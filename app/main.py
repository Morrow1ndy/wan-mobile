"""FastAPI app: serves the mobile UI and proxies RunPod + ComfyUI.

The RunPod API key never leaves this process; the phone only ever talks to
this server (reached over Tailscale locally, or a password-protected public
URL when hosted on Fly.io).
"""

import asyncio
import base64
import json
import os
import re
import secrets
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import websockets
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import comfy_client as comfy
from . import config
from . import drive_client as drive
from . import persistence as ps
from . import runpod_client as rp
from . import workflow as wf

app = FastAPI(title="Wan Mobile")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.on_event("startup")
async def _startup():
    # Run the GCS sync in the background so uvicorn starts serving (and passes
    # Fly's health check) immediately. A slow/large sync must never block boot;
    # any video not yet on the volume is fetched on demand by serve_saved_file.
    task = asyncio.create_task(asyncio.to_thread(_drive_startup_sync))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    # Re-attach to generations that were in flight when this process last
    # stopped (e.g. Fly auto-stop). The work continues on the RunPod pod; we
    # just resume watching it so the UI shows progress and the result resolves.
    _restore_jobs()
    # Keep the Fly machine alive while generations are running. Without this,
    # Fly's idle-detection stops the machine (no inbound HTTP = idle), even
    # though _watch() is actively polling RunPod. The self-ping counts as
    # inbound traffic and prevents auto-stop until all jobs complete.
    asyncio.create_task(_keepalive_loop())
    # Backfill sampler-mode/steps/lightx2-ratio fields onto saved videos that
    # predate those fields. backfill_scheduler() is idempotent (skips any
    # field already set), so running it on every boot is safe/cheap and means
    # a newly added field (like lx_ratio) reaches existing saved videos
    # automatically on next deploy — no manual POST to the endpoint needed.
    # Runs after the GCS sync so it operates on the synced local metadata.
    backfill_task = asyncio.create_task(_backfill_after_sync(task))
    _TASKS.add(backfill_task)
    backfill_task.add_done_callback(_TASKS.discard)


async def _backfill_after_sync(sync_task: asyncio.Task):
    try:
        await sync_task
    except Exception:
        pass
    try:
        result = await backfill_scheduler()
        print(f"[backfill] saved-video metadata backfill on boot: {result}")
    except Exception as e:
        print(f"[backfill] startup backfill failed: {e}")


async def _keepalive_loop():
    """Ping our own public URL every 30s while any job is running.

    Fly auto-stops machines with no inbound traffic THROUGH THE FLY PROXY.
    A loopback request to localhost never leaves the VM — it doesn't pass
    through the proxy at all — so it does NOT register as activity and does
    NOT prevent auto-stop, despite looking like it should. This was the
    actual reason the "generating" card kept reverting to "queued" (and
    duplicating once the pod's job finished) after being away for a while:
    the app machine auto-stopped mid-generation because this self-ping was
    silently a no-op, then _restore_jobs() had to reconstruct state on the
    next request. Pinging the public hostname routes through the proxy like
    a real client request, so it actually counts.
    """
    app_name = os.getenv("FLY_APP_NAME")
    if not app_name:
        return  # local dev — no Fly proxy, no auto-stop to fight
    url = f"https://{app_name}.fly.dev/api/balance"
    auth = (_AUTH_USER, _AUTH_PASS) if _AUTH_USER and _AUTH_PASS else None
    while True:
        await asyncio.sleep(30)
        if any(j.get("status") == "running" for j in JOBS.values()):
            try:
                import httpx
                async with httpx.AsyncClient() as client:
                    await client.get(url, auth=auth, timeout=10)
            except Exception:
                pass


def _drive_startup_sync():
    """Sync saved videos with GCS on startup.

    GCS is the source of truth. Updates local metadata and downloads any
    video files missing from the local volume. Falls back to local cache
    silently if GCS is unreachable.
    """
    try:
        gcs_meta = drive.download_metadata()
    except Exception as e:
        print(f"[GCS] startup sync skipped: {e}")
        return

    if gcs_meta is None:
        return  # nothing saved yet, local state is already empty

    ps.save_saved(gcs_meta)
    ps.SAVED_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = 0
    for item in gcs_meta:
        local_file = ps.SAVED_DIR / item["filename"]
        if not local_file.exists():
            try:
                drive.download_video_to_file(item["filename"], local_file)
                downloaded += 1
            except Exception as e:
                print(f"[GCS] failed to download {item['filename']}: {e}")
    if downloaded:
        print(f"[GCS] downloaded {downloaded} missing video(s) from GCS")

# ----- optional HTTP Basic Auth -------------------------------------------
# When WAN_AUTH_USER + WAN_AUTH_PASS are set (e.g. on a public Fly.io URL),
# every request must carry matching Basic credentials. Unset => open (local).
_AUTH_USER = os.getenv("WAN_AUTH_USER", "")
_AUTH_PASS = os.getenv("WAN_AUTH_PASS", "")
# On Fly.io connections are always HTTPS; on localhost they're HTTP.
_SECURE_COOKIE = bool(os.getenv("FLY_APP_NAME"))


def _check_auth(request: Request) -> bool:
    """Accept either the Authorization header or the wan_auth cookie.

    <video src> and <img src> are browser-native requests that bypass our
    JS fetch wrapper and therefore never carry the Authorization header.
    Setting an httponly cookie in parallel lets the browser include credentials
    automatically on all same-origin requests, including media elements.
    """
    candidates: list[str] = []
    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        candidates.append(header[6:])
    cookie = request.cookies.get("wan_auth", "")
    if cookie:
        candidates.append(cookie)
    for cred_b64 in candidates:
        try:
            user, _, pw = base64.b64decode(cred_b64).decode().partition(":")
            if (secrets.compare_digest(user, _AUTH_USER)
                    and secrets.compare_digest(pw, _AUTH_PASS)):
                return True
        except Exception:
            pass
    return False


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    # Only protect API routes. Static files (including the login page itself)
    # are served without auth so the custom login overlay can load.
    if _AUTH_USER and _AUTH_PASS and request.url.path.startswith("/api/"):
        if not _check_auth(request):
            return Response(
                status_code=401,
                content='{"error":"unauthorized"}',
                media_type="application/json",
            )
    return await call_next(request)


