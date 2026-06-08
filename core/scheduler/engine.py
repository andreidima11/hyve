"""APScheduler instance and lifecycle helpers."""

from __future__ import annotations

import time
from datetime import datetime

from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler

from logger import log_detail, log_line

jobstores = {"default": SQLAlchemyJobStore(url="sqlite:///jobs.sqlite")}
scheduler = BackgroundScheduler(jobstores=jobstores)

_CONFIG_RELOAD_INTERVAL = 30
_last_config_reload = 0.0


def reload_config_if_needed() -> None:
    """Reload settings at most every _CONFIG_RELOAD_INTERVAL seconds."""
    global _last_config_reload
    now = time.time()
    if now - _last_config_reload >= _CONFIG_RELOAD_INTERVAL:
        try:
            import settings as _s

            _s.reload_config()
            _last_config_reload = now
        except Exception as exc:
            log_detail("scheduler", "CONFIG_RELOAD_ERROR", error=str(exc))


def start_scheduler() -> None:
    if not scheduler.running:
        scheduler.start()
        log_line("success", "✅", "SCHEDULER", "Started (Database Backed)")


def stop_scheduler() -> None:
    if scheduler.running:
        try:
            scheduler.shutdown(wait=False)
        except Exception:
            pass


def to_naive_local(dt):
    if dt is None or dt.tzinfo is None:
        return dt
    try:
        return dt.astimezone().replace(tzinfo=None)
    except Exception:
        return datetime.now()
