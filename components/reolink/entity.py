"""Reolink NVR / camera integration (ported from Home Assistant).

Uses the official ``reolink-aio`` library (same as HA). Exposes cameras, switches,
binary sensors, sensors, lights, PTZ buttons, sirens, Smart AI zones, IO inputs,
and automation rules.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any
from urllib.parse import urlparse

import aiohttp

from pathlib import Path

from integrations.component_import import import_sibling
from integrations.base import BaseEntity
from integrations.entity_utils import slugify

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
_context_mod = import_sibling(_component_dir, "context")
extract_reolink_candidates = _extract_mod.extract_reolink_candidates
patch_camera_stream_attrs = _extract_mod.patch_camera_stream_attrs
_registry = import_sibling(_component_dir, "registry")
ReolinkSpec = _registry.ReolinkSpec
all_specs = _registry.all_specs
build_entities = _registry.build_entities

log = logging.getLogger("integrations.reolink")

_TIMEOUT = 30.0
_TEST_BUDGET_SECONDS = 32.0
_TEST_LOGIN_TIMEOUT = 12.0
_TEST_HOSTDATA_TIMEOUT = 12.0
# Per-entry live API handles (entry_id → Host)
_API_CACHE: dict[str, Any] = {}
_SESSION: aiohttp.ClientSession | None = None


def _get_aiohttp_session() -> aiohttp.ClientSession:
    global _SESSION
    if _SESSION is None or _SESSION.closed:
        _SESSION = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=_TIMEOUT),
            connector=aiohttp.TCPConnector(ssl=False),
        )
    return _SESSION


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _parse_port(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _parse_https(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    return _as_bool(value, True)


def _normalize_host(raw: str) -> str:
    """Accept bare IP/hostname or pasted URL (https://192.168.0.119/)."""
    host = (raw or "").strip()
    if not host:
        return host
    if "://" in host:
        parsed = urlparse(host)
        host = parsed.hostname or host
    host = host.split("/")[0].strip()
    host = host.split(":")[0].strip() if host.count(":") == 1 and not host.startswith("[") else host
    # Strip accidental port suffix on hostname field (192.168.0.119:443)
    if re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", host):
        host = host.rsplit(":", 1)[0]
    return host


async def _tcp_probe(host: str, port: int, timeout: float = 3.0) -> str | None:
    """Return None if port accepts TCP; otherwise a short error label."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout,
        )
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


def _network_hint(host: str, probe: dict[int, str | None]) -> str:
    """Build a Romanian hint from TCP probes on 443/80."""
    if not host:
        return ""
    codes = {p: probe.get(p) for p in (443, 80) if probe.get(p)}
    if not codes:
        return ""
    if all(v in ("no_route", "unreachable", "timeout") for v in codes.values()):
        return (
            f" Hyve nu poate deschide TCP către {host} (port 443/80: "
            f"{', '.join(f'{p}={codes[p]}' for p in sorted(codes))}). "
            "Camera e probabil pe alt SSID/VLAN sau cu „client isolation” pe WiFi — "
            "telefonul merge, dar Mac-ul Hyve (192.168.0.x) e blocat. "
            "Dezactivează izolarea AP / pune Mac-ul pe același WiFi ca camera, sau cablu LAN."
        )
    if all(v == "refused" for v in codes.values()):
        return " Porturile răspund dar refuză conexiunea — verifică în Reolink că API/HTTPS e activ."
    return ""


def _variant_label(section: dict[str, Any]) -> str:
    port = section.get("port")
    if port in (None, ""):
        port_s = "auto"
    else:
        port_s = str(port)
    https = section.get("use_https")
    if https in (None, ""):
        scheme = "auto"
    else:
        scheme = "HTTPS" if _as_bool(https, True) else "HTTP"
    return f"{scheme}:{port_s}"


class ReolinkEntity(BaseEntity):
    slug = "reolink"
    label = "Reolink"
    description = (
        "Camere și NVR Reolink: live, snapshot, mișcare, AI, PTZ, lumină, sirenă, "
        "înregistrare și setări — același set de funcții ca integrarea Home Assistant."
    )
    icon = "fa-video"
    color = "text-sky-300"
    scan_interval_seconds = 60
    uses_refresh_layers = True
    probe_interval_cycles = 10
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "host", "label": "Adresă IP / host", "type": "text", "required": True,
         "help": "Doar IP sau hostname, ex. 192.168.0.119 (fără https://)."},
        {"key": "port", "label": "Port HTTP", "type": "number", "default": 443, "min": 1, "max": 65535,
         "help": "443 pentru HTTPS (implicit). 80 pentru HTTP."},
        {"key": "username", "label": "Utilizator", "type": "text", "required": True},
        {"key": "password", "label": "Parolă", "type": "password", "secret": True, "required": True},
        {"key": "use_https", "label": "HTTPS", "type": "boolean", "default": True},
        {"key": "baichuan_port", "label": "Port Baichuan (opțional)", "type": "number", "default": 9000,
         "help": "9000 implicit. Schimbă doar dacă știi că folosești alt port."},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 60, "min": 15},
    ]

    def _section(self) -> dict[str, Any]:
        return self.entry_data or {}

    def _base_url(self) -> str:
        section = self._section()
        host = _normalize_host(str(section.get("host") or ""))
        port = int(section.get("port") or 443)
        scheme = "https" if _as_bool(section.get("use_https"), True) else "http"
        return f"{scheme}://{host}:{port}"

    def _entry_prefix(self) -> str:
        return (self.entry_id or "default")[:8]

    def _make_host(self, section: dict[str, Any] | None = None) -> Any:
        from reolink_aio.api import Host

        section = section or self._section()
        host = _normalize_host(str(section.get("host") or ""))
        user = str(section.get("username") or "").strip()
        password = str(section.get("password") or "")
        if not host or not user:
            raise RuntimeError("Host și utilizator sunt obligatorii.")
        bc_port = int(section.get("baichuan_port") or 9000)
        return Host(
            host,
            user,
            password,
            port=_parse_port(section.get("port")),
            use_https=_parse_https(section.get("use_https")),
            timeout=int(_TIMEOUT),
            aiohttp_get_session_callback=_get_aiohttp_session,
            bc_port=bc_port,
        )

    @classmethod
    def _test_variants(cls, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Connection attempts: user settings, flipped HTTP/S, then auto port discovery."""
        base = dict(data or {})
        variants: list[dict[str, Any]] = [base]
        https = base.get("use_https")
        if https not in (None, ""):
            if _as_bool(https, True):
                variants.append({**base, "use_https": False, "port": 80})
            else:
                variants.append({**base, "use_https": True, "port": 443})
        auto = dict(base)
        auto.pop("port", None)
        auto["use_https"] = None
        if auto not in variants:
            variants.append(auto)
        seen: list[str] = []
        out: list[dict[str, Any]] = []
        for v in variants:
            key = f"{v.get('host')}|{v.get('port')}|{v.get('use_https')}"
            if key in seen:
                continue
            seen.append(key)
            out.append(v)
        return out

    async def _connect(self) -> Any:
        """Return a logged-in ``reolink_aio.api.Host``, cached per config entry."""
        cache_key = self.entry_id or id(self)
        cached = _API_CACHE.get(cache_key)
        if cached is not None:
            return cached

        api = self._make_host()
        await api.login()
        await api.get_host_data()
        _API_CACHE[cache_key] = api
        return api

    async def _test_connect_once(self, section: dict[str, Any], budget: float) -> tuple[Any, str]:
        api = self._make_host(section)
        login_timeout = min(_TEST_LOGIN_TIMEOUT, max(4.0, budget * 0.5))
        await asyncio.wait_for(api.login(), timeout=login_timeout)
        host_data_ok = False
        remaining = budget - login_timeout
        if remaining > 2.0:
            try:
                await asyncio.wait_for(
                    api.get_host_data(),
                    timeout=min(_TEST_HOSTDATA_TIMEOUT, remaining),
                )
                host_data_ok = True
            except Exception as exc:
                log.debug("Reolink test get_host_data (%s): %s", _variant_label(section), exc)
        label = _variant_label(section)
        if host_data_ok:
            scheme = "https" if api.use_https else "http"
            port = api.port or (443 if api.use_https else 80)
            label = f"{label} → {scheme}://{api.host}:{port}"
        return api, label

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        section = dict(data or {})
        host = _normalize_host(str(section.get("host") or ""))
        if not host:
            return {"ok": False, "message": "Adresa IP a camerei este obligatorie (ex. 192.168.0.119)."}

        probe: dict[int, str | None] = {}
        for port in (443, 80):
            probe[port] = await _tcp_probe(host, port, timeout=3.0)
        net_hint = _network_hint(host, probe)
        if net_hint and all(probe.get(p) for p in (443, 80)):
            return {"ok": False, "message": f"Conexiune Reolink eșuată:{net_hint}"}

        inst = cls(entry_id="__test__", entry_data={**section, "host": host}, entry_title="test")
        errors: list[str] = []
        deadline = asyncio.get_running_loop().time() + _TEST_BUDGET_SECONDS
        try:
            for variant in cls._test_variants(inst.entry_data):
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining < 4.0:
                    errors.append("timp total epuizat")
                    break
                inst.entry_data = variant
                try:
                    api, used = await inst._test_connect_once(variant, remaining)
                    model = getattr(api, "model", "") or "Reolink"
                    n = len(getattr(api, "channels", []) or [])
                    if n:
                        msg = f"Conectat la {model} ({n} canale) — {used}."
                    else:
                        msg = f"Autentificare reușită la {model} — {used}. Salvează și așteaptă sync-ul pentru entități."
                    return {"ok": True, "message": msg}
                except asyncio.TimeoutError:
                    err = probe.get(443) or probe.get(80)
                    if err == "no_route":
                        errors.append(f"{_variant_label(variant)}: rețea blocată (no route)")
                    else:
                        errors.append(f"{_variant_label(variant)}: timeout")
                except Exception as exc:
                    errors.append(f"{_variant_label(variant)}: {exc}")
            hint = net_hint or (
                " Verifică user/parolă și că API-ul camerei e activ. "
                "HTTPS + port 443 (implicit), sau HTTP + port 80 cu HTTPS debifat."
            )
            detail = "; ".join(errors[-3:]) if errors else "necunoscut"
            return {"ok": False, "message": f"Conexiune Reolink eșuată: {detail}.{hint}"}
        finally:
            _API_CACHE.pop("__test__", None)

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        """Full snapshot: wake cameras, resolve RTSP streams, rebuild entity list."""
        return await self._build_payload(enrich_streams=True, wake=True)

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        """Light sync: refresh states only, reuse stream metadata from cache."""
        cached_items = list((cached or {}).get("items") or [])
        return await self._build_payload(
            enrich_streams=False,
            wake=False,
            cached_items=cached_items,
        )

    @staticmethod
    def _merge_cached_camera_attrs(
        items: list[dict[str, Any]],
        cached_items: list[dict[str, Any]],
    ) -> None:
        cached_by_id = {
            str(item.get("entity_id") or ""): item
            for item in cached_items
            if item.get("entity_id")
        }
        stream_keys = (
            "rtsp_url",
            "stream_url",
            "reolink_rtsp_sub",
            "live_providers",
            "has_audio",
            "snapshot_refresh",
            "two_way_audio",
            "speaker_volume",
            "reolink_snapshot",
            "device_manufacturer",
            "device_model",
        )
        for item in items:
            eid = str(item.get("entity_id") or "")
            cached = cached_by_id.get(eid)
            if not cached or item.get("domain") != "camera":
                continue
            old_attrs = cached.get("attributes") or {}
            attrs = item.setdefault("attributes", {})
            for key in stream_keys:
                if key in old_attrs:
                    attrs[key] = old_attrs[key]
            patch_camera_stream_attrs(attrs)

    async def _build_payload(
        self,
        *,
        enrich_streams: bool,
        wake: bool,
        cached_items: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        section = self._section()
        api = await self._connect()
        try:
            await api.get_states(wake=wake)
        except Exception as exc:
            if wake:
                log.warning("Reolink get_states failed, using wake=False: %s", exc)
                await api.get_states(wake=False)
            else:
                raise

        prefix = self._entry_prefix()
        base = self._base_url()
        host_addr = str(section.get("host") or "")
        items = build_entities(api, entry_prefix=prefix, base_url=base, host_addr=host_addr)

        if enrich_streams:
            for item in items:
                if item.get("domain") != "camera":
                    continue
                ch = (item.get("attributes") or {}).get("reolink_channel")
                stream = (item.get("attributes") or {}).get("reolink_stream") or "sub"
                if ch is None:
                    continue
                attrs = item.setdefault("attributes", {})
                sub_url = None
                main_url = None
                try:
                    sub_url = await api.get_stream_source(ch, stream, False)
                except Exception:
                    pass
                try:
                    main_url = await api.get_stream_source(ch, "main", False)
                except Exception:
                    pass
                play_rtsp = main_url or sub_url
                if play_rtsp:
                    attrs["rtsp_url"] = play_rtsp
                    if sub_url:
                        attrs["stream_url"] = sub_url
                    if sub_url and main_url and sub_url != main_url:
                        attrs["reolink_rtsp_sub"] = sub_url
                    attrs["live_providers"] = ["webm", "rtsp", "snapshot"]
                    attrs["has_audio"] = bool(main_url)
                    attrs["snapshot_refresh"] = 5
                    try:
                        if api.supported(ch, "two_way_audio"):
                            attrs["two_way_audio"] = True
                        if api.supported(ch, "volume_speak"):
                            vol = api.volume_speak(ch)
                            if vol is not None:
                                attrs["speaker_volume"] = int(vol)
                    except Exception:
                        pass
                else:
                    attrs["live_providers"] = ["snapshot"]
                attrs["reolink_snapshot"] = True
                patch_camera_stream_attrs(attrs)
                attrs["device_manufacturer"] = "Reolink"
                attrs["device_model"] = getattr(api, "model", "") or "Reolink"
        elif cached_items:
            self._merge_cached_camera_attrs(items, cached_items)

        return {
            "items": items,
            "model": getattr(api, "model", ""),
            "channels": list(api.channels),
            "host": host_addr,
        }

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_reolink_candidates(payload)

    async def list_entities(self, store) -> list[dict[str, Any]]:
        items = await super().list_entities(store)
        for item in items:
            if item.get("domain") == "camera":
                patch_camera_stream_attrs(item.setdefault("attributes", {}))
        return items

    def format_context(self, entities: dict[str, Any]) -> str:
        return _context_mod.format_reolink_context(entities if isinstance(entities, dict) else {})

    async def _resolve_spec(self, attrs: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
        api = await self._connect()
        return api, attrs

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        # Find entity attributes from live list
        items = await self.fetch_entities()
        payload_items = (items or {}).get("items") if isinstance(items, dict) else []
        ent = next((i for i in payload_items if i.get("entity_id") == entity_id), None)
        if not ent:
            raise ValueError(f"Entitate Reolink necunoscută: {entity_id}")
        attrs = ent.get("attributes") or {}
        api, _ = await self._resolve_spec(attrs)
        scope = str(attrs.get("reolink_scope") or "")
        key = str(attrs.get("reolink_key") or "")
        ch = attrs.get("reolink_channel")
        channel = int(ch) if ch is not None and ch != "" else None

        data = data or {}
        action = (action or "").strip().lower()

        try:
            if scope == "rule":
                rid = int(attrs.get("reolink_rule_id"))
                enable = action in ("turn_on", "on", "toggle")
                if action == "toggle":
                    enable = not api.baichuan.rule_enabled(channel, rid)
                await api.baichuan.set_rule_enabled(channel, rid, enable)
            elif scope == "smart_ai" or scope == "io_input":
                raise NotImplementedError("Acest senzor este doar pentru citire.")
            elif ent.get("domain") == "button" or action == "press":
                spec = _find_spec(ent.get("domain"), key)
                if spec and spec.press:
                    if channel is not None:
                        await spec.press(api, channel)
                    else:
                        await spec.press(api, None)
            elif ent.get("domain") == "siren" or (ent.get("domain") == "switch" and key == "siren"):
                if action in ("turn_off", "off"):
                    if channel is not None:
                        await api.set_siren(channel, False, None)
                    else:
                        await api.set_siren_off() if hasattr(api, "set_siren_off") else await api.set_siren()
                else:
                    duration = data.get("duration")
                    volume = data.get("volume")
                    if volume is not None and channel is not None:
                        await api.set_volume(channel, int(float(volume) * 100))
                    if channel is not None:
                        await api.set_siren(channel, True, duration)
                    else:
                        await api.set_siren()
            elif ent.get("domain") == "light":
                spec = _find_spec("light", key)
                if action in ("turn_off", "off"):
                    if spec and spec.set_bool:
                        await spec.set_bool(api, channel, False)
                else:
                    if spec and spec.set_brightness and data.get("brightness") is not None:
                        await spec.set_brightness(api, channel, int(data["brightness"]))
                    if spec and spec.set_bool:
                        await spec.set_bool(api, channel, True)
            elif ent.get("domain") == "switch":
                enable = action in ("turn_on", "on")
                if action == "toggle":
                    cur = str(ent.get("state") or "").lower() == "on"
                    enable = not cur
                if scope == "host":
                    spec = _find_spec("switch", key)
                    if spec and spec.set_bool:
                        await spec.set_bool(api, None, enable)  # host setters ignore channel
                elif scope == "rule":
                    pass  # handled above
                else:
                    spec = _find_spec("switch", key)
                    if spec and spec.set_bool and channel is not None:
                        await spec.set_bool(api, channel, enable)
            else:
                raise NotImplementedError(f"Control neimplementat pentru {entity_id}")

            await api.get_states(wake={channel: True} if channel is not None else True)
            _API_CACHE.pop(self.entry_id or id(self), None)
            return {"ok": True, "entity_id": entity_id, "action": action}
        except NotImplementedError:
            raise
        except Exception as exc:
            log.warning("control_entity %s failed: %s", entity_id, exc)
            raise RuntimeError(str(exc)) from exc


def _find_spec(domain: str, key: str) -> ReolinkSpec | None:
    for spec in all_specs():
        if spec.domain == domain and spec.key == key:
            return spec
    return None
