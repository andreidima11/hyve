"""Tests for the non-fatal automation linter (lint_definition)."""

import textwrap

import core.automation_definitions as ad


def _normalize(yaml_text: str) -> dict:
    return ad.validate_source_yaml(textwrap.dedent(yaml_text).strip())


def _yaml_with_action(action_block: str) -> str:
    return f"""
    title: T
    trigger:
      - platform: state
        entity_id: light.kitchen
    action:
{action_block}
    """


def test_lint_clean_definition_has_no_warnings():
    norm = _normalize("""
        title: Clean
        trigger:
          - platform: state
            entity_id: light.kitchen
        action:
          - service: light.turn_on
            entity_id: light.kitchen
    """)
    assert ad.lint_definition(norm) == []


def test_top_level_channel_is_legacy_and_not_normalized():
    norm = _normalize("""
        title: Legacy channel
        channel: whatsapp
        trigger:
          - platform: state
            entity_id: light.kitchen
        action:
          - notify:
              text: Hello
    """)
    assert "channel" not in norm


def test_lint_warns_on_disabled():
    norm = _normalize("""
        title: T
        enabled: false
        trigger:
          - platform: state
            entity_id: light.kitchen
        action:
          - service: light.turn_on
            entity_id: light.kitchen
    """)
    codes = [w["code"] for w in ad.lint_definition(norm)]
    assert "disabled" in codes


def test_lint_warns_on_duplicate_trigger():
    norm = _normalize("""
        title: T
        trigger:
          - platform: state
            entity_id: light.kitchen
          - platform: state
            entity_id: light.kitchen
        action:
          - service: light.turn_on
            entity_id: light.kitchen
    """)
    warns = ad.lint_definition(norm)
    assert any(w["code"] == "duplicate_trigger" for w in warns)


def test_lint_warns_on_long_delay():
    norm = _normalize("""
        title: T
        trigger:
          - platform: state
            entity_id: light.kitchen
        action:
          - delay: 7200
          - service: light.turn_on
            entity_id: light.kitchen
    """)
    warns = ad.lint_definition(norm)
    assert any(w["code"] == "long_delay" for w in warns)


def test_lint_warns_on_destructive_action_without_condition():
    norm = _normalize("""
        title: T
        trigger:
          - platform: state
            entity_id: light.kitchen
        action:
          - service: light.turn_off
            entity_id: light.kitchen
    """)
    warns = ad.lint_definition(norm)
    assert any(w["code"] == "no_guard" for w in warns)


def test_lint_destructive_with_condition_no_warning():
    norm = _normalize("""
        title: T
        trigger:
          - platform: state
            entity_id: light.kitchen
        condition:
          - kind: state
            entity_id: light.kitchen
            state: "on"
        action:
          - service: light.turn_off
            entity_id: light.kitchen
    """)
    warns = ad.lint_definition(norm)
    assert not any(w["code"] == "no_guard" for w in warns)
