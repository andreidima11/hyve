"""Tapo HA-style config flow (api / full phases)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.tapo import entity as tapo_entity
from components.tapo.entity import TapoEntity, _connection_metadata


def _fake_camera_dev(*, alias: str = "Cam", model: str = "C225"):
    dev = MagicMock()
    dev.alias = alias
    dev.model = model
    dev.host = "192.168.0.125"
    dev.mac = "AA:BB:CC:DD:EE:FF"
    dev.device_type = MagicMock(value="camera")
    dev.children = []
    dev.credentials_hash = "hash123"
    dev.config.connection_type.to_dict.return_value = {"login_version": 3}
    dev.config.uses_http = False
    dev.modules = {}
    return dev


def test_check_connection_api_phase_camera_requires_rtsp_step():
    section = {
        "host": "192.168.0.125",
        "username": "admin",
        "password": "secret",
        "live_view": True,
    }
    dev = _fake_camera_dev()

    async def _run():
        with patch.object(tapo_entity, "_tcp_probe", new_callable=AsyncMock, return_value=None):
            with patch.object(TapoEntity, "_connect", new_callable=AsyncMock, return_value=dev):
                return await TapoEntity._check_connection(section, phase="api")

    result = asyncio.run(_run())

    assert result["ok"] is True
    assert result["requires_camera_rtsp"] is True
    assert result["phase"] == "api"
    assert "entry_patch" in result
    assert result["entry_patch"].get("device_model") == "C225"


def test_check_connection_full_phase_rtsp_missing():
    section = {
        "host": "192.168.0.125",
        "username": "admin",
        "password": "secret",
        "live_view": True,
    }
    dev = _fake_camera_dev()

    async def _run():
        with patch.object(tapo_entity, "_tcp_probe", new_callable=AsyncMock, return_value=None):
            with patch.object(TapoEntity, "_connect", new_callable=AsyncMock, return_value=dev):
                with patch.object(TapoEntity, "_rtsp_url", return_value=None):
                    return await TapoEntity._check_connection(section, phase="full")

    result = asyncio.run(_run())

    assert result["ok"] is False
    assert result["requires_camera_rtsp"] is True


def test_check_connection_full_phase_rtsp_validated():
    section = {
        "host": "192.168.0.125",
        "username": "admin",
        "password": "secret",
        "rtsp_username": "cam",
        "rtsp_password": "camsecret",
        "live_view": True,
    }
    dev = _fake_camera_dev()
    rtsp = "rtsp://cam:camsecret@192.168.0.125:554/stream1"

    async def _run():
        with patch.object(tapo_entity, "_tcp_probe", new_callable=AsyncMock, return_value=None):
            with patch.object(TapoEntity, "_connect", new_callable=AsyncMock, return_value=dev):
                with patch.object(TapoEntity, "_rtsp_url", return_value=rtsp):
                    with patch.object(tapo_entity, "_validate_rtsp_stream", new_callable=AsyncMock, return_value=True):
                        return await TapoEntity._check_connection(section, phase="full")

    result = asyncio.run(_run())

    assert result["ok"] is True
    assert result["phase"] == "full"
    assert "ffmpeg" in result["message"]


def test_async_validate_entry_merges_entry_patch():
    section = {
        "host": "192.168.0.125",
        "username": "admin",
        "password": "secret",
        "rtsp_username": "cam",
        "rtsp_password": "camsecret",
    }
    patch_data = {"device_alias": "Living room", "device_model": "C225"}

    async def _run():
        with patch.object(
            TapoEntity,
            "_check_connection",
            new_callable=AsyncMock,
            return_value={"ok": True, "entry_patch": patch_data},
        ):
            return await TapoEntity.async_validate_entry(section)

    result = asyncio.run(_run())

    assert result["ok"] is True
    assert result["title"] == "Living room"
    assert result["data"] == patch_data


def test_connection_metadata_extracts_fields():
    dev = _fake_camera_dev(alias="Hall")
    meta = _connection_metadata(dev)
    assert meta["credentials_hash"] == "hash123"
    assert meta["device_alias"] == "Hall"
    assert meta["connection_parameters"] == {"login_version": 3}


def test_live_view_disabled_skips_rtsp_url():
    inst = TapoEntity(
        entry_id="e1",
        entry_data={"host": "192.168.0.125", "live_view": False, "rtsp_username": "u", "rtsp_password": "p"},
        entry_title="Cam",
    )
    dev = _fake_camera_dev()
    assert inst._rtsp_url(dev) is None
