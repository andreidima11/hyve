"""Entity extraction — shared normalizers plus lazy loaders for components/*/extract.py."""

from __future__ import annotations

from typing import Any

from smart_home_registry import (
    entity_domain,
    is_controllable_domain,
    is_visible_domain,
)

from integrations.component_import import import_sibling
from integrations.component_paths import BUNDLED_COMPONENTS_DIR
from integrations.entity_utils import finalize_entities as _finalize
from integrations.entity_utils import is_state_controllable

_EXTRACT_CACHE: dict[str, Any] = {}

_COMPONENT_EXTRACTORS = {
    "pago": "extract_pago_candidates",
    "eon_romania": "extract_eon_romania_candidates",
    "ariston_net": "extract_ariston_net_candidates",
    "open_meteo": "extract_weather_candidates",
    "midea_ac": "extract_midea_ac_candidates",
    "reteleelectrice": "extract_reteleelectrice_candidates",
    "fusion_solar": "extract_fusion_solar_candidates",
    "mosquitto": "extract_z2m_candidates",
    "reolink": "extract_reolink_candidates",
    "roborock": "extract_roborock_candidates",
    "tapo": "extract_tapo_candidates",
    "xiaomi_home": "extract_xiaomi_home_candidates",
}

_EXPORTABLE_FUNCS: dict[str, tuple[str, str]] = {
    attr: (slug, attr) for slug, attr in _COMPONENT_EXTRACTORS.items()
}
_EXPORTABLE_FUNCS["extract_z2m_widget_candidates"] = ("mosquitto", "extract_z2m_widget_candidates")


def _load_extract_module(slug: str) -> Any:
    key = str(slug or "").strip()
    if key in _EXTRACT_CACHE:
        return _EXTRACT_CACHE[key]
    mod = import_sibling(BUNDLED_COMPONENTS_DIR / key, "extract")
    _EXTRACT_CACHE[key] = mod
    return mod


def get_extractor(slug: str):
    """Return the primary ``extract_*_candidates`` callable for a component slug."""
    attr = _COMPONENT_EXTRACTORS.get(str(slug or "").strip())
    if not attr:
        raise KeyError(slug)
    return getattr(_load_extract_module(slug), attr)


def __getattr__(name: str) -> Any:
    spec = _EXPORTABLE_FUNCS.get(name)
    if spec is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    slug, attr = spec
    return getattr(_load_extract_module(slug), attr)


def infer_source(entity_id: str, name: str = "") -> str:
    blob = f"{entity_id} {name}".lower()
    if "ariston_net" in blob or "ariston net" in blob or "aristonnet" in blob:
        return "ariston_net"
    if "open_meteo" in blob or "open meteo" in blob or entity_id.startswith("weather.openmeteo"):
        return "open_meteo"
    if "fusion_solar" in blob or "fusion solar" in blob:
        return "fusion_solar"
    if "eon_romania" in blob or "e.on" in blob or "eon romania" in blob or "eon românia" in blob:
        return "eon_romania"
    if "midea_ac" in blob or "midea ac" in blob:
        return "midea_ac"
    if "reteleelectrice" in blob or "rețele electrice" in blob or "retele electrice" in blob:
        return "reteleelectrice"
    if "pago" in blob:
        return "pago"
    if "reolink" in blob:
        return "reolink"
    if "roborock" in blob:
        return "roborock"
    if "tapo" in blob or "tp-link" in blob:
        return "tapo"
    if "xiaomi" in blob or "mi home" in blob:
        return "xiaomi_home"
    if entity_id.startswith("scene."):
        return "hyve_scenes"
    return "zigbee2mqtt"


def normalize_entities(states: list[dict[str, Any]], managed_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    managed_map = {str(item.get("entity_id") or ""): item for item in (managed_items or [])}
    items: list[dict[str, Any]] = []

    for raw in states or []:
        entity_id = str(raw.get("entity_id") or "").strip()
        if "." not in entity_id:
            continue
        domain = entity_domain(entity_id)
        if not is_visible_domain(domain):
            continue

        managed = managed_map.get(entity_id, {})
        attrs = raw.get("attributes") or {}
        name = managed.get("name") or attrs.get("friendly_name") or entity_id
        aliases = managed.get("aliases") or []

        items.append({
            "entity_id": entity_id,
            "name": name,
            "state": str(raw.get("state") or "unknown"),
            "domain": domain,
            "source": infer_source(entity_id, name),
            "aliases": aliases,
            "unit": attrs.get("unit_of_measurement") or "",
            "controllable": is_controllable_domain(domain),
        })

    items.sort(key=lambda item: (item.get("source") != "zigbee2mqtt", item.get("domain") or "", item.get("name") or ""))
    return _finalize(items, default_source="zigbee2mqtt")
