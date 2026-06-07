"""Tests for automation blueprints — parse, validate inputs, instantiate."""

import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import database
import models
import automation_definitions as ad
from core.automations_engine import blueprints as bp_engine
from core.automations_engine.validators import AutomationValidationError


@pytest.fixture()
def db_session(monkeypatch, tmp_path):
    db_path = tmp_path / "bp.db"
    engine = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(bind=engine)
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(ad, "AUTOMATIONS_ROOT", str(tmp_path / "automations"))
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.close()


_DOOR_BLUEPRINT = """\
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
"""


def test_parse_blueprint_extracts_inputs():
    parsed = bp_engine.parse_blueprint(_DOOR_BLUEPRINT)
    assert parsed["title"] == "Notify when door opens"
    assert len(parsed["inputs"]) == 2
    door = parsed["inputs"][0]
    assert door["id"] == "door_entity"
    assert door["type"] == "entity"
    assert door["required"] is True
    msg = parsed["inputs"][1]
    assert msg["default"] == "Door is open"


def test_parse_blueprint_rejects_missing_template():
    with pytest.raises(AutomationValidationError, match="template"):
        bp_engine.parse_blueprint("title: foo\ninputs: []")


def test_parse_blueprint_rejects_unknown_input_type():
    src = "title: x\ninputs:\n  - id: foo\n    type: weird\ntemplate: 'x'"
    with pytest.raises(AutomationValidationError, match="not supported"):
        bp_engine.parse_blueprint(src)


def test_parse_blueprint_rejects_duplicate_input_id():
    src = ("title: x\ninputs:\n"
           "  - id: foo\n    type: string\n"
           "  - id: foo\n    type: string\n"
           "template: 'x'")
    with pytest.raises(AutomationValidationError, match="Duplicate input"):
        bp_engine.parse_blueprint(src)


def test_instantiate_substitutes_and_validates():
    result = bp_engine.instantiate_blueprint(
        _DOOR_BLUEPRINT,
        {"door_entity": "binary_sensor.front_door", "message": "Front door opened!"},
    )
    rendered = result["automation_yaml"]
    assert "binary_sensor.front_door" in rendered
    assert "Front door opened!" in rendered
    # The slug filter should have produced a safe id.
    assert "door_open_binary_sensor_front_door" in rendered
    # And the rendered YAML must round-trip through the real validator.
    assert result["normalized"]["id"] == "door_open_binary_sensor_front_door"


def test_instantiate_rejects_missing_required_input():
    with pytest.raises(AutomationValidationError, match="required"):
        bp_engine.instantiate_blueprint(_DOOR_BLUEPRINT, {"message": "x"})


def test_instantiate_uses_default_when_input_omitted():
    result = bp_engine.instantiate_blueprint(
        _DOOR_BLUEPRINT, {"door_entity": "binary_sensor.back_door"}
    )
    assert "Door is open" in result["automation_yaml"]


def test_instantiate_rejects_unknown_placeholder():
    bad = _DOOR_BLUEPRINT.replace("{{ inputs.message }}", "{{ inputs.nope }}")
    with pytest.raises(AutomationValidationError, match="unknown input"):
        bp_engine.instantiate_blueprint(bad, {"door_entity": "x"})


def test_select_input_validates_choices():
    src = ("title: x\ninputs:\n"
           "  - id: mode\n    type: select\n    choices: [a, b, c]\n    required: true\n"
           "template: 'id: t\\ntitle: t\\nmode: single\\ntrigger: []\\naction: []\\n'")
    with pytest.raises(AutomationValidationError, match="not in choices"):
        bp_engine.instantiate_blueprint(src, {"mode": "x"})


def test_create_and_list_blueprint(db_session):
    bp = bp_engine.create_blueprint(db_session, "u1", "user:u1", _DOOR_BLUEPRINT)
    assert bp.title == "Notify when door opens"
    assert json.loads(bp.inputs_json)[0]["id"] == "door_entity"
    items = bp_engine.list_blueprints(db_session, "u1")
    assert len(items) == 1
    # Other owner sees nothing.
    assert bp_engine.list_blueprints(db_session, "u2") == []


def test_get_blueprint_for_owner_blocks_others(db_session):
    bp_engine.create_blueprint(db_session, "u1", "user:u1", _DOOR_BLUEPRINT)
    bp = bp_engine.list_blueprints(db_session, "u1")[0]
    with pytest.raises(AutomationValidationError, match="not found"):
        bp_engine.get_blueprint_for_owner(db_session, bp.id, "u2")


def test_instantiate_via_crud_creates_definition(db_session):
    bp = bp_engine.create_blueprint(db_session, "u1", "user:u1", _DOOR_BLUEPRINT)
    result = bp_engine.instantiate_blueprint(
        bp.source_yaml, {"door_entity": "binary_sensor.kitchen_door"}
    )
    defn = ad.create_definition(
        db_session, owner_id="u1", actor="user:u1", source_yaml=result["automation_yaml"]
    )
    assert defn.id == "door_open_binary_sensor_kitchen_door"
    assert defn.owner_id == "u1"
