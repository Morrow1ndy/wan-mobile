"""Configuration + the workflow parameter map.

Two things live here:
  1. `settings` — env-driven RunPod/ComfyUI config (loaded from .env).
  2. `PARAM_FIELDS` / `IMAGE_NODE` / `OUTPUT_NODE_ID` — the map between the
     mobile UI controls and nodes in workflows/YAW_2.2.json (API format).

If you re-export the workflow and node ids change, update the `node_id`s below.
"""

import os
from dataclasses import dataclass
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
    data_center_id: str = os.getenv("RUNPOD_DATA_CENTER_ID", "")
    gpu_type_id: str = os.getenv("RUNPOD_GPU_TYPE_ID", "NVIDIA GeForce RTX 4090")
    cloud_type: str = os.getenv("RUNPOD_CLOUD_TYPE", "SECURE")
    image_name: str = os.getenv("RUNPOD_IMAGE_NAME", "")
    container_disk_gb: int = _int("RUNPOD_CONTAINER_DISK_GB", 20)
    comfy_port: int = _int("COMFY_PORT", 8188)
    pod_name: str = os.getenv("POD_NAME", "wan22-i2v")
    workflow_file: str = os.getenv("WORKFLOW_FILE", "YAW_2.2.json")


settings = Settings()


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

    # ---- NSFW-22 LoRA strength (nested in the rgthree Power Lora Loaders) ----
    {"key": "nsfw_high", "label": "NSFW-22 strength (High)", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.7,
     "targets": [{"node_id": "141", "path": ["lora_2", "strength"]}]},

    {"key": "nsfw_low", "label": "NSFW-22 strength (Low)", "type": "slider",
     "fmt": "float", "min": 0, "max": 2, "step": 0.05, "default": 0.3,
     "targets": [{"node_id": "142", "path": ["lora_2", "strength"]}]},

    # ---- sampler / scheduler — High KSampler (node 128) ----
    {"key": "sampler_high", "label": "Sampler (High)", "type": "select", "fmt": "str",
     "choices": ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde",
                 "dpmpp_3m_sde", "dpmpp_sde", "dpmpp_2s_ancestral", "uni_pc",
                 "uni_pc_bh2", "res_multistep", "heun", "ddim", "lcm"],
     "default": "euler",
     "targets": [{"node_id": "128", "input": "sampler_name"}]},

    {"key": "scheduler_high", "label": "Scheduler (High)", "type": "select", "fmt": "str",
     "choices": ["beta57", "beta", "normal", "karras", "exponential",
                 "sgm_uniform", "simple", "ddim_uniform", "kl_optimal",
                 "linear_quadratic"],
     "default": "beta57",
     "targets": [{"node_id": "128", "input": "scheduler"}]},

    # ---- sampler / scheduler — Low KSampler (node 129) ----
    {"key": "sampler_low", "label": "Sampler (Low)", "type": "select", "fmt": "str",
     "choices": ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde",
                 "dpmpp_3m_sde", "dpmpp_sde", "dpmpp_2s_ancestral", "uni_pc",
                 "uni_pc_bh2", "res_multistep", "heun", "ddim", "lcm"],
     "default": "euler",
     "targets": [{"node_id": "129", "input": "sampler_name"}]},

    {"key": "scheduler_low", "label": "Scheduler (Low)", "type": "select", "fmt": "str",
     "choices": ["beta57", "beta", "normal", "karras", "exponential",
                 "sgm_uniform", "simple", "ddim_uniform", "kl_optimal",
                 "linear_quadratic"],
     "default": "beta57",
     "targets": [{"node_id": "129", "input": "scheduler"}]},

    # ---- seed: auto-randomized every run, no UI control ----
    {"key": "_seed", "type": "const", "fmt": "seed", "value": 0,
     "targets": [{"node_id": "158", "input": "seed"}]},
]

# The LoadImage node that receives the uploaded image.
IMAGE_NODE = {"node_id": "361", "input": "image"}

# The node that produces the final saved video (VHS_VideoCombine, save_output).
OUTPUT_NODE_ID = "145"
