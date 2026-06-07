from __future__ import annotations

from typing import Any

from integrations.base import BaseEntity


class DemoSensorEntity(BaseEntity):
    slug = "demo_sensor"
    label = "Demo Sensor"
    description = "Example custom integration — returns a static sensor for testing the component loader."
    icon = "fa-flask"
    color = "text-violet-400"
    scan_interval_seconds = 300
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {"key": "name", "label": "Sensor name", "type": "text", "default": "Demo"},
    ]

    async def fetch_entities(self) -> dict[str, Any]:
        name = str(self.entry_data.get("name") or "Demo").strip() or "Demo"
        return {"name": name, "value": 42}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        name = str((payload or {}).get("name") or "Demo")
        value = (payload or {}).get("value", 0)
        eid = f"demo_sensor.{self.entry_id[:8] if self.entry_id else 'default'}_value"
        return [
            {
                "entity_id": eid,
                "name": name,
                "state": str(value),
                "domain": "sensor",
                "source": self.slug,
                "aliases": [],
                "unit": "",
                "controllable": False,
            }
        ]
