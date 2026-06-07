from __future__ import annotations

import asyncio
import time

from logger import log_detail, log_line

from brain.ambient import config, constants, cycle, learning, runtime, triggers

from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled
from brain.ambient.cycle import _dispatch_decision, _primary_admin, run_ambient_cycle, run_test
from brain.ambient.learning import _propose_automation, _record_acceptance, act_on_suggestion
from brain.ambient.runtime import _load_state, _save_state
from brain.ambient.triggers import _enqueue, _on_state_event

def _checkin_job(kind: str) -> None:
    """APScheduler thread callback → push a check-in trigger to the worker."""
    if not is_enabled():
        return
    _enqueue({"type": "checkin", "kind": kind, "at": time.time()})

async def _scan_loop() -> None:
    """Periodic home scan — catches *duration* situations (light left on for an
    hour, door open too long) that never re-fire as events. Cheap: skipped
    entirely unless something has been running long (see run_ambient_cycle)."""
    log_line("ambient", "🔁", "AMBIENT", "scan loop started")
    while True:
        try:
            interval = max(2, int(_cfg().get("scan_interval_min", 15) or 15))
            await asyncio.sleep(interval * 60)
            if is_enabled():
                _enqueue({"type": "scan", "at": time.time()})
        except asyncio.CancelledError:
            log_line("ambient", "🔁", "AMBIENT", "scan loop stopped")
            break
        except Exception as exc:
            log_detail("ambient", "SCAN_LOOP_ERR", error=str(exc))
            await asyncio.sleep(60)

def _apply_subscription() -> None:
    """Subscribe to state events only while enabled, so the state observer does
    not compute diffs for us when ambient is off."""
    try:
        from core import event_bus, state_observer
    except Exception:
        return
    want = is_enabled()
    if want and not runtime._subscribed:
        event_bus.subscribe(state_observer.TOPIC_STATE_CHANGED, "ambient:state", _on_state_event)
        runtime._subscribed = True
    elif not want and runtime._subscribed:
        event_bus.unsubscribe(state_observer.TOPIC_STATE_CHANGED, "ambient:state")
        runtime._subscribed = False

def reschedule_checkins() -> None:
    """(Re)register APScheduler cron jobs for ambient check-ins based on config."""
    try:
        from scheduler_service import scheduler
    except Exception as exc:
        log_detail("ambient", "SCHED_IMPORT_ERR", error=str(exc))
        return

    # Clear existing ambient jobs.
    # Re-evaluate the event subscription whenever config changes.
    _apply_subscription()

    for job in list(scheduler.get_jobs()):
        if job.id and job.id.startswith(constants.CHECKIN_JOB_PREFIX):
            try:
                scheduler.remove_job(job.id)
            except Exception:
                pass

    if not is_enabled():
        return

    plan = str(_cfg().get("checkin", "off")).lower()
    specs: list[tuple[str, dict]] = []
    if plan == "hourly":
        specs.append(("hourly", {"trigger": "cron", "minute": 0}))
    if plan in {"morning", "morning_evening"}:
        specs.append(("morning", {"trigger": "cron", "hour": 8, "minute": 0}))
    if plan in {"evening", "morning_evening"}:
        specs.append(("evening", {"trigger": "cron", "hour": 21, "minute": 0}))

    for kind, kw in specs:
        try:
            scheduler.add_job(
                _checkin_job, kwargs={"kind": kind},
                id=f"{constants.CHECKIN_JOB_PREFIX}{kind}", replace_existing=True, **kw,
            )
        except Exception as exc:
            log_detail("ambient", "SCHED_ADD_ERR", kind=kind, error=str(exc))
    if specs:
        log_line("ambient", "⏰", "AMBIENT", f"check-ins scheduled: {', '.join(k for k, _ in specs)}")

def init_ambient(loop: asyncio.AbstractEventLoop) -> None:
    """Called once at startup from the main event loop."""
    if runtime._started:
        return
    runtime._started = True
    runtime._loop = loop
    runtime._queue = asyncio.Queue()
    _load_state()

    _apply_subscription()

    runtime._worker = loop.create_task(_run_worker_router())
    runtime._scan_task = loop.create_task(_scan_loop())
    reschedule_checkins()
    log_line("success", "🧠", "AMBIENT", f"brain initialised (mode={_mode()}, enabled={is_enabled()})")

async def _run_worker_router() -> None:
    """Top-level worker: routes queue items to the right coroutine."""
    assert runtime._queue is not None
    log_line("ambient", "🧠", "AMBIENT", "worker started")
    while True:
        try:
            trigger = await runtime._queue.get()
        except asyncio.CancelledError:
            log_line("ambient", "🧠", "AMBIENT", "worker stopped")
            break

        kind = trigger.get("type")
        if kind == "propose_automation":
            try:
                await _propose_automation(trigger.get("pattern_key", ""), int(trigger.get("user_id")))
            except Exception as exc:
                log_detail("ambient", "PROPOSE_ERR", error=str(exc))
            continue

        # Aggregate a burst of events into a single reasoning cycle.
        batch = [trigger]
        debounce = float(_cfg().get("event_debounce_s", 8) or 0)
        if kind == "event" and debounce > 0:
            deadline = time.monotonic() + debounce
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    nxt = await asyncio.wait_for(runtime._queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                except asyncio.CancelledError:
                    return
                if nxt.get("type") == "propose_automation":
                    # don't lose it — handle after the batch
                    _enqueue(nxt)
                    break
                batch.append(nxt)

        try:
            await run_ambient_cycle(batch)
        except Exception as exc:
            log_detail("ambient", "CYCLE_ERR", error=str(exc))

def shutdown_ambient() -> None:
    try:
        from core import event_bus, state_observer
        event_bus.unsubscribe(state_observer.TOPIC_STATE_CHANGED, "ambient:state")
        runtime._subscribed = False
    except Exception:
        pass
    if runtime._worker is not None:
        runtime._worker.cancel()
        runtime._worker = None
    if runtime._scan_task is not None:
        runtime._scan_task.cancel()
        runtime._scan_task = None
    runtime._started = False

