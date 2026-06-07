"""Trace collector — captures per-step execution detail for the UI debugger.

Stored under `AutomationRun.details_json["trace"]`; size-capped to avoid
runaway growth. Thread-local: each automation run binds a collector to the
worker thread that executes it, then unbinds in `finally`.

Public surface (also re-exported from `automation_definitions` for
backwards compatibility with existing imports):
    - TRACE_MAX_STEPS / TRACE_MAX_PARAMS_BYTES / TRACE_MAX_MESSAGE_BYTES
    - TraceCollector
    - trace_begin / trace_end / trace_current / trace_step
    - trace_truncate / trace_safe_params
"""

from __future__ import annotations

import json
import threading
import time as _time_mod

TRACE_MAX_STEPS = 256
TRACE_MAX_PARAMS_BYTES = 1024
TRACE_MAX_MESSAGE_BYTES = 512

_REDACT_KEYS = {"password", "token", "secret", "key", "authorization", "api_key"}
_SCALAR_TYPES = (str, int, float, bool, type(None))

_trace_local = threading.local()


def trace_truncate(value, limit: int) -> str:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def trace_safe_params(params: dict | None) -> dict | None:
    """Best-effort JSON-safe copy of params, capped at TRACE_MAX_PARAMS_BYTES.
    Sensitive-looking keys (password/token/secret/key/authorization/api_key)
    are redacted defensively even though we don't currently surface user
    secrets here — defense in depth for future fields."""
    if not isinstance(params, dict) or not params:
        return None
    safe: dict[str, object] = {}
    for raw_k, raw_v in params.items():
        k = str(raw_k)
        if k.lower() in _REDACT_KEYS:
            safe[k] = "***"
            continue
        # Coerce non-JSON-native values to strings via repr so the trace
        # surface is always serializable and never leaks live object state.
        if isinstance(raw_v, _SCALAR_TYPES):
            safe[k] = raw_v
        else:
            safe[k] = repr(raw_v)
    try:
        encoded = json.dumps(safe, ensure_ascii=False)
    except Exception:
        return {"_truncated": True, "_error": "non_serializable"}
    if len(encoded) > TRACE_MAX_PARAMS_BYTES:
        return {"_truncated": True, "_size": len(encoded)}
    return safe


class TraceCollector:
    """Append-only structured log of automation execution steps."""

    def __init__(self, run_id: str):
        self.run_id = run_id
        self.steps: list[dict] = []
        self._t0 = _time_mod.monotonic()
        self._truncated = False
        self._lock = threading.Lock()

    def add(self, kind: str, path: str, status: str, *,
            message: str | None = None, error: str | None = None,
            params: dict | None = None, duration_ms: float | None = None) -> None:
        with self._lock:
            if len(self.steps) >= TRACE_MAX_STEPS:
                self._truncated = True
                return
            entry: dict = {
                "kind": kind,
                "path": path,
                "status": status,
                "ts_offset_ms": round((_time_mod.monotonic() - self._t0) * 1000, 1),
            }
            if message:
                entry["message"] = trace_truncate(message, TRACE_MAX_MESSAGE_BYTES)
            if error:
                entry["error"] = trace_truncate(error, TRACE_MAX_MESSAGE_BYTES)
            if duration_ms is not None:
                entry["duration_ms"] = round(duration_ms, 1)
            safe_params = trace_safe_params(params)
            if safe_params is not None:
                entry["params"] = safe_params
            self.steps.append(entry)

    def as_dict(self) -> dict:
        with self._lock:
            return {
                "run_id": self.run_id,
                "steps": list(self.steps),
                "truncated": self._truncated,
                "step_count": len(self.steps),
            }


def trace_begin(run_id: str) -> TraceCollector:
    collector = TraceCollector(run_id)
    _trace_local.collector = collector
    return collector


def trace_end() -> None:
    _trace_local.collector = None


def trace_current() -> TraceCollector | None:
    return getattr(_trace_local, "collector", None)


def trace_step(kind: str, path: str, status: str, **kwargs) -> None:
    collector = trace_current()
    if collector is not None:
        collector.add(kind, path, status, **kwargs)
