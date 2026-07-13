# Wan Mobile — Agent Context

**Project type:** FastAPI + Vanilla JS mobile web app deployed on Fly.io.
**Purpose:** Mobile control panel for running **Wan 2.2 image-to-video (i2v)** generation on RunPod ComfyUI pods. One user (the owner), accessed from an iOS browser.
**Live URL:** https://wan-mobile.fly.dev/
**GitHub:** https://github.com/Morrow1ndy/wan-mobile
**Deploy command:** `fly deploy` (from project root, requires `flyctl` authenticated)

> **New session? Jump to [Changelog](#changelog) at the bottom first** — it's the
> fastest way to see what's changed recently before reading anything else.

---

## Git & deploy rules

- **Do NOT commit/push after every individual change.** More edits are likely
  coming in the same session. Only commit + push (and deploy if needed) when
  the user **explicitly says so** in their message (e.g. "push", "deploy",
  "commit this"). Batch all pending changes into one commit at that point.
- **Commit directly to `main` by default.** Don't open feature branches or PRs
  unless the user explicitly asks. Push straight to `main` (which auto-deploys —
  see below). If a session starts on some other branch, switch to `main` before
  committing.
- When committing, `git add -A` to include everything changed in the session.
- **Never run `fly deploy` manually.** Deployment is handled automatically by
  the GitHub Actions workflow (`.github/workflows/fly-deploy.yml`) on every push
  to `main` that touches `app/**`, `static/**`, `workflows/**`, `data/**`,
  `Dockerfile`, `requirements.txt`, or `fly.toml`. Doc-only pushes (CLAUDE.md,
  README) are skipped. Running `fly deploy` manually is redundant and wastes a
  build slot.

---

## How this document is maintained

This file is the **handoff document between Claude Code sessions and machines**.

**Do NOT touch the [Changelog](#changelog) section during normal work.** The user
will explicitly ask for a changelog update at the end of each day's work. At that
point, add a new entry (newest-first) covering:
- Features added or changed
- Bugs fixed (include root cause, not just symptom)
- Any new env vars, endpoints, or files introduced
- Known issues discovered but not yet fixed

Keep entries concise — bullet points, not paragraphs. The architecture sections
above should be updated in-place if something structural changes (don't just log
it in the changelog and leave the architecture stale).

**When starting a new session on a new machine:** read this whole file before
writing any code. The changelog is the fastest way to catch up on recent work.

---

## Architecture

```
wan-mobile/
├── app/
│   ├── main.py          # FastAPI app — all API routes + middleware
│   ├── drive_client.py  # Google Cloud Storage backend (videos + images)
│   ├── persistence.py   # Local JSON file store on the Fly volume
│   ├── comfy_client.py  # ComfyUI HTTP/WS client
│   ├── runpod_client.py # RunPod GraphQL API client
│   ├── workflow.py      # ComfyUI workflow builder
│   ├── push.py          # Web Push / VAPID key management + subscription store
│   └── config.py        # Settings loaded from environment / config files
├── static/
│   ├── index.html       # Single-page app shell (all overlays/modals in here)
│   ├── styles.css       # Dark mobile-first UI (CSS variables, no framework)
│   ├── app.js           # All frontend logic (~3500 lines, vanilla JS)
│   ├── sw.js            # Service worker — handles push events + notificationclick
│   └── manifest.webmanifest  # PWA manifest (required for iOS Web Push)
├── data/                # Fly persistent volume mount point
│   ├── saved_videos/    # MP4s — BOTH current-session and starred (2026-07-03), synced from GCS on startup
│   ├── saved_videos.json  # metadata for all of the above; is_saved distinguishes starred from session
│   ├── active_jobs.json # In-flight generation state (survives auto-stop)
│   ├── prompt_templates.json
│   ├── param_presets.json
│   ├── generation_params.json
│   ├── generation_durations.json
│   └── last_params.json
├── workflows/
│   ├── YAW_2.2_bf16.json            # Standard Sampler mode (WORKFLOW_FILE default)
│   ├── YAW_2.2_bf16_TripleK.json    # TripleKSampler mode
│   ├── YAW_2.2_bf16_Clownshark.json # Clownshark Sampler mode
│   └── ram_clear.json               # ComfyUI workflow for clearing VRAM
│   ⚠️ Filenames still say "bf16" but as of 2026-07-03 all three actually load
│   **fp16** UNET weights (`wan22-i2v-14b-fp16-{high,low}.safetensors`) — the
│   name is legacy/kept for backward compat with saved videos' `workflow_file`
│   field (see Workflow ↔ UI parameter map below). Don't infer precision from
│   the filename.
├── .env                 # local config — gitignored/untracked (see Security)
├── .env.example         # template for .env (this one IS committed)
├── fly.toml             # Fly.io config (512MB RAM, sin region, auto-stop)
├── Dockerfile
└── requirements.txt
```

**Dependencies** (`requirements.txt`): fastapi, uvicorn[standard], runpod, httpx,
websockets, python-dotenv, python-multipart, google-cloud-storage, pywebpush. No
frontend build step — `static/` is served as-is.

**Fly.io volume:** `wan_data` mounted at `/app/data`. Persists across restarts. The Dockerfile CMD conditionally seeds JSON files on first boot only.

**GCS bucket:** `wan-mobile-videos` (Google Cloud Storage)
- `saved_videos/` — output MP4 files; both current-session and starred clips
  live here since 2026-07-03 (`is_saved` in the metadata distinguishes them)
- `input_images/` — user's cloud image library (virtual folders via `.keep` blobs)
- `wan_saved_videos.json` — video metadata for everything above (source of truth)

**Auth:** HTTP Basic Auth via `WAN_AUTH_USER` / `WAN_AUTH_PASS` Fly secrets. The backend only protects `/api/*` routes (not static files), and returns plain 401 JSON (no `WWW-Authenticate` header) so the browser never shows its native dialog. The frontend handles auth with a custom login overlay.

---

## Configuration (env vars)

Config is read by `config.py` via `python-dotenv`'s `load_dotenv()`. **Locally**
these come from `.env` (in repo root). **On Fly** config comes from two places:
- **Real secrets** (`RUNPOD_API_KEY`, `WAN_AUTH_USER`, `WAN_AUTH_PASS`,
  `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_GCS_BUCKET`) → **Fly secrets**
  (`fly secrets set` / `fly secrets list`).
- **Non-secret RunPod pod-deploy config** (`RUNPOD_TEMPLATE_ID`,
  `RUNPOD_NETWORK_VOLUME_ID`, `RUNPOD_DATA_CENTER_ID`, `RUNPOD_VOLUME_MOUNT_PATH`,
  `RUNPOD_IMAGE_NAME`, `RUNPOD_GPU_TYPE_ID`, `RUNPOD_CLOUD_TYPE`, `COMFY_PORT`,
  `POD_NAME`) → the **`[env]` block in `fly.toml`** (committed). These used to
  travel in the committed `.env`; when `.env` was removed for the secrets fix
  they were dropped and pod creation broke — living in `fly.toml` now, they
  can't silently vanish on a rebuild.

`load_dotenv()` does not override already-set env vars, so a Fly secret / `[env]`
value wins over anything in a baked-in `.env`.

**Auth + cloud storage:**

| Var | Purpose |
|-----|---------|
| `RUNPOD_API_KEY` | RunPod GraphQL API key (**secret**) |
| `WAN_AUTH_USER` / `WAN_AUTH_PASS` | Login credentials; blank = open (local only) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full GCS service account JSON, stringified (**secret**) |
| `GOOGLE_GCS_BUCKET` | `wan-mobile-videos` |

**RunPod / ComfyUI pod config** (needed to actually deploy pods — see `config.py`):

| Var | Default | Purpose |
|-----|---------|---------|
| `RUNPOD_TEMPLATE_ID` | — | RunPod template the pod boots from |
| `RUNPOD_NETWORK_VOLUME_ID` | — | Network volume holding the models + venv |
| `RUNPOD_DATA_CENTER_ID` | — | Must match the network volume's data center |
| `RUNPOD_VOLUME_MOUNT_PATH` | `/workspace` | Where the volume mounts (template ships venv here) |
| `RUNPOD_GPU_TYPE_ID` | `NVIDIA GeForce RTX 4090` | Default GPU |
| `RUNPOD_CLOUD_TYPE` | `SECURE` | SECURE or COMMUNITY |
| `RUNPOD_IMAGE_NAME` | — | Container image (if not using template's) |
| `RUNPOD_CONTAINER_DISK_GB` | `20` | Scratch disk |
| `RUNPOD_ALLOWED_CUDA_VERSIONS` | `12.8,12.9,13.0` | CUDA filter for availability/deploy |
| `COMFY_PORT` | `8188` | ComfyUI port on the pod |
| `POD_NAME` | `wan22-i2v` | Name for created pods |
| `WORKFLOW_FILE` | `YAW_2.2_bf16.json` | Which workflow in `workflows/` to use |

---

## Workflow ↔ UI parameter map (FRAGILE — read before editing generation)

`config.py` `PARAM_FIELDS` maps each UI control to specific **node IDs** inside
the workflow JSON files. Three **sampler-mode** workflows are available; the
user picks one via the workflow tab in the Generate UI. Each mode is a
genuinely different node graph (ComfyUI's API-format export only serializes
whichever sampler branch is active), sharing 57 common nodes plus its own
sampler node(s):

| File (`WF_*` in `config.py`) | Sampler node(s) | Mode label (`WORKFLOW_LABELS`) | Default? |
|------|--------|----------|----------|
| `workflows/YAW_2.2_bf16.json` (`WF_STANDARD`) | `128`/`129` `KSamplerAdvanced` (High/Low) | Standard Sampler | ✓ (`WORKFLOW_FILE`) |
| `workflows/YAW_2.2_bf16_TripleK.json` (`WF_TRIPLEK`) | `290` `TripleKSamplerWan22LightningAdvanced` | TripleKSampler | selectable in UI |
| `workflows/YAW_2.2_bf16_Clownshark.json` (`WF_CLOWNSHARK`) | `209`/`210` `ClownsharKSampler_Beta` (High/Low) | Clownshark Sampler | selectable in UI |

The GGUF workflow/toggle was removed earlier — all three modes load one model
precision. **⚠️ As of 2026-07-03 that precision is fp16, not bf16** — the user
swapped `UNETLoader` nodes 177/178 to
`wan22-i2v-14b-fp16-{high,low}.safetensors` in all three files (was
`Wan2_2-I2V-A14B-{HIGH,LOW}_bf16.safetensors`). **The filenames
(`YAW_2.2_bf16*.json`) were deliberately left unchanged** — renaming them
would silently break the `workflow_file` string already stored on every
saved video (used to look up `WORKFLOW_LABELS` for the mode badge), plus
`WORKFLOW_FILE`/`WF_STANDARD` etc. Don't infer model precision from these
filenames; check node `177`/`178`'s `unet_name` in the actual JSON if it matters.

**Shared nodes** (`IMAGE_NODE` / `OUTPUT_NODE_ID`, identical across all three
files, no conditional logic needed):
- `IMAGE_NODE` = node `166` (LoadImage — receives the uploaded image)
- `OUTPUT_NODE_ID` = node `145` (VHS_VideoCombine — the saved video)
- Steps/CFG/Last-Step write to **two** source nodes each (an in-graph switch),
  so values apply whichever way the switch is flipped.
- The `lightx2v` toggle (distill LoRA) selects between two value sets and
  enables/disables the LoRA by setting strength (0 = off). CFG is forced to 1 when on.
- Seed is auto-randomized every run (`_seed` field → node `158`).
- **Width/height widget (2026-07-03)**: the old fixed node `169` ("Width and
  height from aspect ratio 🪴", baked `aspect_ratio: "9:16", target_size: 480`)
  was replaced by node `364` (`SimpleSwitch`, reads the loaded input image) →
  node `365` (`WanResolutions`, `aspect_ratio: "2:3"`,
  `resolution: "Preview — 512×768"`), still feeding the same `292`/`293` Width/
  Height Switch nodes. Not exposed in `PARAM_FIELDS` (no UI control either
  before or after) — purely a workflow-graph-internal change, verified to have
  zero effect on any `config.py` node reference.

**Per-mode fields** are scoped with a `"workflows": [WF_*]` key on the
`PARAM_FIELDS` entry — both `workflow.py`'s `build_workflow()` (skips any
field whose `workflows` list excludes the resolved workflow file, so a stale
value from another mode is silently ignored instead of KeyError'ing on a
node that doesn't exist in that graph) and the frontend's `_visibleFields()`
enforce this:
- **Standard**: `sampler`/`scheduler` → both `128` and `129`. `scheduler` is
  `multiselect` (fires one generation per selected scheduler, same seed).
- **TripleKSampler**: a single `sampler`/`scheduler` pair drives **both**
  Base and Lightning together (→ node `290`'s `base_sampler`+
  `lightning_sampler` / `base_scheduler`+`lightning_scheduler` — one
  `PARAM_FIELDS` entry per key, each with two `targets`). `scheduler` is
  `multiselect`, same as Standard. **Changed 2026-07-03** — this used to be
  two fully independent pairs (`sampler_base`/`scheduler_base` and
  `sampler_lightning`/`scheduler_lightning`, only the Base scheduler
  multiselect) with their own Base/Lightning UI labels; merged into one pair
  by request, deliberately reusing the same `sampler`/`scheduler` keys
  Standard already uses. This is safe because `PARAM_FIELDS` entries are
  scoped per-mode via `"workflows"` — only one of the two same-keyed entries
  is ever visible/collected at a time (`_visibleFields()` in `app.js`) — and
  it means a clip generated this way naturally renders through the existing
  single-pair (no Base/Lightning label) card path instead of needing new UI.
  Saved videos from before the merge still have the old `sampler_base`/
  `scheduler_base`/`sampler_lightning`/`scheduler_lightning` fields recorded;
  `_samplerPairs()` in `app.js` detects these legacy fields and displays the
  **Base** value as a plain unlabeled pair (matching the new single-pair
  look), dropping the Lightning value from the card/full-screen view (by
  request, so old clips visually match new ones instead of keeping a
  separate two-row Base/Lightning display) — the Lightning value isn't
  deleted from storage, just not shown on the card; it's still visible via
  Generation Details (`LEGACY_LABELS` keeps a "Sampler (Lightning)" label for
  it there).
- **Clownshark**: independent High (`cs_sampler_h`/`cs_scheduler_h` → node
  `209`) and Low (`cs_sampler_l`/`cs_scheduler_l` → node `210`) pairs, plain
  `select` (never multiselect). `sampler_name`/`scheduler` choices
  (`_CS_SAMPLER_CHOICES` — 119 entries / `_CS_SCHEDULER_CHOICES` — 11 entries)
  verified against a live pod's `/object_info/ClownsharKSampler_Beta` (a
  different, RES4LYF-namespaced node from `KSamplerAdvanced`). Also
  independent `cs_eta_h`/`cs_eta_l` sliders (→ node `209`/`210` `eta`, `min:
  0, max: 2, step: 0.01, default: 0.5` — the node's real range is -100..100,
  narrowed to a usable slider span). Confirmed via static graph inspection
  that `ClownOptions Detail Boost` (node `216`) is **not wired into any of
  the three workflow files** — dead/unused input in all of them, not just
  Clownshark.

**Sampling Mode tab placement + per-mode value memory (2026-07-03)**: the
mode tabs (`_workflowTabsHtml()` in `app.js`) render *inline inside* `#params`
between the LoRA fields and the sampler/scheduler fields — not as a separate
static element. `renderParamFields()` finds this boundary by splitting
`_visibleFields()` at the first field carrying a `workflows` key (i.e. the
first per-mode field), so it stays correct even if fields are
reordered/added, as long as per-mode fields remain contiguous. Mode-tab
clicks are handled by a delegated listener on `#params` (alongside the seed
buttons) rather than one listener per button, since this markup is rebuilt
on every `renderParamFields()` call.

Each mode's own sampler/scheduler/eta values are remembered independently
(`_perModeValues`, `_rememberModeValues()`/`_recallModeValues()`) — captured
whenever you switch away from a mode or hit Generate, and persisted via the
existing `/api/last-params` endpoint (opaque JSON, no backend schema
changes needed) under a `_perMode` key alongside the flat last-used-params
blob that endpoint already stored. `restoreLastParams()` loads `_perMode` on
boot and layers the *currently selected* mode's remembered values on top of
the flat blob (which only ever reflects whichever single mode was active at
the last save). `_selectedWorkflow` itself still always resets to the
server default each session (unchanged, deliberate — see the 2026-06-26
changelog entry on why) — only the field *values* persist per mode, not
which mode is active on reload.

⚠️ **If you re-export any of the three workflows from ComfyUI, node IDs
change** and every `node_id` in `PARAM_FIELDS` (plus `IMAGE_NODE` /
`OUTPUT_NODE_ID`) must be updated or generation silently breaks.
`workflow.py` builds the final prompt from this map. Re-check **all three**
files if you update node IDs — the 57 shared nodes must stay in sync.

**Sampler-mode + sampler/scheduler labels on video cards**: every
prompt_id's chosen `workflow_file` and sampler/scheduler value(s) are
persisted via `ps.save_params()` at generate time and surfaced identically
by `_job_public()` (in-progress card) and `_build_video_meta()` (session +
saved card — see "Video storage" below, both now built from the same
function) in `main.py` — same field names (`workflow_file`, `sampler`,
`scheduler`, `cs_sampler_h`, `cs_scheduler_h`, `cs_sampler_l`,
`cs_scheduler_l`, plus `steps`/`lx_ratio` — see below) from both, so
`app.js`'s `samplerModeBadge()` / `samplerPairRows()` (grid tile) and
`capSamplerHtml()` (expanded caption) render consistently across
in-progress, session, and saved cards without special-casing any of them.
`sampler_base`/`scheduler_base`/`sampler_lightning`/`scheduler_lightning` are
still surfaced too, but only ever populated on **legacy** TripleK saved
videos from before the 2026-07-03 single-pair merge (see the TripleKSampler
entry above) — new generations never write them.

**Total steps field**: `_compute_steps(params)` (`main.py`) returns
`steps_on` if `lightx2v` was enabled for that generation, else `steps_off` —
mirrors the toggle's own `when` condition in `PARAM_FIELDS`. Computed and
returned as `"steps"` alongside the sampler fields above by all three
surfacing points; `/api/saved/backfill-scheduler` backfills it for saved
videos recorded before this field existed. Rendered as a "STEPS N" row on
both the grid tile and the expanded caption; omitted when `null`.

**Short mode labels**: `_shortModeLabel(fullLabel)` (`app.js`) strips a
trailing `" Sampler"` (e.g. `"Standard Sampler"` → `"Standard"`,
`"TripleKSampler"` → `"TripleK"`, `"Clownshark Sampler"` → `"Clownshark"`) —
the single source of truth used by the grid-tile mode badge, the expanded
caption, and the Generate tab's sampling-mode tab buttons
(`_workflowTabsHtml()`), so all three stay in sync if `WORKFLOW_LABELS` in
`config.py` ever changes. Replaces an earlier hardcoded per-label map.

---

## Frontend Architecture (app.js)

**Auth system:** `_authHeader` (sessionStorage) → `apiFetch()` wraps all fetch calls, injects `Authorization` header, catches 401 → shows `#login-overlay`.

**Custom dialogs:** `showConfirm(msg, {okText, danger})` and `showPrompt(msg, default)` — styled overlays replacing all `confirm()` / `window.prompt()` system dialogs.

**Tabs:** Pod / Generate / Outputs. Sticky bottom bars (no `backdrop-filter` — iOS WebKit bug). All three `.tab` sections are plain `display:none`/`block` toggles sharing **one page-level scroll** — there is no independent scroll container per tab. `switchTab()` explicitly saves `window.scrollY` for the outgoing tab into `_tabScrollY` and restores the incoming tab's saved value at the end of the function (2026-07-03) — without this, switching to a shorter tab clamps the shared scroll position down, and nothing un-clamped it back on return.

**Undo system:** `captureUndo(label)` snapshots prompt + all params. `_undoStack` max 10. Captured at: template Use, preset Apply, details Apply-to-Generate, Generate. `↩ Undo (N)` button in Prompt card header.

**Image library state:** `_libPrefix`, `_libSelectMode`, `_libSelected` — library browser with folder navigation, select mode, bulk delete/copy/move, and bulk upload (2026-07-08) — a "+ Upload" button next to "Select" opens a multi-file picker and uploads every selected photo into `_libPrefix` (the currently-browsed folder), one `/api/images/save` call per file. Independent of the single-image "☆ Save to cloud" button on the Upload tab, which only ever saves `_currentImageFile`.

**Live job updates:** `connectJobStream(podId)` opens an `EventSource` on
`GET /api/pods/{pod_id}/stream` (SSE) — this is the only mechanism that
drives the in-progress "generating…" card; there is no polling `setInterval`
for it anymore (replaced 2026-06-25). `EventSource` auto-reconnects on any
drop (background/foreground, network blip), and the first message on every
new connection carries current server state, so the card self-heals within
~1s of reconnecting. `tickActive()` (one-shot fetch of `/api/pods/{id}/jobs`)
still exists only as an immediate fallback while the stream is reconnecting.
This is still pod-scoped (a job only ever runs on one pod) — unlike Current
Session below, which isn't.

**Current Session is pod-independent (2026-07-03)**: `loadDone()` /
`GET /api/session/outputs` no longer take or need a pod id — the list is a
persisted store that survives the originating pod being stopped/terminated
(see the backend's "Video storage" section). `_outPodId` still exists and is
still used, but now purely for **in-progress** job tracking (`connectJobStream`,
`tickActive`, `pollGenBadge`) — not for loading the completed-videos list.
`loadOutputs()` always calls `loadDone()` regardless of whether a pod is
selected; it only additionally opens the SSE stream when one is.

**Key state variables:**
```js
_authHeader        // "Basic base64..." or null
_currentImageFile  // File object (uploaded or fetched from library)
_libPrefix         // current folder path in image library
_undoStack         // [{prompt, params, label}] up to 10
_outPodId          // currently selected pod — used for in-progress job tracking only
JOBS               // in-memory job tracking (also persisted to active_jobs.json)
_savedSelectMode   // bulk select for saved videos
_libSelectMode     // bulk select for image library
```

---

## Backend Key Patterns

**GCS client** (`drive_client.py`): module-level `_gcs_bucket_cache` (single client instance). All calls have 60s timeout. Streaming helpers for thumbnails (`iter_image`) and video download (`download_video_to_file`) to avoid RAM buffering.

**Startup sync** (`_drive_startup_sync`): runs as a background task (not blocking uvicorn startup). Downloads GCS metadata → writes local JSON → streams missing videos to volume. Videos missing at serve time are fetched on demand by `serve_saved_file`.

**In-flight job lifecycle** (`JOBS` dict, `active_jobs.json`, `_watch()`) — this
is the current mechanism as of 2026-07-02; see that changelog entry for why
it changed:
- `_watch()` is the single source of truth for a job's progress: opens a
  ComfyUI websocket for live progress/preview, and falls back to polling
  `/history/{prompt_id}` every 2s if the socket drops or never connects.
- **On every attach** (a fresh `queue_prompt`, or `_restore_jobs()`
  re-attaching after this process restarts) `_watch()` does **one**
  `/history/{prompt_id}` check *before* touching the websocket. A fresh
  websocket only delivers *future* events, so without this check a prompt
  that already finished while the app was down would sit stuck as
  `status=running`, and a prompt still genuinely running would show
  "queued" forever since `started_at` never gets set without a live progress
  event. The pre-check resolves an already-finished prompt immediately and
  backfills `started_at` for one still in progress. It's a no-op for a
  normal freshly-queued prompt (nothing in ComfyUI's history for it yet).
- **On resolving to "done"**, `_watch()` `await`s `_persist_completed_video()`
  (see "Video storage" below) *before* marking the job done in `JOBS` — so by
  the time any client can see the completed status, the video is already
  durably stored, not just referenced via a live pod query.
- `active_jobs.json`: written at queue/start/terminal states via
  `_persist_jobs()`. `_restore_jobs()` on startup re-attaches `_watch()` to
  any `status=running` job. Jobs auto-expire from the file (only running +
  last 60s after finish are persisted).
- `_keepalive_loop()`: self-pings this app's **public** Fly URL (not
  `localhost` — a loopback request never reaches the Fly proxy, so it never
  counted as inbound traffic and was a silent no-op for months) every 30s
  while any job is running, so Fly's `auto_stop_machines` doesn't stop this
  app machine (not the RunPod pod) mid-generation.
- Client-side delivery is via SSE (`GET /api/pods/{pod_id}/stream`), see
  "Live job updates" under Frontend Architecture above — not polling.

**Video storage (2026-07-03 rearchitecture)** — "Current Session" and "Saved"
are both views over the SAME persisted list (`ps.get_saved()` /
`data/saved_videos.json` + GCS `saved_videos/` prefix), distinguished only by
an `is_saved` flag on each entry:
- `_persist_completed_video(prompt_id, job)` downloads the video (Fly volume +
  GCS) as soon as a generation finishes — `await`ed from `_watch()`, not a
  background fire-and-forget — with `is_saved: False`. This replaces the old
  design where "Current Session" was a **live** query against the pod's
  ComfyUI `/history` (via the now-removed `pod_outputs()` /
  `comfy_client.get_history_all()`), which vanished the instant that specific
  pod was stopped or terminated. Now every completed clip is durable
  independent of any pod's lifecycle — only starred ones used to survive
  termination; now *all* of them do, until explicitly deleted or the session
  is cleared (see below). Idempotent (skips a prompt_id already persisted) so
  `_watch()` re-resolving the same job after a restart doesn't re-download.
- `_build_video_meta()` builds the metadata dict (sampler/scheduler/steps/
  lx_ratio/etc. — same shape used by `_job_public()` for the in-progress
  card) shared by both the auto-persist path and starring.
- **Starring/unstarring is a metadata flip, not a file operation**:
  `POST /api/saved/{prompt_id}/star` sets `is_saved: True` (video is already
  downloaded); `POST /api/saved/{prompt_id}/unstar` sets it back to `False`.
  Neither touches the file. `DELETE /api/saved/{prompt_id}` is the only
  operation that actually removes it (file + GCS + metadata) — used by both
  sections' "Delete" action now, since there's nothing pod-specific left to
  purge.
- `GET /api/session/outputs` returns `is_saved: False` entries (Current
  Session); `GET /api/saved` returns `is_saved: True` entries (Saved). Both
  are plain reads of the local JSON — no pod, no network call, no per-pod
  scoping.
- `POST /api/session/clear` deletes every `is_saved: False` entry (file + GCS
  + metadata) — called by the frontend after the user confirms deploying a
  new pod despite having unstarred session clips (see the Frontend
  Architecture section's "Current Session" note). Starred entries are never
  touched by this.
- `GET /api/pods/{pod_id}/view` (pod-proxied) is still used, but now only for
  the **in-progress** card's live sampling preview / input-image thumbnail —
  anything already in Current Session or Saved is served from local/GCS
  storage via `GET /api/saved/file/{filename}` instead, which is why
  `renderOutput()` in `app.js` no longer takes a `podId` and both sections
  share one render function.

**Saved video concurrency** (`_saved_lock`): `asyncio.Lock()` serializes read-modify-write of the shared session+saved metadata + its GCS upload so concurrent star/unstar/persist/clear calls don't clobber each other.

**Storage endpoint:** `GET /api/storage` — returns `shutil.disk_usage` of the volume + `saved_bytes` (now covers every persisted video — session and starred alike, since both live in `SAVED_DIR`). Used by storage meter UI.

**RAM endpoint:** `GET /api/sysmetrics` — reads from `/sys/fs/cgroup/memory.current` (Fly cgroup) or `/proc/meminfo`. Used by header RAM chip.

---

## UI Design Tokens (styles.css)

```css
--bg: #0b0c0e      /* page background */
--surface: #141518  /* cards */
--surface-2: #191b1f /* ghost buttons, inputs */
--solid: #0f1012   /* inner elements */
--line: rgba(255,255,255,0.09)
--line-2: rgba(255,255,255,0.16)
--text: #f4f5f7
--muted: #9098a3
--accent: #6e8bff  /* blue — primary actions, durations, icons */
--good: #4ade80    /* green — pod ready */
--warn: #f5b34a    /* amber — storage >75%, RAM >75% */
--red: #f87171     /* red — errors, delete, storage >90% */
```

**Font:** Inter (Google Fonts).

---

## iOS / mobile CSS rules — READ BEFORE ADDING ANY NEW UI

These are hard-won fixes for iOS WebKit / Chrome bugs. Violating them causes
visual glitches that only appear on iOS, not on desktop.

**Rule 1 — Never use `backdrop-filter` on any `position: fixed` or `position: sticky` element.**
iOS WebKit composites `backdrop-filter` elements onto a separate GPU layer. On
`position: fixed` this breaks the fixed positioning during scroll (the bar drifts
into the page). On `position: sticky` it bleeds the blur onto sibling/child
elements during scroll momentum (inactive tab buttons appear to gain a dark
background). **Fix: use a solid or near-opaque background colour instead.**
Affected elements: `.generate-bar`, `.deploy-bar`, `.bulk-bar`, `.tabs` — all
already use solid `#0b0c0e` or opaque gradients for this reason.

**Rule 2 — Never use `aspect-ratio` for grid tiles that contain `<img>` elements.**
iOS WebKit lets the image's intrinsic size override the `aspect-ratio` constraint,
collapsing rows into thin strips. **Fix: use `padding-bottom: 100%` on the tile
with `position: absolute; inset: 0` on the inner content.** Already applied to
`.lib-folder-tile` and `.lib-file-tile`.

**Rule 3 — Always truncate text in constrained containers.**
Long strings (filenames, folder names) break out of flex/block containers on iOS
if `overflow: hidden` is not set. **Fix: add `overflow: hidden; text-overflow:
ellipsis; white-space: nowrap` to any text element that could receive user-supplied
or dynamic content inside a fixed-width container.** Already applied to
`#image-label` and `.lib-folder-name`.

---

## Security

- **`.env` is NOT committed** (fixed 2026-07-01 when the repo went public —
  see that changelog entry): it's in both `.gitignore` and `.dockerignore`,
  the leaked `RUNPOD_API_KEY` / `WAN_AUTH_PASS` were **rotated** (old values
  in git history are dead), and real secrets live in **Fly secrets**
  (`fly secrets list` is the source of truth). `.env.example` is the only
  env file tracked. Local dev uses an untracked `.env`.
- Any NEW secret env var must be added via `fly secrets set`, not just
  `.env` — a baked-in `.env` no longer exists in the image, so a var missing
  from Fly secrets (or fly.toml `[env]` for non-secrets) is simply unset in
  production.
- Service account key (`*.json.key`) IS gitignored; it lives in the
  `GOOGLE_SERVICE_ACCOUNT_JSON` Fly secret.

---

## Known Remaining Issues

- **`active_jobs.json` on stale pod**: if a pod was terminated mid-generation, the restored watcher polls for 15 min before erroring out. Low priority.
- **No video count/storage limit**: since 2026-07-03 *every* completed generation is auto-downloaded to permanent storage (not just starred ones — see "Video storage" above), so the volume/GCS fill faster than before. The storage meter makes usage visible, and `POST /api/session/clear` (fired when starting a new pod over leftover unsaved clips) is the only auto-eviction — there's still no cap or manual bulk-cleanup for old *starred* videos, or for session videos that were never cleared via a new pod deploy.
- **Fly deploy WARNING "not listening on expected address"**: benign — Fly's smoke check snapshots the instant before Python finishes importing heavy libraries on cold boot. App reaches good state seconds later.

---

## Common Operations

```bash
# Deploy
fly deploy

# View logs
fly logs

# SSH into machine
fly ssh console

# Check secrets
fly secrets list

# Restart machine
fly machine restart

# Run locally — MUST run from project root (main.py uses relative imports;
# `cd app && uvicorn main:app` will fail with an ImportError)
python -m uvicorn app.main:app --reload --port 8000
```

---

## Workflow Notes

- **Pushing code changes**: `git add -A && git commit -m "..." && git push` —
  GitHub Actions auto-deploys on push to `main` (do NOT run `fly deploy`
  manually; see the Git & deploy rules at the top of this file).
- **Pulling on new machine**: `git pull`. Fly secrets live on Fly (not git), so
  the server is unaffected; recreate a local `.env` from `.env.example` if
  running locally (`.env` is gitignored — see Security).
- **`data/*.json`** (templates, presets, saved_videos.json, last_params, etc.) ARE
  **committed** — they're the seed data the Dockerfile copies onto the volume on
  first boot. Editing them in git changes the seed for fresh volumes.
- **Gitignored** (NOT in repo): `data/saved_videos/*.mp4` (live in GCS + volume),
  `data/active_jobs.json` (runtime state), `*.json.key` (the GCS service-account
  key → stored as the `GOOGLE_SERVICE_ACCOUNT_JSON` Fly secret).
- **`saved_videos.json` is committed seed data but also the GCS source of truth** is
  `wan_saved_videos.json` — on startup the GCS copy overwrites the local one.

---

## Changelog

Entries are newest-first. Each entry should be added at the **top** of this list.

---

### 2026-07-08 (bulk photo upload to cloud library)

**Features added:**
- **"+ Upload" button in the Library tab** (next to "Select") opens the
  device's file picker with multi-select enabled (`<input type="file"
  multiple>`) and uploads every selected photo straight into whichever
  folder is currently browsed — one `POST /api/images/save` call per file
  (sequential), with a running "Uploading N/M…" toast, then reloads the
  library view to show the new files. No backend changes needed — reuses
  the existing single-file endpoint per upload.
- **Separate from the existing "☆ Save to cloud" button** (Upload tab) —
  that one still only saves the single image currently loaded for
  generation (`_currentImageFile`); untouched by this change. The two
  flows just happen to share the same backend endpoint.
- Verified with a Playwright test: 3 selected files all land under the
  browsed folder path, the library view refreshes to show them, and the
  old single-image save button is confirmed unaffected.
- SW cache bumped to `wan-static-v55`.

---

### 2026-07-08 (CRITICAL: legacy starred videos misclassified as unsaved — audit fixes)

**Bugs fixed:**
- **⚠️ CRITICAL — every pre-rearchitecture starred video was misclassified as
  an unsaved session clip** after the 2026-07-03 unified-storage deploy.
  Metadata written by the old code has no `is_saved` key at all (the key was
  only introduced in that rearchitecture), and every read treated a missing
  key as falsy — so the user's previously-starred videos (which are, by
  definition, the only entries the old model ever persisted) vanished from
  the ⭐ Saved section, showed up under Current Session as unsaved, and —
  worst — were eligible for **permanent deletion** by `clear_session()` on
  the next confirmed pod deploy. Fixed in two layers: a new `_is_saved()`
  helper defaults a MISSING key to `True` (fail-safe) in `list_saved()`/
  `session_outputs()`/`clear_session()`, and the boot backfill now
  materializes `is_saved: True` onto key-less entries — placed *before* the
  missing-params skip, since the oldest starred videos are exactly the ones
  whose params have aged out of the 500-entry cap. Verified with tests
  reproducing the production state (legacy entries → correct sections,
  `clear_session` deletes nothing, backfill materializes the key).
- **Startup GCS sync could clobber a video persisted during boot** —
  `_drive_startup_sync` blindly overwrote `saved_videos.json` with the GCS
  snapshot, from a thread, without holding `_saved_lock`. A restored watcher
  resolving a finished job seconds after boot (`_persist_completed_video`)
  raced that overwrite and could get its metadata entry silently dropped,
  orphaning the video file. Now async: metadata merge happens under
  `_saved_lock`, and it MERGES (local-only entries — persisted after the
  GCS snapshot — are kept and pushed back up) instead of overwriting.

**Cleanup / docs:**
- Removed dead `GET /api/video/{prompt_id}` (nothing calls it since playback
  moved to `/api/saved/file/{filename}`).
- Outputs-tab hint text updated ("Videos generated on this pod…" described
  the pre-rearchitecture model); README's "Recovering videos" bullet
  rewritten for the same reason; CLAUDE.md app.js line count corrected.
- SW cache bumped to `wan-static-v54`.

---

### 2026-07-03 (Current Session survives pod termination — unified video storage)

**Bugs fixed:**
- **"Current Session" videos were permanently lost the instant their pod was
  terminated**, even though nothing warned about it. Root cause: Current
  Session was a *live query* against the pod's own ComfyUI `/history` — the
  instant that specific pod was terminated, there was no way to query it
  anymore, so the whole list (not just in-progress jobs) vanished. Worse, the
  earlier "double-confirm before deploying" safeguard (2026-07-03, previous
  entry) only ever checked *currently-running* pods, so once the old pod was
  already terminated there was nothing left to warn about — the exact
  sequence (terminate, then later deploy) silently lost unsaved clips with
  zero warning at either step.

**Architecture change:**
- **"Current Session" and "Saved" are now both views over the SAME persisted
  list** (`data/saved_videos.json` + GCS `saved_videos/` prefix), distinguished
  only by an `is_saved` flag — see the "Video storage" section above for the
  full breakdown. In short:
  - Every completed generation is now auto-downloaded to permanent storage
    (Fly volume + GCS) the moment it finishes — not just starred ones —
    via a new `_persist_completed_video()`, `await`ed inside `_watch()`
    right when a job resolves to "done". This is independent of the pod's
    lifecycle from that point on, including if the pod is later terminated.
  - Starring/unstarring became a pure metadata flip (`POST
    /api/saved/{id}/star` / `/unstar`) — no re-download needed, since the
    video was already persisted when it completed.
  - `DELETE /api/saved/{id}` is now the one real-deletion endpoint, shared by
    both sections' "Delete" action.
  - `GET /api/session/outputs` (new) / `GET /api/saved` are plain local
    reads — no pod, no network call, no per-pod scoping. `renderOutput()` in
    `app.js` no longer takes a `podId` and now covers both sections (was two
    near-duplicate functions).
  - The deploy-time unsaved-video check (`_unsavedSessionVideoCount()`) now
    reads from `/api/session/outputs`, so it actually works regardless of
    whether the old pod is still running — and on confirmation, a new
    `POST /api/session/clear` deletes the leftover unstarred clips, so
    starting a new pod genuinely starts a clean session as originally
    intended.
  - Removed the now-dead `pod_outputs()` (`GET /api/pods/{pod_id}/outputs`),
    `_input_image()`, `DELETE /api/pods/{pod_id}/outputs/{prompt_id}`, and
    `comfy_client.get_history_all()`/`delete_history()` — all superseded by
    the persisted-list approach above.
- Verified with backend unit tests (persist → star → unstar → delete,
  idempotency on re-processing, session-clear preserving starred videos) and
  Playwright UI tests (star/unstar/delete flows on both sections, and the
  full deploy-with-leftovers warn-then-clear flow).
- SW cache bumped to `wan-static-v53`.

---

### 2026-07-03 (Saved section collapsed by default on Outputs tab)

**Changes:**
- **The ⭐ Saved section on the Outputs tab now starts collapsed** instead of
  expanded — matches the collapse/expand mechanism `#session-toggle`/
  `#saved-toggle` already use (`list.style.display === "none"` = collapsed).
  `static/index.html` now sets `#saved-list`'s initial `style="display:none"`
  and its chevron to `▸` (was `▾`/expanded); `📹 Current Session` is
  unaffected and still starts expanded. `loadSaved()` never touches
  `list.style.display` on refresh, so this is purely a default-state change —
  manually expanding/collapsing still works exactly as before and survives
  refreshes.
- SW cache bumped to `wan-static-v52`.

---

### 2026-07-03 (Current Session no longer capped at 30 clips + double-confirm before deploying over unsaved videos)

**Bugs fixed:**
- **"Current Session" silently dropped older clips once more than 30 had been
  generated on a pod**, even though the pod was still running. Root cause:
  `pod_outputs()` read the pod's ComfyUI history via `get_history_all(...,
  max_items=limit)` with `limit` defaulting to 30 — a real cap, not just a
  page size. Both defaults (`pod_outputs`'s `limit` and
  `get_history_all`'s `max_items`) bumped to 10,000 (effectively unbounded).
  Current Session now shows every clip generated on a pod for its whole
  lifetime; it only empties when that pod is replaced/terminated (a fresh
  pod has no ComfyUI history of its own) — never from a count limit.

**Features added:**
- **Double-confirm before deploying a new pod if unsaved session videos
  exist** — clicking "Deploy selected GPU" now checks every currently
  running pod's Current Session for videos that haven't been starred (★).
  If any exist, a confirm dialog names the count and asks to proceed before
  the deploy request fires; cancelling blocks the deploy entirely. Already-
  saved videos don't trigger it (they're safely in cloud storage already),
  and if nothing is at risk the deploy proceeds with no interruption. New
  `_unsavedSessionVideoCount()` helper in `app.js` (queries `/api/pods` for
  running pods, then each one's `/api/pods/{id}/outputs`, summing entries
  where `!is_saved`).
- Verified both paths with a real headless-browser test: deploy blocked on
  Cancel and proceeding on Confirm when unsaved videos exist, and deploying
  immediately with no dialog when everything is already saved.
- SW cache bumped to `wan-static-v51`.

---

### 2026-07-03 ("Apply to Generate" ignored a legacy TripleK clip's sampler/scheduler)

**Bugs fixed:**
- **Applying a legacy TripleK video's Generation Details silently dropped its
  sampler/scheduler values**, leaving the Generate tab showing TripleK's
  plain defaults (`euler`/`simple`) instead of the clip's actual recorded
  values. Root cause: today's earlier single-pair merge changed the current
  TripleK fields to the `sampler`/`scheduler` keys (same as Standard), but
  clips generated *before* that merge have their values stored under the old
  `sampler_base`/`scheduler_base`/`sampler_lightning`/`scheduler_lightning`
  keys — `applyParams()` only writes a value to the DOM element matching its
  own key, and there's no longer a `sampler_base` field to write to, so the
  value silently no-opped instead of erroring.
  Fixed: the `.details-apply` handler now falls back to the Base value
  (`sampler_base`/`scheduler_base`) when the current `sampler`/`scheduler`
  keys aren't present on the saved params — consistent with the earlier
  choice to display the Base value on legacy TripleK cards. New-style
  TripleK clips, Standard, and Clownshark were verified unaffected by this
  bug (their saved params already use the same keys as their current
  Generate-tab fields).
- Verified with a real headless-browser test driving the actual
  `showDetails()`/`applyParams()` code against mocked params for all four
  cases (Standard, new-style TripleK, legacy TripleK, Clownshark).
- SW cache bumped to `wan-static-v50`.

---

### 2026-07-03 (legacy TripleK videos now match the new single-pair look)

**Changes:**
- **Existing (legacy) TripleK saved videos still showed the old two-row
  Base/Lightning display** after the single-pair merge earlier today, since
  `_samplerPairs()` deliberately preserved their old recorded values. By
  request, changed this so legacy clips now display their **Base** sampler/
  scheduler value as a plain unlabeled pair — visually identical to how new
  TripleK clips render — instead of two labelled Base/Lightning rows. The
  Lightning value (which could genuinely differ from Base) is no longer
  shown on the card/full-screen view, but isn't deleted from storage — it's
  still visible in Generation Details, which keeps a "Sampler (Lightning)"/
  "Scheduler (Lightning)" label for it via `LEGACY_LABELS`. Falls back to
  the Lightning value only if Base wasn't recorded at all.
- SW cache bumped to `wan-static-v49`.

---

### 2026-07-03 (TripleK: single sampler/scheduler pair + in-progress card parity)

**Changes:**
- **TripleKSampler's independent Base/Lightning sampler+scheduler pair
  merged into one pair that drives both simultaneously** — the Generate tab
  now shows a single "Sampler"/"Scheduler" control for TripleK (matching
  Standard), instead of four separate Base/Lightning fields. `config.py`'s
  `PARAM_FIELDS` now has TripleK reuse the same `sampler`/`scheduler` keys
  as Standard, each with two `targets` (node `290`'s `base_sampler`+
  `lightning_sampler`, and `base_scheduler`+`lightning_scheduler`), so one
  selection writes to both stages. Safe to share keys with Standard's
  entries because `PARAM_FIELDS` fields are scoped per-mode via
  `"workflows"` — only one of the two same-keyed entries is ever
  visible/collected at a time. `scheduler` stays `multiselect` (fires one
  generation per selected scheduler, same as Standard).
  - New TripleK generations now render as a single unlabeled sampler/
    scheduler pair everywhere (grid tile, full-screen player, in-progress
    card) via the existing single-pair fallback in `_samplerPairs()` —
    no new rendering code needed.
  - **Legacy TripleK saved videos** (generated before this merge) still have
    the old independent `sampler_base`/`scheduler_base`/`sampler_lightning`/
    `scheduler_lightning` fields recorded and still render as two labelled
    Base/Lightning rows — `_samplerPairs()` checks for these legacy fields
    before falling through to the single-pair case, so old data isn't lost.
    Generation Details also keeps clean "Sampler (Base)"/"Sampler
    (Lightning)" labels for these via a `LEGACY_LABELS` entry, since they no
    longer have a matching `PARAM_FIELDS` entry to pull a label from.
- **In-progress "generating" card now shows the same info as a completed
  card** — it was missing the Steps + lightx2 ratio row added earlier today.
  `upsertActiveCard()` now also renders `_stepsLxRowHtml()`, so the card is
  visually consistent from the moment a video starts generating through to
  the finished/saved card.
- SW cache bumped to `wan-static-v48`.

---

### 2026-07-03 (lightx2 High:Low ratio on cards + auto-backfill on boot)

**Features added:**
- **lightx2/ning distill-LoRA High:Low strength ratio now shown on every
  card** — e.g. `2:1`, or `2:0.8` if the strengths were tuned unevenly (raw
  values preserved, not rounded to a fixed scale). New `_compute_lx_ratio(params)`
  in `main.py` returns `f"{high}:{low}"` from `lx_high`/`lx_low` only when
  `lightx2v` was on for that generation (the LoRA strengths are forced to 0
  when it's off, so a ratio isn't meaningful then — returns `None`). New
  `_fmt_ratio_num()` helper strips trailing `.0` (`2.0` → `"2"`) without
  rounding real decimals (`0.8` stays `"0.8"`). Wired into the same three
  surfacing points as `steps` (`_job_public()`, `pod_outputs()`,
  `star_video()`) as a new `"lx_ratio"` field.
- **Rendered on the same row as Steps, styled the same way** — "lightx2" is
  its own `.sched-row-label` (uppercase, muted — identical styling to
  "Steps"), not folded into the value text. `app.js`'s `_stepsLxRowHtml(it)`
  (replaces the earlier plain-text `_stepsLxText`) builds
  `STEPS 10  LIGHTX2 2:1` as two label/value pairs on one row; used by both
  the grid tile and the expanded/full-screen caption (`capSamplerHtml()`).
  Omits the lightx2 part entirely when `lx_ratio` is `null` (lightx2v was off,
  or the clip predates this field).
- **Existing saved videos now auto-backfilled on every boot** — the
  `/api/saved/backfill-scheduler` migration (previously POST-only, and never
  actually invoked against production data after being added, which is why
  `steps` never appeared on existing saved videos) is now also called from
  `_startup()` via a new `_backfill_after_sync()` task, after the GCS sync
  completes. Idempotent (skips any field already set), so this runs safely
  on every boot at ~no cost once caught up — no manual API call needed
  whenever a future field is added to this migration. Extended the migration
  itself to also fill in `lx_ratio` (alongside the existing `steps` fill-in).
- SW cache bumped to `wan-static-v47`.

---

### 2026-07-03 (compact sampler labels + total steps + shorter player info panel)

**Changes:**
- **Sampling-mode badge shrunk on grid tiles** — `.tile-foot .mode-badge` dropped
  to 8px font / tighter padding (was inheriting the base 10px pill).
- **Total steps now shown on every card** — new `_compute_steps(params)` helper
  in `main.py` picks `steps_on` when `lightx2v` was enabled for that generation,
  else `steps_off` (mirrors the toggle's own `PARAM_FIELDS` condition). Returned
  as `"steps"` from `_job_public()` (in-progress card), `pod_outputs()`
  (session/completed card), and `star_video()` (saved card) meta, and backfilled
  for existing saved videos via `/api/saved/backfill-scheduler`. Rendered as a
  plain "STEPS N" row — grid tile (below the sampler/scheduler rows) and
  expanded caption (below the sampler block). Omitted when not recorded.
- **Full-screen player: mode name is now plain blue text merged onto the
  sampler/scheduler row, not a separate pill/stripe** — new `_shortModeLabel()`
  (regex-strips a trailing " Sampler", e.g. "Standard Sampler" → "Standard")
  replaces the old hardcoded `TILE_MODE_LABELS` map and is now used
  consistently in three places: the grid-tile mode badge, the new expanded-
  caption renderer `capSamplerHtml()`, and the Generate tab's sampling-mode
  tab buttons (`_workflowTabsHtml()`) — all three now show "Standard"/
  "TripleK"/"Clownshark" instead of the full label. `capSamplerHtml()` puts the
  mode name (`.cap-mode-name`, blue, no background) on the same row as the
  first sampler/scheduler pair; a second pair (TripleK Base/Lightning,
  Clownshark High/Low) gets an invisible same-width `.cap-mode-name.cap-mode-
  spacer` instead of repeating the name, so both rows stay aligned under one
  visual column.
- **Expanded player's bottom info panel made noticeably shorter**, handing that
  space back to the video (`.out-cover` is `flex:1`, so anything trimmed off
  `.out-cap` grows the video) — tightened `.out-cap` padding/gaps and
  `.sched-row`/`.sched-row-label` font-sizes. Measured via a Playwright
  before/after height comparison: **Standard 142px → 119px, Clownshark
  164px → 136px** (~16–17% shorter), despite adding the new Steps row, since
  merging the mode name onto the pair row (round 2) roughly offset it (round 1).
- SW cache bumped to `wan-static-v46`.

---

### 2026-07-03 (param presets now carry sampling mode too)

**Bugs fixed:**
- **Applying a param preset had the same "wrong sampling mode" bug as
  Generation Details' "Apply to Generate"** (fixed earlier the same day) —
  `#preset-apply` called `applyParams(preset.params)` directly with no
  mode-switch, so a preset saved while e.g. Clownshark was active would
  silently drop its `cs_sampler_h`/`cs_scheduler_h`/`cs_eta_h`/etc. values
  (no matching DOM input exists until that mode is selected) if a different
  mode was currently showing, without ever switching to Clownshark either.
  Root cause was one step earlier than Details' version of this bug though:
  presets never even *recorded* which mode they were saved under —
  `collectParams()` (what `#preset-save`/`#preset-update` send) doesn't
  include `workflow_file` at all, since it's tracked separately via the
  `_selectedWorkflow` JS variable, not a real `PARAM_FIELDS` DOM input.
  Fixed: `#preset-save`/`#preset-update` now stamp `workflow_file:
  _selectedWorkflow` onto the saved params (the `/api/param-presets`
  storage is a schema-less JSON blob, so no backend change needed), and
  `#preset-apply` switches `_selectedWorkflow` + re-renders the fields
  first when the preset's mode differs from the current one — same pattern
  as the Details fix. Presets saved before this fix have no `workflow_file`
  recorded and just apply against whichever mode is currently selected, as
  before.
  **Correction to the earlier entry**: that entry's "known related gap"
  note lumped templates in with presets — templates (`#tpl-*`) are prompt-
  text-only snippets (`{name, text}`, just writes the Prompt textarea) and
  were never affected by this class of bug in the first place; only
  presets (`{name, params}`, a full field snapshot) were.
- Verified with a real headless-browser test: saved a preset while
  Clownshark mode was active with distinctive sampler/scheduler/eta values,
  switched to Standard mode, applied the preset, and confirmed it switched
  back to Clownshark with all values restored correctly.
- SW cache bumped to `wan-static-v45`.

---

### 2026-07-03 ("Apply to Generate" didn't switch to the clip's actual sampling mode)

**Bugs fixed:**
- **Generation Details' "Apply to Generate" silently dropped the sampler
  mode's own fields** whenever a different mode was currently selected in
  the Generate tab — e.g. opening Details for a Clownshark-generated clip
  while Standard mode was showing, then hitting Apply, never switched to
  Clownshark and never applied `cs_sampler_h`/`cs_scheduler_h`/`cs_eta_h`/
  etc. at all. Root cause: `applyParams()` only sets values on DOM elements
  that already exist for whichever mode is *currently* rendered — it never
  switched `_selectedWorkflow` first, so a different mode's fields (which
  don't exist in the DOM at all until that mode is selected) were silently
  no-ops. Shared fields (prompt, steps, cfg, loras, seed) still applied
  correctly, masking the bug unless you specifically checked the sampler
  values afterward.
  Fixed: the `.details-apply` click handler now switches `_selectedWorkflow`
  to `params.workflow_file` and calls `renderParamFields()` *before*
  `applyParams()`, when that mode differs from the current one (falls back
  to leaving the mode alone for a clip that predates `workflow_file` being
  recorded).
- Verified with a real headless-browser test: applying a Clownshark clip's
  details while Standard mode was active (mode switches + all 6 Clownshark
  fields + shared fields all land correctly), applying a same-mode clip
  (no regression), and applying a legacy clip with no `workflow_file` (no
  crash, applies against whatever mode is current).
- **Known related gap, not fixed here**: param presets/templates don't
  carry `workflow_file` at all (see Known Remaining Issues) — only
  Generation Details had a real value to switch to.
- SW cache bumped to `wan-static-v44`.

---

### 2026-07-03 (fix scroll position lost every time you return to Generate)

**Bugs fixed:**
- **The Generate tab always jumped back to the top on revisiting it**, even
  though Pod/Outputs usually kept their scroll position. Root cause: all
  three `.tab` sections are plain `display:none`/`block` toggles sharing
  **one page-level scroll** — there's no independent scroll container per
  tab. Two compounding issues:
  1. `switchTab("generate")` calls `resizeTextareas()`, which briefly sets
     every textarea's height to `0` before measuring `scrollHeight` (to let
     it shrink back down if content was deleted). That momentary shrink
     reduces the page's scrollable height enough that the browser clamps
     `window.scrollY` down to fit — and unlike a resize you trigger by
     typing (where you're already looking at the tab, so scrollY can't
     exceed its current height), this ran on *every visit* to Generate,
     silently resetting the shared scroll position each time regardless of
     where you'd left off.
  2. More fundamentally, nothing ever explicitly remembered per-tab scroll
     position in the first place — Pod "usually" kept its position purely
     by luck (its content is normally tall enough that passing through a
     shorter tab doesn't clamp it away), not because it was actually
     tracked. Any switch to a shorter tab and back could equally have lost
     Pod's or Outputs' position too.
  Fixed: `switchTab()` now explicitly saves `window.scrollY` for the
  outgoing tab into a `_tabScrollY` map before switching, and restores the
  incoming tab's saved value (default `0` for a never-visited tab) at the
  end of the function — after `resizeTextareas()` runs, so the restore is
  the last word. This makes scroll memory deterministic for all three tabs,
  not just "usually" for Pod.
- Verified with a real headless-browser test (mocked `/api/config` and
  friends, no real backend): Pod surviving a trip through Generate,
  Generate surviving a trip through Pod (the reported bug, with a long
  prompt to make the page tall), Generate surviving a trip through Outputs,
  and Generate surviving 3 repeated round-trips — all pass.
- SW cache bumped to `wan-static-v43`.

---

### 2026-07-03 (Favourite GPUs sometimes showed a lower-RAM card)

**Bugs fixed:**
- **Favourite GPUs section (5090/4090) occasionally didn't show the
  highest-RAM config** — it reused whatever GPU list the *main grid* had
  just fetched, which is filtered by the RAM dropdown. The backend's
  "pick the highest-available-RAM tier" merge (2026-07-01) only runs when
  `min_memory` is omitted entirely (RAM filter = "Any"); if the user had the
  main grid's RAM filter set to anything else (e.g. 8/16/24GB), that single-
  tier query's own price-tied config won instead — reintroducing the exact
  bug that merge was built to avoid. Confirmed live: `min_memory=8` returned
  RTX 5090 capped at 60GB RAM even though a same-price 92GB config
  (`min_memory` omitted) was in stock at the same time.
  Fixed: `loadGpuGrid()` now fetches the Favourite GPUs section from its own
  always-unfiltered-by-RAM request whenever the main grid's filter isn't
  already "Any" (an extra request only in that case; reuses the main list
  when the filter already is "Any", no added cost in the common case).
- SW cache bumped to `wan-static-v42`.

---

### 2026-07-03 (generation time back on video cards)

**Changes:**
- **Generation time restored to session/saved video cards** (grid tile and
  expanded caption), reversing the 2026-07-02 decision to keep it
  Details-only. Plain text via `fmtElapsed()` (e.g. `2m 56s`), no icon —
  reuses `it.duration_secs`, which the backend (`pod_outputs()`/
  `star_video()`) has returned all along even while the card UI ignored it.
  - Grid tile: new `.tile-gentime` line (9px, muted) sits directly above the
    date line — not the bottom-most row, so it doesn't need the ✕
    delete-button's right-clearance padding and can use the tile's full width.
  - Expanded caption: repurposed the existing (previously unused since
    2026-07-01) `.out-dur` class, restyled down from 13px/accent to 11px/
    muted to match "keep it small" — sits in `.cap-meta` right below the
    full date, clear of the Details/Save/Delete action buttons.
  - Renders nothing (no empty line) when `duration_secs` is null (older
    videos recorded before `started_at` existed, or one that timed out).
  - Verified with a rendered screenshot using the real `renderSavedOutput()`
    code against representative Standard/Clownshark/no-duration items.
- SW cache bumped to `wan-static-v41`.

---

### 2026-07-03 (Sampling Mode moved into params, per-mode value memory)

**Changes:**
- **Sampling Mode tabs moved from the Pod card to between the LoRA fields
  and the Sampler/Scheduler fields** in the Generate tab's Parameters
  section. Previously a static element near the top (Pod dropdown area);
  now rendered inline inside `#params` by `_workflowTabsHtml()`, positioned
  by `renderParamFields()` at the first field carrying a `workflows` key
  (the boundary between shared fields and per-mode fields). Mode-tab clicks
  now go through a delegated listener on `#params` (alongside the seed
  buttons) instead of one listener per button, since this markup rebuilds
  on every render.

**Features added:**
- **Each sampling mode now remembers its own last-used sampler/scheduler/eta
  values independently**, surviving both switching between modes in the
  same session and closing/reopening the app. New `_perModeValues` map +
  `_rememberModeValues()`/`_recallModeValues()` helpers, captured on every
  mode switch and Generate click, persisted via the existing
  `/api/last-params` endpoint (already schema-less JSON storage, so no
  backend changes) under a new `_perMode` key alongside its existing flat
  blob. `restoreLastParams()` layers the current mode's remembered values on
  top of that flat blob on load, since the flat blob alone only ever
  reflects whichever single mode was active at the last save. The
  currently-*selected* mode still always resets to the server default each
  session (unchanged from 2026-06-26) — only the field values persist per
  mode.
- Verified end-to-end with a real headless-browser test (mocked
  `/api/config`/`/api/last-params`, no real backend): confirmed the tab
  position sits exactly between the last LoRA field and the first sampler
  field, confirmed a Clownshark eta value set then carried through a
  same-session mode round-trip, and confirmed it's correctly recalled in a
  **fresh browser context** simulating a full close-and-reopen.
- SW cache bumped to `wan-static-v40`.

---

### 2026-07-03 (drop Clownshark's sampler namespace prefix from cards/Details)

**Changes:**
- **Clownshark's namespaced sampler values** (e.g. `multistep/res_2m`,
  `exponential/res_3s_non-monotonic`) **now show only the part after the
  last `/`** on video cards (in-progress, session, and saved — all go
  through `samplerPairRows()`) and in the Generation Details overlay. The
  Generate tab's own sampler dropdown is unaffected (it renders raw
  `_CS_SAMPLER_CHOICES` values directly, not through `fmtSchedulerLabel()`).
  - `fmtSchedulerLabel()`: now takes only the segment after the last `/`
    before title-casing (was joining every segment with `" · "` — e.g.
    `multistep/res_2m` rendered as `Multistep · Res 2m`; now just `Res 2m`).
  - `showDetails()`'s `buildRow()`: `cs_sampler_h`/`cs_sampler_l` now strip
    the prefix too, but **keep the raw suffix casing** (`res_2m`, not
    `Res 2m`) — Details shows every other value unformatted, so this only
    removes the noisy namespace rather than introducing new formatting.
- SW cache bumped to `wan-static-v39`.

---

### 2026-07-03 (blank seed no longer auto-fills on single generation)

**Bugs fixed:**
- **Leaving the seed blank auto-filled it with a random number immediately on
  Generate, even for a single (non-fan-out) generation** — a regression from
  the 2026-07-02 multi-select-scheduler feature. That feature needs every
  fan-out request (one per selected scheduler) to share one seed, so it
  resolves a random seed client-side and writes it into the seed box before
  firing — but that resolution ran unconditionally on *every* Generate click,
  not just when actually fanning out to 2+ variants. Fixed: the seed is now
  only resolved+displayed client-side when `variants.length > 1`; a single
  generation goes back to sending the seed as-is (blank/0), letting ComfyUI
  randomise it server-side same as before that feature — the box stays blank,
  and the actual seed used still surfaces afterward via Details / "Use this
  seed" (`_backfill_seed()` in `main.py`, unchanged).

**Features added:**
- **✕ Clear button next to the seed field's 🎲 randomise button** — empties
  the seed input in one tap (`.seed-clear`, delegated click handler
  alongside the existing `.seed-rand` one in `init()`).
- SW cache bumped to `wan-static-v38`.

---

### 2026-07-03 (Clownshark eta sliders)

**Features added:**
- **Independent Eta (High)/Eta (Low) sliders for Clownshark Sampler** —
  `cs_eta_h`/`cs_eta_l` write to node `209`/`210`'s (`ClownsharKSampler_Beta`)
  `eta` input. Slider range `0–2` (step `0.01`, default `0.5` matching the
  workflow's baked value) — the node's real range is `-100..100` per
  `/object_info`, narrowed here to what's actually usable. Scoped to
  `WF_CLOWNSHARK` only, same pattern as the other Clownshark-only fields; no
  frontend changes needed since `renderField()`'s generic slider branch and
  `_visibleFields()`'s workflow-scoping already handle any new `PARAM_FIELDS`
  entry automatically. Verified with `build_workflow()` across a passed
  value, the no-value default, and confirmed Standard/TripleK builds are
  unaffected.

---

### 2026-07-03 (model swapped bf16 → fp16, new width/height widget)

**Changes:**
- **All three sampler-mode workflows now load fp16 UNET weights**, not bf16 —
  the user re-exported all three (`YAW_2.2_bf16.json`,
  `YAW_2.2_bf16_TripleK.json`, `YAW_2.2_bf16_Clownshark.json`) with nodes
  `177`/`178` (`UNETLoader`) pointed at
  `wan22-i2v-14b-fp16-{high,low}.safetensors` (was
  `Wan2_2-I2V-A14B-{HIGH,LOW}_bf16.safetensors`). **The repo filenames were
  deliberately left unchanged** — renaming them would break the `workflow_file`
  string already persisted on every saved video (used for the mode badge
  lookup) and the `WORKFLOW_FILE`/`WF_STANDARD` config defaults; see the
  Workflow ↔ UI parameter map section above for the full explanation. No
  `config.py`/`workflow.py` changes were needed: every node ID + input key
  `PARAM_FIELDS` references (plus `IMAGE_NODE`/`OUTPUT_NODE_ID`) was verified
  present and unchanged across all three new files before swapping them in.
- **Width/height is now image-driven instead of a fixed 9:16/480 baked
  value** — node `169` ("Width and height from aspect ratio 🪴") was replaced
  by node `364` (`SimpleSwitch`, reads the loaded input image) → node `365`
  (`WanResolutions`, `aspect_ratio: "2:3"`, `resolution: "Preview — 512×768"`),
  still feeding the same downstream Width/Height Switch nodes (`292`/`293`).
  Not exposed in the mobile UI before or after this change (no `PARAM_FIELDS`
  entry), so this is purely a workflow-graph-internal change.
- Net effect: shared-node count between the three modes went from 56 to 57
  (removed `169`, added `364` + `365`). Verified via a standalone
  `build_workflow()` test across all three modes (Standard/TripleK/Clownshark)
  with the new files — no `KeyError`s, correct image/prompt/seed/sampler
  injection, correct fp16 filenames in the built prompt JSON.

---

### 2026-07-02 (root-caused the recurring "generating → queued" bug)

**Bugs fixed:**
- **The "generating" card reverting to "queued" (and duplicating a completed
  clip) after being away for a while — root cause found and fixed.** This
  exact symptom was patched at the frontend layer at least twice before
  (2026-06-25's `_seenDone` de-dupe, then the SSE-stream rewrite) but kept
  coming back, because neither patch touched the actual root cause:
  1. **`_keepalive_loop()`'s self-ping never worked.** It pinged
     `http://localhost:8000`, but Fly's `auto_stop_machines` only tracks
     inbound traffic **through the Fly proxy** — a loopback request never
     leaves the VM, so it doesn't pass through the proxy and doesn't count as
     activity. The keepalive has silently been a no-op since it was added;
     the app machine (not the RunPod pod — the lightweight Fly VM running
     this FastAPI server) was auto-stopping mid-generation exactly as if the
     loop didn't exist. Fixed: it now pings the real public URL
     (`https://{FLY_APP_NAME}.fly.dev/api/balance`, with Basic Auth), which
     routes through the proxy like a real request and actually prevents
     auto-stop. (A code deploy also restarts this same machine — the fix
     below covers that path too, regardless of *why* the process restarted.)
  2. **`_watch()` re-attaching after a restart never resynced from ComfyUI.**
     `_restore_jobs()` (runs on every boot) re-opens a *new* websocket
     connection for any job still marked "running" — but a fresh websocket
     only delivers *future* events, it never replays `execution_start`/
     `progress` for work that already happened. A prompt that had **already
     finished** while the app was down would sit marked "running" until the
     websocket eventually dropped and fell through to the slower polling
     fallback — during that window `pod_outputs()` (which reads the pod's
     ComfyUI history directly, independent of `JOBS`) already showed the
     finished clip, producing the reported duplicate: a stuck "queued" ghost
     card next to the real completed one. And a prompt still **genuinely in
     progress** would show "queued" forever (not "generating"), since
     `started_at` never gets set without a fresh progress event to trigger it.
     Fixed: `_watch()` now does one `GET /history/{prompt_id}` against
     ComfyUI *before* opening the websocket — if the prompt already has
     outputs/is complete, it resolves immediately (no ghost card, no
     duplicate); if it's still running, it backfills `started_at` immediately
     instead of leaving it null. This one history check is a no-op for a
     normal freshly-queued job (nothing in ComfyUI's history for it yet), so
     it doesn't change behavior for the common case.
- Both fixes verified with a standalone async unit test (mocking
  `comfy.get_history`) covering "already finished while restarted" (resolves
  to `status: done` with the video immediately) and "still running,
  `started_at` lost" (gets backfilled instead of staying null).

---

### 2026-07-02 (sampler card labels: grid tile redesign + in-progress card sync)

**Bugs fixed:**
- **In-progress "generating…" card had no sampler-mode/pair labels at all** —
  `_job_public()` only returned bare job state, not the saved params, so the
  card you see while a clip is generating showed nothing about which sampler
  mode was in use, unlike the completed/saved card. `_job_public()` now also
  reads `ps.get_params()` (already persisted at generate time) and returns
  the same `workflow_file`/`sampler`/`scheduler`/`sampler_base`/`cs_sampler_h`/
  etc. fields as `pod_outputs()` and `star_video()`, so `upsertActiveCard()`
  renders the identical badges from the moment a video starts generating
  through session view through starring.
- **Clownshark's sampler/scheduler fields converted from free-text to
  verified dropdowns** — queried `/object_info/ClownsharKSampler_Beta` on a
  live pod and replaced the 4 unverified text inputs with proper `select`
  fields: 119 samplers (`_CS_SAMPLER_CHOICES`, RES4LYF namespace) and 11
  schedulers (`_CS_SCHEDULER_CHOICES`). Baked defaults confirmed valid.

**UI/UX (two iterations, same day):**
- **Round 1 — mode-only tiles**: the original label redesign packed the full
  sampler-mode name plus one or two sampler+scheduler pair badges into the
  ~110px 3-col grid tile, which didn't fit and truncated illegibly (worse
  with two pairs). First fix: grid tiles dropped to showing only a short mode
  badge (`TILE_MODE_LABELS`: "Standard"/"TripleK"/"Clownshark"); the full
  breakdown moved to the expanded caption as label/value rows (`.sched-row`)
  that wrap instead of truncating.
- **Round 2 — values back on the tile, smaller font**: mode-only tiles hid
  too much at a glance, so sampler+scheduler values were added back to the
  tile itself at a smaller font (8px), still wrapping instead of truncating.
  Single-pair clips (Standard, and legacy pre-mode videos that only have a
  `scheduler` value) show just the value with no label — unambiguous with
  only one pair. Two-pair clips (TripleK's Base/Lightning, Clownshark's
  High/Low) keep their stage label since that's the only way to tell the two
  rows apart. Freed up width for this by scoping the ✕ delete-button
  clearance padding to just the date line (`.tile-dt`) instead of the whole
  `.tile-foot` column — earlier rows (name, mode badge, sched rows) now use
  the tile's full width.
- SW cache bumped to `wan-static-v37`.

---

### 2026-07-02 (3-way sampler mode: Standard / TripleKSampler / Clownshark)

**Features added:**
- **Sampler mode switch** — the workflow tab in Generate now switches between
  three genuinely different node graphs instead of the old bf16/GGUF loader
  toggle (GGUF dropped entirely — bf16 only, in all three modes):
  - **Standard Sampler** (`YAW_2.2_bf16.json`) — unchanged: one `sampler` +
    `scheduler` pair written to both `KSamplerAdvanced` nodes (`128`/`129`).
    `scheduler` stays `multiselect` (fires one generation per selected
    scheduler, sharing one seed).
  - **TripleKSampler** (new `YAW_2.2_bf16_TripleK.json`) — independent
    **Base** (`sampler_base`/`scheduler_base`) and **Lightning**
    (`sampler_lightning`/`scheduler_lightning`) pairs, writing to node `290`'s
    (`TripleKSamplerWan22LightningAdvanced`) `base_*`/`lightning_*` inputs.
    Only `scheduler_base` is `multiselect`; Lightning stays single-select to
    avoid an N×M cross-product fan-out.
  - **Clownshark Sampler** (new `YAW_2.2_bf16_Clownshark.json`) — independent
    High (`cs_sampler_h`/`cs_scheduler_h` → node `209`) and Low
    (`cs_sampler_l`/`cs_scheduler_l` → node `210`) pairs on
    `ClownsharKSampler_Beta`, never multiselect. Confirmed via static graph
    inspection that `ClownOptions Detail Boost` (node `216`) is unwired in
    all three workflow files (dead input, not just here).
  - All three modes share 56 common nodes (`IMAGE_NODE`=`166`,
    `OUTPUT_NODE_ID`=`145`, steps/CFG/lightx2v/seed, etc.) — see the Workflow
    ↔ UI parameter map section above for the full field/node breakdown.
  - `PARAM_FIELDS` entries are scoped to a mode via a new `"workflows": [...]`
    key; `workflow.py`'s `build_workflow()` skips any field not in the
    resolved workflow's list (so a stale cross-mode value can't KeyError on
    a node the graph doesn't have), and the frontend's new `_visibleFields()`
    does the same for rendering. Switching mode tabs mid-session preserves
    shared field values (steps/CFG/prompt/etc.) via capture-then-reapply.
- **Clownshark's sampler/scheduler enums verified against a live pod** —
  queried `/object_info/ClownsharKSampler_Beta` on the running pod
  (`nextdiffusionai/comfyui-sageattention:cuda12.8-v1`) and replaced the
  previously-unverified free-text inputs with proper `select` dropdowns:
  119 samplers (`_CS_SAMPLER_CHOICES`, RES4LYF namespace — e.g.
  `multistep/res_2m`, `exponential/res_2s`, distinct from Standard/TripleK's
  `KSamplerAdvanced` enum) and 11 schedulers (`_CS_SCHEDULER_CHOICES`). The
  workflow's baked defaults (`multistep/res_2m`, `exponential/res_2s`,
  `bong_tangent`) were confirmed valid members of the verified lists.
- **Video card labels reworked** — the old single colour-coded scheduler
  badge (`schedBadge`/`SCHED_CLASSES`) is replaced by two new badges on every
  card (grid tile + expanded, session + saved + **in-progress/generating**):
  a `samplerModeBadge()` showing which mode produced the clip ("Standard
  Sampler" / "TripleKSampler" / "Clownshark Sampler", from `workflow_file` via
  `CFG.workflow_labels`) stacked above `samplerPairBadges()` showing the
  actual sampler+scheduler pair(s) — one pair for Standard, two labelled
  pairs ("Base"/"Lightning" or "High"/"Low") for TripleK/Clownshark. No more
  colour-coding by scheduler value; badges are one flat neutral style
  (`.sched-badge` / `.mode-badge` in `styles.css`).
- **Generation Time restored to the Details overlay** (between Seed and
  Prompt) but intentionally **not** shown on any card — `GET /api/params/{id}`
  now injects `_duration_secs` (computed the same way `pod_outputs()`
  computes clip duration) alongside the raw saved params; `showDetails()`
  renders it as a synthesized row that isn't a real `PARAM_FIELD` (nothing to
  write back).
- **Labels now consistent across in-progress and completed cards** — the
  in-progress "generating…" card (`upsertActiveCard()`) previously showed no
  sampler/mode info at all, since `_job_public()` only returned bare job
  state. `_job_public()` now also reads `ps.get_params()` (saved at generate
  time, before the job even starts) and returns the same
  `workflow_file`/`sampler`/`scheduler`/`sampler_base`/`scheduler_base`/
  `sampler_lightning`/`scheduler_lightning`/`cs_sampler_h`/`cs_scheduler_h`/
  `cs_sampler_l`/`cs_scheduler_l` fields as `pod_outputs()` and `star_video()`,
  so `samplerModeBadge()`/`samplerPairBadges()` render identically on a video
  from the moment it starts generating through session view through starring.
- SW cache bumped to `wan-static-v35`.

---

### 2026-07-02 (multi-select scheduler: N generations, one shared seed)

**Features added:**
- **Scheduler is now multi-selectable** — `config.py`'s `scheduler` field is
  `"type": "multiselect"` (was `"select"`); the Generate tab renders it as a
  row of toggle chips (reusing the existing `.chip.toggle` style from the CUDA
  filter) instead of a single dropdown. At least one must stay selected.
- **Selecting multiple schedulers fans out into multiple generations** — e.g.
  picking `simple`, `beta`, `beta57` and tapping Generate fires 3
  `/api/generate` requests, one per scheduler, so you get 3 clips to compare.
  **All of them share the same seed**, resolved client-side once *before* the
  first request: if the seed field is blank/0, a random seed is generated in
  the browser and written back into the seed input (so you can see + reuse
  it), then that exact value is sent with every request — a blank seed can no
  longer randomise independently per scheduler. Toast shows `N/M generations
  queued`; a plain single selection behaves exactly as before (one request,
  scheduler sent as a plain string, "Generation queued").
- No backend changes were needed — each individual `/api/generate` call still
  receives `scheduler` as a single string, exactly as pre-existing
  `workflow.py`/`_coerce` expects; "multiselect" only changes how the
  Generate-tab UI renders/collects the field client-side. `_multiSelected`
  (a `{fieldKey: Set<string>}` map) backs the chip state; `collectParams()`
  reads it in since chips aren't real form controls, and `applyParams()`
  restores it (used by template/preset apply, Details "Apply to Generate",
  and Undo/revert) — verified round-tripping through capture/revert correctly
  reselects the right chips.
- SW cache bumped to `wan-static-v33`.

---

### 2026-07-02 (full sampler/scheduler lists from live ComfyUI)

**Changes:**
- **Sampler + scheduler dropdowns now list the full set** the pod's ComfyUI
  actually supports. The hand-maintained lists in `config.py` were stale —
  only 13 of 63 samplers and 10 of 11 schedulers. Spun up a pod once and read
  the ground truth from `/object_info/KSamplerAdvanced` on the deployed image
  (`nextdiffusionai/comfyui-sageattention:cuda12.8-v1`), then replaced both
  `choices` lists verbatim (ComfyUI's own ordering). Samplers → 63 (adds the
  `_cfg_pp`/`_gpu` variants, `dpm_2*`, `lms`, `deis*`, `res_*` family, `seeds_*`,
  `sa_solver*`, `rk*`, etc.); schedulers → 11 (adds `bong_tangent`). Defaults
  unchanged (`euler` / `beta57`). Re-query that endpoint if the pod image is
  ever updated. SW cache bumped to `wan-static-v32` so clients re-fetch
  `/api/config`.

---

### 2026-07-01 (fix broken pod deploy: RunPod config moved to fly.toml)

**Bugs fixed:**
- **"Deploy" gave a 500 / pods couldn't be created** — `POST /api/pods` failed
  with `ValueError: Either image_name or template_id must be provided`. Root
  cause: the non-secret RunPod pod-config vars (`RUNPOD_TEMPLATE_ID`,
  `RUNPOD_NETWORK_VOLUME_ID`, `RUNPOD_DATA_CENTER_ID`, `RUNPOD_IMAGE_NAME`, …)
  used to travel in the committed `.env` (baked into the Docker image). The
  earlier secrets fix removed `.env` from the repo + image but only migrated the
  *real* secrets (`RUNPOD_API_KEY`, `WAN_AUTH_*`) to Fly secrets — these
  pod-config vars were never migrated, so the deployed app booted with them all
  empty and `runpod.create_pod` got no template and no image. (Read-only GPU
  listing kept working because it needs none of them.)
- **Fix:** moved the non-secret pod-config vars into a committed **`[env]` block
  in `fly.toml`**, so they travel with the repo and can't be dropped on a
  rebuild. Real secrets stay in `fly secrets`. The GitHub Actions deploy applies
  `[env]` on the next push (fly.toml is a trigger path).
- **`POST /api/pods` now surfaces the real error** — it wrapped
  `rp.create_pod` in try/except and returns HTTP 502 with the RunPod/SDK error
  text (and logs it) instead of an opaque 500, so deploy failures are
  diagnosable from the UI.

**Note:** `requirements.txt` still pins `runpod>=1.0.0` (unpinned) — a future
SDK bump could change `create_pod`'s signature and break deploy again. Consider
pinning to a known-good version.

---

### 2026-07-01 (details overlay: seed to top, follows auto-advance)

**Changes:**
- **Seed row moved to the top of Generation Details** — `showDetails()`'s row
  ordering was `positive` first, then insertion order; now it's `_seed` first,
  then `positive`, then everything else, so the seed value + "↑ Use this seed"
  button are the first thing you see instead of scrolling past the prompt.

**Bugs fixed:**
- **Details overlay went stale when the video auto-switched underneath it** —
  opening Generation Details while a clip plays, then letting it finish and
  auto-advance (or manually swiping/scrolling/arrow-keying) to the next/prev
  clip, left the overlay showing the *old* clip's params instead of the new
  one's. New `_refreshOpenDetails(card)` re-invokes `showDetails()` for the
  newly-expanded card whenever a `.details-overlay` is present; called from
  both `slideTo`'s `onDone()` and the touch-swipe commit path's `onDone()`, so
  it covers auto-advance, wheel, arrow keys, and manual swipes alike.
- SW cache bumped to `wan-static-v31`.

---

### 2026-07-01 (scheduler badge replaces duration on cards)

**Changes:**
- **⏱ duration badge replaced by a scheduler badge** on both the grid tile
  (`.tile-foot`) and the expanded/full-screen action bar (`.out-cap
  .cap-meta`) — same two spots that used to show `⏱ {duration}`. New
  `schedBadge(scheduler, cls)` in `app.js` renders a coloured pill via
  `fmtSchedulerLabel()` (underscore-separated values like `sgm_uniform` →
  "Sgm Uniform"). The 3 schedulers actually in rotation get distinct colours —
  `beta57` → accent blue, `beta` → green, `simple` → amber — every other
  scheduler (`karras`, `normal`, etc.) shares one muted "other" colour
  (`.sched-badge.sched-other`). No badge is rendered when `scheduler` is empty
  (e.g. very old saved videos from before this field was recorded).
- **Backend**: `GET /api/pods/{id}/outputs` and `POST /api/saved/{pod}/{pid}`
  (star) now include a `"scheduler"` field, read from `ps.get_params(pid)` —
  `scheduler` (current combined field) falling back to the legacy
  `scheduler_high` key for older recordings. `duration_secs` is still returned
  by the API (unused by the card UI now, but harmless) in case it's needed
  elsewhere later.
- SW cache bumped to `wan-static-v30`.

---

### 2026-07-01 (player polish: progress bar placement, expanded ✕, edge hint)

**Changes:**
- **Progress bar moved above the action bar** — it was appended to the
  full-screen `.tile-nav` overlay and pinned to the viewport bottom, so it sat
  *below* the expanded player's action bar (Details / Save / Delete). It's now
  built into `.out-cover` (the video area) at its bottom edge, so it sits just
  above the action bar. `_updateNavCounter` now rebuilds it inside the cover;
  CSS hides it unless the card is `.expanded`.
- **✕ quick-delete hidden in the expanded player** — `.out-card.expanded
  .tile-del-btn { display: none }`. It was redundant with the action-bar Delete
  button and overlapped the video.

**Features added:**
- **Start/End-of-list hint** — a transient centred pill (`.edge-hint`) shows
  "End of list" / "Start of list" when navigation reaches a boundary, then
  auto-dismisses after 1.5s. Fired from `_autoAdvance` (auto-advance-on-finish),
  `_edgeBounce` (wheel / arrow keys), and a hard boundary swipe in `onTouchEnd`.
  `_showEdgeHint(dir)` reuses a single element and restarts its fade each time.
- SW cache bumped to `wan-static-v28`.

---

### 2026-07-01 (auto-advance fix + playback progress bar)

**Bugs fixed:**
- **Auto-advance-on-finish never fired** — the `ended` listener was only attached
  inside `expandTile`'s first-expand branch, which runs *only when the
  `tile-video` has no `src` yet*. But the `_tileObserver` IntersectionObserver
  preloads `tile-video.src` (`preload="metadata"`) for every tile within 400px
  of the viewport, so by tap time the src was almost always already set → the
  branch was skipped → no `ended` handler → the clip just stopped at its end
  instead of advancing. **Fix:** extracted `_bindVideoEvents(card)` (guarded by a
  `_navBound` flag) that binds `waiting`/`playing`/`ended`/`timeupdate`
  unconditionally, and call it from both `expandTile` and `_primeVideo`
  regardless of whether the src was just set or pre-loaded.

**Features added:**
- **Playback progress bar** — the expanded player now has a seekable progress bar
  pinned to the bottom (`.vid-progress` → `.vid-progress-track` →
  `.vid-progress-fill`, built by `_updateNavCounter` alongside the counter/loop
  controls). It fills as the clip plays (`_updateProgress` on `timeupdate`) and is
  tap/drag-seekable via pointer events (`_bindProgressSeek`): the wrapper is a
  22px transparent hit area over a 3px visible track, `pointer-events: auto` so it
  takes taps while the rest of `.tile-nav` stays pass-through. Seek fraction is
  measured against the visible track rect.
- SW cache bumped to `wan-static-v27`.

---

### 2026-07-01 (video player: date format, auto-advance, loop toggle)

**Features added:**
- **Auto-advance to next/prev clip on finish** — when an expanded video reaches
  the end, it now automatically continues in whichever direction the user last
  navigated (swipe up/down, scroll wheel, or arrow keys): `_lastNavDir` (global,
  defaults to `"up"`/next until the user has navigated at all) is recorded at
  every manual-navigation commit point and read by the new `_autoAdvance(card)`,
  bound to each `<video>`'s `ended` event. At the start/end of the list there's
  nothing to advance to, so it just stops — no wraparound, no bounce.
- **Loop-current-video toggle** — a new 🔁 `.loop-btn` button (top-right of the
  expanded player, next to the `N / total` counter pill) toggles `video.loop`
  for the currently-expanded clip. Looping a video natively suppresses the
  `ended` event, so a looped clip is exempt from auto-advance until unlooped.
  Rendered by `_updateNavCounter` (renamed in intent to also own the loop
  button) — shown even for a single-video list, where the counter itself is
  omitted.
- **Behaviour change:** `<video class="tile-video">` no longer has a hardcoded
  `loop` attribute (previously ALL clips looped indefinitely by default). Clips
  now play once and auto-advance per the above; loop is now an explicit
  per-video opt-in via the button instead of the old always-on default.

**Changes:**
- **Grid tile timestamp shortened to date-only** — `.tile-dt` on grid cards
  (both session and saved) now shows `dd MMM yyyy` (e.g. `01 Jul 2026`) via new
  `fmtDateOnly()`, dropping the time-of-day that used to run under the ✕
  quick-delete button.
- **Expanded player shows the full timestamp** — `.out-dt` in the expanded
  bottom caption now shows date **+ year + time** (e.g. `01 Jul 2026, 3:11 PM`)
  via new `fmtDatetimeFull()`. Previously both grid and expanded views shared
  one `fmtDatetime()` (month/day + time, no year); it's been split into the two
  functions above and removed.
- SW cache bumped to `wan-static-v26`.
### 2026-07-01 (secrets exposure — repo went public)

**Security fix:**
- **`.env` (real secrets) was tracked in git AND baked into the Docker image** —
  discovered right after the repo was made public. Root causes: `.gitignore`
  never listed `.env` (it got committed once and stayed tracked), and
  `.dockerignore` didn't exclude it either, so `Dockerfile`'s `COPY . .` baked
  it into every deployed image. Worse: `RUNPOD_API_KEY`, `WAN_AUTH_USER`,
  `WAN_AUTH_PASS` were **not** set as Fly secrets (only the `GOOGLE_*` vars
  were) — per `config.py`'s "Fly secrets win over baked-in `.env`" rule, that
  meant the live app was actually running on the image-baked values, not
  anything editable via `fly secrets set`, until this fix.
  **Remediation:**
  - Rotated `RUNPOD_API_KEY` on RunPod's dashboard (old one revoked/dead).
  - Rotated `WAN_AUTH_PASS` (old one — same as what's still sitting in git
    history on `main` — is now dead too).
  - Set `RUNPOD_API_KEY` / `WAN_AUTH_USER` / `WAN_AUTH_PASS` as **Fly secrets**
    (`fly secrets set` triggers its own rolling redeploy — took effect
    immediately, no push/CI needed).
  - Added `.env` to both `.gitignore` and `.dockerignore`; `git rm --cached .env`.
  - **Did not** rewrite git history / force-push — once a leaked secret is
    rotated, its old value in history is dead, so scrubbing wasn't worth the
    force-push risk on a shared branch.
  - `GOOGLE_SERVICE_ACCOUNT_JSON` / GCS creds were never in `.env` — unaffected.
  **Going forward: any new secret env var must be added via `fly secrets set`,
  not just `.env`** — `fly secrets list` is the source of truth for what's
  actually live, not `config.py`'s var table.

---

### 2026-07-01 (output card fixes)

**Bugs fixed:**
- **✕ quick-delete button hid the datetime's AM/PM** — `.tile-del-btn` is pinned
  bottom-right of the cover, and the tile-foot datetime is left-aligned on that
  same bottom line, so a long "…3:11 AM" ran under the button. Gave `.tile-foot`
  a 34px right padding to reserve space for the button and added
  `text-overflow: ellipsis` to `.tile-dt`/`.tile-dur`/tile-foot name so they
  truncate before the button instead of hiding behind it.
- **6-dot drag grip looked off-centre** — the `⠿` braille glyph sits high/left in
  its em box, so it never centred in the round handle. Replaced it with a new
  `GRIP_SVG` (6 dots as 2 cols × 3 rows, symmetric about the viewBox centre) used
  in both `renderOutput` and `renderSavedOutput` — now perfectly centred.
- **Video name not shown on cards** — the name only lived in `.out-cap`, which is
  `display:none` in the grid (shown only when a card is expanded), so a labelled
  clip showed no name in the gallery. Added the name to the visible `.tile-foot`
  cover overlay (white + text-shadow for legibility over bright video); the
  `.out-cap` copy keeps the accent colour. Only rendered when `video_name` is set.
- **Whole gallery reloaded on every Outputs-tab visit** — `switchTab("outputs")`
  → `loadOutputs()` unconditionally wiped and rebuilt both lists' `innerHTML`, so
  every `<video>` re-fetched and the tiles flashed black. Added a **signature
  guard**: re-entry still re-fetches, but if the clips/order/is_saved/video_name
  are identical it skips the DOM rewrite entirely (posters stay loaded). Applied
  to `loadDone` (new `silent` arg), `loadSaved`, and the foreground-return
  refresh in `resumePolls`. Real changes (new clip, delete, reorder, star) still
  re-render immediately. On a silent revisit the in-flight `#out-active` cards are
  also preserved instead of being wiped and rebuilt by the SSE stream.
  SW cache → `wan-static-v25`.

---

### 2026-07-01 (swipe gap fix)

**Bugs fixed:**
- **Big gap between clips during TikTok swipe up/down** — the current and incoming
  expanded cards are both `position: fixed; inset: 0` (full viewport), but the
  swipe/slide transforms offset the incoming card by the CSS unit `100vh`. On
  mobile `100vh` is the *address-bar-hidden* (taller) viewport height, while an
  `inset: 0` fixed element renders at the current *visual* viewport height — so
  `translateY(100vh)` pushed the incoming clip down further than the current
  card's real height, exposing a gap so the two clips weren't connected. **Fix:**
  new `_cardH(card)` helper returns the card's *measured* pixel height
  (`getBoundingClientRect().height`), and every `100vh`/`-100vh` offset in the
  swipe logic now uses it instead: the drag (`onTouchMove`), commit
  (`onTouchEnd`), and wheel/keyboard (`slideTo`). Incoming card is now always
  exactly flush with the current one at any address-bar state. Edge-bounce (fixed
  48px) was already correct. SW cache → `wan-static-v24`.

---

### 2026-07-01 (default to highest-RAM GPU config)

**Bugs fixed:**
- **GPU cards showed the lowest-RAM tier by default (RAM = "Any")** — RunPod's
  `lowestPrice` GraphQL field returns exactly one config per GPU model, and a
  model's RAM tiers are all the *same price*, so lowestPrice broke the tie toward
  the *lowest-RAM* config. A 5090 with a same-price 100GB variant would show 60GB
  by default, and the frontend's "pick highest RAM" reduce in `renderFavGpus` was
  a no-op (only one entry per model ever arrived). Both the Favourite GPUs section
  and the main grid were affected.
  **Fix (backend, `list_gpu_availability`):** when no RAM is selected, probe every
  `RAM_OPTIONS` tier (8/16/24/48/80/100) plus the unfiltered baseline **in parallel**
  (`asyncio.gather` of `to_thread` calls), then merge — for each model keep the
  entry from the *highest tier where it's still in stock*. The baseline (None)
  query seeds the model universe so out-of-stock models still get a greyed card.
  A specific RAM selection still does a single query (unchanged). Costs ~7 RunPod
  GraphQL calls on grid load/refresh when RAM = "Any", but they run concurrently
  (~one query's latency).
- **Deploy provisioned the cheapest tier even when the card showed 100GB** — the
  Deploy button took `min_memory` only from the RAM dropdown, so with RAM = "Any"
  RunPod would fall back to the lowest-RAM config and the card was lying about
  what you'd get. Now, when the dropdown is "Any", deploy uses the *selected
  card's* RAM (`selectedGpu.ram`) so the provisioned pod matches the card. Same
  price, more RAM. SW cache → `wan-static-v23`.

---

### 2026-06-26 (misc fixes + features)

**Features added:**
- **Favourite GPUs section** — a new "Favourite GPUs" section appears above
  "Select a GPU" on the Pod tab. Shows the highest-RAM available option for
  each preferred model (currently 5090 and 4090, configured via
  `FAV_GPU_KEYWORDS` in `app.js`). If a model has no available entries, its
  greyed-out card is still shown (not hidden). If neither model appears in the
  API response at all, the section is hidden. Selecting a card in either section
  clears the other. Thin divider separates the two sections.

**Bugs fixed / changes:**
- **bf16 workflow always selected by default** — `_selectedWorkflow` was
  persisted in `localStorage`, so picking GGUF once made it stick across every
  future session. Now it starts empty each session and falls back to the
  server's `default_workflow` (bf16). Users can still switch to GGUF during a
  session; it resets on next open.
- **CLAUDE.md: never run `fly deploy` manually** — deploy rule updated to
  clarify that GitHub Actions handles deployment automatically on push to main.
- **CLAUDE.md: workflow section covers both bf16 and GGUF** — updated the
  Workflow ↔ UI parameter map to document both files, note that all param node
  IDs are identical between them, and warn to re-check both if re-exporting.

---

### 2026-06-26 (TikTok swipe strip)

**UI/UX:**
- **Swipe between videos now shows a seamless connected strip** — previously only
  the current card moved during the drag, exposing the Outputs grid underneath.
  Now the incoming card is shown simultaneously via a new `.vid-incoming` class
  (`position: fixed; inset: 0; z-index: 39` — one below the expanded card at 40)
  that renders the next clip's cover thumbnail full-screen with no controls. As
  you drag, both cards move with the same offset so their edges are always flush:
  `current` at `translateY(dy)`, `next` at `translateY(100vh + dy)`. The Outputs
  grid is completely hidden throughout. The incoming cover thumbnail starts loading
  as soon as the drag begins (so it's usually painted before you commit). On
  commit, `.vid-incoming` swaps to `.expanded` and the animation continues from
  the dragged positions (no snap-back to 100vh). On cancel/spring-back the
  `.vid-incoming` class is cleaned up and no ghost cards are left. SW → v20.

---

### 2026-06-26 (SW cache conflict fix)

**Bugs fixed:**
- **Stale data on reopen after cloud changes** — stale-while-revalidate for
  `/api/saved`, `/api/templates`, `/api/param-presets`, `/api/last-params`
  would briefly show the old cached version on open, hiding changes made from
  another device or since the last session. Switched these to **network-first
  with cache fallback**: always fetches fresh when online (tiny payloads,
  negligible latency); serves cache only when offline. `/api/config` stays
  SWR — it only changes on deploy, which installs a new SW that re-fetches.
- **Deleted/moved library images persisting as ghost thumbnails** — `cacheFirst`
  for `/api/images/file/*` would keep serving a stale cached entry after the
  image was deleted or moved. Added `_evictImageCache(path)` helper in `app.js`
  that sends an `EVICT_IMAGE` message to the SW after a successful delete or
  move. The SW `message` handler removes the matching entry from `wan-media-v1`.
  SW cache → `wan-static-v19`.

---

### 2026-06-26 (PWA media + data caching)

**Performance:**
- **Library images and API data now cached by the service worker** — previously
  the SW had a blanket "never intercept /api/*" rule, so every library image,
  config, template list, preset list, saved list, and last-params fetched fresh
  from Fly.io on every open. iOS aggressively evicts the browser HTTP cache for
  PWA contexts, so repeat visits felt as slow as first loads.
  New strategy (two persistent caches not deleted on deploy):
  - `wan-media-v1` — **cache-first** for `/api/images/file/*` (library images,
    immutable per URL) and Google Fonts. After the first visit, library thumbnails
    are instant.
  - `wan-data-v1` — **stale-while-revalidate** for `/api/config`, `/api/saved`,
    `/api/templates`, `/api/param-presets`, `/api/last-params`. The cached
    version renders the UI immediately; the network fetch updates the cache for
    next time.
  - Range requests (`Range:` header) still bypass the SW — video partial fetches
    are large and the server's `Cache-Control: immutable` covers them via the
    browser HTTP cache.
  - `activate` handler now keeps `wan-media-v1` and `wan-data-v1` alive across
    deploys (only old `wan-static-*` shells are evicted). SW version → `wan-static-v18`.

---

### 2026-06-26 (swipe nav fix)

**Bugs fixed:**
- **Swipe nav closed the player + left the next tile spinning** — the first cut
  manipulated the *incoming* card during the drag (`_primeVideo` + `expanded` +
  transform on `next` inside `touchmove`). A non-committed swipe then left the
  neighbour half-loaded (spinner) in the grid, and the synthetic post-swipe
  `click` re-hit the cover/back so the player appeared to close. Root fixes:
  (1) **only the current card moves during the drag**; the incoming card is
  brought in solely by `slideTo()` on release (it continues smoothly from the
  dragged offset). (2) **axis is decided after an 8px movement threshold** so an
  initial horizontal jitter no longer permanently cancels the swipe. (3) the
  post-swipe **ghost click is suppressed** (`_swipeJustHappened()` guard on the
  cover-tap branch). (4) listeners now **bind once per card and no-op unless that
  card is expanded**, so a collapsed tile in the grid can't hijack scroll or
  accumulate duplicate handlers. Touch listeners moved from `.out-cover` to the
  expanded `.out-card`. SW cache → `wan-static-v17`.

---

### 2026-06-26 (TikTok swipe nav)

**Features added:**
- **Swipe up/down to navigate between videos** — replaced the `‹`/`›` arrow
  buttons with TikTok-style swipe up/down navigation. The gesture is physical:
  during the drag both the current card (slides out) and the incoming card (slides
  in from below/above) follow the finger in real-time. On release, committing at
  ≥60px or enough velocity slides to the next clip with a
  `cubic-bezier(.36,.66,.04,1)` spring (320ms); releasing early springs both
  cards back. At the list boundary, a rubber-band nudge (48px elastic push +
  spring-back) signals there's nothing more. The incoming video's `src` is set
  the moment the drag starts so buffering begins before the animation completes.
  Counter pill (`2 / 3`) stays in the top-right corner.
- **Desktop equivalents:** scroll wheel / trackpad (80ms debounce → slide) and
  `ArrowUp`/`ArrowDown` keys both navigate between clips.
- Removed the `‹`/`›` button elements and their CSS (`.tile-nav-btn`,
  `.tile-nav-prev`, `.tile-nav-next`) — no longer needed. SW cache → `wan-static-v16`.

---

### 2026-06-26 (player UX + saved delete)

**Bugs fixed:**
- **Video resumed mid-clip after reopening** — `collapseTile` now resets
  `video.currentTime = 0` when the player closes, so reopening a clip starts from
  the beginning instead of where it was paused.
- **Esc/Back closed the video under an open Details overlay** — the global key
  handler only collapsed the expanded tile, leaving the Details overlay on top.
  It now closes the **topmost layer first**: a `.details-overlay` is dismissed
  before the expanded player. Also handles `Backspace` (guarded against form
  fields) and `preventDefault`s it so it never triggers browser back-nav.

**Features added:**
- **Delete on saved videos** (permanent) — saved tiles now have a ✕ quick-delete
  on the cover and a "Delete" button in the expanded actions, mirroring session
  tiles. **Unstar (★)** = return the clip to the current session (removes the
  saved copy; relabelled confirm/toast). **Delete** = remove the saved copy AND
  purge it from the pod's ComfyUI history (`DELETE /api/pods/{pod}/outputs/{pid}`,
  best-effort) so it's gone for good. `star_video` now records `pod_id` in the
  saved metadata so Delete knows which pod to purge (old saved entries without
  `pod_id` just skip the pod-history purge). SW cache → `wan-static-v15`.

---

### 2026-06-26 (player controls restyle)

**UI/UX:**
- **RedNote-style video controls** — replaced the clunky glyph controls in the
  expanded player with clean SVG icons + a frosted-glass treatment. Tap-to-pause
  indicator (`.vid-play-overlay`) is now a soft rounded play triangle in a 68px
  translucent blurred circle that lingers while paused and gives a scale-up
  "release" flick on resume (pure opacity/transform transitions; dropped the
  `vid-pop` keyframe). Prev/next nav buttons (`.tile-nav-btn`) shrank 48→40px,
  swapped the `‹`/`›` glyphs for thin stroked chevron SVGs, and gained the same
  frosted blur + hairline border + soft shadow; the counter pill matches. New
  `PLAY_TRIANGLE_SVG` / `CHEVRON_L_SVG` / `CHEVRON_R_SVG` constants in `app.js`.
  Note: backdrop-filter is safe here despite the iOS rule — the expanded card is
  a non-scrolling full-screen `position: fixed` view, so the scroll-drift bug
  doesn't apply. SW cache bumped to `wan-static-v14`.

---

### 2026-06-26 (video save sheet fix)

**Bugs fixed:**
- **Video "↓ Save" opened a full-screen download view, not the share sheet** —
  `saveVideoFile` gated the Web Share path on `navigator.canShare({ files })`,
  which is a **false-negative for files inside an installed iOS PWA**: it
  returned false, so the code fell into the desktop anchor-download branch,
  which on iOS opens the file full-screen with no back button. **Fix:** drop the
  `canShare` gate and just *try* `navigator.share({ files: [file] })`, letting
  iOS decide; only fall back to the anchor download when `navigator.share` is
  absent (desktop) or share throws a non-`AbortError`. Also now share **only the
  file** (removed `title:` — including it makes iOS treat it as a link share and
  hides "Save Video"/"Save to Files") and force a concrete `video/*` MIME type +
  `.mp4` name. `AbortError` (user dismissed the sheet) is swallowed. SW cache
  bumped to `wan-static-v13`.

---

### 2026-06-26 (drag-handle fix)

**Bugs fixed:**
- **Drag-to-reorder didn't work on iOS** — the whole-card long-press drag
  (`delay: 400`) never started: on an iOS PWA a long-press on a scrolling video
  tile is claimed by page scroll / the native long-press callout, and you can't
  put `touch-action: none` on the whole (scrolling) tile to stop that. SortableJS
  loaded fine (CDN 200) — the gesture just never reached it. **Fix:** switched to
  a dedicated **drag handle** (`⠿` grip, top-left of each tile) with
  `handle: ".drag-handle"`; the grip alone gets `touch-action: none` so iOS hands
  the press straight to SortableJS while taps (expand), scroll, and the other
  tile buttons keep working. Removed the `delay`/`delayOnTouchOnly`/
  `touchStartThreshold` opts (the handle disambiguates from tap). Added a
  `.drag-handle` click guard in both `#out-list` / `#saved-list` handlers so a
  tap on the grip doesn't expand the tile; grip is hidden when a tile is
  expanded or in select mode. Verified in a real browser: instance inits with
  the handle, grips render, a reorder persists to localStorage. Both Session
  (localStorage) and Saved (`POST /api/saved/reorder`) lists use it. SW cache
  bumped to `wan-static-v12`.

---

### 2026-06-26

**Bugs fixed:**
- **Video name missing on completed session and saved tiles** — `pod_outputs` was
  building the item dict from ComfyUI history without `video_name`. Fixed by looking
  it up from the in-memory `JOBS` dict first, falling back to `ps.get_params(pid)`
  (params are saved to disk at generate time and include `video_name`). Both
  `renderOutput` and `renderSavedOutput` already handled `it.video_name`; only the
  backend was missing the field.
- **Drag-to-reorder video cards** — hold a card 400 ms to start dragging; drop
  anywhere in the grid to reorder. Uses SortableJS 1.15.6 (CDN, `forceFallback`
  for reliable iOS grid drag). Saved section: order persisted to `saved_videos.json`
  + GCS via `POST /api/saved/reorder`. Session section: order persisted to
  `localStorage` keyed by pod ID; applied on every `loadDone()` so new clips appear
  at the top. Sortable is disabled while select mode is active in each section.
- **Storage filename now uses display name** — `star_video` constructs the storage
  filename as `{sanitized_name}_{YYYYMMDD_HHMMSS}.mp4` (e.g. `beach_sunset_20260626_143022.mp4`)
  instead of `{prompt_id[:8]}_{comfyui_name}.mp4`. Falls back to `{timestamp}.mp4`
  when no name is set. Name is sanitized: filesystem-unsafe chars stripped,
  spaces → underscores.
- **Delete button colour wrong** — duplicate CSS rule at line 349 overrode `.del-btn`
  red with muted grey; removed the conflict. Save (↓) link is now accent blue.
  Details stays muted grey.

**Features added:**
- **iOS-native Save sheet for videos** — `↓ Save` button now fetches the video as a
  blob and calls `navigator.share({ files: [file] })`, which opens the iOS native
  share sheet (Save to Photos / Save to Files / AirDrop). Falls back to a
  programmatic blob-URL download click on desktop. `AbortError` (user dismissed the
  sheet) is silently swallowed. Button shows "↓ …" while downloading.
- **Quick-delete on session tiles** — small red ✕ button at bottom-right of each
  current-session video tile; deletes without needing to expand the card.
- **Video buffering spinner** — white spinner overlay appears while `readyState < 3`
  on expand and on any subsequent `waiting` event; hides on `canplay`/`playing`.
- **Tile-video metadata preload** — `IntersectionObserver` now also sets
  `tile-video.src` with `preload="metadata"` when a card nears the viewport (400px
  margin), so the moov atom is already cached before the user taps.

---

### 2026-06-25 (end of day)

**Changes:**
- **Outputs section order swapped** — Current Session now appears above Saved (HTML reorder only).
- **Library image caching** — `Cache-Control` on `/api/images/file/` changed from
  `max-age=300` to `max-age=31536000, immutable`. Thumbnails are write-once per path
  so the browser caches them for a year; repeat library visits are now instant.

---

### 2026-06-25 (late session)

**Features added:**
- **TikTok-style tap-to-pause** — native video controls removed from expanded tiles;
  tapping the video area toggles play/pause. Pause shows ⏸ icon (stays visible);
  resume briefly flashes ▶ then fades. Icon uses `vid-pop` scale animation.
  Videos now loop automatically. Overlay cleaned up on collapse.
- **Compact active-gen card** — in-flight generation card now matches the done-video
  tile layout: same 3-column `out-grid`, `aspect-ratio: 9/16` cover, input image /
  sampling preview as background. Status badge top-left, thin accent progress bar
  along bottom edge, ✕ stop button top-right. `#out-active` changed from
  `card-list` to `out-grid`; orphan selector updated from `.out-item` → `.out-card`.

**Bugs fixed:**
- **Generate button switches to Outputs tab** — removed `switchTab("outputs")` call
  after queue. Stays on Generate tab; Outputs badge still updates live.

---

### 2026-06-25 (bugfixes)

**Bugs fixed:**
- **`ensurePushSubscription is not defined`** — stale call left in the Generate button
  handler after notifications were removed; deleted.
- **Two refresh buttons in header** — removed `#refresh` from the header, moved it
  inline into the Pods tab section (small ↻ next to "Running pods"). Only the ↺
  hard-refresh remains in the top-right.
- **Prev/next video nav not visible** — nav was appended inside `.out-cover`
  (`overflow: hidden`), and `position: absolute; inset: 0` was unreliable inside
  the flex card on iOS. Changed to `position: fixed; inset: 0` so the nav is a
  true full-viewport overlay, with ‹/› arrows at vertical-center left/right edges.
- **Generate button switches to Outputs tab** — removed the `switchTab("outputs")`
  call after queue; stays on Generate tab. Badge on Outputs tab still updates live.

---

### 2026-06-25 (multi-feature session)

**Features added:**
- **Input library copy/move** — bulk-select images, then "Copy to" or "Move to" reuses
  the existing save-panel folder picker. `_libBulkOp` state variable routes the
  `save-here-btn` handler to `POST /api/images/copy` or `/api/images/move`.
  `drive_client.copy_image` uses GCS `copy_blob`; `move_image` is copy + delete.
- **Video name field** — text input added below Seed in params (rendered in `loadConfig`,
  not in `PARAM_FIELDS` so workflow.py ignores it). Collected via `collectParams`,
  stored in `JOBS[prompt_id]["video_name"]`, persisted in `_JOB_PERSIST_KEYS`,
  exposed in `_job_public`. Shown as accent-blue label on active cards, done tiles,
  and saved tiles. Included in starred-video metadata.
- **Sampler + Scheduler combined** — `sampler_high/low` and `scheduler_high/low` merged
  into single `sampler` and `scheduler` fields that write to both KSampler nodes
  (128 and 129). Saved-video Details overlay hides legacy `sampler_low`/`scheduler_low`
  keys and relabels `sampler_high` → "Sampler", `scheduler_high` → "Scheduler".
- **One-tap clear for prompt** — `✕` button rendered inside `.prompt-wrap` wrapper on
  the Prompt textarea (key `"positive"` only); clears value and fires `input` event.
- **Prev/next video navigation** — `expandTile` appends a `.tile-nav` overlay with ‹/›
  buttons and an "N / total" counter. Navigation walks `#out-list` or `#saved-list`
  sibling cards. Buttons auto-hide at first/last position.
- **Hard refresh button** — `#hard-refresh` (↺) in the header: clears all SW caches
  with `caches.delete`, then `location.reload()`. Spinning CSS animation plays on tap.
- **Notifications removed** — `#notif-btn`, all push JS (`ensurePushSubscription`,
  `_updateNotifBtn`, `_pushState`, VAPID helpers), push API endpoints
  (`/api/push/vapid`, `/api/push/subscribe`), and `push.send_push` calls in `_watch`
  all removed. SW registration kept for app-shell caching.

**Bugs fixed:**
- **Screen stuck when vid gen completes during preview** — `loadDone` now calls
  `collapseTile` on any expanded `.out-card` in `#out-list` before overwriting
  `innerHTML`, so `body.overflow` is always restored before the node disappears.
- **Hide unused params in Details overlay** — `showDetails` now filters rows with
  `_shouldShow(key)`: hides keys starting with `_` (except `_seed`), `const` fields,
  `video_name` (metadata-only), and fields whose `when` condition isn't met in the
  saved params (e.g. LoRA sliders when the LoRA toggle was off).

**New endpoints:**
- `POST /api/images/copy` — `{src, dest}` (both relative to `input_images/`)
- `POST /api/images/move` — same; server-side copy + delete

**SW cache:** bumped to `wan-static-v4`.

---

### 2026-06-25 (SSE job stream)

**Architecture change — replaced timer-based job polling with SSE:**
- New `GET /api/pods/{pod_id}/stream` SSE endpoint (`main.py`): pushes the current
  jobs array every 1 s while a generation is active, sends a keepalive comment (`":
  ping"`) every 10 s when idle. Auth via the `wan_auth` cookie (EventSource cannot
  send custom headers; the middleware already accepts the cookie).
- `connectJobStream(podId)` / `disconnectJobStream()` in `app.js`: open/close an
  `EventSource` on that endpoint. `loadOutputs()` now calls `connectJobStream()`
  instead of the old `tickActive() + scheduleOutTick()` timer chain.
- `_applyJobsUpdate(jobs, podId)`: shared DOM-update logic extracted from the old
  `tickActive()` body; called by both the SSE message handler and the one-shot
  `tickActive()` (kept as an immediate fallback while the stream reconnects).
- `scheduleOutTick` and its `_outTimer` / `_outActivePoll`-driven interval removed
  entirely from the Outputs-tab flow.
- SW cache bumped to `wan-static-v3`.

**Why this fixes the stale "queued" card permanently:**
The old approach paused `setInterval`/`setTimeout` on `visibilitychange → hidden`
and tried to restart them on `visibilitychange → visible` / `pageshow → persisted`.
iOS has multiple edge cases where neither event fires reliably after bfcache restore,
leaving the Outputs poll dead and the active card frozen. `EventSource` sidesteps
all of this: it auto-reconnects on any drop, and the **first SSE message on every
new connection** delivers current job state — so within ~1 s of foregrounding the
app the card reflects reality, with no resume logic to get wrong.

Note: JS is frozen by iOS while the PWA is backgrounded, so the card does not
animate while minimized — updates happen when the user returns. Push notifications
handle the "fully away" completion signal.

---

### 2026-06-25 (continued)

**Bugs fixed:**
- **Stale "queued" active card after returning from background (regression)** —
  the earlier (2026-06-25) network-traffic refactor replaced the persistent
  `setInterval(tickActive, 1000)` Outputs poll with a self-cancelling
  `setTimeout` chain (`scheduleOutTick`) that **stops itself while the tab is
  hidden** and relies entirely on `visibilitychange→resumePolls()` to restart.
  On iOS Safari a backgrounded tab is often restored from the **bfcache without
  firing `visibilitychange→visible`**, so `resumePolls()` never ran, the Outputs
  poll stayed dead, and the active card frozen at "queued" was never reconciled —
  it stuck on "queued" while the generation was actually running/finished, and
  left a ghost "queued" card above the completed clip. **Fix:** also call
  `resumePolls()` on `pageshow` when `event.persisted` is true (the reliable
  bfcache-restore signal). `resumePolls()` is idempotent (each timer is cleared
  before re-arming), so the extra trigger is safe if `visibilitychange` does fire
  too. (The old `setInterval` masked this because iOS auto-resumes a live
  interval on foreground regardless of which lifecycle event fired.)
  Bumped `sw.js` `CACHE_VERSION` → `wan-static-v2`.
- **"Save to cloud" button stuck on "★ Saved" after uploading a new image** — `#img-star-btn` text was set to `"★ Saved"` on successful save but never reset when a new image was loaded. Fixed by resetting to `"☆ Save to cloud"` in both places `_currentImageFile` is assigned: the file input `change` handler and the library "use image" handler (`app.js`).

---

### 2026-06-25

**Network traffic reductions (the focus of this session):**
- **Client-side input-image downscale before upload** — `downscaleImage()` in
  `app.js` caps the longest edge at 1280px and re-encodes as JPEG (drawing an
  oriented `<img>` to a canvas, so EXIF rotation is baked in). Wan i2v resizes
  the input anyway, so this cuts the per-generation upload (phone→Fly→pod) by
  ~80–95% for typical phone photos. Falls back to the original on any failure.
- **Immutable caching on all video endpoints** — `serve_saved_file`,
  `/api/pods/{id}/view`, and `/api/video/{id}` now send
  `Cache-Control: private, max-age=31536000, immutable` (generated clips are
  write-once). Re-visiting the Outputs tab no longer re-downloads cover data.
- **HTTP Range support on pod-proxied video** — `comfy_client.open_view_stream`
  now forwards the browser's `Range` header to ComfyUI (aiohttp honours it) and
  returns `(resp, body)`; `main.py` `_proxy_view()` streams it back (no RAM
  buffer) passing through `Content-Length` / `Content-Range` / `206`. Cover
  thumbnails (`<video preload>`) and seeks transfer only the bytes needed
  instead of the whole clip. (This also re-fixes the original
  StreamingResponse-without-Content-Length playback bug by passing both through.)
- **Lazy-loaded video cover tiles** — covers render with `preload="none"` +
  `data-src`; an `IntersectionObserver` (`observeLazyCovers`) sets `src` only
  when the tile nears the viewport, so off-screen tiles cost nothing.
- **Adaptive Outputs poll** — `tickActive` no longer runs on a fixed 1s
  `setInterval`. `scheduleOutTick()` polls every 1s only while a job is in
  flight, backing off to 6s when the pod is idle (stops needlessly waking the
  Fly machine).
- **Merged metrics+events poll** — new `GET /api/pods/{id}/session` returns both
  in one request (was two every tick); the pod-card poll slowed 4s→5s and skips
  while the tab is hidden.
- **All polls pause when the tab is hidden** — `pausePolls()`/`resumePolls()` on
  `visibilitychange` stop RAM, balance, metrics, Outputs, and readiness timers
  while backgrounded. The generation keeps running server-side (`_watch` +
  push), and `resumePolls()` does one authoritative refresh on return — so the
  vid-gen status still auto-updates with no manual refresh.
- **Service worker now caches the app shell + fonts** (`sw.js`,
  `CACHE_VERSION = wan-static-v1`): precache + stale-while-revalidate for static
  assets and Google Fonts; network-first for navigations; `/api/*` and media are
  never cached by the SW (immutable HTTP caching handles media). Repeat visits
  load with ~no network and work offline. **Bump `CACHE_VERSION` on each deploy.**
- Dropped a redundant `/api/storage` fetch when switching to the Outputs tab.

**UI/UX:**
- **"Generation running" badge on the Outputs tab** — a count chip
  (`setGenBadge`) shows in-flight generations even from other tabs. Driven by
  `tickActive` on the Outputs tab and a cheap ~8s `pollGenBadge` loop elsewhere
  that self-stops at zero (so it only adds traffic while a job is actually live).
- **Generate button auto-recovers from "warming up"** — `onGenPodChange` now
  polls readiness every 5s (`checkGenReady`) and enables the button the moment
  ComfyUI answers; no manual re-select/refresh. Self-stops on ready / pod change.
- **Error toasts are dismissible** — longer (8s) and tap-to-dismiss so failures
  aren't missed.
- **Accessibility** — `aria-label`s on the icon-only header/refresh buttons
  (RAM chip, balance, RAM-clear, notifications, all refresh buttons).

**New endpoints:**
- `GET /api/pods/{id}/session` — `{metrics, events}` bundled (halves poll traffic).

**Deferred (intentionally not done):**
- Server-side ffmpeg poster JPEGs for saved tiles — folded into Range + caching +
  lazy-load instead, to avoid heavy video decoding on the 512MB Fly box.
- Pull-to-refresh — manual ↻ already exists; low value vs. gesture/scroll risk.

---

### 2026-06-20 (continued)

**Bugs fixed:**
- **Push notifications not firing** — two root causes:
  1. `send_push` passed the raw PEM string to `pywebpush`, which requires a `Vapid01` instance; now loads PEM into `Vapid01` before calling `webpush()`. Added `[push]` server log lines so success/failure is visible in `fly logs`.
  2. Push was fire-and-forget (background task) so the Fly machine could auto-stop before the HTTP request to the push service completed. All three terminal states in `_watch` now directly `await asyncio.to_thread(push.send_push, ...)` so the send finishes before the watcher exits. Removed unused `_notify` helper.
- **Session video playback broken** — `StreamingResponse` (added in previous session) doesn't send `Content-Length` or handle HTTP range requests; browsers need both to play `<video>` inline. Reverted `/api/video/{prompt_id}` and `/api/pods/{pod_id}/view` to buffered `fetch_view()` + `Response` with explicit `Content-Length` + `Accept-Ranges: bytes`. Wan 2.2 clips are ~5–30 MB so no OOM risk. Image thumbnail endpoint (`/api/images/file/`) still streams from GCS (appropriate there).
- **Pod status stuck on "warming up"** — `checkReady` was called once on first render but the 4s metrics tick never updated the badge. Now the tick checks `checkReady` whenever the badge still shows "warm", so it flips to "ready" automatically without a manual refresh.
- **iOS nav tabs hidden behind header** — `position: sticky; top: 60px` on `.tabs` was too low: on iPhone with `env(safe-area-inset-top) ≈ 59px` the header is ~107px tall so the tabs slid behind it. Changed to `top: calc(max(16px, env(safe-area-inset-top)) + 56px)` (~115px on iPhone, ~72px on desktop).
- **Stale "queued" active card after returning from background** — when the browser woke up, `loadDone` showed the completed video but `tickActive` could still see the job as "running" server-side (watcher not yet updated), leaving both visible simultaneously. `loadDone` now removes any active card whose `prompt_id` matches a completed video, and adds it to `_seenDone` so `tickActive` won't re-create it.
- **Missing timestamp/gen time on session video tiles** — `save_stat` was only called when `started_at` was non-null; if the Fly machine restarted mid-generation, `started_at` was never set and `completed_at` was never persisted. Now `save_stat` is always called at completion (duration is `None` if start time unavailable, but timestamp is always recorded).
- **🔔 notification status button** — added to header; shows dim (off) / bright (on) / blocked state. Tapping it triggers the permission + subscription flow; shows iOS Home Screen hint if `PushManager` is unavailable in a regular browser tab.

---

### 2026-06-20

**Features added:**
- Web Push notifications — server notifies phone when video generation completes (ready / failed / timed-out), even with browser minimised or closed
  - New `app/push.py`: auto-generates & persists a VAPID keypair to `data/vapid.json` on first run (or reads from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env vars); subscription store in `data/push_subs.json`; prunes dead subscriptions on 404/410 responses
  - New `GET /api/push/vapid` + `POST /api/push/subscribe` endpoints in `main.py`
  - `_notify()` helper fires push at all terminal states in `_watch()` (success, error, timeout)
  - New `static/sw.js` service worker: handles `push` events → `showNotification`; `notificationclick` focuses or opens app window
  - New `static/manifest.webmanifest` + PWA meta tags in `index.html` (required for iOS 16.4+ Web Push — must be added to Home Screen first)
  - New PNG icons: `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`
  - Frontend: `registerServiceWorker()` + `ensurePushSubscription()` in `app.js`; permission request triggered on first Generate tap (user gesture required); auto-re-subscribes in `init()` if permission was previously granted
  - `pywebpush>=1.14.0` added to `requirements.txt`; `data/vapid.json` + `data/push_subs.json` added to `.gitignore`

**Bugs fixed:**
- `startMetrics()` timer leak — per-second uptime ticker accumulated indefinitely across `loadPods()` calls; fixed by tracking all timers in `uptimeTimers = {}` and clearing them at the top of each `loadPods()` call
- Generation error message was always generic — `jobErrorText()` helper now extracts real ComfyUI reason from `exception_message`, `status_str`, `error`, or `node_type`
- 4 bare `fetch()` calls bypassed `apiFetch()` and never sent auth headers — fixed for `/api/generate`, `useLibraryImage`, lib-bulk-delete, and `/api/images/save`
- Template name in `<option>` was unescaped (XSS risk) — `esc(t.name)` applied in `renderTemplateSelect`; pod names/IDs escaped in all dropdowns
- Null RunPod balance crashed `updateBalance()` — guard renders `"—"` and neutral CSS class when balance is `null`
- `/api/video/{prompt_id}` and `/api/pods/{pod_id}/view` buffered entire MP4 in RAM before sending — replaced with `comfy.open_view_stream()` + `StreamingResponse` (eliminates OOM risk on 512MB Fly VM); `fetch_view()` kept for star-to-GCS path (needs bytes)
- `generation_params.json` and `generation_durations.json` grew without bound — `persistence.py` now trims to 500 / 1000 entries respectively before each write

**New env vars (optional):**
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — override auto-generated VAPID keys (useful if rotating or migrating keys without losing existing push subscriptions)

---

### 2026-06-19 (continued)

**Bugs fixed (late session):**
- Workflow BF16/GGUF tab lost selection when user clicked Upload/Library or other elements — `$$(".img-mode-tab")` was a global selector that toggled `active` on every `.img-mode-tab` on the page, wiping the workflow selection whenever the image tab row was touched. Fixed by scoping to `btn.closest(".img-mode-tabs")` so each tab row only manages its own buttons.
- Session video multi-select "Select" button was invisible — it was placed next to the pod dropdown, not next to the "📹 Current Session" section header. Moved to match the ⭐ Saved section pattern.
- Scroll lock when deleting/removing an expanded video card — `card.remove()` bypassed `collapseTile()`, leaving `body.overflow=hidden`. Added `removeCard()` helper that collapses first; applied to all 5 card-removal sites (delete, bulk delete, star-to-saved, unstar, bulk unstar).
- Workflow tab visual state not obvious — changed active tab to filled accent-blue pill (solid background, dark text, bold) so selected model is unmistakable.
- Template/preset Update and Delete: undo toast (5s) now appears after each action with an "Undo" button that reverses server-side changes (Update reverts via PUT with old data; Delete restores via POST).
- Seed input blank/invalid value caused 500 on generate — `_coerce` now handles `ValueError`/`TypeError` gracefully (treats as 0 = randomise). Seed input default changed to empty; placeholder updated to "Leave blank (or 0) to randomise each run".
- Login password field used browser default styling — `input[type="password"]` was missing from CSS styled-input selector.
- Select buttons (session/saved/library) now toggle to "Done" when active; tapping Done exits selection without needing the Cancel bar.
- Stop generation confirmation replaced browser `confirm()` with custom `showConfirm()` dialog.
- `collectParams()` was collecting button elements with `data-key` (the 🎲 seed-rand button), overwriting the real seed value with `""` → 500 on every generate. Fixed by scoping selector to `input, textarea, select` only.
- `toastUndo()` helper added for reversible actions.

---

### 2026-06-19

**Features added:**
- Workflow selector (BF16 / GGUF toggle) in Generate tab — tabs rendered dynamically from files in `workflows/` (ram_clear.json excluded); selection persisted in localStorage; chosen workflow sent as `workflow_file` form field on each generate request. Adding new workflow files to `workflows/` auto-populates new tabs on next deploy. All param node IDs confirmed identical between bf16 and GGUF workflows — only loader nodes differ (UNETLoader vs UnetLoaderGGUF).
- Seed control in params panel — `_seed` promoted from hidden const to visible input with 🎲 randomise button; `0` / blank = randomise each run, positive int = fixed seed
- Seed auto-captured after generation — `_backfill_seed()` extracts actual seed from ComfyUI history (node `158`) and overwrites the placeholder; old videos show `"— (not captured)"`
- "Use this seed" button in generation details overlay — appears only when a real seed was captured
- Param preset **Update** button — `PUT /api/param-presets/{index}` + Update button in params, mirrors template Update flow; "Save current" renamed "Save as new"
- Undo system — `captureUndo()` + `↩ Undo (N)` button in Prompt card; 10-step history
- Fly machine keep-alive — `_keepalive_loop()` pings localhost every 30s while any job is running; prevents Fly idle-stop mid-generation when browser is closed
- Input image cloud library (Upload/Library tab toggle, GCS folder browser, select + bulk delete, save-to-cloud flow)
- Saved video bulk unstar; custom login overlay; custom `showConfirm()` / `showPrompt()` dialogs
- Fly.io storage meter (Generate + Outputs tabs); live RAM chip in header
- Output card redesign — thumbnail-only grid tiles with gradient overlay; solid expanded bottom panel; SVG play icon

**Bugs fixed:**
- Generate returned 500 after seed feature — 🎲 button had `data-key="_seed"` so `collectParams()` collected it (button `.value` = `""`), overwriting input; fixed by scoping selector to form controls only
- Blank seed input also caused 500 — `_coerce("", "seed")` → `ValueError`; fixed with try/except
- Media (videos/images) failed to load on iOS — `<video src>` / `<img src>` bypass `apiFetch()` and never send `Authorization`; fixed with `wan_auth` httponly cookie accepted by middleware; `POST /api/auth/cookie` was returning 500 due to missing `JSONResponse` import — fixed
- iOS scroll lock — `switchTab()` never called `collapseTile()`, leaving `body.overflow=hidden` on the new tab
- Generation state lost when iOS backgrounds browser — `visibilitychange` now refreshes outputs; `tickActive()` calls `loadDone()` on orphaned active cards; `cancel_job` no longer wipes a job that already completed
- OOM crash: 256MB → 512MB Fly; GCS client cached; `serve_saved_file` streams via `FileResponse`; image thumbnails streamed in chunks
- iOS sticky bars drifting / tab button glitch on scroll — removed `backdrop-filter` from all `position:fixed`/`sticky` elements (WebKit compositing bug)
- Library photos stacked on iOS — `padding-bottom:100%` trick replaces `aspect-ratio`
- Tile text overlapping — `line-height:0` from `.out-cover` cascaded into `.tile-foot`; reset to `1.35`
- Long filename broke upload button layout — `overflow:hidden` + `text-overflow:ellipsis`
- Login password field unstyled — `input[type="password"]` missing from CSS selector
- Select buttons (session/saved/library) now toggle to "Done" when active
- Stop generation confirmation replaced browser `confirm()` with custom dialog

**New endpoints:**
- `GET /api/storage`, `GET /api/sysmetrics`, `POST /api/auth/cookie`
- `PUT /api/param-presets/{index}`
- `GET|POST|DELETE /api/images/*` (browse, file, folder, save)

**Security:** path traversal guards on `serve_saved_file` and `delete_image_folder`; `_saved_lock` for star/unstar; 60s GCS timeouts; auth only on `/api/*` routes

---

### 2026-06-19 (initial session)

**Features added:**
- Input image cloud library (Upload/Library tab toggle, GCS-backed folder browser with breadcrumb nav, select + bulk delete, save-to-cloud flow with inline folder picker + create folder)
- Saved video bulk unstar (select mode in Outputs → Saved section)
- Custom login overlay (replaces browser native Basic Auth dialog; credentials in sessionStorage)
- Custom `showConfirm()` / `showPrompt()` dialogs (replaced all `confirm()` / `window.prompt()` calls)
- Fly.io storage meter on Generate + Outputs tabs (used/total bar, amber >75%, red >90%)
- Live RAM chip in header (`RAM N%` from cgroup, polls every 5s while tab visible, pauses on hide)
- Undo system — `captureUndo()` + `↩ Undo (N)` button in Prompt card; 10-step history, captured at template Use / preset Apply / details Apply / Generate
- Param preset **Update** button (`PUT /api/param-presets/{index}`) — overwrites selected preset in place, mirrors template Update flow; "Save current" renamed "Save as new"
- Output card redesign — grid tiles show thumbnail only with gradient duration/datetime overlay; expanded state has solid bottom panel with "← Back" + text-labelled action buttons; SVG play icon

**Bugs fixed:**
- OOM crash: 256MB → 512MB Fly machine; GCS client now cached (single instance); `serve_saved_file` streams via `FileResponse`; image thumbnails streamed in chunks via `iter_image()`
- Startup blocking Fly health check: GCS sync moved to background `asyncio.Task`
- iOS sticky bars drifting on scroll: removed `backdrop-filter` from all `position:fixed` bars (WebKit bug)
- Library photos stacked on iOS: replaced `aspect-ratio:1` with `padding-bottom:100%` + absolutely-positioned inner content
- Tile duration/datetime overlapping: `.out-cover` sets `line-height:0`; reset to `1.35` on `.tile-foot` so stacked text has height
- Library path encoding: `encPath()` helper preserves `/` for FastAPI `{path:path}` params (plain `encodeURIComponent` was encoding `/` → `%2F` causing 404s)

**Security hardened:**
- `serve_saved_file`: path traversal guard (reject filenames with `/` or `..`)
- `delete_image_folder`: rejects empty/`..` prefixes at endpoint and GCS client layer
- `_saved_lock`: `asyncio.Lock()` serializes star/unstar read-modify-write + GCS push
- GCS: explicit 60s timeout on every blob/list/delete/upload operation
- Auth: backend no longer sends `WWW-Authenticate: Basic` header (prevents browser native dialog); only `/api/*` routes are protected (static files load without auth so login page can render)

**New endpoints:**
- `GET /api/storage` — Fly volume disk usage + saved_bytes
- `GET /api/sysmetrics` — container RAM from cgroup / `/proc/meminfo`
- `GET /api/images/browse?prefix=` — list GCS image library folders + files
- `GET /api/images/file/{path:path}` — stream image from GCS
- `POST /api/images/save` — upload image to GCS library
- `DELETE /api/images/file/{path:path}` — delete single image
- `DELETE /api/images/folder/{path:path}` — recursive folder delete (guarded)
- `POST /api/images/folder` — create virtual GCS folder via `.keep` blob
- `PUT /api/param-presets/{index}` — update existing preset in place

**Known issues still open:**
- `active_jobs.json` restored watcher polls terminated pod for up to 15 min
- No auto-eviction of saved videos if volume fills
