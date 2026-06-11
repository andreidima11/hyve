"""Frigate ``/api/config`` + ``/api/stats`` payload → Hyve entity candidates."""

from __future__ import annotations

import re
from typing import Any

from integrations.entity_utils import slugify
from core.smart_home_registry import normalize_entity_record

_UNKNOWN = "unknown"


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on", "enabled"}:
            return True
        if text in {"0", "false", "no", "off", "disabled"}:
            return False
    return default


def _num(value: Any, default: float | int | None = None) -> float | int | None:
    try:
        if value is None or value == "":
            return default
        n = float(value)
        return int(n) if n.is_integer() else n
    except (TypeError, ValueError):
        return default


def _version_tuple(value: Any) -> tuple[int, ...]:
    parts = re.findall(r"\d+", str(value or ""))[:3]
    return tuple(int(p) for p in parts) if parts else (0,)


def _dict_get(data: dict[str, Any], *path: str, default: Any = None) -> Any:
    cur: Any = data
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    return default if cur is None else cur


def _payload_parts(payload: Any) -> tuple[dict[str, Any], dict[str, Any], Any]:
    if not isinstance(payload, dict):
        return {}, {}, ""
    if "config" in payload or "stats" in payload:
        config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
        stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
        return config, stats, payload.get("version") or _dict_get(stats, "service", "version", default="")
    return payload, {}, ""


def _go2rtc_stream_name(cam_name: str, label: str, cam_cfg: dict[str, Any], streams: dict[str, Any]) -> str:
    if not isinstance(streams, dict) or not streams:
        return ""
    live_stream = str(_dict_get(cam_cfg, "live", "stream_name", default="") or cam_name).strip()
    candidates = [
        live_stream,
        cam_name,
        cam_name.lower(),
        cam_name.replace("-", "_"),
        cam_name.replace("_", "-"),
        slugify(cam_name),
    ]
    for candidate in candidates:
        if candidate and candidate in streams:
            return candidate

    cam_tokens = {
        token
        for token in re.split(r"[^a-z0-9]+", f"{cam_name} {label} {live_stream}".lower())
        if len(token) >= 5
    }
    fuzzy_matches = []
    for stream_name in streams.keys():
        stream_tokens = {
            token
            for token in re.split(r"[^a-z0-9]+", str(stream_name).lower())
            if len(token) >= 5
        }
        if cam_tokens & stream_tokens:
            fuzzy_matches.append(str(stream_name))
    return fuzzy_matches[0] if len(fuzzy_matches) == 1 else ""


def _base_attrs(*, device_id: str, device_name: str, base: str, version: Any = "") -> dict[str, Any]:
    model = "Frigate"
    if version:
        model = f"Frigate {version}"
    return {
        "device_id": device_id,
        "device_name": device_name,
        "device_model": model,
        "device_manufacturer": "Frigate",
        "configuration_url": base,
    }


def _camera_attrs(
    *,
    cam_name: str,
    label: str,
    cam_cfg: dict[str, Any],
    base: str,
    host: str,
    rtsp_port: int,
    version: Any,
    go2rtc_streams: dict[str, Any] | None = None,
) -> dict[str, Any]:
    live_stream = _dict_get(cam_cfg, "live", "stream_name", default="") or cam_name
    attrs = _base_attrs(
        device_id=f"frigate:{cam_name}",
        device_name=label,
        base=f"{base}/cameras/{cam_name}",
        version=version,
    )
    go2rtc_stream = _go2rtc_stream_name(cam_name, label, cam_cfg, go2rtc_streams or {})
    attrs.update({
        "friendly_name": label,
        "device_class": "camera",
        "snapshot_url": f"{base}/api/{cam_name}/latest.jpg?h=480",
        "mjpeg_url": f"{base}/api/{cam_name}?fps=5&h=480",
        "stream_url": f"{base}/api/{cam_name}/preview.mp4",
        "rtsp_url": f"rtsp://{host}:{rtsp_port}/{live_stream}",
        "webrtc_url": f"{base}/live/webrtc/{cam_name}",
        "frigate_url": f"{base}/cameras/{cam_name}",
        "frigate_camera": cam_name,
        "frigate_live_stream": live_stream,
        "snapshot_refresh": 5,
        "live_providers": ["mjpeg", "snapshot"],
    })
    if go2rtc_stream:
        attrs.update({
            "go2rtc_available": True,
            "go2rtc_stream": go2rtc_stream,
            "go2rtc_modes": ["mse", "mjpeg"],
            "live_provider": "go2rtc",
            "live_providers": ["go2rtc", "mjpeg", "snapshot"],
        })
    return attrs