@app.post("/api/auth/cookie")
async def set_auth_cookie(request: Request):
    """Persist auth as an httponly cookie so browser media elements work.

    Called by the frontend immediately after login and on every page load
    that has stored credentials. The middleware already verified the request,
    so we just extract the credential string and bake it into a cookie that
    the browser will include automatically on all same-origin requests
    (including <video src> and <img src> which can't carry custom headers).
    """
    cred_b64 = ""
    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        cred_b64 = header[6:]
    elif request.cookies.get("wan_auth"):
        cred_b64 = request.cookies["wan_auth"]
    response = JSONResponse({"ok": True})
    response.set_cookie(
        key="wan_auth",
        value=cred_b64,
        httponly=True,
        secure=_SECURE_COOKIE,
        samesite="strict",
        max_age=30 * 24 * 3600,  # 30 days; refreshed on every page load
    )
    return response

# In-memory job tracking (good enough for a single user). Mirrored to disk so
# in-flight jobs survive a restart / Fly auto-stop (see _persist_jobs).
JOBS: dict[str, dict] = {}
_TASKS: set[asyncio.Task] = set()  # keeps watcher tasks alive until done


# Serializes read-modify-write of the saved-videos metadata + its GCS upload so
# concurrent star/unstar calls can't clobber each other's changes.
_saved_lock = asyncio.Lock()

# Per-pod activity log + last-known ComfyUI readiness (app-level, in memory).
POD_EVENTS: dict[str, list[dict]] = {}
POD_READY: dict[str, bool] = {}

# Job fields that are JSON-safe to persist (omits raw preview bytes).
_JOB_PERSIST_KEYS = (
    "status", "progress", "max", "node", "node_title", "node_titles",
    "pod_id", "video", "started_at", "finished_at", "input_image", "error",
    "video_name",
)


def _persist_jobs():
    """Write running (and very-recently-finished) jobs to the volume.

    Finished jobs naturally age out: only the ones still relevant to the UI
    are kept, so the file stays small and stale jobs don't resurrect.
    """
    now = time.time()
    slim = {}
    for pid, j in JOBS.items():
        fin = j.get("finished_at")
        if j.get("status") == "running" or (fin and now - fin < 60):
            slim[pid] = {k: j.get(k) for k in _JOB_PERSIST_KEYS}
    try:
        ps.save_jobs(slim)
    except Exception:
        pass


def _restore_jobs():
    """Reload persisted jobs and resume watching any still in flight."""
    try:
        saved = ps.get_jobs()
    except Exception:
        return
    for pid, j in saved.items():
        j.setdefault("preview", None)
        j.setdefault("preview_ct", None)
        j.setdefault("node_titles", {})
        JOBS[pid] = j
    for pid, j in list(JOBS.items()):
        if j.get("status") == "running" and j.get("pod_id"):
            url = rp.comfy_url(j["pod_id"])
            client_id = uuid.uuid4().hex
            task = asyncio.create_task(_watch(url, client_id, pid))
            _TASKS.add(task)
            task.add_done_callback(_TASKS.discard)


def log_event(pod_id: str, msg: str):
    """Append a timestamped line to a pod's session activity log."""
    POD_EVENTS.setdefault(pod_id, []).append(
        {"t": time.strftime("%H:%M:%S"), "msg": msg})


# ----- config / pods -------------------------------------------------------
@app.get("/api/config")
async def get_config():
    return {
        "fields": config.PARAM_FIELDS,
        "cuda_versions": config.ALLOWED_CUDA_VERSIONS,
        "ram_options": config.RAM_OPTIONS,
        "data_center": config.settings.data_center_id,
        "cloud_type": config.settings.cloud_type,
        "container_disk_gb": config.CONTAINER_DISK_GB,
        "workflows": config.AVAILABLE_WORKFLOWS,
        "default_workflow": config.settings.workflow_file,
        "workflow_labels": config.WORKFLOW_LABELS,
    }


@app.get("/api/balance")
async def balance():
    return {"balance": await rp.get_balance()}


@app.get("/api/gpus")
async def gpus():
    return await rp.list_gpus()


@app.get("/api/gpu-availability")
async def gpu_availability(min_memory: int | None = None, cuda: str | None = None):
    """Live GPU grid (price + stock) for the configured region/cloud/CUDA.

    `cuda` is a comma-separated list of CUDA versions; blank/omitted falls back
    to the configured default set.
    """
    cuda_versions = [c.strip() for c in cuda.split(",") if c.strip()] if cuda else None
    return await rp.list_gpu_availability(min_memory, cuda_versions)


@app.get("/api/pods")
async def pods():
    data = await rp.list_pods()
    return [{**p, "comfy_url": rp.comfy_url(p["id"])} for p in data]


@app.get("/api/pods/{pod_id}")
async def pod_status(pod_id: str):
    pod = await rp.get_pod(pod_id)
    url = rp.comfy_url(pod_id)
    ready = await comfy.is_ready(url)
    if ready and not POD_READY.get(pod_id):
        POD_READY[pod_id] = True
        log_event(pod_id, "ComfyUI ready ✓")
    return {"pod": pod, "comfy_url": url, "comfy_ready": ready}


@app.get("/api/pods/{pod_id}/metrics")
async def pod_metrics(pod_id: str):
    return await rp.pod_metrics(pod_id)


@app.get("/api/pods/{pod_id}/events")
async def pod_events(pod_id: str):
    return POD_EVENTS.get(pod_id, [])


@app.get("/api/pods/{pod_id}/session")
async def pod_session(pod_id: str):
    """Live metrics + activity log in a single request.

    The pod card polls this on a timer; bundling both halves the number of
    phone→Fly round-trips per tick (events are in-memory, so this adds no
    extra RunPod API calls beyond the metrics lookup).
    """
    metrics = await rp.pod_metrics(pod_id)
    return {"metrics": metrics, "events": POD_EVENTS.get(pod_id, [])}


@app.post("/api/pods")
async def create(payload: dict = Body(default={})):
    try:
        res = await rp.create_pod(
            gpu_type_id=payload.get("gpu_type_id"),
            min_memory_gb=payload.get("min_memory"),
            cuda_versions=payload.get("cuda_versions"),
        )
    except Exception as e:
        # Surface the real RunPod/SDK error instead of a bare 500 so the UI can
        # show what actually went wrong (e.g. no capacity, bad kwarg, auth).
        detail = f"{type(e).__name__}: {e}"
        log_event("system", f"Pod create failed: {detail}")
        raise HTTPException(502, detail)
    pod_id = (res or {}).get("id")
    if pod_id:
        gpu = payload.get("gpu_label") or payload.get("gpu_type_id") or "GPU"
        POD_READY[pod_id] = False
        log_event(pod_id, f"Pod created ({gpu}, {config.settings.data_center_id})")
        log_event(pod_id, "Waiting for ComfyUI…")
    return res


