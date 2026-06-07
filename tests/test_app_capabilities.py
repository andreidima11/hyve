import importlib.util
import sys
import types
from pathlib import Path


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_APP_CAPABILITIES_PATH = Path(__file__).resolve().parent.parent / "brain" / "app_capabilities.py"
_SPEC = importlib.util.spec_from_file_location("app_capabilities_under_test", _APP_CAPABILITIES_PATH)
app_capabilities = importlib.util.module_from_spec(_SPEC)
assert _SPEC and _SPEC.loader
_SPEC.loader.exec_module(app_capabilities)


def _empty_manifest():
    return {
        "themes": [],
        "cards": [],
        "integrations": [],
        "automation_triggers": [],
        "api_areas": [],
        "tools_enabled": {},
        "ui": {},
    }


def test_widget_delete_help_topic_is_listed():
    assert "dashboard.widgets.delete" in app_capabilities.list_help_topics()


def test_widget_delete_help_resolves_romanian_synonyms(monkeypatch):
    monkeypatch.setattr(app_capabilities, "get_capabilities_manifest", _empty_manifest)

    help_text = app_capabilities.get_app_help("cum șterg un widget?")

    assert "Șterge widget" in help_text
    assert "edit mode" in help_text
    assert "DELETE /api/dashboard/widgets/{widget_id}" in help_text


def test_widget_delete_help_resolves_english_synonyms(monkeypatch):
    monkeypatch.setattr(app_capabilities, "get_capabilities_manifest", _empty_manifest)

    help_text = app_capabilities.get_app_help("remove dashboard card")

    assert "trash button" in help_text
    assert "static/js/dashboard.js" in help_text
    assert "removeDashboardWidget" in help_text


def test_app_help_unknown_topic_forbids_guessing(monkeypatch):
    monkeypatch.setattr(app_capabilities, "get_capabilities_manifest", _empty_manifest)

    help_text = app_capabilities.get_app_help("where is the billing export screen?")

    assert help_text.startswith("UNKNOWN_TOPIC:")
    assert "Do not invent menu paths" in help_text


def test_navigation_help_rejects_settings_dashboard_path(monkeypatch):
    monkeypatch.setattr(app_capabilities, "get_capabilities_manifest", lambda: {"ui": app_capabilities._discover_ui_map()})

    help_text = app_capabilities.get_app_help("navigation")

    assert "Settings > Dashboard" in help_text
    assert "not a real Hyve path" in help_text
    assert "Dashboard (#/dashboard)" in help_text


def test_guardrails_keep_app_help_available_in_filtered_tool_sets():
    cortex_source = (_PROJECT_ROOT / "brain" / "cortex.py").read_text(encoding="utf-8")
    toolbox_source = (_PROJECT_ROOT / "brain" / "toolbox.py").read_text(encoding="utf-8")

    untrusted_block = toolbox_source.partition("_UNTRUSTED_CONTEXT_SAFE_TOOL_NAMES")[2].partition("})")[0]

    assert '"get_app_help"' in cortex_source.partition("_MINIMAL_TOOL_NAMES")[2][:200]
    assert '"get_system_status"' in cortex_source.partition("_MINIMAL_TOOL_NAMES")[2][:200]
    assert '"get_app_help"' in cortex_source.partition("_MEMORY_TOOL_NAMES")[2][:200]
    assert '"get_system_status"' in cortex_source.partition("_MEMORY_TOOL_NAMES")[2][:200]
    assert '"get_app_help",' in untrusted_block
    assert '"get_system_status",' in untrusted_block


def _load_intent_router(monkeypatch):
    monkeypatch.setitem(sys.modules, "httpx", types.SimpleNamespace(TimeoutException=TimeoutError))
    monkeypatch.setitem(sys.modules, "settings", types.SimpleNamespace(CFG={"intelligence": {"intent_router": {"enabled": False}}}))
    monkeypatch.setitem(sys.modules, "llm_client", types.SimpleNamespace(get_llm_client=lambda: None))
    monkeypatch.setitem(sys.modules, "logger", types.SimpleNamespace(log_line=lambda *args, **kwargs: None))

    router_path = _PROJECT_ROOT / "intent_router.py"
    spec = importlib.util.spec_from_file_location("intent_router_under_test", router_path)
    router = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(router)
    return router


