"""Reolink entity registry — ported from Home Assistant ``components/reolink``.

Each spec describes one Hyve entity: how to detect support, read state, and
(optionally) control. ``build_entities()`` turns a live ``reolink_aio.api.Host``
into flat entity dicts for the entity store.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from integrations.entity_utils import attach_device_fields, slugify

# Re-export detection type constants used in binary_sensor specs
try:
    from reolink_aio.api import (
        FACE_DETECTION_TYPE,
        PACKAGE_DETECTION_TYPE,
        PERSON_DETECTION_TYPE,
        PET_DETECTION_TYPE,
        VEHICLE_DETECTION_TYPE,
        Chime,
        Host,
    )
    from reolink_aio.enums import GuardEnum, PtzEnum
except ImportError:  # pragma: no cover
    Host = Any  # type: ignore
    Chime = Any  # type: ignore
    FACE_DETECTION_TYPE = "face"
    PERSON_DETECTION_TYPE = "person"
    VEHICLE_DETECTION_TYPE = "vehicle"
    PET_DETECTION_TYPE = "pet"
    PACKAGE_DETECTION_TYPE = "package"
    PtzEnum = GuardEnum = None  # type: ignore


@dataclass(frozen=True)
class ReolinkSpec:
    domain: str
    key: str
    name: str
    scope: str  # channel | host | chime_ch | chime_host | rule
    supported: Callable[..., bool]
    value: Callable[..., Any]
    controllable: bool = False
    # switch / light on-off
    set_bool: Callable[..., Any] | None = None
    # button press (no arg)
    press: Callable[..., Any] | None = None
    # light extras
    set_brightness: Callable[..., Any] | None = None
    get_brightness: Callable[..., Any] | None = None
    # siren
    siren: bool = False
    # camera stream id
    stream: str | None = None
    unit: str = ""
    device_class: str = ""


def _eid(prefix: str, domain: str, key: str, channel: int | None = None, suffix: str = "") -> str:
    parts = [domain, slugify(f"{prefix}_{key}" if channel is None else f"{prefix}_ch{channel}_{key}")]
    if suffix:
        parts[1] += f"_{slugify(suffix)}"
    return ".".join(parts[:2]) if "." not in parts[1] else f"{parts[0]}.{parts[1]}"


def _channel_specs() -> list[ReolinkSpec]:
    """Channel-scoped entities (switches, sensors, binary, light, button, siren, camera)."""
    specs: list[ReolinkSpec] = []

    # ── Switches (HA switch.py SWITCH_ENTITIES) ───────────────────────────
    sw: list[tuple[str, str, Callable, Callable, Callable]] = [
        ("ir_lights", "IR", lambda a, c: a.supported(c, "ir_lights"), lambda a, c: a.ir_enabled(c), lambda a, c, v: a.set_ir_lights(c, v)),
        ("record_audio", "Înregistrare audio", lambda a, c: a.supported(c, "audio"), lambda a, c: a.audio_record(c), lambda a, c, v: a.set_audio(c, v)),
        ("siren_on_event", "Sirenă la eveniment", lambda a, c: a.supported(c, "siren"), lambda a, c: a.audio_alarm_enabled(c), lambda a, c, v: a.set_audio_alarm(c, v)),
        ("auto_tracking", "Urmărire automată", lambda a, c: a.supported(c, "auto_track"), lambda a, c: a.auto_track_enabled(c), lambda a, c, v: a.set_auto_tracking(c, v)),
        ("auto_focus", "Autofocus", lambda a, c: a.supported(c, "auto_focus"), lambda a, c: a.autofocus_enabled(c), lambda a, c, v: a.set_autofocus(c, v)),
        ("gaurd_return", "Guard return", lambda a, c: a.supported(c, "ptz_guard"), lambda a, c: a.ptz_guard_enabled(c), lambda a, c, v: a.set_ptz_guard(c, enable=v)),
        ("ptz_patrol", "Patrol PTZ", lambda a, c: a.supported(c, "ptz_patrol"), lambda a, c: a.baichuan.ptz_patrol_cruising(c), lambda a, c, v: a.ctrl_ptz_patrol(c, v)),
        ("email", "Email", lambda a, c: a.supported(c, "email") and a.is_nvr, lambda a, c: a.email_enabled(c), lambda a, c, v: a.set_email(c, v)),
        ("ftp_upload", "FTP", lambda a, c: a.supported(c, "ftp") and a.is_nvr, lambda a, c: a.ftp_enabled(c), lambda a, c, v: a.set_ftp(c, v)),
        ("push_notifications", "Notificări push", lambda a, c: a.supported(c, "push") and a.is_nvr, lambda a, c: a.push_enabled(c), lambda a, c, v: a.set_push(c, v)),
        ("record", "Înregistrare", lambda a, c: a.supported(c, "rec_enable") and a.is_nvr, lambda a, c: a.recording_enabled(c), lambda a, c, v: a.set_recording(c, v)),
        ("manual_record", "Înregistrare manuală", lambda a, c: a.supported(c, "manual_record"), lambda a, c: a.manual_record_enabled(c), lambda a, c, v: a.set_manual_record(c, v)),
        ("pre_record", "Pre-înregistrare", lambda a, c: a.supported(c, "pre_record"), lambda a, c: a.baichuan.pre_record_enabled(c), lambda a, c, v: a.baichuan.set_pre_recording(c, enabled=v)),
        ("buzzer", "Sonerie hub", lambda a, c: a.supported(c, "buzzer") and a.is_nvr, lambda a, c: a.buzzer_enabled(c), lambda a, c, v: a.set_buzzer(c, v)),
        ("doorbell_button_sound", "Sunet sonerie", lambda a, c: a.supported(c, "doorbell_button_sound"), lambda a, c: a.doorbell_button_sound(c), lambda a, c, v: a.set_volume(c, doorbell_button_sound=v)),
        ("pir_enabled", "PIR activ", lambda a, c: a.supported(c, "PIR"), lambda a, c: a.pir_enabled(c) is True, lambda a, c, v: a.set_pir(c, enable=v)),
        ("pir_reduce_alarm", "PIR reduce alarmă", lambda a, c: a.supported(c, "PIR"), lambda a, c: a.pir_reduce_alarm(c) is True, lambda a, c, v: a.set_pir(c, reduce_alarm=v)),
        ("privacy_mode", "Mod confidențialitate", lambda a, c: a.supported(c, "privacy_mode"), lambda a, c: a.baichuan.privacy_mode(c), lambda a, c, v: a.baichuan.set_privacy_mode(c, v)),
        ("privacy_mask", "Mască confidențialitate", lambda a, c: a.supported(c, "privacy_mask"), lambda a, c: a.privacy_mask_enabled(c), lambda a, c, v: a.set_privacy_mask(c, enable=v)),
        ("hardwired_chime_enabled", "Sonerie cablată", lambda a, c: a.supported(c, "hardwired_chime"), lambda a, c: a.baichuan.hardwired_chime_enabled(c), lambda a, c, v: a.baichuan.set_ding_dong_ctrl(c, enable=v)),
    ]
    for key, label, sup, val, set_ in sw:
        specs.append(ReolinkSpec("switch", key, label, "channel", sup, val, True, set_bool=set_))

    # ── Binary sensors (motion / AI / visitor) ────────────────────────────
    bs: list[tuple[str, str, Callable, Callable]] = [
        ("motion", "Mișcare", lambda a, c: a.supported(c, "motion_detection"), lambda a, c: a.motion_detected(c)),
        (FACE_DETECTION_TYPE, "Față", lambda a, c: a.ai_supported(c, FACE_DETECTION_TYPE), lambda a, c: a.ai_detected(c, FACE_DETECTION_TYPE)),
        (PERSON_DETECTION_TYPE, "Persoană", lambda a, c: a.ai_supported(c, PERSON_DETECTION_TYPE), lambda a, c: a.ai_detected(c, PERSON_DETECTION_TYPE)),
        (VEHICLE_DETECTION_TYPE, "Vehicul", lambda a, c: a.ai_supported(c, VEHICLE_DETECTION_TYPE), lambda a, c: a.ai_detected(c, VEHICLE_DETECTION_TYPE)),
        ("non-motor_vehicle", "Vehicul nemotor", lambda a, c: a.supported(c, "ai_non-motor vehicle"), lambda a, c: a.ai_detected(c, "non-motor vehicle")),
        (PET_DETECTION_TYPE, "Animal", lambda a, c: a.ai_supported(c, PET_DETECTION_TYPE) and not a.supported(c, "ai_animal"), lambda a, c: a.ai_detected(c, PET_DETECTION_TYPE)),
        (PACKAGE_DETECTION_TYPE, "Colet", lambda a, c: a.ai_supported(c, PACKAGE_DETECTION_TYPE), lambda a, c: a.ai_detected(c, PACKAGE_DETECTION_TYPE)),
        ("visitor", "Vizitator", lambda a, c: a.is_doorbell(c), lambda a, c: a.visitor_detected(c)),
        ("cry", "Plâns", lambda a, c: a.ai_supported(c, "cry"), lambda a, c: a.ai_detected(c, "cry")),
        ("sleep", "Sleep", lambda a, c: a.supported(c, "sleep"), lambda a, c: a.sleeping(c)),
    ]
    for key, label, sup, val in bs:
        specs.append(ReolinkSpec("binary_sensor", key, label, "channel", sup, val, device_class="motion" if key == "motion" else ""))

    # ── Sensors (read-only) ─────────────────────────────────────────────────
    sens: list[tuple[str, str, str, Callable, Callable]] = [
        ("battery_percent", "Baterie", "%", lambda a, c: a.supported(c, "battery"), lambda a, c: a.battery_percentage(c)),
        ("battery_temperature", "Temp. baterie", "°C", lambda a, c: a.supported(c, "battery"), lambda a, c: a.battery_temperature(c)),
        ("wifi_signal", "WiFi", "%", lambda a, c: a.supported(c, "wifi"), lambda a, c: a.wifi_signal(c)),
        ("day_night_state", "Zi/Noapte", "", lambda a, c: a.supported(c, "daynight"), lambda a, c: a.daynight_state(c)),
        ("ptz_pan_position", "PTZ pan", "", lambda a, c: a.supported(c, "ptz_position"), lambda a, c: a.ptz_pan_position(c)),
        ("ptz_tilt_position", "PTZ tilt", "", lambda a, c: a.supported(c, "ptz_position"), lambda a, c: a.ptz_tilt_position(c)),
    ]
    for key, label, unit, sup, val in sens:
        specs.append(ReolinkSpec("sensor", key, label, "channel", sup, val, unit=unit))

    # ── Lights ──────────────────────────────────────────────────────────────
    specs.append(ReolinkSpec(
        "light", "floodlight", "Reflector", "channel",
        lambda a, c: a.supported(c, "floodLight"),
        lambda a, c: a.whiteled_state(c),
        True,
        set_bool=lambda a, c, v: a.set_whiteled(c, state=v),
        set_brightness=lambda a, c, v: a.set_whiteled(c, brightness=v),
        get_brightness=lambda a, c: a.whiteled_brightness(c),
    ))
    specs.append(ReolinkSpec(
        "light", "status_led", "LED status", "channel",
        lambda a, c: a.supported(c, "power_led"),
        lambda a, c: a.status_led_enabled(c),
        True,
        set_bool=lambda a, c, v: a.set_status_led(c, v),
    ))

    # ── Buttons (PTZ, guard, reboot) ────────────────────────────────────────
    if PtzEnum is not None:
        btn: list[tuple[str, str, Callable, Callable]] = [
            ("ptz_stop", "PTZ stop", lambda a, c: a.supported(c, "pan_tilt") or a.supported(c, "zoom_basic"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.stop.value)),
            ("ptz_left", "PTZ stânga", lambda a, c: a.supported(c, "pan"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.left.value)),
            ("ptz_right", "PTZ dreapta", lambda a, c: a.supported(c, "pan"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.right.value)),
            ("ptz_up", "PTZ sus", lambda a, c: a.supported(c, "tilt"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.up.value)),
            ("ptz_down", "PTZ jos", lambda a, c: a.supported(c, "tilt"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.down.value)),
            ("ptz_zoom_in", "Zoom +", lambda a, c: a.supported(c, "zoom_basic"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.zoomin.value)),
            ("ptz_zoom_out", "Zoom -", lambda a, c: a.supported(c, "zoom_basic"), lambda a, c: a.set_ptz_command(c, command=PtzEnum.zoomout.value)),
            ("guard_go_to", "Guard poziție", lambda a, c: a.supported(c, "ptz_guard"), lambda a, c: a.set_ptz_guard(c, command=GuardEnum.goto.value)),
            ("guard_set", "Guard set", lambda a, c: a.supported(c, "ptz_guard"), lambda a, c: a.set_ptz_guard(c, command=GuardEnum.set.value)),
            ("reboot", "Repornire cameră", lambda a, c: a.supported(c, "reboot"), lambda a, c: a.reboot(c)),
        ]
        for key, label, sup, press in btn:
            specs.append(ReolinkSpec(
                "button", key, label, "channel", sup, lambda a, c, _v=None: "idle",
                controllable=True, press=press,
            ))

    # ── Siren ───────────────────────────────────────────────────────────────
    specs.append(ReolinkSpec(
        "siren", "siren", "Sirenă", "channel",
        lambda a, c: a.supported(c, "siren_play"),
        lambda a, c: a.baichuan.siren_state(c),
        controllable=True,
        siren=True,
    ))

    # ── Cameras (main sub stream per channel) ───────────────────────────────
    specs.append(ReolinkSpec(
        "camera", "sub", "Cameră", "channel",
        lambda a, c: a.supported(c, "stream"),
        lambda a, c: "streaming",
        stream="sub",
    ))

    return specs


def _host_specs() -> list[ReolinkSpec]:
    specs: list[ReolinkSpec] = []
    host_sw = [
        ("email", "Email", lambda a: a.supported(None, "email") and not a.is_hub, lambda a: a.email_enabled(), lambda a, v: a.set_email(None, v)),
        ("ftp_upload", "FTP", lambda a: a.supported(None, "ftp") and not a.is_hub, lambda a: a.ftp_enabled(), lambda a, v: a.set_ftp(None, v)),
        ("push_notifications", "Notificări push", lambda a: a.supported(None, "push") and not a.is_hub, lambda a: a.push_enabled(), lambda a, v: a.set_push(None, v)),
        ("record", "Înregistrare", lambda a: a.supported(None, "rec_enable") and not a.is_hub, lambda a: a.recording_enabled(), lambda a, v: a.set_recording(None, v)),
        ("buzzer", "Sonerie", lambda a: a.supported(None, "buzzer") and not a.is_hub, lambda a: a.buzzer_enabled(), lambda a, v: a.set_buzzer(None, v)),
    ]
    for key, label, sup, val, set_ in host_sw:
        specs.append(ReolinkSpec(
            "switch", key, label, "host", sup, val, True,
            set_bool=lambda a, _c, v, fn=set_: fn(a, v),
        ))

    specs.append(ReolinkSpec(
        "light", "hub_status_led", "LED status hub", "host",
        lambda a: a.supported(None, "state_light"),
        lambda a: a.state_light,
        True,
        set_bool=lambda a, _c, v: a.set_state_light(v),
    ))
    if PtzEnum is not None:
        specs.append(ReolinkSpec(
            "button", "reboot", "Repornire NVR", "host",
            lambda a: a.supported(None, "reboot"),
            lambda a: None,
            True,
            press=lambda a, _c: a.reboot(),
        ))
    specs.append(ReolinkSpec(
        "siren", "siren", "Sirenă hub", "host",
        lambda a: a.supported(None, "siren_play"),
        lambda a: False,
        controllable=True,
        siren=True,
    ))
    specs.append(ReolinkSpec(
        "sensor", "wifi_signal", "WiFi hub", "host",
        lambda a: a.supported(None, "wifi"),
        lambda a: a.wifi_signal(),
        unit="%",
    ))
    specs.append(ReolinkSpec(
        "sensor", "cpu_usage", "CPU", "host",
        lambda a: a.supported(None, "performance"),
        lambda a: a.cpu_usage(),
        unit="%",
    ))
    return specs


def all_specs() -> list[ReolinkSpec]:
    return _channel_specs() + _host_specs()


def _state_for_spec(api: Host, spec: ReolinkSpec, channel: int | None) -> Any:
    try:
        if spec.scope == "host":
            raw = spec.value(api, None)  # type: ignore[arg-type]
        else:
            raw = spec.value(api, channel)  # type: ignore[arg-type]
    except Exception:
        return "unknown"
    if spec.domain == "switch" or spec.domain == "light":
        return "on" if raw else "off"
    if spec.domain == "binary_sensor":
        return "on" if raw else "off"
    if spec.domain == "button":
        return "idle"
    if spec.domain == "camera":
        return raw or "idle"
    if raw is None:
        return "unknown"
    return raw


def _reolink_device(api: Host, prefix: str, channel: int | None) -> tuple[str, str]:
    if channel is None:
        return f"{prefix}_host", str(api.nvr_name or api.name or "Reolink")
    label = str(api.camera_name(channel) or f"Channel {channel}")
    return f"{prefix}_ch{channel}", label


def _append_reolink_entity(
    items: list[dict[str, Any]],
    entity: dict[str, Any],
    *,
    api: Host,
    prefix: str,
    channel: int | None,
) -> None:
    did, dname = _reolink_device(api, prefix, channel)
    items.append(attach_device_fields(
        entity,
        device_id=did,
        device_name=dname,
        manufacturer="Reolink",
        model=str(getattr(api, "model", "") or ""),
    ))


def build_entities(
    api: Host,
    *,
    entry_prefix: str,
    base_url: str,
    host_addr: str,
) -> list[dict[str, Any]]:
    """Build all Hyve entities for a connected Reolink API host."""
    items: list[dict[str, Any]] = []
    prefix = slugify(entry_prefix or "reolink")

    for spec in all_specs():
        if spec.scope == "host":
            channels: list[int | None] = [None]
        else:
            channels = list(api.channels)

        for ch in channels:
            try:
                if spec.scope == "host":
                    if not spec.supported(api):
                        continue
                else:
                    if not spec.supported(api, ch):
                        continue
            except Exception:
                continue

            ch_label = api.camera_name(ch) if ch is not None else (api.nvr_name or "Reolink")
            name = f"{ch_label} {spec.name}".strip()
            eid = f"{spec.domain}.{prefix}_{slugify(f'{ch}_{spec.key}' if ch is not None else spec.key)}"
            state = _state_for_spec(api, spec, ch)

            attrs: dict[str, Any] = {
                "friendly_name": name,
                "reolink_key": spec.key,
                "reolink_scope": spec.scope,
                "reolink_channel": ch,
                "configuration_url": base_url,
            }
            if spec.unit:
                attrs["unit_of_measurement"] = spec.unit
            if spec.device_class:
                attrs["capabilities"] = {"device_class": spec.device_class}
            if spec.stream:
                attrs.update({
                    "device_class": "camera",
                    "snapshot_refresh": 5,
                    "live_providers": ["snapshot"],
                })
                # Snapshot URL via Reolink HTTP API (filled after stream URL resolve in provider)
                attrs["frigate_camera"] = spec.key  # reuse hyveview camera card fields
                attrs["reolink_stream"] = spec.stream

            item: dict[str, Any] = {
                "entity_id": eid,
                "name": name,
                "state": state,
                "domain": spec.domain,
                "source": "reolink",
                "unit": spec.unit,
                "controllable": spec.controllable,
                "attributes": attrs,
            }
            _append_reolink_entity(items, item, api=api, prefix=prefix, channel=ch)

    # Dynamic: Smart AI binary sensors per zone (HA binary_sensor.py)
    _SMART_AI = (
        ("crossline", "ai_crossline", "people", "crossline_person"),
        ("crossline", "ai_crossline", "vehicle", "crossline_vehicle"),
        ("crossline", "ai_crossline", "dog_cat", "crossline_dog_cat"),
        ("intrusion", "ai_intrusion", "people", "intrusion_person"),
        ("intrusion", "ai_intrusion", "vehicle", "intrusion_vehicle"),
        ("intrusion", "ai_intrusion", "dog_cat", "intrusion_dog_cat"),
        ("loitering", "ai_linger", "people", "linger_person"),
        ("loitering", "ai_linger", "vehicle", "linger_vehicle"),
        ("loitering", "ai_linger", "dog_cat", "linger_dog_cat"),
    )
    for ch in api.channels:
        ch_name = api.camera_name(ch)
        for smart_type, sup_key, obj_type, key in _SMART_AI:
            if not api.supported(ch, sup_key):
                continue
            try:
                locations = api.baichuan.smart_location_list(ch, smart_type)
            except Exception:
                continue
            for loc in locations:
                try:
                    if obj_type not in api.baichuan.smart_ai_type_list(ch, smart_type, loc):
                        continue
                    zone = api.baichuan.smart_ai_name(ch, smart_type, loc)
                    on = api.baichuan.smart_ai_state(ch, smart_type, loc, obj_type)
                except Exception:
                    continue
                eid = f"binary_sensor.{prefix}_ch{ch}_{slugify(key)}_{loc}"
                _append_reolink_entity(items, {
                    "entity_id": eid,
                    "name": f"{ch_name} {key} ({zone})",
                    "state": "on" if on else "off",
                    "domain": "binary_sensor",
                    "source": "reolink",
                    "unit": "",
                    "controllable": False,
                    "attributes": {
                        "friendly_name": f"{ch_name} {key}",
                        "reolink_key": key,
                        "reolink_scope": "smart_ai",
                        "reolink_channel": ch,
                        "reolink_location": loc,
                        "reolink_smart_type": smart_type,
                        "reolink_object_type": obj_type,
                    },
                }, api=api, prefix=prefix, channel=ch)

    # Dynamic: IO inputs
    for ch in api.channels:
        try:
            inputs = api.baichuan.io_inputs(ch)
        except Exception:
            continue
        for idx in inputs:
            try:
                on = api.baichuan.io_input_state(ch, idx)
            except Exception:
                on = None
            ch_name = api.camera_name(ch)
            eid = f"binary_sensor.{prefix}_ch{ch}_io_input_{idx}"
            _append_reolink_entity(items, {
                "entity_id": eid,
                "name": f"{ch_name} IO {idx}",
                "state": "on" if on else "off" if on is not None else "unknown",
                "domain": "binary_sensor",
                "source": "reolink",
                "unit": "",
                "controllable": False,
                "attributes": {
                    "reolink_key": "io_input",
                    "reolink_scope": "io_input",
                    "reolink_channel": ch,
                    "reolink_index": idx,
                },
            }, api=api, prefix=prefix, channel=ch)

    # Dynamic: automation rules
    for ch in api.channels:
        try:
            rule_ids = api.baichuan.rule_ids(ch)
        except Exception:
            continue
        for rid in rule_ids:
            try:
                on = api.baichuan.rule_enabled(ch, rid)
                rname = api.baichuan.rule_name(ch, rid)
            except Exception:
                continue
            ch_name = api.camera_name(ch)
            eid = f"switch.{prefix}_ch{ch}_rule_{rid}"
            _append_reolink_entity(items, {
                "entity_id": eid,
                "name": f"{ch_name} Regulă {rname}",
                "state": "on" if on else "off",
                "domain": "switch",
                "source": "reolink",
                "unit": "",
                "controllable": True,
                "attributes": {
                    "reolink_key": "rule",
                    "reolink_scope": "rule",
                    "reolink_channel": ch,
                    "reolink_rule_id": rid,
                },
            }, api=api, prefix=prefix, channel=ch)

    return items
