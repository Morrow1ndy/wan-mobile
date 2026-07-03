"""Async HTTP client for the ComfyUI API running on a pod.

All calls target the pod's RunPod proxy URL, so they're server-to-server
(no browser CORS involved).
"""

import httpx


def _client(comfy: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=comfy, timeout=httpx.Timeout(60.0))


def ws_url(comfy: str, client_id: str) -> str:
    base = comfy.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/ws?clientId={client_id}"


async def is_ready(comfy: str) -> bool:
    """True once ComfyUI answers — handles pod cold-start / proxy 502s."""
    try:
        async with _client(comfy) as c:
            r = await c.get("/system_stats")
            return r.status_code == 200
    except Exception:
        return False


async def upload_image(comfy: str, data: bytes, filename: str) -> str:
    """Upload an image to ComfyUI's input dir; returns the stored name."""
    async with _client(comfy) as c:
        files = {"image": (filename, data, "application/octet-stream")}
        r = await c.post("/upload/image", files=files, data={"overwrite": "true"})
        r.raise_for_status()
        j = r.json()
        name = j["name"]
        if j.get("subfolder"):
            name = f"{j['subfolder']}/{name}"
        return name


async def queue_prompt(comfy: str, workflow: dict, client_id: str) -> str:
    async with _client(comfy) as c:
        r = await c.post("/prompt", json={"prompt": workflow, "client_id": client_id})
        r.raise_for_status()
        return r.json()["prompt_id"]


async def get_history(comfy: str, prompt_id: str) -> dict:
    async with _client(comfy) as c:
        r = await c.get(f"/history/{prompt_id}")
        r.raise_for_status()
        return r.json()


async def get_history_all(comfy: str, max_items: int = 10_000) -> dict:
    """All prompts in ComfyUI's current-session history (chronological).

    max_items defaults high enough to never be the thing that truncates the
    list — "Current Session" should show every clip generated on this pod for
    its whole lifetime, not just the most recent few. ComfyUI's own history
    dict is the real bound (cleared when the pod's ComfyUI process restarts).
    """
    async with _client(comfy) as c:
        r = await c.get("/history", params={"max_items": max_items})
        r.raise_for_status()
        return r.json()


async def cancel_queued(comfy: str, prompt_id: str):
    """Remove a not-yet-running prompt from ComfyUI's pending queue."""
    async with _client(comfy) as c:
        r = await c.post("/queue", json={"delete": [prompt_id]})
        r.raise_for_status()


async def interrupt(comfy: str):
    """Interrupt the currently executing prompt."""
    async with _client(comfy) as c:
        r = await c.post("/interrupt", json={})
        r.raise_for_status()


async def delete_history(comfy: str, prompt_id: str):
    """Remove a prompt from ComfyUI's history (hides it from outputs list)."""
    async with _client(comfy) as c:
        r = await c.post("/history", json={"delete": [prompt_id]})
        r.raise_for_status()


async def fetch_view(comfy: str, filename: str, subfolder: str = "",
                     type_: str = "output") -> bytes:
    """Download a generated file (video/image) from ComfyUI, fully buffered.

    Use only when the bytes are needed in memory (e.g. starring a video, which
    must upload to GCS). For serving to the browser, prefer open_view_stream().
    """
    async with _client(comfy) as c:
        r = await c.get("/view", params={
            "filename": filename, "subfolder": subfolder, "type": type_,
        })
        r.raise_for_status()
        return r.content


async def open_view_stream(comfy: str, filename: str, subfolder: str = "",
                           type_: str = "output", range_header: str | None = None):
    """Stream a generated file from ComfyUI without buffering it in RAM.

    Forwards an optional HTTP `Range` header so the browser only pulls the
    bytes it needs — `<video preload="metadata">` cover tiles fetch just the
    moov atom + first frame instead of the whole clip, and seeking transfers
    only the seeked region. ComfyUI serves /view via aiohttp's FileResponse,
    which honours Range (replies 206 + Content-Range) and otherwise returns
    200 + Content-Length.

    Returns `(resp, body_generator)`. The caller reads `resp.status_code` and
    the relevant headers to pass through, then streams `body_generator`. The
    underlying httpx client/response stay open until the generator is fully
    consumed, then close in its `finally`. raise_for_status runs first so HTTP
    errors (4xx/5xx) surface immediately; a 206 is not an error.
    """
    client = httpx.AsyncClient(base_url=comfy, timeout=httpx.Timeout(120.0))
    headers = {"Range": range_header} if range_header else {}
    req = client.build_request("GET", "/view", params={
        "filename": filename, "subfolder": subfolder, "type": type_,
    }, headers=headers)
    resp = await client.send(req, stream=True)
    try:
        resp.raise_for_status()
    except Exception:
        await resp.aclose()
        await client.aclose()
        raise

    async def body():
        try:
            async for chunk in resp.aiter_bytes():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return resp, body()
