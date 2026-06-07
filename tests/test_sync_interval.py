"""sync_interval respects CONFIG_SCHEMA min; live integrations skip background polling."""

from __future__ import annotations

from components.mosquitto.entity import MosquittoEntity
from integrations.base import BaseEntity


class _PollIntegration(BaseEntity):
    slug = "poll_test"
    CONFIG_SCHEMA = [
        {"key": "scan_interval", "type": "number", "default": 300, "min": 30},
    ]

    async def fetch_entities(self):
        return {}

    def extract_entities(self, payload):
        return []


def test_scan_interval_floor_from_schema_min():
    inst = _PollIntegration(entry_data={"scan_interval": 5})
    assert inst.sync_interval({}) == 30


def test_scan_interval_no_schema_min_defaults_to_one():
    class _NoMin(BaseEntity):
        slug = "no_min"
        CONFIG_SCHEMA = [{"key": "scan_interval", "type": "number", "default": 300}]

        async def fetch_entities(self):
            return {}

        def extract_entities(self, payload):
            return []

    inst = _NoMin(entry_data={"scan_interval": 5})
    assert inst.sync_interval({}) == 5


def test_mosquitto_respects_user_scan_interval():
    inst = MosquittoEntity(entry_data={"host": "localhost", "scan_interval": 10})
    assert inst.sync_interval({}) == 10


def test_mosquitto_is_live_push_not_background():
    inst = MosquittoEntity(entry_data={"host": "localhost"})
    assert inst.updates_live is True
    assert inst.uses_background_sync() is False
    assert inst.supports_sync is True
