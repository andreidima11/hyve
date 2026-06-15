"""Startup status tracker for the UI loading indicator."""

from __future__ import annotations

from core.startup_status import (
    get_startup_status,
    mark_startup_task_done,
    report_subsystem,
    reset_startup_status,
    set_startup_core_ready,
)


def test_startup_status_progress_increases_with_tasks():
    reset_startup_status()
    booting = get_startup_status()
    assert booting["ready"] is False
    assert booting["progress"] < 40
    assert booting["health"] == "ok"

    set_startup_core_ready()
    core_only = get_startup_status()
    assert core_only["core_ready"] is True
    assert core_only["progress"] >= 35

    mark_startup_task_done("integrations")
    mid = get_startup_status()
    assert mid["ready"] is False
    assert mid["progress"] > core_only["progress"]

    mark_startup_task_done("addons")
    done = get_startup_status()
    assert done["ready"] is True
    assert done["progress"] == 100


def test_reset_startup_status_clears_progress():
    set_startup_core_ready()
    mark_startup_task_done("integrations")
    mark_startup_task_done("addons")
    reset_startup_status()
    fresh = get_startup_status()
    assert fresh["ready"] is False
    assert fresh["progress"] < 20


def test_report_subsystem_degraded_and_fatal():
    reset_startup_status()
    report_subsystem("memory", "degraded", message="timeout")
    report_subsystem("entities", "fatal", message="schema error")

    status = get_startup_status()
    assert status["health"] == "fatal"
    assert len(status["issues"]) == 2
    assert status["issues"][0]["name"] in ("memory", "entities")

    reset_startup_status()
    report_subsystem("scheduler", "degraded", message="offline")
    degraded = get_startup_status()
    assert degraded["health"] == "degraded"
    assert degraded["issues"][0]["level"] == "degraded"
