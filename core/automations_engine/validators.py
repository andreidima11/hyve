"""Source-YAML validators / normalizers for automation definitions.

Pure logic — no DB, no filesystem, no scheduler. The legacy
`automation_definitions` module re-exports everything here under the original
underscore-prefixed names so existing call sites and tests keep working.

Public surface (re-exported from `automation_definitions`):
    - AutomationValidationError
    - validate_source_yaml(source_yaml: str) -> dict
    - _validate_trigger / _validate_condition / _validate_action /
      _validate_service_action / _validate_weekdays
    - small parsing helpers (_slugify, _parse_time_string, …)
"""

from __future__ import annotations

import json
import re
from datetime import datetime

import yaml

from .schema import (
    ENTITY_ID_RE,
    SERVICE_DATA_MAX_BYTES,
    SERVICE_DATA_SCALAR_TYPES,
    SUPPORTED_MODES,
    SUPPORTED_SERVICE_VERBS,
    SUPPORTED_WEEKDAYS,
)


class AutomationValidationError(ValueError):
    pass


# Regexes that don't belong in schema (they're used only here).
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")
    if len(slug) < 3:
        slug = f"automation_{slug or 'item'}"
    return slug[:64]


def _parse_time_string(value: str) -> tuple[int, int]:
    text = str(value or "").strip()
    match = TIME_RE.match(text)
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


def _coerce_duration_seconds(value) -> float:
    """Accept ``5`` (seconds), ``"5"``, ``"00:01:30"`` (HH:MM:SS), or
    ``{seconds, minutes, hours}`` dict. Returns total seconds (float)."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if ":" in text:
            parts = text.split(":")
            try:
                nums = [float(p) for p in parts]
            except ValueError as exc:
                raise AutomationValidationError(f"Invalid duration '{text}'") from exc
            if len(nums) == 2:
                return nums[0] * 60 + nums[1]
            if len(nums) == 3:
                return nums[0] * 3600 + nums[1] * 60 + nums[2]
            raise AutomationValidationError(f"Invalid duration '{text}'")
        try:
            return float(text)
        except ValueError as exc:
            raise AutomationValidationError(f"Invalid duration '{text}'") from exc
    if isinstance(value, dict):
        total = 0.0
        for key, mult in (("seconds", 1.0), ("minutes", 60.0), ("hours", 3600.0)):
            if key in value:
                try:
                    total += float(value[key]) * mult
                except (TypeError, ValueError) as exc:
                    raise AutomationValidationError(f"Invalid duration.{key}") from exc
        return total
    raise AutomationValidationError("Duration must be a number, HH:MM[:SS] string, or dict")


def _coerce_signed_duration_seconds(value) -> float:
    """Same as ``_coerce_duration_seconds`` but accepts negative offsets
    (``-00:30:00``) used by sun trigger offsets."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        sign = 1.0
        if text.startswith("-"):
            sign = -1.0
            text = text[1:]
        elif text.startswith("+"):
            text = text[1:]
        return sign * _coerce_duration_seconds(text)
    return _coerce_duration_seconds(value)


