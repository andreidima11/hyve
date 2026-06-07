"""Jinja2-based template evaluation for automations.

Exposes a tiny HA-compatible API:
    {{ states('light.kitchen') }}            -> entity state as str (or 'unknown')
    {{ state_attr('sensor.temp', 'unit') }}  -> entity attribute
    {{ is_state('switch.x', 'on') }}         -> bool
    {{ now() }}                              -> datetime.now()
    {{ trigger.entity_id }}                  -> trigger payload (when fired by bus)

The environment is autoescape-off and sandboxed via ``SandboxedEnvironment``
so templates can't reach into builtins/imports. A short cache keeps repeat
renders cheap when the observer fires often.
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

from jinja2 import StrictUndefined
from jinja2.sandbox import SandboxedEnvironment

_env = SandboxedEnvironment(autoescape=False, undefined=StrictUndefined)
_template_cache: dict[str, Any] = {}

# Per-thread variables published by an in-flight automation run. Templates
# rendered while the run is active see these as plain identifiers (e.g.
# ``{{ my_var }}``) on top of the standard helpers.
_run_context = threading.local()


def set_run_variables(variables: dict[str, Any] | None) -> None:
    _run_context.variables = dict(variables or {})


def clear_run_variables() -> None:
    _run_context.variables = {}


def _current_variables() -> dict[str, Any]:
    return getattr(_run_context, "variables", {}) or {}


def _build_helpers(snapshot: list[dict] | None):
    """Return the dict of helper callables exposed to templates."""
    by_id = {item.get("entity_id"): item for item in (snapshot or []) if item.get("entity_id")}

    def states(entity_id: str) -> str:
        item = by_id.get(entity_id)
        if not item:
            return "unknown"
        return str(item.get("state", "unknown"))

    def state_attr(entity_id: str, attr: str):
        item = by_id.get(entity_id)
        if not item:
            return None
        return (item.get("attributes") or {}).get(attr)

    def is_state(entity_id: str, value: Any) -> bool:
        return states(entity_id) == str(value)

    def is_state_attr(entity_id: str, attr: str, value: Any) -> bool:
        return state_attr(entity_id, attr) == value

    return {
        "states": states,
        "state_attr": state_attr,
        "is_state": is_state,
        "is_state_attr": is_state_attr,
        "now": datetime.now,
    }


def render(template_str: str, *, snapshot: list[dict] | None = None, extra: dict | None = None) -> str:
    """Render ``template_str`` against the given entity snapshot. Returns the
    rendered string (caller decides how to coerce to bool / number)."""
    tmpl = _template_cache.get(template_str)
    if tmpl is None:
        tmpl = _env.from_string(template_str)
        if len(_template_cache) > 256:
            _template_cache.clear()
        _template_cache[template_str] = tmpl
    ctx = _build_helpers(snapshot)
    ctx.update(_current_variables())
    if extra:
        ctx.update(extra)
    return tmpl.render(**ctx)


def render_bool(template_str: str, *, snapshot: list[dict] | None = None, extra: dict | None = None) -> bool:
    """Render and coerce to bool. ``true``/``1``/``on``/``yes`` → True; the
    rest is False. Empty / whitespace also False."""
    raw = render(template_str, snapshot=snapshot, extra=extra).strip().lower()
    return raw in {"true", "1", "on", "yes"}
