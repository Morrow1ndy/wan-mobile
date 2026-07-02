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
│   ├── app.js           # All frontend logic (~2100 lines, vanilla JS)
│   ├── sw.js            # Service worker — handles push events + notificationclick
│   └── manifest.webmanifest  # PWA manifest (required for iOS Web Push)
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
websockets, python-dotenv, python-multipart, google-cloud-storage, pywebpush. No
frontend build step — `static/` is served as-is.

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
the workflow JSON files. Two workflows are available; the user selects between
them via the workflow tab in the Generate UI:

| File | Loader | Default? |
|------|--------|----------|
| `workflows/YAW_2.2_bf16.json` | UNETLoader (bf16 weights) | ✓ (`WORKFLOW_FILE`) |
| `workflows/YAW_2.2_GGUF.json` | UnetLoaderGGUF (quantised) | selectable in UI |

**All param node IDs are identical between the two files** — only the model
loader nodes differ. So `PARAM_FIELDS` (and `IMAGE_NODE` / `OUTPUT_NODE_ID`)
applies to both workflows without any conditional logic.

Key bindings (same node IDs in both files):
- `IMAGE_NODE` = node `166` (LoadImage — receives the uploaded image)
- `OUTPUT_NODE_ID` = node `145` (VHS_VideoCombine — the saved video)
- Steps/CFG/Last-Step write to **two** source nodes each (an in-graph switch),
  so values apply whichever way the switch is flipped.
- The `lightx2v` toggle (distill LoRA) selects between two value sets and
  enables/disables the LoRA by setting strength (0 = off). CFG is forced to 1 when on.
- Seed is auto-randomized every run (`_seed` field → node `158`).

⚠️ **If you re-export either workflow from ComfyUI, node IDs change** and every
`node_id` in `PARAM_FIELDS` (plus `IMAGE_NODE` / `OUTPUT_NODE_ID`) must be updated
or generation silently breaks. `workflow.py` builds the final prompt from this map.
Re-check **both** files if you update node IDs — they must stay in sync.

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
