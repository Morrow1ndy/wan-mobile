"""File-backed persistence for prompt templates, last-used params,
generation stats, and saved (starred) videos.

All files live in data/ on the project root — on Fly.io this is the
persistent volume, so they survive restarts and redeploys.
"""

import json
from pathlib import Path

_DATA = Path(__file__).resolve().parent.parent / "data"
_TEMPLATES = _DATA / "prompt_templates.json"
_LAST_PARAMS = _DATA / "last_params.json"
_STATS = _DATA / "generation_durations.json"
_SAVED_META = _DATA / "saved_videos.json"
SAVED_DIR = _DATA / "saved_videos"


def _read(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def get_templates() -> list:
    return _read(_TEMPLATES, [])


def save_templates(templates: list):
    _write(_TEMPLATES, templates)


def get_last_params() -> dict:
    return _read(_LAST_PARAMS, {})


def save_last_params(params: dict):
    _write(_LAST_PARAMS, params)


def get_stats() -> dict:
    """Returns {prompt_id: {secs, at}} — handles legacy {prompt_id: int} entries."""
    raw = _read(_STATS, {})
    return {
        pid: (v if isinstance(v, dict) else {"secs": v, "at": None})
        for pid, v in raw.items()
    }


def save_stat(prompt_id: str, secs: int, completed_at: float):
    d = get_stats()
    d[prompt_id] = {"secs": secs, "at": round(completed_at)}
    _write(_STATS, d)


_PARAMS   = _DATA / "generation_params.json"
_PRESETS  = _DATA / "param_presets.json"


def save_params(prompt_id: str, params: dict):
    d = _read(_PARAMS, {})
    d[prompt_id] = params
    _write(_PARAMS, d)


def get_params(prompt_id: str) -> dict | None:
    return _read(_PARAMS, {}).get(prompt_id)


def get_param_presets() -> list:
    return _read(_PRESETS, [])


def save_param_presets(presets: list):
    _write(_PRESETS, presets)


_ACTIVE_JOBS = _DATA / "active_jobs.json"


def get_jobs() -> dict:
    """Return persisted in-flight jobs (survives restart/auto-stop)."""
    d = _read(_ACTIVE_JOBS, {})
    return d if isinstance(d, dict) else {}


def save_jobs(jobs: dict):
    _write(_ACTIVE_JOBS, jobs)


def get_saved() -> list:
    return _read(_SAVED_META, [])


def save_saved(items: list):
    _write(_SAVED_META, items)


def upsert_saved(meta: dict):
    saved = get_saved()
    idx = next((i for i, s in enumerate(saved) if s["prompt_id"] == meta["prompt_id"]), None)
    if idx is not None:
        saved[idx] = meta
    else:
        saved.insert(0, meta)
    _write(_SAVED_META, saved)


def remove_saved(prompt_id: str) -> dict | None:
    saved = get_saved()
    item = next((s for s in saved if s["prompt_id"] == prompt_id), None)
    if item:
        _write(_SAVED_META, [s for s in saved if s["prompt_id"] != prompt_id])
    return item
