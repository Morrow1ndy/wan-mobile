"""Configuration + the workflow parameter map.

Two things live here:
  1. `settings` — env-driven RunPod/ComfyUI config (loaded from .env).
  2. `PARAM_FIELDS` / `IMAGE_NODE` / `OUTPUT_NODE_ID` — the map between the
     mobile UI controls and nodes in workflows/YAW_2.2.json (API format).

If you re-export the workflow and node ids change, update the `node_id`s below.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def _csv(name: str, default: str) -> list[str]:
    raw = os.getenv(name, "") or default
    return [v.strip() for v in raw.split(",") if v.strip()]


# CUDA versions to require when querying availability + deploying a pod.
# Override with RUNPOD_ALLOWED_CUDA_VERSIONS="12.8,12.9" in .env if needed.
ALLOWED_CUDA_VERSIONS = _csv("RUNPOD_ALLOWED_CUDA_VERSIONS", "12.8,12.9,13.0")

# System-RAM-per-GPU choices shown in the pod filter (GB), mirrors RunPod's UI.
RAM_OPTIONS = [8, 16, 24, 48, 80, 100]

# Container (scratch) disk is always tiny — the models live on the network
# volume, so the pod only needs a few GB of temp space.
CONTAINER_DISK_GB = 3


@dataclass
class Settings:
    runpod_api_key: str = os.getenv("RUNPOD_API_KEY", "")
    template_id: str = os.getenv("RUNPOD_TEMPLATE_ID", "")
    network_volume_id: str = os.getenv("RUNPOD_NETWORK_VOLUME_ID", "")
    # Where the network volume mounts. The Next Diffusion ComfyUI template ships
    # its venv (torch, ComfyUI) on the volume at /workspace; the SDK otherwise
    # defaults to /runpod-volume, which leaves torch unimportable.
    volume_mount_path: str = os.getenv("RUNPOD_VOLUME_MOUNT_PATH", "/workspace")
    data_center_id: str = os.getenv("RUNPOD_DATA_CENTER_ID", "")
    gpu_type_id: str = os.getenv("RUNPOD_GPU_TYPE_ID", "NVIDIA GeForce RTX 4090")
    cloud_type: str = os.getenv("RUNPOD_CLOUD_TYPE", "SECURE")
    image_name: str = os.getenv("RUNPOD_IMAGE_NAME", "")
    container_disk_gb: int = _int("RUNPOD_CONTAINER_DISK_GB", 20)
    comfy_port: int = _int("COMFY_PORT", 8188)
    pod_name: str = os.getenv("POD_NAME", "wan22-i2v")
    workflow_file: str = os.getenv("WORKFLOW_FILE", "YAW_2.2_bf16.json")


settings = Settings()

# Workflow JSON files available for selection (ram_clear excluded — internal only)
_WF_DIR = Path(__file__).resolve().parent.parent / "workflows"
AVAILABLE_WORKFLOWS: list[str] = sorted([
    f.name for f in _WF_DIR.glob("*.json")
    if f.name != "ram_clear.json"
])

# ---------------------------------------------------------------------------
# Sampler modes — three selectable workflow files, one per sampler node the
# graph exposes. Unlike the old bf16/GGUF pair (identical node IDs, only the
# model loader differed), these three have genuinely different graphs: 56
# nodes are shared byte-for-byte (steps/cfg/loras/seed/prompt/etc.), but each
# adds its own distinct sampler node(s):
#   Standard    -> KSamplerAdvanced x2 (nodes 128 High / 129 Low)
#   TripleK     -> TripleKSamplerWan22LightningAdvanced x1 (node 290, no High/Low split)
#   Clownshark  -> ClownsharKSampler_Beta x2 (nodes 209 High / 210 Low)
# PARAM_FIELDS entries below use a "workflows" key to say which file(s) they
# apply to; fields with no "workflows" key apply to all three (see
# workflow.py build_workflow, which skips fields that don't match).
WF_STANDARD = "YAW_2.2_bf16.json"
WF_TRIPLEK = "YAW_2.2_bf16_TripleK.json"
WF_CLOWNSHARK = "YAW_2.2_bf16_Clownshark.json"

# Human-readable labels for the workflow-tab UI and the "sampler mode" card badge.
WORKFLOW_LABELS = {
    WF_STANDARD: "Standard Sampler",
    WF_TRIPLEK: "TripleKSampler",
    WF_CLOWNSHARK: "Clownshark Sampler",
}

# Ground-truth sampler/scheduler enums from ComfyUI's /object_info/KSamplerAdvanced
# on the deployed pod image (nextdiffusionai/comfyui-sageattention:cuda12.8-v1),
# in ComfyUI's own order. Shared by Standard and TripleKSampler (its baked
# defaults, "euler"/"simple", are both valid members of these lists). Re-query
# that endpoint on a live pod if the image is updated. Clownshark uses a
# different custom node with its own unverified namespace — see its text-input
# fields further below.
_SAMPLER_CHOICES = ["euler", "euler_cfg_pp", "euler_ancestral",
                     "euler_ancestral_cfg_pp", "heun", "heunpp2", "exp_heun_2_x0",
                     "exp_heun_2_x0_sde", "dpm_2", "dpm_2_ancestral", "lms",
                     "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral",
                     "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu",
                     "dpmpp_2m", "dpmpp_2m_cfg_pp", "dpmpp_2m_sde",
                     "dpmpp_2m_sde_gpu", "dpmpp_2m_sde_heun", "dpmpp_2m_sde_heun_gpu",
                     "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm", "ipndm",
                     "ipndm_v", "deis", "res_multistep", "res_multistep_cfg_pp",
                     "res_multistep_ancestral", "res_multistep_ancestral_cfg_pp",
                     "gradient_estimation", "gradient_estimation_cfg_pp", "er_sde",
                     "seeds_2", "seeds_3", "sa_solver", "sa_solver_pece", "ddim",
                     "uni_pc", "uni_pc_bh2", "legacy_rk", "rk", "rk_beta",
                     "deis_3m_ode", "deis_2m_ode", "deis_3m", "deis_2m",
                     "res_6s_ode", "res_5s_ode", "res_3s_ode", "res_2s_ode",
                     "res_3m_ode", "res_2m_ode", "res_6s", "res_5s", "res_3s",
                     "res_2s", "res_3m", "res_2m"]
_SCHEDULER_CHOICES = ["simple", "sgm_uniform", "karras", "exponential",
                       "ddim_uniform", "beta", "normal", "linear_quadratic",
                       "kl_optimal", "bong_tangent", "beta57"]

# ClownsharKSampler_Beta's sampler_name/scheduler enums — a different custom
# node with its own namespace (RES4LYF), verified via /object_info on a live
# pod (nextdiffusionai/comfyui-sageattention:cuda12.8-v1). Its `scheduler`
# enum happens to be identical to _SCHEDULER_CHOICES above but is kept
# separate since the two nodes are independent and could diverge.
_CS_SAMPLER_CHOICES = ["none", "multistep/res_2m", "multistep/res_3m",
                        "multistep/dpmpp_2m", "multistep/dpmpp_3m",
                        "multistep/abnorsett_2m", "multistep/abnorsett_3m",
                        "multistep/abnorsett_4m", "multistep/deis_2m",
                        "multistep/deis_3m", "multistep/deis_4m",
                        "exponential/res_2s_rkmk2e", "exponential/res_2s",
                        "exponential/res_2s_stable", "exponential/res_3s",
                        "exponential/res_3s_non-monotonic", "exponential/res_3s_alt",
                        "exponential/res_3s_cox_matthews", "exponential/res_3s_lie",
                        "exponential/res_3s_sunstar", "exponential/res_3s_strehmel_weiner",
                        "exponential/res_4s_krogstad", "exponential/res_4s_krogstad_alt",
                        "exponential/res_4s_strehmel_weiner", "exponential/res_4s_strehmel_weiner_alt",
                        "exponential/res_4s_cox_matthews", "exponential/res_4s_cfree4",
                        "exponential/res_4s_friedli", "exponential/res_4s_minchev",
                        "exponential/res_4s_munthe-kaas", "exponential/res_5s",
                        "exponential/res_5s_hochbruck-ostermann", "exponential/res_6s",
                        "exponential/res_8s", "exponential/res_8s_alt", "exponential/res_10s",
                        "exponential/res_15s", "exponential/res_16s", "exponential/etdrk2_2s",
                        "exponential/etdrk3_a_3s", "exponential/etdrk3_b_3s",
                        "exponential/etdrk4_4s", "exponential/etdrk4_4s_alt",
                        "exponential/dpmpp_2s", "exponential/dpmpp_sde_2s",
                        "exponential/dpmpp_3s", "exponential/lawson2a_2s",
                        "exponential/lawson2b_2s", "exponential/lawson4_4s",
                        "exponential/lawson41-gen_4s", "exponential/lawson41-gen-mod_4s",
                        "exponential/ddim", "hybrid/pec423_2h2s", "hybrid/pec433_2h3s",
                        "hybrid/abnorsett2_1h2s", "hybrid/abnorsett3_2h2s",
                        "hybrid/abnorsett4_3h2s", "hybrid/lawson42-gen-mod_1h4s",
                        "hybrid/lawson43-gen-mod_2h4s", "hybrid/lawson44-gen-mod_3h4s",
                        "hybrid/lawson45-gen-mod_4h4s", "linear/ralston_2s",
                        "linear/ralston_3s", "linear/ralston_4s", "linear/midpoint_2s",
                        "linear/heun_2s", "linear/heun_3s", "linear/houwen-wray_3s",
                        "linear/kutta_3s", "linear/ssprk3_3s", "linear/ssprk4_4s",
                        "linear/rk38_4s", "linear/rk4_4s", "linear/rk5_7s", "linear/rk6_7s",
                        "linear/bogacki-shampine_4s", "linear/bogacki-shampine_7s",
                        "linear/dormand-prince_6s", "linear/dormand-prince_13s",
                        "linear/tsi_7s", "linear/euler", "diag_implicit/irk_exp_diag_2s",
                        "diag_implicit/kraaijevanger_spijker_2s", "diag_implicit/qin_zhang_2s",
                        "diag_implicit/pareschi_russo_2s", "diag_implicit/pareschi_russo_alt_2s",
                        "diag_implicit/crouzeix_2s", "diag_implicit/crouzeix_3s",
                        "diag_implicit/crouzeix_3s_alt", "fully_implicit/gauss-legendre_2s",
                        "fully_implicit/gauss-legendre_3s", "fully_implicit/gauss-legendre_4s",
                        "fully_implicit/gauss-legendre_4s_alternating_a",
                        "fully_implicit/gauss-legendre_4s_ascending_a",
                        "fully_implicit/gauss-legendre_4s_alt", "fully_implicit/gauss-legendre_5s",
                        "fully_implicit/gauss-legendre_5s_ascending", "fully_implicit/radau_ia_2s",
                        "fully_implicit/radau_ia_3s", "fully_implicit/radau_iia_2s",
                        "fully_implicit/radau_iia_3s", "fully_implicit/radau_iia_3s_alt",
                        "fully_implicit/radau_iia_5s", "fully_implicit/radau_iia_7s",
                        "fully_implicit/radau_iia_9s", "fully_implicit/radau_iia_11s",
                        "fully_implicit/lobatto_iiia_2s", "fully_implicit/lobatto_iiia_3s",
                        "fully_implicit/lobatto_iiia_4s", "fully_implicit/lobatto_iiib_2s",
                        "fully_implicit/lobatto_iiib_3s", "fully_implicit/lobatto_iiib_4s",
                        "fully_implicit/lobatto_iiic_2s", "fully_implicit/lobatto_iiic_3s",
                        "fully_implicit/lobatto_iiic_4s", "fully_implicit/lobatto_iiic_star_2s",
                        "fully_implicit/lobatto_iiic_star_3s", "fully_implicit/lobatto_iiid_2s",
                        "fully_implicit/lobatto_iiid_3s"]
_CS_SCHEDULER_CHOICES = ["simple", "sgm_uniform", "karras", "exponential",
                          "ddim_uniform", "beta", "normal", "linear_quadratic",
                          "kl_optimal", "bong_tangent", "beta57"]


# ---------------------------------------------------------------------------
# Workflow parameter map  (wired to workflows/YAW_2.2.json)
# ---------------------------------------------------------------------------
# Field schema:
#   type   : "textarea" | "slider" | "select" | "toggle" | "const"
#            ("const" is not shown; it applies a fixed `value` to its targets)
#   fmt    : "str" | "int" | "float" | "int_str" | "seed" | "bool"
#            - "int_str": for "Int" nodes whose value is a STRING ("Number")
#            - "seed":    <= 0 randomizes to a concrete number
#            - blank str/text values are skipped (keeps the workflow's value)
#   targets: [{node_id, input}]  or  [{node_id, path:[...]}] for nested values
#            (multiple targets = the value is written to all of them)
#   when   : {key, is}  -> field only renders / applies when toggle `key` == is
#
# Steps / Last-High-Step / CFG each feed an in-graph EG_WXZ_QH switch via two
# source nodes; we write to BOTH so the value applies whichever way the switch
# is flipped. The lightx2/ning toggle picks which set of values is used and
# enables/disables the distill LoRA by setting its strength (0 = off).
PARAM_FIELDS = [
    {"key": "positive", "label": "Prompt", "type": "textarea", "fmt": "str",
     "default": "", "placeholder": "Blank = keep the workflow's current prompt",
     "targets": [{"node_id": "351", "input": "text"}]},

    {"key": "seconds", "label": "Length (seconds)", "type": "slider", "fmt": "int",
     "min": 1, "max": 10, "step": 1, "default": 6,
     "targets": [{"node_id": "139", "input": "Xi"}]},

    {"key": "shift", "label": "Model shift", "type": "slider", "fmt": "float",
     "min": 1, "max": 12, "step": 0.5, "default": 8.0,
     "targets": [{"node_id": "202", "input": "value"}]},

    # ---- lightx2/ning (distill LoRA) toggle + its two value sets ----
    {"key": "lightx2v", "label": "lightx2/ning (distill LoRA)",
     "type": "toggle", "fmt": "bool", "default": True, "targets": []},

    # when ON: tune LoRA strengths + on-preset steps; CFG is forced to 1
    {"key": "lx_high", "label": "lightx2/ning High strength", "type": "slider",
     "fmt": "float", "min": 0, "max": 4, "step": 0.1, "default": 2.0,
     "when": {"key": "lightx2v", "is": True},
     "targets": [{"node_id": "234", "input": "strength_model"}]},

    {"key": "lx_low", "label": "lightx2/ning Low strength", "type": "slider",
     "fmt": "float", "min": 0, "max": 4, "step": 0.1, "default": 1.0,
     "when": {"key": "lightx2v", "is": True},
     "targets": [{"node_id": "233", "input": "strength_model"}]},

    {"key": "steps_on", "label": "Steps (lightx2/ning on)", "type": "slider",
     "fmt": "int_str", "min": 4, "max": 20, "step": 1, "default": 10,
     "when": {"key": "lightx2v", "is": True},
     "targets": [{"node_id": "153", "input": "Number"},
                 {"node_id": "241", "input": "Number"}]},

    {"key": "last_on", "label": "Last High-Noise Step (on)", "type": "slider",
     "fmt": "int_str", "min": 1, "max": 12, "step": 1, "default": 5,
     "when": {"key": "lightx2v", "is": True},
     "targets": [{"node_id": "203", "input": "Number"},
                 {"node_id": "242", "input": "Number"}]},

    # force CFG = 1 when lightx2/ning is on (hidden)
    {"key": "_cfg_on", "type": "const", "fmt": "float", "value": 1.0,
     "when": {"key": "lightx2v", "is": True},
     "targets": [{"node_id": "201", "input": "value"},
                 {"node_id": "238", "input": "value"}]},

    # when OFF: tune steps / last-step / CFG; distill LoRA strengths forced to 0
    {"key": "steps_off", "label": "Steps (lightx2/ning off)", "type": "slider",
     "fmt": "int_str", "min": 8, "max": 60, "step": 1, "default": 30,
     "when": {"key": "lightx2v", "is": False},
     "targets": [{"node_id": "153", "input": "Number"},
                 {"node_id": "241", "input": "Number"}]},

    {"key": "last_off", "label": "Last High-Noise Step (off)", "type": "slider",
     "fmt": "int_str", "min": 1, "max": 40, "step": 1, "default": 15,
     "when": {"key": "lightx2v", "is": False},
     "targets": [{"node_id": "203", "input": "Number"},
                 {"node_id": "242", "input": "Number"}]},

    {"key": "cfg_off", "label": "CFG (lightx2/ning off)", "type": "slider",
     "fmt": "float", "min": 1, "max": 12, "step": 0.1, "default": 3.5,
     "when": {"key": "lightx2v", "is": False},
     "targets": [{"node_id": "201", "input": "value"},
                 {"node_id": "238", "input": "value"}]},

    # disable the distill LoRA when off (strength 0 = no-op) (hidden)
    {"key": "_lx_high_off", "type": "const", "fmt": "float", "value": 0,
     "when": {"key": "lightx2v", "is": False},
     "targets": [{"node_id": "234", "input": "strength_model"}]},
    {"key": "_lx_low_off", "type": "const", "fmt": "float", "value": 0,
     "when": {"key": "lightx2v", "is": False},
     "targets": [{"node_id": "233", "input": "strength_model"}]},

    # ---- LoRA toggles — grouped by name (High = node 141, Low = node 142) ----
    {"key": "lora_h_1", "label": "dr34ml4y (High)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "141", "path": ["lora_1", "on"]}]},
    {"key": "dr34m_high", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_h_1", "is": True},
     "targets": [{"node_id": "141", "path": ["lora_1", "strength"]}]},
    {"key": "lora_l_1", "label": "dr34ml4y (Low)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "142", "path": ["lora_1", "on"]}]},
    {"key": "dr34m_low", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_l_1", "is": True},
     "targets": [{"node_id": "142", "path": ["lora_1", "strength"]}]},

    {"key": "lora_h_2", "label": "NSFW-22 (High)", "type": "toggle", "fmt": "bool",
     "default": True,
     "targets": [{"node_id": "141", "path": ["lora_2", "on"]}]},
    {"key": "nsfw_high", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_h_2", "is": True},
     "targets": [{"node_id": "141", "path": ["lora_2", "strength"]}]},
    {"key": "lora_l_2", "label": "NSFW-22 (Low)", "type": "toggle", "fmt": "bool",
     "default": True,
     "targets": [{"node_id": "142", "path": ["lora_2", "on"]}]},
    {"key": "nsfw_low", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.3,
     "when": {"key": "lora_l_2", "is": True},
     "targets": [{"node_id": "142", "path": ["lora_2", "strength"]}]},

    {"key": "lora_h_3", "label": "HJBJCombo (High)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "141", "path": ["lora_3", "on"]}]},
    {"key": "hjbj_high", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_h_3", "is": True},
     "targets": [{"node_id": "141", "path": ["lora_3", "strength"]}]},
    {"key": "lora_l_3", "label": "HJBJCombo (Low)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "142", "path": ["lora_3", "on"]}]},
    {"key": "hjbj_low", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_l_3", "is": True},
     "targets": [{"node_id": "142", "path": ["lora_3", "strength"]}]},

    {"key": "lora_h_4", "label": "pen1s (High)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "141", "path": ["lora_4", "on"]}]},
    {"key": "pen1s_high", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_h_4", "is": True},
     "targets": [{"node_id": "141", "path": ["lora_4", "strength"]}]},
    {"key": "lora_l_4", "label": "pen1s (Low)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "142", "path": ["lora_4", "on"]}]},
    {"key": "pen1s_low", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_l_4", "is": True},
     "targets": [{"node_id": "142", "path": ["lora_4", "strength"]}]},

    {"key": "lora_h_5", "label": "sh00tz (High)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "141", "path": ["lora_5", "on"]}]},
    {"key": "sh00tz_high", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_h_5", "is": True},
     "targets": [{"node_id": "141", "path": ["lora_5", "strength"]}]},
    {"key": "lora_l_6", "label": "sh00tz (Low)", "type": "toggle", "fmt": "bool",
     "default": False,
     "targets": [{"node_id": "142", "path": ["lora_6", "on"]}]},
    {"key": "sh00tz_low", "label": "", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "when": {"key": "lora_l_6", "is": True},
     "targets": [{"node_id": "142", "path": ["lora_6", "strength"]}]},

    # ---- sampler / scheduler ----------------------------------------------
    # Standard Sampler (KSamplerAdvanced) — one pair for both High (128) and Low (129).
    {"key": "sampler", "label": "Sampler", "type": "select", "fmt": "str",
     "workflows": [WF_STANDARD],
     "choices": _SAMPLER_CHOICES,
     "default": "euler",
     "targets": [{"node_id": "128", "input": "sampler_name"},
                 {"node_id": "129", "input": "sampler_name"}]},

    # Scheduler is multi-selectable (Standard + TripleKSampler — see below):
    # the frontend fires one /api/generate request per selected scheduler
    # (all sharing the same resolved seed), so each individual request still
    # carries a single plain scheduler string — "multiselect" only changes
    # how the Generate-tab UI renders/collects it.
    {"key": "scheduler", "label": "Scheduler", "type": "multiselect", "fmt": "str",
     "workflows": [WF_STANDARD],
     "choices": _SCHEDULER_CHOICES,
     "default": "beta57",
     "targets": [{"node_id": "128", "input": "scheduler"},
                 {"node_id": "129", "input": "scheduler"}]},

    # TripleKSampler (node 290) — a SINGLE sampler/scheduler pair drives both
    # its Base and Lightning stages together (used to be two independent
    # pairs with their own Base/Lightning labels; merged 2026-07-03 — see
    # that changelog entry). Deliberately reuses the same "sampler"/
    # "scheduler" keys as Standard Sampler above: PARAM_FIELDS entries are
    # scoped per-mode via "workflows", so only one of the two same-named
    # entries is ever visible/collected at a time (see _visibleFields() in
    # app.js) — this also means a clip generated this way naturally reuses
    # Standard's existing single-pair (no Base/Lightning label) card display.
    {"key": "sampler", "label": "Sampler", "type": "select", "fmt": "str",
     "workflows": [WF_TRIPLEK], "choices": _SAMPLER_CHOICES, "default": "euler",
     "targets": [{"node_id": "290", "input": "base_sampler"},
                 {"node_id": "290", "input": "lightning_sampler"}]},
    {"key": "scheduler", "label": "Scheduler", "type": "multiselect", "fmt": "str",
     "workflows": [WF_TRIPLEK], "choices": _SCHEDULER_CHOICES, "default": "simple",
     "targets": [{"node_id": "290", "input": "base_scheduler"},
                 {"node_id": "290", "input": "lightning_scheduler"}]},

    # Clownshark Sampler (ClownsharKSampler_Beta, nodes 209 High / 210 Low) —
    # genuinely independent High/Low pair, and NOT multi-selectable (per
    # request, multi-scheduler is Standard/TripleK only). Its sampler/scheduler
    # namespace ("multistep/res_2m", "bong_tangent", ...) is a different node
    # (ClownsharKSampler_Beta, RES4LYF) from KSamplerAdvanced's — verified via
    # /object_info/ClownsharKSampler_Beta on a live pod
    # (nextdiffusionai/comfyui-sageattention:cuda12.8-v1); see
    # _CS_SAMPLER_CHOICES / _CS_SCHEDULER_CHOICES above.
    {"key": "cs_sampler_h", "label": "Sampler (High)", "type": "select", "fmt": "str",
     "workflows": [WF_CLOWNSHARK], "choices": _CS_SAMPLER_CHOICES, "default": "multistep/res_2m",
     "targets": [{"node_id": "209", "input": "sampler_name"}]},
    {"key": "cs_scheduler_h", "label": "Scheduler (High)", "type": "select", "fmt": "str",
     "workflows": [WF_CLOWNSHARK], "choices": _CS_SCHEDULER_CHOICES, "default": "bong_tangent",
     "targets": [{"node_id": "209", "input": "scheduler"}]},
    {"key": "cs_sampler_l", "label": "Sampler (Low)", "type": "select", "fmt": "str",
     "workflows": [WF_CLOWNSHARK], "choices": _CS_SAMPLER_CHOICES, "default": "exponential/res_2s",
     "targets": [{"node_id": "210", "input": "sampler_name"}]},
    {"key": "cs_scheduler_l", "label": "Scheduler (Low)", "type": "select", "fmt": "str",
     "workflows": [WF_CLOWNSHARK], "choices": _CS_SCHEDULER_CHOICES, "default": "bong_tangent",
     "targets": [{"node_id": "210", "input": "scheduler"}]},
    {"key": "cs_eta_h", "label": "Eta (High)", "type": "slider", "fmt": "float",
     "workflows": [WF_CLOWNSHARK], "min": 0, "max": 2, "step": 0.01, "default": 0.5,
     "targets": [{"node_id": "209", "input": "eta"}]},
    {"key": "cs_eta_l", "label": "Eta (Low)", "type": "slider", "fmt": "float",
     "workflows": [WF_CLOWNSHARK], "min": 0, "max": 2, "step": 0.01, "default": 0.5,
     "targets": [{"node_id": "210", "input": "eta"}]},

    # ---- seed: 0 (or blank) = randomize each run; positive int = fixed seed ----
    {"key": "_seed", "label": "Seed", "type": "seed", "fmt": "seed", "default": 0,
     "targets": [{"node_id": "158", "input": "seed"}]},
]

# The LoadImage node that receives the uploaded image.
IMAGE_NODE = {"node_id": "166", "input": "image"}

# The node that produces the final saved video (VHS_VideoCombine, save_output).
OUTPUT_NODE_ID = "145"
