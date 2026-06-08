"""Startup and shutdown phase helpers for the FastAPI lifespan."""

from __future__ import annotations

import asyncio

import httpx

import database
import scheduler_service
import settings
import storage
from addons.entity_store import get_entity_store
from core.log_stream import log_line, print_banner


async def startup_infrastructure(app) -> None:
    print_banner()
    timeout = float(settings.CFG.get("llm", {}).get("timeout") or 120)
    app.state.http_client = httpx.AsyncClient(timeout=timeout)

    try:
        from core.loop_watchdog import start_loop_watchdog

        start_loop_watchdog(threshold_seconds=2.0, poll_seconds=0.25, dump_cooldown=30.0)
    except Exception as exc:
        log_line("error", "⚠️", "WATCHDOG", f"loop watchdog failed to start: {exc}")


async def startup_scheduler() -> None:
    try:
        scheduler_service.start_scheduler()
        scheduler_service.schedule_consolidation_job()
        log_line("success", "⏰", "SCHEDULER", "Service started.")
    except Exception as exc:
        log_line("error", "❌", "SCHEDULER", f"Failed: {exc}")


async def startup_entity_store() -> None:
    try:
        entity_store = get_entity_store()
        await entity_store.initialize_schema()
        log_line("success", "🔄", "ENTITIES", "Entity store initialized.")
    except Exception as exc:
        log_line("error", "❌", "ENTITIES", f"Failed to initialize entity store: {exc}")


async def startup_integrations(mark_startup_task_done) -> None:
    try:
        from integrations import get_integration_manager
        from addons.entity_store import get_entity_store as entity_store

        try:
            from components.sun.entity import ensure_default_entry as sun_default

            sun_default()
        except Exception as exc:
            log_line("error", "⚠️", "SUN", f"auto-entry failed: {exc}")

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
            finally:
                mark_startup_task_done("integrations")

        asyncio.create_task(_bootstrap_integrations_background(), name="integration-bootstrap")
    except Exception as exc:
        log_line("error", "⚠️", "INTEGRATIONS", f"Bootstrap failed: {exc}")
        mark_startup_task_done("integrations")


async def startup_mqtt_bridges() -> None:
    try:
        from integrations import get_integration_manager
        from components.mosquitto import bridge as mosquitto_bridge

        for inst in get_integration_manager().entries_for("mosquitto"):
            section = inst.config_section(settings.CFG)
            host = (section.get("host") or "").strip() or "localhost"
            try:
                await asyncio.wait_for(
                    mosquitto_bridge.start_bridge({**section, "host": host}, key=inst.entry_id),
                    timeout=5.0,
                )
                log_line("success", "📡", "MQTT BRIDGE", f"connected to {host}:{section.get('port', 1883)}")
            except asyncio.TimeoutError:
                log_line("error", "⚠️", "MQTT BRIDGE", f"{host}: setup timed out; continuing without this bridge")
    except Exception as exc:
        log_line("error", "⚠️", "MQTT BRIDGE", f"Setup failed: {exc}")


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
            finally:
                mark_startup_task_done("addons")

        asyncio.create_task(_start_addon_watchdog_background(), name="addon-watchdog-startup")
    except Exception as exc:
        log_line("error", "⚠️", "WATCHDOG", f"Failed to start: {exc}")
        mark_startup_task_done("addons")

    try:
        from core.entity_history import start_history_recorder

        start_history_recorder()
    except Exception as exc:
        log_line("error", "⚠️", "HISTORY", f"Failed to start: {exc}")

    try:
        from core import state_observer

        state_observer.start()
        log_line("success", "📡", "STATE BUS", "observer started")
    except Exception as exc:
        log_line("error", "⚠️", "STATE BUS", f"Failed to start: {exc}")

    try:
        from brain.ambient import init_ambient, is_enabled as ambient_enabled

        if ambient_enabled():
            init_ambient(asyncio.get_event_loop())
    except Exception as exc:
        log_line("error", "⚠️", "AMBIENT", f"Failed to start: {exc}")

    try:
        from brain.briefings import is_enabled as briefings_enabled, schedule_briefings

        if briefings_enabled():
            schedule_briefings()
    except Exception as exc:
        log_line("error", "⚠️", "BRIEFINGS", f"Failed to schedule: {exc}")

    try:
        from brain.pattern_detector import init_pattern_detector

        init_pattern_detector()
    except Exception as exc:
        log_line("error", "⚠️", "PATTERNS", f"Failed to start: {exc}")


async def startup_maintenance_tasks() -> None:
    async def _run_startup_db_maintenance():
        await asyncio.sleep(1)
        try:
            db = next(database.get_db())
            try:
                from auth import cleanup_expired_revocations

                removed = cleanup_expired_revocations(db)
                if removed:
                    log_line("sys", "🧹", "AUTH", f"Cleaned {removed} expired revoked tokens")
            finally:
                db.close()
        except Exception as exc:
            log_line("error", "⚠️", "AUTH", str(exc))

    asyncio.create_task(_run_startup_db_maintenance(), name="startup-db-maintenance")

    try:
        from integrations.component_i18n import warm_cache

        warm_cache()
    except Exception as exc:
        log_line("error", "⚠️", "I18N", f"component translations preload failed: {exc}")

    async def _warm_memory_storage():
        try:
            await asyncio.to_thread(storage.get_collection)
            log_line("success", "🧠", "MEMORY", "Chroma collection ready.")
        except Exception as exc:
            log_line("error", "⚠️", "MEMORY", f"Chroma warm-up failed: {exc}")

    asyncio.create_task(_warm_memory_storage(), name="warm-chroma")


async def shutdown_services(app) -> None:
    scheduler_service.stop_scheduler()
    try:
        from core.loop_watchdog import stop_loop_watchdog

        await stop_loop_watchdog()
    except Exception:
        pass
    try:
        from brain.ambient import shutdown_ambient

        shutdown_ambient()
    except Exception:
        pass
    try:
        from core import state_observer

        state_observer.stop()
    except Exception:
        pass
    if getattr(app.state, "http_client", None) is not None:
        await app.state.http_client.aclose()
    try:
        from llm_client import close_llm_client

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
        from components.mosquitto import bridge as mosquitto_bridge

        await mosquitto_bridge.stop_bridge()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"mosquitto_bridge.stop: {exc}")
    try:
        from addons.process_manager import stop_all

        await stop_all()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"process_manager.stop_all: {exc}")
    try:
        storage.shutdown_storage()
    except Exception as exc:
        log_line("error", "⚠️", "SHUTDOWN", f"storage.shutdown_storage: {exc}")
