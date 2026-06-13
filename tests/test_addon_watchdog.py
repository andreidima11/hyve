"""Addon process watchdog backoff (HA-style, no tight restart loops)."""

from addons import process_manager as pm


def test_watchdog_backoff_grows_then_caps():
    assert pm._watchdog_backoff_seconds(1) == 30
    assert pm._watchdog_backoff_seconds(2) == 60
    assert pm._watchdog_backoff_seconds(3) == 120
    assert pm._watchdog_backoff_seconds(4) == 240
    assert pm._watchdog_backoff_seconds(5) == 480
    assert pm._watchdog_backoff_seconds(10) == 480


def test_watchdog_can_retry_respects_backoff(monkeypatch):
    pm._watchdog_retry_state.clear()
    slug = "mosquitto"
    assert pm._watchdog_can_retry(slug) is True

    pm._watchdog_on_failure(slug, reason="boom")
    assert pm._watchdog_can_retry(slug) is False

    st = pm._watchdog_retry_state[slug]
    monkeypatch.setattr(pm.time, "time", lambda: float(st["next_retry_at"]) + 1)
    assert pm._watchdog_can_retry(slug) is True


def test_watchdog_success_clears_retry_state():
    pm._watchdog_retry_state.clear()
    slug = "zigbee2mqtt"
    pm._watchdog_on_failure(slug, reason="crash")
    assert slug in pm._watchdog_retry_state
    pm._watchdog_on_success(slug)
    assert slug not in pm._watchdog_retry_state


def test_watchdog_long_pause_after_repeated_failures(monkeypatch):
    pm._watchdog_retry_state.clear()
    slug = "frigate"
    now = 1_000_000.0
    monkeypatch.setattr(pm.time, "time", lambda: now)

    for i in range(pm._WATCHDOG_GIVE_UP_AFTER):
        pm._watchdog_on_failure(slug, reason=f"fail-{i}")

    assert pm._watchdog_can_retry(slug) is False
    st = pm._watchdog_retry_state[slug]
    assert float(st["paused_until"]) == now + pm._WATCHDOG_GIVE_UP_PAUSE

    monkeypatch.setattr(pm.time, "time", lambda: float(st["paused_until"]) + 1)
    assert pm._watchdog_can_retry(slug) is True
