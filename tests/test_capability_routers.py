"""Optional per-integration HTTP routers — manifest-driven discovery."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter, FastAPI

from integrations import capability_routers


@pytest.fixture(autouse=True)
def _clear_router_cache():
    capability_routers.invalidate_cache()
    yield
    capability_routers.invalidate_cache()


def test_discover_skips_component_without_router_module(tmp_path: Path, monkeypatch):
    component_dir = tmp_path / "demo_sensor"
    component_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps({"domain": "demo_sensor", "name": "Demo", "version": "0.1.0"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        capability_routers,
        "_component_dir_for_domain",
        lambda _slug: component_dir,
    )
    capability_routers.invalidate_cache()

    assert capability_routers.discover_component_routers() == []


def test_discover_loads_router_export(tmp_path: Path, monkeypatch):
    component_dir = tmp_path / "demo_sensor"
    component_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps(
            {
                "domain": "demo_sensor",
                "name": "Demo",
                "version": "0.1.0",
                "router_module": "router",
            }
        ),
        encoding="utf-8",
    )
    (component_dir / "router.py").write_text(
        """
from fastapi import APIRouter

router = APIRouter(prefix="/api/demo_sensor", tags=["demo_sensor"])

@router.get("/ping")
async def ping():
    return {"ok": True}
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        capability_routers,
        "_component_dir_for_domain",
        lambda _slug: component_dir,
    )
    monkeypatch.setattr(
        capability_routers,
        "discovered_slugs",
        lambda: {"demo_sensor"},
    )
    capability_routers.invalidate_cache()

    found = capability_routers.discover_component_routers()
    assert len(found) == 1
    slug, router = found[0]
    assert slug == "demo_sensor"
    assert isinstance(router, APIRouter)
    assert router.prefix == "/api/demo_sensor"


def test_register_component_routers_includes_on_app(tmp_path: Path, monkeypatch):
    component_dir = tmp_path / "demo_sensor"
    component_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps({"domain": "demo_sensor", "name": "Demo", "version": "0.1.0"}),
        encoding="utf-8",
    )
    (component_dir / "router.py").write_text(
        "from fastapi import APIRouter\nrouter = APIRouter(prefix='/api/demo_sensor')\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        capability_routers,
        "_component_dir_for_domain",
        lambda _slug: component_dir,
    )
    monkeypatch.setattr(
        capability_routers,
        "discovered_slugs",
        lambda: {"demo_sensor"},
    )
    capability_routers.invalidate_cache()

    app = FastAPI()
    app.include_router = MagicMock(wraps=app.include_router)
    registered = capability_routers.register_component_routers(app)
    assert registered == ["demo_sensor"]
    app.include_router.assert_called_once()


def test_mammotion_manifest_registers_component_router():
    from integrations import capability_routers

    capability_routers.invalidate_cache()
    router = capability_routers.routers_for_slug("mammotion")
    assert router is not None
    assert router.prefix == "/api/cameras"


def test_piper_and_whisper_manifests_register_routers():
    from integrations import capability_routers

    capability_routers.invalidate_cache()
    piper = capability_routers.routers_for_slug("piper")
    whisper = capability_routers.routers_for_slug("whisper")
    assert piper is not None
    assert piper.prefix == "/api/piper"
    assert whisper is not None
    assert whisper.prefix == "/api/whisper"


def test_frigate_manifest_registers_go2rtc_router():
    from integrations import capability_routers

    capability_routers.invalidate_cache()
    router = capability_routers.routers_for_slug("frigate")
    assert router is not None
    assert router.prefix == "/api/cameras"


def test_comfyui_manifest_registers_router():
    from integrations import capability_routers

    capability_routers.invalidate_cache()
    router = capability_routers.routers_for_slug("comfyui")
    assert router is not None
    routes = [getattr(r, "path", "") for r in router.routes]
    assert "/api/comfyui/test" in routes
