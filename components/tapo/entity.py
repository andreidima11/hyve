"""TP-Link Tapo integration (Home Assistant core ``tplink`` / python-kasa).

Supports Tapo plugs, lights, switches, hubs, cameras, doorbells and chimes on
the local network. Uses the same ``python-kasa`` library as HA's TP-Link Smart
Home integration.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import quote_plus, urlparse

from pathlib import Path
from integrations.component_import import import_sibling
from integrations.base import BaseEntity

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
_context_mod = import_sibling(_component_dir, "context")
extract_tapo_candidates = _extract_mod.extract_tapo_candidates

from integrations.entity_utils import attach_device_fields, slugify

if TYPE_CHECKING:
    from kasa import Device

log = logging.getLogger("integrations.tapo")

_CONNECT_TIMEOUT = 20
_DEVICE_CACHE: dict[str, Any] = {}

_LIGHT_TYPE_VALUES = frozenset({"bulb", "dimmer", "lightstrip"})
_SWITCH_TYPE_VALUES = frozenset({
    "plug", "wallswitch", "strip", "stripsocket", "fan", "thermostat", "vacuum",
})
_CAMERA_TYPE_VALUES = frozenset({"camera", "doorbell", "chime"})
_PTZ_ACTIONS = frozenset({
    "ptz_up", "ptz_down", "ptz_left", "ptz_right",
    "move_up", "move_down", "move_left", "move_right",
})
_PTZ_BUTTONS = (
    ("move_up", "Sus", "ptz_up"),
    ("move_down", "Jos", "ptz_down"),
    ("move_left", "Stânga", "ptz_left"),
    ("move_right", "Dreapta", "ptz_right"),
)


def _require_kasa():
    """Import python-kasa lazily so the provider registers even if the dep was missing at boot."""
    try:
        from components.tapo.kasa_ssl import apply_kasa_ssl_cipher_patch

        apply_kasa_ssl_cipher_patch()
        from kasa import Credentials, Device, Discover, Module
        from kasa.device_type import DeviceType
        from kasa.exceptions import AuthenticationError, KasaException, UnsupportedDeviceError

        return Credentials, Device, Discover, Module, DeviceType, AuthenticationError, KasaException, UnsupportedDeviceError
    except ImportError as exc:
        raise RuntimeError(
            "Pachetul python-kasa lipsește. Rulează: pip install -r requirements.txt "
            "și repornește serverul Hyve."
        ) from exc


def _dtype_value(dev: Any) -> str:
    dt = getattr(dev, "device_type", None)
    return getattr(dt, "value", str(dt or "")).lower()


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _normalize_host(raw: str) -> str:
    host = (raw or "").strip()
    if not host:
        return host
    if "://" in host:
        parsed = urlparse(host)
        host = parsed.hostname or host
    host = host.split("/")[0].strip()
    if re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", host):
        host = host.rsplit(":", 1)[0]
    return host


def build_rtsp_url(
    host: str,
    username: str,
    password: str,
    *,
    hd: bool = True,
) -> str | None:
    """Build a Tapo RTSP URL (stream1 HD / stream2 SD)."""
    host = _normalize_host(host)
    user = str(username or "").strip()
    pwd = str(password or "")
    if not host or not user or not pwd:
        return None
    stream = "stream1" if hd else "stream2"
    return f"rtsp://{quote_plus(user)}:{quote_plus(pwd)}@{host}:554/{stream}"


def _device_is_camera(dev: Any) -> bool:
    dtype = _dtype_value(dev)
    if dtype in _CAMERA_TYPE_VALUES:
        return True
    try:
        _Credentials, _Device, _Discover, Module, *_ = _require_kasa()
        return dev.modules.get(Module.Camera) is not None
    except Exception:
        return False


def _connection_metadata(dev: Any) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    try:
        conn = dev.config.connection_type
        if conn is not None:
            meta["connection_parameters"] = conn.to_dict()
    except Exception as exc:
        log.debug("tapo connection_parameters extract failed: %s", exc)
    try:
        meta["uses_http"] = bool(dev.config.uses_http)
    except Exception:
        pass
    cred_hash = getattr(dev, "credentials_hash", None)
    if cred_hash:
        meta["credentials_hash"] = cred_hash
    if dev.mac:
        meta["device_mac"] = dev.mac
    if dev.model:
        meta["device_model"] = dev.model
    if dev.alias:
        meta["device_alias"] = dev.alias
    return meta


async def _validate_rtsp_stream(rtsp_url: str) -> bool:
    import core.cctv_capture as cctv_capture

    frame = await asyncio.to_thread(cctv_capture.get_rtsp_frame, rtsp_url, 18.0)
    return bool(frame and len(frame) > 64)


async def _tcp_probe(host: str, port: int, timeout: float = 3.0) -> str | None:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return None
    except asyncio.TimeoutError:
        return "timeout"
    except OSError as exc:
        err = (exc.strerror or str(exc)).lower()
        if "no route" in err or getattr(exc, "errno", None) in (65, 113):
            return "no_route"
        if "refused" in err or getattr(exc, "errno", None) == 61:
            return "refused"
        return err or "unreachable"
    except Exception as exc:
        return str(exc).lower()[:40]


class TapoEntity(BaseEntity):
    slug = "tapo"
    label = "Tapo"
    description = (
        "Dispozitive TP-Link Tapo: prize, becuri, camere, sonerii, hub — "
        "aceeași bibliotecă ca integrarea TP-Link Smart Home din Home Assistant."
    )
    icon = "fa-plug"
    color = "text-emerald-300"
    scan_interval_seconds = 60
    uses_refresh_layers = True
    probe_interval_cycles = 12
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {
            "key": "host",
            "label": "Adresă IP / host",
            "type": "text",
            "required": True,
            "ui_group": "api",
            "help": "IP-ul camerei sau prizei, ex. 192.168.0.119 (fără https://).",
        },
        {
            "key": "username",
            "label": "Utilizator API",
            "type": "text",
            "required": True,
            "ui_group": "api",
            "help": "Cont Tapo cloud (user „admin” + parola cloud) sau Cont cameră pentru dispozitive locale.",
        },
        {
            "key": "password",
            "label": "Parolă API",
            "type": "password",
            "secret": True,
            "required": True,
            "ui_group": "api",
        },
        {
            "key": "credential_hint",
            "label": "Tip cont API",
            "type": "select",
            "default": "camera",
            "ui_group": "api",
            "options": [
                {"value": "camera", "label": "Cont cameră (recomandat pentru camere)"},
                {"value": "cloud", "label": "Cont Tapo / TP-Link cloud"},
            ],
            "help": "Dacă autentificarea API eșuează, încearcă celălalt tip sau user „admin” cu parola contului cloud.",
        },
        {
            "key": "live_view",
            "label": "Live view (RTSP)",
            "type": "boolean",
            "default": True,
            "ui_group": "camera_rtsp",
            "help": "Ca în Home Assistant: activează stream video local. Necesită Cont cameră separat dacă API folosește cont cloud.",
        },
        {
            "key": "rtsp_username",
            "label": "Utilizator Cont cameră (RTSP)",
            "type": "text",
            "required": False,
            "ui_group": "camera_rtsp",
            "help": "Tapo App → Setări cameră → Setări avansate → Cont cameră. Obligatoriu pentru video când API e cont cloud.",
        },
        {
            "key": "rtsp_password",
            "label": "Parolă Cont cameră (RTSP)",
            "type": "password",
            "secret": True,
            "required": False,
            "ui_group": "camera_rtsp",
        },
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 60, "min": 30, "ui_group": "advanced"},
    ]

    def _section(self) -> dict[str, Any]:
        return self.entry_data or {}

    def _entry_prefix(self) -> str:
        return (self.entry_id or "default")[:8]

    def _credentials(self, section: dict[str, Any] | None = None) -> Any:
        Credentials, *_ = _require_kasa()
        section = section or self._section()
        user = str(section.get("username") or "").strip()
        password = str(section.get("password") or "")
        hint = str(section.get("credential_hint") or "camera").strip().lower()
        if hint == "cloud" and "@" not in user and user.lower() != "admin":
            # HA docs: cloud often uses admin + cloud password
            user = user or "admin"
        return Credentials(username=user, password=password)

    def _rtsp_credentials(self, section: dict[str, Any] | None = None) -> Any:
        Credentials, *_ = _require_kasa()
        section = section or self._section()
        user = str(section.get("rtsp_username") or section.get("username") or "").strip()
        password = str(section.get("rtsp_password") or section.get("password") or "")
        hint = str(section.get("credential_hint") or "camera").strip().lower()
        if hint == "cloud" and "@" not in user and user.lower() != "admin":
            user = user or "admin"
        return Credentials(username=user, password=password)

    @classmethod
    def _live_view_enabled(cls, section: dict[str, Any] | None) -> bool:
        return _as_bool((section or {}).get("live_view"), True)

    @staticmethod
    def _apply_saved_connection(config: Any, section: dict[str, Any]) -> None:
        conn = section.get("connection_parameters")
        if isinstance(conn, dict) and conn:
            try:
                from kasa import Device

                config.connection_type = Device.ConnectionParameters.from_dict(conn)
            except Exception as exc:
                log.debug("tapo apply connection_parameters failed: %s", exc)
        cred_hash = str(section.get("credentials_hash") or "").strip()
        if cred_hash and not str(section.get("password") or "").strip():
            config.credentials_hash = cred_hash

    async def _connect(self, section: dict[str, Any] | None = None) -> Any:
        Credentials, Device, Discover, *_rest = _require_kasa()
        from kasa.deviceconfig import DeviceConfig

        section = section or self._section()
        cache_key = self.entry_id or id(self)
        cached = _DEVICE_CACHE.get(cache_key)
        if cached is not None:
            return cached

        host = _normalize_host(str(section.get("host") or ""))
        if not host:
            raise RuntimeError("Adresa IP este obligatorie.")
        creds = self._credentials(section)
        config = DeviceConfig(host=host, credentials=creds)
        self._apply_saved_connection(config, section)

        dev: Any | None = None
        last_exc: Exception | None = None
        for attempt in (
            lambda: Discover.discover_single(
                host,
                credentials=creds,
                timeout=_CONNECT_TIMEOUT,
                discovery_timeout=_CONNECT_TIMEOUT,
            ),
            lambda: Device.connect(config=config),
        ):
            try:
                dev = await asyncio.wait_for(attempt(), timeout=_CONNECT_TIMEOUT)
                if dev is not None:
                    break
            except Exception as exc:
                last_exc = exc
        if dev is None:
            raise RuntimeError(f"Nu s-a putut conecta la {host}: {last_exc or 'necunoscut'}")

        await asyncio.wait_for(dev.update(), timeout=_CONNECT_TIMEOUT)
        _DEVICE_CACHE[cache_key] = dev
        return dev

    @classmethod
    async def _check_connection(cls, section: dict[str, Any], *, phase: str = "full") -> dict[str, Any]:
        host = _normalize_host(str(section.get("host") or ""))
        if not host:
            return {"ok": False, "message": "Adresa IP este obligatorie."}

        probe = {443: await _tcp_probe(host, 443), 80: await _tcp_probe(host, 80)}
        if all(probe.values()):
            codes = ", ".join(f"{p}={probe[p]}" for p in sorted(probe))
            return {
                "ok": False,
                "message": (
                    f"Hyve nu poate deschide TCP către {host} ({codes}). "
                    "Verifică IP-ul și izolarea WiFi/VLAN."
                ),
            }

        phase = str(phase or "full").strip().lower()
        inst = cls(entry_id="__test__", entry_data=section, entry_title="test")
        try:
            dev = await inst._connect(section)
            label = dev.alias or dev.model or host
            dtype = getattr(dev.device_type, "value", str(dev.device_type))
            child_n = len(dev.children) if dev.children else 0
            extra = f", {child_n} sub-dispozitive" if child_n else ""
            entry_patch = _connection_metadata(dev)
            is_camera = _device_is_camera(dev)
            live_view = cls._live_view_enabled(section)

            if is_camera and live_view and phase == "api":
                return {
                    "ok": True,
                    "phase": "api",
                    "requires_camera_rtsp": True,
                    "entry_patch": entry_patch,
                    "message": (
                        f"API OK — {label} ({dtype}, {dev.model}){extra}. "
                        "Pas 2: completează Cont cameră (RTSP) și testează din nou."
                    ),
                }

            if is_camera and live_view and phase == "full":
                rtsp = inst._rtsp_url(dev, section=section)
                if not rtsp:
                    return {
                        "ok": False,
                        "requires_camera_rtsp": True,
                        "message": (
                            "Cont cameră lipsă. Tapo App → Setări cameră → Setări avansate → "
                            "Cont cameră, apoi completează rtsp_username / rtsp_password."
                        ),
                    }
                if not await _validate_rtsp_stream(rtsp):
                    return {
                        "ok": False,
                        "requires_camera_rtsp": True,
                        "message": (
                            "RTSP respins — user/parolă Cont cameră greșite sau ffmpeg indisponibil. "
                            "Verifică în VLC: rtsp://USER:PASS@IP:554/stream1"
                        ),
                    }
                return {
                    "ok": True,
                    "phase": "full",
                    "entry_patch": entry_patch,
                    "message": (
                        f"Conectat la {label} ({dtype}){extra}. "
                        "API + RTSP validate (ffmpeg)."
                    ),
                }

            return {
                "ok": True,
                "phase": phase,
                "entry_patch": entry_patch,
                "message": f"Conectat la {label} ({dtype}, model {dev.model}){extra}.",
            }
        finally:
            _DEVICE_CACHE.pop("__test__", None)

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        try:
            *_rest, AuthenticationError, KasaException, _Unsupported = _require_kasa()
        except RuntimeError as exc:
            return {"ok": False, "message": str(exc)}

        section = dict(data or {})
        phase = str(kwargs.get("phase") or "full").strip().lower()
        try:
            return await cls._check_connection(section, phase=phase)
        except AuthenticationError:
            return {
                "ok": False,
                "message": (
                    "Autentificare API eșuată. Pentru camere: Cont cameră sau "
                    "user „admin” + parola cloud Tapo."
                ),
            }
        except (KasaException, asyncio.TimeoutError, Exception) as exc:
            return {"ok": False, "message": f"Conexiune Tapo eșuată: {exc}"}

    @classmethod
    async def async_validate_entry(cls, data: dict[str, Any]) -> dict[str, Any]:
        section = dict(data or {})
        host = _normalize_host(str(section.get("host") or ""))
        if not host:
            return {"ok": False, "errors": {"host": "Adresa IP este obligatorie."}}
        if not str(section.get("username") or "").strip():
            return {"ok": False, "errors": {"username": "Utilizatorul API este obligatoriu."}}
        if not str(section.get("password") or "").strip() and not str(section.get("credentials_hash") or "").strip():
            return {"ok": False, "errors": {"password": "Parola API este obligatorie."}}

        try:
            result = await cls._check_connection(section, phase="full")
        except Exception as exc:
            return {"ok": False, "errors": {"__all__": str(exc)}}

        if not result.get("ok"):
            msg = str(result.get("message") or "Validare eșuată.")
            errors: dict[str, str] = {}
            if result.get("requires_camera_rtsp"):
                errors["rtsp_username"] = msg
                errors["rtsp_password"] = msg
            else:
                errors["__all__"] = msg
            return {"ok": False, "errors": errors}

        patch = dict(result.get("entry_patch") or {})
        title = str(patch.get("device_alias") or section.get("host") or "Tapo").strip()
        return {"ok": True, "title": title, "data": patch}

    def _device_key(self, dev: Any) -> str:
        did = getattr(dev, "device_id", None) or dev.mac or dev.host
        return slugify(str(did or dev.host))

    def _ptz_available(self, dev: Any) -> bool:
        return dev.modules.get("PanTilt") is not None

    async def _ptz_move(self, target: Any, action: str) -> None:
        action = (action or "").strip().lower()
        feat_map = {
            "ptz_up": "tilt_up",
            "move_up": "tilt_up",
            "ptz_down": "tilt_down",
            "move_down": "tilt_down",
            "ptz_left": "pan_left",
            "move_left": "pan_left",
            "ptz_right": "pan_right",
            "move_right": "pan_right",
        }
        feat_id = feat_map.get(action)
        if not feat_id:
            raise ValueError(f"Acțiune PTZ necunoscută: {action}")

        feat = target.features.get(feat_id)
        if feat is not None:
            await feat.set_value(None)
            return

        pt = target.modules.get("PanTilt")
        if pt is None:
            raise ValueError("Camera nu suportă PTZ")
        if feat_id == "tilt_up":
            await pt.tilt(pt._tilt_step)
        elif feat_id == "tilt_down":
            await pt.tilt(pt._tilt_step * -1)
        elif feat_id == "pan_left":
            await pt.pan(pt._pan_step)
        elif feat_id == "pan_right":
            await pt.pan(pt._pan_step * -1)

    def _rtsp_url(
        self,
        dev: Any,
        *,
        hd: bool = True,
        section: dict[str, Any] | None = None,
    ) -> str | None:
        section = section or self._section()
        if not self._live_view_enabled(section):
            return None
        creds = self._rtsp_credentials(section)
        host = _normalize_host(str(section.get("host") or getattr(dev, "host", "") or ""))
        try:
            _Credentials, _Device, _Discover, Module, _DT, *_ = _require_kasa()
            from kasa.smartcam.modules.camera import StreamResolution

            cam = dev.modules.get(Module.Camera)
            if cam:
                resolutions = (
                    (StreamResolution.HD, StreamResolution.SD)
                    if hd
                    else (StreamResolution.SD, StreamResolution.HD)
                )
                for res in resolutions:
                    url = cam.stream_rtsp_url(creds, stream_resolution=res)
                    if url:
                        return url
        except Exception as exc:
            log.debug("tapo rtsp url via kasa failed for %s: %s", host, exc)
        return build_rtsp_url(host, creds.username or "", creds.password or "", hd=hd)

    async def _entities_for_device(
        self,
        dev: Any,
        *,
        prefix: str,
        parent_name: str = "",
        section: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        section = section or self._section()
        _Credentials, _Device, _Discover, Module, _DeviceType, *_ = _require_kasa()
        items: list[dict[str, Any]] = []
        key = self._device_key(dev)
        name = (dev.alias or dev.model or dev.host or key).strip()
        full_name = f"{parent_name} {name}".strip() if parent_name else name
        dtype_val = _dtype_value(dev)

        def _add(entity: dict[str, Any]) -> None:
            attach_device_fields(
                entity,
                device_id=key,
                device_name=name,
                manufacturer="TP-Link",
                model=str(dev.model or ""),
            )
            items.append(entity)

        base_attrs = {
            "friendly_name": full_name,
            "device_manufacturer": "TP-Link",
            "device_model": dev.model or "",
            "device_id": key,
            "device_name": name,
            "tapo_host": dev.host,
            "tapo_device_key": key,
            "tapo_device_type": dtype_val,
        }
        if dev.mac:
            base_attrs["device_mac"] = dev.mac

        if dtype_val in _CAMERA_TYPE_VALUES:
            stream = None
            if self._live_view_enabled(section):
                stream = self._rtsp_url(dev, section=section)
            cam_attrs = {
                **base_attrs,
                "device_class": "camera",
                "live_providers": ["rtsp", "webm", "snapshot"] if stream else ["snapshot"],
            }
            if stream:
                cam_attrs["stream_url"] = stream
                cam_attrs["rtsp_url"] = stream
                cam_attrs["snapshot_refresh"] = 5
                cam_attrs["has_audio"] = True
                cam_attrs["two_way_audio"] = True
                cam_attrs["microphone_mutable"] = True
                cam_attrs["speaker_volume_mutable"] = True
            elif _normalize_host(str(section.get("host") or "")):
                log.warning(
                    "tapo camera %s: RTSP URL lipsă — setează Cont cameră (rtsp_username/rtsp_password) în integrare",
                    full_name,
                )
            if self._ptz_available(dev):
                cam_attrs["ptz_supported"] = True
                cam_attrs["capabilities"] = {**(cam_attrs.get("capabilities") or {}), "ptz": True}
            _add({
                "entity_id": f"camera.{prefix}_{key}",
                "name": full_name,
                "state": "streaming" if dev.is_on else "idle",
                "domain": "camera",
                "source": "tapo",
                "aliases": [name, dev.host],
                "unit": "",
                "controllable": True,
                "attributes": cam_attrs,
            })
            if self._ptz_available(dev):
                for suffix, label, ptz_action in _PTZ_BUTTONS:
                    _add({
                        "entity_id": f"button.{prefix}_{key}_{suffix}",
                        "name": f"{full_name} {label}",
                        "state": "idle",
                        "domain": "button",
                        "source": "tapo",
                        "unit": "",
                        "controllable": True,
                        "attributes": {
                            **base_attrs,
                            "tapo_feature": ptz_action,
                            "tapo_device_key": key,
                            "tapo_button_kind": "ptz",
                        },
                    })
            motion = dev.modules.get("MotionDetection")
            if motion is not None:
                _add({
                    "entity_id": f"switch.{prefix}_{key}_motion_detect",
                    "name": f"{full_name} detecție mișcare",
                    "state": "on" if motion.enabled else "off",
                    "domain": "switch",
                    "source": "tapo",
                    "unit": "",
                    "controllable": True,
                    "attributes": {**base_attrs, "tapo_feature": "motion_detection"},
                })
            person = dev.modules.get("PersonDetection")
            if person is not None:
                _add({
                    "entity_id": f"switch.{prefix}_{key}_person_detect",
                    "name": f"{full_name} detecție persoană",
                    "state": "on" if person.enabled else "off",
                    "domain": "switch",
                    "source": "tapo",
                    "unit": "",
                    "controllable": True,
                    "attributes": {**base_attrs, "tapo_feature": "person_detection"},
                })

        if dtype_val in _LIGHT_TYPE_VALUES | _SWITCH_TYPE_VALUES or (
            dtype_val not in _CAMERA_TYPE_VALUES
            and dtype_val not in ("hub", "unknown", "")
        ):
            domain = "light" if dtype_val in _LIGHT_TYPE_VALUES else "switch"
            ent = {
                "entity_id": f"{domain}.{prefix}_{key}",
                "name": full_name,
                "state": "on" if dev.is_on else "off",
                "domain": domain,
                "source": "tapo",
                "aliases": [name],
                "unit": "",
                "controllable": True,
                "attributes": base_attrs,
            }
            light_mod = dev.modules.get("Light") or dev.modules.get(getattr(Module, "Light", "Light"))
            if light_mod is not None and hasattr(light_mod, "brightness"):
                try:
                    ent["attributes"]["brightness"] = int(light_mod.brightness)
                except Exception:
                    pass
            _add(ent)

        if dev.rssi is not None:
            _add({
                "entity_id": f"sensor.{prefix}_{key}_rssi",
                "name": f"{full_name} RSSI",
                "state": str(dev.rssi),
                "domain": "sensor",
                "source": "tapo",
                "unit": "dBm",
                "controllable": False,
                "attributes": base_attrs,
            })

        led = dev.features.get("led") if dev.features else None
        if led is not None:
            _add({
                "entity_id": f"switch.{prefix}_{key}_led",
                "name": f"{full_name} LED",
                "state": "on" if led.value else "off",
                "domain": "switch",
                "source": "tapo",
                "unit": "",
                "controllable": True,
                "attributes": {**base_attrs, "tapo_feature": "led"},
            })

        for child in (dev.children or {}).values():
            try:
                await child.update()
            except Exception as exc:
                log.debug("tapo child update %s: %s", child.host, exc)
            items.extend(
                await self._entities_for_device(
                    child, prefix=prefix, parent_name=full_name, section=section,
                )
            )

        return items

    async def _build_payload(self) -> dict[str, Any]:
        section = self._section()
        try:
            dev = await self._connect()
        except Exception as exc:
            from core.logger import log_line
            log_line("error", "🔌", "TAPO", f"fetch failed — {exc}")
            return {"items": [], "error": str(exc)}

        prefix = self._entry_prefix()
        items = await self._entities_for_device(dev, prefix=prefix, section=section)
        return {
            "items": items,
            "host": _normalize_host(str(section.get("host") or "")),
            "model": dev.model,
            "alias": dev.alias,
        }

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._build_payload()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        if not (cached or {}).get("items"):
            return await self.probe_source()
        return await self._build_payload()

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_tapo_candidates(payload)

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_tapo_context(entities if isinstance(entities, dict) else {})

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _Credentials, _Device, _Discover, Module, _DT, *_ = _require_kasa()
        dev = await self._connect()
        prefix = self._entry_prefix()
        action = (action or "").strip().lower()
        data = data or {}

        target_key = None
        feature = None
        domain = None
        for item in self.extract_entities(await self.fetch_entities()):
            if item.get("entity_id") != entity_id:
                continue
            attrs = item.get("attributes") or {}
            target_key = attrs.get("tapo_device_key")
            feature = attrs.get("tapo_feature")
            domain = item.get("domain")
            break
        else:
            raise ValueError(f"Entitate Tapo necunoscută: {entity_id}")

        target = self._find_device(dev, target_key)
        if target is None:
            raise ValueError(f"Dispozitiv Tapo negăsit pentru {entity_id}")

        ptz_action = action if action in _PTZ_ACTIONS else None
        if not ptz_action and domain == "button" and action == "press" and feature in _PTZ_ACTIONS:
            ptz_action = feature
        if not ptz_action and domain == "camera" and action in _PTZ_ACTIONS:
            ptz_action = action

        enable = action in ("turn_on", "on")
        if action == "toggle":
            enable = not target.is_on

        try:
            if ptz_action:
                await self._ptz_move(target, ptz_action)
            elif feature == "motion_detection":
                mod = target.modules.get("MotionDetection")
                if mod:
                    await mod.set_enabled(enable)
            elif feature == "person_detection":
                mod = target.modules.get("PersonDetection")
                if mod:
                    await mod.set_enabled(enable)
            elif feature == "led":
                led = target.features.get("led")
                if led:
                    await led.set_value(enable)
            elif domain == "light" and data.get("brightness") is not None:
                light_mod = target.modules.get("Light") or target.modules.get(getattr(Module, "Light", "Light"))
                if light_mod and hasattr(light_mod, "set_brightness"):
                    await light_mod.set_brightness(int(data["brightness"]))
                if enable:
                    await target.turn_on()
                else:
                    await target.turn_off()
            elif domain == "button" and action == "press":
                raise ValueError(f"Buton Tapo fără acțiune suportată: {entity_id}")
            elif enable:
                await target.turn_on()
            else:
                await target.turn_off()

            await target.update()
            _DEVICE_CACHE.pop(self.entry_id or id(self), None)
            return {"ok": True, "entity_id": entity_id, "action": action}
        except Exception as exc:
            log.warning("tapo control %s failed: %s", entity_id, exc)
            raise RuntimeError(str(exc)) from exc

    def _find_device(self, root: Any, key: str | None) -> Any | None:
        if not key:
            return root
        if self._device_key(root) == key:
            return root
        for child in (root.children or {}).values():
            found = self._find_device(child, key)
            if found is not None:
                return found
        return None