def _validate_weekdays(value) -> list[str]:
    weekdays = value or []
    if not isinstance(weekdays, list):
        raise AutomationValidationError("weekdays must be a list")
    normalized: list[str] = []
    for item in weekdays:
        weekday = str(item or "").strip().lower()
        if weekday not in SUPPORTED_WEEKDAYS:
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
        return {"platform": "datetime", "at": _parse_datetime_string(at).isoformat()}
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
    if platform == "state":
        entity_id = str(item.get("entity_id") or "").strip()
        if not entity_id:
            raise AutomationValidationError("state trigger requires entity_id")
        out = {"platform": "state", "entity_id": entity_id}
        # Optional: only fire when transitioning FROM a specific state, or
        # TO a specific state. YAML on/off booleans are normalized.
        for key in ("to", "from"):
            val = item.get(key)
            if val is None:
                continue
            if isinstance(val, bool):
                val = "on" if val else "off"
            out[key] = str(val).strip()
        return out
    if platform == "numeric_state":
        entity_id = str(item.get("entity_id") or "").strip()
        if not entity_id:
            raise AutomationValidationError("numeric_state trigger requires entity_id")
        above = item.get("above")
        below = item.get("below")
        if above is None and below is None:
            raise AutomationValidationError("numeric_state trigger requires above and/or below")
        out = {"platform": "numeric_state", "entity_id": entity_id}
        if above is not None:
            try:
                out["above"] = float(above)
            except (TypeError, ValueError) as exc:
                raise AutomationValidationError("numeric_state.above must be a number") from exc
        if below is not None:
            try:
                out["below"] = float(below)
            except (TypeError, ValueError) as exc:
                raise AutomationValidationError("numeric_state.below must be a number") from exc
        attr = item.get("attribute")
        if attr:
            out["attribute"] = str(attr).strip()
        return out
    if platform == "template":
        value_template = str(item.get("value_template") or item.get("template") or "").strip()
        if not value_template:
            raise AutomationValidationError("template trigger requires value_template")
        from core import automation_template
        try:
            automation_template._env.from_string(value_template)
        except Exception as exc:
            raise AutomationValidationError(f"Invalid template: {exc}") from exc
        return {"platform": "template", "value_template": value_template}
    if platform == "sun":
        event = str(item.get("event") or "").strip().lower()
        if event not in {"sunrise", "sunset"}:
            raise AutomationValidationError("sun trigger requires event: sunrise|sunset")
        out = {"platform": "sun", "event": event}
        offset = item.get("offset")
        if offset is not None:
            out["offset"] = _coerce_signed_duration_seconds(offset)
        return out
    if platform == "event":
        event_type = str(item.get("event_type") or "").strip()
        if not event_type:
            raise AutomationValidationError("event trigger requires event_type")
        out = {"platform": "event", "event_type": event_type}
        ed = item.get("event_data")
        if ed is not None:
            if not isinstance(ed, dict):
                raise AutomationValidationError("event_data must be an object")
            out["event_data"] = ed
        return out
    if platform == "time_pattern":
        out = {"platform": "time_pattern"}
        for key in ("hours", "minutes", "seconds"):
            val = item.get(key)
            if val is None:
                continue
            # Accept '*', '/5', or int.
            sval = str(val).strip()
            if not sval:
                continue
            out[key] = sval
        if not (set(out) - {"platform"}):
            raise AutomationValidationError("time_pattern requires hours/minutes/seconds")
        return out
    raise AutomationValidationError(f"Unsupported trigger platform '{platform}'")


def _validate_condition(item: dict) -> dict:
    if not isinstance(item, dict):
        raise AutomationValidationError("Each condition must be an object")
    kind = str(item.get("kind") or "").strip().lower()
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
    if kind == "state":
        entity_id = str(item.get("entity_id") or "").strip()
        if not entity_id:
            raise AutomationValidationError("state condition requires entity_id")
        state = item.get("state")
        if state is None or (isinstance(state, str) and not state.strip()):
            raise AutomationValidationError("state condition requires state")
        # YAML treats `on`/`off`/`yes`/`no` as booleans — translate them back
        # to canonical lowercase strings so authors can write the natural form.
        if isinstance(state, bool):
            state = "on" if state else "off"
        out = {"kind": "state", "entity_id": entity_id, "state": str(state).strip()}
        op = str(item.get("operator") or "==").strip()
        if op not in {"==", "!="}:
            raise AutomationValidationError("state operator must be '==' or '!='")
        out["operator"] = op
        return out
    if kind == "numeric_state":
        entity_id = str(item.get("entity_id") or "").strip()
        if not entity_id:
            raise AutomationValidationError("numeric_state condition requires entity_id")
        above = item.get("above")
        below = item.get("below")
        if above is None and below is None:
            raise AutomationValidationError("numeric_state requires above and/or below")
        out = {"kind": "numeric_state", "entity_id": entity_id}
        if above is not None:
            try:
                out["above"] = float(above)
            except (TypeError, ValueError) as exc:
                raise AutomationValidationError("numeric_state.above must be a number") from exc
        if below is not None:
            try:
                out["below"] = float(below)
            except (TypeError, ValueError) as exc:
                raise AutomationValidationError("numeric_state.below must be a number") from exc
        attr = item.get("attribute")
        if attr:
            out["attribute"] = str(attr).strip()
        return out
    raise AutomationValidationError(f"Unsupported condition kind '{kind}'")


