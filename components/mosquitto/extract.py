"""MQTT discovery and Zigbee2MQTT expose parsing → Hyve entities."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling
from integrations.entity_utils import finalize_entities as _finalize
from integrations.entity_utils import is_state_controllable, slugify
from smart_home_registry import entity_domain, normalize_entity_record

log = logging.getLogger("integrations.mosquitto")

_DEFAULT_DISCOVERY_WAIT = 4.0
_Z2M_BRIDGE_DEVICES = "zigbee2mqtt/bridge/devices"
_Z2M_BRIDGE_INFO = "zigbee2mqtt/bridge/info"
_Z2M_BRIDGE_STATE = "zigbee2mqtt/bridge/state"
_Z2M_BRIDGE_DEVICE_ID = "z2m_bridge"
_Z2M_BRIDGE_DEVICE_NAME = "Zigbee2MQTT"
_Z2M_DEVICE_STATE = "zigbee2mqtt/+"
_HA_DISCOVERY_2 = "homeassistant/+/+/config"
_HA_DISCOVERY_3 = "homeassistant/+/+/+/config"

_bridge_mod = import_sibling(Path(__file__).resolve().parent, "bridge")

def extract_mosquitto_candidates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []

    discovery = payload.get("discovery") or {}
    states = payload.get("states") or {}
    z2m_devices = payload.get("z2m_devices") or []
    device_meta = _build_device_meta(z2m_devices)

    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    bridge_entities = _entities_from_z2m_bridge(payload)
    for ent in bridge_entities:
        eid = ent["entity_id"]
        uid = ent.get("unique_id", "")
        if eid in seen or uid in seen:
            continue
        seen.add(eid)
        if uid:
            seen.add(uid)
        items.append(ent)

    # Z2M ``bridge/devices`` exposes are authoritative (HA MQTT uses live
    # state_topic + value_template, but capability list comes from Z2M).
    expose_covered: dict[str, set[str]] = {}
    if z2m_devices:
        items.extend(_entities_from_all_z2m_devices(
            z2m_devices, states, seen, expose_covered,
        ))

    # HA discovery fills gaps only (stale rows after rename are skipped).
    discovery_covered: dict[str, set[str]] = {}

    for topic, msg in discovery.items():
        if not isinstance(msg, dict):
            continue
        entity = _entity_from_discovery(topic, msg, states, device_meta)
        if not entity:
            continue
        attrs = entity.get("attributes") or {}
        dev_id = str(attrs.get("device_id") or "")
        dev_name = str(attrs.get("device_name") or "")
        if "zigbee2mqtt_bridge" in dev_id.lower() or dev_name.lower().startswith("zigbee2mqtt bridge"):
            continue
        if entity["entity_id"] in seen or entity.get("unique_id") in seen:
            continue

        # Extract which Z2M property this discovery entity covers.
        vt = str((attrs.get("capabilities") or {}).get("value_template") or "")
        prop = _extract_z2m_property_from_template(vt)
        dom = str(entity.get("domain") or "").lower()
        if dev_id and prop and prop in expose_covered.get(dev_id, set()):
            continue
        if (
            z2m_devices
            and _device_known_in_z2m(z2m_devices, dev_id)
            and dom in {"sensor", "binary_sensor", "event", "button"}
            and entity.get("state") == "unknown"
        ):
            continue

        # Z2M creates many discovery entries for the same property (e.g.
        # one sensor per action value for remotes). Skip duplicates.
        if dev_id and prop:
            already = discovery_covered.get(dev_id, set())
            if prop in already:
                continue
            # For event-like properties (action) that Z2M splits into many
            # per-value discovery entries, skip ALL of them -- the expose
            # parser creates a single clean entity instead. Don't mark as
            # covered so the expose parser picks it up.
            if prop == "action":
                continue
            if entity.get("state") != "unknown" or entity.get("controllable"):
                discovery_covered.setdefault(dev_id, set()).add(prop)

        seen.add(entity["entity_id"])
        if entity.get("unique_id"):
            seen.add(entity["unique_id"])
        items.append(entity)

    items.sort(key=lambda x: ((x.get("attributes") or {}).get("device_name") or "",
                              x.get("name") or ""))
    # HA-style: rewrite entity_id as ``<domain>.<object_id>`` while keeping
    # the legacy ``mqtt:<slug>`` form as ``unique_id`` for routing.
    from smart_home_registry import normalize_entity_record
    for item in items:
        normalize_entity_record(item, default_source="mosquitto")
    return items

# ── Discovery → entity ──────────────────────────────────────────────────────


_DOMAIN_TOPIC_RE = re.compile(r"^homeassistant/([^/]+)/(?:([^/]+)/)?([^/]+)/config$")
_ACTION_COMPARE_RE = re.compile(r"value_json\.action\s*[=!]")


def _should_skip_discovery_junk(
    topic: str,
    msg: dict[str, Any],
    domain: str,
    object_id: str,
) -> bool:
    """Drop Z2M per-action HA discovery noise (binary sensors, legacy triggers)."""
    vt = str(msg.get("value_template") or msg.get("val_tpl") or "")
    stvt = str(msg.get("state_value_template") or msg.get("stat_val_tpl") or "")
    combined = f"{vt} {stvt}"
    if _ACTION_COMPARE_RE.search(combined):
        return True
    oid = str(object_id or "").lower()
    if oid.startswith("action_") and domain in {"binary_sensor", "sensor", "event"}:
        return True
    if "/action_" in topic.lower() and domain in {"binary_sensor", "sensor", "event"}:
        return True
    uid = str(msg.get("unique_id") or msg.get("uniq_id") or "").lower()
    if "_action_" in uid and domain in {"binary_sensor", "sensor"}:
        return True
    return False


def _entity_from_discovery(
    topic: str,
    msg: dict[str, Any],
    states: dict[str, Any],
    device_meta: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    m = _DOMAIN_TOPIC_RE.match(topic)
    if not m:
        return None
    domain = m.group(1)
    # device_automation / device_trigger are HA automation triggers, not real
    # entities (Z2M creates one per action value for remotes). Skip them.
    if domain in {"device_automation", "device_trigger", "update"}:
        return None
    object_id = m.group(3)
    if _should_skip_discovery_junk(topic, msg, domain, object_id):
        return None

    unique_id = (msg.get("unique_id") or msg.get("uniq_id") or object_id or "").strip()
    if not unique_id:
        return None
    legacy_id = f"mqtt:{slugify(unique_id)}"

    device = msg.get("device") or msg.get("dev") or {}
    identifiers = device.get("identifiers") or device.get("ids") or []
    if isinstance(identifiers, str):
        identifiers = [identifiers]
    device_id = (identifiers[0] if identifiers else "").strip() or ""
    # Z2M discovery prefixes IDs with ``zigbee2mqtt_`` while the Z2M-only
    # fallback path uses the bare IEEE. Strip the prefix so a single canonical
    # ID is used for grouping, alias lookup and rename, regardless of source.
    if device_id.lower().startswith("zigbee2mqtt_"):
        device_id = device_id[len("zigbee2mqtt_"):]

    device_name = (device.get("name") or "").strip()
    feature_name = (msg.get("name") or object_id or "").strip()
    if device_name and feature_name and not feature_name.lower().startswith(device_name.lower()):
        display_name = f"{device_name} {feature_name}"
    else:
        display_name = feature_name or device_name or legacy_id

    state_topic = msg.get("state_topic") or msg.get("stat_t") or ""
    value_template = msg.get("value_template") or msg.get("val_tpl") or ""
    state_value_template = msg.get("state_value_template") or msg.get("stat_val_tpl") or ""
    template = value_template or state_value_template
    live_payload = _live_z2m_payload(
        states, device_id, device_meta, state_topic, extra_names=[device_name, feature_name],
    )
    z2m_prop = _extract_z2m_property_from_template(template)
    raw_state = live_payload if live_payload else _decode_z2m_payload(states.get(state_topic) if state_topic else None)
    if z2m_prop and isinstance(live_payload, dict) and z2m_prop in live_payload:
        state_value = live_payload.get(z2m_prop)
    else:
        state_value = _apply_value_template(template, raw_state)

    # If the resolved state is a dict/list (no template to extract a scalar),
    # this discovery entry points at an aggregate state topic and isn't a
    # useful standalone entity — skip it.
    if isinstance(state_value, (dict, list)):
        return None

    command_topic = msg.get("command_topic") or msg.get("cmd_t") or ""
    payload_on = msg.get("payload_on") or msg.get("pl_on") or "ON"
    payload_off = msg.get("payload_off") or msg.get("pl_off") or "OFF"
    state_on = msg.get("state_on") or msg.get("stat_on") or payload_on
    state_off = msg.get("state_off") or msg.get("stat_off") or payload_off

    unit = msg.get("unit_of_measurement") or msg.get("unit_of_meas") or ""
    device_class = msg.get("device_class") or msg.get("dev_cla") or ""
    options = msg.get("options") or msg.get("opts") or []
    if not isinstance(options, list):
        options = []

    capabilities: dict[str, Any] = {
        "command_topic": command_topic,
        "state_topic": state_topic,
        "value_template": value_template,
        "payload_on": payload_on,
        "payload_off": payload_off,
        "state_on": state_on,
        "state_off": state_off,
        "options": options,
        "min": msg.get("min") or msg.get("min_value"),
        "max": msg.get("max") or msg.get("max_value"),
        "step": msg.get("step"),
        "unit": unit,
        "device_class": device_class,
        "icon": msg.get("icon") or "",
    }
    if not z2m_prop:
        z2m_prop = _extract_z2m_property_from_template(template)
    if z2m_prop:
        capabilities["z2m_property"] = z2m_prop

    meta_row = device_meta.get(device_id) or {}
    live_friendly = str(meta_row.get("friendly_name") or "").strip()
    if live_friendly:
        capabilities["state_topic"] = f"zigbee2mqtt/{live_friendly}"

    # Optional secondary control surfaces (lights w/ brightness etc.)
    if msg.get("brightness_command_topic"):
        capabilities["brightness_command_topic"] = msg.get("brightness_command_topic")
        capabilities["brightness_state_topic"] = msg.get("brightness_state_topic") or ""
        capabilities["brightness_value_template"] = msg.get("brightness_value_template") or ""
        capabilities["brightness_scale"] = msg.get("brightness_scale") or 255

    if z2m_prop == "action" and domain in {"sensor", "event"}:
        domain = "event"

    norm_state = _normalize_state(state_value, domain, capabilities)
    controllable = bool(command_topic)

    attributes: dict[str, Any] = {
        "via": "mqtt",
        "discovery_topic": topic,
        "unique_id": unique_id,
        "object_id": object_id,
        "device_id": device_id,
        "device_name": device_name,
        "device_model": device.get("model") or "",
        "device_manufacturer": device.get("manufacturer") or device.get("mf") or "",
        "device_sw": device.get("sw_version") or device.get("sw") or "",
        "capabilities": capabilities,
        "raw_state": raw_state,
    }
    if z2m_prop:
        attributes["z2m_property"] = z2m_prop
        attributes["state_topic"] = state_topic
    # Augment with Z2M device meta if we recognise it.
    if device_id and device_id in device_meta:
        meta = device_meta[device_id]
        attributes["zigbee_ieee"] = meta.get("ieee_address") or ""
        if not attributes["device_model"]:
            attributes["device_model"] = meta.get("model") or ""
        if not attributes["device_manufacturer"]:
            attributes["device_manufacturer"] = meta.get("manufacturer") or ""
        friendly = (meta.get("friendly_name") or "").strip()
        attributes["zigbee_friendly"] = friendly
        # Prefer the live Z2M friendly_name over the discovery `device.name`
        # (which Z2M sometimes leaves as the raw IEEE after a rename until
        # the next full restart). Treat plain IEEE strings as "no name".
        ieee_like = friendly.lower().startswith("0x") and all(
            c in "0123456789abcdef" for c in friendly.lower()[2:]
        )
        if friendly and not ieee_like:
            old_name = device_name
            attributes["device_name"] = friendly
            # Recompute the display name with the new device label so the
            # entity title reads "<friendly> <feature>" instead of the IEEE.
            if feature_name and not feature_name.lower().startswith(friendly.lower()):
                # Strip the old IEEE prefix if it's still in feature_name
                if old_name and feature_name.lower().startswith(old_name.lower()):
                    tail = feature_name[len(old_name):].strip()
                    display_name = f"{friendly} {tail}" if tail else friendly
                else:
                    display_name = f"{friendly} {feature_name}"
            else:
                display_name = feature_name or friendly

    # HA-style entity_id derived from the human-friendly device/feature name.
    # Fall back to the original opaque unique_id if no name is available.
    object_basis = display_name if (display_name and display_name != legacy_id) else unique_id
    ha_entity_id = f"{(domain if domain in {'sensor','binary_sensor','switch','light','climate','water_heater','number','select','scene','weather','sun','cover','lock','vacuum','fan','media_player','button','image','event'} else 'sensor')}.{slugify(object_basis)}"

    return {
        "entity_id": ha_entity_id,
        "unique_id": legacy_id,
        "name": display_name,
        "state": norm_state,
        "domain": domain,
        "source": "mosquitto",
        "aliases": [],
        "unit": unit,
        "controllable": controllable,
        "attributes": attributes,
    }


# ── Value template ─────────────────────────────────────────────────────────

_VT_VALUE_JSON = re.compile(
    r"\{\{\s*value_json\.([A-Za-z_][A-Za-z0-9_]*)(?:\s*\|\s*[^}]+)?\s*\}\}"
)
_VT_VALUE = re.compile(r"\{\{\s*value(?:\s*\|\s*[^}]+)?\s*\}\}")


def _extract_z2m_property_from_template(template: str) -> str:
    """Extract the Z2M property name from a ``{{ value_json.X }}`` template."""
    if not template:
        return ""
    m = _VT_VALUE_JSON.search(template)
    return m.group(1) if m else ""


_VT_ACTION_COMPARE = re.compile(
    r"value_json\.action\s*==\s*['\"]([^'\"]+)['\"]"
)


def _decode_z2m_payload(raw: Any) -> Any:
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return raw
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return raw
    return raw


def _z2m_name_hints(
    device_id: str,
    device_meta: dict[str, dict[str, Any]],
    *extra: str,
) -> set[str]:
    hints: set[str] = set()
    for raw in extra:
        text = str(raw or "").strip()
        if text:
            hints.add(text)
    meta = device_meta.get(device_id) or {}
    for key in ("friendly_name", "ieee_address"):
        text = str(meta.get(key) or "").strip()
        if text:
            hints.add(text)
    ieee = str(meta.get("ieee_address") or device_id or "").strip()
    try:
        from integrations import device_aliases
        from integrations.device_aliases import canonical_device_id

        cid = canonical_device_id(ieee) or canonical_device_id(device_id) or device_id
        alias = device_aliases.get_alias("mosquitto", cid)
        if alias:
            hints.add(alias.strip())
    except Exception:
        pass
    try:
        from core import device_registry

        row = device_registry.get_device(ieee) if ieee else None
        if row:
            for key in ("name", "z2m_friendly_name"):
                text = str(row.get(key) or "").strip()
                if text:
                    hints.add(text)
    except Exception:
        pass
    return {h for h in hints if h}


def _resolve_z2m_display_name(device: dict[str, Any]) -> str:
    """Human device label for entities — registry/YAML beat raw Z2M IEEE names.

    Home Assistant shows the device_registry name while MQTT topics still use
    Z2M ``friendly_name``. Hyve mirrors that: UI/grouping uses the stored label
    even when ``bridge/devices`` temporarily reports only the IEEE address.
    """
    ieee = str(device.get("ieee_address") or "").strip()
    friendly = str(device.get("friendly_name") or "").strip()
    try:
        from integrations.device_aliases import canonical_device_id
    except Exception:
        canonical_device_id = lambda x: str(x or "").strip()  # type: ignore[assignment]

    key = canonical_device_id(ieee) or ieee
    candidates: list[str] = []

    try:
        from core import device_registry

        row = device_registry.get_device(key) if key else None
        if row:
            for field in ("name", "z2m_friendly_name"):
                text = str(row.get(field) or "").strip()
                if text and not _IEEE_TOPIC_RE.match(text):
                    candidates.append(text)
    except Exception:
        pass

    try:
        from integrations import device_aliases

        alias = device_aliases.get_alias("mosquitto", key)
        if alias and str(alias).strip():
            candidates.append(str(alias).strip())
    except Exception:
        pass

    if friendly and not _IEEE_TOPIC_RE.match(friendly):
        candidates.append(friendly)

    for label in candidates:
        if label and not _IEEE_TOPIC_RE.match(label):
            return label
    return friendly or key


def _device_known_in_z2m(z2m_devices: list[Any], device_id: str) -> bool:
    did = str(device_id or "").strip()
    if not did:
        return False
    for raw in z2m_devices or []:
        if not isinstance(raw, dict):
            continue
        ieee = str(raw.get("ieee_address") or "").strip()
        friendly = str(raw.get("friendly_name") or "").strip()
        if did in {ieee, friendly}:
            return True
    return False


def _is_z2m_non_state_topic(topic: str) -> bool:
    """True for Hyve/Z2M control topics that must not overwrite device state."""
    t = str(topic or "").strip().lower()
    return not t or t.endswith("/get") or "/set" in t


def _merge_z2m_property_values(into: dict[str, Any], raw: dict[str, Any]) -> None:
    """Merge Z2M JSON without letting empty /get poll placeholders clobber real values."""
    for key, value in raw.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, dict) and not value:
            continue
        into[key] = value


def _live_z2m_payload(
    states: dict[str, Any],
    device_id: str,
    device_meta: dict[str, dict[str, Any]],
    state_topic: str = "",
    extra_names: list[str] | None = None,
) -> dict[str, Any]:
    """Resolve the live Z2M JSON for a device (HA matches by state_topic, we alias topics)."""
    candidates: list[str] = []
    seen_topics: set[str] = set()

    def _add(topic: str) -> None:
        t = str(topic or "").strip()
        if not t or _is_z2m_non_state_topic(t) or t in seen_topics:
            return
        seen_topics.add(t)
        candidates.append(t)

    _add(state_topic)
    hints = _z2m_name_hints(device_id, device_meta, *(extra_names or []))
    meta = device_meta.get(device_id) or {}
    ieee = str(meta.get("ieee_address") or device_id or "").strip().lower()
    for name in hints:
        _add(f"zigbee2mqtt/{name}")
        _add(f"zigbee2mqtt/{name}/action")

    for topic in states:
        if not str(topic).startswith("zigbee2mqtt/"):
            continue
        if _is_z2m_non_state_topic(topic):
            continue
        parts = str(topic).split("/")
        if len(parts) < 2:
            continue
        segment = parts[1]
        if segment in hints or (ieee and segment.lower() == ieee):
            _add(topic)

    merged: dict[str, Any] = {}
    for topic in candidates:
        raw = _decode_z2m_payload(states.get(topic))
        if isinstance(raw, dict):
            _merge_z2m_property_values(merged, raw)
        elif isinstance(raw, str) and raw.strip() and topic.endswith("/action"):
            merged["action"] = raw.strip()
    return merged


def _device_has_expose_prop(z2m_devices: list[Any], device_id: str, prop: str) -> bool:
    """True when Z2M bridge/devices lists ``prop`` on the matching device."""
    target = str(prop or "").strip().lower()
    if not target:
        return False
    for raw in z2m_devices or []:
        if not isinstance(raw, dict):
            continue
        ieee = str(raw.get("ieee_address") or "").strip()
        friendly = str(raw.get("friendly_name") or "").strip()
        if device_id not in {ieee, friendly}:
            continue
        definition = raw.get("definition") if isinstance(raw.get("definition"), dict) else {}
        exposes = definition.get("exposes") or []

        def _walk(entry: Any) -> bool:
            if not isinstance(entry, dict):
                return False
            p = str(entry.get("property") or "").strip().lower()
            if p == target:
                return True
            for feat in entry.get("features") or []:
                if _walk(feat):
                    return True
            return False

        for entry in exposes if isinstance(exposes, list) else []:
            if _walk(entry):
                return True
    return False


def z2m_get_payload_for_device(device: dict[str, Any]) -> dict[str, str]:
    """Build Z2M ``/get`` payload from device exposes (HA reads each property)."""
    definition = device.get("definition") if isinstance(device.get("definition"), dict) else {}
    exposes = (definition.get("exposes") or []) if isinstance(definition, dict) else []
    props: list[str] = []

    def _walk(entry: Any) -> None:
        if not isinstance(entry, dict):
            return
        prop = str(entry.get("property") or "").strip()
        if prop and prop != "action":
            access = int(entry.get("access") or 0)
            # Bit 1 = published in state; bit 3 = explicitly gettable.
            if (access & 1) or (access & 4):
                if prop not in props:
                    props.append(prop)
        features = entry.get("features")
        if isinstance(features, list):
            for feat in features:
                _walk(feat)

    for entry in exposes if isinstance(exposes, list) else []:
        _walk(entry)
    if not props:
        return {"state": ""}
    return {prop: "" for prop in props}


def _apply_value_template(template: str, raw: Any) -> Any:
    """Best-effort minimal Jinja resolver for the most common Z2M templates."""
    if raw is None:
        return None
    if not template:
        return raw
    if isinstance(raw, str):
        raw = _decode_z2m_payload(raw)
    if _VT_ACTION_COMPARE.search(template):
        m = _VT_ACTION_COMPARE.search(template)
        expected = m.group(1) if m else ""
        if isinstance(raw, dict):
            actual = str(raw.get("action") or "").strip()
            return actual == expected
        return False
    m = _VT_VALUE_JSON.search(template)
    if m and isinstance(raw, dict):
        return raw.get(m.group(1))
    if _VT_VALUE.search(template):
        return raw
    return raw


def _normalize_state(value: Any, domain: str, caps: dict[str, Any]) -> str:
    if value is None:
        return "unknown"
    if isinstance(value, (dict, list)):
        return "unknown"
    if isinstance(value, bool):
        return "on" if value else "off"
    text_val = str(value).strip()
    if not text_val:
        return "unknown"
    if domain in {"switch", "light", "fan", "binary_sensor", "lock"}:
        on_marker = str(caps.get("state_on") or caps.get("payload_on") or "ON").lower()
        off_marker = str(caps.get("state_off") or caps.get("payload_off") or "OFF").lower()
        low = text_val.lower()
        if low == on_marker:
            return "on"
        if low == off_marker:
            return "off"
        if low in {"on", "true", "open", "unlocked", "1"}:
            return "on"
        if low in {"off", "false", "closed", "locked", "0"}:
            return "off"
    return text_val


# ── Z2M device meta ────────────────────────────────────────────────────────


def _build_device_meta(z2m_devices: list[Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for d in z2m_devices or []:
        if not isinstance(d, dict):
            continue
        if d.get("type") == "Coordinator":
            continue
        ieee = (d.get("ieee_address") or "").strip()
        friendly = (d.get("friendly_name") or "").strip()
        definition = d.get("definition") or {}
        meta = {
            "ieee_address": ieee,
            "friendly_name": friendly,
            "model": (definition.get("model") if isinstance(definition, dict) else "") or "",
            "manufacturer": (definition.get("vendor") if isinstance(definition, dict) else "") or "",
            "description": (definition.get("description") if isinstance(definition, dict) else "") or "",
        }
        if ieee:
            out[ieee] = meta
            # Z2M discovery uses identifiers like "zigbee2mqtt_<ieee>" but we
            # normalise to the bare IEEE so the meta lookup matches the
            # already-stripped device_id from `_entity_from_discovery`.
            out[ieee] = meta
        if friendly:
            out[friendly] = meta
    return out


def _merge_payload(stored: Any, live: Any) -> dict[str, Any]:
    """Merge a durable payload with a live bridge snapshot.

    A bridge can be connected but still warming up; keep stored data whenever
    the live section is empty, otherwise prefer live values.

    State messages are an exception: Z2M does NOT retain state messages on
    the broker, so the live bridge is the only source of truth. If we kept
    a stored ``states`` dict around it would surface yesterday's values
    after every server restart (until a state-change event happens to fire),
    which looks like a stale dashboard. Better to show ``unknown`` until the
    bridge actually receives a fresh message.
    """
    base = stored if isinstance(stored, dict) else {}
    live_payload = live if isinstance(live, dict) else {}
    merged = dict(base)
    # Discovery is retained on the broker → keep stored when live is empty.
    live_disc = live_payload.get("discovery")
    if isinstance(live_disc, dict) and live_disc:
        merged["discovery"] = live_disc
    elif "discovery" not in merged:
        merged["discovery"] = {}
    # States are NOT retained on the broker. Prefer live bridge values per topic,
    # but keep the last persisted snapshot for topics the bridge has not heard
    # yet (e.g. right after restart, before /get responses for sleepy remotes).
    stored_states = base.get("states") if isinstance(base.get("states"), dict) else {}
    live_states = live_payload.get("states") if isinstance(live_payload.get("states"), dict) else {}
    merged_states = {
        k: v
        for k, v in stored_states.items()
        if not _is_z2m_non_state_topic(k)
    }
    for topic, value in live_states.items():
        if _is_z2m_non_state_topic(topic):
            continue
        merged_states[topic] = value
    merged["states"] = merged_states
    live_devices = live_payload.get("z2m_devices")
    if isinstance(live_devices, list) and live_devices:
        merged["z2m_devices"] = live_devices
    elif "z2m_devices" not in merged:
        merged["z2m_devices"] = []
    if live_payload.get("broker"):
        merged["broker"] = live_payload.get("broker")
    live_bridge = live_payload.get("z2m_bridge")
    if isinstance(live_bridge, dict) and live_bridge:
        merged["z2m_bridge"] = {
            "info": dict(live_bridge.get("info") or {}),
            "state": dict(live_bridge.get("state") or {}),
        }
    elif "z2m_bridge" not in merged:
        merged["z2m_bridge"] = {"info": {}, "state": {}}
    return merged


# ── Command builder ────────────────────────────────────────────────────────


def _z2m_control_caps(
    friendly: str,
    prop: str,
    expose: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """MQTT command metadata for native Zigbee2MQTT exposes."""
    caps: dict[str, Any] = {
        "command_topic": f"zigbee2mqtt/{friendly}/set",
        "state_topic": f"zigbee2mqtt/{friendly}",
        "z2m_property": prop,
        "payload_on": "ON",
        "payload_off": "OFF",
    }
    if isinstance(expose, dict):
        if expose.get("value_on") is not None:
            caps["payload_on"] = expose["value_on"]
        if expose.get("value_off") is not None:
            caps["payload_off"] = expose["value_off"]
    return caps


def _resolve_control_caps(record: dict[str, Any]) -> dict[str, Any]:
    """Merge legacy attribute fields into the capabilities dict used for control."""
    attrs = record.get("attributes") or {}
    caps = dict(attrs.get("capabilities") or {})
    if not caps.get("command_topic"):
        cmd = attrs.get("command_topic") or ""
        if cmd:
            caps["command_topic"] = cmd
    if not caps.get("state_topic"):
        st = attrs.get("state_topic") or ""
        if st:
            caps["state_topic"] = st
    if not caps.get("z2m_property"):
        zp = attrs.get("z2m_property") or ""
        if zp:
            caps["z2m_property"] = zp
    if not caps.get("z2m_property"):
        caps["z2m_property"] = _extract_z2m_property_from_template(
            str(caps.get("value_template") or "")
        )
    if not caps.get("options") and isinstance(caps.get("values"), list):
        caps["options"] = caps["values"]
    return caps


def _select_options(raw: Any) -> list[Any]:
    """Normalize Z2M/HA select option lists for the UI."""
    if not isinstance(raw, list) or not raw:
        return []
    return raw


def _z2m_set_payload(prop: str, value: Any) -> str:
    return json.dumps({prop: value}, ensure_ascii=False)


_ENDPOINT_SET_TOPIC = re.compile(r"/l\d+/set$", re.I)


def _command_prefers_plain_payload(command_topic: str) -> bool:
    """HA MQTT discovery uses per-endpoint topics (…/l3/set) with plain ON/OFF."""
    return bool(_ENDPOINT_SET_TOPIC.search(str(command_topic or "")))


def _native_z2m_set_topic(command_topic: str) -> str:
    """Map HA discovery ``…/l3/set`` → native Zigbee2MQTT ``…/set``."""
    cmd = str(command_topic or "").strip()
    if _command_prefers_plain_payload(cmd):
        return _ENDPOINT_SET_TOPIC.sub("/set", cmd)
    return cmd


_IEEE_TOPIC_RE = re.compile(r"^0x[0-9a-fA-F]{16}$")


_Z2M_CMD_TOPIC_RE = re.compile(r"^zigbee2mqtt/([^/]+)(/.*)?$", re.I)


def _z2m_topic_device_segment(ieee: str, *, entry_key: str = "") -> str:
    """Return the MQTT path segment Z2M is actually listening on.

    Uses the live ``bridge/devices`` friendly_name when available. Hyve's
    registry ``device_name`` is intentionally ignored here — it can differ
    from what Z2M still has configured after a partial rename, and publishing
    to the wrong segment is a silent no-op.
    """
    from integrations.device_aliases import canonical_device_id

    key = canonical_device_id(ieee)
    if not key:
        return ""
    bridge = _bridge_mod.get_bridge(entry_key or None)
    if bridge is not None:
        for raw in bridge._z2m_devices or []:
            if not isinstance(raw, dict):
                continue
            if canonical_device_id(raw.get("ieee_address")) != key:
                continue
            friendly = str(raw.get("friendly_name") or "").strip()
            if friendly and not _IEEE_TOPIC_RE.match(friendly):
                return friendly
            break
    return key


def _rewrite_z2m_command_topic(
    topic: str,
    record: dict[str, Any],
    *,
    entry_key: str = "",
) -> str:
    """Align ``zigbee2mqtt/<device>/…`` with the live Z2M friendly_name (or IEEE)."""
    cmd = str(topic or "").strip()
    if not cmd.lower().startswith("zigbee2mqtt/"):
        return cmd
    if "/bridge/" in cmd.lower():
        return cmd
    attrs = record.get("attributes") if isinstance(record.get("attributes"), dict) else {}
    ieee = str(attrs.get("zigbee_ieee") or attrs.get("device_id") or "").strip()
    live = _z2m_topic_device_segment(
        ieee,
        entry_key=entry_key or str(record.get("entry_id") or ""),
    )
    if not live:
        return cmd
    match = _Z2M_CMD_TOPIC_RE.match(cmd)
    if not match:
        return cmd
    current = match.group(1)
    tail = match.group(2) or ""
    if current.lower() == live.lower():
        return cmd
    return f"zigbee2mqtt/{live}{tail}"


def _build_command(
    domain: str,
    verb: str,
    caps: dict[str, Any],
    data: dict[str, Any] | None,
) -> tuple[str, str]:
    """Decide ``(topic, payload_string)`` for a control action."""
    cmd = caps.get("command_topic") or ""
    if not cmd:
        return "", ""

    bridge_req = str(caps.get("z2m_bridge_request") or "").strip()
    if bridge_req == "permit_join":
        if verb in {"turn_on", "on"}:
            secs = int(caps.get("permit_join_seconds") or 254)
            return cmd, json.dumps({"time": secs}, ensure_ascii=False)
        if verb in {"turn_off", "off"}:
            return cmd, json.dumps({"time": 0}, ensure_ascii=False)

    payload_on = caps.get("payload_on") if caps.get("payload_on") is not None else "ON"
    payload_off = caps.get("payload_off") if caps.get("payload_off") is not None else "OFF"
    value_template = str(caps.get("value_template") or "")
    z2m_prop = str(caps.get("z2m_property") or "").strip()
    if not z2m_prop:
        z2m_prop = _extract_z2m_property_from_template(value_template)
    # HA multi-gang discovery publishes …/lN/set; Z2M native API is …/set + JSON.
    if z2m_prop and _command_prefers_plain_payload(cmd):
        cmd = _native_z2m_set_topic(cmd)

    if z2m_prop:
        if verb in {"turn_on", "on"}:
            return cmd, _z2m_set_payload(z2m_prop, payload_on)
        if verb in {"turn_off", "off"}:
            return cmd, _z2m_set_payload(z2m_prop, payload_off)
        if verb in {"toggle"}:
            return cmd, _z2m_set_payload(z2m_prop, "TOGGLE")
        if verb in {"set", "publish"} and isinstance(data, dict):
            if "value" in data:
                return cmd, _z2m_set_payload(z2m_prop, data["value"])
            if len(data) == 1 and z2m_prop in data:
                return cmd, _z2m_set_payload(z2m_prop, data[z2m_prop])
            return cmd, json.dumps(data, ensure_ascii=False)

    if verb in {"turn_on", "on"}:
        return cmd, str(payload_on)
    if verb in {"turn_off", "off"}:
        return cmd, str(payload_off)
    if verb in {"toggle"}:
        # MQTT discovery doesn't standardize TOGGLE; Z2M understands the
        # literal string "TOGGLE" on switch endpoints.
        return cmd, "TOGGLE"

    if verb in {"set", "publish"} and isinstance(data, dict):
        if "value" in data:
            value = data["value"]
            if domain == "light" and isinstance(value, (int, float)) and caps.get("brightness_command_topic"):
                return caps["brightness_command_topic"], str(int(value))
            return cmd, str(value)
        if "brightness" in data and caps.get("brightness_command_topic"):
            return caps["brightness_command_topic"], str(int(data["brightness"]))
        return cmd, json.dumps(data, ensure_ascii=False)

    return "", ""


# ── Helpers ────────────────────────────────────────────────────────────────


def _find_entity_record(items: list[dict[str, Any]], entity_id: str) -> dict[str, Any] | None:
    from integrations.entity_utils import entity_id_lookup_variants

    for variant in entity_id_lookup_variants(entity_id):
        for item in items:
            if item.get("entity_id") == variant or item.get("unique_id") == variant:
                return item
    return None


# ── Z2M Native Expose Parser ───────────────────────────────────────────────
#
# Converts ``definition.exposes`` from ``zigbee2mqtt/bridge/devices`` into
# proper Hyve entities.  Used both as enrichment (fills gaps HA discovery
# missed) and as a complete fallback when HA discovery is disabled.
#
# Z2M expose format:
#   Simple:    {"type":"numeric","property":"battery","unit":"%","access":1}
#   Composite: {"type":"light","features":[{"property":"state",...},…]}
#   access bitmask: 1=read 2=write 4=get

_PROPERTY_DEVICE_CLASS: dict[str, tuple[str, str]] = {
    "battery":          ("battery",             "%"),
    "linkquality":      ("signal_strength",     "lqi"),
    "temperature":      ("temperature",         "°C"),
    "humidity":         ("humidity",            "%"),
    "pressure":         ("pressure",            "hPa"),
    "illuminance":      ("illuminance",         "lx"),
    "illuminance_lux":  ("illuminance",         "lx"),
    "co2":              ("carbon_dioxide",      "ppm"),
    "voc":              ("volatile_organic_compounds", "ppb"),
    "pm25":             ("pm25",                "µg/m³"),
    "energy":           ("energy",              "kWh"),
    "power":            ("power",               "W"),
    "voltage":          ("voltage",             "V"),
    "current":          ("current",             "A"),
    "soil_moisture":    ("moisture",            "%"),
}

_COMPOSITE_DOMAIN: dict[str, str] = {
    "light":   "light",
    "switch":  "switch",
    "cover":   "cover",
    "lock":    "lock",
    "fan":     "fan",
    "climate": "climate",
}


def _z2m_expose_to_domain(
    expose: dict[str, Any],
) -> tuple[str, str, str, bool]:
    """Map a single Z2M expose to (domain, device_class, unit, controllable).

    Returns ``("", "", "", False)`` for exposes that should be skipped
    (e.g. composite parents handled via their features).
    """
    etype = str(expose.get("type") or "").lower()
    prop = str(expose.get("property") or "").lower()
    access = expose.get("access") or 0
    writable = bool(access & 2)
    unit = str(expose.get("unit") or "")

    # Composite types (light, switch, cover, etc.) → handled at walk level
    if etype in _COMPOSITE_DOMAIN:
        return _COMPOSITE_DOMAIN[etype], "", "", writable

    # Button-like (identify) — always a button regardless of access flags
    if prop == "identify":
        return "button", "", "", True

    # Binary
    if etype == "binary":
        if writable:
            return "switch", "", "", True
        return "binary_sensor", "", "", False

    # Numeric
    if etype == "numeric":
        dc, default_unit = _PROPERTY_DEVICE_CLASS.get(prop, ("", ""))
        if not unit and default_unit:
            unit = default_unit
        if writable and not dc:
            return "number", dc, unit, True
        return "sensor", dc, unit, False

    # Enum
    if etype == "enum":
        if prop == "action":
            return "event", "", "", False
        if writable:
            return "select", "", "", True
        return "sensor", "", "", False

    return "", "", "", False


def _entities_from_z2m_exposes(
    device: dict[str, Any],
    states: dict[str, Any],
    device_meta: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Walk a Z2M device's ``definition.exposes`` and produce Hyve entities."""
    ieee = (device.get("ieee_address") or "").strip()
    z2m_friendly = (device.get("friendly_name") or "").strip()
    friendly = _resolve_z2m_display_name(device)
    if not friendly and not z2m_friendly:
        return []
    mqtt_friendly = z2m_friendly or friendly
    definition = device.get("definition") if isinstance(device.get("definition"), dict) else {}
    exposes = (definition.get("exposes") or []) if isinstance(definition, dict) else []
    if not isinstance(exposes, list):
        return []

    meta = device_meta or _build_device_meta([device])
    state_payload = _live_z2m_payload(
        states,
        ieee or friendly,
        meta,
        f"zigbee2mqtt/{mqtt_friendly}",
        extra_names=[friendly, mqtt_friendly, ieee],
    )

    model = (definition.get("model") if isinstance(definition, dict) else "") or ""
    vendor = (definition.get("vendor") if isinstance(definition, dict) else "") or ""

    out: list[dict[str, Any]] = []
    seen_props: set[str] = set()

    def _make_entity(
        prop: str,
        domain: str,
        device_class: str,
        unit: str,
        controllable: bool,
        capabilities: dict[str, Any] | None = None,
        name_suffix: str = "",
    ) -> dict[str, Any] | None:
        if not prop or prop in seen_props:
            return None
        seen_props.add(prop)

        display = name_suffix or prop.replace("_", " ").title()
        if domain == "button":
            state_str = "idle"
        else:
            raw_val = state_payload.get(prop)
            if raw_val is None:
                state_str = "unknown"
            elif isinstance(raw_val, bool):
                state_str = "on" if raw_val else "off"
            else:
                text = str(raw_val).strip()
                state_str = text if text else "unknown"

        caps: dict[str, Any] = dict(capabilities or {})
        if device_class:
            caps["device_class"] = device_class

        eid = f"{domain}.{slugify(friendly)}_{slugify(prop)}"
        uid = f"z2m:{slugify(friendly)}:{slugify(prop)}"

        return {
            "entity_id": eid,
            "unique_id": uid,
            "name": f"{friendly} {display}",
            "state": state_str,
            "domain": domain,
            "source": "mosquitto",
            "aliases": [],
            "unit": unit,
            "controllable": controllable,
            "attributes": {
                "via": "zigbee2mqtt",
                "device_id": ieee or friendly,
                "zigbee_ieee": ieee,
                "device_name": friendly,
                "device_model": model,
                "device_manufacturer": vendor,
                "z2m_property": prop,
                "capabilities": caps,
            },
        }

    def _walk(entry: Any) -> None:
        if not isinstance(entry, dict):
            return

        etype = str(entry.get("type") or "").lower()

        # Composite (light, switch, cover, etc.) — create one entity for the
        # composite and extract capabilities from its features.
        if etype in _COMPOSITE_DOMAIN:
            domain = _COMPOSITE_DOMAIN[etype]
            features = entry.get("features") or []
            caps: dict[str, Any] = {}
            primary_prop = ""
            for feat in features if isinstance(features, list) else []:
                fp = str(feat.get("property") or "")
                if not fp:
                    continue
                if fp in ("state", f"state_{entry.get('endpoint', '')}") and not primary_prop:
                    primary_prop = fp
                if feat.get("type") == "numeric":
                    vmin = feat.get("value_min")
                    vmax = feat.get("value_max")
                    if vmin is not None or vmax is not None:
                        caps[f"{fp}_range"] = [vmin, vmax]
                if fp == "color_temp":
                    caps["color_temp"] = True
                if fp in ("color_xy", "color_hs"):
                    caps["color"] = True
                if feat.get("values"):
                    caps[f"{fp}_values"] = feat["values"]

            if primary_prop:
                writable = bool((entry.get("access") or 0) & 2) or any(
                    bool((f.get("access") or 0) & 2) for f in (features if isinstance(features, list) else [])
                )
                ent = _make_entity(primary_prop, domain, "", "", writable, caps)
                if ent:
                    state_topic = f"zigbee2mqtt/{mqtt_friendly}"
                    if writable:
                        z2m_caps = _z2m_control_caps(mqtt_friendly, primary_prop, entry)
                        ent["attributes"]["capabilities"].update(z2m_caps)
                    ent["attributes"]["state_topic"] = state_topic
                    ent["attributes"]["capabilities"]["state_topic"] = state_topic
                    ent["attributes"]["capabilities"]["z2m_property"] = primary_prop
                    ent["attributes"]["command_topic"] = f"zigbee2mqtt/{mqtt_friendly}/set"
                    ent["attributes"]["z2m_property"] = primary_prop
                    out.append(ent)
            return

        # Simple expose
        prop = str(entry.get("property") or "")
        if not prop:
            return
        domain, dc, unit, controllable = _z2m_expose_to_domain(entry)
        if not domain:
            return

        ent = _make_entity(prop, domain, dc, unit, controllable)
        if ent:
            state_topic = f"zigbee2mqtt/{mqtt_friendly}"
            ent["attributes"]["state_topic"] = state_topic
            ent["attributes"]["capabilities"]["state_topic"] = state_topic
            ent["attributes"]["capabilities"]["z2m_property"] = prop
            if controllable:
                z2m_caps = _z2m_control_caps(mqtt_friendly, prop, entry)
                ent["attributes"]["capabilities"].update(z2m_caps)
                ent["attributes"]["command_topic"] = z2m_caps["command_topic"]
                ent["attributes"]["z2m_property"] = prop
            if entry.get("values"):
                vals = _select_options(entry["values"])
                ent["attributes"]["capabilities"]["values"] = vals
                if domain == "select":
                    ent["attributes"]["capabilities"]["options"] = vals
            vmin = entry.get("value_min")
            vmax = entry.get("value_max")
            if vmin is not None or vmax is not None:
                ent["attributes"]["capabilities"]["range"] = [vmin, vmax]
            out.append(ent)

    for entry in exposes:
        _walk(entry)

    return out