@app.post("/api/pods/{pod_id}/stop")
async def stop(pod_id: str):
    return await rp.stop_pod(pod_id)


@app.post("/api/pods/{pod_id}/resume")
async def resume(pod_id: str):
    return await rp.resume_pod(pod_id, 1)


@app.post("/api/pods/{pod_id}/terminate")
async def terminate(pod_id: str):
    return await rp.terminate_pod(pod_id)


# ----- prompt templates + last params -------------------------------------
@app.get("/api/templates")
async def list_templates():
    return ps.get_templates()


@app.post("/api/templates")
async def add_template(payload: dict = Body(default={})):
    templates = ps.get_templates()
    templates.append({"name": payload.get("name", "Template"),
                      "text": payload.get("text", "")})
    ps.save_templates(templates)
    return templates


@app.put("/api/templates/{index}")
async def update_template(index: int, payload: dict = Body(default={})):
    templates = ps.get_templates()
    if 0 <= index < len(templates):
        templates[index] = {
            "name": payload.get("name", templates[index]["name"]),
            "text": payload.get("text", templates[index]["text"]),
        }
        ps.save_templates(templates)
    return templates


@app.delete("/api/templates/{index}")
async def delete_template(index: int):
    templates = ps.get_templates()
    if 0 <= index < len(templates):
        templates.pop(index)
        ps.save_templates(templates)
    return templates


@app.get("/api/last-params")
async def get_last_params():
    return ps.get_last_params()


@app.post("/api/last-params")
async def save_last_params(payload: dict = Body(default={})):
    ps.save_last_params(payload)
    return {"ok": True}


@app.get("/api/param-presets")
async def list_param_presets():
    return ps.get_param_presets()


@app.post("/api/param-presets")
async def add_param_preset(payload: dict = Body(default={})):
    presets = ps.get_param_presets()
    presets.append({"name": payload.get("name", "Preset"),
                    "params": payload.get("params", {})})
    ps.save_param_presets(presets)
    return presets


@app.put("/api/param-presets/{index}")
async def update_param_preset(index: int, payload: dict = Body(default={})):
    presets = ps.get_param_presets()
    if 0 <= index < len(presets):
        presets[index] = {
            "name": payload.get("name", presets[index]["name"]),
            "params": payload.get("params", presets[index]["params"]),
        }
        ps.save_param_presets(presets)
    return presets


@app.delete("/api/param-presets/{index}")
async def delete_param_preset(index: int):
    presets = ps.get_param_presets()
    if 0 <= index < len(presets):
        presets.pop(index)
        ps.save_param_presets(presets)
    return presets


# ----- generation ----------------------------------------------------------
@app.post("/api/generate")
async def generate(
    pod_id: str = Form(...),
    image: UploadFile = File(...),
    params: str = Form("{}"),
    workflow_file: str = Form(""),
):
    values = json.loads(params)
    video_name = (values.get("video_name") or "").strip()
    url = rp.comfy_url(pod_id)
    if not await comfy.is_ready(url):
        raise HTTPException(409, "ComfyUI is not ready on this pod yet.")

    # Validate workflow selection against known files (security: no path traversal)
    chosen = workflow_file if workflow_file in config.AVAILABLE_WORKFLOWS else config.settings.workflow_file

    data = await image.read()
    image_name = await comfy.upload_image(url, data, image.filename or "input.png")
    workflow = wf.build_workflow(values, image_name, chosen)

    client_id = uuid.uuid4().hex
    prompt_id = await comfy.queue_prompt(url, workflow, client_id)

    # Record which sampler-mode workflow was actually used, so completed/saved
    # videos can show the right "sampler mode" badge + sampler/scheduler pair
    # even after this in-memory JOBS entry expires (persisted params outlive it).
    values["workflow_file"] = chosen
    ps.save_params(prompt_id, values)
    JOBS[prompt_id] = {
        "status": "running", "progress": 0, "max": 0,
        "node": None, "node_title": None, "node_titles": _node_titles(workflow),
        "pod_id": pod_id, "video": None,
        "started_at": None, "finished_at": None,
        "input_image": image_name,
        "preview": None, "preview_ct": None,
        "workflow_file": chosen,
        "video_name": video_name,
    }
    log_event(pod_id, "Generation queued")
    _persist_jobs()
    task = asyncio.create_task(_watch(url, client_id, prompt_id))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return {"prompt_id": prompt_id}


def _node_titles(workflow: dict) -> dict:
    """node_id -> human label, from the API-format workflow's _meta.title."""
    titles = {}
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        meta = node.get("_meta") or {}
        titles[str(nid)] = meta.get("title") or node.get("class_type") or str(nid)
    return titles


def _compute_steps(params: dict):
    """Total steps actually used: steps_on when lightx2v was enabled for this
    generation, steps_off otherwise (mirrors the toggle's own condition in
    PARAM_FIELDS). Returns None if neither was recorded."""
    key = "steps_on" if params.get("lightx2v") else "steps_off"
    return params.get(key)


def _fmt_ratio_num(x) -> str:
    """Format a ratio component, keeping its original value (2.0 -> "2",
    0.8 -> "0.8") rather than rounding to a fixed decimal count."""
    r = round(float(x), 4)
    if r == int(r):
        return str(int(r))
    return f"{r:g}"


def _compute_lx_ratio(params: dict):
    """lightx2/ning distill-LoRA High:Low strength ratio (e.g. "2:1", "2:0.8"),
    only when lightx2v was enabled for this generation — the strengths are
    forced to 0 when it's off, so a ratio isn't meaningful then. Returns None
    if not applicable or not recorded."""
    if not params.get("lightx2v"):
        return None
    high, low = params.get("lx_high"), params.get("lx_low")
    if high is None or low is None:
        return None
    return f"{_fmt_ratio_num(high)}:{_fmt_ratio_num(low)}"