def test_intent_router_prompt_covers_ui_and_system_queries(monkeypatch):
    router = _load_intent_router(monkeypatch)

    prompt = router._ROUTER_SYSTEM_PROMPT.lower()
    assert "complex" in prompt
    assert "widget" in prompt
    assert "integrations" in prompt or "integrări" in prompt
    assert "entities" in prompt or "entități" in prompt
    assert "hyve" in prompt


# ---------------------------------------------------------------------------
# get_system_status tests
# ---------------------------------------------------------------------------

def test_get_system_status_returns_string():
    result = app_capabilities.get_system_status("overview")
    assert isinstance(result, str)
    assert len(result) > 0


def test_get_system_status_unknown_query_returns_error():
    result = app_capabilities.get_system_status("nonexistent_query")
    assert "Unknown query" in result
    assert "overview" in result


def test_get_system_status_all_modes_return_strings():
    for mode in ("overview", "integrations", "entities", "health",
                 "dashboard", "automations", "scenes", "areas",
                 "notifications", "addons"):
        result = app_capabilities.get_system_status(mode)
        assert isinstance(result, str), f"mode={mode} did not return a string"
        assert len(result) > 0, f"mode={mode} returned empty string"


def test_get_system_status_integration_detail_requires_slug():
    result = app_capabilities.get_system_status("integration_detail", slug="")
    assert "provide" in result.lower() or "error" in result.lower()


def test_get_system_status_entities_accepts_filters():
    result = app_capabilities.get_system_status("entities", source="nonexistent_xyz")
    assert "No entities found" in result or "Entity" in result


def test_toolbox_has_system_status_tool():
    toolbox_source = (_PROJECT_ROOT / "brain" / "toolbox.py").read_text(encoding="utf-8")
    assert "TOOL_GET_SYSTEM_STATUS" in toolbox_source
    assert '"get_system_status"' in toolbox_source
    assert "_exec_get_system_status" in toolbox_source


def test_toolbox_has_new_omniscience_tools():
    toolbox_source = (_PROJECT_ROOT / "brain" / "toolbox.py").read_text(encoding="utf-8")
    for tool_name in ("get_entity_history", "control_device", "get_device_state"):
        assert f'"name": "{tool_name}"' in toolbox_source, f"Tool {tool_name} not found in toolbox"
    assert "TOOL_GET_ENTITY_HISTORY" in toolbox_source
    assert "TOOL_CONTROL_DEVICE" in toolbox_source
    assert "TOOL_GET_DEVICE_STATE" in toolbox_source
    assert "_exec_get_entity_history" in toolbox_source
    assert "_exec_control_device" in toolbox_source
    assert "_exec_get_device_state" in toolbox_source


def test_untrusted_safe_includes_readonly_new_tools():
    toolbox_source = (_PROJECT_ROOT / "brain" / "toolbox.py").read_text(encoding="utf-8")
    untrusted_block = toolbox_source.partition("_UNTRUSTED_CONTEXT_SAFE_TOOL_NAMES")[2].partition("})")[0]
    assert '"get_entity_history"' in untrusted_block
    assert '"get_device_state"' in untrusted_block
    # control_device should NOT be in the untrusted-safe set
    assert '"control_device"' not in untrusted_block


def test_system_status_query_enum_includes_new_modes():
    toolbox_source = (_PROJECT_ROOT / "brain" / "toolbox.py").read_text(encoding="utf-8")
    for mode in ("dashboard", "automations", "automation_history", "scenes", "areas", "notifications", "addons"):
        assert f'"{mode}"' in toolbox_source, f"Query mode {mode} not found in TOOL_GET_SYSTEM_STATUS enum"
