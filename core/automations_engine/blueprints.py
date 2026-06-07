"""Automation blueprints — reusable, parameterized definitions.

A blueprint is a YAML template with ``{{ inputs.<key> }}`` placeholders
and a schema describing each input (label, type, default, required,
choices). Instantiating it substitutes the supplied input values and
emits a normal automation YAML that goes through the regular validator
+ runtime path.

Example blueprint YAML::

    title: "Notify when door opens"
    description: "Generic door-open notifier"
    inputs:
      - id: door_entity
        label: Door sensor
        type: entity
        required: true
      - id: message
        label: Notification text
        type: string
        default: "Door is open"
    template: |
      id: door_open_{{ inputs.door_entity | slug }}
      title: "Door open: {{ inputs.door_entity }}"
      mode: single
      trigger:
        - platform: state
          entity_id: {{ inputs.door_entity }}
          to: open
      action:
        - notify:
            text: "{{ inputs.message }}"

Inputs are validated against the schema before substitution. Type
``entity`` and ``area`` are validated as opaque strings here — the UI is
responsible for offering valid pickers.
"""

from __future__ import annotations

import json
import re
from typing import Any

import yaml
from sqlalchemy.orm import Session

import models
from core.automations_engine.validators import (
    AutomationValidationError,
    _slugify,
    validate_source_yaml,
)


SUPPORTED_INPUT_TYPES = {"string", "number", "boolean", "entity", "area", "select", "duration"}

_PLACEHOLDER_RE = re.compile(r"\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*(\|\s*slug\s*)?\}\}")


def _parse_blueprint_yaml(source_yaml: str) -> dict:
    try:
        data = yaml.safe_load(source_yaml)
    except yaml.YAMLError as exc:
        raise AutomationValidationError(f"Invalid YAML: {exc}")
    if not isinstance(data, dict):
        raise AutomationValidationError("Blueprint must be a mapping at top level")
    if not data.get("template"):
        raise AutomationValidationError("Blueprint must contain a 'template' string")
    if not isinstance(data["template"], str):
        raise AutomationValidationError("Blueprint 'template' must be a string")
    return data


def _validate_inputs_schema(raw_inputs: Any) -> list[dict]:
    if raw_inputs is None:
        return []
    if not isinstance(raw_inputs, list):
        raise AutomationValidationError("Blueprint 'inputs' must be a list")
    seen_ids: set[str] = set()
    out: list[dict] = []
    for idx, raw in enumerate(raw_inputs):
        if not isinstance(raw, dict):
            raise AutomationValidationError(f"inputs[{idx}] must be a mapping")
        input_id = str(raw.get("id") or "").strip()
        if not input_id or not re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*$", input_id):
            raise AutomationValidationError(f"inputs[{idx}].id must be a valid identifier")
        if input_id in seen_ids:
            raise AutomationValidationError(f"Duplicate input id: {input_id!r}")
        seen_ids.add(input_id)
        type_ = str(raw.get("type") or "string").strip().lower()
        if type_ not in SUPPORTED_INPUT_TYPES:
            raise AutomationValidationError(
                f"inputs[{idx}].type {type_!r} not supported (allowed: {sorted(SUPPORTED_INPUT_TYPES)})"
            )
        normalized = {
            "id": input_id,
            "label": str(raw.get("label") or input_id),
            "type": type_,
            "required": bool(raw.get("required", False)),
            "default": raw.get("default"),
        }
        if type_ == "select":
            choices = raw.get("choices") or []
            if not isinstance(choices, list) or not choices:
                raise AutomationValidationError(f"inputs[{idx}] type=select requires non-empty 'choices'")
            normalized["choices"] = [str(c) for c in choices]
        out.append(normalized)
    return out


def parse_blueprint(source_yaml: str) -> dict:
    """Parse + validate a blueprint YAML, returning a normalized dict with
    keys ``title``, ``description``, ``inputs`` (list of input schemas),
    and ``template`` (the raw YAML template string)."""
    data = _parse_blueprint_yaml(source_yaml)
    inputs = _validate_inputs_schema(data.get("inputs"))
    return {
        "title": str(data.get("title") or "Untitled blueprint"),
        "description": str(data.get("description") or ""),
        "inputs": inputs,
        "template": data["template"],
    }


