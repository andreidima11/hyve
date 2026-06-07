"""Trigger compilation + APScheduler / event-bus wiring.

Owns the side of the engine that decides *when* an automation runs:
- Schedules cron / one-shot / interval jobs in APScheduler.
- Subscribes to the event bus for state / numeric_state / template / event
  triggers.
- Computes next sunrise / sunset and re-arms after each fire.
- Translates HA-style `time_pattern` fields to APScheduler cron syntax.

The actual execution callback (`execute_automation_definition`) lives in
`automation_definitions` and is imported lazily inside the dispatch
functions to avoid a circular import.

Re-exported from `automation_definitions` under the original underscore-
prefixed names so existing call sites keep working unchanged.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

import database
import models
from core import event_bus
from logger import log_detail

import scheduler_service

from .validators import _parse_datetime_string, _parse_time_string

RUNTIME_PREFIX = "autdef_"


def _execute() -> "callable":
    """Lazy lookup of the executor entry point (defined in the legacy module)
    so we don't introduce a circular import at module load time."""
    from automation_definitions import execute_automation_definition
    return execute_automation_definition


def _runtime_job_id(definition_id: str, trigger_index: int) -> str:
    return f"{RUNTIME_PREFIX}{definition_id}_{trigger_index}"


def list_definition_runtime_jobs(definition_id: str) -> list[dict]:
    prefix = f"{RUNTIME_PREFIX}{definition_id}_"
    jobs: list[dict] = []
    try:
        for job in scheduler_service.scheduler.get_jobs():
            if not str(job.id).startswith(prefix):
                continue
            jobs.append({
                "job_id": str(job.id),
                "next_run_at": job.next_run_time.isoformat() if getattr(job, "next_run_time", None) else None,
            })
    except Exception as exc:
        log_detail("automation", "RUNTIME_LIST_ERROR", automation_id=definition_id, error=str(exc))
    jobs.sort(key=lambda item: item.get("next_run_at") or "")
    return jobs


def _remove_runtime_jobs(definition_id: str):
    prefix = f"{RUNTIME_PREFIX}{definition_id}_"
    # Remove APScheduler jobs
    for job in list(getattr(scheduler_service.scheduler, "get_jobs", lambda: [])()):
        if str(getattr(job, "id", "")).startswith(prefix):
            try:
                scheduler_service.scheduler.remove_job(str(job.id))
            except Exception as exc:
                log_detail("automation", "RUNTIME_REMOVE_ERROR", automation_id=definition_id, job_id=str(job.id), error=str(exc))
    # Drop any event-bus subscriptions registered for this definition.
    event_bus.unsubscribe_prefix(f"automation:{definition_id}:")


def _hash_triggers(triggers: list[dict]) -> str:
    return hashlib.sha256(json.dumps(triggers, sort_keys=True).encode("utf-8")).hexdigest()


def _schedule_trigger(definition_id: str, trigger_index: int, trigger: dict):
    job_id = _runtime_job_id(definition_id, trigger_index)
    platform = trigger.get("platform")
    execute_automation_definition = _execute()
    if platform == "time":
        hour, minute = _parse_time_string(trigger.get("at"))
        kwargs = {
            "hour": hour,
            "minute": minute,
            "id": job_id,
            "replace_existing": True,
            "args": [definition_id, f"trigger:{trigger_index}"],
        }
        if trigger.get("weekdays"):
            kwargs["day_of_week"] = ",".join(day[:3] for day in trigger.get("weekdays") or [])
        scheduler_service.scheduler.add_job(execute_automation_definition, "cron", **kwargs)
        return
    if platform == "datetime":
        run_at = _parse_datetime_string(trigger.get("at"))
        if run_at.tzinfo:
            run_at = scheduler_service._to_naive_local(run_at)
        scheduler_service.scheduler.add_job(
            execute_automation_definition,
            "date",
            run_date=run_at,
            id=job_id,
            replace_existing=True,
            args=[definition_id, f"trigger:{trigger_index}"],
        )
        return
    if platform == "interval":
        kwargs = {
            "minutes": int(trigger.get("every_minutes")),
            "id": job_id,
            "replace_existing": True,
            "args": [definition_id, f"trigger:{trigger_index}"],
        }
        if trigger.get("start_at"):
            start_at = _parse_datetime_string(trigger.get("start_at"))
            if start_at.tzinfo:
                start_at = scheduler_service._to_naive_local(start_at)
            kwargs["start_date"] = start_at
        scheduler_service.scheduler.add_job(execute_automation_definition, "interval", **kwargs)
        return
    if platform in ("state", "numeric_state"):
        _subscribe_state_trigger(definition_id, trigger_index, trigger)
        return
    if platform == "template":
        _subscribe_template_trigger(definition_id, trigger_index, trigger)
        return
    if platform == "sun":
        _schedule_sun_trigger(definition_id, trigger_index, trigger)
        return
    if platform == "time_pattern":
        _schedule_time_pattern_trigger(definition_id, trigger_index, trigger)
        return
    if platform == "event":
        _subscribe_event_trigger(definition_id, trigger_index, trigger)
        return


