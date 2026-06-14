"""Backup preferences stored in ``config.json → backup``."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

import core.settings as settings_mod

VALID_INTERVALS = frozenset({"never", "daily", "weekly", "monthly"})
VALID_REMOTE_PROVIDERS = frozenset({"none", "s3", "sftp"})

DEFAULT_REMOTE_CONFIG: dict[str, Any] = {
    "enabled": False,
    "provider": "none",
    "upload_on_create": True,
    "retention_count": 5,
    "s3": {
        "bucket": "",
        "prefix": "hyve/",
        "region": "",
        "endpoint_url": "",
    },
    "sftp": {
        "host": "",
        "port": 22,
        "username": "",
        "password": "",
        "remote_path": "/backups/hyve",
    },
}

DEFAULT_BACKUP_CONFIG: dict[str, Any] = {
    "schedule_interval": "never",
    "retention_count": 10,
    "pre_restore_retention_count": 3,
    "include_optional": False,
    "include_frigate_media": False,
    "refetch_addons": False,
    "encrypt_at_rest": False,
    "remote": deepcopy(DEFAULT_REMOTE_CONFIG),
    "last_scheduled_at": None,
    "last_scheduled_status": None,
    "last_scheduled_detail": None,
}


def _merge_remote(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = deepcopy(DEFAULT_REMOTE_CONFIG)
    if not isinstance(raw, dict):
        return out
    for key in ("enabled", "upload_on_create", "retention_count", "provider"):
        if key in raw:
            out[key] = raw[key]
    provider = str(out.get("provider") or "none")
    out["provider"] = provider if provider in VALID_REMOTE_PROVIDERS else "none"
    out["retention_count"] = max(0, min(100, int(out.get("retention_count") or 0)))
    for section in ("s3", "sftp"):
        sub = raw.get(section)
        if isinstance(sub, dict):
            out[section].update(sub)
    if out["sftp"].get("port") is not None:
        out["sftp"]["port"] = int(out["sftp"].get("port") or 22)
    return out


def get_backup_config(*, redact_secrets: bool = False) -> dict[str, Any]:
    raw = settings_mod.CFG.get("backup") if settings_mod.CFG else None
    cfg = deepcopy(DEFAULT_BACKUP_CONFIG)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if key == "remote":
                cfg["remote"] = _merge_remote(value if isinstance(value, dict) else None)
            elif key in cfg or key.startswith("last_scheduled"):
                cfg[key] = value
    interval = str(cfg.get("schedule_interval") or "never")
    cfg["schedule_interval"] = interval if interval in VALID_INTERVALS else "never"
    cfg["retention_count"] = max(1, min(100, int(cfg.get("retention_count") or 10)))
    cfg["pre_restore_retention_count"] = max(
        1, min(20, int(cfg.get("pre_restore_retention_count") or 3))
    )
    cfg["include_optional"] = bool(cfg.get("include_optional"))
    cfg["include_frigate_media"] = bool(cfg.get("include_frigate_media"))
    cfg["refetch_addons"] = bool(cfg.get("refetch_addons"))
    cfg["encrypt_at_rest"] = bool(cfg.get("encrypt_at_rest"))
    cfg["remote"] = _merge_remote(cfg.get("remote") if isinstance(cfg.get("remote"), dict) else None)
    if redact_secrets:
        sftp = cfg["remote"]["sftp"]
        if sftp.get("password"):
            sftp["password"] = "••••••"
    return cfg


def save_backup_config(updates: dict[str, Any]) -> dict[str, Any]:
    current = get_backup_config()
    if "schedule_interval" in updates:
        interval = str(updates["schedule_interval"] or "never")
        current["schedule_interval"] = interval if interval in VALID_INTERVALS else "never"
    if "retention_count" in updates:
        current["retention_count"] = max(1, min(100, int(updates["retention_count"])))
    if "pre_restore_retention_count" in updates:
        current["pre_restore_retention_count"] = max(
            1, min(20, int(updates["pre_restore_retention_count"]))
        )
    for key in ("include_optional", "include_frigate_media", "refetch_addons", "encrypt_at_rest"):
        if key in updates:
            current[key] = bool(updates[key])
    if "remote" in updates and isinstance(updates["remote"], dict):
        merged = _merge_remote(current.get("remote"))
        incoming = updates["remote"]
        for key in ("enabled", "upload_on_create", "retention_count", "provider"):
            if key in incoming:
                merged[key] = incoming[key]
        for section in ("s3", "sftp"):
            sub = incoming.get(section)
            if isinstance(sub, dict):
                if section == "sftp" and sub.get("password") in {"••••••", "******"}:
                    sub = dict(sub)
                    sub.pop("password", None)
                merged[section].update(sub)
        current["remote"] = _merge_remote(merged)
    settings_mod.save_config({"backup": current})
    settings_mod.reload_config()
    return get_backup_config(redact_secrets=True)


def record_scheduled_run(*, status: str, detail: dict[str, Any] | None = None) -> None:
    cfg = get_backup_config()
    cfg["last_scheduled_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    cfg["last_scheduled_status"] = status
    cfg["last_scheduled_detail"] = detail or {}
    settings_mod.save_config({"backup": cfg})
    settings_mod.reload_config()
