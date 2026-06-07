import json
import os
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

import database
import models
from logger import log_detail, log_line

# --------------------------------------------------------------------------- #
# Schema constants — implementation lives in core.automations_engine.schema.  #
# Re-exported here under the original underscore-prefixed names so existing   #
# call sites (validators, executor, tests) keep working unchanged.            #
# --------------------------------------------------------------------------- #

from core.automations_engine.schema import (  # noqa: E402
    ENTITY_ID_RE as _ENTITY_ID_RE,
    SUPPORTED_SERVICE_VERBS as _SUPPORTED_SERVICE_VERBS,
    SERVICE_DATA_MAX_BYTES as _SERVICE_DATA_MAX_BYTES,
    SERVICE_DATA_SCALAR_TYPES as _SERVICE_DATA_SCALAR_TYPES,
    SUPPORTED_MODES as _SUPPORTED_MODES,
    SUPPORTED_TRIGGER_PLATFORMS as _SUPPORTED_TRIGGER_PLATFORMS,
    SUPPORTED_CONDITION_KINDS as _SUPPORTED_CONDITION_KINDS,
    SUPPORTED_ACTION_KINDS as _SUPPORTED_ACTION_KINDS,
    SUPPORTED_WEEKDAYS as _SUPPORTED_WEEKDAYS,
    describe_schema,
)

AUTOMATIONS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "automations")


# --------------------------------------------------------------------------- #
# Trace collector — captures per-step execution detail for the UI debugger.   #
# Implementation lives in core.automations_engine.trace; the underscore names #
# below are kept as backwards-compatible aliases for existing call sites and  #
# tests that import them from this module.                                    #
# --------------------------------------------------------------------------- #

from core.automations_engine.trace import (  # noqa: E402  (kept near top of trace section)
    TRACE_MAX_STEPS as _TRACE_MAX_STEPS,
    TRACE_MAX_PARAMS_BYTES as _TRACE_MAX_PARAMS_BYTES,
    TRACE_MAX_MESSAGE_BYTES as _TRACE_MAX_MESSAGE_BYTES,
    TraceCollector as _TraceCollector,
    trace_begin as _trace_begin,
    trace_end as _trace_end,
    trace_current as _trace_current,
    trace_step as _trace_step,
    trace_truncate as _trace_truncate,
    trace_safe_params as _trace_safe_params,
)

# --------------------------------------------------------------------------- #
# Validators / parsers — implementation lives in                              #
# core.automations_engine.validators. Re-exported here under the original     #
# names so existing call sites + tests keep working unchanged.                #
# --------------------------------------------------------------------------- #

from core.automations_engine.validators import (  # noqa: E402
    AutomationValidationError,
    ID_RE as _ID_RE,
    TIME_RE as _TIME_RE,
    _slugify,
    _parse_time_string,
    _parse_datetime_string,
    _ensure_dict,
    _coerce_duration_seconds,
    _coerce_signed_duration_seconds,
    _validate_weekdays,
    _validate_trigger,
    _validate_condition,
    _validate_service_action,
    _validate_action,
    validate_source_yaml,
    lint_definition,
)

# --------------------------------------------------------------------------- #
# Runtime / scheduler — implementation lives in                               #
# core.automations_engine.runtime. Re-exported here under the original names. #
# The runtime module imports execute_automation_definition lazily to avoid a  #
# circular import (it's defined further down in this module).                 #
# --------------------------------------------------------------------------- #

from core.automations_engine.runtime import (  # noqa: E402
    sync_runtime,
    list_definition_runtime_jobs,
    _runtime_job_id,
    _remove_runtime_jobs,
    _hash_triggers,
    _schedule_trigger,
    _bus_handler_id,
    _subscribe_state_trigger,
    _subscribe_template_trigger,
    _schedule_sun_trigger,
    _fire_and_rearm_sun,
    _normalize_cron_field,
    _schedule_time_pattern_trigger,
    _subscribe_event_trigger,
)


# --------------------------------------------------------------------------- #
# Storage helpers — implementation lives in core.automations_engine.storage   #
# as pure functions taking ``root`` as their first arg. The wrappers below    #
# forward this module's ``AUTOMATIONS_ROOT`` so existing tests that monkey-   #
# patch ``ad.AUTOMATIONS_ROOT`` keep working unchanged.                       #
# --------------------------------------------------------------------------- #

from core.automations_engine import storage as _storage  # noqa: E402


def ensure_automation_storage_root() -> str:
    return _storage.ensure_storage_root(AUTOMATIONS_ROOT)


def _safe_owner_dir(owner_id: str) -> str:
    return _storage.safe_owner_dir(AUTOMATIONS_ROOT, owner_id)


def get_automation_yaml_path(owner_id: str, automation_id: str) -> str:
    return _storage.yaml_path(AUTOMATIONS_ROOT, owner_id, automation_id)


def get_automation_yaml_relpath(owner_id: str, automation_id: str) -> str:
    return _storage.yaml_relpath(AUTOMATIONS_ROOT, owner_id, automation_id)