def _bus_handler_id(definition_id: str, trigger_index: int) -> str:
    return f"automation:{definition_id}:{trigger_index}"


def _subscribe_state_trigger(definition_id: str, trigger_index: int, trigger: dict) -> None:
    """Register an event-bus handler that fires the automation when the
    target entity transitions in a way that matches the trigger spec."""
    from core.state_observer import TOPIC_STATE_CHANGED, TOPIC_MQTT_ACTION
    target_entity = trigger.get("entity_id")
    platform = trigger.get("platform")
    handler_id = _bus_handler_id(definition_id, trigger_index)

    def _fire() -> None:
        import threading as _th
        try:
            _th.Thread(
                target=_execute(),
                args=(definition_id, f"trigger:{trigger_index}"),
                daemon=True,
            ).start()
        except Exception as exc:
            log_detail("automation", "BUS_DISPATCH_ERROR", automation_id=definition_id, error=str(exc))

    def _handle(payload: dict) -> None:
        if payload.get("entity_id") != target_entity:
            return
        if platform == "state":
            old = str(payload.get("old_state") or "").strip().lower()
            new = str(payload.get("new_state") or "").strip().lower()
            want_from = (trigger.get("from") or "").strip().lower()
            want_to = (trigger.get("to") or "").strip().lower()
            if want_from and old != want_from:
                return
            if want_to and new != want_to:
                return
        elif platform == "numeric_state":
            attr = trigger.get("attribute")
            new_entity = payload.get("new") or {}
            if attr:
                raw_new = (new_entity.get("attributes") or {}).get(attr)
                old_entity = payload.get("old") or {}
                raw_old = (old_entity.get("attributes") or {}).get(attr)
            else:
                raw_new = payload.get("new_state")
                raw_old = payload.get("old_state")
            try:
                new_val = float(str(raw_new).strip())
            except (TypeError, ValueError):
                return
            try:
                old_val = float(str(raw_old).strip())
            except (TypeError, ValueError):
                old_val = None
            above = trigger.get("above")
            below = trigger.get("below")

            def _in_range(v: float | None) -> bool | None:
                if v is None:
                    return None
                if above is not None and not (v > above):
                    return False
                if below is not None and not (v < below):
                    return False
                return True

            new_in = _in_range(new_val)
            old_in = _in_range(old_val)
            if not new_in or old_in is True:
                return
        _fire()

    event_bus.subscribe(TOPIC_STATE_CHANGED, handler_id, _handle)

    # For action-based triggers (remotes), also subscribe to MQTT action
    # events.  These fire on EVERY button press including same-value
    # repeats, bypassing edge detection — critical for remotes.
    if platform == "state" and target_entity and "action" in target_entity:
        action_handler_id = f"{handler_id}:action"
        want_to = (trigger.get("to") or "").strip().lower()

        def _handle_action(payload: dict) -> None:
            if payload.get("entity_id") != target_entity:
                return
            action_val = str(payload.get("action") or "").strip().lower()
            if want_to and action_val != want_to:
                return
            _fire()

        event_bus.subscribe(TOPIC_MQTT_ACTION, action_handler_id, _handle_action)


def _subscribe_template_trigger(definition_id: str, trigger_index: int, trigger: dict) -> None:
    """Re-evaluate ``value_template`` on every state change. Fire when the
    result transitions from falsy to truthy (edge trigger), so the automation
    doesn't refire while the condition stays True."""
    from core.state_observer import TOPIC_STATE_CHANGED
    from core import automation_template
    handler_id = _bus_handler_id(definition_id, trigger_index)
    template_str = trigger.get("value_template") or ""
    state_box = {"last": False}

    def _handle(payload: dict) -> None:
        try:
            snapshot = list((payload.get("new") or {}).get("__bus_snapshot__") or [])
        except Exception:
            snapshot = []
        if not snapshot:
            try:
                from core.state_observer import _last_snapshot
                snapshot = list(_last_snapshot.values())
            except Exception:
                snapshot = []
        try:
            now_truthy = automation_template.render_bool(
                template_str,
                snapshot=snapshot,
                extra={"trigger": payload},
            )
        except Exception as exc:
            log_detail("automation", "TEMPLATE_TRIGGER_ERROR",
                       automation_id=definition_id, error=str(exc))
            return
        if now_truthy and not state_box["last"]:
            try:
                scheduler_service.scheduler.add_job(
                    _execute(),
                    "date",
                    args=[definition_id, f"trigger:{trigger_index}"],
                    id=f"_evt_{definition_id}_{trigger_index}_{datetime.now().timestamp()}",
                )
            except Exception as exc:
                log_detail("automation", "BUS_DISPATCH_ERROR",
                           automation_id=definition_id, error=str(exc))
        state_box["last"] = now_truthy

    event_bus.subscribe(TOPIC_STATE_CHANGED, handler_id, _handle)


