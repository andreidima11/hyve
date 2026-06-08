"""Regression guards for cortex modularization (missing imports broke chat)."""

import importlib

import pytest

from brain.cortex.prompt import _build_static_prompt_prefix


def test_build_static_prompt_prefix_does_not_raise():
    text = _build_static_prompt_prefix("user_1", None, max_prompt_tokens=2000)
    assert isinstance(text, str)
    assert len(text) > 100


@pytest.mark.parametrize(
    "module_name",
    [
        "brain.cortex.llm",
        "brain.cortex.messages",
        "brain.cortex.warmup",
        "brain.cortex.agent_stream",
        "brain.cortex.agent_context",
    ],
)
def test_cortex_modules_import(module_name):
    importlib.import_module(module_name)


def test_stream_llm_turn_references_resolved_symbols():
    from brain.cortex import llm as llm_mod

    assert hasattr(llm_mod, "time")
    assert hasattr(llm_mod, "uuid")
    assert hasattr(llm_mod, "_ThinkContentStreamParser")


def test_clean_history_strips_thinking_from_assistant_messages():
    from brain.cortex.messages import clean_history

    history = [
        {
            "role": "assistant",
            "content": "<think>internal</think>Salut!",
        }
    ]
    cleaned = clean_history(history)
    assert cleaned[0]["content"] == "Salut!"
