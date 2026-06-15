"""Startup and shutdown phase helpers for the FastAPI lifespan."""

from __future__ import annotations

import asyncio

import httpx

import core.database as database
import core.scheduler_service as scheduler_service
import core.settings as settings
import core.storage as storage
from core.entity_store import get_entity_store
from core.log_stream import log_line, print_banner
from core.startup_status import report_subsystem


async def startup_infrastructure(app) -> None:
    print_banner()
    timeout = float(settings.CFG.get("llm", {}).get("timeout") or 120)
    app.state.http_client = httpx.AsyncClient(timeout=timeout)

    try:
        from core.loop_watchdog import start_loop_watchdog

        start_loop_watchdog(threshold_seconds=2.0, poll_seconds=0.25, dump_cooldown=30.0)
    except Exception as exc:
        log_line("error", "⚠️", "WATCHDOG", f"loop watchdog failed to start: {exc}")
        report_subsystem("watchdog", "degraded", message=str(exc))


def _purge_removed_scheduler_jobs() -> None:
    """Drop cron jobs for removed features (ambient check-ins, briefings)."""
    try:
        scheduler = scheduler_service.scheduler
        for job in list(scheduler.get_jobs()):
            jid = job.id or ""
            if jid.startswith("ambient_checkin_") or jid.startswith("briefing_"):
                scheduler.remove_job(jid)
    except Exception:
        pass


async def startup_scheduler() -> None:
    try:
        scheduler_service.start_scheduler()
        _purge_removed_scheduler_jobs()
        scheduler_service.schedule_consolidation_job()
        from routers.updates import schedule_addon_check
        from core.backup.schedule import schedule_backup_job

        schedule_addon_check()
        schedule_backup_job()
        log_line("success", "⏰", "SCHEDULER", "Service started.")
    except Exception as exc:
        log_line("error", "❌", "SCHEDULER", f"Failed: {exc}")
        report_subsystem("scheduler", "degraded", message=str(exc))


async def startup_entity_store() -> None:
    try:
        entity_store = get_entity_store()
        await entity_store.initialize_schema()
        log_line("success", "🔄", "ENTITIES", "Entity store initialized.")
    except Exception as exc:
        log_line("error", "❌", "ENTITIES", f"Failed to initialize entity store: {exc}")
        report_subsystem("entities", "fatal", message=str(exc))


async def startup_integrations(mark_startup_task_done) -> None:
    try:
        from integrations import get_integration_manager
        from core.entity_store import get_entity_store as entity_store

        try:
            from components.sun.entity import ensure_default_entry as sun_default

            sun_default()
        except Exception as exc:
            log_line("error", "⚠️", "SUN", f"auto-entry failed: {exc}")
            report_subsystem("sun", "degraded", message=str(exc))

        try:
            from integrations.config_entries import migrate_from_cfg

            manager = get_integration_manager()
            migrated = migrate_from_cfg(settings.CFG, manager.classes().keys())
            if migrated:
                manager.reload()
                log_line(
                    "success",
                    "🔐",
                    "INTEGRATIONS",
                    f"Migrated {migrated} legacy config.json section(s) to config entries",
                )
        except Exception as exc:
            log_line("error", "⚠️", "INTEGRATIONS", f"Legacy config migration failed: {exc}")
            report_subsystem("integrations", "degraded", message=str(exc))

        async def _bootstrap_integrations_background():
            await asyncio.sleep(1)

            def _boot_log(level, key, msg):
                if level == "success":
                    emoji, log_level = "🔄", "success"
                elif level == "deferred":
                    emoji, log_level = "⏳", "sys"
                else:
                    emoji = "⚠️"
                    log_level = level if level in ("success", "error") else "sys"
                log_line(log_level, emoji, "INTEGRATIONS", f"{key}: {msg}")

            try:
                await get_integration_manager().bootstrap_store(
                    entity_store(), run_initial_sync=True, logger=_boot_log
                )
            except Exception as exc:
                log_line("error", "⚠️", "INTEGRATIONS", f"Bootstrap failed: {exc}")
                report_subsystem("integrations", "degraded", message=str(exc))
            finally:
                mark_startup_task_done("integrations")

        asyncio.create_task(_bootstrap_integrations_background(), name="integration-bootstrap")
    except Exception as exc:
        log_line("error", "⚠️", "INTEGRATIONS", f"Bootstrap failed: {exc}")
        report_subsystem("integrations", "degraded", message=str(exc))
        mark_startup_task_done("integrations")


async def startup_mqtt_bridges() -> None:
    """Run integration ``startup_all`` lifecycle hooks (MQTT bridges, etc.)."""
    try:
        from integrations import lifecycle as integration_lifecycle

        await integration_lifecycle.run_startup_hooks()
    except Exception as exc:
        log_line("error", "⚠️", "INTEGRATION LIFECYCLE", f"Startup hooks failed: {exc}")
        report_subsystem("integration_lifecycle", "degraded", message=str(exc))


