"""Google Cloud Storage backend for saved videos.

All functions are synchronous (google-cloud-storage is sync).
Call them with asyncio.to_thread() from async FastAPI handlers.
Gracefully no-ops when GOOGLE_SERVICE_ACCOUNT_JSON is unset (local dev).
"""

import json
import os

_METADATA_BLOB = "wan_saved_videos.json"
_VIDEO_PREFIX = "saved_videos/"


def _enabled() -> bool:
    return bool(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON") and
                os.getenv("GOOGLE_GCS_BUCKET"))


_gcs_bucket_cache = None


def _bucket():
    global _gcs_bucket_cache
    if _gcs_bucket_cache is not None:
        return _gcs_bucket_cache
    from google.cloud import storage
    from google.oauth2 import service_account
    info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    client = storage.Client(credentials=creds, project=info["project_id"])
    _gcs_bucket_cache = client.bucket(os.environ["GOOGLE_GCS_BUCKET"])
    return _gcs_bucket_cache


def upload_video(filename: str, data: bytes):
    """Upload a video to GCS under the saved_videos/ prefix."""
    if not _enabled():
        return
    _bucket().blob(_VIDEO_PREFIX + filename).upload_from_string(
        data, content_type="video/mp4")


def download_video(filename: str) -> bytes:
    """Download a video from GCS by its filename."""
    return _bucket().blob(_VIDEO_PREFIX + filename).download_as_bytes()


def download_video_to_file(filename: str, dest_path) -> None:
    """Stream a video from GCS directly to a file path (avoids RAM buffering)."""
    _bucket().blob(_VIDEO_PREFIX + filename).download_to_filename(str(dest_path))


def delete_video(filename: str):
    """Delete a video from GCS. Silently ignores if it doesn't exist."""
    if not _enabled():
        return
    try:
        _bucket().blob(_VIDEO_PREFIX + filename).delete()
    except Exception:
        pass


def upload_metadata(metadata_list: list):
    """Write the full saved-videos list to GCS (create or overwrite)."""
    if not _enabled():
        return
    data = json.dumps(metadata_list, indent=2, ensure_ascii=False).encode()
    _bucket().blob(_METADATA_BLOB).upload_from_string(
        data, content_type="application/json")


def download_metadata() -> list | None:
    """Download saved-videos metadata from GCS.

    Returns None when the metadata file doesn't exist yet (first use).
    """
    if not _enabled():
        return None
    blob = _bucket().blob(_METADATA_BLOB)
    if not blob.exists():
        return None
    return json.loads(blob.download_as_bytes())


# ---------- input image library ----------

_IMAGE_PREFIX = "input_images/"


def list_image_prefix(prefix: str = "") -> dict:
    """List subfolders and image files at a prefix under input_images/.

    Returns {"folders": [...], "files": [...]} where each entry has
    {"name": str, "path": str} (path is relative to input_images/).
    """
    if not _enabled():
        return {"folders": [], "files": []}
    bkt = _bucket()
    full_prefix = _IMAGE_PREFIX + prefix
    iterator = bkt.list_blobs(prefix=full_prefix, delimiter="/")
    blobs = list(iterator)
    files = []
    for blob in blobs:
        rel = blob.name[len(full_prefix):]
        if rel and rel != ".keep":
            files.append({"name": rel, "path": prefix + rel})
    folders = []
    for p in iterator.prefixes or []:
        name = p[len(full_prefix):].rstrip("/")
        if name:
            folders.append({"name": name, "path": prefix + name + "/"})
    return {
        "folders": sorted(folders, key=lambda x: x["name"]),
        "files": sorted(files, key=lambda x: x["name"]),
    }


def upload_image(path: str, data: bytes, content_type: str = "image/jpeg"):
    if not _enabled():
        return
    _bucket().blob(_IMAGE_PREFIX + path).upload_from_string(
        data, content_type=content_type)


def download_image(path: str) -> bytes:
    return _bucket().blob(_IMAGE_PREFIX + path).download_as_bytes()


def delete_image(path: str):
    if not _enabled():
        return
    try:
        _bucket().blob(_IMAGE_PREFIX + path).delete()
    except Exception:
        pass


def delete_image_folder(prefix: str):
    """Delete every object under input_images/{prefix}."""
    if not _enabled():
        return
    bkt = _bucket()
    for blob in list(bkt.list_blobs(prefix=_IMAGE_PREFIX + prefix)):
        try:
            blob.delete()
        except Exception:
            pass


def create_image_folder(path: str):
    """Create a virtual folder via a zero-byte .keep placeholder."""
    if not _enabled():
        return
    _bucket().blob(_IMAGE_PREFIX + path + ".keep").upload_from_string(
        b"", content_type="application/octet-stream")
