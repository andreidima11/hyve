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

_component_dir = Path(__file__).resolve().parent
_bridge_mod = import_sibling(_component_dir, "bridge")
_extract_mod = import_sibling(_component_dir, "extract")
_context_mod = import_sibling(_component_dir, "context")
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


class MosquittoEntity(BaseEntity):
    slug = "mosquitto"
    label = "Mosquitto MQTT"
    description = "Broker MQTT local (Mosquitto) — primește date de la dispozitive Zigbee2MQTT, senzori WiFi și alte surse MQTT."
    icon = "fa-tower-broadcast"
    color = "text-emerald-400"
    scan_interval_seconds = 600
    updates_live = True
    uses_refresh_layers = True
    probe_interval_cycles = 6
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

    def _stored_payload(self) -> dict[str, Any]:
        try:
            from addons.entity_store import get_entity_store

            stored = (get_entity_store().get_entities(self.store_key) or {}).get("entities") or {}
            return stored if isinstance(stored, dict) else {}
        except Exception:
            return {}

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.pull_live_states(self._stored_payload())

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        """Full broker drain — rediscover HA MQTT entities and Z2M devices."""
        import core.settings as settings

        return await _drain_broker(self.config_section(settings.CFG))

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        """Light sync: merge live bridge cache with the last stored snapshot."""
        bridge = _bridge_mod.get_bridge(self.entry_id)
        stored = dict(cached or {})
        if bridge is not None and bridge.is_running():
            return _merge_payload(stored, bridge.snapshot())
        if stored:
            return stored
        return await self.probe_source()

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
        return _context_mod.format_mosquitto_context(entities if isinstance(entities, dict) else {})

    # ── Control ────────────────────────────────────────────────────────────

    def _live_entity_items(self) -> list[dict[str, Any]]:
        from addons.entity_store import get_entity_store

        store = get_entity_store()
        cached = store.get_entities(self.store_key) or {}
        raw_payload = self.live_payload(cached.get("entities") or {})
        return self.extract_entities(raw_payload)

    def _record_has_command_caps(self, record: dict[str, Any] | None) -> bool:
        if not record:
            return False
        return bool(_resolve_control_caps(record).get("command_topic"))

    def _resolve_control_record(self, entity_id: str) -> dict[str, Any] | None:
        """Find a control-ready entity row with fresh MQTT capabilities."""
        from integrations.entity_utils import entity_id_lookup_variants

        raw = str(entity_id or "").strip()
        if not raw:
            return None

        items = self._live_entity_items()
        for variant in entity_id_lookup_variants(raw):
            hit = _find_entity_record(items, variant)
            if self._record_has_command_caps(hit):
                return hit

        try:
            from core import entity_registry

            row = None
            for variant in entity_id_lookup_variants(raw):
                row = entity_registry.get_by_unique_id(variant) or entity_registry.get_by_entity_id(variant)
                if row:
                    break
            if row:
                for candidate in (
                    str(row.get("unique_id") or ""),
                    str(row.get("entity_id") or ""),
                ):
                    if not candidate:
                        continue
                    hit = _find_entity_record(items, candidate)
                    if self._record_has_command_caps(hit):
                        return hit
        except Exception:
            pass

        try:
            from core.state_observer import _last_snapshot

            for variant in entity_id_lookup_variants(raw):
                hit = _last_snapshot.get(variant)
                if self._record_has_command_caps(hit):
                    return hit
                for ent in _last_snapshot.values():
                    if ent.get("unique_id") == variant and self._record_has_command_caps(ent):
                        return ent
        except Exception:
            pass

        try:
            from core.device_control import find_entity_record

            hit = find_entity_record(raw, include_derived=False)
            if self._record_has_command_caps(hit):
                return hit
        except Exception:
            pass

        return None

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

        import core.settings as settings

        record = self._resolve_control_record(entity_id)
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
        topic = _rewrite_z2m_command_topic(topic, record, entry_key=self.entry_id)
        log.info("Z2M control %s %s -> %s %s", entity_id, verb, topic, mqtt_payload)

        await _publish(
            self.config_section(settings.CFG),
            topic,
            mqtt_payload,
            entry_key=self.entry_id,
        )
        return {"status": "ok", "topic": topic, "payload": mqtt_payload}

    async def rename_zigbee_device(
        self,
        current_name: str,
        new_name: str,
        *,
        device_id: str | None = None,
        homeassistant_rename: bool = True,
    ) -> dict[str, Any]:
        """Ask Zigbee2MQTT to persistently rename a device.

        Z2M should write the new ``friendly_name`` to its own configuration,
        but Hyve still keeps a local override because broker publish success
        does not prove Z2M persisted the rename.

        When ``homeassistant_rename`` is true, Z2M removes and republishes
        HA discovery topics so entity IDs follow the new friendly name.
        """
        try:
            import aiomqtt  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("aiomqtt nu este instalat.") from exc
        import core.settings as _settings
        from integrations import device_aliases

        bridge = _bridge_mod.get_bridge(self.entry_id)
        resolved_from = current_name
        canonical = device_aliases.canonical_device_id(device_id or current_name)
        if bridge is not None:
            resolved_from = bridge.resolve_z2m_rename_from(canonical or device_id or "", current_name)
        elif canonical:
            resolved_from = canonical

        payload_obj: dict[str, Any] = {
            "from": resolved_from,
            "to": new_name,
        }
        if homeassistant_rename:
            payload_obj["homeassistant_rename"] = True
        payload = json.dumps(payload_obj, ensure_ascii=False)
        await _publish(
            self.config_section(_settings.CFG),
            "zigbee2mqtt/bridge/request/device/rename",
            payload,
            entry_key=self.entry_id,
        )
        return {
            "status": "ok",
            "topic": "zigbee2mqtt/bridge/request/device/rename",
            "payload": payload,
            "from": resolved_from,
            "homeassistant_rename": bool(homeassistant_rename),
        }


