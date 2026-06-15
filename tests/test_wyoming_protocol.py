"""Wyoming protocol framing."""

from __future__ import annotations

from integrations import wyoming_protocol


def test_make_event_round_trip_with_payload():
    frame = wyoming_protocol.make_event(
        "audio-chunk",
        {"rate": 16000, "width": 2, "channels": 1},
        payload=b"\x01\x02",
    )
    events = list(wyoming_protocol.parse_events(frame))
    assert len(events) == 1
    evt_type, data, payload = events[0]
    assert evt_type == "audio-chunk"
    assert data["rate"] == 16000
    assert payload == b"\x01\x02"


def test_parse_events_multiple_frames():
    raw = wyoming_protocol.make_event("transcribe", {"language": "ro"})
    raw += wyoming_protocol.make_event("audio-stop")
    types = [evt_type for evt_type, _data, _payload in wyoming_protocol.parse_events(raw)]
    assert types == ["transcribe", "audio-stop"]
