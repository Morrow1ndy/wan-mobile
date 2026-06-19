# Wan Mobile — Agent Context

**Project type:** FastAPI + Vanilla JS mobile web app deployed on Fly.io.
**Purpose:** Mobile control panel for running Wan 2.1 video generation on RunPod ComfyUI pods. One user (the owner), accessed from an iOS browser.
**Live URL:** https://wan-mobile.fly.dev/
**GitHub:** https://github.com/Morrow1ndy/wan-mobile
**Deploy command:** `fly deploy` (from project root, requires `flyctl` authenticated)

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
│   └── ram_clear.json   # ComfyUI workflow for clearing VRAM
├── fly.toml             # Fly.io config (512MB RAM, sin region, auto-stop)
├── Dockerfile
└── requirements.txt
```

**Fly.io volume:** `wan_data` mounted at `/app/data`. Persists across restarts. The Dockerfile CMD conditionally seeds JSON files on first boot only.

**GCS bucket:** `wan-mobile-videos` (Google Cloud Storage)
- `saved_videos/` — starred output MP4 files
- `input_images/` — user's cloud image library (virtual folders via `.keep` blobs)
- `wan_saved_videos.json` — saved video metadata (source of truth)

**Auth:** HTTP Basic Auth via `WAN_AUTH_USER` / `WAN_AUTH_PASS` Fly secrets. The backend only protects `/api/*` routes (not static files), and returns plain 401 JSON (no `WWW-Authenticate` header) so the browser never shows its native dialog. The frontend handles auth with a custom login overlay.

---

## Key Environment Variables / Fly Secrets

| Secret | Purpose |
|--------|---------|
| `RUNPOD_API_KEY` | RunPod GraphQL API |
| `WAN_AUTH_USER` | Login username |
| `WAN_AUTH_PASS` | Login password |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full GCS service account JSON (stringified) |
| `GOOGLE_GCS_BUCKET` | `wan-mobile-videos` |

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

**Font:** Inter (Google Fonts). All sticky bars use solid `#0b0c0e` background (not `backdrop-filter` — iOS WebKit breaks `position:fixed` with `backdrop-filter`).

**iOS-safe squares:** Library tiles use `padding-bottom: 100%` + `position: absolute` inner content (not `aspect-ratio`, which iOS WebKit collapses when an `<img>` with intrinsic dimensions is present).

---

## What Was Built This Session (2026-06-19)

### Features added
1. **Input image cloud library** — Upload/Library tab toggle in Generate card. Library browsing with virtual folder navigation (breadcrumb), `max-height` scroll, select mode + bulk delete (synced to GCS), save-temp-upload flow with folder picker + create folder.

2. **Saved video bulk unstar** — Select mode on saved videos section (via "Select" button), bulk unstar removes from GCS + local.

3. **Custom login overlay** — Styled in-app login replacing browser native Basic Auth dialog. Credentials in sessionStorage, re-injected on every API call.

4. **Custom confirm/prompt modals** — All 8 `confirm()` and 2 `window.prompt()` calls replaced with `showConfirm()` / `showPrompt()`.

5. **Storage meter** — In Generate + Outputs tabs: Fly volume used/total with colour-coded bar (accent → amber at 75% → red at 90%).

6. **Live RAM chip** — Header chip showing `RAM N%` from cgroup, polled every 5s while tab is visible. Pauses on `visibilitychange` to not keep machine alive.

7. **Undo system** — 10-step undo for prompt + params, captured at key automated changes.

8. **Param preset Update** — New `PUT /api/param-presets/{index}` endpoint + "Update" button in params tpl-actions (mirrors template Update flow).

9. **Output card redesign** — Grid tiles: thumbnail only, duration/datetime as gradient overlay. Expanded: solid bottom panel with "← Back" + text-labelled action buttons. SVG play icon replacing `▶` unicode.

### Bugs fixed
- **OOM crash**: 256MB → 512MB Fly machine; GCS client cached; serve_saved_file streams via FileResponse; image thumbnails streamed in chunks.
- **Startup blocks health check**: GCS sync moved to background task.
- **iOS sticky bars drifting**: removed `backdrop-filter` from all `position:fixed` bars.
- **Library photos stacked on iOS**: `padding-bottom: 100%` trick for grid squares.
- **Tile text overlap**: tile-foot changed to `flex-direction: column`.
- **Library path encoding**: `encPath()` helper encodes segments but preserves `/` for FastAPI `{path:path}` params (not `encodeURIComponent` which encodes `/` to `%2F`).

### Security hardened
- `serve_saved_file`: path traversal guard (reject filenames with `/`).
- `delete_image_folder`: rejects empty/`..` paths at both endpoint and GCS client.
- `saved_lock`: serializes star/unstar to prevent lost-update race.
- GCS: 60s timeout on all operations.

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

# Run locally (no GCS, no auth)
cd app && uvicorn main:app --reload --port 8000
# or from project root:
python -m uvicorn app.main:app --reload --port 8000
```

---

## Workflow Notes

- **Pushing code changes**: `git add -A && git commit -m "..." && git push && fly deploy`
- **Pulling on new machine**: `git pull` then check if Fly secrets are already set (they live in Fly, not git)
- **Data files** (`data/*.json`, `data/saved_videos/*.mp4`) are gitignored — they live only on the Fly volume and GCS
- **active_jobs.json** is gitignored (runtime state)
- **Service account key** (`*.json.key`) is gitignored — it's stored as the `GOOGLE_SERVICE_ACCOUNT_JSON` Fly secret
