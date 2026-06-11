"""Dry-run / simulate mode for execute_automation_definition.

Verifies that when ``dry_run=True``:
- The action sequence is walked (so the trace shows what *would* run).
- Side-effecting branches (service / scene / notify / skill) are SUPPRESSED:
  no integration calls, no scheduler notifications, no skill invocations.
- No ``AutomationRun`` row is written and ``last_run_*`` columns stay clean.
- A trace dict is returned to the caller.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.database as database
import core.models as models
import core.automation_definitions as ad


@pytest.fixture()
def db_session(monkeypatch, tmp_path):
    db_path = tmp_path / "dryrun.db"
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


_NOTIFY_YAML = """\
id: dry_notify
title: Dry notify
mode: single
trigger:
  - platform: time
    at: '08:00'
action:
  - notify:
      text: Should NOT actually send
"""


_DELAY_YAML = """\
id: dry_delay
title: Dry delay
mode: single
trigger:
  - platform: time
    at: '08:00'
action:
  - delay:
      seconds: 30
  - notify:
      text: After delay
"""


def test_dry_run_suppresses_notify_and_returns_trace(db_session, monkeypatch):
    ad.create_definition(db_session, owner_id="u1", actor="user:u1", source_yaml=_NOTIFY_YAML)
    sent = []
    # Patch the underlying scheduler call — if dry-run leaks, this list grows.
    import core.scheduler_service as scheduler_service
    monkeypatch.setattr(scheduler_service, "trigger_notification",
                        lambda *a, **kw: sent.append((a, kw)))

    result = ad.execute_automation_definition("dry_notify", "manual", dry_run=True)

    assert result is not None, "dry_run must return a result dict"
    assert result["status"] == "ok"
    assert sent == [], "dry-run must NOT call trigger_notification"
    # Trace must contain the dry_run notify step.
    statuses = [s["status"] for s in result["trace"]["steps"]]
    assert "dry_run" in statuses
    # And no AutomationRun row should have been written.
    runs = db_session.query(models.AutomationRun).all()
    assert runs == []
    # last_run_* should remain untouched.
    defn = db_session.query(models.AutomationDefinition).filter(
        models.AutomationDefinition.id == "dry_notify"
    ).first()
    assert defn.last_run_at is None
    assert defn.last_run_status is None


def test_dry_run_skips_delay_sleep(db_session, monkeypatch):
    """A 30s delay must NOT actually sleep when dry-running — the test would
    time out otherwise."""
    ad.create_definition(db_session, owner_id="u1", actor="user:u1", source_yaml=_DELAY_YAML)
    import time
    slept = []
    monkeypatch.setattr(time, "sleep", lambda s: slept.append(s))

    import core.scheduler_service as scheduler_service
    monkeypatch.setattr(scheduler_service, "trigger_notification",
                        lambda *a, **kw: None)

    result = ad.execute_automation_definition("dry_delay", "manual", dry_run=True)
    assert result["status"] == "ok"
    assert slept == [], "dry-run delay must not sleep"
    # Two action messages: delay + notify.
    assert len(result["messages"]) == 2
    assert "skipped" in result["messages"][0]


def test_dry_run_disabled_definition_reports_skipped(db_session):
    defn = ad.create_definition(db_session, owner_id="u1", actor="user:u1", source_yaml=_NOTIFY_YAML)
    ad.set_enabled(db_session, defn, "user:u1", False, defn.revision)

    result = ad.execute_automation_definition("dry_notify", "manual", dry_run=True)
    assert result["status"] == "skipped"
    assert "disabled" in result["message"].lower()
    # And still no run row.
    assert db_session.query(models.AutomationRun).count() == 0


def test_real_run_still_writes_run_row(db_session, monkeypatch):
    """Sanity: dry_run=False must still create an AutomationRun row."""
    ad.create_definition(db_session, owner_id="u1", actor="user:u1", source_yaml=_NOTIFY_YAML)
    import core.scheduler_service as scheduler_service
    monkeypatch.setattr(scheduler_service, "trigger_notification",
                        lambda *a, **kw: None)

    ad.execute_automation_definition("dry_notify", "manual")

    runs = db_session.query(models.AutomationRun).all()
    assert len(runs) == 1
    assert runs[0].status == "ok"