def _job_public(prompt_id: str, job: dict) -> dict:
    """JSON-safe view of a job (omits raw preview bytes + the titles map)."""
    params = ps.get_params(prompt_id) or {}
    scheduler = params.get("scheduler") or params.get("scheduler_high") or ""
    return {
        "prompt_id": prompt_id,
        "status": job.get("status"),
        "progress": job.get("progress", 0),
        "max": job.get("max", 0),
        "node_title": job.get("node_title"),
        "started_at": job.get("started_at"),
        "input_image": job.get("input_image"),
        "has_preview": job.get("preview") is not None,
        "video": job.get("video"),
        "error": job.get("error"),
        "video_name": job.get("video_name", ""),
        # Same sampler-mode fields as pod_outputs()/star_video() so the
        # in-progress card shows the same mode + sampler/scheduler badges as
        # the completed/saved card once it lands.
        "workflow_file": job.get("workflow_file") or params.get("workflow_file", ""),
        "sampler": params.get("sampler", ""),
        "scheduler": scheduler,
        "sampler_base": params.get("sampler_base", ""),
        "scheduler_base": params.get("scheduler_base", ""),
        "sampler_lightning": params.get("sampler_lightning", ""),
        "scheduler_lightning": params.get("scheduler_lightning", ""),
        "cs_sampler_h": params.get("cs_sampler_h", ""),
        "cs_scheduler_h": params.get("cs_scheduler_h", ""),
        "cs_sampler_l": params.get("cs_sampler_l", ""),
        "cs_scheduler_l": params.get("cs_scheduler_l", ""),
        "steps": _compute_steps(params),
        "lx_ratio": _compute_lx_ratio(params),
    }


