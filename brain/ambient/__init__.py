"""Ambient Brain — proactive perception → reasoning → action loop."""

from __future__ import annotations

from brain.ambient.actions import (
    _ambient_context_tags,
    ambient_actions_for_context,
    format_ambient_actions_catalog,
)
from brain.ambient.config import is_enabled
from brain.ambient.context import _build_context
from brain.ambient.cycle import run_test
from brain.ambient.learning import act_on_suggestion
from brain.ambient.llm import default_reasoner_prompt, reasoner_system_prompt
from brain.ambient.scheduler import _checkin_job, init_ambient, reschedule_checkins, shutdown_ambient

__all__ = [
    "is_enabled",
    "init_ambient",
    "shutdown_ambient",
    "reschedule_checkins",
    "default_reasoner_prompt",
    "reasoner_system_prompt",
    "ambient_actions_for_context",
    "format_ambient_actions_catalog",
    "run_test",
    "act_on_suggestion",
    "_build_context",
    "_ambient_context_tags",
    "_checkin_job",
]