def _count_z2m_user_devices(z2m_devices: list[Any]) -> int:
    count = 0
    for raw in z2m_devices or []:
        if not isinstance(raw, dict):
            continue
        if raw.get("type") == "Coordinator":
            continue
        if raw.get("disabled"):
            continue
        if not str(raw.get("friendly_name") or "").strip():
            continue
        count += 1
    return count


def _z2m_bridge_context(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[Any]]:
    bridge = payload.get("z2m_bridge") if isinstance(payload.get("z2m_bridge"), dict) else {}
    info = dict(bridge.get("info") or {})
    state = dict(bridge.get("state") or {})
    states = payload.get("states") if isinstance(payload.get("states"), dict) else {}
    if not info:
        raw_info = states.get(_Z2M_BRIDGE_INFO)
        if isinstance(raw_info, dict):
            info = raw_info
    if not state:
        raw_state = states.get(_Z2M_BRIDGE_STATE)
        if isinstance(raw_state, dict):
            state = raw_state
    z2m_devices = payload.get("z2m_devices") if isinstance(payload.get("z2m_devices"), list) else []
    return info, state, z2m_devices


def _z2m_bridge_present(payload: dict[str, Any]) -> bool:
    info, state, z2m_devices = _z2m_bridge_context(payload)
    if z2m_devices:
        return True
    if info:
        return True
    if state:
        return True
    states = payload.get("states") if isinstance(payload.get("states"), dict) else {}
    return _Z2M_BRIDGE_INFO in states or _Z2M_BRIDGE_STATE in states


