"""FastAPI app: serves the mobile UI and proxies RunPod + ComfyUI.

The RunPod API key never leaves this process; the phone only ever talks to
this server (reached over your Tailscale network).
"""

import asyncio
import json
import uuid
from pathlib import Path

import websockets
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import comfy_client as comfy
from . import config
from . import runpod_client as rp
from . import workflow as wf

app = FastAPI(title="Wan Mobile")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# In-memory job tracking (good enough for a single user). Restarting the
# server forgets in-flight jobs; finished videos still live on the pod.
JOBS: dict[str, dict] = {}


# ----- config / pods -------------------------------------------------------
@app.get("/api/config")
async def get_config():
    return {"fields": config.PARAM_FIELDS}


@app.get("/api/gpus")
async def gpus():
    return await rp.list_gpus()


@app.get("/api/pods")
async def pods():
    data = await rp.list_pods()
    return [{**p, "comfy_url": rp.comfy_url(p["id"])} for p in data]


@app.get("/api/pods/{pod_id}")
async def pod_status(pod_id: str):
    pod = await rp.get_pod(pod_id)
    url = rp.comfy_url(pod_id)
    return {"pod": pod, "comfy_url": url, "comfy_ready": await comfy.is_ready(url)}


@app.post("/api/pods")
async def create(payload: dict = Body(default={})):
    return await rp.create_pod(gpu_type_id=payload.get("gpu_type_id"))


@app.post("/api/pods/{pod_id}/stop")
async def stop(pod_id: str):
    return await rp.stop_pod(pod_id)


@app.post("/api/pods/{pod_id}/resume")
async def resume(pod_id: str):
    return await rp.resume_pod(pod_id, 1)


@app.post("/api/pods/{pod_id}/terminate")
async def terminate(pod_id: str):
    return await rp.terminate_pod(pod_id)


# ----- generation ----------------------------------------------------------
@app.post("/api/generate")
async def generate(
    pod_id: str = Form(...),
    image: UploadFile = File(...),
    params: str = Form("{}"),
):
    values = json.loads(params)
    url = rp.comfy_url(pod_id)
    if not await comfy.is_ready(url):
        raise HTTPException(409, "ComfyUI is not ready on this pod yet.")

    data = await image.read()
    image_name = await comfy.upload_image(url, data, image.filename or "input.png")
    workflow = wf.build_workflow(values, image_name)

    client_id = uuid.uuid4().hex
    prompt_id = await comfy.queue_prompt(url, workflow, client_id)

    JOBS[prompt_id] = {"status": "running", "progress": 0, "max": 0,
                       "node": None, "pod_id": pod_id, "video": None}
    asyncio.create_task(_watch(url, client_id, prompt_id))
    return {"prompt_id": prompt_id}


@app.get("/api/status/{prompt_id}")
async def status(prompt_id: str):
    job = JOBS.get(prompt_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job


@app.get("/api/video/{prompt_id}")
async def video(prompt_id: str):
    job = JOBS.get(prompt_id)
    if not job or not job.get("video"):
        raise HTTPException(404, "no video for this job yet")
    v = job["video"]
    content = await comfy.fetch_view(
        rp.comfy_url(job["pod_id"]), v["filename"], v.get("subfolder", ""),
        v.get("type", "output"),
    )
    return Response(
        content=content,
        media_type=v.get("content_type", "video/mp4"),
        headers={"Content-Disposition": f'inline; filename="{v["filename"]}"'},
    )


# ----- background watcher ---------------------------------------------------
async def _watch(url: str, client_id: str, prompt_id: str):
    """Listen on ComfyUI's websocket for progress, then resolve the output."""
    job = JOBS[prompt_id]
    try:
        async with websockets.connect(comfy.ws_url(url, client_id),
                                       max_size=None) as ws:
            async for raw in ws:
                if isinstance(raw, bytes):  # binary = live preview, ignore
                    continue
                msg = json.loads(raw)
                mtype, d = msg.get("type"), msg.get("data", {})
                if mtype == "progress":
                    job["progress"], job["max"] = d.get("value", 0), d.get("max", 0)
                elif mtype == "executing":
                    job["node"] = d.get("node")
                    if d.get("node") is None and d.get("prompt_id") == prompt_id:
                        break  # this prompt finished executing
                elif mtype == "execution_error" and d.get("prompt_id") == prompt_id:
                    job["status"], job["error"] = "error", d
                    return
    except Exception:
        pass  # fall through to history-based resolution

    try:
        hist = await comfy.get_history(url, prompt_id)
        outputs = hist.get(prompt_id, {}).get("outputs", {})
        job["video"] = _find_video(outputs)
        job["status"] = "done"
        if job["max"]:
            job["progress"] = job["max"]
    except Exception as e:
        job["status"], job["error"] = "error", str(e)


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


def _content_type(item: dict) -> str:
    fmt = item.get("format", "")
    name = item.get("filename", "")
    for needle, ctype in (("mp4", "video/mp4"), ("webm", "video/webm"),
                          ("webp", "image/webp"), ("gif", "image/gif")):
        if needle in fmt or name.endswith("." + needle):
            return ctype
    return "application/octet-stream"


# Serve the mobile frontend. Mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
