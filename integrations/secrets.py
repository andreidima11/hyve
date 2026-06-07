"""Per-integration secret encryption (Fernet).

Used by the config-entries store to keep credentials encrypted at rest
instead of storing them as plain text in ``config.json``.
"""
from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

_KEY_PATH = Path(__file__).resolve().parent.parent / "secrets" / "integration_entries.key"
_FERNET: Fernet | None = None


def _get_fernet() -> Fernet:
    global _FERNET
    if _FERNET is not None:
        return _FERNET
    _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    if _KEY_PATH.exists():
        key = _KEY_PATH.read_bytes().strip()
    else:
        key = Fernet.generate_key()
        _KEY_PATH.write_bytes(key)
        try:
            _KEY_PATH.chmod(0o600)
        except OSError:
            pass
    _FERNET = Fernet(key)
    return _FERNET


def encrypt(value: str) -> str:
    if value is None:
        return ""
    return _get_fernet().encrypt(str(value).encode("utf-8")).decode("utf-8")


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""
