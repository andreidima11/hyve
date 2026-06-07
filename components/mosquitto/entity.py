"""Mosquitto MQTT broker integration provider.

Generic MQTT-Discovery consumer (Hyve native):

* Primary source = ``homeassistant/+/+/config`` (and ``+/+/+/config`` for
  topics that include a ``node_id``). Each retained discovery payload becomes
  a single entity in Hyve, with ``state_topic`` / ``command_topic`` /
  ``value_template`` / ``options`` / ``min`` / ``max`` etc. attached as
  capabilities.
* Secondary source = ``zigbee2mqtt/bridge/devices`` for device-meta enrichment
  (model, manufacturer, friendly name) and a fallback path when the user
  hasn't enabled HA discovery in Z2M.

The provider also reads retained ``state_topic`` payloads at sync time so the
initial UI render shows real values; live updates after that are pushed by
``mosquitto_bridge`` over SSE.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from pathlib import Path
from integrations.component_import import import_sibling

_bridge_mod = import_sibling(Path(__file__).resolve().parent, "bridge")
_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_mosquitto_candidates = _extract_mod.extract_mosquitto_candidates
_merge_payload = _extract_mod._merge_payload
_drain_broker = _extract_mod._drain_broker
_find_entity_record = _extract_mod._find_entity_record
_build_command = _extract_mod._build_command
_resolve_control_caps = _extract_mod._resolve_control_caps
_rewrite_z2m_command_topic = _extract_mod._rewrite_z2m_command_topic
_publish = _extract_mod._publish

from integrations.base import BaseEntity

log = logging.getLogger("integrations.mosquitto")

_Z2M_BRIDGE_DEVICES = "zigbee2mqtt/bridge/devices"
_Z2M_DEVICE_STATE = "zigbee2mqtt/+"
_HA_DISCOVERY_2 = "homeassistant/+/+/config"
_HA_DISCOVERY_3 = "homeassistant/+/+/+/config"

_DEFAULT_DISCOVERY_WAIT = 4.0


class MosquittoEntity(BaseEntity):
    slug = "mosquitto"
    label = "Mosquitto MQTT"
    description = "Broker MQTT local (Mosquitto) — primește date de la dispozitive Zigbee2MQTT, senzori WiFi și alte surse MQTT."
    icon = "fa-tower-broadcast"
    color = "text-emerald-400"
    scan_interval_seconds = 600
    updates_live = True
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "host", "label": "Host", "type": "text", "required": True, "placeholder": "localhost"},
        {"key": "port", "label": "Port", "type": "number", "default": 1883, "min": 1, "max": 65535},
        {"key": "username", "label": "Utilizator", "type": "text"},
        {"key": "password", "label": "Parolă", "type": "password", "secret": True},
        {"key": "scan_interval", "label": "Re-scan broker (sec)", "type": "number", "default": 600, "min": 1,
         "help": "Doar pentru sync manual / reîmprospătare discovery. Stările Zigbee/MQTT se actualizează instant prin bridge (ca Home Assistant MQTT), fără a aștepta acest interval."},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool((section.get("host") or "").strip())

    # ── Fetch ──────────────────────────────────────────────────────────────

    async def fetch_entities(self) -> dict[str, Any]:
        """Snapshot retained discovery + state messages from the broker.

        If a persistent ``MosquittoBridge`` is already running (started by the
        app lifespan), reuse its in-memory cache instead of opening yet another
        connection — this avoids racing with live updates.

        During early startup the bridge may be connected but still warming up
        (empty ``z2m_devices`` / ``discovery``).  We merge the live snapshot
        with the previously stored payload so a warm-up fetch never erases
        good data that was persisted before the restart.
        """
        # bridge module loaded as _bridge_mod above
        import settings

        bridge = _bridge_mod.get_bridge(self.entry_id)
        if bridge is not None and bridge.is_running():
            live = bridge.snapshot()
            # Merge with last stored payload to avoid losing z2m_devices /
            # discovery during the bridge warm-up window.
            from addons.entity_store import get_entity_store
            try:
                stored = (get_entity_store().get_entities(self.store_key) or {}).get("entities") or {}
            except Exception:
                stored = {}
            return _merge_payload(stored, live)

        return await _drain_broker(self.config_section(settings.CFG))

    def live_payload(self, stored: dict[str, Any]) -> dict[str, Any]:
        """Merge stored discovery with the live MQTT bridge cache so the
        dashboard's entity builder (which calls ``extract_entities`` directly)
        sees fresh non-retained Z2M state messages instead of yesterday's
        SQLite snapshot.
        """
        # bridge module loaded as _bridge_mod above

        payload = stored if isinstance(stored, dict) else {}
        # Stored layout from ``list_entities`` is ``{"entities": {...real...}}``;
        # callers passing the inner dict pass it directly. Handle both.
        inner = payload.get("entities") if isinstance(payload.get("entities"), dict) else payload
        bridge = _bridge_mod.get_bridge(self.entry_id)
        if bridge is not None and bridge.is_running():
            return _merge_payload(inner or {}, bridge.snapshot())
        return inner or {}

    async def list_entities(self, store) -> list[dict[str, Any]]:
        """List entities using the freshest live bridge metadata available.

        The SQLite store is still the durable raw snapshot, but Z2M friendly
        names can change while Hyve is running. Prefer non-empty bridge caches
        so names changed directly in Zigbee2MQTT show up immediately and can be
        remembered locally for future Hyve restarts.
        """
        stored = store.get_entities(self.store_key) or {}
        payload = self.live_payload(stored.get("entities") or {})
        return self.extract_entities(payload)

    # ── Extract ────────────────────────────────────────────────────────────

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_mosquitto_candidates(payload)

    # ── Context ────────────────────────────────────────────────────────────

    def format_context(self, entities: dict[str, Any]) -> str:
        if not isinstance(entities, dict):
            return ""
        devices = entities.get("z2m_devices") or []
        names = [d.get("friendly_name") for d in devices
                 if isinstance(d, dict) and d.get("type") != "Coordinator"]
        names = [n for n in names if n]
        disc_count = len(entities.get("discovery") or {})
        if not names and not disc_count:
            return ""
        bits = []
        if names:
            preview = ", ".join(names[:8])
            more = f" (+{len(names) - 8})" if len(names) > 8 else ""
            bits.append(f"{len(names)} dispozitive Zigbee ({preview}{more})")
        if disc_count:
            bits.append(f"{disc_count} entități MQTT-Discovery")
        return "Mosquitto MQTT: " + "; ".join(bits) + "."

    # ── Control ────────────────────────────────────────────────────────────

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Publish an MQTT command derived from the entity's discovery payload."""
        try:
            import aiomqtt  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("aiomqtt nu este instalat.") from exc

        import settings

        # Fast path: try the state observer's snapshot (no I/O, no rebuild).
        record = None
        try:
            from core.state_observer import _last_snapshot
            record = _last_snapshot.get(entity_id)
            if not record:
                for ent in _last_snapshot.values():
                    if ent.get("unique_id") == entity_id:
                        record = ent
                        break
        except Exception:
            pass

        # Slow path: rebuild from stored payload (only if snapshot missed).
        if not record:
            from addons.entity_store import get_entity_store
            store = get_entity_store()
            cached = store.get_entities(self.store_key) or {}
            raw_payload = cached.get("entities") or {}
            record = _find_entity_record(self.extract_entities(raw_payload), entity_id)

        if not record:
            raise ValueError(f"Entity necunoscut: {entity_id}")

        caps = _resolve_control_caps(record)
        domain = (record.get("domain") or "").lower()
        verb = (action or "").lower()

        topic, mqtt_payload = _build_command(domain, verb, caps, data)
        if not topic:
            raise ValueError(
                f"Entitatea {entity_id} nu suportă acțiunea {action!r}"
            )
        topic = _rewrite_z2m_command_topic(topic, record)

        await _publish(self.config_section(settings.CFG), topic, mqtt_payload)
        return {"status": "ok", "topic": topic, "payload": mqtt_payload}

    async def rename_zigbee_device(self, current_name: str, new_name: str) -> dict[str, Any]:
        """Ask Zigbee2MQTT to persistently rename a device.

        Z2M should write the new ``friendly_name`` to its own configuration,
        but Hyve still keeps a local override because broker publish success
        does not prove Z2M persisted the rename.
        """
        try:
            import aiomqtt  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("aiomqtt nu este instalat.") from exc
        import settings as _settings
        payload = json.dumps({"from": current_name, "to": new_name}, ensure_ascii=False)
        await _publish(
            self.config_section(_settings.CFG),
            "zigbee2mqtt/bridge/request/device/rename",
            payload,
        )
        return {"status": "ok", "topic": "zigbee2mqtt/bridge/request/device/rename", "payload": payload}


