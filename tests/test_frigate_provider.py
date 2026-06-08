from integrations.component_loader import get_component_entity_class

FrigateEntity = get_component_entity_class("frigate")
assert FrigateEntity is not None


def _sample_payload():
    return {
        "config": {
            "birdseye": {"enabled": True},
            "profiles": {"home": {}, "away": {}},
            "cameras": {
                "front_door": {
                    "friendly_name": "Front Door",
                    "enabled": True,
                    "detect": {"enabled": True},
                    "motion": {
                        "enabled": True,
                        "contour_area": 12,
                        "threshold": 30,
                        "improve_contrast": False,
                    },
                    "record": {"enabled": True},
                    "snapshots": {"enabled": True},
                    "audio": {"enabled": True, "listen": ["bark"]},
                    "objects": {"track": ["person", "car"]},
                    "zones": {"porch": {"objects": ["person"]}},
                    "review": {
                        "alerts": {"enabled": True},
                        "detections": {"enabled": True},
                    },
                }
            },
        },
        "stats": {
            "detection_fps": 2.5,
            "service": {"version": "0.18.1", "latest_version": "0.19.0", "uptime": 123},
            "detectors": {"cpu": {"inference_speed": 8.2}},
            "cameras": {
                "front_door": {
                    "camera_fps": 5,
                    "detection_fps": 1,
                    "process_fps": 5,
                    "skipped_fps": 0,
                    "audio_dBFS": -32,
                }
            },
        },
        "go2rtc_streams": {
            "front_door": {"producers": []},
        },
    }


def test_frigate_provider_exposes_ha_like_entity_surface():
    provider = FrigateEntity(
        entry_id="entry-1",
        entry_data={"host": "192.168.0.101", "port": 8971, "scheme": "https"},
    )

    entities = provider.extract_entities(_sample_payload())
    by_id = {entity["entity_id"]: entity for entity in entities}

    assert by_id["camera.front_door"]["state"] == "streaming"
    assert by_id["camera.front_door"]["attributes"]["mjpeg_url"].startswith("https://192.168.0.101:8971")
    assert by_id["camera.front_door"]["attributes"]["go2rtc_available"] is True
    assert by_id["camera.front_door"]["attributes"]["go2rtc_stream"] == "front_door"
    assert by_id["camera.front_door"]["attributes"]["live_providers"] == ["go2rtc", "mjpeg", "snapshot"]
    assert by_id["camera.birdseye"]["domain"] == "camera"

    assert by_id["sensor.frigate_status"]["state"] == "online"
    assert by_id["sensor.frigate_detection_fps"]["unit"] == "fps"
    assert by_id["sensor.frigate_cpu_inference_speed"]["unit"] == "ms"
    assert by_id["sensor.front_door_camera_fps"]["state"] == 5
    assert by_id["sensor.front_door_sound_level"]["unit"] == "dB"

    assert by_id["sensor.front_door_person_count"]["state"] == "unknown"
    assert by_id["sensor.front_door_person_active_count"]["state"] == "unknown"
    assert by_id["binary_sensor.front_door_person_occupancy"]["domain"] == "binary_sensor"
    assert by_id["binary_sensor.front_door_motion"]["attributes"]["state_source"] == "Frigate MQTT"
    assert by_id["sensor.porch_person_count"]["attributes"]["frigate_zone"] == "porch"

    assert by_id["switch.front_door_detect"]["state"] == "on"
    assert by_id["switch.front_door_detect"]["controllable"] is False
    assert by_id["number.front_door_threshold"]["state"] == 30
    assert by_id["number.front_door_threshold"]["attributes"]["capabilities"]["max"] == 255
    assert by_id["image.front_door_person"]["domain"] == "image"
    assert by_id["select.frigate_profile"]["attributes"]["options"] == ["home", "away"]
    assert by_id["select.frigate_profile"]["controllable"] is False
    assert by_id["update.frigate_server"]["state"] == "on"


def test_frigate_provider_keeps_raw_config_payload_compatible():
    provider = FrigateEntity(entry_data={"host": "localhost", "port": 5005})
    raw_config = _sample_payload()["config"]

    entities = provider.extract_entities(raw_config)
    by_id = {entity["entity_id"]: entity for entity in entities}

    assert "camera.front_door" in by_id
    assert "switch.front_door_snapshots" in by_id
    assert by_id["camera.front_door"]["attributes"]["snapshot_url"].startswith("http://localhost:5005")


def test_frigate_tls_verify_accepts_persisted_string_booleans():
    assert FrigateEntity._build_client_kwargs({"verify_tls": "false"})["verify"] is False
    assert FrigateEntity._build_client_kwargs({"verify_tls": "true"})["verify"] is True