def _validate_service_action(item: dict) -> dict:
    """Accept both HA-style (`service: light.turn_on` + `target.entity_id`)
    and Hyve-legacy (`service: turn_on` + `entity_id`) shapes; normalize to the
    internal form `{kind, service, entity_id, data?}`.

    Security guards: action verb allowlist, strict entity_id format,
    domain/entity consistency, target key allowlist (no area/device yet),
    flat scalar-only data dict with size cap.
    """
    raw_service = str(item.get("service") or "").strip().lower()
    if not raw_service:
        raise AutomationValidationError("service action requires service name")

    domain = ""
    if "." in raw_service:
        domain, _, verb = raw_service.partition(".")
        domain = domain.strip()
        verb = verb.strip()
        if not domain or not verb:
            raise AutomationValidationError(
                "service must be `domain.verb` (e.g. light.turn_on) or a bare verb"
            )
    else:
        verb = raw_service

    if verb not in SUPPORTED_SERVICE_VERBS:
        raise AutomationValidationError(
            "service verb must be one of: " + ", ".join(sorted(SUPPORTED_SERVICE_VERBS))
        )

    entity_id = ""
    target = item.get("target")
    if target is not None:
        if not isinstance(target, dict):
            raise AutomationValidationError("service.target must be an object")
        allowed = {"entity_id"}
        unsupported = {"area_id", "device_id", "label_id", "floor_id"}
        extra = set(target.keys()) - allowed - unsupported
        if extra:
            raise AutomationValidationError(
                f"service.target has unsupported key(s): {sorted(extra)}"
            )
        bad = set(target.keys()) & unsupported
        if bad:
            raise AutomationValidationError(
                f"service.target.{sorted(bad)[0]} is not supported yet"
            )
        entity_id = str(target.get("entity_id") or "").strip()

    if not entity_id:
        entity_id = str(item.get("entity_id") or "").strip()

    if not entity_id:
        raise AutomationValidationError("service action requires entity_id")

    if not ENTITY_ID_RE.match(entity_id):
        raise AutomationValidationError(
            f"entity_id {entity_id!r} must match `<domain>.<object_id>` (lowercase, [a-z0-9_])"
        )

    if domain and entity_id.split(".", 1)[0] != domain:
        raise AutomationValidationError(
            f"service domain {domain!r} does not match entity_id domain "
            f"{entity_id.split('.', 1)[0]!r}"
        )

    raw_data = item.get("data")
    data: dict | None = None
    if raw_data not in (None, {}):
        if not isinstance(raw_data, dict):
            raise AutomationValidationError("service.data must be an object")
        for key, value in raw_data.items():
            if not isinstance(key, str) or not key:
                raise AutomationValidationError("service.data keys must be non-empty strings")
            if isinstance(value, (dict, list, tuple, set)):
                raise AutomationValidationError(
                    f"service.data.{key} must be a scalar (no nested structures yet)"
                )
            if not isinstance(value, SERVICE_DATA_SCALAR_TYPES):
                raise AutomationValidationError(
                    f"service.data.{key} has unsupported type {type(value).__name__}"
                )
        try:
            encoded = json.dumps(raw_data, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise AutomationValidationError(
                f"service.data is not JSON-serializable: {exc}"
            ) from exc
        if len(encoded) > SERVICE_DATA_MAX_BYTES:
            raise AutomationValidationError(
                f"service.data exceeds {SERVICE_DATA_MAX_BYTES} bytes"
            )
        data = dict(raw_data)

    out = {"kind": "service", "service": verb, "entity_id": entity_id}
    if data is not None:
        out["data"] = data
    return out


def _validate_action(item: dict) -> dict:
    if not isinstance(item, dict):
        raise AutomationValidationError("Each action must be an object")
    if item.get("service") is not None:
        return _validate_service_action(item)
    if item.get("scene") is not None:
        scene_id = str(item.get("scene") or "").strip()
        if not scene_id:
            raise AutomationValidationError("scene action requires scene id")
        # Accept both "scene.living" and bare "living".
        if scene_id.startswith("scene."):
            scene_id = scene_id.split(".", 1)[1]
        return {"kind": "scene", "scene_id": scene_id}
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
    if item.get("delay") is not None:
        seconds = _coerce_duration_seconds(item.get("delay"))
        if seconds <= 0:
            raise AutomationValidationError("delay must be > 0 seconds")
        if seconds > 24 * 3600:
            raise AutomationValidationError("delay must be <= 24h")
        return {"kind": "delay", "seconds": seconds}
    if item.get("wait_template") is not None:
        tmpl = str(item.get("wait_template") or "").strip()
        if not tmpl:
            raise AutomationValidationError("wait_template requires a template string")
        from core import automation_template
        try:
            automation_template._env.from_string(tmpl)
        except Exception as exc:
            raise AutomationValidationError(f"Invalid wait_template: {exc}") from exc
        timeout_raw = item.get("timeout", 60)
        timeout = _coerce_duration_seconds(timeout_raw)
        if timeout <= 0 or timeout > 3600:
            raise AutomationValidationError("wait_template.timeout must be 1..3600 seconds")
        out = {"kind": "wait_template", "template": tmpl, "timeout": timeout}
        if item.get("continue_on_timeout") is not None:
            out["continue_on_timeout"] = bool(item.get("continue_on_timeout"))
        return out
    if item.get("repeat") is not None:
        repeat = _ensure_dict(item.get("repeat"), "repeat")
        try:
            count = int(repeat.get("count"))
        except (TypeError, ValueError) as exc:
            raise AutomationValidationError("repeat.count must be an integer") from exc
        if count < 1 or count > 1000:
            raise AutomationValidationError("repeat.count must be 1..1000")
        inner = repeat.get("actions")
        if not isinstance(inner, list) or not inner:
            raise AutomationValidationError("repeat.actions must be a non-empty list")
        validated = [_validate_action(sub) for sub in inner]
        return {"kind": "repeat", "count": count, "actions": validated}
    if item.get("choose") is not None:
        choose = item.get("choose")
        if not isinstance(choose, list) or not choose:
            raise AutomationValidationError("choose must be a non-empty list")
        from core import automation_template
        out_choices = []
        for idx, branch in enumerate(choose):
            if not isinstance(branch, dict):
                raise AutomationValidationError(f"choose[{idx}] must be an object")
            cond = branch.get("condition") or branch.get("conditions")
            actions = branch.get("sequence") or branch.get("actions")
            if not isinstance(actions, list) or not actions:
                raise AutomationValidationError(f"choose[{idx}].sequence must be a non-empty list")
            inner_actions = [_validate_action(a) for a in actions]
            inner_conds: list[dict] = []
            if cond is not None:
                if isinstance(cond, str):
                    try:
                        automation_template._env.from_string(cond)
                    except Exception as exc:
                        raise AutomationValidationError(f"choose[{idx}] template error: {exc}") from exc
                    inner_conds.append({"kind": "template", "template": cond})
                elif isinstance(cond, list):
                    inner_conds = [_validate_condition(c) for c in cond]
                elif isinstance(cond, dict):
                    inner_conds = [_validate_condition(cond)]
                else:
                    raise AutomationValidationError(f"choose[{idx}].condition has unsupported type")
            out_choices.append({"conditions": inner_conds, "actions": inner_actions})
        default_actions = item.get("default")
        default_validated: list[dict] = []
        if default_actions is not None:
            if not isinstance(default_actions, list):
                raise AutomationValidationError("choose.default must be a list")
            default_validated = [_validate_action(a) for a in default_actions]
        return {"kind": "choose", "choices": out_choices, "default": default_validated}
    raise AutomationValidationError("Unsupported action. Use service, scene, skill, notify, delay, wait_template, repeat, or choose.")


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
    if not ID_RE.match(automation_id):
        raise AutomationValidationError("id must match ^[a-z0-9][a-z0-9_-]{2,63}$")

    enabled = bool(raw.get("enabled", True))
    triggers = raw.get("trigger") or []
    if not isinstance(triggers, list) or not triggers:
        raise AutomationValidationError("trigger must be a non-empty list")
    actions = raw.get("action") or []
    if not isinstance(actions, list) or not actions:
        raise AutomationValidationError("action must be a non-empty list")

    conditions = raw.get("condition") or []
    if conditions and not isinstance(conditions, list):
        raise AutomationValidationError("condition must be a list")

    mode = str(raw.get("mode") or "single").strip().lower() or "single"
    if mode not in SUPPORTED_MODES:
        raise AutomationValidationError("mode must be single|restart|queued|parallel")

    variables = raw.get("variables") or {}
    if variables and not isinstance(variables, dict):
        raise AutomationValidationError("variables must be a mapping")
    norm_vars: dict[str, str] = {}
    for vk, vv in variables.items():
        key = str(vk).strip()
        if not key or not key.replace("_", "").isalnum():
            raise AutomationValidationError(f"variable name '{vk}' must be alphanumeric/underscore")
        norm_vars[key] = vv if isinstance(vv, str) else json.dumps(vv)

    normalized = {
        "version": version,
        "id": automation_id,
        "title": title,
        "description": str(raw.get("description") or "").strip() or None,
        "enabled": enabled,
        "mode": mode,
        "variables": norm_vars,
        "trigger": [_validate_trigger(item) for item in triggers],
        "condition": [_validate_condition(item) for item in conditions],
        "action": [_validate_action(item) for item in actions],
    }
    return normalized


def lint_definition(normalized: dict) -> list[dict]:
    """Return non-fatal warnings about a normalized automation.

    Each warning: ``{"code": str, "severity": "info"|"warning", "message": str, "path": str}``.
    Warnings are advisory — they never block validation. The editor surfaces
    them in a sidebar panel so users can spot common issues (no actions,
    duplicate triggers, suspicious delay, etc.) before saving.
    """
    warnings: list[dict] = []

    actions = normalized.get("action") or []
    triggers = normalized.get("trigger") or []
    conditions = normalized.get("condition") or []

    if not actions:
        warnings.append({"code": "no_actions", "severity": "warning",
                         "message": "Automation has no actions — it will be a no-op.",
                         "path": "action"})
    if not normalized.get("enabled", True):
        warnings.append({"code": "disabled", "severity": "info",
                         "message": "Automation is disabled — triggers will not fire.",
                         "path": "enabled"})

    # Duplicate trigger detection (same platform + same key fields).
    seen_trigger_sigs: set[str] = set()
    for idx, trig in enumerate(triggers):
        sig = json.dumps(trig, sort_keys=True, default=str)
        if sig in seen_trigger_sigs:
            warnings.append({"code": "duplicate_trigger", "severity": "warning",
                             "message": f"Trigger #{idx + 1} duplicates an earlier trigger.",
                             "path": f"trigger[{idx}]"})
        seen_trigger_sigs.add(sig)

    # Suspicious long delay (> 1h) or zero/negative delay.
    def _walk_actions(items: list, base_path: str) -> None:
        for i, act in enumerate(items):
            path = f"{base_path}[{i}]"
            kind = act.get("kind") if isinstance(act, dict) else None
            if kind == "delay":
                seconds = act.get("seconds", 0)
                if seconds is not None and seconds <= 0:
                    warnings.append({"code": "zero_delay", "severity": "info",
                                     "message": f"Delay of {seconds}s is a no-op.",
                                     "path": path})
                elif seconds and seconds > 3600:
                    warnings.append({"code": "long_delay", "severity": "info",
                                     "message": f"Delay of {seconds}s (~{round(seconds / 3600, 1)}h) is unusually long.",
                                     "path": path})
            elif kind == "repeat":
                _walk_actions(act.get("actions") or [], f"{path}.actions")
            elif kind == "choose":
                for ci, choice in enumerate(act.get("choices") or []):
                    _walk_actions(choice.get("actions") or [], f"{path}.choices[{ci}].actions")
                _walk_actions(act.get("default") or [], f"{path}.default")
    _walk_actions(actions, "action")

    # Trigger without condition AND with destructive-looking action ids.
    if triggers and not conditions:
        destructive = any(
            isinstance(act, dict) and act.get("kind") == "service"
            and any(tok in str(act.get("service") or "").lower() for tok in ("turn_off", "delete", "disable"))
            for act in actions
        )
        if destructive:
            warnings.append({"code": "no_guard", "severity": "info",
                             "message": "Destructive action without any condition — runs unconditionally on every trigger.",
                             "path": "condition"})

    return warnings
