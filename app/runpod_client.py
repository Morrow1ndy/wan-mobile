"""Thin async wrapper over the RunPod Python SDK.

The SDK is synchronous, so every call is pushed to a thread to avoid blocking
the FastAPI event loop. The RunPod API key is read once from settings.
"""

import asyncio

import runpod
from runpod.api.graphql import run_graphql_query

from . import config
from .config import settings

runpod.api_key = settings.runpod_api_key


async def _call(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


def comfy_url(pod_id: str) -> str:
    """RunPod's public proxy URL for the pod's ComfyUI port."""
    return f"https://{pod_id}-{settings.comfy_port}.proxy.runpod.net"


async def list_gpus():
    return await _call(runpod.get_gpus)


def _secure_cloud_flag():
    """Whether to query/deploy on Secure Cloud. COMMUNITY -> False, else True."""
    return settings.cloud_type != "COMMUNITY"


# RunPod's public API has no GPU-generation field, so we classify by name into
# NVIDIA architecture families (newest first). Each entry: (label, sort rank).
def _gpu_generation(display: str, gid: str):
    name = (display or "").upper()
    blob = name + " " + (gid or "").upper()
    if name == "UNKNOWN":
        return ("Other", 0)
    if "MI300" in blob or "INSTINCT" in blob or "V100" in blob:
        return ("Other", 1)
    if ("BLACKWELL" in blob or "B200" in name or "B300" in name
            or ("RTX 50" in name and "ADA" not in name)):
        return ("Blackwell", 6)
    if "H100" in blob or "H200" in blob:
        return ("Hopper", 5)
    if ("ADA" in blob or "RTX 4090" in name or "RTX 4080" in name
            or "RTX 4070" in name or name in ("L4", "L40", "L40S")):
        return ("Ada Lovelace", 4)
    if ("A100" in name or name.startswith("A40") or name.startswith("RTX A")
            or "RTX 3090" in name or "RTX 3080" in name or "RTX 3070" in name
            or name.startswith("A2000")):
        return ("Ampere", 3)
    return ("Other", 1)


# Derived (estimated) ratings — RunPod's API exposes no benchmark data, so we
# approximate from per-model lookup (falling back to architecture rank) for
# performance, and price tiers for value. Both are 1–5.
_SPEED = {5: "Exceptional", 4: "Fast", 3: "Capable", 2: "Modest", 1: "Entry-level"}
_VALUE = {5: "outstanding", 4: "strong", 3: "fair", 2: "premium", 1: "costly"}

# Ordered longest/most-specific first to prevent prefix collisions
# (e.g. "A100" must come before "A10", "L40S" before "L40" before "L4").
_PERF_OVERRIDE = [
    # Ada Lovelace professional
    ("RTX A6000",          4), ("RTX A5000", 3), ("RTX A4500", 3), ("RTX A4000", 2),
    ("RTX 6000 Ada",       5), ("RTX 5000 Ada", 4), ("RTX 2000 Ada", 2),
    # RTX PRO 6000 variants — specific names must precede the base pattern
    ("RTX PRO 6000 WK",    5), ("RTX PRO 6000 MaxQ", 4), ("RTX PRO 6000", 5),
    ("RTX PRO 5000",       4), ("RTX PRO 4500", 3), ("RTX PRO 4000", 2),
    # MIG slices
    ("PRO 6000 MIG 48GB",  4), ("PRO 6000 MIG 24GB", 3),
    # Consumer
    ("RTX 5090",           5), ("RTX 5080",  3),  # 5080 docked: only 16 GB VRAM
    ("RTX 4090",           4), ("RTX 4080",  3), ("RTX 4070", 3), ("RTX 4000", 2),
    ("RTX 3090",           3), ("RTX 3080",  2), ("RTX 3070", 1),
    # Inference / pro L-series
    ("L40S",               5), ("L40",       4), ("L4",        2),
    # Hopper
    ("H200",               5), ("H100",      5),
    # Blackwell datacenter
    ("B300",               5), ("B200",      5), ("B100",      5),
    # Ampere datacenter
    ("A100",               5), ("A40",       4), ("A30",       3),
    ("A10G",               3), ("A10",       3), ("A2000",     1),
    # AMD Instinct
    ("MI300X",             4),  # ROCm; WAN 2.2 works but ecosystem less mature
    # Volta (legacy)
    ("V100 SXM2",          2), ("Tesla V100", 2),
]


def _gpu_ratings(rank: int, vram, price, name: str = ""):
    uname = name.upper()
    perf = None
    rating_fallback = True
    for pat, score in _PERF_OVERRIDE:
        if pat.upper() in uname:
            perf = score
            rating_fallback = False
            break
    if perf is None:
        # Unknown model: fall back to architecture rank + VRAM nudges.
        base = {6: 5, 5: 5, 4: 4, 3: 3}.get(rank, 2)
        if vram and vram <= 16 and base > 1:
            base -= 1
        if vram and vram >= 80 and base < 5:
            base += 1
        perf = max(1, min(5, base))
    if price is None:
        value = None
    elif price <= 0.40:
        value = 5
    elif price <= 0.70:
        value = 4
    elif price <= 1.20:
        value = 3
    elif price <= 2.50:
        value = 2
    else:
        value = 1
    return perf, value, rating_fallback


def _gpu_blurb(category: str, vram, perf: int, value):
    arch = category if category != "Other" else "Legacy-class"
    speed = _SPEED[perf]
    if value is None:
        tail = "pricing unavailable in this region."
    else:
        tail = f"{_VALUE[value]} value for image & video generation."
    return f"{arch} GPU · {vram}GB VRAM. {speed} performance, {tail}"


def _gpu_availability_sync(min_memory_gb, cuda_versions=None):
    """Query every GPU type's live stock + price for our region/cloud/CUDA.

    Mirrors what the RunPod console shows: per-config price, VRAM, vCPU/RAM,
    and a stockStatus of High/Medium/Low (None => unavailable here).
    """
    cudas_list = cuda_versions if cuda_versions is not None else config.ALLOWED_CUDA_VERSIONS
    inputs = ["gpuCount: 1", f"secureCloud: {str(_secure_cloud_flag()).lower()}"]
    if settings.data_center_id:
        inputs.append(f'dataCenterId: "{settings.data_center_id}"')
    if min_memory_gb:
        inputs.append(f"minMemoryInGb: {int(min_memory_gb)}")
    if cudas_list:
        cudas = ", ".join(f'"{v}"' for v in cudas_list)
        inputs.append(f"allowedCudaVersions: [{cudas}]")

    query = """
    query GpuAvailability {
      gpuTypes {
        id
        displayName
        memoryInGb
        maxGpuCount
        lowestPrice(input: { %s }) {
          uninterruptablePrice
          stockStatus
          minVcpu
          minMemory
        }
      }
    }
    """ % ", ".join(inputs)

    data = run_graphql_query(query)["data"]["gpuTypes"]
    out = []
    for g in data:
        name = g.get("displayName") or g["id"]
        if name == "unknown" or not g.get("memoryInGb"):
            continue  # skip the junk placeholder entry
        lp = g.get("lowestPrice") or {}
        vram = g.get("memoryInGb")
        price = lp.get("uninterruptablePrice")
        category, rank = _gpu_generation(name, g["id"])
        perf, value, rating_fallback = _gpu_ratings(rank, vram, price, name)
        out.append({
            "id": g["id"],
            "displayName": name,
            "vram": vram,
            "max_gpu_count": g.get("maxGpuCount"),
            "price": price,
            "stock": lp.get("stockStatus"),
            "vcpu": lp.get("minVcpu"),
            "ram": lp.get("minMemory"),
            "available": lp.get("stockStatus") is not None,
            "perf": perf,
            "value": value,
            "rating_fallback": rating_fallback,
            "blurb": _gpu_blurb(category, vram, perf, value),
        })
    # available first, then by price high -> low
    out.sort(key=lambda x: (not x["available"], -(x["price"] or 0)))
    return out


async def list_gpu_availability(min_memory_gb: int | None = None,
                                cuda_versions: list[str] | None = None):
    return await asyncio.to_thread(_gpu_availability_sync, min_memory_gb, cuda_versions)


def _pod_metrics_sync(pod_id: str):
    """Live pod metrics. Tries GPU-util fields, falls back if unsupported."""
    base = ("id name desiredStatus costPerHr uptimeSeconds gpuCount "
            "memoryInGb vcpuCount containerDiskInGb machine { gpuDisplayName }")
    rich = ('runtime { uptimeInSeconds gpus { id gpuUtilPercent '
            'memoryUtilPercent } container { cpuPercent memoryPercent } }')
    try:
        q = 'query { pod(input: {podId: "%s"}) { %s %s } }' % (pod_id, base, rich)
        return run_graphql_query(q)["data"]["pod"]
    except Exception:
        q = 'query { pod(input: {podId: "%s"}) { %s } }' % (pod_id, base)
        return run_graphql_query(q)["data"]["pod"]


async def pod_metrics(pod_id: str):
    return await asyncio.to_thread(_pod_metrics_sync, pod_id)


def _balance_sync():
    data = run_graphql_query("query { myself { clientBalance } }")
    return data["data"]["myself"]["clientBalance"]


async def get_balance():
    return await asyncio.to_thread(_balance_sync)


async def list_pods():
    return await _call(runpod.get_pods)


async def get_pod(pod_id: str):
    return await _call(runpod.get_pod, pod_id)


async def create_pod(gpu_type_id: str | None = None, name: str | None = None,
                     min_memory_gb: int | None = None,
                     cuda_versions: list[str] | None = None):
    """Create a pod from the configured template + network volume.

    The network volume is region-locked, so we pin data_center_id to match.
    Container disk is fixed tiny (models live on the network volume). The
    allowed CUDA versions matter: the image needs CUDA >= 12.8, so without
    this filter RunPod may land the pod on an older-driver host and the
    container fails to start.
    """
    cudas = cuda_versions if cuda_versions else config.ALLOWED_CUDA_VERSIONS
    return await _call(
        runpod.create_pod,
        name or settings.pod_name,         # name
        settings.image_name or "",          # image_name (blank => template's)
        gpu_type_id or settings.gpu_type_id,  # gpu_type_id
        cloud_type=settings.cloud_type,
        data_center_id=settings.data_center_id or None,
        template_id=settings.template_id or None,
        network_volume_id=settings.network_volume_id or None,
        container_disk_in_gb=config.CONTAINER_DISK_GB,
        min_memory_in_gb=min_memory_gb or 1,
        allowed_cuda_versions=cudas or None,
        volume_mount_path=settings.volume_mount_path,
    )


async def stop_pod(pod_id: str):
    return await _call(runpod.stop_pod, pod_id)


async def resume_pod(pod_id: str, gpu_count: int = 1):
    return await _call(runpod.resume_pod, pod_id, gpu_count)


async def terminate_pod(pod_id: str):
    return await _call(runpod.terminate_pod, pod_id)