def _tracked_objects(cam_cfg: dict[str, Any], zone_cfg: dict[str, Any] | None = None) -> list[str]:
    objects: list[str] = []
    source = zone_cfg if zone_cfg is not None else cam_cfg.get("objects") or {}
    raw: Any = []
    if isinstance(source, dict):
        raw = source.get("track") or source.get("objects") or source.get("filters") or []
    if isinstance(raw, dict):
        objects.extend(str(k) for k in raw.keys())
    elif isinstance(raw, list):
        objects.extend(str(v) for v in raw)
    if not objects and zone_cfg is not None:
        objects = _tracked_objects(cam_cfg)
    return sorted({"all", *[obj for obj in objects if obj]})


def _append_sensor(
    items: list[dict[str, Any]],
    entity_id: str,
    name: str,
    state: Any,
    attrs: dict[str, Any],
    *,
    unit: str = "",
    device_class: str = "",
) -> None:
    a = dict(attrs)
    if device_class:
        a["capabilities"] = {**(a.get("capabilities") or {}), "device_class": device_class}
    items.append({
        "entity_id": entity_id,
        "name": name,
        "state": _UNKNOWN if state is None or state == "" else state,
        "domain": "sensor",
        "source": "frigate",
        "unit": unit,
        "controllable": False,
        "attributes": a,
    })


def _append_binary_sensor(
    items: list[dict[str, Any]],
    entity_id: str,
    name: str,
    state: Any,
    attrs: dict[str, Any],
    *,
    device_class: str = "",
) -> None:
    a = dict(attrs)
    if device_class:
        a["capabilities"] = {**(a.get("capabilities") or {}), "device_class": device_class}
    items.append({
        "entity_id": entity_id,
        "name": name,
        "state": state if state in {"on", "off"} else _UNKNOWN,
        "domain": "binary_sensor",
        "source": "frigate",
        "unit": "",
        "controllable": False,
        "attributes": a,
    })


def _append_switch(
    items: list[dict[str, Any]],
    entity_id: str,
    name: str,
    enabled: Any,
    attrs: dict[str, Any],
) -> None:
    items.append({
        "entity_id": entity_id,
        "name": name,
        "state": "on" if _as_bool(enabled, False) else "off",
        "domain": "switch",
        "source": "frigate",
        "unit": "",
        "controllable": False,
        "attributes": {
            **attrs,
            "state_source": "config",
            "control_source": "Frigate MQTT/API control not enabled in Hyve yet",
        },
    })


def _append_number(
    items: list[dict[str, Any]],
    entity_id: str,
    name: str,
    value: Any,
    attrs: dict[str, Any],
    *,
    min_value: int,
    max_value: int,
    step: int = 1,
) -> None:
    items.append({
        "entity_id": entity_id,
        "name": name,
        "state": _num(value, 0),
        "domain": "number",
        "source": "frigate",
        "unit": "",
        "controllable": False,
        "attributes": {
            **attrs,
            "capabilities": {"min": min_value, "max": max_value, "step": step},
            "control_source": "Frigate MQTT/API control not enabled in Hyve yet",
        },
    })


def _append_select(
    items: list[dict[str, Any]],
    entity_id: str,
    name: str,
    options: list[str],
    attrs: dict[str, Any],
) -> None:
    items.append({
        "entity_id": entity_id,
        "name": name,
        "state": _UNKNOWN,
        "domain": "select",
        "source": "frigate",
        "unit": "",
        "controllable": False,
        "attributes": {
            **attrs,
            "options": options,
            "state_source": "Frigate MQTT",
            "control_source": "Frigate MQTT/API control not enabled in Hyve yet",
        },
    })


