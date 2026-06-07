"""Per-user API keys for the Assist proxy: link external requests to a Bridge user and inject memories."""
import json
import os
import uuid
import threading

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assist_keys.json")
_lock = threading.Lock()


def _load() -> dict:
    if not os.path.exists(_PATH):
        return {}
    try:
        with open(_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data: dict) -> None:
    with open(_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_or_create_key(user_id: int) -> str:
    """Return existing key or generate and save a new one."""
    with _lock:
        data = _load()
        key = data.get(str(user_id))
        if key:
            return key
        key = f"hab_{uuid.uuid4().hex}"
        data[str(user_id)] = key
        _save(data)
        return key


def regenerate_key(user_id: int) -> str:
    """Generate a new key for the user and return it."""
    with _lock:
        data = _load()
        data[str(user_id)] = f"hab_{uuid.uuid4().hex}"
        _save(data)
        return data[str(user_id)]


def get_user_id_by_token(token: str) -> int | None:
    """Return user id for this Assist API key, or None."""
    if not token or not token.startswith("hab_"):
        return None
    with _lock:
        data = _load()
        for uid, k in data.items():
            if k == token:
                try:
                    return int(uid)
                except ValueError:
                    pass
    return None
