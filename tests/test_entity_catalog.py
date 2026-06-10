"""Tests for unified entity catalog."""

from __future__ import annotations

from core import entity_catalog


def test_build_entities_uncached_returns_list(monkeypatch):
    monkeypatch.setattr(
        entity_catalog,
        "get_integration_manager",
        lambda: type(
            "M",
            (),
            {
                "all_instances": lambda self: [],
                "is_bootstrap_eligible": lambda self, i: True,
            },
        )(),
    )
    monkeypatch.setattr(
        entity_catalog,
        "get_entity_store",
        lambda: type(
            "S",
            (),
            {
                "get_entities": lambda self, key: {},
                "get_entities_many": lambda self, keys: {key: {} for key in keys},
                "apply_overrides": lambda self, items: None,
            },
        )(),
    )
    monkeypatch.setattr(entity_catalog.derived_entities, "evaluate_all", lambda state: [])

    items = entity_catalog.build_entities_uncached(include_derived=True, sort_mode="name")
    assert isinstance(items, list)


def test_invalidate_clears_peek_cache(monkeypatch):
    entity_catalog._ENTITY_CACHE[(True, "name")] = {"data": [{"entity_id": "x"}], "t": 999999.0}
    entity_catalog.invalidate_entity_cache()
    assert entity_catalog.peek_cached_entities(include_derived=True, sort_mode="name") is None


def test_dashboard_and_name_use_separate_cache_keys(monkeypatch):
    entity_catalog._ENTITY_CACHE[(False, "dashboard")] = {"data": [{"entity_id": "dash"}], "t": 999999.0}
    entity_catalog._ENTITY_CACHE[(False, "name")] = {"data": [{"entity_id": "name"}], "t": 999999.0}
    assert entity_catalog.peek_cached_entities(include_derived=False, sort_mode="dashboard")[0]["entity_id"] == "dash"
    assert entity_catalog.peek_cached_entities(include_derived=False, sort_mode="name")[0]["entity_id"] == "name"
    entity_catalog.invalidate_entity_cache()
