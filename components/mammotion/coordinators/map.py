"""Map and schedule sync coordinator."""

from __future__ import annotations

from typing import Any


class MapCoordinator:
    """HA ``MammotionMapUpdateCoordinator`` subset."""

    def __init__(self, client: Any, device_name: str) -> None:
        self._client = client
        self.device_name = device_name
        self.map_sync_status = "synced"

    def meta(self) -> dict[str, Any]:
        return {"map_sync_status": self.map_sync_status}

    async def sync_maps(self) -> None:
        self.map_sync_status = "syncing"
        await self._client.start_map_sync(self.device_name)
        self.map_sync_status = "synced"

    async def sync_schedule(self) -> None:
        await self._client.start_plan_sync(self.device_name)
