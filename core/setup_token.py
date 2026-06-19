"""One-time setup token stored on disk while onboarding is incomplete."""

from __future__ import annotations

import secrets
from pathlib import Path

import core.settings as settings
from core.log_stream import log_line

_ROOT = Path(__file__).resolve().parents[1]
_SETUP_TOKEN_PATH = _ROOT / "secrets" / "setup_token"


def setup_token_path() -> Path:
    return _SETUP_TOKEN_PATH


def read_setup_token() -> str:
    try:
        return _SETUP_TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def ensure_setup_token() -> str:
    """Return the current setup token, creating secrets/setup_token if missing."""
    existing = read_setup_token()
    if existing:
        return existing
    token = secrets.token_urlsafe(32)
    _SETUP_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SETUP_TOKEN_PATH.write_text(token, encoding="utf-8")
    log_line(
        "sys",
        "🔑",
        "SETUP",
        "Setup token created — required to finish onboarding. "
        "Find it in secrets/setup_token or server logs on loopback /api/setup/status.",
    )
    return token


def verify_setup_token(provided: str) -> bool:
    expected = read_setup_token()
    if not expected or not provided:
        return False
    return secrets.compare_digest(expected, str(provided).strip())


def clear_setup_token() -> None:
    try:
        _SETUP_TOKEN_PATH.unlink(missing_ok=True)
    except OSError as exc:
        log_line("error", "⚠️", "SETUP", f"Could not remove setup token file: {exc}")


def setup_token_required() -> bool:
    from core.setup_service import is_setup_complete

    if is_setup_complete():
        return False
    return bool(read_setup_token() or True)