def write_definition_yaml(owner_id: str, automation_id: str, source_yaml: str) -> str:
    return _storage.write_yaml(AUTOMATIONS_ROOT, owner_id, automation_id, source_yaml)


def read_definition_yaml(owner_id: str, automation_id: str, fallback: str | None = None) -> str:
    return _storage.read_yaml(AUTOMATIONS_ROOT, owner_id, automation_id, fallback)


def delete_definition_yaml(owner_id: str, automation_id: str) -> None:
    _storage.delete_yaml(AUTOMATIONS_ROOT, owner_id, automation_id)


def backfill_yaml_files_from_db(db: Session) -> None:
    _storage.backfill_from_db(AUTOMATIONS_ROOT, db, models.AutomationDefinition)


def reschedule_all(db: Session) -> int:
    """Re-register every enabled automation's runtime triggers (cron jobs and
    event-bus subscriptions). Called at boot so reactive triggers survive a
    restart. Returns the number of definitions scheduled."""
    count = 0
    for item in db.query(models.AutomationDefinition).filter(models.AutomationDefinition.enabled == True).all():  # noqa: E712
        try:
            sync_runtime(item, db)
            count += 1
        except Exception as exc:
            log_detail("automation", "RESCHEDULE_ERROR", automation_id=item.id, error=str(exc))
    return count


def serialize_definition(definition: models.AutomationDefinition) -> dict:
    normalized = json.loads(definition.normalized_json)
    next_runs = list_definition_runtime_jobs(definition.id)
    source_yaml = read_definition_yaml(definition.owner_id, definition.id, fallback=definition.source_yaml)
    return {
        "id": definition.id,
        "owner_id": definition.owner_id,
        "owner_type": definition.owner_type,
        "title": definition.title,
        "description": definition.description,
        "enabled": definition.enabled,
        "source_version": definition.source_version,
        "revision": definition.revision,
        "source_yaml": source_yaml,
        "yaml_path": get_automation_yaml_relpath(definition.owner_id, definition.id),
        "normalized": normalized,
        "trigger_summary": summarize_trigger_set(normalized.get("trigger") or []),
        "action_summary": summarize_action_set(normalized.get("action") or []),
        "next_runs": next_runs,
        "last_compiled_at": definition.last_compiled_at.isoformat() if definition.last_compiled_at else None,
        "last_run_at": definition.last_run_at.isoformat() if definition.last_run_at else None,
        "last_run_status": definition.last_run_status,
        "last_error": definition.last_error,
        "created_by": definition.created_by,
        "updated_by": definition.updated_by,
        "created_at": definition.created_at.isoformat() if definition.created_at else None,
        "updated_at": definition.updated_at.isoformat() if definition.updated_at else None,
    }


def summarize_trigger_set(triggers: list[dict]) -> list[str]:
    out = []
    for item in triggers:
        platform = item.get("platform")
        if platform == "time":
            if item.get("weekdays"):
                out.append(f"time {item.get('at')} on {', '.join(item.get('weekdays') or [])}")
            else:
                out.append(f"time {item.get('at')} daily")
        elif platform == "datetime":
            out.append(f"datetime {item.get('at')}")
        elif platform == "interval":
            out.append(f"every {item.get('every_minutes')} min")
        elif platform == "state":
            extras = []
            if item.get("from"):
                extras.append(f"from {item.get('from')}")
            if item.get("to"):
                extras.append(f"to {item.get('to')}")
            tail = (" " + " ".join(extras)) if extras else " change"
            out.append(f"state {item.get('entity_id')}{tail}")
        elif platform == "numeric_state":
            extras = []
            if item.get("above") is not None:
                extras.append(f">{item.get('above')}")
            if item.get("below") is not None:
                extras.append(f"<{item.get('below')}")
            out.append(f"numeric_state {item.get('entity_id')} {' '.join(extras)}".strip())
        elif platform == "template":
            tmpl = item.get("value_template") or ""
            preview = tmpl if len(tmpl) <= 40 else tmpl[:37] + "..."
            out.append(f"template {preview}")
    return out


def summarize_action_set(actions: list[dict]) -> list[str]:
    out = []
    for item in actions:
        kind = item.get("kind")
        if kind == "service":
            out.append(f"{item.get('service')} {item.get('entity_id')}")
        elif kind == "scene":
            out.append(f"scene:{item.get('scene_id')}")
        elif kind == "skill":
            out.append(f"skill:{item.get('name')}")
        elif kind == "notify":
            out.append("notify")
        elif kind == "delay":
            out.append(f"delay {item.get('seconds')}s")
        elif kind == "wait_template":
            out.append(f"wait_template (timeout {item.get('timeout')}s)")
        elif kind == "repeat":
            inner = summarize_action_set(item.get("actions") or [])
            out.append(f"repeat {item.get('count')}x [{', '.join(inner)}]")
    return out


