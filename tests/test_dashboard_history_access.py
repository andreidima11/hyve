"""Dashboard history API access control tests."""

from __future__ import annotations

import pytest

from core.dashboard.history_access import (
    filter_entity_ids_for_history,
    user_may_access_entity_history,
)


class _User:
    def __init__(self, username: str = "alice", is_admin: bool = False):
        self.username = username
        self.is_admin = is_admin


@pytest.fixture()
def dashboard_with_sensor(monkeypatch):
    store = {
        "pages": [{
            "id": "home",
            "title": "Home",
            "panels": [{
                "id": "panel_1",
                "title": "Main",
                "widgets": [{
                    "id": "w1",
                    "type": "entity",
                    "entity_id": "sensor.temperature",
                }],
            }],
        }],
        "current_page_id": "home",
    }

    def _load_store():
        return store

    monkeypatch.setattr("core.dashboard_store.load_store", _load_store)
    return store


def test_history_allowed_for_dashboard_entity(dashboard_with_sensor):
    user = _User()
    assert user_may_access_entity_history(user, "sensor.temperature") is True


def test_history_denied_for_off_dashboard_entity(dashboard_with_sensor):
    user = _User()
    assert user_may_access_entity_history(user, "sensor.other") is False


def test_history_batch_filters_to_allowed_entities(dashboard_with_sensor):
    user = _User()
    allowed = filter_entity_ids_for_history(
        user,
        ["sensor.temperature", "sensor.other", "sensor.temperature"],
    )
    assert allowed == ["sensor.temperature"]
