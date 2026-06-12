"""Dispatch Mammotion control_entity calls by unique_id."""

from __future__ import annotations

from typing import Any

from components.mammotion.coordinator import MowerCoordinator


def _slugify_device_name(name: str) -> str:
    import re

    text = re.sub(r"[^a-z0-9_]+", "_", str(name or "").strip().lower())
    return re.sub(r"_+", "_", text).strip("_")


_HYVE_CONTROL_DOMAINS = frozenset(
    {
        "switch",
        "button",
        "sensor",
        "binary_sensor",
        "number",
        "select",
        "lawn_mower",
        "vacuum",
        "device_tracker",
        "camera",
        "update",
        "event",
    }
)


def _parse_hyve_entity_id(raw: str, known_devices: list[str] | None) -> tuple[str, str, str] | None:
    """Parse Hyve entity_id ``domain.{slug}_{key}`` into mammotion control parts."""
    if "." not in raw:
        return None
    domain, rest = raw.split(".", 1)
    if domain not in _HYVE_CONTROL_DOMAINS or not rest:
        return None

    devices = known_devices or []
    if domain in {"lawn_mower", "vacuum"}:
        for candidate in devices:
            if _slugify_device_name(candidate) == rest:
                return candidate, domain, ""
        return None

    best: tuple[str, str, str] | None = None
    best_slug_len = -1
    for candidate in devices:
        slug = _slugify_device_name(candidate)
        if rest == slug:
            if len(slug) > best_slug_len:
                best = (candidate, domain, "")
                best_slug_len = len(slug)
            continue
        prefix = f"{slug}_"
        if rest.startswith(prefix):
            key = rest[len(prefix) :]
            if key and len(slug) > best_slug_len:
                best = (candidate, domain, key)
                best_slug_len = len(slug)
    return best


def parse_target_id(target_id: str, *, known_devices: list[str] | None = None) -> tuple[str, str, str]:
    """Return (device_name, domain_or_kind, key)."""
    raw = str(target_id or "").strip()
    if not raw:
        raise ValueError("entity_id Mammotion gol.")

    if raw.startswith("lawn_mower.") or raw.startswith("vacuum."):
        domain = "vacuum" if raw.startswith("vacuum.") else "lawn_mower"
        slug = raw.split(".", 1)[1]
        for candidate in known_devices or []:
            if _slugify_device_name(candidate) == slug:
                return candidate, domain, ""
        raise ValueError(f"Nu am găsit robotul Mammotion pentru {raw}.")

    hyve = _parse_hyve_entity_id(raw, known_devices)
    if hyve is not None:
        return hyve

    body = raw.split(":", 1)[1] if raw.startswith("mammotion:") else raw
    parts = body.split(":")
    device_name = parts[0]
    if len(parts) == 1:
        return device_name, "lawn_mower", ""
    return device_name, parts[1], ":".join(parts[2:])


async def control_mammotion(
    coordinator: MowerCoordinator,
    target_id: str,
    action: str,
    data: dict[str, Any] | None,
) -> dict[str, Any]:
    from pymammotion.utility.device_type import DeviceType

    device_name, domain, key = parse_target_id(target_id, known_devices=[coordinator.device_name])
    if coordinator.device_name != device_name:
        raise ValueError(f"Coordinator greșit pentru {device_name}")

    act = str(action or "").strip().lower()
    payload = dict(data or {})

    if DeviceType.is_swimming_pool(device_name) and domain in {"lawn_mower", device_name} and not key:
        return await _control_spino(coordinator, act, payload)

    if domain in {"lawn_mower", device_name} or (not key and domain == "lawn_mower"):
        return await _control_lawn_mower(coordinator, act, payload)

    if domain == "button":
        if act not in {"press", "turn_on", ""}:
            raise ValueError(f"Acțiune button invalidă: {action}")
        await coordinator.press_button(key)
        return {"status": "ok", "action": "press", "key": key}

    if domain == "switch":
        on = act in {"turn_on", "on", "enable"}
        if act == "toggle":
            on = not bool(payload.get("current_state") == "on")
        elif act in {"turn_off", "off", "disable"}:
            on = False
        elif act not in {"turn_on", "on", "enable", "set"}:
            raise ValueError(f"Acțiune switch invalidă: {action}")
        await coordinator.apply_switch(key, on)
        return {"status": "ok", "action": "turn_on" if on else "turn_off", "key": key}

    if domain == "number":
        value = payload.get("value", payload.get("number"))
        if value is None:
            raise ValueError("Lipsește valoarea pentru number.")
        await coordinator.apply_config_number(key, float(value))
        return {"status": "ok", "action": "set", "key": key, "value": value}

    if domain == "select":
        option = payload.get("option", payload.get("value"))
        if option is None:
            raise ValueError("Lipsește opțiunea pentru select.")
        await coordinator.apply_config_select(key, str(option))
        return {"status": "ok", "action": "select_option", "key": key, "option": option}

    if domain == "vacuum":
        return await _control_spino(coordinator, act, payload)

    if domain == "camera" and key == "webrtc":
        return await _control_mammotion_camera(coordinator, act, payload)

    raise ValueError(f"Domeniu Mammotion nesuportat pentru control: {domain}")