# --------------------------------------------------------------------------- #
# Runner / executor — implementation lives in core.automations_engine.actions #
# (condition eval + action execution + per-mode coordination). Re-exported    #
# here under the original underscore-prefixed names so callers and tests      #
# keep working unchanged.                                                     #
# --------------------------------------------------------------------------- #

from core.automations_engine.actions import (  # noqa: E402
    _current_time_for_window,
    _lookup_entity,
    _entity_numeric_value,
    _evaluate_conditions,
    _run_async_in_thread,
    _execute_service_action,
    _execute_scene_action,
    _execute_action_sequence,
    _execute_choose_action,
    _execute_wait_template,
    execute_automation_definition,
    _mode_state,
    _get_mode,
    _execute_definition_inner,
    _execute_definition_body,
)


def create_definition(db: Session, owner_id: str, actor: str, source_yaml: str) -> models.AutomationDefinition:
    normalized = validate_source_yaml(source_yaml)
    existing = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == normalized["id"]).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Automation '{normalized['id']}' already exists")
    normalized_source = (source_yaml or "").strip() + "\n"
    definition = models.AutomationDefinition(
        id=normalized["id"],
        owner_type="user",
        owner_id=owner_id,
        title=normalized["title"],
        description=normalized.get("description"),
        enabled=bool(normalized.get("enabled", True)),
        channel="web",
        source_yaml=normalized_source,
        normalized_json=json.dumps(normalized, ensure_ascii=False),
        source_version=normalized.get("version", 1),
        revision=1,
        created_by=actor,
        updated_by=actor,
    )
    write_definition_yaml(owner_id, normalized["id"], normalized_source)
    try:
        db.add(definition)
        db.commit()
        db.refresh(definition)
    except Exception:
        delete_definition_yaml(owner_id, normalized["id"])
        raise
    sync_runtime(definition, db)
    return definition


def get_definition_for_owner(db: Session, automation_id: str, owner_id: str) -> models.AutomationDefinition:
    definition = db.query(models.AutomationDefinition).filter(
        models.AutomationDefinition.id == automation_id,
        models.AutomationDefinition.owner_id == owner_id,
    ).first()
    if not definition:
        raise HTTPException(status_code=404, detail="Automation not found")
    return definition


def replace_definition(db: Session, definition: models.AutomationDefinition, actor: str, source_yaml: str, expected_revision: int) -> models.AutomationDefinition:
    if int(expected_revision) != int(definition.revision):
        raise HTTPException(status_code=409, detail="Automation revision conflict")
    normalized = validate_source_yaml(source_yaml)
    if normalized["id"] != definition.id:
        raise HTTPException(status_code=400, detail="Automation id cannot change")
    normalized_source = (source_yaml or "").strip() + "\n"
    definition.title = normalized["title"]
    definition.description = normalized.get("description")
    definition.enabled = bool(normalized.get("enabled", True))
    definition.channel = "web"
    definition.source_yaml = normalized_source
    definition.normalized_json = json.dumps(normalized, ensure_ascii=False)
    definition.source_version = normalized.get("version", 1)
    definition.revision = int(definition.revision or 0) + 1
    definition.updated_by = actor
    write_definition_yaml(definition.owner_id, definition.id, normalized_source)
    db.add(definition)
    db.commit()
    db.refresh(definition)
    sync_runtime(definition, db)
    return definition


def set_enabled(db: Session, definition: models.AutomationDefinition, actor: str, enabled: bool, expected_revision: int) -> models.AutomationDefinition:
    if int(expected_revision) != int(definition.revision):
        raise HTTPException(status_code=409, detail="Automation revision conflict")
    normalized = json.loads(definition.normalized_json)
    normalized["enabled"] = bool(enabled)
    definition.enabled = bool(enabled)
    definition.normalized_json = json.dumps(normalized, ensure_ascii=False)
    definition.revision = int(definition.revision or 0) + 1
    definition.updated_by = actor
    db.add(definition)
    db.commit()
    db.refresh(definition)
    sync_runtime(definition, db)
    return definition


def list_definitions(db: Session, owner_id: str) -> list[models.AutomationDefinition]:
    return db.query(models.AutomationDefinition).filter(models.AutomationDefinition.owner_id == owner_id).order_by(models.AutomationDefinition.updated_at.desc()).all()


def delete_definition(db: Session, definition: models.AutomationDefinition):
    _remove_runtime_jobs(definition.id)
    delete_definition_yaml(definition.owner_id, definition.id)
    db.delete(definition)
    db.commit()


def list_history(db: Session, definition: models.AutomationDefinition, limit: int = 20) -> list[dict]:
    runs = db.query(models.AutomationRun).filter(models.AutomationRun.automation_id == definition.id).order_by(models.AutomationRun.started_at.desc()).limit(limit).all()
    out = []
    for run in runs:
        details = None
        if run.details_json:
            try:
                details = json.loads(run.details_json)
            except Exception:
                details = {"raw": run.details_json}
        out.append({
            "id": run.id,
            "status": run.status,
            "trigger_source": run.trigger_source,
            "message": run.message,
            "details": details,
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        })
    return out