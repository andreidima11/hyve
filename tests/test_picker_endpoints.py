import asyncio
"""Tests for /api/integrations/picker/* — smart entity/area/domain pickers.

Calls the endpoint functions directly with monkeypatched data sources so
we don't need a running FastAPI test client.
"""

import pytest

from routers.integrations import helpers as integrations_helpers
from routers import integrations as integrations_router


_FAKE_ENTITIES = [
    {"entity_id": "light.kitchen", "friendly_name": "Kitchen Light", "name": "Kitchen Light",
     "area": "Kitchen", "source": "zigbee2mqtt", "controllable": True, "state": "on"},
    {"entity_id": "light.bedroom", "friendly_name": "Bedroom Light", "name": "Bedroom Light",
     "area": "Bedroom", "source": "zigbee2mqtt", "controllable": True, "state": "off"},
    {"entity_id": "switch.fan", "friendly_name": "Fan", "name": "Fan",
     "area": "Bedroom", "source": "mosquitto", "controllable": True, "state": "off"},
    {"entity_id": "sensor.temp", "friendly_name": "Temperature", "name": "Temperature",
     "area": "Kitchen", "source": "open_meteo", "controllable": False, "state": "21.5"},
    {"entity_id": "sensor.no_area", "friendly_name": "Orphan", "name": "Orphan",
     "area": "", "source": "fusion_solar", "controllable": False, "state": ""},
]


@pytest.fixture(autouse=True)
def patch_all_entities(monkeypatch):
    async def _fake():
        return list(_FAKE_ENTITIES)
    monkeypatch.setattr(integrations_helpers, "all_entities", _fake)


class _DummyUser:
    id = 1
    username = "tester"


def test_picker_no_filters_returns_all():
    res = asyncio.run(integrations_router.picker_entities(user=_DummyUser()))
    assert res["total"] == len(_FAKE_ENTITIES)
    assert all("id" in item and "label" in item and "domain" in item for item in res["items"])


def test_picker_filter_by_domain():
    res = asyncio.run(integrations_router.picker_entities(domain="light", user=_DummyUser()))
    assert res["total"] == 2
    assert {item["id"] for item in res["items"]} == {"light.kitchen", "light.bedroom"}


def test_picker_filter_by_source():
    res = asyncio.run(integrations_router.picker_entities(source="zigbee2mqtt", user=_DummyUser()))
    assert res["total"] == 2
    assert all(item["source"] == "zigbee2mqtt" for item in res["items"])


def test_picker_filter_by_area_case_insensitive():
    res = asyncio.run(integrations_router.picker_entities(area="kitchen", user=_DummyUser()))
    assert res["total"] == 2
    assert {item["id"] for item in res["items"]} == {"light.kitchen", "sensor.temp"}


def test_picker_filter_controllable_true():
    res = asyncio.run(integrations_router.picker_entities(controllable=True, user=_DummyUser()))
    assert res["total"] == 3
    assert all(item["controllable"] for item in res["items"])


def test_picker_filter_controllable_false():
    res = asyncio.run(integrations_router.picker_entities(controllable=False, user=_DummyUser()))
    assert res["total"] == 2
    assert all(not item["controllable"] for item in res["items"])


def test_picker_search_substring():
    res = asyncio.run(integrations_router.picker_entities(search="bedroom", user=_DummyUser()))
    assert res["total"] == 1
    assert res["items"][0]["id"] == "light.bedroom"


def test_picker_combined_filters():
    res = asyncio.run(integrations_router.picker_entities(
        domain="light", area="kitchen", controllable=True, user=_DummyUser()
    ))
    assert res["total"] == 1
    assert res["items"][0]["id"] == "light.kitchen"


def test_picker_limit_and_truncated_flag():
    res = asyncio.run(integrations_router.picker_entities(limit=2, user=_DummyUser()))
    assert res["total"] == 2
    assert res["truncated"] is True


def test_picker_domains_counts():
    res = asyncio.run(integrations_router.picker_domains(user=_DummyUser()))
    by_id = {item["id"]: item["count"] for item in res["items"]}
    assert by_id["light"] == 2
    assert by_id["switch"] == 1
    assert by_id["sensor"] == 2


def test_picker_areas(monkeypatch):
    monkeypatch.setattr(
        integrations_router.entities.area_resolver,
        "list_areas",
        lambda: [
            {"name": "Kitchen", "icon": "fa-utensils", "color": "text-amber-400"},
            {"name": "Bedroom", "icon": "fa-bed", "color": "text-indigo-400"},
            {"name": "", "icon": "", "color": ""},  # filtered out
        ],
    )
    res = asyncio.run(integrations_router.picker_areas(user=_DummyUser()))
    ids = [item["id"] for item in res["items"]]
    assert "Kitchen" in ids and "Bedroom" in ids
    assert "" not in ids