def extract_frigate_candidates(
    payload: Any,
    *,
    entry_data: dict[str, Any] | None,
    base_url: str,
) -> list[dict[str, Any]]:
    config, stats, version_payload = _payload_parts(payload)
    cameras = config.get("cameras") or {}
    if not isinstance(cameras, dict):
        return []

    section = entry_data or {}
    host = str(section.get("host") or "localhost").strip() or "localhost"
    rtsp_port = int(section.get("rtsp_port") or 8554)
    base = base_url
    service = stats.get("service") if isinstance(stats.get("service"), dict) else {}
    go2rtc_streams = (
        payload.get("go2rtc_streams")
        if isinstance(payload, dict) and isinstance(payload.get("go2rtc_streams"), dict)
        else {}
    )
    version = service.get("version") or version_payload or config.get("version") or ""
    latest_version = service.get("latest_version") or service.get("latest") or ""
    model_version = version or latest_version or ""

    items: list[dict[str, Any]] = []

    root_attrs = _base_attrs(
        device_id="frigate:server",
        device_name="Frigate",
        base=base,
        version=model_version,
    )
    _append_sensor(items, "sensor.frigate_status", "Frigate Status", "online", root_attrs)
    uptime = service.get("uptime") or service.get("last_updated")
    if uptime is not None:
        _append_sensor(
            items,
            "sensor.frigate_uptime",
            "Frigate Uptime",
            uptime,
            root_attrs,
            unit="s",
            device_class="duration",
        )
    for fps_key in ("detection_fps", "process_fps", "camera_fps", "skipped_fps"):
        if fps_key in stats:
            _append_sensor(
                items,
                f"sensor.frigate_{slugify(fps_key)}",
                f"Frigate {fps_key.replace('_', ' ').title()}",
                _num(stats.get(fps_key), 0),
                {**root_attrs, "raw_key": fps_key},
                unit="fps",
            )
    detectors = stats.get("detectors") if isinstance(stats.get("detectors"), dict) else {}
    for detector, values in detectors.items():
        if not isinstance(values, dict):
            continue
        speed = values.get("inference_speed") or values.get("inference_speed_ms")
        _append_sensor(
            items,
            f"sensor.frigate_{slugify(str(detector))}_inference_speed",
            f"Frigate {detector} Inference Speed",
            _num(speed, 0),
            {**root_attrs, "detector": detector, "raw_state": values},
            unit="ms",
        )
    if latest_version or version:
        update_state = "off"
        if latest_version and version and _version_tuple(latest_version) > _version_tuple(version):
            update_state = "on"
        items.append({
            "entity_id": "update.frigate_server",
            "name": "Frigate Server",
            "state": update_state,
            "domain": "update",
            "source": "frigate",
            "unit": "",
            "controllable": False,
            "attributes": {**root_attrs, "installed_version": version, "latest_version": latest_version},
        })

    profiles = config.get("profiles") if isinstance(config.get("profiles"), dict) else {}
    if profiles and _version_tuple(str(version or config.get("version") or "0")) >= _version_tuple("0.18"):
        _append_select(
            items,
            "select.frigate_profile",
            "Frigate Profile",
            [str(option) for option in profiles.keys()],
            root_attrs,
        )

    birdseye = config.get("birdseye") if isinstance(config.get("birdseye"), dict) else {}
    if _as_bool(birdseye.get("enabled"), False):
        attrs = _base_attrs(
            device_id="frigate:server",
            device_name="Frigate",
            base=f"{base}/birdseye",
            version=model_version,
        )
        attrs.update({
            "friendly_name": "Birdseye",
            "device_class": "camera",
            "snapshot_url": f"{base}/api/birdseye/latest.jpg?h=480",
            "mjpeg_url": f"{base}/api/birdseye?fps=5&h=480",
            "stream_url": f"{base}/api/birdseye/preview.mp4",
            "frigate_camera": "birdseye",
            "snapshot_refresh": 5,
            "live_providers": ["mjpeg", "snapshot"],
        })
        items.append({
            "entity_id": "camera.birdseye",
            "name": "Birdseye",
            "state": "streaming",
            "domain": "camera",
            "source": "frigate",
            "aliases": ["birdseye"],
            "unit": "",
            "controllable": False,
            "attributes": attrs,
        })

    stats_cameras = stats.get("cameras") if isinstance(stats.get("cameras"), dict) else {}
    for cam_name, cam_cfg in cameras.items():
        if not cam_name:
            continue
        cam_cfg = cam_cfg if isinstance(cam_cfg, dict) else {}
        obj = slugify(str(cam_name))
        label = str(cam_cfg.get("friendly_name") or cam_name).strip() or cam_name
        enabled = bool(cam_cfg.get("enabled", True))
        attrs = _camera_attrs(
            cam_name=str(cam_name),
            label=label,
            cam_cfg=cam_cfg,
            base=base,
            host=host,
            rtsp_port=rtsp_port,
            version=model_version,
            go2rtc_streams=go2rtc_streams,
        )
        items.append({
            "entity_id": f"camera.{obj}",
            "name": label,
            "state": "streaming" if enabled else "idle",
            "domain": "camera",
            "source": "frigate",
            "aliases": [cam_name],
            "unit": "",
            "controllable": False,
            "attributes": attrs,
        })

        cam_stats = stats_cameras.get(cam_name) if isinstance(stats_cameras.get(cam_name), dict) else {}
        for fps_key in ("camera_fps", "detection_fps", "process_fps", "skipped_fps"):
            if fps_key in cam_stats:
                _append_sensor(
                    items,
                    f"sensor.{obj}_{slugify(fps_key)}",
                    f"{label} {fps_key.replace('_', ' ').title()}",
                    _num(cam_stats.get(fps_key), 0),
                    {**attrs, "raw_key": fps_key, "raw_state": cam_stats},
                    unit="fps",
                )
        for cpu_key, state_key in (
            ("capture", "capture_process_cpu_usage"),
            ("detect", "detect_process_cpu_usage"),
            ("ffmpeg", "ffmpeg_process_cpu_usage"),
        ):
            raw_value = cam_stats.get(state_key) or _dict_get(stats, "cpu_usages", f"{cam_name}:{cpu_key}")
            if raw_value is not None:
                _append_sensor(
                    items,
                    f"sensor.{obj}_{cpu_key}_cpu_usage",
                    f"{label} {cpu_key.title()} CPU Usage",
                    _num(raw_value, 0),
                    {**attrs, "process": cpu_key},
                    unit="%",
                )
        audio_cfg = cam_cfg.get("audio") if isinstance(cam_cfg.get("audio"), dict) else {}
        audio_enabled = _as_bool(audio_cfg.get("enabled") or audio_cfg.get("enabled_in_config"), False)
        if audio_enabled:
            sound_level = cam_stats.get("audio_dBFS") or cam_stats.get("audio_dbfs") or cam_stats.get("sound_level")
            _append_sensor(
                items,
                f"sensor.{obj}_sound_level",
                f"{label} Sound Level",
                _num(sound_level, None),
                attrs,
                unit="dB",
            )
            for audio_name in (audio_cfg.get("listen") or audio_cfg.get("audio_events") or ["audio"]):
                _append_binary_sensor(
                    items,
                    f"binary_sensor.{obj}_{slugify(str(audio_name))}_sound",
                    f"{label} {str(audio_name).title()} Sound",
                    _UNKNOWN,
                    {**attrs, "state_source": "Frigate MQTT"},
                    device_class="sound",
                )

        _append_binary_sensor(
            items,
            f"binary_sensor.{obj}_motion",
            f"{label} Motion",
            _UNKNOWN,
            {**attrs, "state_source": "Frigate MQTT"},
            device_class="motion",
        )
        _append_sensor(
            items,
            f"sensor.{obj}_review_status",
            f"{label} Review Status",
            _UNKNOWN,
            {**attrs, "state_source": "Frigate MQTT"},
        )

        for object_name in _tracked_objects(cam_cfg):
            object_slug = slugify(object_name)
            object_attrs = {**attrs, "frigate_object": object_name, "state_source": "Frigate MQTT"}
            _append_sensor(
                items,
                f"sensor.{obj}_{object_slug}_count",
                f"{label} {object_name.title()} Count",
                _UNKNOWN,
                object_attrs,
            )
            _append_sensor(
                items,
                f"sensor.{obj}_{object_slug}_active_count",
                f"{label} {object_name.title()} Active Count",
                _UNKNOWN,
                object_attrs,
            )
            _append_binary_sensor(
                items,
                f"binary_sensor.{obj}_{object_slug}_occupancy",
                f"{label} {object_name.title()} Occupancy",
                _UNKNOWN,
                object_attrs,
                device_class="occupancy",
            )
            if object_name != "all":
                items.append({
                    "entity_id": f"image.{obj}_{object_slug}",
                    "name": f"{label} {object_name.title()}",
                    "state": "available",
                    "domain": "image",
                    "source": "frigate",
                    "unit": "",
                    "controllable": False,
                    "attributes": {
                        **object_attrs,
                        "image_url": f"{base}/api/{cam_name}/{object_name}/snapshot.jpg",
                        "snapshot_url": f"{base}/api/{cam_name}/latest.jpg?label={object_name}&h=720",
                    },
                })

        zones = cam_cfg.get("zones") if isinstance(cam_cfg.get("zones"), dict) else {}
        for zone_name, zone_cfg in zones.items():
            zone_obj = slugify(str(zone_name))
            zone_attrs = {
                **attrs,
                "device_id": f"frigate:{zone_name}",
                "device_name": str(zone_name).replace("_", " ").title(),
                "frigate_zone": zone_name,
                "state_source": "Frigate MQTT",
            }
            for object_name in _tracked_objects(cam_cfg, zone_cfg if isinstance(zone_cfg, dict) else {}):
                object_slug = slugify(object_name)
                zone_label = zone_attrs["device_name"]
                _append_sensor(
                    items,
                    f"sensor.{zone_obj}_{object_slug}_count",
                    f"{zone_label} {object_name.title()} Count",
                    _UNKNOWN,
                    {**zone_attrs, "frigate_object": object_name},
                )
                _append_sensor(
                    items,
                    f"sensor.{zone_obj}_{object_slug}_active_count",
                    f"{zone_label} {object_name.title()} Active Count",
                    _UNKNOWN,
                    {**zone_attrs, "frigate_object": object_name},
                )
                _append_binary_sensor(
                    items,
                    f"binary_sensor.{zone_obj}_{object_slug}_occupancy",
                    f"{zone_label} {object_name.title()} Occupancy",
                    _UNKNOWN,
                    {**zone_attrs, "frigate_object": object_name},
                    device_class="occupancy",
                )

        detect_cfg = cam_cfg.get("detect") if isinstance(cam_cfg.get("detect"), dict) else {}
        motion_cfg = cam_cfg.get("motion") if isinstance(cam_cfg.get("motion"), dict) else {}
        record_cfg = cam_cfg.get("record") if isinstance(cam_cfg.get("record"), dict) else {}
        snapshots_cfg = cam_cfg.get("snapshots") if isinstance(cam_cfg.get("snapshots"), dict) else {}
        review_cfg = cam_cfg.get("review") if isinstance(cam_cfg.get("review"), dict) else {}
        _append_switch(items, f"switch.{obj}_detect", f"{label} Detect", detect_cfg.get("enabled", enabled), attrs)
        _append_switch(items, f"switch.{obj}_motion", f"{label} Motion", motion_cfg.get("enabled", True), attrs)
        _append_switch(items, f"switch.{obj}_recordings", f"{label} Recordings", record_cfg.get("enabled", False), attrs)
        _append_switch(items, f"switch.{obj}_snapshots", f"{label} Snapshots", snapshots_cfg.get("enabled", False), attrs)
        if audio_cfg:
            _append_switch(items, f"switch.{obj}_audio_detection", f"{label} Audio Detection", audio_enabled, attrs)
        if "improve_contrast" in motion_cfg:
            _append_switch(
                items,
                f"switch.{obj}_improve_contrast",
                f"{label} Improve Contrast",
                motion_cfg.get("improve_contrast"),
                attrs,
            )
        alerts_cfg = review_cfg.get("alerts") if isinstance(review_cfg.get("alerts"), dict) else {}
        detections_cfg = review_cfg.get("detections") if isinstance(review_cfg.get("detections"), dict) else {}
        if alerts_cfg:
            _append_switch(
                items,
                f"switch.{obj}_review_alerts",
                f"{label} Review Alerts",
                alerts_cfg.get("enabled", True),
                attrs,
            )
        if detections_cfg:
            _append_switch(
                items,
                f"switch.{obj}_review_detections",
                f"{label} Review Detections",
                detections_cfg.get("enabled", True),
                attrs,
            )
        if motion_cfg:
            _append_number(
                items,
                f"number.{obj}_contour_area",
                f"{label} Contour Area",
                motion_cfg.get("contour_area", 10),
                attrs,
                min_value=1,
                max_value=100,
            )
            _append_number(
                items,
                f"number.{obj}_threshold",
                f"{label} Threshold",
                motion_cfg.get("threshold", 25),
                attrs,
                min_value=1,
                max_value=255,
            )

    for item in items:
        normalize_entity_record(item, default_source="frigate")
    items.sort(key=lambda i: i.get("name") or "")
    return items
