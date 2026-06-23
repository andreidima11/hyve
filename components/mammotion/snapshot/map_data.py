"""Map / plan helpers for Mammotion device snapshots."""

from __future__ import annotations

from typing import Any

from pymammotion.data.model.device import MowerDevice
from pymammotion.utility.device_type import DeviceType


def device_kind(device_name: str, product_key: str = "") -> str:
    if DeviceType.is_swimming_pool(device_name):
        return "spino"
    if DeviceType.is_rtk(device_name, product_key):
        return "rtk"
    return "mower"


def mower_flags(device_name: str) -> dict[str, bool]:
    return {
        "is_luba1": DeviceType.is_luba1(device_name),
        "is_luba_pro": DeviceType.is_luba_pro(device_name),
        "is_yuka": DeviceType.is_yuka(device_name),
        "is_yuka_mini": DeviceType.is_yuka_mini(device_name),
        "is_mini_or_x_series": DeviceType.is_mini_or_x_series(device_name),
        "supports_video": DeviceType.is_support_video(device_name)
        if hasattr(DeviceType, "is_support_video")
        else not DeviceType.is_luba1(device_name),
    }


def _map_obj(device: MowerDevice) -> Any:
    return getattr(device, "map", None)


def iter_map_area_pairs(device: MowerDevice) -> list[tuple[int, str]]:
    map_obj = _map_obj(device)
    if map_obj is None:
        return []

    # Preferred: PyMammotion's canonical merge of geometry (``area``) and names
    # (``area_name``). It auto-assigns "Area N" labels for hashes whose name the
    # cloud never delivered (some sessions never send ``toapp_all_hash_name``).
    try:
        computed = getattr(map_obj, "computed_areas", None)
        if computed:
            pairs: list[tuple[int, str]] = []
            for item in computed:
                area_hash = int(getattr(item, "hash", 0) or 0)
                if not area_hash:
                    continue
                label = str(getattr(item, "name", "") or "").strip() or f"Area {area_hash}"
                pairs.append((area_hash, label))
            if pairs:
                return pairs
    except Exception:
        pass

    area_name = getattr(map_obj, "area_name", None)
    if area_name:
        pairs = []
        for item in area_name:
            area_hash = int(getattr(item, "hash", 0) or 0)
            if not area_hash:
                continue
            label = str(getattr(item, "name", "") or "").strip() or f"Area {area_hash}"
            pairs.append((area_hash, label))
        if pairs:
            return pairs

    legacy = getattr(map_obj, "area_list", None)
    if legacy:
        pairs = []
        for area in legacy:
            area_hash = int(getattr(area, "hash", 0) or 0)
            if not area_hash:
                continue
            label = str(getattr(area, "name", "") or "").strip() or f"Area {area_hash}"
            pairs.append((area_hash, label))
        if pairs:
            return pairs

    area_dict = getattr(map_obj, "area", None)
    if isinstance(area_dict, dict) and area_dict:
        return [(int(h), f"Area {h}") for h in area_dict.keys() if int(h or 0)]

    # Last resort: the device-reported area manifest (hashes only, before the
    # boundary geometry frames have been fetched).
    try:
        root_hashes = getattr(map_obj, "area_root_hashlist", None)
        if root_hashes:
            seen: set[int] = set()
            pairs = []
            for h in root_hashes:
                area_hash = int(h or 0)
                if not area_hash or area_hash in seen:
                    continue
                seen.add(area_hash)
                pairs.append((area_hash, f"Area {area_hash}"))
            if pairs:
                return pairs
    except Exception:
        pass

    return []


def iter_map_plan_items(device: MowerDevice) -> list[tuple[str, Any]]:
    map_obj = _map_obj(device)
    if map_obj is None:
        return []
    plan = getattr(map_obj, "plan", None)
    if isinstance(plan, dict):
        return list(plan.items())
    return []


def area_name_from_map(device: MowerDevice, zone_hash: int) -> str | None:
    for area_hash, name in iter_map_area_pairs(device):
        if area_hash == zone_hash:
            if name and not name.lower().startswith("area "):
                return name
    return None
