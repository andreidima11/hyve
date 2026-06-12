"""Shared Mammotion helpers (no pymammotion import at load)."""

from __future__ import annotations

import os
from typing import Any

# Mammotion cloud rejects logins whose App-Version is not a known Mammotion-HA
# release tag (sent as ``HA,2.<tag>``). Hyve's own semver must not be used here.
# Match Mammotion-HA manifest version (split on "-" for beta tags).
_DEFAULT_MAMMOTION_HA_FINGERPRINT = "0.6.4"


def movement_use_wifi_from_entry(data: dict[str, Any] | None) -> bool:
    """Parse CONFIG_SCHEMA bool for emergency nudge over cloud/MQTT."""
    if not data:
        return False
    value = data.get("movement_use_wifi")
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def mammotion_ha_fingerprint() -> str:
    """Version tag Mammotion accepts in the OAuth ``App-Version`` header."""
    raw = (os.environ.get("MAMMOTION_HA_FINGERPRINT") or _DEFAULT_MAMMOTION_HA_FINGERPRINT).strip()
    return raw or _DEFAULT_MAMMOTION_HA_FINGERPRINT


def hyve_client_version() -> str:
    try:
        from core.settings import APP_VERSION

        return str(APP_VERSION)
    except Exception:
        return "0.9.3"


def mammotion_cache_usable(cache: dict[str, Any] | None) -> bool:
    """True when cached credentials look complete enough for restore_credentials."""
    if not isinstance(cache, dict) or not cache:
        return False
    if cache.get("aep_data"):
        return True
    return "mammotion_mqtt" in cache and "mammotion_device_records" in cache


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            safe = json_safe(item)
            if safe is not None:
                out[str(key)] = safe
        return out
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value if json_safe(item) is not None]
    if hasattr(value, "to_dict"):
        try:
            return json_safe(value.to_dict())
        except TypeError:
            try:
                return json_safe(value.to_dict(encode_json=True))
            except Exception:
                pass
        except Exception:
            pass
    return None


def mammotion_cache_for_storage(cache: dict[str, Any] | None) -> dict[str, Any]:
    """JSON-serializable copy of pymammotion ``to_cache()`` for Hyve config storage."""
    if not isinstance(cache, dict) or not cache:
        return {}
    safe = json_safe(cache)
    return safe if isinstance(safe, dict) else {}


def is_auth_session_error(exc: BaseException | None) -> bool:
    """True when Mammotion cloud tokens are stale and cache should be cleared."""
    if exc is None:
        return False
    name = exc.__class__.__name__
    if name in {"AuthError", "ReLoginRequiredError", "SessionExpiredError", "LoginFailedError"}:
        return True
    text = f"{getattr(exc, 'reason', '')} {exc}".lower()
    markers = (
        "refreshtoken invalid",
        "re-login required",
        "session expired",
        "check iottoken failed",
        "no http client available for re-login",
        "iot biz error",
        "request auth error",
        "identityid is blank",
        "22000",
        "error check or refresh token",
    )
    return any(marker in text for marker in markers)


def is_rate_limited_error(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    if exc.__class__.__name__ in {"TooManyRequestsException", "TransportRateLimitedError"}:
        return True
    text = str(exc).lower()
    return "rate limit" in text or "too many requests" in text


def is_auth_cache_failure(exc: BaseException | None) -> bool:
    """True when cached Aliyun/MQTT credentials should be discarded."""
    return is_auth_session_error(exc)


def friendly_auth_error(exc: BaseException) -> str:
    name = exc.__class__.__name__
    reason = str(getattr(exc, "reason", "") or "").strip()
    text = str(exc).strip()
    if name == "TooManyRequestsException":
        return "Prea multe cereri către Mammotion — așteaptă ~15 minute și încearcă din nou."
    if name == "LoginFailedError":
        detail = reason or text
        lower = detail.lower()
        if "access denied" in lower:
            return (
                "Mammotion a refuzat autentificarea (access denied). "
                "Dacă contul merge în app, așteaptă 15–30 min (rate limit), loghează-te o dată în app Mammotion, "
                "apoi încearcă din nou. Folosește e-mailul/telefonul exact ca în app."
            )
        if detail:
            return f"Autentificare Mammotion eșuată: {detail}"
        return "Autentificare Mammotion eșuată — verifică contul și parola."
    if name in {"AuthError", "ReLoginRequiredError", "SessionExpiredError"}:
        detail = reason or text
        if detail:
            return f"Sesiune Mammotion invalidă: {detail}"
        return "Sesiunea Mammotion a expirat — reconectează contul."
    if text:
        return text
    return "Eroare Mammotion."