def _bridge_state_value(
    info: dict[str, Any],
    state: dict[str, Any],
    states: dict[str, Any],
    prop: str,
    *,
    default: str = "unknown",
) -> str:
    flat = states.get(_Z2M_BRIDGE_INFO)
    if isinstance(flat, dict) and flat.get(prop) is not None:
        raw = flat.get(prop)
    elif info.get(prop) is not None:
        raw = info.get(prop)
    else:
        raw = None
    if prop == "connection":
        flat_state = states.get(_Z2M_BRIDGE_STATE)
        if isinstance(flat_state, dict) and flat_state.get("connection") is not None:
            raw = flat_state.get("connection")
        elif isinstance(state, dict) and state.get("state"):
            raw_state = str(state.get("state") or "").strip().lower()
            if raw_state == "online":
                raw = "on"
            elif raw_state == "offline":
                raw = "off"
    if raw is None:
        return default
    if isinstance(raw, bool):
        return "on" if raw else "off"
    text = str(raw).strip()
    return text if text else default


def _make_z2m_bridge_entity(
    *,
    entity_id: str,
    unique_id: str,
    name: str,
    domain: str,
    state: str,
    controllable: bool = False,
    unit: str = "",
    capabilities: dict[str, Any] | None = None,
    z2m_property: str = "",
    state_topic: str = "",
    command_topic: str = "",
) -> dict[str, Any]:
    caps = dict(capabilities or {})
    if state_topic:
        caps["state_topic"] = state_topic
    if z2m_property:
        caps["z2m_property"] = z2m_property
    attrs: dict[str, Any] = {
        "via": "zigbee2mqtt",
        "device_id": _Z2M_BRIDGE_DEVICE_ID,
        "device_name": _Z2M_BRIDGE_DEVICE_NAME,
        "device_model": "Bridge",
        "device_manufacturer": "Zigbee2MQTT",
        "z2m_bridge": True,
        "capabilities": caps,
    }
    if z2m_property:
        attrs["z2m_property"] = z2m_property
    if state_topic:
        attrs["state_topic"] = state_topic
    if command_topic:
        attrs["command_topic"] = command_topic
    return {
        "entity_id": entity_id,
        "unique_id": unique_id,
        "name": name,
        "state": state,
        "domain": domain,
        "source": "mosquitto",
        "aliases": [],
        "unit": unit,
        "controllable": controllable,
        "attributes": attrs,
    }