@app.get("/api/status/{prompt_id}")
async def status(prompt_id: str):
    job = JOBS.get(prompt_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return _job_public(prompt_id, job)


@app.get("/api/preview/{prompt_id}")
async def preview(prompt_id: str):
    """Latest live sampling-preview frame for an in-flight job, if any."""
    job = JOBS.get(prompt_id)
    if not job or not job.get("preview"):
        raise HTTPException(404, "no preview")
    return Response(content=job["preview"],
                    media_type=job.get("preview_ct", "image/jpeg"),
                    headers={"Cache-Control": "no-store"})


@app.get("/api/params/{prompt_id}")
async def generation_params(prompt_id: str):
    params = ps.get_params(prompt_id)
    if params is None:
        raise HTTPException(404, "No params saved for this generation")
    # Inject the actual generation time for the Details overlay. Not a real
    # PARAM_FIELD (nothing to write back into a workflow), and underscore-
    # prefixed so it's excluded from the overlay's generic field-row loop —
    # the frontend renders it as its own dedicated row instead.
    job = JOBS.get(prompt_id) or {}
    s, f = job.get("started_at"), job.get("finished_at")
    stat = ps.get_stats().get(prompt_id, {})
    duration = round(f - s) if s and f else stat.get("secs")
    return {**params, "_duration_secs": duration}


# Generated clips are write-once (the filename embeds a unique counter / prompt
# id), so they never change under a given URL — cache them hard on the device.
_VIDEO_CACHE = "private, max-age=31536000, immutable"


async def _proxy_view(pod_id: str, filename: str, subfolder: str,
                      type_: str, range_header: str | None):
    """Stream a pod file to the browser with Range + immutable caching.

    No RAM buffering (streamed straight through), and the client's Range header
    is forwarded so cover thumbnails and seeks only move the needed bytes.
    Passes through upstream Content-Length / Content-Range and the 206 status.
    """
    resp, body = await comfy.open_view_stream(
        rp.comfy_url(pod_id), filename, subfolder, type_, range_header)
    headers = {
        "Content-Disposition": f'inline; filename="{filename}"',
        "Accept-Ranges": "bytes",
        "Cache-Control": _VIDEO_CACHE,
    }
    for h in ("content-length", "content-range"):
        if h in resp.headers:
            headers[h] = resp.headers[h]
    return StreamingResponse(
        body, status_code=resp.status_code,
        media_type=_content_type({"filename": filename}),
        headers=headers,
    )


@app.get("/api/video/{prompt_id}")
async def video(request: Request, prompt_id: str):
    job = JOBS.get(prompt_id)
    if not job or not job.get("video"):
        raise HTTPException(404, "no video for this job yet")
    v = job["video"]
    return await _proxy_view(job["pod_id"], v["filename"], v.get("subfolder", ""),
                             v.get("type", "output"), request.headers.get("range"))


@app.get("/api/pods/{pod_id}/outputs")
async def pod_outputs(pod_id: str, limit: int = 10_000):
    """Videos from the pod's ComfyUI history, newest first.

    Reads straight from the pod (which holds the files on the network volume),
    so it survives the browser closing or this server restarting/sleeping.
    `limit` defaults high (effectively unbounded) so Current Session shows
    every clip generated on this pod for its whole lifetime rather than
    silently dropping older ones once more than a handful pile up — it only
    ever empties when the pod itself is replaced/terminated (a fresh pod has
    no ComfyUI history of its own).
    """
    try:
        hist = await comfy.get_history_all(rp.comfy_url(pod_id), max_items=limit)
    except Exception:
        return []
    items = []
    all_stats = ps.get_stats()
    saved_ids = {s["prompt_id"] for s in ps.get_saved()}
    for pid, entry in hist.items():
        vid = _find_video(entry.get("outputs") or {})
        if vid:
            job = JOBS.get(pid)
            s, f = (job or {}).get("started_at"), (job or {}).get("finished_at")
            stat = all_stats.get(pid, {})
            duration = round(f - s) if s and f else stat.get("secs")
            completed_at = f or stat.get("at")
            params = ps.get_params(pid) or {}
            # video_name: try in-memory job first, then fall back to saved params
            video_name = (job or {}).get("video_name") or params.get("video_name", "")
            # scheduler: "scheduler" is the current combined field; "scheduler_high"
            # is the legacy pre-merge key (see 2026-06-25 changelog entry)
            scheduler = params.get("scheduler") or params.get("scheduler_high") or ""
            items.append({
                "prompt_id": pid, "input_image": _input_image(entry),
                "duration_secs": duration, "completed_at": completed_at,
                "is_saved": pid in saved_ids,
                "video_name": video_name, "scheduler": scheduler,
                # Which sampler-mode workflow produced this clip (Standard/
                # TripleK/Clownshark), plus that mode's sampler+scheduler
                # values — absent on videos generated before this feature.
                "workflow_file": (job or {}).get("workflow_file") or params.get("workflow_file", ""),
                "sampler": params.get("sampler", ""),
                "sampler_base": params.get("sampler_base", ""),
                "scheduler_base": params.get("scheduler_base", ""),
                "sampler_lightning": params.get("sampler_lightning", ""),
                "scheduler_lightning": params.get("scheduler_lightning", ""),
                "cs_sampler_h": params.get("cs_sampler_h", ""),
                "cs_scheduler_h": params.get("cs_scheduler_h", ""),
                "cs_sampler_l": params.get("cs_sampler_l", ""),
                "cs_scheduler_l": params.get("cs_scheduler_l", ""),
                "steps": _compute_steps(params),
                "lx_ratio": _compute_lx_ratio(params),
                **vid,
            })
    items.reverse()  # history is chronological -> newest first
    return items


@app.get("/api/pods/{pod_id}/jobs")
async def pod_jobs(pod_id: str):
    """In-flight (and just-finished) generations for this pod, newest first.

    Kept around for ~10s after finishing so the UI can show the terminal
    state before the clip drops into the completed list below it.
    """
    now = time.time()
    out = []
    for pid, job in JOBS.items():
        if job.get("pod_id") != pod_id:
            continue
        fin = job.get("finished_at")
        if job.get("status") == "running" or (fin and now - fin < 10):
            out.append(_job_public(pid, job))
    out.sort(key=lambda j: j.get("started_at") or 0, reverse=True)
    return out


def _jobs_sse_data(pod_id: str) -> str:
    """Current in-flight jobs for pod_id serialised for an SSE data line."""
    now = time.time()
    out = []
    for pid, job in JOBS.items():
        if job.get("pod_id") != pod_id:
            continue
        fin = job.get("finished_at")
        if job.get("status") == "running" or (fin and now - fin < 10):
            out.append(_job_public(pid, job))
    out.sort(key=lambda j: j.get("started_at") or 0, reverse=True)
    return json.dumps(out)


@app.get("/api/pods/{pod_id}/stream")
async def job_stream(pod_id: str, request: Request):
    """SSE stream of in-flight job state for this pod.

    Pushes a JSON jobs array every 1 s while a generation is running, or
    a keepalive comment every 10 s when idle.  EventSource auto-reconnects
    on any drop, so the client always gets fresh state within 1 s of
    foregrounding — no timer-resume or bfcache handling needed in JS.
    Auth is via the wan_auth cookie set at login (EventSource cannot send
    custom headers, but the middleware already accepts the cookie).
    """
    async def generate():
        last = None
        while True:
            if await request.is_disconnected():
                break
            data = _jobs_sse_data(pod_id)
            if data != last:
                yield f"data: {data}\n\n"
                last = data
            else:
                yield ": ping\n\n"
            has_active = any(
                j.get("pod_id") == pod_id and j.get("status") == "running"
                for j in JOBS.values()
            )
            await asyncio.sleep(1 if has_active else 10)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/pods/{pod_id}/view")
async def pod_view(request: Request, pod_id: str, filename: str,
                   subfolder: str = "", type: str = "output"):
    """Proxy a single output file from the pod by its ComfyUI coordinates.

    Streams with Range support so cover thumbnails / seeks transfer only the
    bytes the browser requests, and caches immutably (outputs are write-once).
    """
    return await _proxy_view(pod_id, filename, subfolder, type,
                             request.headers.get("range"))


# ----- cancel / delete -------------------------------------------------------
@app.post("/api/pods/{pod_id}/cancel/{prompt_id}")
async def cancel_job(pod_id: str, prompt_id: str):
    url = rp.comfy_url(pod_id)
    job = JOBS.get(prompt_id)
    if job and job.get("started_at") is None:
        await comfy.cancel_queued(url, prompt_id)
        log_event(pod_id, "Generation cancelled (was queued)")
    else:
        await comfy.interrupt(url)
        log_event(pod_id, "Generation interrupted")
    if job:
        # Don't overwrite a job that already completed successfully — this
        # happens when the browser was backgrounded, the generation finished,
        # and the user taps Stop on the ghost active card that's still showing.
        if job.get("status") != "done":
            job["status"] = "error"
            job["error"] = "Cancelled"
            job["finished_at"] = time.time()
            _persist_jobs()
    return {"ok": True}


@app.delete("/api/pods/{pod_id}/outputs/{prompt_id}")
async def delete_output(pod_id: str, prompt_id: str):
    url = rp.comfy_url(pod_id)
    await comfy.delete_history(url, prompt_id)
    log_event(pod_id, f"Output deleted: {prompt_id}")
    return {"ok": True}


# ----- saved (starred) videos ------------------------------------------------
@app.post("/api/saved/{pod_id}/{prompt_id}")
async def star_video(pod_id: str, prompt_id: str, payload: dict = Body(default={})):
    """Download a video from the pod, store it locally, and upload to Drive."""
    filename = payload.get("filename")
    if not filename:
        raise HTTPException(400, "filename required")
    subfolder = payload.get("subfolder", "")
    file_type = payload.get("type", "output")

    content = await comfy.fetch_view(rp.comfy_url(pod_id), filename, subfolder, file_type)
    ps.SAVED_DIR.mkdir(parents=True, exist_ok=True)
    _job = JOBS.get(prompt_id) or {}
    video_name = (_job.get("video_name") or "").strip()
    # Sanitize display name: strip filesystem-unsafe chars, collapse spaces to _
    safe_name = re.sub(r'[\\/:*?"<>|]', "", video_name).strip()
    safe_name = re.sub(r"\s+", "_", safe_name)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    local_name = f"{safe_name}_{ts}.mp4" if safe_name else f"{ts}.mp4"
    (ps.SAVED_DIR / local_name).write_bytes(content)

    stat = ps.get_stats().get(prompt_id, {})
    params = ps.get_params(prompt_id) or {}
    scheduler = params.get("scheduler") or params.get("scheduler_high") or ""
    meta = {
        "prompt_id": prompt_id,
        "filename": local_name,
        "saved_at": round(time.time()),
        "completed_at": stat.get("at"),
        "duration_secs": stat.get("secs"),
        "video_name": _job.get("video_name", ""),
        "scheduler": scheduler,
        "workflow_file": _job.get("workflow_file") or params.get("workflow_file", ""),
        "sampler": params.get("sampler", ""),
        "sampler_base": params.get("sampler_base", ""),
        "scheduler_base": params.get("scheduler_base", ""),
        "sampler_lightning": params.get("sampler_lightning", ""),
        "scheduler_lightning": params.get("scheduler_lightning", ""),
        "cs_sampler_h": params.get("cs_sampler_h", ""),
        "cs_scheduler_h": params.get("cs_scheduler_h", ""),
        "cs_sampler_l": params.get("cs_sampler_l", ""),
        "cs_scheduler_l": params.get("cs_scheduler_l", ""),
        "steps": _compute_steps(params),
        "lx_ratio": _compute_lx_ratio(params),
        # Pod the clip was generated on — lets a permanent "Delete" also purge it
        # from the pod's ComfyUI history (so it can't reappear in the session).
        "pod_id": pod_id,
    }

    try:
        await asyncio.to_thread(drive.upload_video, local_name, content)
    except Exception as e:
        log_event(pod_id, f"GCS upload failed: {e}")

    # Serialize the metadata read-modify-write + its GCS push so a concurrent
    # star/unstar can't overwrite this change with a stale list.
    async with _saved_lock:
        ps.upsert_saved(meta)
        try:
            await asyncio.to_thread(drive.upload_metadata, ps.get_saved())
        except Exception:
            pass

    log_event(pod_id, f"Video starred: {local_name}")
    return meta


@app.get("/api/saved")
async def list_saved():
    return ps.get_saved()


@app.post("/api/saved/backfill-scheduler")
async def backfill_scheduler():
    """Migration: fill in sampler-mode fields (workflow_file, and
    sampler/scheduler or the TripleK/Clownshark pair fields, steps, lx_ratio)
    on saved videos that predate a given feature, from the generation params
    recorded at the time (falling back to the legacy `scheduler_high`/
    `sampler_high` keys). Idempotent — any field already set on an entry is
    left untouched, so re-running (e.g. after a later feature adds more
    fields, as happened 2026-07-02 with the 3-way sampler mode, and
    2026-07-03 with steps/lx_ratio) is always safe and only fills in what's
    still missing. Also called once from `_startup()` on every boot (see
    `_backfill_after_sync`) so newly added fields reach existing saved videos
    automatically on the next deploy, without a manual POST to this endpoint.
    Params older than the last 500 generations (see
    persistence._MAX_PARAMS) are no longer available, so those entries are
    simply left without this data and show no mode/sampler badge in the UI.
    """
    pair_fields = (
        "sampler_base", "scheduler_base", "sampler_lightning", "scheduler_lightning",
        "cs_sampler_h", "cs_scheduler_h", "cs_sampler_l", "cs_scheduler_l",
    )
    updated = skipped = not_found = 0
    async with _saved_lock:
        saved = ps.get_saved()
        for item in saved:
            params = ps.get_params(item["prompt_id"]) or {}
            if not params:
                not_found += 1
                continue
            changed = False
            if not item.get("scheduler"):
                v = params.get("scheduler") or params.get("scheduler_high") or ""
                if v:
                    item["scheduler"] = v
                    changed = True
            if not item.get("sampler"):
                v = params.get("sampler") or params.get("sampler_high") or ""
                if v:
                    item["sampler"] = v
                    changed = True
            for key in pair_fields:
                if not item.get(key):
                    v = params.get(key) or ""
                    if v:
                        item[key] = v
                        changed = True
            if not item.get("workflow_file"):
                v = params.get("workflow_file") or ""
                if not v and (item.get("sampler") or item.get("sampler_base") or item.get("cs_sampler_h")):
                    # Pre-3-way-mode generations only ever used the
                    # Standard-shape workflow (bf16/GGUF both wrote to the
                    # same KSamplerAdvanced node pair) — infer it so the mode
                    # badge renders too.
                    v = config.WF_STANDARD
                if v:
                    item["workflow_file"] = v
                    changed = True
            if item.get("steps") is None:
                v = _compute_steps(params)
                if v is not None:
                    item["steps"] = v
                    changed = True
            if item.get("lx_ratio") is None:
                v = _compute_lx_ratio(params)
                if v is not None:
                    item["lx_ratio"] = v
                    changed = True
            if changed:
                updated += 1
            else:
                skipped += 1
        ps.save_saved(saved)
        try:
            await asyncio.to_thread(drive.upload_metadata, saved)
        except Exception:
            pass
    return {"updated": updated, "already_set": skipped, "no_params_found": not_found,
            "total": len(saved)}


@app.delete("/api/saved/{prompt_id}")
async def unstar_video(prompt_id: str):
    async with _saved_lock:
        item = ps.remove_saved(prompt_id)
        if item:
            try:
                await asyncio.to_thread(drive.delete_video, item["filename"])
            except Exception:
                pass
            try:
                await asyncio.to_thread(drive.upload_metadata, ps.get_saved())
            except Exception:
                pass
            p = ps.SAVED_DIR / item["filename"]
            if p.exists():
                p.unlink()
    return {"ok": True}


@app.post("/api/saved/reorder")
async def reorder_saved(payload: dict = Body(default={})):
    """Persist a user-defined display order for saved videos."""
    ids = [str(i) for i in (payload.get("ids") or [])]
    if not ids:
        raise HTTPException(400, "ids required")
    async with _saved_lock:
        saved = ps.get_saved()
        by_id = {s["prompt_id"]: s for s in saved}
        reordered = [by_id[pid] for pid in ids if pid in by_id]
        reordered += [s for s in saved if s["prompt_id"] not in set(ids)]
        ps.save_saved(reordered)
        try:
            await asyncio.to_thread(drive.upload_metadata, reordered)
        except Exception:
            pass
    return {"ok": True}


@app.get("/api/saved/file/{filename}")
async def serve_saved_file(filename: str):
    # Reject path traversal — filename must be a bare name on the volume.
    if "/" in filename or "\\" in filename or filename in ("", ".", ".."):
        raise HTTPException(400, "bad filename")
    p = ps.SAVED_DIR / filename
    if not p.exists():
        # Volume cache miss — restore from GCS, streamed to disk (no RAM buffer).
        try:
            ps.SAVED_DIR.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(drive.download_video_to_file, filename, p)
        except Exception:
            raise HTTPException(404, "Saved video not found")
    # FileResponse streams from disk in chunks instead of loading the whole
    # video into memory.
    # FileResponse streams from disk in chunks and honours Range natively.
    # Saved files are immutable, so cache them hard to avoid re-downloads.
    return FileResponse(
        p, media_type=_content_type({"filename": filename}),
        headers={"Content-Disposition": f'inline; filename="{filename}"',
                 "Cache-Control": _VIDEO_CACHE})


# ----- system metrics (RAM) --------------------------------------------------
def _mem_usage() -> dict:
    """Container memory used/total in bytes, read from the Fly VM.

    Prefers the cgroup (the real container limit, e.g. 512MB on Fly); falls
    back to /proc/meminfo. Returns {used: None, total: None} off-Linux.
    """
    try:
        with open("/sys/fs/cgroup/memory.current") as f:
            used = int(f.read().strip())
        with open("/sys/fs/cgroup/memory.max") as f:
            raw = f.read().strip()
        if raw != "max":
            return {"used": used, "total": int(raw)}
    except Exception:
        pass
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.strip().split()[0]) * 1024
        total = info.get("MemTotal")
        avail = info.get("MemAvailable")
        if total and avail is not None:
            return {"used": total - avail, "total": total}
    except Exception:
        pass
    return {"used": None, "total": None}


