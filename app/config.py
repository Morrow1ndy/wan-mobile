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

    # ---- sampler / scheduler — single selection writes to both High (128) and Low (129) KSamplers ----
    # Choices are the exact ground-truth enums from ComfyUI's
    # /object_info/KSamplerAdvanced on the deployed pod image
    # (nextdiffusionai/comfyui-sageattention:cuda12.8-v1), in ComfyUI's own
    # order. Re-query that endpoint on a live pod if the image is updated.
    {"key": "sampler", "label": "Sampler", "type": "select", "fmt": "str",
     "choices": ["euler", "euler_cfg_pp", "euler_ancestral",
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
                 "res_2s", "res_3m", "res_2m"],
     "default": "euler",
     "targets": [{"node_id": "128", "input": "sampler_name"},
                 {"node_id": "129", "input": "sampler_name"}]},

    {"key": "scheduler", "label": "Scheduler", "type": "select", "fmt": "str",
     "choices": ["simple", "sgm_uniform", "karras", "exponential",
                 "ddim_uniform", "beta", "normal", "linear_quadratic",
                 "kl_optimal", "bong_tangent", "beta57"],
     "default": "beta57",
     "targets": [{"node_id": "128", "input": "scheduler"},
                 {"node_id": "129", "input": "scheduler"}]},

    # ---- seed: 0 (or blank) = randomize each run; positive int = fixed seed ----
    {"key": "_seed", "label": "Seed", "type": "seed", "fmt": "seed", "default": 0,
     "targets": [{"node_id": "158", "input": "seed"}]},
]

# The LoadImage node that receives the uploaded image.
IMAGE_NODE = {"node_id": "166", "input": "image"}

# The node that produces the final saved video (VHS_VideoCombine, save_output).
OUTPUT_NODE_ID = "145"