async def startup_intelligence(mark_startup_task_done) -> None:
    try:
        from brain.cortex import warmup_llm_cache

        asyncio.create_task(warmup_llm_cache())
    except Exception as exc:
        log_line("error", "⚠️", "WARMUP", f"Failed to schedule: {exc}")

    try:
        from addons.process_manager import auto_start_watchdog_addons, start_watchdog

        async def _start_addon_watchdog_background():
            await asyncio.sleep(1)
            try:
                await auto_start_watchdog_addons()
                await start_watchdog()
            except Exception as exc:
                log_line("error", "⚠️", "WATCHDOG", f"Failed to start: {exc}")
                report_subsystem("addons", "degraded", message=str(exc))
            finally:
                mark_startup_task_done("addons")

        asyncio.create_task(_start_addon_watchdog_background(), name="addon-watchdog-startup")
    except Exception as exc:
        log_line("error", "⚠️", "WATCHDOG", f"Failed to start: {exc}")
        report_subsystem("addons", "degraded", message=str(exc))
        mark_startup_task_done("addons")

    try:
        from core.entity_history import start_history_recorder

        start_history_recorder()
    except Exception as exc:
        log_line("error", "⚠️", "HISTORY", f"Failed to start: {exc}")
        report_subsystem("history", "degraded", message=str(exc))

    try:
        from core import state_observer
        from core.entity_mirror import get_entity_mirror
        from core.entity_mirror_wiring import wire_entity_mirror_targets

        wire_entity_mirror_targets()
        get_entity_mirror().start()
        state_observer.start()
        log_line("success", "📡", "ENTITY MIRROR", "shared snapshot loop started")
    except Exception as exc:
        log_line("error", "⚠️", "ENTITY MIRROR", f"Failed to start: {exc}")
        report_subsystem("entity_mirror", "degraded", message=str(exc))

async def startup_maintenance_tasks() -> None:
    async def _run_startup_db_maintenance():
        await asyncio.sleep(1)
        try:
            db = next(database.get_db())
            try:
                from core.auth import cleanup_expired_revocations

                removed = cleanup_expired_revocations(db)
                if removed:
                    log_line("sys", "🧹", "AUTH", f"Cleaned {removed} expired revoked tokens")
            finally:
                db.close()
        except Exception as exc:
            log_line("error", "⚠️", "AUTH", str(exc))
            report_subsystem("auth", "degraded", message=str(exc))

    asyncio.create_task(_run_startup_db_maintenance(), name="startup-db-maintenance")

    try:
        from core.i18n.bundles import warm_cache as warm_i18n_bundles

        warm_i18n_bundles()
        from integrations.component_i18n import warm_cache

        warm_cache()
    except Exception as exc:
        log_line("error", "⚠️", "I18N", f"component translations preload failed: {exc}")
        report_subsystem("i18n", "degraded", message=str(exc))

    async def _warm_memory_storage():
        try:
            await asyncio.to_thread(storage.get_collection)
            log_line("success", "🧠", "MEMORY", "Chroma collection ready.")
        except Exception as exc:
            log_line("error", "⚠️", "MEMORY", f"Chroma warm-up failed: {exc}")
            report_subsystem("memory", "degraded", message=str(exc))

    asyncio.create_task(_warm_memory_storage(), name="warm-chroma")


async def shutdown_services(app) -> None:
    scheduler_service.stop_scheduler()
    try:
        from core.loop_watchdog import stop_loop_watchdog

        await stop_loop_watchdog()
    except Exception:
        pass
    try:
        from core import state_observer

        state_observer.stop()
    except Exception:
        pass
    try:
        from core.entity_mirror import get_entity_mirror

        await get_entity_mirror().stop()
    except Exception:
        pass
    if getattr(app.state, "http_client", None) is not None:
        await app.state.http_client.aclose()
    try:
        from brain.llm_client import close_llm_client

        await close_llm_client()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"close_llm_client: {exc}")
    try:
        get_entity_store().stop_all_sync_loops()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"entity_store.stop_all: {exc}")
    try:
        from core.entity_history import stop_history_recorder

        await stop_history_recorder()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"history.stop: {exc}")
    try:
        from integrations import lifecycle as integration_lifecycle

        await integration_lifecycle.run_shutdown_hooks()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"integration lifecycle shutdown: {exc}")
    try:
        from addons.process_manager import stop_all

        await stop_all()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"process_manager.stop_all: {exc}")
    try:
        storage.shutdown_storage()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"storage.shutdown_storage: {exc}")