@app.get("/api/sysmetrics")
async def sysmetrics():
    return _mem_usage()


# ----- storage usage ---------------------------------------------------------
@app.get("/api/storage")
async def storage_usage():
    """Fly volume disk usage, plus how much the saved videos take.

    `total`/`used`/`free` are the whole volume (the filesystem mounted at
    /app/data); `saved_bytes` is just the starred-video files.
    """
    data_dir = ps.SAVED_DIR.parent
    data_dir.mkdir(parents=True, exist_ok=True)
    total, used, free = await asyncio.to_thread(shutil.disk_usage, str(data_dir))
    saved_bytes = 0
    if ps.SAVED_DIR.exists():
        saved_bytes = sum(
            f.stat().st_size for f in ps.SAVED_DIR.glob("*") if f.is_file())
    return {"total": total, "used": used, "free": free,
            "saved_bytes": saved_bytes}


# ----- input image cloud library --------------------------------------------
@app.get("/api/images/browse")
async def browse_images(prefix: str = ""):
    return await asyncio.to_thread(drive.list_image_prefix, prefix)


@app.get("/api/images/file/{path:path}")
async def serve_image_file(path: str):
    # Stream the image from GCS in chunks rather than buffering the whole file
    # in RAM — a library folder can request many thumbnails at once.
    return StreamingResponse(
        drive.iter_image(path),
        media_type=_content_type({"filename": path}),
        headers={
            "Content-Disposition": f'inline; filename="{Path(path).name}"',
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )


@app.post("/api/images/save")
async def save_image_to_cloud(
    file: UploadFile = File(...),
    path: str = Form(...),
):
    data = await file.read()
    await asyncio.to_thread(
        drive.upload_image, path, data, file.content_type or "image/jpeg"
    )
    return {"ok": True, "path": path}


@app.delete("/api/images/file/{path:path}")
async def delete_image_file(path: str):
    await asyncio.to_thread(drive.delete_image, path)
    return {"ok": True}


@app.delete("/api/images/folder/{path:path}")
async def delete_image_folder(path: str):
    # Guard against a request that would wipe the whole library: require a
    # concrete, traversal-free subfolder.
    clean = (path or "").strip().strip("/")
    if not clean or ".." in clean.split("/"):
        raise HTTPException(400, "invalid folder path")
    await asyncio.to_thread(drive.delete_image_folder, clean + "/")
    return {"ok": True}


@app.post("/api/images/folder")
async def create_image_folder(payload: dict = Body(default={})):
    path = payload.get("path", "").strip("/")
    if not path:
        raise HTTPException(400, "path required")
    await asyncio.to_thread(drive.create_image_folder, path + "/")
    return {"ok": True}


def _safe_image_path(p: str) -> str:
    """Validate an image library path: must be non-empty and traversal-free."""
    clean = (p or "").strip().strip("/")
    if not clean or ".." in clean.split("/"):
        raise HTTPException(400, "invalid path")
    return clean


@app.post("/api/images/copy")
async def copy_image_file(payload: dict = Body(default={})):
    src = _safe_image_path(payload.get("src", ""))
    dest = _safe_image_path(payload.get("dest", ""))
    await asyncio.to_thread(drive.copy_image, src, dest)
    return {"ok": True}


@app.post("/api/images/move")
async def move_image_file(payload: dict = Body(default={})):
    src = _safe_image_path(payload.get("src", ""))
    dest = _safe_image_path(payload.get("dest", ""))
    await asyncio.to_thread(drive.move_image, src, dest)
    return {"ok": True}


# ----- RAM clear -------------------------------------------------------------
_RAM_CLEAR_WF = Path(__file__).resolve().parent.parent / "workflows" / "ram_clear.json"


@app.post("/api/pods/{pod_id}/ram-clear")
async def ram_clear(pod_id: str):
    url = rp.comfy_url(pod_id)
    if not await comfy.is_ready(url):
        raise HTTPException(409, "ComfyUI is not ready on this pod.")
    with open(_RAM_CLEAR_WF, "r", encoding="utf-8") as f:
        workflow = json.load(f)
    client_id = uuid.uuid4().hex
    prompt_id = await comfy.queue_prompt(url, workflow, client_id)
    log_event(pod_id, "RAM clear queued")
    return {"prompt_id": prompt_id}


# ----- background watcher ---------------------------------------------------
async def _watch(url: str, client_id: str, prompt_id: str):
    """Listen on ComfyUI's websocket for progress, then resolve the output."""
    job = JOBS[prompt_id]

    # Re-sync from ComfyUI's history before opening the websocket. This is a
    # no-op for a job that was JUST queued (nothing in history yet for it),
    # but it matters a lot when _restore_jobs() is re-attaching to a job that
    # was already running before this process restarted (Fly auto-stop, or a
    # deploy): a freshly-opened websocket only sees FUTURE events, it never
    # replays "execution_start"/"progress" for work that already happened —
    # so a prompt that had already finished while we were down would sit
    # marked "running" until the websocket happened to drop and fall through
    # to the polling loop below, showing a stuck "queued" ghost card
    # alongside the real completed card pod_outputs() finds independently by
    # reading the pod's ComfyUI history directly. And a prompt still
    # genuinely in progress would show "queued" (not "generating") forever,
    # since started_at never gets backfilled without a fresh progress event.
    try:
        entry = (await comfy.get_history(url, prompt_id)).get(prompt_id) or {}
    except Exception:
        entry = {}
    _status = entry.get("status") or {}
    _outputs = entry.get("outputs") or {}
    if _status.get("status_str") == "error":
        job["status"], job["error"] = "error", _status
        job["finished_at"] = time.time()
        log_event(job["pod_id"], "Generation error (ComfyUI)")
        _persist_jobs()
        return
    if _outputs or _status.get("completed"):
        job["video"] = _find_video(_outputs)
        job["status"] = "done"
        job["finished_at"] = time.time()
        if job["max"]:
            job["progress"] = job["max"]
        duration = (round(job["finished_at"] - job["started_at"])
                    if job.get("started_at") else None)
        ps.save_stat(prompt_id, duration, job["finished_at"])
        _backfill_seed(prompt_id, entry)
        log_event(job["pod_id"],
                  "Video ready ✓" if job["video"] else "Finished (no video output)")
        _persist_jobs()
        return
    if job["started_at"] is None and _status.get("status_str"):
        # ComfyUI already has a status for this prompt (it's dequeued/running),
        # we just don't know exactly when it started — best-effort backfill so
        # the UI shows "generating" instead of "queued" indefinitely.
        job["started_at"] = time.time()
        _persist_jobs()

    try:
        async with websockets.connect(comfy.ws_url(url, client_id),
                                       max_size=None) as ws:
            async for raw in ws:
                if isinstance(raw, bytes):  # binary = live sampling preview
                    # Layout: 4-byte event (1 = preview image), 4-byte image
                    # type (1 = JPEG, 2 = PNG), then the raw image bytes.
                    if len(raw) > 8 and int.from_bytes(raw[0:4], "big") == 1:
                        job["preview"] = raw[8:]
                        job["preview_ct"] = ("image/png"
                            if int.from_bytes(raw[4:8], "big") == 2 else "image/jpeg")
                    continue
                msg = json.loads(raw)
                mtype, d = msg.get("type"), msg.get("data", {})
                if mtype == "execution_start":
                    if d.get("prompt_id") == prompt_id and job["started_at"] is None:
                        job["started_at"] = time.time()
                        _persist_jobs()
                elif mtype == "progress":
                    if job["started_at"] is None:
                        job["started_at"] = time.time()
                    job["progress"], job["max"] = d.get("value", 0), d.get("max", 0)
                elif mtype == "executing":
                    node = d.get("node")
                    if node is not None and job["started_at"] is None:
                        job["started_at"] = time.time()
                    job["node"] = node
                    job["node_title"] = (job["node_titles"].get(str(node))
                                         if node is not None else None)
                    if node is None and d.get("prompt_id") == prompt_id:
                        break  # this prompt finished executing
                elif mtype == "execution_error" and d.get("prompt_id") == prompt_id:
                    job["status"], job["error"] = "error", d
                    job["finished_at"] = time.time()
                    log_event(job["pod_id"], "Generation error (ComfyUI)")
                    _persist_jobs()
                    return
    except Exception:
        pass  # fall through to history-based resolution

    # Resolve via history. The websocket can drop early (cold-start proxy
    # hiccups) BEFORE the job actually finishes, so we must poll until ComfyUI
    # reports this prompt as complete — resolving on the first (empty) reply
    # is what made jobs wrongly show "done / no video" mid-generation.
    deadline = time.monotonic() + 900  # up to 15 min after the ws ends
    while True:
        try:
            entry = (await comfy.get_history(url, prompt_id)).get(prompt_id) or {}
        except Exception:
            entry = {}
        status = entry.get("status") or {}
        outputs = entry.get("outputs") or {}

        if status.get("status_str") == "error":
            job["status"], job["error"] = "error", status
            job["finished_at"] = time.time()
            log_event(job["pod_id"], "Generation error (ComfyUI)")
            _persist_jobs()
            return
        if outputs or status.get("completed"):
            job["video"] = _find_video(outputs)
            job["status"] = "done"
            job["finished_at"] = time.time()
            if job["max"]:
                job["progress"] = job["max"]
            # Always save_stat so completed_at is recorded even without started_at
            duration = (round(job["finished_at"] - job["started_at"])
                        if job.get("started_at") else None)
            ps.save_stat(prompt_id, duration, job["finished_at"])
            _backfill_seed(prompt_id, entry)
            log_event(job["pod_id"],
                      "Video ready ✓" if job["video"] else "Finished (no video output)")
            _persist_jobs()
            return
        if time.monotonic() > deadline:
            job["status"] = "error"
            job["error"] = "Timed out waiting for ComfyUI to finish."
            job["finished_at"] = time.time()
            log_event(job["pod_id"], "Generation timed out")
            _persist_jobs()
            return
        await asyncio.sleep(2)


def _backfill_seed(prompt_id: str, history_entry: dict):
    """Extract the actual seed used from ComfyUI history and persist it.

    ComfyUI always records the concrete seed (even randomised ones) in the
    queued workflow, so we can read it back and overwrite the _seed: 0
    placeholder that was saved at queue time.  Node "158" is the seed source
    node (see config.py PARAM_FIELDS _seed targets).
    """
    try:
        prompt = history_entry.get("prompt")
        if not (isinstance(prompt, list) and len(prompt) >= 3):
            return
        wf = prompt[2]
        if not isinstance(wf, dict):
            return
        seed_val = (wf.get("158", {}).get("inputs") or {}).get("seed")
        if not seed_val or int(seed_val) <= 0:
            return
        params = ps.get_params(prompt_id) or {}
        params["_seed"] = int(seed_val)
        ps.save_params(prompt_id, params)
    except Exception:
        pass


def _find_video(outputs: dict):
    node_ids = ([config.OUTPUT_NODE_ID] if config.OUTPUT_NODE_ID
                else list(outputs.keys()))
    for nid in node_ids:
        node = outputs.get(str(nid), {})
        for key in ("gifs", "videos", "images"):
            items = node.get(key)
            if items:
                it = items[0]
                return {"filename": it["filename"],
                        "subfolder": it.get("subfolder", ""),
                        "type": it.get("type", "output"),
                        "content_type": _content_type(it)}
    return None


def _input_image(entry: dict):
    """The uploaded image fed to this generation, from its stored workflow.

    History stores the queued prompt as [number, prompt_id, workflow, ...];
    we read the LoadImage node's `image` input so the UI can show it as a
    thumbnail for the resulting clip.
    """
    prompt = entry.get("prompt")
    wf = prompt[2] if isinstance(prompt, list) and len(prompt) >= 3 else prompt
    if not isinstance(wf, dict):
        return None
    node = wf.get(str(config.IMAGE_NODE["node_id"])) or {}
    img = (node.get("inputs") or {}).get(config.IMAGE_NODE["input"])
    return img if isinstance(img, str) else None


def _content_type(item: dict) -> str:
    fmt = item.get("format", "")
    name = item.get("filename", "")
    for needle, ctype in (("mp4", "video/mp4"), ("webm", "video/webm"),
                          ("webp", "image/webp"), ("gif", "image/gif"),
                          ("png", "image/png"), ("jpeg", "image/jpeg"),
                          ("jpg", "image/jpeg")):
        if needle in fmt or name.endswith("." + needle):
            return ctype
    return "application/octet-stream"


# Serve the mobile frontend. Mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
