"""Mowing schedule / plan helpers for Mammotion snapshots."""

from __future__ import annotations

from typing import Any

from components.mammotion.snapshot.map_data import area_name_from_map
from pymammotion.data.model.device import MowerDevice


def _zone_labels(device: MowerDevice, zone_hashes: list[int]) -> list[str]:
    labels: list[str] = []
    for raw in zone_hashes:
        try:
            zone_hash = int(raw)
        except (TypeError, ValueError):
            continue
        if not zone_hash:
            continue
        name = area_name_from_map(device, zone_hash)
        labels.append(name or f"Zonă {zone_hash}")
    return labels


def plan_snapshot_entry(device: MowerDevice, plan_id: str, plan: Any) -> dict[str, Any]:
    """Serialize a pymammotion ``Plan`` for Hyve entity builders."""
    if plan is None:
        return {}
    pid = str(getattr(plan, "plan_id", None) or plan_id or "").strip() or str(plan_id)
    task_name = str(getattr(plan, "task_name", "") or "").strip()
    job_name = str(getattr(plan, "job_name", "") or "").strip()
    zone_hashes = [int(z) for z in (getattr(plan, "zone_hashs", None) or []) if int(z or 0)]
    zone_names = _zone_labels(device, zone_hashes)
    enabled = bool(plan.is_enabled()) if hasattr(plan, "is_enabled") else True
    plan_index = int(getattr(plan, "plan_index", 0) or 0)
    return {
        "plan_id": pid,
        "task_name": task_name,
        "job_name": job_name,
        "enabled": enabled,
        "zone_hashes": zone_hashes,
        "zone_names": zone_names,
        "plan_index": plan_index,
        "area_count": len(zone_hashes),
    }


def plan_display_label(plan: dict[str, Any] | None, plan_id: str = "") -> str:
    """Human label for a schedule button (HA uses ``Plan.task_name``)."""
    if not isinstance(plan, dict):
        return f"Task {plan_id}".strip() or "Task"
    pid = str(plan.get("plan_id") or plan_id or "").strip()
    task_name = str(plan.get("task_name") or "").strip()
    job_name = str(plan.get("job_name") or "").strip()
    generic = {f"task {pid}".lower(), f"task{pid}".lower(), pid.lower()}
    if task_name and task_name.lower() not in generic:
        return task_name
    if job_name and job_name.lower() not in generic:
        return job_name
    zone_names = [str(z).strip() for z in (plan.get("zone_names") or []) if str(z).strip()]
    if zone_names:
        return ", ".join(zone_names)
    plan_index = int(plan.get("plan_index") or 0)
    if plan_index > 0:
        return f"Program {plan_index}"
    if pid:
        return f"Program {pid}"
    return "Program"


def plans_from_device(device: MowerDevice) -> dict[str, dict[str, Any]]:
    """All map plans keyed by plan id (parity with HA ``map.plan``)."""
    from components.mammotion.snapshot.map_data import iter_map_plan_items

    out: dict[str, dict[str, Any]] = {}
    for plan_id, plan in iter_map_plan_items(device):
        entry = plan_snapshot_entry(device, str(plan_id), plan)
        if entry:
            out[str(plan_id)] = entry
    return out
