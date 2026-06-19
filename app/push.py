"""Web Push (VAPID) so the phone gets a notification when a video is ready —
even with the browser minimised or closed.

How it fits together:
  - The browser registers a service worker (static/sw.js) and subscribes to push
    using our VAPID *public* key. The subscription is POSTed to /api/push/subscribe
    and stored in data/push_subs.json.
  - When a generation reaches a terminal state, main.py's _watch() calls
    send_push(); we sign each message with the VAPID *private* key and hand it to
    the browser's push service (FCM/Mozilla/etc), which wakes the service worker.

Keys: read from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) if set, otherwise
generated once and persisted to data/vapid.json so they survive restarts. The
keypair is not a credential to anyone else, so persisting it locally is fine.

Everything degrades to a no-op if pywebpush isn't installed.
"""

import base64
import json
import os
import threading
from pathlib import Path

_DATA = Path(__file__).resolve().parent.parent / "data"
_VAPID_FILE = _DATA / "vapid.json"
_SUBS_FILE = _DATA / "push_subs.json"

# Identifies us to the push service; can be any mailto/URL. Override via env.
_VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:wan-mobile@example.com")

_lock = threading.Lock()
_vapid_cache: dict | None = None


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _vapid() -> dict | None:
    """Return {'public_key': <b64url>, 'private_pem': <str>} or None if unavailable."""
    global _vapid_cache
    if _vapid_cache is not None:
        return _vapid_cache

    env_pub = os.getenv("VAPID_PUBLIC_KEY")
    env_priv = os.getenv("VAPID_PRIVATE_KEY")
    if env_pub and env_priv:
        _vapid_cache = {"public_key": env_pub, "private_pem": env_priv}
        return _vapid_cache

    try:
        if _VAPID_FILE.exists():
            _vapid_cache = json.loads(_VAPID_FILE.read_text(encoding="utf-8"))
            return _vapid_cache
    except Exception:
        pass

    # Generate a fresh keypair and persist it.
    try:
        from py_vapid import Vapid01
        from cryptography.hazmat.primitives import serialization

        v = Vapid01()
        v.generate_keys()
        private_pem = v.private_pem()
        if isinstance(private_pem, bytes):
            private_pem = private_pem.decode()
        raw_pub = v.public_key.public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        data = {"public_key": _b64url(raw_pub), "private_pem": private_pem}
        _DATA.mkdir(parents=True, exist_ok=True)
        _VAPID_FILE.write_text(json.dumps(data), encoding="utf-8")
        _vapid_cache = data
        return _vapid_cache
    except Exception as e:
        print(f"[push] VAPID unavailable: {e}")
        return None


def public_key() -> str | None:
    v = _vapid()
    return v["public_key"] if v else None


# ---- subscription store ----------------------------------------------------
def _load_subs() -> list:
    try:
        return json.loads(_SUBS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_subs(subs: list):
    _DATA.mkdir(parents=True, exist_ok=True)
    _SUBS_FILE.write_text(json.dumps(subs), encoding="utf-8")


def add_subscription(sub: dict):
    """Store a browser push subscription, de-duplicated by endpoint."""
    endpoint = (sub or {}).get("endpoint")
    if not endpoint:
        return
    with _lock:
        subs = _load_subs()
        subs = [s for s in subs if s.get("endpoint") != endpoint]
        subs.append(sub)
        _save_subs(subs)


def _remove_endpoint(endpoint: str):
    with _lock:
        subs = [s for s in _load_subs() if s.get("endpoint") != endpoint]
        _save_subs(subs)


# ---- sending ---------------------------------------------------------------
def send_push(title: str, body: str, url: str = "/", tag: str = "wan-gen"):
    """Send a notification to every stored subscription (best-effort, sync).

    Call from a thread (asyncio.to_thread). Dead subscriptions (404/410) are
    pruned automatically.
    """
    v = _vapid()
    if not v:
        return
    subs = _load_subs()
    if not subs:
        return
    try:
        from pywebpush import webpush, WebPushException
    except Exception:
        return

    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    for sub in subs:
        try:
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=v["private_pem"],
                vapid_claims={"sub": _VAPID_SUBJECT},
                timeout=10,
            )
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):
                _remove_endpoint(sub.get("endpoint", ""))
        except Exception:
            pass
