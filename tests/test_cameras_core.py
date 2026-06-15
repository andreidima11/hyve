"""Unit tests for core.cameras helpers."""

from __future__ import annotations

import pytest

from core.cameras.attrs import hydrate_stream_attrs
from core.cameras.capabilities import camera_capabilities_payload
from core.cameras.shared import prefer_http_snapshot


def test_hydrate_stream_attrs_passthrough_non_frigate():
    ent = {"entity_id": "camera.tapo", "source": "tapo", "attributes": {"rtsp_url": "rtsp://x"}}
    attrs = {"rtsp_url": "rtsp://x"}
    assert hydrate_stream_attrs(ent, attrs) is attrs


def test_camera_capabilities_payload_reolink_volume():
    ent = {"entity_id": "camera.front", "source": "reolink"}
    attrs = {"has_audio": True, "two_way_audio": False}
    payload = camera_capabilities_payload(ent, attrs)
    assert payload["source"] == "reolink"
    assert payload["speaker_volume_mutable"] is True
    assert payload["supports_talk"] is False


def test_camera_capabilities_payload_frigate_talk():
    ent = {"entity_id": "camera.drive", "source": "frigate"}
    attrs = {
        "go2rtc_available": True,
        "go2rtc_stream": "drive",
        "has_audio": True,
    }
    payload = camera_capabilities_payload(ent, attrs)
    assert payload["go2rtc_available"] is True
    assert payload["supports_talk"] is True
    assert payload["talk_methods"] == ["go2rtc"]


def test_prefer_http_snapshot_frigate_with_url():
    ent = {"source": "frigate"}
    attrs = {"snapshot_url": "http://127.0.0.1/snap.jpg"}
    assert prefer_http_snapshot(ent, attrs, source="frigate") is True
