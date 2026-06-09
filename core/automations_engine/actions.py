"""Automation runner — condition evaluation + action execution.

This is the runtime executor. It decides WHAT happens when an automation
fires (the WHEN lives in ``runtime.py``). All public names are re-exported
from ``automation_definitions`` under their original underscore-prefixed
names for backwards compatibility.

Currently still synchronous — uses ``time.sleep`` for delay/wait_template.
Async-first conversion (``await asyncio.sleep``) is a follow-up that needs
coordinated changes in ``scheduler_service.py`` callers.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time as _time_mod
import uuid
from datetime import datetime
from typing import Any

import database
import models
import scheduler_service
import settings
import skills
from logger import log_detail, log_line

from core.automations_engine.runtime import _remove_runtime_jobs
from core.automations_engine.trace import (
    trace_begin as _trace_begin,
    trace_end as _trace_end,
    trace_step as _trace_step,
)
from core.automations_engine.validators import AutomationValidationError


def _current_time_for_window() -> str:
    now = datetime.now()
    return now.strftime("%H:%M")


def _lookup_entity(entity_id: str) -> dict | None:
    """Return the current snapshot for ``entity_id``.

    Tries the state observer's in-memory snapshot first (instant, no I/O).
    Falls back to the full entity builder only when the snapshot miss.
    """
    # Fast path: state observer already has a pre-built snapshot.
    try:
        from integrations.entity_utils import resolve_entity_by_id
        from core.state_observer import _last_snapshot
        hit = resolve_entity_by_id(entity_id, list(_last_snapshot.values()))
        if hit:
            return hit
    except Exception:
        pass
    # Slow path: rebuild full entity list.
    try:
        from routers.dashboard import _available_entities

        async def _fetch():
            return await _available_entities()

        items = _run_async_in_thread(_fetch)
    except Exception as exc:
        log_detail("automation", "ENTITY_LOOKUP_ERROR", entity_id=entity_id, error=str(exc))
        return None
    for item in items:
        hit = resolve_entity_by_id(entity_id, items)
        if hit:
            return hit
    return None


def _entity_numeric_value(entity: dict, attribute: str | None) -> float | None:
    if attribute:
        attrs = entity.get("attributes") or {}
        raw = attrs.get(attribute)
    else:
        raw = entity.get("state")
    if raw is None:
        return None
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return None


def _evaluate_conditions(conditions: list[dict]) -> tuple[bool, str | None]:
    for condition in conditions:
        kind = condition.get("kind")
        if kind == "time_window":
            now_val = _current_time_for_window()
            after = condition.get("after")
            before = condition.get("before")
            if after and now_val < after:
                return False, f"Current time {now_val} is before {after}"
            if before and now_val > before:
                return False, f"Current time {now_val} is after {before}"
        elif kind == "state":
            entity_id = condition.get("entity_id")
            entity = _lookup_entity(entity_id)
            if entity is None:
                return False, f"Entity '{entity_id}' not found"
            current = str(entity.get("state") or "").strip()
            expected = str(condition.get("state") or "").strip()
            op = condition.get("operator") or "=="
            equal = current.lower() == expected.lower()
            if op == "==" and not equal:
                return False, f"{entity_id} is '{current}', expected '{expected}'"
            if op == "!=" and equal:
                return False, f"{entity_id} is '{current}' (must not equal)"
        elif kind == "numeric_state":
            entity_id = condition.get("entity_id")
            entity = _lookup_entity(entity_id)
            if entity is None:
                return False, f"Entity '{entity_id}' not found"
            value = _entity_numeric_value(entity, condition.get("attribute"))
            if value is None:
                return False, f"{entity_id} has no numeric value"
            above = condition.get("above")
            below = condition.get("below")
            if above is not None and not (value > above):
                return False, f"{entity_id}={value} is not above {above}"
            if below is not None and not (value < below):
                return False, f"{entity_id}={value} is not below {below}"
        elif kind == "template":
            from core import automation_template
            try:
                from core.state_observer import _last_snapshot
                snapshot = list(_last_snapshot.values())
            except Exception:
                snapshot = []
            try:
                ok = automation_template.render_bool(condition.get("template") or "", snapshot=snapshot)
            except Exception as exc:
                return False, f"template error: {exc}"
            if not ok:
                return False, "template evaluated false"
    return True, None


def _run_async_in_thread(coro_factory, *, timeout: float = 45.0):
    """Run an async coroutine from a sync worker thread on Hyve's main loop.

    Uses the same bridge as dashboard control and the legacy scheduler so
    integration clients (OAuth sessions, MQTT, aiohttp) are not spun up on
    orphan per-thread loops — that path could fail DNS/SSL differently.
    """
    from core.http.runtime import run_coroutine_on_main_loop

    return run_coroutine_on_main_loop(
        coro_factory(),
        timeout=timeout,
        allow_fallback=True,
    )


def _execute_service_action(action: dict) -> str:
    """HA-style service call: turn_on / turn_off / toggle / set on an entity.

    Uses the same ``control_entity_sync`` bridge as dashboard widgets and
    ``/api/integrations/{slug}/control`` so automations hit the same
    integration instance and network stack as manual controls.
    """
    entity_id = str(action.get("entity_id") or "").strip()
    service = str(action.get("service") or "").strip()
    data = action.get("data") or {}
    if not entity_id:
        raise AutomationValidationError("service action missing entity_id")
    if not service:
        raise AutomationValidationError("service action missing service")
    from core.device_control import ControlTargetNotFound, control_entity_sync
    from core.entity_refs import resolve_entity_reference

    record = resolve_entity_reference(entity_id)
    live_id = str((record or {}).get("entity_id") or entity_id).strip()
    slug_hint = str((record or {}).get("source") or "").strip() or None

    try:
        result = control_entity_sync(
            live_id,
            service,
            data or None,
            entity=record,
            slug_hint=slug_hint,
            timeout=45.0,
        )
    except ControlTargetNotFound as exc:
        raise AutomationValidationError(str(exc)) from exc
    return f"{service} {live_id} ok (result={result})"


def _execute_scene_action(action: dict) -> str:
    scene_id = str(action.get("scene_id") or "").strip()
    if not scene_id:
        raise AutomationValidationError("scene action missing scene_id")
    db = database.SessionLocal()
    try:
        from routers import scenes as scenes_module
        scene = db.query(models.Scene).filter(models.Scene.id == scene_id).first()
        if scene is None:
            raise AutomationValidationError(f"Scene '{scene_id}' not found")

        async def _call():
            return await scenes_module.activate_scene_internal(db, scene)

        result = _run_async_in_thread(_call)
        return f"scene {scene_id} activated ({result.get('status', 'ok')})"
    finally:
        db.close()


def _execute_action_sequence(owner_id: str, channel: str, actions: list[dict], path_prefix: str = "action", dry_run: bool = False) -> list[str]:
    """Run an action sequence. When ``dry_run`` is true, side-effecting
    branches (service, scene, notify, skill) record a synthetic
    ``DRY-RUN: would ...`` trace step instead of invoking integrations,
    scheduler or skills. Conditions, repeat/choose control flow, delays
    (clamped to 0s) and wait_template (single-shot, no sleep) all still
    execute so the simulated path matches the real one."""
    messages = []
    for idx, action in enumerate(actions):
        kind = action.get("kind") or "?"
        path = f"{path_prefix}[{idx}].{kind}"
        step_t0 = _time_mod.monotonic()
        try:
            if kind == "service":
                if dry_run:
                    msg = f"DRY-RUN: would call {action.get('service')} on {action.get('entity_id')}"
                else:
                    msg = _execute_service_action(action)
                messages.append(msg)
                _trace_step("action", path, "dry_run" if dry_run else "ok", message=msg,
                            params={"service": action.get("service"),
                                    "entity_id": action.get("entity_id")},
                            duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "scene":
                if dry_run:
                    msg = f"DRY-RUN: would activate scene {action.get('scene_id')}"
                else:
                    msg = _execute_scene_action(action)
                messages.append(msg)
                _trace_step("action", path, "dry_run" if dry_run else "ok", message=msg,
                            params={"scene_id": action.get("scene_id")},
                            duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "skill":
                skill_name = action.get("name")
                if dry_run:
                    msg = f"DRY-RUN: would run skill {skill_name}"
                    messages.append(msg)
                    _trace_step("action", path, "dry_run", message=msg,
                                params={"name": skill_name},
                                duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
                else:
                    skill_input = action.get("input") or {}
                    allow_network = False
                    from integrations import entry_settings

                    searxng = entry_settings.searxng_settings()
                    if searxng.get("url"):
                        skill_input = dict(skill_input)
                        skill_input["_searxng_url"] = searxng["url"].strip()
                        allow_network = True
                    result = skills.run_skill(skill_name, skill_input, allow_network=allow_network)
                    formatted = scheduler_service._format_skill_result(skill_name, result)
                    scheduler_service.trigger_notification(owner_id, formatted, channel, notification_type="automation")
                    messages.append(f"skill {skill_name} ok")
                    _trace_step("action", path, "ok", message=f"skill {skill_name} ok",
                                params={"name": skill_name, "allow_network": allow_network},
                                duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "notify":
                text = action.get("text") or "Automation notification"
                if dry_run:
                    msg = f"DRY-RUN: would create notification: {text}"
                else:
                    scheduler_service.trigger_notification(owner_id, text, channel, notification_type="automation")
                    msg = "notify ok"
                messages.append(msg)
                _trace_step("action", path, "dry_run" if dry_run else "ok", message=msg,
                            params={"text": text},
                            duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "delay":
                seconds = float(action.get("seconds") or 0)
                if not dry_run:
                    _time_mod.sleep(seconds)
                messages.append(f"delay {action.get('seconds')}s" + (" (skipped)" if dry_run else ""))
                _trace_step("action", path, "dry_run" if dry_run else "ok",
                            message=f"delay {seconds}s" + (" (skipped)" if dry_run else ""),
                            duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "wait_template":
                if dry_run:
                    msg = f"DRY-RUN: would wait for template (timeout {action.get('timeout')}s)"
                    messages.append(msg)
                    _trace_step("action", path, "dry_run", message=msg,
                                duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
                else:
                    msg = _execute_wait_template(action)
                    messages.append(msg)
                    _trace_step("action", path, "ok", message=msg,
                                duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "repeat":
                count = int(action.get("count") or 0)
                inner = action.get("actions") or []
                for i in range(count):
                    inner_msgs = _execute_action_sequence(
                        owner_id, channel, inner, path_prefix=f"{path}[{i}]", dry_run=dry_run,
                    )
                    messages.append(f"repeat[{i + 1}/{count}] " + ", ".join(inner_msgs))
                _trace_step("action", path, "ok", message=f"repeat x{count}",
                            duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            elif kind == "choose":
                choose_msgs = _execute_choose_action(owner_id, channel, action, path_prefix=path, dry_run=dry_run)
                messages.extend(choose_msgs)
                _trace_step("action", path, "ok", message=choose_msgs[0] if choose_msgs else "choose",
                            duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            else:
                _trace_step("action", path, "skipped",
                            message=f"unknown action kind {kind!r}")
        except Exception as exc:
            _trace_step("action", path, "error", error=str(exc),
                        duration_ms=(_time_mod.monotonic() - step_t0) * 1000)
            raise
    return messages


def _execute_choose_action(owner_id: str, channel: str, action: dict, path_prefix: str = "choose", dry_run: bool = False) -> list[str]:
    """HA-style if/elif/else: pick the first branch whose conditions all
    pass and run its sequence; if none match, run ``default``."""
    for idx, branch in enumerate(action.get("choices") or []):
        conditions = branch.get("conditions") or []
        ok, _reason = _evaluate_conditions(conditions)
        if ok:
            inner = _execute_action_sequence(
                owner_id, channel, branch.get("actions") or [],
                path_prefix=f"{path_prefix}[{idx}]", dry_run=dry_run,
            )
            return [f"choose[{idx}] matched"] + inner
    default_actions = action.get("default") or []
    if default_actions:
        inner = _execute_action_sequence(
            owner_id, channel, default_actions,
            path_prefix=f"{path_prefix}[default]", dry_run=dry_run,
        )
        return ["choose[default]"] + inner
    return ["choose: no branch matched"]


def _execute_wait_template(action: dict) -> str:
    """Block (in the executor thread) until the template renders truthy or
    the timeout elapses. Polls every 0.5s, refreshing the entity snapshot
    each tick."""
    import time as _time
    from core import automation_template
    template_str = action.get("template") or ""
    timeout = float(action.get("timeout") or 60)
    continue_on_timeout = bool(action.get("continue_on_timeout", True))
    deadline = _time.monotonic() + timeout
    poll_interval = 0.5
    while True:
        try:
            from core.state_observer import _last_snapshot
            snapshot = list(_last_snapshot.values())
            if automation_template.render_bool(template_str, snapshot=snapshot):
                return f"wait_template ok ({timeout - (deadline - _time.monotonic()):.1f}s)"
        except Exception as exc:
            log_detail("automation", "WAIT_TEMPLATE_ERROR", error=str(exc))
        if _time.monotonic() >= deadline:
            if continue_on_timeout:
                return f"wait_template timeout ({timeout}s, continuing)"
            raise AutomationValidationError(f"wait_template timed out after {timeout}s")
        _time.sleep(poll_interval)


def execute_automation_definition(definition_id: str, trigger_source: str = "manual", dry_run: bool = False):
    """Public entry. Wraps the actual run with HA-style ``mode`` semantics:

    - ``single`` (default): if a run is already in flight, skip new triggers.
    - ``restart``: cancel the previous run by clearing its 'busy' flag and
      proceeding (best-effort — Python threads can't be hard-killed, so the
      previous run finishes naturally but its result is discarded).
    - ``queued``: serialize runs through a per-automation lock — new triggers
      wait their turn (capped at 10 pending to avoid runaway buildup).
    - ``parallel``: run concurrently with no coordination.

    When ``dry_run`` is true the mode-coordination layer is bypassed: the
    simulation is read-only so concurrent dry-runs are always safe and
    must never be skipped/queued behind a real in-flight run.
    """
    if dry_run:
        return _execute_definition_body(definition_id, trigger_source, 0, _mode_state(definition_id), dry_run=True)
    mode = _get_mode(definition_id)
    if mode == "parallel":
        return _execute_definition_inner(definition_id, trigger_source)

    state = _mode_state(definition_id)
    with state["meta_lock"]:
        in_flight = state["in_flight"]
        pending = state["pending"]

    if mode == "single" and in_flight:
        log_detail("automation", "MODE_SKIP_SINGLE", automation_id=definition_id)
        return
    if mode == "restart" and in_flight:
        # Mark previous as superseded; the older worker will discard its
        # result on completion. The new run starts immediately.
        with state["meta_lock"]:
            state["generation"] += 1
    if mode == "queued":
        if pending >= 10:
            log_detail("automation", "MODE_QUEUE_FULL", automation_id=definition_id)
            return
        with state["meta_lock"]:
            state["pending"] += 1
        with state["run_lock"]:
            with state["meta_lock"]:
                state["pending"] -= 1
            return _execute_definition_inner(definition_id, trigger_source)

    return _execute_definition_inner(definition_id, trigger_source)


# Per-automation runtime coordination state. Created lazily.
_mode_states: dict[str, dict] = {}
_mode_states_lock = threading.Lock()


def _mode_state(definition_id: str) -> dict:
    with _mode_states_lock:
        st = _mode_states.get(definition_id)
        if st is None:
            st = {
                "meta_lock": threading.Lock(),
                "run_lock": threading.Lock(),
                "in_flight": False,
                "pending": 0,
                "generation": 0,
            }
            _mode_states[definition_id] = st
        return st


def _get_mode(definition_id: str) -> str:
    db = database.SessionLocal()
    try:
        defn = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == definition_id).first()
        if not defn:
            return "single"
        return (json.loads(defn.normalized_json).get("mode") or "single").strip().lower()
    except Exception:
        return "single"
    finally:
        db.close()


def _execute_definition_inner(definition_id: str, trigger_source: str = "manual"):
    state = _mode_state(definition_id)
    with state["meta_lock"]:
        state["in_flight"] = True
        my_generation = state["generation"]
    try:
        return _execute_definition_body(definition_id, trigger_source, my_generation, state)
    finally:
        with state["meta_lock"]:
            # Only clear if no newer 'restart' generation took over.
            if state["generation"] == my_generation:
                state["in_flight"] = False


def _execute_definition_body(definition_id: str, trigger_source: str, my_generation: int, state: dict, dry_run: bool = False):
    db = database.SessionLocal()
    run = None
    run_id = uuid.uuid4().hex
    trace = _trace_begin(run_id)
    trace.add("run", "trigger", "ok", message=f"trigger_source={trigger_source}" + (" (dry_run)" if dry_run else ""))
    # Pre-render top-level variables (Jinja-evaluated against current
    # entity snapshot) and publish them on the thread-local so all nested
    # templates can reference them by name.
    from core import automation_template
    automation_template.set_run_variables({})
    try:
        defn_peek = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == definition_id).first()
        if defn_peek:
            normalized_peek = json.loads(defn_peek.normalized_json)
            raw_vars = normalized_peek.get("variables") or {}
            if raw_vars:
                try:
                    from core.state_observer import _last_snapshot
                    snap = list(_last_snapshot.values())
                except Exception:
                    snap = []
                rendered: dict[str, Any] = {}
                # Render in declaration order so a later variable can
                # reference an earlier one. We set them progressively on
                # the thread-local so the next render() picks them up.
                automation_template.set_run_variables(rendered)
                for vk, vv in raw_vars.items():
                    if isinstance(vv, str) and "{{" in vv:
                        try:
                            rendered[vk] = automation_template.render(vv, snapshot=snap)
                        except Exception as exc:
                            log_detail("automation", "VARIABLE_RENDER_ERROR",
                                       automation_id=definition_id, variable=vk, error=str(exc))
                            rendered[vk] = ""
                    else:
                        rendered[vk] = vv
                    automation_template.set_run_variables(rendered)
    except Exception:
        pass
    run = None
    try:
        definition = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == definition_id).first()
        if not definition:
            log_detail("automation", "RUN_MISSING_DEFINITION", automation_id=definition_id)
            if not dry_run:
                _remove_runtime_jobs(definition_id)
            return {"status": "error", "error": "definition not found", "trace": trace.as_dict()} if dry_run else None
        normalized = json.loads(definition.normalized_json)
        if not dry_run:
            run = models.AutomationRun(
                automation_id=definition.id,
                status="running",
                trigger_source=trigger_source,
                details_json=json.dumps({"trigger_source": trigger_source, "run_id": run_id}),
            )
            db.add(run)
            db.commit()
            db.refresh(run)

        if not definition.enabled or not normalized.get("enabled", True):
            message = "Automation is disabled"
            trace.add("run", "skip", "skipped", message=message)
            if dry_run:
                return {"status": "skipped", "message": message, "messages": [], "trace": trace.as_dict()}
            definition.last_run_status = "skipped"
            definition.last_error = message
            run.status = "skipped"
            run.message = message
            run.finished_at = datetime.now()
            run.details_json = json.dumps(
                {"trigger_source": trigger_source, "run_id": run_id, "trace": trace.as_dict()},
                ensure_ascii=False,
            )
            db.commit()
            return

        conditions_ok, condition_message = _evaluate_conditions(normalized.get("condition") or [])
        trace.add("condition", "condition", "ok" if conditions_ok else "skipped",
                  message=condition_message)
        if not conditions_ok:
            if dry_run:
                return {"status": "skipped", "message": condition_message, "messages": [], "trace": trace.as_dict()}
            definition.last_run_at = datetime.now()
            definition.last_run_status = "skipped"
            definition.last_error = condition_message
            run.status = "skipped"
            run.message = condition_message
            run.finished_at = datetime.now()
            run.details_json = json.dumps(
                {"trigger_source": trigger_source, "run_id": run_id, "trace": trace.as_dict()},
                ensure_ascii=False,
            )
            db.commit()
            return

        messages = _execute_action_sequence(
            definition.owner_id, "web",
            normalized.get("action") or [], dry_run=dry_run,
        )
        if dry_run:
            return {"status": "ok", "messages": messages, "trace": trace.as_dict()}
        definition.last_run_at = datetime.now()
        definition.last_run_status = "ok"
        definition.last_error = None
        run.status = "ok"
        run.message = "; ".join(messages) or "Automation executed"
        run.details_json = json.dumps(
            {"messages": messages, "run_id": run_id, "trace": trace.as_dict()},
            ensure_ascii=False,
        )
        run.finished_at = datetime.now()
        db.commit()
    except Exception as exc:
        log_line("error", "❌", "AUTOMATION", f"Definition run failed for {definition_id}: {exc}")
        trace.add("run", "exception", "error", error=str(exc))
        if dry_run:
            return {"status": "error", "error": str(exc), "trace": trace.as_dict()}
        if run is not None:
            run.status = "error"
            run.message = str(exc)
            run.finished_at = datetime.now()
            try:
                run.details_json = json.dumps(
                    {"run_id": run_id, "trace": trace.as_dict(), "error": str(exc)},
                    ensure_ascii=False,
                )
            except Exception:
                pass
        definition = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == definition_id).first()
        if definition:
            definition.last_run_at = datetime.now()
            definition.last_run_status = "error"
            definition.last_error = str(exc)
        db.commit()
    finally:
        db.close()
        _trace_end()
        try:
            from core import automation_template
            automation_template.clear_run_variables()
        except Exception:
            pass
