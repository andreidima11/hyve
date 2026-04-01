import hashlib
import json
import re
import asyncio
import os
from datetime import datetime, timedelta

import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session

import database
import device_resolver
import home_assistant
from ha_websocket import ha_ws
import models
import scheduler_service
import settings
import skills
from logger import log_detail, log_line


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_RUNTIME_PREFIX = "autdef_"
_OWNER_RE = re.compile(r"[^a-zA-Z0-9_.-]+")

# In-memory map of state-trigger callbacks: { job_id: (entity_id, callback) }
_state_trigger_callbacks: dict[str, tuple[str, any]] = {}

_SUPPORTED_WEEKDAYS = {
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
}
AUTOMATIONS_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "automations")



def _known_ha_entity_ids() -> set[str]:
    entity_ids: set[str] = set()
    try:
        for item in home_assistant.load_config() or []:
            entity_id = str((item or {}).get("entity_id") or "").strip()
            if entity_id:
                entity_ids.add(entity_id)
    except Exception:
        pass
    if entity_ids:
        return entity_ids
    try:
        for item in _fetch_ha_states_sync() or []:
            entity_id = str((item or {}).get("entity_id") or "").strip()
            if entity_id:
                entity_ids.add(entity_id)
    except Exception:
        pass
    return entity_ids


def _validate_known_entity_id(entity_id: str, context: str) -> str:
    normalized = str(entity_id or "").strip()
    if not normalized or "." not in normalized:
        raise AutomationValidationError(f"{context} requires entity_id")
    known = _known_ha_entity_ids()
    if known and normalized not in known:
        raise AutomationValidationError(f"Unknown Home Assistant entity '{normalized}'")
    return normalized

class AutomationValidationError(ValueError):
    pass


def ensure_automation_storage_root() -> str:
    os.makedirs(AUTOMATIONS_ROOT, exist_ok=True)
    return AUTOMATIONS_ROOT


def _safe_owner_dir(owner_id: str) -> str:
    owner = _OWNER_RE.sub("_", str(owner_id or "unknown")).strip("._") or "unknown"
    return os.path.join(ensure_automation_storage_root(), owner)


def get_automation_yaml_path(owner_id: str, automation_id: str) -> str:
    return os.path.join(_safe_owner_dir(owner_id), f"{automation_id}.yaml")


def get_automation_yaml_relpath(owner_id: str, automation_id: str) -> str:
    safe_owner = os.path.basename(_safe_owner_dir(owner_id))
    return os.path.join("automations", safe_owner, f"{automation_id}.yaml")


def write_definition_yaml(owner_id: str, automation_id: str, source_yaml: str) -> str:
    owner_dir = _safe_owner_dir(owner_id)
    os.makedirs(owner_dir, exist_ok=True)
    path = get_automation_yaml_path(owner_id, automation_id)
    temp_path = f"{path}.tmp"
    normalized_text = (source_yaml or "").strip() + "\n"
    with open(temp_path, "w", encoding="utf-8") as handle:
        handle.write(normalized_text)
    os.replace(temp_path, path)
    return path


def read_definition_yaml(owner_id: str, automation_id: str, fallback: str | None = None) -> str:
    path = get_automation_yaml_path(owner_id, automation_id)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    if fallback is not None:
        write_definition_yaml(owner_id, automation_id, fallback)
        return (fallback or "").strip() + "\n"
    raise FileNotFoundError(path)


def delete_definition_yaml(owner_id: str, automation_id: str):
    path = get_automation_yaml_path(owner_id, automation_id)
    if os.path.exists(path):
        os.remove(path)
    owner_dir = os.path.dirname(path)
    if os.path.isdir(owner_dir) and not os.listdir(owner_dir):
        os.rmdir(owner_dir)


