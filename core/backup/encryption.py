"""Encrypt ``.hyvebak`` archives at rest (Fernet)."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger("backup.encryption")

_ENC_SUFFIX = ".enc"
_KEY_PATH = Path(__file__).resolve().parents[2] / "secrets" / "backup_archive.key"
_FERNET: Fernet | None = None


def is_encrypted_name(name: str) -> bool:
    return str(name or "").endswith(f".hyvebak{_ENC_SUFFIX}")


def encryption_key_status() -> dict[str, Any]:
    """Metadata about the active backup encryption key (never includes the key itself)."""
    env_key = (os.environ.get("HYVE_BACKUP_ENCRYPTION_KEY") or "").strip()
    if env_key:
        return {
            "configured": True,
            "source": "env",
            "file_path": None,
        }
    if _KEY_PATH.is_file() and _KEY_PATH.read_bytes().strip():
        return {
            "configured": True,
            "source": "file",
            "file_path": "secrets/backup_archive.key",
        }
    return {
        "configured": False,
        "source": None,
        "file_path": "secrets/backup_archive.key",
    }


def export_encryption_key() -> dict[str, str]:
    """Return the active Fernet key for admin export (does not create a new key)."""
    env_key = (os.environ.get("HYVE_BACKUP_ENCRYPTION_KEY") or "").strip()
    if env_key:
        return {"source": "env", "key": env_key}
    if _KEY_PATH.is_file():
        key = _KEY_PATH.read_text(encoding="utf-8").strip()
        if key:
            return {"source": "file", "key": key}
    raise ValueError("backup.encryption_key_missing")


def encryption_available() -> bool:
    try:
        _get_fernet()
        return True
    except Exception as exc:
        log.debug("Backup encryption unavailable: %s", exc)
        return False


def _load_key_bytes() -> bytes:
    env_key = (os.environ.get("HYVE_BACKUP_ENCRYPTION_KEY") or "").strip()
    if env_key:
        return env_key.encode("utf-8")
    if _KEY_PATH.is_file():
        return _KEY_PATH.read_bytes().strip()
    key = Fernet.generate_key()
    _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    _KEY_PATH.write_bytes(key)
    try:
        _KEY_PATH.chmod(0o600)
    except OSError:
        pass
    return key


def _get_fernet() -> Fernet:
    global _FERNET
    if _FERNET is not None:
        return _FERNET
    _FERNET = Fernet(_load_key_bytes())
    return _FERNET


def encrypt_file(src: Path, dest: Path | None = None) -> Path:
    """Encrypt ``src``; default output ``src`` + ``.enc``."""
    src = src.resolve()
    if not src.is_file():
        raise FileNotFoundError(str(src))
    out = (dest or Path(str(src) + _ENC_SUFFIX)).resolve()
    token = _get_fernet().encrypt(src.read_bytes())
    out.write_bytes(token)
    return out


def _fernet_for_key(key: str | bytes | None = None) -> Fernet:
    if key is None:
        return _get_fernet()
    raw = key.strip().encode("utf-8") if isinstance(key, str) else key.strip()
    return Fernet(raw)


def decrypt_file(src: Path, dest: Path, *, key: str | bytes | None = None) -> Path:
    src = src.resolve()
    dest = dest.resolve()
    if not src.is_file():
        raise FileNotFoundError(str(src))
    try:
        plain = _fernet_for_key(key).decrypt(src.read_bytes())
    except InvalidToken as exc:
        raise ValueError("backup.decrypt_failed") from exc
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(plain)
    return dest
