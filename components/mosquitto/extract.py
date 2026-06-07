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

_bridge_mod = import_sibling(Path(__file__).resolve().parent, "bridge")

def extract_mosquitto_candidates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []

    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    discovery = payload.get("discovery") or {}
    states = payload.get("states") or {}
    z2m_devices = payload.get("z2m_devices") or []
    device_meta = _build_device_meta(z2m_devices)

    # Track which Z2M properties per device are already covered by HA
    # discovery so the expose parser doesn't create duplicates.
    # Key: device_id, Value: set of Z2M property names.
    discovery_covered: dict[str, set[str]] = {}

    # --- Primary path: HA discovery -------------------------------------
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
            discovery_covered.setdefault(dev_id, set()).add(prop)

        seen.add(entity["entity_id"])
        if entity.get("unique_id"):
            seen.add(entity["unique_id"])
        items.append(entity)

    # --- Enrich / fallback: native Z2M expose parsing ----------------------
    # Always run to fill gaps HA discovery missed. Properties already
    # covered by a discovery entity for the same device are skipped.
    if z2m_devices:
        items.extend(_entities_from_all_z2m_devices(
            z2m_devices, states, seen, discovery_covered,
        ))

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
    if domain in {"device_automation", "device_trigger"}:
        return None
    object_id = m.group(3)

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
    raw_state = states.get(state_topic) if state_topic else None
    state_value = _apply_value_template(value_template, raw_state)

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
    z2m_prop = _extract_z2m_property_from_template(value_template)
    if z2m_prop and command_topic.endswith("/set"):
        capabilities["z2m_property"] = z2m_prop

    # Optional secondary control surfaces (lights w/ brightness etc.)
    if msg.get("brightness_command_topic"):
        capabilities["brightness_command_topic"] = msg.get("brightness_command_topic")
        capabilities["brightness_state_topic"] = msg.get("brightness_state_topic") or ""
        capabilities["brightness_value_template"] = msg.get("brightness_value_template") or ""
        capabilities["brightness_scale"] = msg.get("brightness_scale") or 255

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


def _apply_value_template(template: str, raw: Any) -> Any:
    """Best-effort minimal Jinja resolver for the most common Z2M templates."""
    if raw is None:
        return None
    if not template:
        return raw
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
    # States are NOT retained → always trust the live bridge snapshot, even
    # if it's empty. Drop any persisted states so we don't surface stale ones.
    live_states = live_payload.get("states")
    merged["states"] = live_states if isinstance(live_states, dict) else {}
    live_devices = live_payload.get("z2m_devices")
    if isinstance(live_devices, list) and live_devices:
        merged["z2m_devices"] = live_devices
    elif "z2m_devices" not in merged:
        merged["z2m_devices"] = []
    if live_payload.get("broker"):
        merged["broker"] = live_payload.get("broker")
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
    return caps


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


def _rewrite_z2m_command_topic(topic: str, record: dict[str, Any]) -> str:
    """Replace IEEE segments in MQTT paths with the live Z2M friendly name."""
    cmd = str(topic or "").strip()
    if not cmd or "zigbee2mqtt/" not in cmd:
        return cmd
    attrs = record.get("attributes") if isinstance(record.get("attributes"), dict) else {}
    ieee = str(attrs.get("zigbee_ieee") or attrs.get("device_id") or "").strip().lower()
    friendly = str(attrs.get("device_name") or "").strip()
    if not ieee or not friendly:
        return cmd
    if friendly.lower().startswith("0x") and all(c in "0123456789abcdef" for c in friendly.lower()[2:]):
        return cmd
    for needle in (ieee, ieee.upper()):
        if needle in cmd:
            return cmd.replace(needle, friendly, 1)
    return cmd


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
        if writable:
            return "select", "", "", True
        return "sensor", "", "", False

    return "", "", "", False


def _entities_from_z2m_exposes(
    device: dict[str, Any],
    states: dict[str, Any],
) -> list[dict[str, Any]]:
    """Walk a Z2M device's ``definition.exposes`` and produce Hyve entities."""
    friendly = (device.get("friendly_name") or "").strip()
    if not friendly:
        return []
    ieee = (device.get("ieee_address") or "").strip()
    definition = device.get("definition") if isinstance(device.get("definition"), dict) else {}
    exposes = (definition.get("exposes") or []) if isinstance(definition, dict) else []
    if not isinstance(exposes, list):
        return []

    state_payload = states.get(f"zigbee2mqtt/{friendly}")
    if isinstance(state_payload, str):
        try:
            state_payload = json.loads(state_payload)
        except (json.JSONDecodeError, TypeError):
            state_payload = {}
    if not isinstance(state_payload, dict):
        state_payload = {}

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
                    if writable:
                        z2m_caps = _z2m_control_caps(friendly, primary_prop, entry)
                        ent["attributes"]["capabilities"].update(z2m_caps)
                    ent["attributes"]["state_topic"] = f"zigbee2mqtt/{friendly}"
                    ent["attributes"]["command_topic"] = f"zigbee2mqtt/{friendly}/set"
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
            ent["attributes"]["state_topic"] = f"zigbee2mqtt/{friendly}"
            if controllable:
                z2m_caps = _z2m_control_caps(friendly, prop, entry)
                ent["attributes"]["capabilities"].update(z2m_caps)
                ent["attributes"]["command_topic"] = z2m_caps["command_topic"]
                ent["attributes"]["z2m_property"] = prop
            if entry.get("values"):
                ent["attributes"]["capabilities"]["values"] = entry["values"]
            vmin = entry.get("value_min")
            vmax = entry.get("value_max")
            if vmin is not None or vmax is not None:
                ent["attributes"]["capabilities"]["range"] = [vmin, vmax]
            out.append(ent)

    for entry in exposes:
        _walk(entry)

    return out


def _entities_from_all_z2m_devices(
    z2m_devices: list[Any],
    states: dict[str, Any],
    seen: set[str],
    discovery_covered: dict[str, set[str]] | None = None,
) -> list[dict[str, Any]]:
    """Create entities for all Z2M devices via native expose parsing.

    ``discovery_covered`` maps device_id → set of Z2M property names already
    handled by HA discovery entities.  Those properties are skipped here.
    """
    covered = discovery_covered or {}
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
        dev_covered = covered.get(dev_id, set())
        for ent in _entities_from_z2m_exposes(d, states):
            eid = ent["entity_id"]
            uid = ent.get("unique_id", "")
            if eid in seen or uid in seen:
                continue
            # Skip if HA discovery already covers this property for this device
            z2m_prop = (ent.get("attributes") or {}).get("z2m_property", "")
            if z2m_prop and z2m_prop in dev_covered:
                continue
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
            await client.subscribe(_Z2M_DEVICE_STATE)

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
                    elif topic.endswith("/config") and topic.startswith("homeassistant/") and isinstance(data, dict):
                        discovery[topic] = data
                    else:
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
                        '{"state": ""}',
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
    }


async def _publish(cfg: dict[str, Any], topic: str, payload: str) -> None:
    import aiomqtt

    # bridge module loaded as _bridge_mod above

    bridge = _bridge_mod.get_bridge()
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
