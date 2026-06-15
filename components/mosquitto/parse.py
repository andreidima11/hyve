"""Mosquitto extract — MQTT/Z2M parsing helpers."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

log = logging.getLogger("integrations.mosquitto")

_IEEE_TOPIC_RE = re.compile(r"^0x[0-9a-fA-F]{16}$")

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

