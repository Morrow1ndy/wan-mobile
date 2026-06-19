"""Load the API-format workflow template and patch the exposed params."""

import json
import random
from pathlib import Path

from . import config
from .config import settings

WF_PATH = Path(__file__).resolve().parent.parent / "workflows" / settings.workflow_file


def load_template() -> dict:
    with open(WF_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _as_bool(v) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() not in ("", "false", "0", "no", "off")


def _coerce(raw, fmt):
    """Return the coerced value, or None to skip writing this field."""
    if fmt == "seed":
        try:
            v = int(float(raw))
        except (ValueError, TypeError):
            v = 0  # blank or invalid input → randomise
        return random.randint(0, 2**32 - 1) if v <= 0 else v
    if raw is None or raw == "":
        return None
    if fmt == "int":
        return int(float(raw))
    if fmt == "float":
        return float(raw)
    if fmt == "int_str":          # "Int" nodes store the value as a string
        return str(int(float(raw)))
    if fmt == "bool":
        return _as_bool(raw)
    return str(raw)               # fmt == "str"


def _passes(field: dict, toggles: dict) -> bool:
    """True if the field's `when` condition matches the current toggle state."""
    cond = field.get("when")
    if not cond:
        return True
    return _as_bool(toggles.get(cond["key"], True)) == bool(cond["is"])


def build_workflow(values: dict, image_name: str) -> dict:
    """Return a ready-to-queue workflow: template + user values + image."""
    wf = load_template()

    _write(wf, {"node_id": config.IMAGE_NODE["node_id"],
                "input": config.IMAGE_NODE["input"]}, image_name)

    # resolve toggle states first (used by `when` conditions)
    toggles = dict(values)
    for f in config.PARAM_FIELDS:
        if f.get("type") == "toggle":
            toggles[f["key"]] = _as_bool(values.get(f["key"], f.get("default", True)))

    for field in config.PARAM_FIELDS:
        if field.get("type") == "toggle" and not field.get("targets"):
            continue                       # pure condition driver; no node to write
        if not _passes(field, toggles):
            continue

        if field.get("type") == "const":
            raw = field.get("value")
        else:
            if field["key"] not in values:
                continue
            raw = values[field["key"]]

        value = _coerce(raw, field.get("fmt", "str"))
        if value is None:
            continue
        for target in field.get("targets", []):
            _write(wf, target, value)

    return wf


def _write(wf: dict, target: dict, value):
    node_id = str(target["node_id"])
    if node_id not in wf:
        raise KeyError(
            f"Node '{node_id}' not found in workflow. Fix the targets in "
            f"app/config.py to match your workflow ({settings.workflow_file})."
        )
    inputs = wf[node_id].setdefault("inputs", {})
    if "path" in target:               # nested value, e.g. lora_2 -> strength
        node = inputs
        for key in target["path"][:-1]:
            node = node.setdefault(key, {})
        node[target["path"][-1]] = value
    else:
        inputs[target["input"]] = value
