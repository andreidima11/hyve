"""APScheduler integration for automatic Hyve backups."""

from __future__ import annotations

import logging
from typing import Any

from core.backup.config_store import get_backup_config, record_scheduled_run
from core.backup.paths import BackupOptions

log = logging.getLogger("backup.schedule")

BACKUP_JOB_ID = "hyve_scheduled_backup"


def run_scheduled_backup() -> None:
    """Create a scheduled backup using saved config options."""
    cfg = get_backup_config()
    if cfg.get("schedule_interval") == "never":
        return

    from core.backup.service import get_backup_service

    service = get_backup_service()
    options = BackupOptions(
        include_optional=bool(cfg.get("include_optional")),
        include_frigate_media=bool(cfg.get("include_frigate_media")),
    )
    try:
        result = service.create_backup(options, label="scheduled")
        record_scheduled_run(
            status="ok",
            detail={"path": result.get("path"), "deleted": result.get("retention_deleted") or []},
        )
        log.info("Scheduled backup created: %s", result.get("path"))
    except Exception as exc:
        log.exception("Scheduled backup failed")
        record_scheduled_run(status="failed", detail={"error": str(exc)})


def schedule_backup_job() -> None:
    """Register or remove the backup cron job from ``config.json → backup``."""
    from core.scheduler_service import scheduler

    cfg = get_backup_config()
    interval = cfg.get("schedule_interval", "never")

    if scheduler.get_job(BACKUP_JOB_ID):
        scheduler.remove_job(BACKUP_JOB_ID)

    if interval == "never":
        return

    cron_kwargs: dict[str, Any] = {"hour": 3, "minute": 0}
    if interval == "weekly":
        cron_kwargs["day_of_week"] = "sun"
    elif interval == "monthly":
        cron_kwargs["day"] = 1

    scheduler.add_job(
        run_scheduled_backup,
        "cron",
        id=BACKUP_JOB_ID,
        replace_existing=True,
        **cron_kwargs,
    )
    log.info("Scheduled backup job: %s (cron: %s)", interval, cron_kwargs)
