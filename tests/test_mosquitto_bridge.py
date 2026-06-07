"""MQTT bridge client id and reconnect helpers."""

from __future__ import annotations

from components.mosquitto.bridge import _MQTT311_CLIENT_ID_MAX_BYTES, _mqtt_client_id


def test_mqtt_client_id_respects_mqtt311_limit():
    cid = _mqtt_client_id("entry-abc", "localhost", 1883)
    assert len(cid.encode("utf-8")) <= _MQTT311_CLIENT_ID_MAX_BYTES


def test_mqtt_client_id_stable_per_entry():
    a = _mqtt_client_id("entry-1", "192.168.1.10", 1883)
    b = _mqtt_client_id("entry-1", "192.168.1.10", 1883)
    c = _mqtt_client_id("entry-2", "192.168.1.10", 1883)
    assert a == b
    assert a != c
