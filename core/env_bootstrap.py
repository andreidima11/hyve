from __future__ import annotations

from dotenv import load_dotenv


_LOADED = False


def ensure_env_loaded() -> None:
    global _LOADED
    if _LOADED:
        return
    load_dotenv()
    _LOADED = True