def _schedule_sun_trigger(definition_id: str, trigger_index: int, trigger: dict) -> None:
    """Schedule a one-shot APScheduler job for the next sunrise/sunset
    (with optional offset). On firing, dispatch the automation and
    automatically re-arm for the next occurrence."""
    from datetime import timezone as _tz
    job_id = _runtime_job_id(definition_id, trigger_index)
    event = trigger.get("event")
    offset = float(trigger.get("offset") or 0.0)

    def _arm():
        try:
            from integrations import config_entries as _ce
            from integrations.providers.sun import _find_next_event
            entries = _ce.list_entries("sun")
            if not entries:
                log_detail("automation", "SUN_TRIGGER_NO_ENTRY", automation_id=definition_id)
                return
            data = entries[0].get("data") or {}
            lat = float(data.get("latitude"))
            lon = float(data.get("longitude"))
        except Exception as exc:
            log_detail("automation", "SUN_TRIGGER_CONFIG_ERROR",
                       automation_id=definition_id, error=str(exc))
            return
        now_utc = datetime.now(_tz.utc)
        rising = (event == "sunrise")
        nxt = _find_next_event(now_utc, lat, lon, -0.833, rising=rising)
        if nxt is None:
            log_detail("automation", "SUN_TRIGGER_NO_EVENT",
                       automation_id=definition_id, event=event)
            return
        run_at = nxt + timedelta(seconds=offset)
        if run_at.tzinfo:
            run_at = scheduler_service._to_naive_local(run_at.astimezone())
        scheduler_service.scheduler.add_job(
            _fire_and_rearm_sun,
            "date",
            run_date=run_at,
            id=job_id,
            replace_existing=True,
            args=[definition_id, trigger_index, trigger],
        )

    _arm()


def _fire_and_rearm_sun(definition_id: str, trigger_index: int, trigger: dict):
    try:
        _execute()(definition_id, f"trigger:{trigger_index}")
    finally:
        try:
            _schedule_sun_trigger(definition_id, trigger_index, trigger)
        except Exception as exc:
            log_detail("automation", "SUN_REARM_ERROR",
                       automation_id=definition_id, error=str(exc))


def _normalize_cron_field(value) -> str:
    """Translate HA-style time_pattern fields to APScheduler cron syntax.
    ``"*"`` → ``"*"``, ``"/15"`` → ``"*/15"``, ``"5"`` → ``"5"``."""
    sval = str(value).strip()
    if not sval or sval == "*":
        return "*"
    if sval.startswith("/"):
        return f"*{sval}"
    return sval


def _schedule_time_pattern_trigger(definition_id: str, trigger_index: int, trigger: dict) -> None:
    job_id = _runtime_job_id(definition_id, trigger_index)
    rename = {"hours": "hour", "minutes": "minute", "seconds": "second"}
    cron_kwargs: dict[str, str] = {}
    for key, target in rename.items():
        if key in trigger:
            cron_kwargs[target] = _normalize_cron_field(trigger[key])
    scheduler_service.scheduler.add_job(
        _execute(),
        "cron",
        id=job_id,
        replace_existing=True,
        args=[definition_id, f"trigger:{trigger_index}"],
        **cron_kwargs,
    )


def _subscribe_event_trigger(definition_id: str, trigger_index: int, trigger: dict) -> None:
    """Listen on the event bus for arbitrary events. Match optional
    ``event_data`` keys against the payload."""
    handler_id = _bus_handler_id(definition_id, trigger_index)
    event_type = trigger.get("event_type")
    expected = trigger.get("event_data") or {}

    def _handle(payload: dict) -> None:
        if expected and isinstance(payload, dict):
            for k, v in expected.items():
                if payload.get(k) != v:
                    return
        try:
            scheduler_service.scheduler.add_job(
                _execute(),
                "date",
                args=[definition_id, f"trigger:{trigger_index}"],
                id=f"_evt_{definition_id}_{trigger_index}_{datetime.now().timestamp()}",
            )
        except Exception as exc:
            log_detail("automation", "BUS_DISPATCH_ERROR",
                       automation_id=definition_id, error=str(exc))

    event_bus.subscribe(event_type, handler_id, _handle)


def sync_runtime(definition: models.AutomationDefinition, db: Session | None = None):
    own_session = False
    if db is None:
        db = database.SessionLocal()
        own_session = True
    try:
        try:
            normalized = json.loads(definition.normalized_json)
        except (json.JSONDecodeError, TypeError):
            log.error("Corrupt normalized_json for automation %s — skipping sync", definition.id)
            return
        _remove_runtime_jobs(definition.id)
        definition.trigger_hash = _hash_triggers(normalized.get("trigger") or [])
        definition.last_compiled_at = datetime.now()
        if definition.enabled:
            for index, trigger in enumerate(normalized.get("trigger") or []):
                _schedule_trigger(definition.id, index, trigger)
        db.add(definition)
        db.commit()
        db.refresh(definition)
    finally:
        if own_session:
            db.close()
