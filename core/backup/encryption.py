"""Encrypt ``.hyvebak`` archives at rest (Fernet)."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger("backup.encryption")

_ENC_SUFFIX = ".enc"
_KEY_PATH = Path(__file__).resolve().parents[2] / "secrets" / "backup_archive.key"
_FERNET: Fernet | None = None


def is_encrypted_name(name: str) -> bool:
    return str(name or "").endswith(f".hyvebak{_ENC_SUFFIX}")


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


def decrypt_file(src: Path, dest: Path) -> Path:
    src = src.resolve()
    dest = dest.resolve()
    if not src.is_file():
        raise FileNotFoundError(str(src))
    try:
        plain = _get_fernet().decrypt(src.read_bytes())
    except InvalidToken as exc:
        raise ValueError("backup.decrypt_failed") from exc
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(plain)
    return dest
