from __future__ import annotations

from routers.cameras import _camera_entity_matches, _camera_object_id


def test_camera_object_id_strips_domain():
    assert _camera_object_id("camera.fata1") == "fata1"


def test_camera_entity_matches_exact_id():
    ent = {"entity_id": "camera.fata1", "domain": "camera", "attributes": {}}
    assert _camera_entity_matches(ent, "camera.fata1", "camera.fata1")


def test_camera_entity_matches_frigate_alias():
    ent = {
        "entity_id": "camera.front_door",
        "domain": "camera",
        "aliases": ["fata1"],
        "attributes": {"frigate_camera": "fata1"},
    }
    assert _camera_entity_matches(ent, "camera.fata1", "camera.fata1")


def test_camera_entity_matches_unique_id():
    ent = {
        "entity_id": "camera.abc123",
        "unique_id": "tapo:host:cam",
        "domain": "camera",
        "attributes": {},
    }
    assert _camera_entity_matches(ent, "tapo:host:cam", "tapo:host:cam")