def backfill_yaml_files_from_db(db: Session):
    ensure_automation_storage_root()
    items = db.query(models.AutomationDefinition).all()
    for item in items:
        path = get_automation_yaml_path(item.owner_id, item.id)
        if os.path.exists(path):
            continue
        if item.source_yaml:
            write_definition_yaml(item.owner_id, item.id, item.source_yaml)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")
    if len(slug) < 3:
        slug = f"automation_{slug or 'item'}"
    return slug[:64]


def _parse_time_string(value: str) -> tuple[int, int]:
    text = str(value or "").strip()
    match = _TIME_RE.match(text)
    if not match:
        raise AutomationValidationError(f"Invalid time '{text}'. Expected HH:MM.")
    return int(match.group(1)), int(match.group(2))


def _parse_datetime_string(value: str) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise AutomationValidationError("datetime trigger requires 'at'")
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AutomationValidationError(f"Invalid datetime '{text}'. Use ISO-8601.") from exc


def _ensure_dict(value, label: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise AutomationValidationError(f"{label} must be an object")
    return value


def _validate_weekdays(value) -> list[str]:
    weekdays = value or []
    if not isinstance(weekdays, list):
        raise AutomationValidationError("weekdays must be a list")
    normalized = []
    for item in weekdays:
        weekday = str(item or "").strip().lower()
        if weekday not in _SUPPORTED_WEEKDAYS:
            raise AutomationValidationError(f"Unsupported weekday '{item}'")
        if weekday not in normalized:
            normalized.append(weekday)
    return normalized


def _validate_trigger(item: dict) -> dict:
    if not isinstance(item, dict):
        raise AutomationValidationError("Each trigger must be an object")
    platform = str(item.get("platform") or "").strip().lower()
    if platform == "time":
        at = str(item.get("at") or "").strip()
        _parse_time_string(at)
        out = {"platform": "time", "at": at}
        weekdays = _validate_weekdays(item.get("weekdays"))
        if weekdays:
            out["weekdays"] = weekdays
        return out
    if platform == "datetime":
        at = str(item.get("at") or "").strip()
        out = {"platform": "datetime", "at": _parse_datetime_string(at).isoformat()}
        return out
    if platform == "interval":
        every_minutes = item.get("every_minutes")
        try:
            every_minutes = int(every_minutes)
        except (TypeError, ValueError) as exc:
            raise AutomationValidationError("interval trigger requires integer every_minutes") from exc
        if every_minutes < 1 or every_minutes > 10080:
            raise AutomationValidationError("every_minutes must be between 1 and 10080")
        out = {"platform": "interval", "every_minutes": every_minutes}
        if item.get("start_at"):
            out["start_at"] = _parse_datetime_string(str(item.get("start_at"))).isoformat()
        return out
    if platform == "home_assistant_state":
        entity_id = _validate_known_entity_id(item.get("entity_id"), "home_assistant_state trigger")
        to_state = str(item.get("to") or "").strip()
        if not to_state:
            raise AutomationValidationError("home_assistant_state trigger requires 'to' state")
        out = {"platform": "home_assistant_state", "entity_id": entity_id, "to": to_state}
        from_state = str(item.get("from") or "").strip()
        if from_state:
            out["from"] = from_state
        return out
    raise AutomationValidationError(f"Unsupported trigger platform '{platform}'")


def _validate_condition(item: dict) -> dict:
    if not isinstance(item, dict):
        raise AutomationValidationError("Each condition must be an object")
    kind = str(item.get("kind") or "").strip().lower()
    if kind == "home_assistant_state":
        entity_id = _validate_known_entity_id(item.get("entity_id"), "home_assistant_state condition")
        state = str(item.get("state") or "").strip()
        if not state:
            raise AutomationValidationError("home_assistant_state requires state")
        return {"kind": kind, "entity_id": entity_id, "state": state}
    if kind == "time_window":
        after = item.get("after")
        before = item.get("before")
        if not after and not before:
            raise AutomationValidationError("time_window requires after and/or before")
        out = {"kind": kind}
        if after:
            out["after"] = str(after).strip()
            _parse_time_string(out["after"])
        if before:
            out["before"] = str(before).strip()
            _parse_time_string(out["before"])
        return out
    raise AutomationValidationError(f"Unsupported condition kind '{kind}'")


def _validate_action(item: dict) -> dict:
    if not isinstance(item, dict):
        raise AutomationValidationError("Each action must be an object")
    if item.get("service"):
        service = str(item.get("service") or "").strip()
        if "." not in service:
            raise AutomationValidationError("service action must use domain.service syntax")
        target = _ensure_dict(item.get("target"), "target")
        data = _ensure_dict(item.get("data"), "data")
        entity_id = str(target.get("entity_id") or "").strip()
        if entity_id:
            if "." in entity_id and " " not in entity_id:
                target["entity_id"] = entity_id
            else:
                resolved = device_resolver.resolve_target_sync(entity_id)
                if not resolved:
                    raise AutomationValidationError(f"Could not resolve target entity '{entity_id}'")
                target["entity_id"] = resolved
        return {"kind": "service", "service": service, "target": target, "data": data}
    if item.get("skill") is not None:
        skill = _ensure_dict(item.get("skill"), "skill")
        name = str(skill.get("name") or "").strip()
        if not name:
            raise AutomationValidationError("skill action requires name")
        skill_input = skill.get("input") or {}
        if not isinstance(skill_input, dict):
            raise AutomationValidationError("skill.input must be an object")
        return {"kind": "skill", "name": name, "input": skill_input}
    if item.get("notify") is not None:
        notify = _ensure_dict(item.get("notify"), "notify")
        text = str(notify.get("text") or "").strip()
        if not text:
            raise AutomationValidationError("notify action requires text")
        return {"kind": "notify", "text": text}
    raise AutomationValidationError("Unsupported action. Use service, skill, or notify.")


def validate_source_yaml(source_yaml: str) -> dict:
    text = (source_yaml or "").strip()
    if not text:
        raise AutomationValidationError("source_yaml is empty")
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise AutomationValidationError(f"Invalid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise AutomationValidationError("Top-level YAML must be an object")

    version = raw.get("version", 1)
    try:
        version = int(version)
    except (TypeError, ValueError) as exc:
        raise AutomationValidationError("version must be an integer") from exc
    if version != 1:
        raise AutomationValidationError("Only version 1 is supported")

    title = str(raw.get("title") or "").strip()
    if not title:
        raise AutomationValidationError("title is required")

    automation_id = str(raw.get("id") or _slugify(title)).strip().lower()
    if not _ID_RE.match(automation_id):
        raise AutomationValidationError("id must match ^[a-z0-9][a-z0-9_-]{2,63}$")

    enabled = bool(raw.get("enabled", True))
    channel = str(raw.get("channel") or "web").strip().lower() or "web"
    if channel not in {"web", "whatsapp"}:
        raise AutomationValidationError("channel must be 'web' or 'whatsapp'")

    triggers = raw.get("trigger") or []
    if not isinstance(triggers, list) or not triggers:
        raise AutomationValidationError("trigger must be a non-empty list")
    actions = raw.get("action") or []
    if not isinstance(actions, list) or not actions:
        raise AutomationValidationError("action must be a non-empty list")

    conditions = raw.get("condition") or []
    if conditions and not isinstance(conditions, list):
        raise AutomationValidationError("condition must be a list")

    normalized = {
        "version": version,
        "id": automation_id,
        "title": title,
        "description": str(raw.get("description") or "").strip() or None,
        "enabled": enabled,
        "mode": str(raw.get("mode") or "single").strip().lower() or "single",
        "channel": channel,
        "trigger": [_validate_trigger(item) for item in triggers],
        "condition": [_validate_condition(item) for item in conditions],
        "action": [_validate_action(item) for item in actions],
    }
    return normalized


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
        "channel": definition.channel,
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
    return out


def summarize_action_set(actions: list[dict]) -> list[str]:
    out = []
    for item in actions:
        kind = item.get("kind")
        if kind == "service":
            out.append(item.get("service") or "service")
        elif kind == "skill":
            out.append(f"skill:{item.get('name')}")
        elif kind == "notify":
            out.append("notify")
    return out


def _runtime_job_id(definition_id: str, trigger_index: int) -> str:
    return f"{_RUNTIME_PREFIX}{definition_id}_{trigger_index}"


def list_definition_runtime_jobs(definition_id: str) -> list[dict]:
    prefix = f"{_RUNTIME_PREFIX}{definition_id}_"
    jobs = []
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
    prefix = f"{_RUNTIME_PREFIX}{definition_id}_"
    # Remove APScheduler jobs
    for job in list(getattr(scheduler_service.scheduler, "get_jobs", lambda: [])()):
        if str(getattr(job, "id", "")).startswith(prefix):
            try:
                scheduler_service.scheduler.remove_job(str(job.id))
            except Exception as exc:
                log_detail("automation", "RUNTIME_REMOVE_ERROR", automation_id=definition_id, job_id=str(job.id), error=str(exc))
    # Remove HA websocket state-trigger callbacks
    keys_to_remove = [k for k in _state_trigger_callbacks if k.startswith(prefix)]
    for key in keys_to_remove:
        entity_id, cb = _state_trigger_callbacks.pop(key)
        ha_ws.remove_change(entity_id, cb)


def _hash_triggers(triggers: list[dict]) -> str:
    return hashlib.sha256(json.dumps(triggers, sort_keys=True).encode("utf-8")).hexdigest()


def _schedule_trigger(definition_id: str, trigger_index: int, trigger: dict):
    job_id = _runtime_job_id(definition_id, trigger_index)
    platform = trigger.get("platform")
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
    if platform == "home_assistant_state":
        entity_id = trigger.get("entity_id", "")
        to_state = trigger.get("to", "")
        from_state = trigger.get("from", "")

        async def _state_cb(eid, old, new, attrs, _def_id=definition_id, _idx=trigger_index, _to=to_state, _from=from_state):
            new_norm = str(new or "").strip().lower()
            to_norm = str(_to or "").strip().lower()
            from_norm = str(_from or "").strip().lower()
            old_norm = str(old or "").strip().lower()
            if new_norm != to_norm:
                return
            if from_norm and old_norm != from_norm:
                return
            import threading
            threading.Thread(
                target=execute_automation_definition,
                args=(_def_id, f"trigger:{_idx}"),
                daemon=True,
            ).start()

        _state_trigger_callbacks[job_id] = (entity_id, _state_cb)
        ha_ws.on_change(entity_id, _state_cb)
        return


def sync_runtime(definition: models.AutomationDefinition, db: Session | None = None):
    own_session = False
    if db is None:
        db = database.SessionLocal()
        own_session = True
    try:
        normalized = json.loads(definition.normalized_json)
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


def _current_time_for_window() -> str:
    now = datetime.now()
    return now.strftime("%H:%M")


def _fetch_ha_states_sync() -> list[dict]:
    try:
        return asyncio.run(home_assistant.fetch_ha_states())
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(home_assistant.fetch_ha_states())
        finally:
            loop.close()


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
        elif kind == "home_assistant_state":
            entity_id = condition.get("entity_id")
            target_state = str(condition.get("state") or "")
            try:
                states = _fetch_ha_states_sync()
            except Exception as exc:
                return False, f"Could not read Home Assistant state: {exc}"
            current = None
            for item in states or []:
                if str(item.get("entity_id")) == entity_id:
                    current = str(item.get("state") or "")
                    break
            if current != target_state:
                return False, f"State mismatch for {entity_id}: expected {target_state}, got {current or 'unknown'}"
    return True, None


def _service_call_from_action(action: dict) -> dict:
    service = str(action.get("service") or "")
    domain, service_name = service.split(".", 1)
    out = {
        "domain": domain,
        "service": service_name,
    }
    target = action.get("target") or {}
    if target.get("entity_id"):
        raw_entity = str(target.get("entity_id") or "").strip()
        if "." in raw_entity and " " not in raw_entity:
            out["entity_id"] = raw_entity
        else:
            resolved = device_resolver.resolve_target_sync(raw_entity)
            out["entity_id"] = resolved or raw_entity
    data = action.get("data") or {}
    if data:
        out["service_data"] = data
    return out


def _execute_action_sequence(owner_id: str, channel: str, actions: list[dict]) -> list[str]:
    messages = []
    for action in actions:
        kind = action.get("kind")
        if kind == "service":
            service_call = _service_call_from_action(action)
            result = home_assistant.call_services_sync([service_call])
            ok = bool(result and result[0])
            state = "ok" if ok else "failed"
            messages.append(f"service {action.get('service')} {state}")
        elif kind == "skill":
            skill_name = action.get("name")
            skill_input = action.get("input") or {}
            allow_network = False
            searxng = settings.CFG.get("searxng") or {}
            if searxng.get("enabled") and (searxng.get("url") or "").strip():
                skill_input = dict(skill_input)
                skill_input["_searxng_url"] = searxng["url"].strip()
                allow_network = True
            result = skills.run_skill(skill_name, skill_input, allow_network=allow_network)
            formatted = scheduler_service._format_skill_result(skill_name, result)
            scheduler_service.trigger_notification(owner_id, formatted, channel, notification_type="automation")
            messages.append(f"skill {skill_name} ok")
        elif kind == "notify":
            scheduler_service.trigger_notification(owner_id, action.get("text") or "Automation notification", channel, notification_type="automation")
            messages.append("notify ok")
    return messages


def execute_automation_definition(definition_id: str, trigger_source: str = "manual"):
    db = database.SessionLocal()
    run = None
    try:
        definition = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == definition_id).first()
        if not definition:
            log_detail("automation", "RUN_MISSING_DEFINITION", automation_id=definition_id)
            _remove_runtime_jobs(definition_id)
            return
        normalized = json.loads(definition.normalized_json)
        run = models.AutomationRun(
            automation_id=definition.id,
            status="running",
            trigger_source=trigger_source,
            details_json=json.dumps({"trigger_source": trigger_source}),
        )
        db.add(run)
        db.commit()
        db.refresh(run)

        if not definition.enabled or not normalized.get("enabled", True):
            message = "Automation is disabled"
            definition.last_run_status = "skipped"
            definition.last_error = message
            run.status = "skipped"
            run.message = message
            run.finished_at = datetime.now()
            db.commit()
            return

        conditions_ok, condition_message = _evaluate_conditions(normalized.get("condition") or [])
        if not conditions_ok:
            definition.last_run_at = datetime.now()
            definition.last_run_status = "skipped"
            definition.last_error = condition_message
            run.status = "skipped"
            run.message = condition_message
            run.finished_at = datetime.now()
            db.commit()
            return

        messages = _execute_action_sequence(definition.owner_id, definition.channel, normalized.get("action") or [])
        definition.last_run_at = datetime.now()
        definition.last_run_status = "ok"
        definition.last_error = None
        run.status = "ok"
        run.message = "; ".join(messages) or "Automation executed"
        run.details_json = json.dumps({"messages": messages}, ensure_ascii=False)
        run.finished_at = datetime.now()
        db.commit()
    except Exception as exc:
        log_line("error", "❌", "AUTOMATION", f"Definition run failed for {definition_id}: {exc}")
        if run is not None:
            run.status = "error"
            run.message = str(exc)
            run.finished_at = datetime.now()
        definition = db.query(models.AutomationDefinition).filter(models.AutomationDefinition.id == definition_id).first()
        if definition:
            definition.last_run_at = datetime.now()
            definition.last_run_status = "error"
            definition.last_error = str(exc)
        db.commit()
    finally:
        db.close()


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
        channel=normalized.get("channel") or "web",
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
    definition.channel = normalized.get("channel") or "web"
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