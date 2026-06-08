"""Hyve APScheduler package — reminders, automations, consolidation."""

from __future__ import annotations

from core.scheduler.engine import jobstores, scheduler, start_scheduler, stop_scheduler, to_naive_local
from core.scheduler.jobs import (
    CONSOLIDATION_JOB_ID,
    bulk_remove_reminder_jobs,
    get_automation_job,
    get_reminder_job,
    list_automation_jobs,
    list_reminder_jobs,
    remove_reminder_job,
    run_automation,
    schedule_at,
    schedule_automation,
    schedule_consolidation_job,
    schedule_event_action,
    schedule_event_notification,
    schedule_reminder,
    trigger_notification,
    update_reminder_job,
)
from core.scheduler.meta import (
    delete_automation_spec,
    get_automation_spec,
    get_automation_specs_bulk,
    get_reminder_display,
    get_reminder_displays_bulk,
    set_automation_spec,
    set_reminder_display,
)

# Legacy private names used by automations_engine and tests
from core.scheduler.jobs import _format_skill_result, _sanitize_text_for_waha

_to_naive_local = to_naive_local

__all__ = [
    "CONSOLIDATION_JOB_ID",
    "bulk_remove_reminder_jobs",
    "delete_automation_spec",
    "get_automation_job",
    "get_automation_spec",
    "get_automation_specs_bulk",
    "get_reminder_display",
    "get_reminder_displays_bulk",
    "get_reminder_job",
    "jobstores",
    "list_automation_jobs",
    "list_reminder_jobs",
    "remove_reminder_job",
    "run_automation",
    "schedule_at",
    "schedule_automation",
    "schedule_consolidation_job",
    "schedule_event_action",
    "schedule_event_notification",
    "schedule_reminder",
    "scheduler",
    "set_automation_spec",
    "set_reminder_display",
    "start_scheduler",
    "stop_scheduler",
    "to_naive_local",
    "trigger_notification",
    "update_reminder_job",
    "_format_skill_result",
    "_sanitize_text_for_waha",
    "_to_naive_local",
]
