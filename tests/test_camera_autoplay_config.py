"""Camera card autoplay config helper (JS parity documented in camera_live.ts)."""

from __future__ import annotations


def _camera_autoplay_enabled(cfg: dict | None, *, live_mode: bool, mammotion_only: bool) -> bool:
    """Mirror static/js/camera_live.ts cameraAutoplayEnabled."""
    raw = (cfg or {}).get("autoplay")
    if raw is False or raw == "false":
        return False
    if raw is True or raw == "true":
        return True
    return live_mode or mammotion_only


def test_autoplay_defaults_on_for_mammotion_and_live():
    assert _camera_autoplay_enabled({}, live_mode=False, mammotion_only=True) is True
    assert _camera_autoplay_enabled({}, live_mode=True, mammotion_only=False) is True
    assert _camera_autoplay_enabled({}, live_mode=False, mammotion_only=False) is False


def test_autoplay_explicit_override():
    assert _camera_autoplay_enabled({"autoplay": False}, live_mode=True, mammotion_only=True) is False
    assert _camera_autoplay_enabled({"autoplay": True}, live_mode=False, mammotion_only=False) is True
