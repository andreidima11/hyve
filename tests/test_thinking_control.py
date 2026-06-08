"""Guards for local LLM thinking suppression (jinja 'No user query' regressions)."""

from brain.thinking_control import (
    OLLAMA_THINK_PREFILL,
    apply_thinking_suppression,
    is_ollama_openai_endpoint,
)


def test_ollama_endpoint_detection_by_url_not_broad_local():
    assert is_ollama_openai_endpoint("http://127.0.0.1:11434/v1/chat/completions", "local")
    assert not is_ollama_openai_endpoint("http://127.0.0.1:1234/v1/chat/completions", "local")
    assert is_ollama_openai_endpoint("http://127.0.0.1:1234/v1", "ollama")


def test_no_think_prefill_skipped_after_tool_messages():
    """Tool-loop tails + assistant prefill trip Qwen jinja templates."""
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "salut"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "function": {"name": "x", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "ok"},
    ]
    payload, out = apply_thinking_suppression(
        {"model": "qwen3"},
        messages,
        target_url="http://127.0.0.1:11434/v1/chat/completions",
        model_name="qwen/qwen3.5-35b",
        provider="local",
        suppress=True,
    )
    assert payload.get("think") is False
    assert out[-1]["role"] == "tool"
    assert OLLAMA_THINK_PREFILL not in str(out[-1].get("content") or "")


def test_ensure_text_user_after_suppression_when_user_was_stripped():
    from brain.cortex.messages import _ensure_text_user_message

    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": " /no_think "},
    ]
    _, out = apply_thinking_suppression(
        {"model": "qwen3"},
        messages,
        target_url="http://127.0.0.1:11434/v1/chat/completions",
        model_name="qwen/qwen3.5-35b",
        provider="local",
        suppress=True,
    )
    fixed = _ensure_text_user_message(out)
    assert any(
        m.get("role") == "user" and str(m.get("content") or "").strip()
        for m in fixed
    )
