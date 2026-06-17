"""Thin async wrapper over the RunPod Python SDK.

The SDK is synchronous, so every call is pushed to a thread to avoid blocking
the FastAPI event loop. The RunPod API key is read once from settings.
"""

import asyncio

import runpod

from .config import settings

runpod.api_key = settings.runpod_api_key


async def _call(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


def comfy_url(pod_id: str) -> str:
    """RunPod's public proxy URL for the pod's ComfyUI port."""
    return f"https://{pod_id}-{settings.comfy_port}.proxy.runpod.net"


async def list_gpus():
    return await _call(runpod.get_gpus)


async def list_pods():
    return await _call(runpod.get_pods)


async def get_pod(pod_id: str):
    return await _call(runpod.get_pod, pod_id)


async def create_pod(gpu_type_id: str | None = None, name: str | None = None):
    """Create a pod from the configured template + network volume.

    The network volume is region-locked, so we pin data_center_id to match.
    """
    return await _call(
        runpod.create_pod,
        name or settings.pod_name,         # name
        settings.image_name or "",          # image_name (blank => template's)
        gpu_type_id or settings.gpu_type_id,  # gpu_type_id
        cloud_type=settings.cloud_type,
        data_center_id=settings.data_center_id or None,
        template_id=settings.template_id or None,
        network_volume_id=settings.network_volume_id or None,
        container_disk_in_gb=settings.container_disk_gb,
        ports=f"{settings.comfy_port}/http,22/tcp",
    )


async def stop_pod(pod_id: str):
    return await _call(runpod.stop_pod, pod_id)


async def resume_pod(pod_id: str, gpu_count: int = 1):
    return await _call(runpod.resume_pod, pod_id, gpu_count)


async def terminate_pod(pod_id: str):
    return await _call(runpod.terminate_pod, pod_id)
