"""Device rename orchestration service."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from integrations.device_rename import DeviceRenameRequest, DeviceRenameService


def test_rename_validates_required_fields():
    async def run():
        svc = DeviceRenameService()
        with pytest.raises(ValueError, match="required"):
            await svc.rename("", "dev1", DeviceRenameRequest(name="Lamp"))

    asyncio.run(run())


def test_rename_sets_alias_and_invalidates_cache():
    async def run():
        svc = DeviceRenameService()
        invalidated: list[bool] = []

        with patch("integrations.device_aliases.canonical_device_id", return_value="0xabc"):
            with patch("integrations.device_aliases.get_alias", return_value="Old"):
                with patch("integrations.device_aliases.set_alias") as set_alias:
                    with patch("core.device_registry.get_device", return_value=None):
                        with patch("core.device_registry.set_device_name"):
                            with patch(
                                "core.entity_registry.refresh_entity_ids_for_device_rename",
                                return_value={"updated": 1},
                            ):
                                with patch.object(
                                    svc,
                                    "_invalidate_entity_cache",
                                    side_effect=lambda: invalidated.append(True),
                                ):
                                    with patch.object(svc, "_purge_bridge_discovery", return_value=0):
                                        with patch.object(
                                            svc,
                                            "_upstream_rename",
                                            new_callable=AsyncMock,
                                            return_value={"attempted": False, "ok": False, "detail": None},
                                        ):
                                            with patch.object(svc, "_resync_after_rename", new_callable=AsyncMock):
                                                result = await svc.rename(
                                                    "mosquitto",
                                                    "0xabc",
                                                    DeviceRenameRequest(name="New Lamp", current_name="Old"),
                                                )

        set_alias.assert_called_once_with("mosquitto", "0xabc", "New Lamp")
        assert invalidated
        assert result["name"] == "New Lamp"
        assert result["device_id"] == "0xabc"
        assert result["registry_refresh"] == {"updated": 1}

    asyncio.run(run())


def test_rename_alias_failure_raises_runtime_error():
    async def run():
        svc = DeviceRenameService()
        with patch("integrations.device_aliases.canonical_device_id", return_value="0xabc"):
            with patch("integrations.device_aliases.get_alias", return_value=None):
                with patch("core.device_registry.get_device", return_value=None):
                    with patch(
                        "integrations.device_aliases.set_alias",
                        side_effect=OSError("disk full"),
                    ):
                        with pytest.raises(RuntimeError, match="Failed to save alias"):
                            await svc.rename(
                                "mosquitto",
                                "0xabc",
                                DeviceRenameRequest(name="X"),
                            )

    asyncio.run(run())
