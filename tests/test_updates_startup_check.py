"""Hyve update check on server startup."""

from __future__ import annotations

from unittest.mock import MagicMock

import core.settings as settings
from routers import updates as updates_router


def test_startup_hyve_check_runs_by_default(monkeypatch):
    monkeypatch.setattr(settings, "CFG", {"updates": {"hyve": {}}})
    mock = MagicMock()
    monkeypatch.setattr(updates_router, "_scheduled_hyve_check", mock)

    updates_router.run_startup_hyve_check()

    mock.assert_called_once()


def test_startup_hyve_check_runs_when_enabled(monkeypatch):
    monkeypatch.setattr(settings, "CFG", {"updates": {"hyve": {"check_on_startup": True}}})
    mock = MagicMock()
    monkeypatch.setattr(updates_router, "_scheduled_hyve_check", mock)

    updates_router.run_startup_hyve_check()

    mock.assert_called_once()


def test_startup_hyve_check_skipped_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "CFG", {"updates": {"hyve": {"check_on_startup": False}}})
    mock = MagicMock()
    monkeypatch.setattr(updates_router, "_scheduled_hyve_check", mock)

    updates_router.run_startup_hyve_check()

    mock.assert_not_called()
