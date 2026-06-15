"""Camera API structured errors (i18n keys)."""

from __future__ import annotations

from core.http.errors import error_detail


def test_camera_error_detail_keys_are_structured():
    detail = error_detail("cameras.not_found", {"entity_id": "camera.x"})
    assert detail == {"key": "cameras.not_found", "params": {"entity_id": "camera.x"}}

    mammotion = error_detail("cameras.mammotion_start_failed", {"error": "timeout"})
    assert mammotion["key"] == "cameras.mammotion_start_failed"
    assert mammotion["params"]["error"] == "timeout"


def test_is_mammotion_camera_still_accepts_stream_type():
    from routers.cameras import _is_mammotion_camera

    ent = {
        "source": "mammotion",
        "entity_id": "camera.luba_webrtc",
        "attributes": {"stream_type": "agora_webrtc"},
    }
    assert _is_mammotion_camera(ent) is True
