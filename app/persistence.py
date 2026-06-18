"""File-backed persistence for prompt templates and last-used params.

Both files live in data/ at the project root and are committed to git so
they travel with the project to any new environment.
"""

import json
from pathlib import Path

_DATA = Path(__file__).resolve().parent.parent / "data"
_TEMPLATES = _DATA / "prompt_templates.json"
_LAST_PARAMS = _DATA / "last_params.json"


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
