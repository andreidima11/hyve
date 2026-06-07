"""Tests for the automation trace collector (in-memory, no DB)."""

import pytest

from automation_definitions import (
    _TraceCollector,
    _trace_begin,
    _trace_current,
    _trace_end,
    _trace_step,
    _TRACE_MAX_STEPS,
    _TRACE_MAX_PARAMS_BYTES,
    _trace_safe_params,
)


def test_collector_records_basic_step():
    c = _TraceCollector("run-abc")
    c.add("action", "action[0].notify", "ok", message="notify ok")
    payload = c.as_dict()
    assert payload["run_id"] == "run-abc"
    assert payload["step_count"] == 1
    assert payload["truncated"] is False
    step = payload["steps"][0]
    assert step["kind"] == "action"
    assert step["path"] == "action[0].notify"
    assert step["status"] == "ok"
    assert step["message"] == "notify ok"
    assert "ts_offset_ms" in step


def test_collector_truncates_after_step_cap():
    c = _TraceCollector("r")
    for i in range(_TRACE_MAX_STEPS + 5):
        c.add("action", f"a[{i}]", "ok")
    payload = c.as_dict()
    assert payload["step_count"] == _TRACE_MAX_STEPS
    assert payload["truncated"] is True


def test_collector_truncates_long_messages():
    c = _TraceCollector("r")
    huge = "x" * 5_000
    c.add("action", "a[0]", "ok", message=huge)
    msg = c.as_dict()["steps"][0]["message"]
    assert len(msg) <= 513  # _TRACE_MAX_MESSAGE_BYTES + ellipsis
    assert msg.endswith("…")


def test_safe_params_redacts_sensitive_keys():
    out = _trace_safe_params({
        "entity_id": "light.living",
        "password": "hunter2",
        "api_key": "k-123",
        "Authorization": "Bearer xxx",
    })
    assert out["entity_id"] == "light.living"
    assert out["password"] == "***"
    assert out["api_key"] == "***"
    assert out["Authorization"] == "***"


def test_safe_params_truncates_oversized_payload():
    big = {"k": "x" * (_TRACE_MAX_PARAMS_BYTES + 10)}
    out = _trace_safe_params(big)
    assert out == {"_truncated": True, "_size": pytest.approx(len(str(big)), abs=200)} or out["_truncated"] is True


def test_safe_params_handles_non_serializable():
    class Weird:
        def __repr__(self):
            return "Weird()"
    out = _trace_safe_params({"thing": Weird()})
    assert out["thing"] == "Weird()"


def test_safe_params_returns_none_for_empty():
    assert _trace_safe_params(None) is None
    assert _trace_safe_params({}) is None


def test_thread_local_lifecycle():
    assert _trace_current() is None
    collector = _trace_begin("r-1")
    assert _trace_current() is collector
    _trace_step("action", "a[0]", "ok", message="ping")
    assert collector.as_dict()["step_count"] == 1
    _trace_end()
    assert _trace_current() is None


def test_trace_step_is_noop_outside_collector():
    _trace_end()  # ensure clean
    # should not raise even though no collector is active
    _trace_step("action", "a[0]", "ok")
    assert _trace_current() is None


def test_collector_records_error_status_with_error_message():
    c = _TraceCollector("r")
    c.add("action", "a[0].service", "error", error="boom")
    step = c.as_dict()["steps"][0]
    assert step["status"] == "error"
    assert step["error"] == "boom"
    assert "message" not in step
