# Wan Mobile

A phone-friendly control panel for running your **Wan2.2 image-to-video**
ComfyUI workflow on **RunPod** — without fighting the desktop ComfyUI UI.

From your phone you can:
- start / stop / resume / **terminate** pods (and see what's currently costing you money)
- pick the GPU for a new pod
- upload an input image (camera roll works)
- tune just the few params you care about
- watch progress and download / save the output video

The RunPod API key stays on your PC; your phone only talks to this server over
your private Tailscale network.

```
Phone ──Tailscale──► your PC (FastAPI) ──► RunPod API  (start/stop pods)
                                       └─► ComfyUI on the pod (run workflow)
```

---

## 1. One-time setup

```powershell
# from this folder
copy .env.example .env      # then edit .env (see below)
```

Fill in `.env`:
- `RUNPOD_API_KEY` — from https://www.runpod.io/console/user/settings
- `RUNPOD_TEMPLATE_ID` — your saved template that boots ComfyUI on port 8188
- `RUNPOD_NETWORK_VOLUME_ID` — the volume holding your Wan2.2 models
- `RUNPOD_DATA_CENTER_ID` — **must match the volume's region** (e.g. `EU-RO-1`)
- `RUNPOD_GPU_TYPE_ID` — default GPU (the app also lets you pick per-launch)

## 2. Point it at your real workflow

`workflows/YAW_2.2.json` is a real working workflow and is ready to use
out of the box. If you want to swap in a different workflow:

1. In ComfyUI: Settings → enable **Dev mode**, then **Save (API Format)**.
2. Replace `workflows/YAW_2.2.json` with that exported file (or set
   `WORKFLOW_FILE=your_file.json` in `.env` to point at a different name).
3. Edit `app/config.py` → `PARAM_FIELDS` and `IMAGE_NODE` so each `node_id`
   matches your workflow's node ids (open the JSON and find them). Optionally
   set `OUTPUT_NODE_ID` to your video-output node (e.g. VHS_VideoCombine).

## 3. Run

```powershell
.\run.ps1
```

First run builds a venv and installs deps; later runs just start the server on
`http://0.0.0.0:8000`.

## 4. Reach it from your phone (Tailscale)

1. Install Tailscale on your PC and phone, sign into the same account.
2. On the phone, open: `http://<your-pc-name>.<tailnet>.ts.net:8000`
   (find the name with `tailscale status`, or use the PC's `100.x.y.z` IP).
3. Optional HTTPS without the port: `tailscale serve --bg 8000`.

---

## Notes / gotchas

- **Cold starts:** Terminate destroys the pod and stops billing, but the next
  launch must remount things. With your models on the **network volume**,
  spin-up is fast; the app shows "warming up" until ComfyUI answers, then
  enables Generate.
- **Stop vs Terminate:** Stop keeps the disk (still small storage cost);
  Terminate destroys the pod. Both stop GPU billing.
- **Python 3.14:** if a dependency fails to install, use Python 3.12 instead
  (`py -3.12 -m venv .venv`).
- Jobs are tracked in memory — restarting the server forgets in-flight jobs,
  but finished videos still live on the pod and in RunPod.

## Project layout

```
app/main.py          FastAPI routes + serves the UI + job watcher
app/runpod_client.py RunPod SDK wrapper (start/stop/terminate/list)
app/comfy_client.py  ComfyUI API (upload, queue, history, view, ws)
app/workflow.py      patch the API-format workflow with your params
app/config.py        env settings + PARAM_FIELDS map  <-- edit this
workflows/           API-format workflow json (YAW_2.2.json included)
static/              mobile UI (no build step, vanilla JS)
```