def _coerce_input_value(spec: dict, raw: Any) -> Any:
    type_ = spec["type"]
    if raw is None or raw == "":
        if spec["required"]:
            raise AutomationValidationError(f"Input {spec['id']!r} is required")
        return spec.get("default")
    if type_ == "string":
        return str(raw)
    if type_ == "number":
        try:
            return float(raw) if isinstance(raw, str) and "." in raw else int(raw)
        except (TypeError, ValueError):
            raise AutomationValidationError(f"Input {spec['id']!r} must be numeric")
    if type_ == "boolean":
        if isinstance(raw, bool):
            return raw
        s = str(raw).strip().lower()
        if s in {"true", "1", "yes", "on"}:
            return True
        if s in {"false", "0", "no", "off"}:
            return False
        raise AutomationValidationError(f"Input {spec['id']!r} must be boolean")
    if type_ == "select":
        s = str(raw)
        if s not in spec["choices"]:
            raise AutomationValidationError(
                f"Input {spec['id']!r}={s!r} not in choices {spec['choices']}"
            )
        return s
    if type_ == "duration":
        try:
            return int(raw)
        except (TypeError, ValueError):
            raise AutomationValidationError(f"Input {spec['id']!r} must be a duration in seconds")
    # entity / area: opaque strings
    return str(raw)


def _substitute(template: str, values: dict[str, Any]) -> str:
    def replace(match: re.Match) -> str:
        key = match.group(1)
        modifier = match.group(2)
        if key not in values:
            raise AutomationValidationError(f"Template references unknown input {key!r}")
        val = values[key]
        rendered = _slugify(str(val)) if modifier else str(val)
        return rendered
    return _PLACEHOLDER_RE.sub(replace, template)


def instantiate_blueprint(blueprint_source_yaml: str, input_values: dict[str, Any]) -> dict:
    """Instantiate a blueprint with the given input values.

    Returns a dict with ``automation_yaml`` (the rendered automation YAML
    string) and ``normalized`` (the result of ``validate_source_yaml`` on
    the rendered text). Raises ``AutomationValidationError`` if any input
    is missing/invalid or the rendered YAML fails validation.
    """
    blueprint = parse_blueprint(blueprint_source_yaml)
    coerced: dict[str, Any] = {}
    for spec in blueprint["inputs"]:
        coerced[spec["id"]] = _coerce_input_value(spec, input_values.get(spec["id"]))
    rendered = _substitute(blueprint["template"], coerced)
    normalized = validate_source_yaml(rendered)
    return {"automation_yaml": rendered, "normalized": normalized, "values": coerced}


# --------------------------------------------------------------------------- #
# CRUD                                                                         #
# --------------------------------------------------------------------------- #

def _blueprint_id_from_title(title: str, owner_id: str) -> str:
    slug = _slugify(title)
    return f"bp_{owner_id}_{slug}"[:120]


def create_blueprint(db: Session, owner_id: str, actor: str, source_yaml: str) -> models.AutomationBlueprint:
    parsed = parse_blueprint(source_yaml)
    bp_id = _blueprint_id_from_title(parsed["title"], owner_id)
    if db.query(models.AutomationBlueprint).filter(models.AutomationBlueprint.id == bp_id).first():
        raise AutomationValidationError(f"Blueprint with id {bp_id!r} already exists")
    bp = models.AutomationBlueprint(
        id=bp_id,
        owner_id=owner_id,
        title=parsed["title"],
        description=parsed["description"],
        source_yaml=source_yaml,
        inputs_json=json.dumps(parsed["inputs"], ensure_ascii=False),
        version=1,
        created_by=actor,
        updated_by=actor,
    )
    db.add(bp)
    db.commit()
    db.refresh(bp)
    return bp


def list_blueprints(db: Session, owner_id: str) -> list[models.AutomationBlueprint]:
    return (
        db.query(models.AutomationBlueprint)
        .filter(models.AutomationBlueprint.owner_id == owner_id)
        .order_by(models.AutomationBlueprint.title.asc())
        .all()
    )


def get_blueprint_for_owner(db: Session, blueprint_id: str, owner_id: str) -> models.AutomationBlueprint:
    bp = db.query(models.AutomationBlueprint).filter(
        models.AutomationBlueprint.id == blueprint_id,
        models.AutomationBlueprint.owner_id == owner_id,
    ).first()
    if not bp:
        raise AutomationValidationError(f"Blueprint {blueprint_id!r} not found")
    return bp


def delete_blueprint(db: Session, bp: models.AutomationBlueprint) -> None:
    db.delete(bp)
    db.commit()


def serialize_blueprint(bp: models.AutomationBlueprint) -> dict:
    return {
        "id": bp.id,
        "owner_id": bp.owner_id,
        "title": bp.title,
        "description": bp.description,
        "source_yaml": bp.source_yaml,
        "inputs": json.loads(bp.inputs_json or "[]"),
        "version": bp.version,
        "created_at": bp.created_at.isoformat() if bp.created_at else None,
        "updated_at": bp.updated_at.isoformat() if bp.updated_at else None,
    }
