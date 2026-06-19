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
- When committing, `git add -A` to include everything changed in the session.
- Deploy (`fly deploy`) only when the user asks — don't auto-deploy after a push.

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
│   └── config.py        # Settings loaded from environment / config files
├── static/
│   ├── index.html       # Single-page app shell (all overlays/modals in here)
│   ├── styles.css       # Dark mobile-first UI (CSS variables, no framework)
│   └── app.js           # All frontend logic (~1700 lines, vanilla JS)
├── data/                # Fly persistent volume mount point
│   ├── saved_videos/    # MP4 files synced from GCS on startup
│   ├── saved_videos.json
│   ├── active_jobs.json # In-flight generation state (survives auto-stop)
│   ├── prompt_templates.json
│   ├── param_presets.json
│   ├── generation_params.json
│   ├── generation_durations.json
│   └── last_params.json
├── workflows/
│   ├── YAW_2.2.json       # Wan 2.2 i2v workflow (ComfyUI API format)
│   ├── YAW_2.2_bf16.json  # bf16 variant — the ACTIVE one (WORKFLOW_FILE default)
│   └── ram_clear.json     # ComfyUI workflow for clearing VRAM
├── .env                 # ⚠️ local config — CURRENTLY COMMITTED (see Security)
├── .env.example         # template for .env
├── fly.toml             # Fly.io config (512MB RAM, sin region, auto-stop)
├── Dockerfile
└── requirements.txt
```

**Dependencies** (`requirements.txt`): fastapi, uvicorn[standard], runpod, httpx,
websockets, python-dotenv, python-multipart, google-cloud-storage. No frontend
build step — `static/` is served as-is.

**Fly.io volume:** `wan_data` mounted at `/app/data`. Persists across restarts. The Dockerfile CMD conditionally seeds JSON files on first boot only.

**GCS bucket:** `wan-mobile-videos` (Google Cloud Storage)
- `saved_videos/` — starred output MP4 files
- `input_images/` — user's cloud image library (virtual folders via `.keep` blobs)
- `wan_saved_videos.json` — saved video metadata (source of truth)

**Auth:** HTTP Basic Auth via `WAN_AUTH_USER` / `WAN_AUTH_PASS` Fly secrets. The backend only protects `/api/*` routes (not static files), and returns plain 401 JSON (no `WWW-Authenticate` header) so the browser never shows its native dialog. The frontend handles auth with a custom login overlay.

---

## Configuration (env vars)

Config is read by `config.py` via `python-dotenv`'s `load_dotenv()`. **Locally**
these come from `.env` (in repo root). **On Fly** they're set as Fly secrets
(injected as env vars). `load_dotenv()` does not override already-set env vars, so
Fly secrets win over the baked-in `.env` when both exist.

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
`workflows/YAW_2.2_bf16.json` (ComfyUI API format). Key bindings:
- `IMAGE_NODE` = node `166` (LoadImage — receives the uploaded image)
- `OUTPUT_NODE_ID` = node `145` (VHS_VideoCombine — the saved video)
- Steps/CFG/Last-Step write to **two** source nodes each (an in-graph switch),
  so values apply whichever way the switch is flipped.
- The `lightx2v` toggle (distill LoRA) selects between two value sets and
  enables/disables the LoRA by setting strength (0 = off). CFG is forced to 1 when on.
- Seed is auto-randomized every run (hidden `_seed` const → node `158`).

⚠️ **If you re-export the workflow from ComfyUI, node IDs change** and every
`node_id` in `PARAM_FIELDS` (plus `IMAGE_NODE` / `OUTPUT_NODE_ID`) must be updated
or generation silently breaks. `workflow.py` builds the final prompt from this map.

---

## Frontend Architecture (app.js)

**Auth system:** `_authHeader` (sessionStorage) → `apiFetch()` wraps all fetch calls, injects `Authorization` header, catches 401 → shows `#login-overlay`.

**Custom dialogs:** `showConfirm(msg, {okText, danger})` and `showPrompt(msg, default)` — styled overlays replacing all `confirm()` / `window.prompt()` system dialogs.

**Tabs:** Pod / Generate / Outputs. Sticky bottom bars (no `backdrop-filter` — iOS WebKit bug).

**Undo system:** `captureUndo(label)` snapshots prompt + all params. `_undoStack` max 10. Captured at: template Use, preset Apply, details Apply-to-Generate, Generate. `↩ Undo (N)` button in Prompt card header.

**Image library state:** `_libPrefix`, `_libSelectMode`, `_libSelected` — library browser with folder navigation, select mode, bulk delete.

**Key state variables:**
```js
_authHeader        // "Basic base64..." or null
_currentImageFile  // File object (uploaded or fetched from library)
_libPrefix         // current folder path in image library
_undoStack         // [{prompt, params, label}] up to 10
_outPodId          // currently selected pod in Outputs tab
JOBS               // in-memory job tracking (also persisted to active_jobs.json)
_savedSelectMode   // bulk select for saved videos
_libSelectMode     // bulk select for image library
```

---

## Backend Key Patterns

**GCS client** (`drive_client.py`): module-level `_gcs_bucket_cache` (single client instance). All calls have 60s timeout. Streaming helpers for thumbnails (`iter_image`) and video download (`download_video_to_file`) to avoid RAM buffering.

**Startup sync** (`_drive_startup_sync`): runs as a background task (not blocking uvicorn startup). Downloads GCS metadata → writes local JSON → streams missing videos to volume. Videos missing at serve time are fetched on demand by `serve_saved_file`.

**Job persistence** (`active_jobs.json`): written at queue/start/terminal states. `_restore_jobs()` on startup re-watches any `status=running` jobs. Jobs auto-expire (only running + last 60s after finish are persisted).

**Saved video concurrency** (`_saved_lock`): `asyncio.Lock()` serializes star/unstar metadata read-modify-write + GCS upload so concurrent operations don't clobber.

**Storage endpoint:** `GET /api/storage` — returns `shutil.disk_usage` of the volume + saved_bytes. Used by storage meter UI.

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

- **⚠️ `.env` is currently committed to git** (tracked, not in `.gitignore`). It
  contains `RUNPOD_API_KEY`, `WAN_AUTH_USER`, `WAN_AUTH_PASS`, and RunPod IDs.
  This is convenient for the 2-machine workflow (config travels with the repo)
  but exposes secrets to anyone with repo access and leaves them in git history.
  If hardening: `git rm --cached .env`, add `.env` to `.gitignore`, **rotate the
  RunPod key + login**, and rely on Fly secrets (already set on the server) +
  `.env.example` for onboarding. Until then, **keep the repo private**.
- Service account key (`*.json.key`) IS gitignored; it lives in the
  `GOOGLE_SERVICE_ACCOUNT_JSON` Fly secret.

---

## Known Remaining Issues

- **`active_jobs.json` on stale pod**: if a pod was terminated mid-generation, the restored watcher polls for 15 min before erroring out. Low priority.
- **No saved video count limit**: volume could fill over time. The storage meter makes this visible, but there's no auto-eviction.
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

- **Pushing code changes**: `git add -A && git commit -m "..." && git push && fly deploy`
- **Pulling on new machine**: `git pull`. Fly secrets live on Fly (not git), so the
  server is unaffected; `.env` currently travels with the repo (see Security).
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

### 2026-06-22

**Features added:**
- Workflow selector (BF16 / GGUF toggle) in Generate tab — tabs rendered dynamically from files in `workflows/` (ram_clear.json excluded); selection persisted in localStorage; chosen workflow sent as `workflow_file` form field on each generate request. Adding new workflow files to `workflows/` auto-populates new tabs on next deploy. All param node IDs confirmed identical between bf16 and GGUF workflows — only loader nodes differ (UNETLoader vs UnetLoaderGGUF).
- `workflow.py`: `build_workflow()` now accepts optional `workflow_file` param, making workflow selection per-request rather than server-global
- `/api/config` now returns `workflows` (list of available filenames) and `default_workflow`
- `/api/generate` now accepts `workflow_file` form field; validated against known files (path-traversal safe)

**Bugs fixed:**
- Generate returned 500 on every call after seed feature was added — the 🎲 randomise button carried `data-key="_seed"` so `collectParams()` (which selected all `[data-key]` elements) collected it too; a button's `.value` is `""`, overwriting the real seed input value; `_coerce("", "seed")` → `ValueError` → 500. Fixed by scoping `collectParams()` selector to `input[data-key], textarea[data-key], select[data-key]` only.
- Blank seed input also caused 500 — `_coerce` did `int(float(""))` which throws. Fixed with try/except: blank or invalid → treat as 0 → randomise.
- Login password field used browser default styling — `input[type="password"]` was missing from the CSS styled-input selector.
- Select buttons (session outputs, saved videos, image library) gave no feedback when active — now toggle to "Done" when selection mode is on; tapping "Done" exits selection (same as Cancel at bottom).
- Stop generation confirmation still used browser native `confirm()` — replaced with custom `showConfirm()` dialog.

**Seed input UX:**
- Default value changed from `"0"` to `""` so placeholder is always visible
- Placeholder updated to `"Leave blank (or 0) to randomise each run"`

---

### 2026-06-21

**Features added:**
- Fly machine keep-alive during active generations — `_keepalive_loop()` pings `GET /api/balance` on localhost every 30s while any job has `status=running`. Prevents Fly's idle-detection from stopping the machine mid-generation when the browser is closed (Fly only counts inbound HTTP; `_watch()`'s outbound RunPod connection is invisible to it). Loop is a no-op when no jobs are running so idle cost is unchanged.

**Bugs fixed:**
- Media (videos/images) failed to load on iOS but not desktop — root cause: `<video src>` and `<img src>` are browser-native fetches that never carry the JS `Authorization` header; iOS Chrome doesn't reuse JS auth state for native media requests (desktop Chrome does). Fix: auth middleware now also accepts a `wan_auth` httponly cookie set by `POST /api/auth/cookie`; the endpoint was returning 500 due to missing `JSONResponse` import — fixed.
- iOS scroll lock — expanding a video tile sets `body.overflow=hidden`; navigating away via tab buttons (or "Apply to Generate" / "Use this seed") never called `collapseTile()`, leaving overflow locked on the new tab. Fixed by collapsing any expanded tile at the top of `switchTab()`.
- Generation state lost when iOS backgrounds browser — three sub-fixes: (1) `visibilitychange` now calls `loadDone()` + `tickActive()` on foreground so finished videos appear without refresh; (2) `tickActive()` calls `loadDone()` when removing orphaned active cards (10s done-window expired before browser came back); (3) `cancel_job` no longer overwrites a job that already completed successfully, preserving timing data when user clicks Stop on a ghost active card.

**New endpoints:**
- `POST /api/auth/cookie` — set httponly auth cookie so browser-native media requests authenticate (already in 2026-06-20 entry but deploy was broken until JSONResponse import fix)

---

### 2026-06-20

**Features added:**
- Seed control in params panel — `_seed` promoted from hidden const to visible input with 🎲 randomise button; `0` = randomise each run, positive int = fixed seed
- Seed auto-captured after generation — `_backfill_seed()` extracts the actual seed used (including randomised ones) from ComfyUI history (node `158`) and overwrites the `_seed: 0` placeholder in saved params
- "Use this seed" button in generation details overlay — appears inline on the Seed row only when a real seed was captured; copies just the seed to the Generate form and switches tab. Old videos (seed not captured) show `"— (not captured)"` instead of `"0"`
- Param preset **Update** button — `PUT /api/param-presets/{index}` endpoint + Update button in params tpl-actions, mirrors template Update flow; "Save current" renamed "Save as new"
- Undo system — `captureUndo()` snapshots both prompt + all params before each automated change (template Use, preset Apply, details Apply-to-Generate, Generate); `↩ Undo (N)` button in Prompt card header, 10-step history

**Bugs fixed:**
- iOS/mobile: all videos and images failed to load (401) while desktop worked — root cause: `<video src>` and `<img src>` are browser-native fetches that bypass `apiFetch()` and never send the `Authorization` header; iOS Chrome doesn't reuse JS-injected auth for native media requests (desktop Chrome does via credential caching). Fix: auth middleware now also accepts a `wan_auth` httponly cookie; `POST /api/auth/cookie` sets it on login and on every page load; browser automatically includes it on all same-origin requests including media elements
- Long filename in upload button stretched the entire layout — added `overflow: hidden` to `.filebtn` and `text-overflow: ellipsis; white-space: nowrap` to `#image-label`
- iOS Chrome tab buttons show dark background on all tabs during scroll — same `backdrop-filter` on `position: sticky` compositing bug as the sticky bars; removed `backdrop-filter` from `.tabs`, replaced with solid-top gradient
- Tile duration/datetime text overlapping — `.out-cover` sets `line-height: 0`; this cascaded into `.tile-foot` text spans collapsing to zero height; reset `line-height: 1.35` on `.tile-foot`

**New endpoints:**
- `PUT /api/param-presets/{index}` — update existing preset in place
- `POST /api/auth/cookie` — set httponly auth cookie for media element authentication

**iOS/mobile CSS rules documented in CLAUDE.md** — three named rules covering `backdrop-filter` on fixed/sticky elements, `aspect-ratio` with img children, and text truncation in constrained containers

---

### 2026-06-19

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
