# Wan Mobile

A phone-friendly control panel for running your **Wan2.2 image-to-video**
ComfyUI workflow on **RunPod** — without fighting the desktop ComfyUI UI.

From your phone you can:
- start / stop / resume / **terminate** pods, with **live account balance** in the header
- pick the GPU for a new pod (with a tappable **CUDA-version filter** and rough perf/value ratings)
- upload an input image (camera roll, camera, **or** files)
- save & reuse **prompt templates**; your last-used params are **remembered**
- tune just the few params you care about (incl. separate High/Low sampler + scheduler)
- watch generation progress and download / save the output video
- browse an **Outputs** tab that lists past videos straight from the pod — so a clip
  is recoverable even if you close the browser mid-generation

Two ways to reach it from your phone:

```
# Local (your PC must be on)
Phone ──Tailscale──► your PC (FastAPI) ──► RunPod API  (start/stop pods)
                                       └─► ComfyUI on the pod (run workflow)

# Always-on (PC can be off)
Phone ──HTTPS──► Fly.io (FastAPI) ──► RunPod API + ComfyUI on the pod
         (password-protected)
```

The RunPod API key never leaves the server process; the phone only ever talks
to this app.

---

## 1. One-time setup

```powershell
# from this folder
copy .env.example .env      # then edit .env (see below)
```

Fill in `.env`:
- `RUNPOD_API_KEY` — from https://www.runpod.io/console/user/settings
- `RUNPOD_TEMPLATE_ID` — your saved template that boots ComfyUI on port 8188
- `RUNPOD_IMAGE_NAME` — the template's container image. **Required** — RunPod
  rejects pod creation with a blank image even when a template is set
  (e.g. `nextdiffusionai/comfyui-sageattention:cuda12.8-v1`)
- `RUNPOD_NETWORK_VOLUME_ID` — the volume holding your Wan2.2 models
- `RUNPOD_VOLUME_MOUNT_PATH` — where the volume mounts in the pod. **Must match
  the template** (the Next Diffusion ComfyUI template uses `/workspace`; the
  RunPod SDK otherwise defaults to `/runpod-volume`, which leaves torch missing)
- `RUNPOD_DATA_CENTER_ID` — **must match the volume's region** (e.g. `EU-RO-1`)
- `RUNPOD_GPU_TYPE_ID` — default GPU (the app also lets you pick per-launch)
- `WAN_AUTH_USER` / `WAN_AUTH_PASS` — web login. Set **both** to require a
  password on every request (do this when hosting publicly on Fly.io). Leave
  blank to run open, which is fine for localhost / Tailscale only.

## 2. Point it at your real workflow

`workflows/YAW_2.2.json` is a real working workflow and is ready to use
out of the box. If you want to swap in a different workflow:

1. In ComfyUI: Settings → enable **Dev mode**, then **Save (API Format)**.
2. Replace `workflows/YAW_2.2.json` with that exported file (or set
   `WORKFLOW_FILE=your_file.json` in `.env` to point at a different name).
3. Edit `app/config.py` → `PARAM_FIELDS` and `IMAGE_NODE` so each `node_id`
   matches your workflow's node ids (open the JSON and find them). Optionally
   set `OUTPUT_NODE_ID` to your video-output node (e.g. VHS_VideoCombine).

## 3. Run locally

```powershell
.\run.ps1
```

First run builds a venv and installs deps; later runs just start the server on
`http://0.0.0.0:8000`.

## 4a. Reach it from your phone — Tailscale (local)

1. Install Tailscale on your PC and phone, sign into the same account.
2. On the phone, open: `http://<your-pc-name>.<tailnet>.ts.net:8000`
   (find the name with `tailscale status`, or use the PC's `100.x.y.z` IP).
3. Optional HTTPS without the port: `tailscale serve --bg 8000`.

## 4b. Reach it from anywhere — Fly.io (always-on)

Hosts the panel in the cloud so it's reachable 24/7, even when your PC is off.
The machine sleeps when idle and wakes on the next request (~1–2s), so it costs
only a few cents/month plus ~$0.15/mo for the 1 GB data volume.

```powershell
# install the CLI once (then open a NEW terminal)
iwr https://fly.io/install.ps1 -useb | iex

fly auth login                 # opens browser; account needs a card on file
fly launch                     # uses the included Dockerfile + fly.toml
#   - copy existing fly.toml? Yes
#   - pick a UNIQUE app name (becomes your URL) + a region near you
#   - let it create the "wan_data" volume; deploy when asked

# later, to push changes:
fly deploy
```

Then open `https://<your-app-name>.fly.dev` on your phone and log in with the
`WAN_AUTH_USER` / `WAN_AUTH_PASS` you set. "Add to Home Screen" for an app-like icon.

Notes:
- `.env` (with the RunPod key + login) is baked into the image at build time, so
  no `fly secrets` step is needed. To rotate just the password without a rebuild:
  `fly secrets set WAN_AUTH_PASS=...`.
- Prompt templates + last-used params persist on a **Fly volume** mounted at
  `/app/data` (seeded from the repo on first boot), surviving deploys.
- A GitHub Action (`.github/workflows/fly-deploy.yml`) auto-deploys on every push
  to `main`. It needs a `FLY_API_TOKEN` repo secret (`fly tokens create deploy`,
  then add it under GitHub → Settings → Secrets → Actions). If you don't want
  CI deploys, delete that file.

---

## Notes / gotchas

- **Image + mount path:** the most common deploy failure is the pod booting but
  ComfyUI reporting "missing GPU / no module named torch". That's almost always
  a wrong `RUNPOD_VOLUME_MOUNT_PATH` (the venv lives on the network volume) or a
  blank `RUNPOD_IMAGE_NAME`. Match both to your template.
- **CUDA filter:** the image needs CUDA ≥ 12.8. The deploy filter pins allowed
  CUDA versions so RunPod won't place the pod on an older-driver host (which
  fails to start). Toggle versions on the Pod tab.
- **Cold starts:** Terminate destroys the pod and stops billing, but the next
  launch must remount things. With your models on the **network volume**,
  spin-up is fast; the app shows "warming up" until ComfyUI answers.
- **Stop vs Terminate:** Stop keeps the disk (still small storage cost);
  Terminate destroys the pod. Both stop GPU billing.
- **Recovering videos:** live progress is tracked in memory, so restarting (or a
  Fly machine sleeping) forgets the in-flight job. Finished videos still live on
  the pod — use the **Outputs** tab to list and download them from the pod's
  ComfyUI history (works as long as the pod hasn't been restarted).
- **Python 3.14:** if a dependency fails to install, use Python 3.12 instead
  (`py -3.12 -m venv .venv`).

## Project layout

```
app/main.py          FastAPI routes + UI + Basic-auth + job watcher + outputs
app/runpod_client.py RunPod SDK wrapper (start/stop/terminate/list/balance)
app/comfy_client.py  ComfyUI API (upload, queue, history, view, ws)
app/workflow.py      patch the API-format workflow with your params
app/config.py        env settings + PARAM_FIELDS map  <-- edit this
app/persistence.py   JSON store for prompt templates + last params
workflows/           API-format workflow json (YAW_2.2.json included)
static/              mobile UI (no build step, vanilla JS)
data/                persisted prompt templates + last params
Dockerfile, fly.toml Fly.io deployment (always-on hosting)
```
</content>
