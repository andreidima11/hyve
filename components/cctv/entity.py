"""CCTV — RTSP camera registry for vision / automations."""

from __future__ import annotations

import json
from typing import Any

from integrations.base import BaseEntity


def _parse_cameras(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            rows = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"JSON camere invalid: {exc}") from exc
    else:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cam_id = str(row.get("id") or "").strip()
        name = str(row.get("name") or "").strip()
        rtsp = str(row.get("rtsp_url") or row.get("url") or "").strip()
        if not cam_id and not rtsp:
            continue
        item = {
            "id": cam_id or name or rtsp,
            "name": name or cam_id or "Camera",
            "rtsp_url": rtsp,
        }
        ctx = str(row.get("context") or "").strip()
        if ctx:
            item["context"] = ctx
        out.append(item)
    return out


class CctvEntity(BaseEntity):
    slug = "cctv"
    label = "CCTV"
    description = "Camere RTSP pentru descriere vision și automatizări."
    icon = "fa-video"
    color = "text-violet-400"
    supports_sync = False
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {
            "key": "cameras",
            "label": "Camere (JSON)",
            "type": "text",
            "placeholder": '[{"id":"living","name":"Living","rtsp_url":"rtsp://..."}]',
            "help": "Listă JSON: id, name, rtsp_url, context (opțional).",
        },
    ]

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        try:
            cams = _parse_cameras((data or {}).get("cameras"))
        except ValueError as exc:
            return {"ok": False, "message": str(exc)}
        if not cams:
            return {"ok": False, "message": "Adaugă cel puțin o cameră RTSP."}
        return {"ok": True, "message": f"{len(cams)} cameră/camere configurate."}

    async def fetch_entities(self) -> dict[str, Any]:
        return {"cameras": _parse_cameras(self.entry_data.get("cameras"))}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return []
