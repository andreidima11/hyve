"""Ambient package smoke tests."""

from __future__ import annotations


def test_ambient_public_exports():
    from brain import ambient

    assert callable(ambient.is_enabled)
    assert callable(ambient.init_ambient)
    assert callable(ambient.shutdown_ambient)
    assert callable(ambient.reschedule_checkins)
    assert callable(ambient.default_reasoner_prompt)
    assert callable(ambient.ambient_actions_for_context)
    assert callable(ambient.run_test)
    assert callable(ambient.act_on_suggestion)
    assert callable(ambient._build_context)


def test_apscheduler_can_resolve_checkin_job():
    """APScheduler persists callables as brain.ambient:_checkin_job."""
    import brain.ambient as ambient

    assert callable(getattr(ambient, "_checkin_job", None))


def test_default_reasoner_prompt_non_empty():
    from brain.ambient import default_reasoner_prompt

    assert len(default_reasoner_prompt().strip()) > 20
