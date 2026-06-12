"""Stable Hyve entity identifiers for Mammotion devices."""

from __future__ import annotations

import re
from typing import Any


def slugify_device_name(name: str) -> str:
    text = re.sub(r"[^a-z0-9_]+", "_", str(name or "").strip().lower())
    return re.sub(r"_+", "_", text).strip("_") or "mower"


def unique_id(device_name: str, domain: str, key: str) -> str:
    return f"mammotion:{device_name}:{domain}:{key}"


def device_id(device_name: str) -> str:
    slug = slugify_device_name(device_name)
    return f"mammotion_{slug}" if slug else "mammotion_unknown"


def base_entity(
    *,
    device_name: str,
    obj: str,
    label: str,
    domain: str,
    key: str,
    state: Any,
    controllable: bool,
    online: bool,
    icon: str,
    unit: str = "",
    extra_attrs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    did = device_id(device_name)
    attrs = {"device_id": did, "device_name": device_name, "mammotion_key": key}
    if extra_attrs:
        attrs.update(extra_attrs)
    ent: dict[str, Any] = {
        "entity_id": f"{domain}.{obj}_{key}" if key else f"{domain}.{obj}",
        "unique_id": unique_id(device_name, domain, key) if key else f"mammotion:{device_name}",
        "device_id": did,
        "device_name": label,
        "name": f"{label} {key.replace('_', ' ')}" if key else label,
        "friendly_name": f"{label} {key.replace('_', ' ')}" if key else label,
        "state": state,
        "domain": domain,
        "source": "mammotion",
        "controllable": controllable,
        "available": online,
        "icon": icon,
        "attributes": attrs,
    }
    if unit:
        ent["unit"] = unit
        ent["attributes"]["unit_of_measurement"] = unit
    return ent
