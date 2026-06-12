"""Mammotion session sync/bootstrap behaviour."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.mammotion.client import MammotionSession
from components.mammotion.extract import extract_mammotion_entities


def test_extract_offline_http_placeholder_produces_lawn_mower():
    payload = {
        "devices": [
            {
                "device_name": "Luba-ABC123",
                "name": "Luba-ABC123",
                "online": False,
                "kind": "mower",
            }
        ]
    }
    items = extract_mammotion_entities(payload)
    mowers = [e for e in items if e["domain"] == "lawn_mower"]
    assert len(mowers) == 1
    assert mowers[0]["state"] == "unavailable"
    assert mowers[0]["entity_id"] == "lawn_mower.luba_abc123"


def test_ensure_devices_ready_falls_back_to_http_names():
    session = MammotionSession(account="a@b.com", password="secret", cache=None)

    class _Registry:
        all_devices: list = []

    client = MagicMock()
    client._device_registry = _Registry()
    client.get_device_by_name.return_value = None
    session._hub._client = client

    with patch.object(session._hub, "_iter_device_names", return_value=[]):
        with patch.object(session._hub, "_http_device_names", AsyncMock(return_value=["Luba-XYZ"])):
            with patch("components.mammotion.hub.asyncio.sleep", new_callable=AsyncMock):
                with patch(
                    "components.mammotion.pymammotion_patch.complete_device_registration",
                    new_callable=AsyncMock,
                ):
                    names = asyncio.run(session._ensure_devices_ready())

    assert names == ["Luba-XYZ"]


def test_sync_devices_raises_when_no_devices_anywhere():
    session = MammotionSession(account="a@b.com", password="secret", cache=None)

    async def _no_devices():
        return []

    with patch.object(session._hub, "connect", new_callable=AsyncMock):
        with patch.object(session._hub, "_ensure_devices_ready", side_effect=_no_devices):
            try:
                asyncio.run(session.sync_devices())
                assert False, "expected RuntimeError"
            except RuntimeError as exc:
                assert "Niciun dispozitiv Mammotion" in str(exc)
