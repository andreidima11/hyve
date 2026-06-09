"""First-run browser setup — admin account and essential runtime settings."""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import auth
import database
import models
import settings
from core.log_stream import log_line

SETUP_KEY = "setup_complete"
SUPPORTED_LANGUAGES = frozenset({"en", "ro"})
MIN_PASSWORD_LENGTH = 8


class SetupAlreadyCompleteError(Exception):
    """Raised when setup endpoints are called after onboarding finished."""


class SetupValidationError(Exception):
    """Raised for invalid setup payload fields."""

    def __init__(self, key: str, **params: str) -> None:
        self.key = key
        self.params = params
        super().__init__(key)


def has_any_user(db) -> bool:
    return db.query(models.User).first() is not None


def has_admin_user(db) -> bool:
    return (
        db.query(models.User)
        .filter(models.User.is_admin.is_(True), models.User.is_active.is_(True))
        .first()
        is not None
    )


def is_setup_complete() -> bool:
    if bool(settings.CFG.get(SETUP_KEY)):
        return True
    db = database.SessionLocal()
    try:
        return has_admin_user(db)
    except Exception:
        return False
    finally:
        db.close()


def mark_setup_complete() -> None:
    settings.save_config({SETUP_KEY: True})


def migrate_legacy_setup() -> bool:
    """Upgrade existing installs that already have an admin but no setup flag."""
    if bool(settings._load_config_raw().get(SETUP_KEY)):
        return False
    db = database.SessionLocal()
    try:
        if has_admin_user(db):
            mark_setup_complete()
            log_line("sys", "✅", "SETUP", "Marked setup complete for existing admin user.")
            return True
    except Exception as exc:
        log_line("error", "⚠️", "SETUP", f"Legacy setup migration failed: {exc}")
    finally:
        db.close()
    return False


def validate_timezone(value: str) -> str:
    tz = (value or "").strip()
    if not tz:
        return ""
    try:
        ZoneInfo(tz)
    except ZoneInfoNotFoundError as exc:
        raise SetupValidationError("setup.invalid_timezone", timezone=tz) from exc
    return tz


def validate_language(value: str) -> str:
    lang = (value or "en").strip().lower()
    if lang not in SUPPORTED_LANGUAGES:
        raise SetupValidationError("setup.invalid_language", language=lang)
    return lang


def _normalize_username(username: str) -> str:
    cleaned = (username or "").strip()
    if not cleaned:
        raise SetupValidationError("setup.username_required")
    if len(cleaned) < 3:
        raise SetupValidationError("setup.username_too_short")
    return cleaned


def _normalize_password(password: str) -> str:
    if not password:
        raise SetupValidationError("setup.password_required")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SetupValidationError("setup.password_too_short", min=str(MIN_PASSWORD_LENGTH))
    return password


def create_initial_admin(
    db,
    *,
    username: str,
    password: str,
    full_name: str = "",
    email: str = "",
) -> models.User:
    if is_setup_complete() or has_any_user(db):
        raise SetupAlreadyCompleteError()

    name = _normalize_username(username)
    pwd = _normalize_password(password)
    if db.query(models.User).filter(models.User.username == name).first():
        raise SetupValidationError("setup.username_taken")

    user = models.User(
        username=name,
        full_name=(full_name or "").strip() or name,
        email=(email or "").strip() or None,
        hashed_password=auth.get_password_hash(pwd),
        is_admin=True,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_line("sys", "👤", "SETUP", f"Created initial admin user: {name}")
    return user


def apply_runtime_preferences(
    *,
    language: str,
    timezone: str,
    server_name: str = "",
) -> None:
    lang = validate_language(language)
    tz = validate_timezone(timezone)
    payload: dict = {
        "ui": {"language": lang},
        SETUP_KEY: True,
    }
    if tz:
        payload["timezone"] = tz
        payload["reminder_languages"] = [lang, "en" if lang != "en" else "ro"]
    cleaned_name = (server_name or "").strip()
    if cleaned_name:
        payload["server_name"] = cleaned_name
    settings.save_config(payload)


def issue_auth_tokens(username: str) -> dict[str, str | int | bool]:
    access_token = auth.create_access_token(data={"sub": username})
    refresh_token = auth.create_refresh_token(data={"sub": username})
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "is_admin": True,
        "expires_in": auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


def complete_setup(
    db,
    *,
    username: str,
    password: str,
    full_name: str = "",
    email: str = "",
    language: str = "en",
    timezone: str = "",
    server_name: str = "",
) -> dict:
    user = create_initial_admin(
        db,
        username=username,
        password=password,
        full_name=full_name,
        email=email,
    )
    apply_runtime_preferences(
        language=language,
        timezone=timezone,
        server_name=server_name,
    )
    tokens = issue_auth_tokens(user.username)
    return {
        "status": "ok",
        "username": user.username,
        "setup_complete": True,
        **tokens,
    }


def get_setup_status() -> dict:
    complete = is_setup_complete()
    cfg = settings.CFG
    return {
        "complete": complete,
        "version": settings.APP_VERSION,
        "languages": sorted(SUPPORTED_LANGUAGES),
        "default_language": (cfg.get("ui") or {}).get("language") or "en",
        "default_timezone": (cfg.get("timezone") or "").strip() or "Europe/Bucharest",
        "server_name": (cfg.get("server_name") or "").strip() or "Hyve",
    }