def _entities_from_z2m_bridge(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Synthetic Hyve device for the Zigbee2MQTT bridge itself."""
    if not isinstance(payload, dict) or not _z2m_bridge_present(payload):
        return []

    info, state, z2m_devices = _z2m_bridge_context(payload)
    states = payload.get("states") if isinstance(payload.get("states"), dict) else {}
    device_count = _count_z2m_user_devices(z2m_devices)
    version = _bridge_state_value(info, state, states, "version")
    coordinator = _bridge_state_value(info, state, states, "coordinator_type")
    if coordinator == "unknown" and isinstance(info.get("coordinator"), dict):
        coordinator = str(info["coordinator"].get("type") or "unknown")
    connection = _bridge_state_value(info, state, states, "connection")
    permit_join = _bridge_state_value(info, state, states, "permit_join")

    out: list[dict[str, Any]] = [
        _make_z2m_bridge_entity(
            entity_id="sensor.z2m_bridge_device_count",
            unique_id="z2m_bridge:device_count",
            name=f"{_Z2M_BRIDGE_DEVICE_NAME} Device Count",
            domain="sensor",
            state=str(device_count),
            unit="devices",
        ),
        _make_z2m_bridge_entity(
            entity_id="binary_sensor.z2m_bridge_online",
            unique_id="z2m_bridge:online",
            name=f"{_Z2M_BRIDGE_DEVICE_NAME} Online",
            domain="binary_sensor",
            state=connection,
            state_topic=_Z2M_BRIDGE_STATE,
            z2m_property="connection",
        ),
        _make_z2m_bridge_entity(
            entity_id="sensor.z2m_bridge_version",
            unique_id="z2m_bridge:version",
            name=f"{_Z2M_BRIDGE_DEVICE_NAME} Version",
            domain="sensor",
            state=version,
            state_topic=_Z2M_BRIDGE_INFO,
            z2m_property="version",
        ),
        _make_z2m_bridge_entity(
            entity_id="sensor.z2m_bridge_coordinator",
            unique_id="z2m_bridge:coordinator",
            name=f"{_Z2M_BRIDGE_DEVICE_NAME} Coordinator",
            domain="sensor",
            state=coordinator,
            state_topic=_Z2M_BRIDGE_INFO,
            z2m_property="coordinator_type",
        ),
        _make_z2m_bridge_entity(
            entity_id="switch.z2m_bridge_permit_join",
            unique_id="z2m_bridge:permit_join",
            name=f"{_Z2M_BRIDGE_DEVICE_NAME} Permit Join",
            domain="switch",
            state=permit_join,
            controllable=True,
            state_topic=_Z2M_BRIDGE_INFO,
            z2m_property="permit_join",
            command_topic="zigbee2mqtt/bridge/request/permit_join",
            capabilities={
                "command_topic": "zigbee2mqtt/bridge/request/permit_join",
                "state_topic": _Z2M_BRIDGE_INFO,
                "z2m_property": "permit_join",
                "z2m_bridge_request": "permit_join",
                "permit_join_seconds": 254,
            },
        ),
    ]
    return out


def _entities_from_all_z2m_devices(
    z2m_devices: list[Any],
    states: dict[str, Any],
    seen: set[str],
    expose_covered: dict[str, set[str]] | None = None,
) -> list[dict[str, Any]]:
    """Create entities for all Z2M devices via native expose parsing.

    ``expose_covered`` maps device_id → property names handled here so stale
    HA discovery rows for the same capability are skipped afterwards.
    """
    covered = expose_covered if expose_covered is not None else {}
    device_meta = _build_device_meta(z2m_devices)
    out: list[dict[str, Any]] = []
    for d in z2m_devices:
        if not isinstance(d, dict) or d.get("type") == "Coordinator":
            continue
        if d.get("disabled"):
            continue
        friendly = (d.get("friendly_name") or "").strip()
        if not friendly:
            continue
        ieee = (d.get("ieee_address") or "").strip()
        dev_id = ieee or friendly
        for ent in _entities_from_z2m_exposes(d, states, device_meta):
            eid = ent["entity_id"]
            uid = ent.get("unique_id", "")
            if eid in seen or uid in seen:
                continue
            z2m_prop = (ent.get("attributes") or {}).get("z2m_property", "")
            if z2m_prop:
                covered.setdefault(dev_id, set()).add(z2m_prop)
            seen.add(eid)
            if uid:
                seen.add(uid)
            out.append(ent)
    return out


# ── Connection helpers (used when bridge isn't running) ────────────────────


async def _drain_broker(cfg: dict[str, Any]) -> dict[str, Any]:
    import aiomqtt

    host = (cfg.get("host") or "localhost").strip()
    port = int(cfg.get("port") or 1883)
    username = (cfg.get("username") or "").strip() or None
    password = cfg.get("password") or None
    wait_seconds = float(cfg.get("discovery_wait_seconds") or _DEFAULT_DISCOVERY_WAIT)
    state_wait_seconds = float(cfg.get("state_wait_seconds") or max(2.0, wait_seconds))

    discovery: dict[str, dict[str, Any]] = {}
    states: dict[str, Any] = {}
    z2m_devices: list[Any] = []
    z2m_bridge_info: dict[str, Any] = {}
    z2m_bridge_state: dict[str, Any] = {}

    try:
        async with aiomqtt.Client(
            hostname=host,
            port=port,
            username=username,
            password=password,
            identifier=f"hyve-discovery-{int(asyncio.get_event_loop().time() * 1000)}",
            keepalive=30,
        ) as client:
            await client.subscribe(_HA_DISCOVERY_2)
            await client.subscribe(_HA_DISCOVERY_3)
            await client.subscribe(_Z2M_BRIDGE_DEVICES)
            await client.subscribe("zigbee2mqtt/#")

            async def _drain():
                async for msg in client.messages:
                    topic = str(msg.topic)
                    raw = msg.payload.decode("utf-8", errors="replace")
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = raw
                    if topic == _Z2M_BRIDGE_DEVICES and isinstance(data, list):
                        z2m_devices.clear()
                        z2m_devices.extend(data)
                    elif topic == _Z2M_BRIDGE_INFO and isinstance(data, dict):
                        z2m_bridge_info.clear()
                        z2m_bridge_info.update(data)
                        states[topic] = data
                    elif topic == _Z2M_BRIDGE_STATE and isinstance(data, dict):
                        z2m_bridge_state.clear()
                        z2m_bridge_state.update(data)
                        states[topic] = data
                    elif topic.endswith("/config") and topic.startswith("homeassistant/") and isinstance(data, dict):
                        discovery[topic] = data
                    elif not str(topic).startswith("zigbee2mqtt/bridge/"):
                        states[topic] = data

            # Phase 1: collect retained discovery + z2m devices snapshot.
            try:
                await asyncio.wait_for(_drain(), timeout=wait_seconds)
            except asyncio.TimeoutError:
                pass

            # Phase 2: Z2M does NOT retain device state messages, so the
            # initial drain only sees retained discovery (and state from
            # devices that happened to publish during the wait window).
            # Ask Z2M to republish current state for each known device by
            # sending ``zigbee2mqtt/<friendly>/get`` with ``{"state": ""}``,
            # then keep draining for a short window to collect the replies.
            for d in z2m_devices:
                if not isinstance(d, dict):
                    continue
                if d.get("type") == "Coordinator" or d.get("disabled"):
                    continue
                friendly = (d.get("friendly_name") or "").strip()
                if not friendly:
                    continue
                try:
                    await client.publish(
                        f"zigbee2mqtt/{friendly}/get",
                        json.dumps(z2m_get_payload_for_device(d), ensure_ascii=False),
                        qos=0,
                        retain=False,
                    )
                except Exception:
                    pass

            try:
                await asyncio.wait_for(_drain(), timeout=state_wait_seconds)
            except asyncio.TimeoutError:
                pass
    except Exception as exc:
        raise RuntimeError(f"Eroare conectare MQTT {host}:{port} — {exc}") from exc

    return {
        "broker": {"host": host, "port": port},
        "discovery": discovery,
        "states": states,
        "z2m_devices": z2m_devices,
        "z2m_bridge": {
            "info": dict(z2m_bridge_info),
            "state": dict(z2m_bridge_state),
        },
    }


async def _publish(
    cfg: dict[str, Any],
    topic: str,
    payload: str,
    *,
    entry_key: str = "",
) -> None:
    import aiomqtt

    # bridge module loaded as _bridge_mod above

    bridge = _bridge_mod.get_bridge(entry_key or None)
    if bridge is not None and bridge.is_running():
        await bridge.publish(topic, payload)
        return

    host = (cfg.get("host") or "localhost").strip()
    port = int(cfg.get("port") or 1883)
    username = (cfg.get("username") or "").strip() or None
    password = cfg.get("password") or None
    try:
        async with aiomqtt.Client(
            hostname=host,
            port=port,
            username=username,
            password=password,
            identifier=f"hyve-control-{int(asyncio.get_event_loop().time() * 1000)}",
            keepalive=15,
        ) as client:
            await client.publish(topic, payload, qos=0, retain=False)
    except Exception as exc:
        raise RuntimeError(f"Eroare publicare MQTT pe {topic}: {exc}") from exc


def extract_z2m_candidates(payload: Any) -> list[dict[str, Any]]:
    """Legacy Z2M bridge/devices payload → flat entity list (dashboard widgets)."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _append(name: str, state: Any, entity_id: str | None = None) -> None:
        label = (name or entity_id or "").strip()
        if not label:
            return
        eid = entity_id or f"sensor.{slugify(label)}"
        if eid in seen:
            return
        seen.add(eid)
        items.append({
            "entity_id": eid,
            "name": label,
            "state": str(state if state is not None else "unknown"),
            "domain": entity_domain(eid),
            "source": "zigbee2mqtt",
            "aliases": [],
            "unit": "",
            "controllable": is_state_controllable(state, eid),
        })

    if isinstance(payload, list):
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("friendly_name") or entry.get("name") or entry.get("ieee_address") or "").strip()
            state = entry.get("state")
            if state is None:
                state = entry.get("last_seen") or "unknown"
            _append(name, state)
        return _finalize(items, default_source="zigbee2mqtt")

    if not isinstance(payload, dict):
        return items

    devices = payload.get("devices")
    if isinstance(devices, list):
        for device in devices:
            if not isinstance(device, dict):
                continue
            ieee = str(device.get("ieee_address") or device.get("friendly_name") or "").strip()
            name = str(device.get("friendly_name") or ieee or "device").strip()
            for definition in device.get("definitions") or []:
                if not isinstance(definition, dict):
                    continue
                prop = str(definition.get("property") or definition.get("name") or "state").strip()
                label = f"{name} {prop}".strip()
                _append(label, definition.get("value"), f"sensor.{slugify(label)}")
            for expose in device.get("exposes") or []:
                if not isinstance(expose, dict):
                    continue
                prop = str(expose.get("name") or expose.get("property") or "state").strip()
                label = f"{name} {prop}".strip()
                _append(label, expose.get("value"), f"sensor.{slugify(label)}")

    for key, value in payload.items():
        if key in {"devices", "bridge"}:
            continue
        if isinstance(value, (str, int, float, bool)):
            _append(str(key), value, f"sensor.{slugify(str(key))}")

    return _finalize(items, default_source="zigbee2mqtt")


