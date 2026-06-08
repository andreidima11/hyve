"""FastAPI startup / shutdown lifecycle."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from core.http.runtime import set_main_loop
from core.http.startup_phases import (
    shutdown_services,
    startup_entity_store,
    startup_infrastructure,
    startup_integrations,
    startup_intelligence,
    startup_maintenance_tasks,
    startup_mqtt_bridges,
    startup_scheduler,
)


@asynccontextmanager
async def lifespan(app):
    """Startup / shutdown lifecycle for the FastAPI app."""
    from core.startup_status import mark_startup_task_done, reset_startup_status, set_startup_core_ready

    reset_startup_status()
    set_main_loop(asyncio.get_event_loop())

    await startup_infrastructure(app)
    await startup_scheduler()
    await startup_entity_store()
    await startup_integrations(mark_startup_task_done)
    await startup_mqtt_bridges()
    await startup_intelligence(mark_startup_task_done)
    await startup_maintenance_tasks()
    set_startup_core_ready()

    yield

    await shutdown_services(app)
    set_main_loop(None)
