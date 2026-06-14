"""Regression tests for context optimizations (Tier A + Tier B)."""

import asyncio

from brain.cortex.agent_helpers import _DEVICE_QUERY_TOOL_NAMES
from brain.cortex.messages import _trim_messages_to_fit
from brain.cortex.prompt_cache import _prompt_cache_config_snapshot, _prompt_cache_fingerprint
from brain.toolbox.handlers.device import _HOME_STATUS_MAX_ENTITIES, _exec_get_home_status


def test_device_query_tool_names_are_minimal_device_set():
    assert "get_home_status" in _DEVICE_QUERY_TOOL_NAMES
    assert "search_web" not in _DEVICE_QUERY_TOOL_NAMES
    assert len(_DEVICE_QUERY_TOOL_NAMES) == 6


def test_trim_keeps_latest_user_after_tool_messages():
    system = {"role": "system", "content": "sys " * 50}
    user = {"role": "user", "content": "What is the temperature?"}
    assistant = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "c1", "function": {"name": "get_home_status", "arguments": "{}"}}],
    }
    tool = {"role": "tool", "tool_call_id": "c1", "content": "Living room: 22C\n" * 200}
    messages = [system, user, assistant, tool]
    trimmed = _trim_messages_to_fit(messages, 800, reserve_for_response=128, model_name="")
    roles = [m["role"] for m in trimmed]
    assert "user" in roles
    assert trimmed[-1]["role"] in ("tool", "assistant", "user")


def test_selected_entities_cap_in_prompt():
    from brain.cortex.prompt import _build_dynamic_prompt_suffix

    entities = [
        {"entity_id": f"sensor.{i}", "name": f"Sensor {i}", "selected": True, "state": i}
        for i in range(30)
    ]
    suffix = _build_dynamic_prompt_suffix(selected_entities=entities, light_context=False)
    assert "[SELECTED ENTITIES]" in suffix
    assert "sensor.19" in suffix
    assert "sensor.29" not in suffix
    assert "more selected entities" in suffix


def test_compact_knowledge_cutoff_for_tendency_three(monkeypatch):
    import core.settings as settings_mod
    from brain.cortex.prompt import _build_dynamic_prompt_suffix

    cfg = dict(settings_mod.CFG)
    intel = dict(cfg.get("intelligence") or {})
    intel["knowledge_cutoff"] = "2024-01"
    intel["search_tendency"] = 3
    cfg["intelligence"] = intel
    monkeypatch.setattr(settings_mod, "CFG", cfg)

    suffix = _build_dynamic_prompt_suffix()
    assert "[KNOWLEDGE CUTOFF]" in suffix
    assert "MUST use search_web when:" not in suffix
    assert "search_web" in suffix


def test_tool_result_max_chars_default_is_tier_b():
    import core.settings as settings_mod

    assert int((settings_mod.CFG.get("intelligence") or {}).get("tool_result_max_chars")) == 3000


def test_get_home_status_caps_large_entity_lists(monkeypatch):
    entities = []
    for i in range(60):
        entities.append(
            {
                "entity_id": f"sensor.device_{i}",
                "name": f"Device {i}",
                "state": "on",
                "area": f"Area {i % 5}",
                "attributes": {},
            }
        )

    class _FakeStore:
        def get_all_entities(self):
            return entities

    monkeypatch.setattr("addons.entity_store.get_entity_store", lambda: _FakeStore())

    result = asyncio.run(_exec_get_home_status({}))
    assert "60 entities" in result
    assert f"showing {_HOME_STATUS_MAX_ENTITIES}" in result
    assert "more entities omitted" in result
    assert len(result) <= 3200


def test_prompt_cache_fingerprint_ignores_unrelated_config(monkeypatch):
    import core.settings as settings_mod

    base_fp = _prompt_cache_fingerprint("user1", None)
    cfg = dict(settings_mod.CFG)
    cfg["server_name"] = "Totally Different Server Name"
    cfg["port"] = 9999
    monkeypatch.setattr(settings_mod, "CFG", cfg)
    assert _prompt_cache_fingerprint("user1", None) == base_fp


def test_prompt_cache_config_snapshot_is_bounded(monkeypatch):
    import core.settings as settings_mod

    monkeypatch.setattr(
        settings_mod,
        "CFG",
        {
            "prompts": {"system": "x"},
            "intelligence": {"lazy_history": True},
            "security": {},
            "skills_disabled": [],
            "personas": {"default": {"name": "Default"}},
            "backup": {"remote": {"s3": {"bucket": "x" * 5000}}},
        },
    )
    snap = _prompt_cache_config_snapshot()
    snap_chars = len(str(snap))
    backup_chars = len(str(settings_mod.CFG["backup"]))
    assert "backup" not in snap
    assert snap_chars < backup_chars / 2