def extract_z2m_widget_candidates(payload: Any) -> list[dict[str, Any]]:
    """Recursive Z2M JSON walk for dashboard entity picker (``z2m:`` entity ids)."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _append(name: str, state: Any, entity_id: str | None = None) -> None:
        label = (name or entity_id or "").strip()
        if not label:
            return
        eid = (entity_id or f"z2m:{slugify(label)}").strip()
        if eid in seen:
            return
        seen.add(eid)
        controllable = is_state_controllable(state, eid)
        items.append({
            "entity_id": eid,
            "name": label,
            "state": str(state or "unknown"),
            "domain": "switch" if controllable else "sensor",
            "source": "zigbee2mqtt",
            "aliases": [],
            "unit": "",
            "controllable": controllable,
        })

    def _walk(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                _walk(child)
            return
        if not isinstance(node, dict):
            return

        possible_name = node.get("friendly_name") or node.get("name") or node.get("device") or node.get("label")
        entity_id = node.get("ha_entity_id") or node.get("entity_id")
        state = node.get("state") or node.get("value")

        if possible_name and state is not None:
            _append(str(possible_name), state, str(entity_id) if entity_id else None)

        for child in node.values():
            if isinstance(child, (dict, list)):
                _walk(child)

    _walk(payload)
    items.sort(key=lambda item: item.get("name") or "")
    return _finalize(items, default_source="zigbee2mqtt")
