"""Owner-isolation regression tests for automation_definitions storage helpers.

These pin down the security contract that automations created by user A
must not be visible/editable/deletable by user B. Uses an isolated in-memory
SQLite engine so no test data leaks into the real users.db.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi import HTTPException

import core.database as database
import core.models as models
import core.automation_definitions as ad


@pytest.fixture()
def db_session(monkeypatch, tmp_path):
    """Spin up a fresh on-disk SQLite for each test (isolated from users.db)
    so the AutomationDefinition + AutomationRun tables exist with the real
    schema. Patches the module-level engine so storage helpers use it."""
    db_path = tmp_path / "isolation.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SessionLocal = sessionmaker(bind=engine)
    database.Base.metadata.create_all(bind=engine)
    # Redirect storage helpers to the test DB.
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)
    monkeypatch.setattr(database, "engine", engine)
    # Redirect the YAML root so we don't pollute the real automations/ folder.
    monkeypatch.setattr(ad, "AUTOMATIONS_ROOT", str(tmp_path / "automations"))
    sess = SessionLocal()
    try:
        yield sess
    finally:
        sess.close()


_VALID_YAML = """\
id: alpha_one
title: Alpha
mode: single
trigger:
  - platform: time
    at: '08:00'
action:
  - notify:
      text: Hello
"""


def test_get_definition_for_owner_returns_definition_to_owner(db_session):
    ad.create_definition(db_session, owner_id="user_1", actor="user:alpha", source_yaml=_VALID_YAML)
    found = ad.get_definition_for_owner(db_session, "alpha_one", "user_1")
    assert found.id == "alpha_one"
    assert found.owner_id == "user_1"


def test_get_definition_for_owner_blocks_other_owners(db_session):
    ad.create_definition(db_session, owner_id="user_1", actor="user:alpha", source_yaml=_VALID_YAML)
    with pytest.raises(HTTPException) as exc:
        ad.get_definition_for_owner(db_session, "alpha_one", "user_2")
    assert exc.value.status_code == 404


def test_list_definitions_only_returns_own_items(db_session):
    ad.create_definition(db_session, owner_id="user_1", actor="user:alpha", source_yaml=_VALID_YAML)
    ad.create_definition(db_session, owner_id="user_2", actor="user:bravo",
                         source_yaml=_VALID_YAML.replace("alpha_one", "bravo_one"))
    items_alpha = ad.list_definitions(db_session, "user_1")
    items_bravo = ad.list_definitions(db_session, "user_2")
    assert {item.id for item in items_alpha} == {"alpha_one"}
    assert {item.id for item in items_bravo} == {"bravo_one"}


def test_replace_definition_requires_matching_revision(db_session):
    defn = ad.create_definition(db_session, owner_id="user_1", actor="user:alpha", source_yaml=_VALID_YAML)
    with pytest.raises(HTTPException) as exc:
        ad.replace_definition(db_session, defn, actor="user:alpha",
                              source_yaml=_VALID_YAML, expected_revision=999)
    assert exc.value.status_code == 409


def test_id_collision_across_owners_is_rejected(db_session):
    """`id` is the table primary key — two users cannot both have an
    automation called 'alpha_one'. The second create must 409, not silently
    overwrite or shadow the first."""
    ad.create_definition(db_session, owner_id="user_1", actor="user:alpha", source_yaml=_VALID_YAML)
    with pytest.raises(HTTPException) as exc:
        ad.create_definition(db_session, owner_id="user_2", actor="user:bravo", source_yaml=_VALID_YAML)
    assert exc.value.status_code == 409
