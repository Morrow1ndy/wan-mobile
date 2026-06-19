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


def _bucket():
    from google.cloud import storage
    from google.oauth2 import service_account
    info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    client = storage.Client(credentials=creds, project=info["project_id"])
    return client.bucket(os.environ["GOOGLE_GCS_BUCKET"])


def upload_video(filename: str, data: bytes):
    """Upload a video to GCS under the saved_videos/ prefix."""
    if not _enabled():
        return
    _bucket().blob(_VIDEO_PREFIX + filename).upload_from_string(
        data, content_type="video/mp4")


def download_video(filename: str) -> bytes:
    """Download a video from GCS by its filename."""
    return _bucket().blob(_VIDEO_PREFIX + filename).download_as_bytes()


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
