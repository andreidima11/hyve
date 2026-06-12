"""Mammotion Agora camera stream helpers."""

from __future__ import annotations

import pytest

from components.mammotion.camera_stream import _token_payload


def test_token_payload_from_dict():
    class _Sub:
        def to_dict(self):
            return {
                "appid": "abc",
                "channelName": "chan",
                "token": "tok",
                "uid": 42,
            }

    class _Resp:
        data = _Sub()

    out = _token_payload(_Resp())
    assert out["appid"] == "abc"
    assert out["uid"] == 42


def test_token_payload_accepts_app_id_alias():
    class _Sub:
        def to_dict(self):
            return {
                "appId": "abc",
                "channel_name": "chan",
                "token": "tok",
                "uid": 7,
            }

    class _Resp:
        data = _Sub()

    out = _token_payload(_Resp())
    assert out["appid"] == "abc"
    assert out["channelName"] == "chan"


def test_mower_camera_entity_marks_agora_stream():
    from components.mammotion.specs.mower import build_mower_entities
    from components.mammotion.specs.row import MowerRow

    row = MowerRow.from_snapshot(
        {
            "device_name": "Luba-VID01",
            "name": "Luba",
            "online": True,
            "flags": {"supports_video": True, "is_luba_pro": True},
            "status": {"sys_status": 11, "charge_state": 1, "battery": 80},
        }
    )
    entities = build_mower_entities(row)
    cam = next(e for e in entities if e["domain"] == "camera")
    assert cam["attributes"]["stream_type"] == "agora_webrtc"
    assert cam["attributes"]["live_providers"] == ["agora"]
    assert cam["controllable"] is True


def test_resolve_camera_device_name_from_entity_id():
    from components.mammotion.camera_stream import _resolve_camera_device_name

    class _Hub:
        def _iter_device_names(self):
            return ["Luba-VID01"]

    ent = {
        "entity_id": "camera.luba_vid01_webrtc",
        "unique_id": "mammotion:Luba-VID01:camera:webrtc",
        "attributes": {"device_name": "Curte", "stream_type": "agora_webrtc"},
    }
    assert _resolve_camera_device_name(_Hub(), ent) == "Luba-VID01"


def test_names_match_slugified():
    from components.mammotion.camera_stream import _names_match

    assert _names_match("Luba-VID01", "luba_vid01") is True
    assert _names_match("Curte", "Luba-VID01") is False


def test_is_mammotion_camera_accepts_stream_type():
    from routers.cameras import _is_mammotion_camera

    ent = {
        "source": "mammotion",
        "entity_id": "camera.luba_webrtc",
        "attributes": {"stream_type": "agora_webrtc"},
    }
    assert _is_mammotion_camera(ent) is True