async def _control_mammotion_camera(
    coordinator: MowerCoordinator,
    act: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    del payload
    hub = coordinator._hub
    if hub is None:
        raise ValueError("Sesiunea Mammotion nu este disponibilă pentru cameră.")
    from components.mammotion.camera_stream import (
        refresh_mammotion_stream_tokens,
        start_mammotion_camera,
        stop_mammotion_camera,
    )

    device_name = coordinator.device_name
    if act in {"turn_on", "on", "start", "start_video", "play"}:
        tokens = await start_mammotion_camera(hub, device_name)
        return {"status": "ok", "action": "start_video", "tokens": tokens}
    if act in {"turn_off", "off", "stop", "stop_video"}:
        await stop_mammotion_camera(hub, device_name)
        return {"status": "ok", "action": "stop_video"}
    if act in {"refresh_stream", "refresh"}:
        tokens = await refresh_mammotion_stream_tokens(hub, device_name, force=True)
        return {"status": "ok", "action": "refresh_stream", "tokens": tokens}
    raise ValueError(f"Acțiune cameră Mammotion nesuportată: {act}")


async def _control_lawn_mower(coordinator: MowerCoordinator, act: str, payload: dict[str, Any]) -> dict[str, Any]:
    if act in {"start", "turn_on", "start_mowing"}:
        await coordinator.start_mow(**payload)
    elif act == "start_mow":
        await coordinator.start_mow(**payload)
    elif act == "pause":
        await coordinator.pause()
    elif act in {"dock", "return_to_base", "return_home"}:
        await coordinator.dock()
    elif act in {"stop", "turn_off", "cancel", "cancel_job"}:
        await coordinator.cancel_job()
    elif act == "start_stop_blades":
        await coordinator.start_stop_blades(
            bool(payload.get("start_stop", True)),
            int(payload.get("blade_height", 60)),
        )
    elif act == "set_non_work_hours":
        await coordinator.set_non_work_hours(
            str(payload.get("start_time", "09:00")),
            str(payload.get("end_time", "17:00")),
        )
    elif act == "reset_blade_time":
        await coordinator.reset_blade_time()
    elif act == "set_blade_warning_time":
        await coordinator.set_blade_warning_time(int(payload.get("hours", 50)))
    elif act == "rename_task":
        await coordinator.rename_task(str(payload["plan_id"]), str(payload["name"]))
    elif act == "set_task_enabled":
        await coordinator.set_task_enabled(str(payload["plan_id"]), bool(payload.get("enabled", True)))
    elif act == "delete_task":
        await coordinator.delete_task(str(payload["plan_id"]))
    elif act == "copy_task":
        await coordinator.copy_task(str(payload["plan_id"]), payload.get("name"))
    else:
        raise ValueError(f"Acțiune lawn_mower nesuportată: {act}")
    return {"status": "ok", "action": act}


async def _control_spino(coordinator: MowerCoordinator, act: str, payload: dict[str, Any]) -> dict[str, Any]:
    del payload
    if act in {"start", "turn_on"}:
        await coordinator._send("start_job")
    elif act in {"stop", "turn_off", "pause"}:
        await coordinator._send("pause_execute_task")
    elif act in {"dock", "return_to_base"}:
        await coordinator._send("return_to_dock")
    else:
        raise ValueError(f"Acțiune vacuum/spino nesuportată: {act}")
    return {"status": "ok", "action": act}
