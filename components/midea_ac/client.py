"""Midea Air Conditioner LAN client wrapper.

Isolates the optional ``msmart-ng`` dependency. Supports two configuration
paths:

* **Auto-discovery** — broadcasts on the local network and (optionally)
  uses a Midea cloud account to retrieve V3 token/key pairs.
* **Manual override** — a JSON list of devices with explicit
  ``host``, ``id``, ``token``, ``key`` per appliance, used when broadcast
  doesn't reach the AC (e.g. across VLANs).

The client returns plain dictionaries that the extractor turns into Hyve
entities, mirroring how :mod:`components.ariston_net.client` works.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
from typing import Any, Callable, Iterable

log = logging.getLogger("midea_ac")


class MideaAcError(ValueError):
    """Raised when Midea AC operations fail."""


class MideaAcDependencyError(MideaAcError):
    """Raised when the optional msmart-ng package is missing."""


SUPPORTED_CLOUD_REGIONS = ("US", "DE", "KR")
CLOUD_REGION_ALIASES = {
    "": "US",
    "AMERICA": "US",
    "STATE": "US",
    "STATES": "US",
    "USA": "US",
    "US": "US",
    "UNITED_STATES": "US",
    "DE": "DE",
    "EU": "DE",
    "EUROPE": "DE",
    "GERMANY": "DE",
    "RO": "DE",
    "ROMANIA": "DE",
    "KR": "KR",
    "KOREA": "KR",
    "SEA": "KR",
    "ASIA": "KR",
    "CN": "CN",
    "CHINA": "CN",
}
CLOUD_PROVIDER_ALIASES = {
    "": "auto",
    "AUTO": "auto",
    "NET_HOME_PLUS": "nethome",
    "NETHOME": "nethome",
    "NETHOMEPLUS": "nethome",
    "NET_HOME": "nethome",
    "MSMART": "smarthome",
    "MSMARTHOME": "smarthome",
    "SMART_HOME": "smarthome",
    "SMARTHOME": "smarthome",
    "MIDEA_AIR": "smarthome",
    "CHINA": "smarthome_china",
    "CN": "smarthome_china",
    "SMARTHOME_CHINA": "smarthome_china",
}


def _import_msmart() -> tuple[Any, Any, Any]:
    try:
        from msmart.device import AirConditioner as AC  # type: ignore
        from msmart.discover import Discover  # type: ignore
        from msmart import const as msmart_const  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional package
        raise MideaAcDependencyError(
            "Pachetul Python 'msmart-ng' nu este instalat. Rulează pip install -r requirements.txt."
        ) from exc
    return AC, Discover, msmart_const


def _import_clouds() -> tuple[Any, Any, Any]:
    try:
        from msmart.cloud import CloudError, NetHomePlusCloud, SmartHomeCloud  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional package
        raise MideaAcDependencyError(
            "Pachetul Python 'msmart-ng' nu este instalat. Rulează pip install -r requirements.txt."
        ) from exc
    return CloudError, NetHomePlusCloud, SmartHomeCloud


def _import_lan_helpers() -> tuple[Any, Any, Any]:
    try:
        from msmart.cloud import CloudError  # type: ignore
        from msmart.lan import AuthenticationError, Security  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional package
        raise MideaAcDependencyError(
            "Pachetul Python 'msmart-ng' nu este instalat. Rulează pip install -r requirements.txt."
        ) from exc
    return CloudError, AuthenticationError, Security


# ── helpers ───────────────────────────────────────────────────────────────

def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def _enum_name(value: Any) -> str:
    if value is None:
        return ""
    name = getattr(value, "name", None)
    return str(name) if name else str(value).split(".")[-1]


def _credential_text(value: Any) -> str:
    if value in (None, "", b""):
        return ""
    if isinstance(value, bytes):
        return value.hex()
    return str(value).strip()


def _device_credential(device: Any, name: str) -> str:
    for obj in (device, getattr(device, "_lan", None)):
        if obj is None:
            continue
        try:
            value = getattr(obj, name, None)
        except Exception:
            continue
        if callable(value):
            continue
        text = _credential_text(value)
        if text:
            return text
    return ""


def _close_device_lan(device: Any) -> None:
    lan = getattr(device, "_lan", None)
    disconnect = getattr(lan, "_disconnect", None)
    if not callable(disconnect):
        return
    try:
        disconnect()
    except Exception:
        pass


def normalize_cloud_region(value: Any) -> str:
    """Return the country code expected by msmart-ng cloud discovery."""
    text = str(value or "US").strip().upper().replace("-", "_").replace(" ", "_")
    region = CLOUD_REGION_ALIASES.get(text, text)
    if region in SUPPORTED_CLOUD_REGIONS or region == "CN":
        return region
    raise MideaAcError(
        "Regiune Midea necunoscută. Folosește US, DE/EU, KR/SEA sau CN "
        "(CN cere cont Midea/SmartHome și server China)."
    )


def normalize_cloud_provider(value: Any) -> str:
    text = str(value or "auto").strip().upper().replace("-", "_").replace(" ", "_")
    provider = CLOUD_PROVIDER_ALIASES.get(text, text.lower())
    if provider in {"auto", "nethome", "smarthome", "smarthome_china"}:
        return provider
    raise MideaAcError("Provider cloud Midea necunoscut. Folosește auto, nethome, smarthome sau smarthome_china.")


def _cloud_error_message(region: str, provider: str, exc: Exception) -> str:
    text = str(exc) or type(exc).__name__
    if "Unknown cloud region" in text:
        return f"{provider}/{region}: regiunea nu este suportată de acest backend"
    if "Account and password" in text:
        return f"{provider}/{region}: contul și parola trebuie completate împreună"
    if "value is illegal" in text.lower():
        return (
            f"{provider}/{region}: cloud-ul a respins valoarea trimisă pentru token ({text}). "
            "Încearcă Provider cloud = Auto sau configurează manual host/id/token/key."
        )
    return f"{provider}/{region}: {text}"


@asynccontextmanager
async def _cloud_provider_patch(Discover: Any, provider: str):
    if provider in {"auto", "nethome"}:
        yield
        return

    CloudError, _NetHomePlusCloud, SmartHomeCloud = _import_clouds()
    previous_get_cloud = Discover.__dict__["_get_cloud"]
    previous_cloud = getattr(Discover, "_cloud", None)

    async def _get_smart_home_cloud(cls):
        assert cls._lock
        async with cls._lock:
            if cls._cloud is None:
                cloud = SmartHomeCloud(
                    cls._region,
                    account=cls._account,
                    password=cls._password,
                    use_china_server=(provider == "smarthome_china"),
                    get_async_client=cls._get_async_client,
                )
                try:
                    await cloud.login()
                    cls._cloud = cloud
                except CloudError as exc:
                    raise CloudError(f"Failed to login to cloud. {exc}") from exc
        return cls._cloud

    Discover._get_cloud = classmethod(_get_smart_home_cloud)
    Discover._cloud = None
    try:
        yield
    finally:
        Discover._get_cloud = previous_get_cloud
        Discover._cloud = previous_cloud


def parse_devices_field(raw: Any) -> list[dict[str, Any]]:
    """Accepts a list, JSON array string, or empty value and returns a
    normalized list of device descriptors. Each entry must at least carry
    ``host`` and ``id``; ``token``/``key`` are optional (V1/V2 devices).
    """
    if raw in (None, "", b""):
        return []
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise MideaAcError(f"Câmpul 'devices' nu este JSON valid: {exc}") from exc
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        raise MideaAcError("Câmpul 'devices' trebuie să fie o listă JSON.")
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        host = str(entry.get("host") or entry.get("ip") or "").strip()
        device_id = _coerce_int(entry.get("id") or entry.get("device_id"))
        if not host or not device_id:
            raise MideaAcError("Fiecare device manual trebuie să aibă 'host' și 'id'.")
        out.append({
            "host": host,
            "port": _coerce_int(entry.get("port"), 6444),
            "id": device_id,
            "token": (entry.get("token") or "").strip() or None,
            "key": (entry.get("key") or entry.get("k1") or "").strip() or None,
            "name": (entry.get("name") or "").strip(),
        })
    return out


# ── client ────────────────────────────────────────────────────────────────

class MideaAcClient:
    def __init__(
        self,
        *,
        account: str = "",
        password: str = "",
        region: str = "US",
        cloud_provider: str = "auto",
        discovery_target: str = "255.255.255.255",
        discovery_timeout: float = 5.0,
        cloud_token_timeout: float = 8.0,
        discovery_budget: float = 26.0,
        devices: Iterable[dict[str, Any]] | None = None,
        cached_devices: Iterable[dict[str, Any]] | None = None,
        cache_callback: Callable[[list[dict[str, Any]]], None] | None = None,
    ) -> None:
        self.account = (account or "").strip()
        self.password = (password or "").strip()
        self.region = normalize_cloud_region(region)
        self.cloud_provider = normalize_cloud_provider(cloud_provider)
        self.discovery_target = (discovery_target or "255.255.255.255").strip() or "255.255.255.255"
        self.discovery_timeout = max(float(discovery_timeout or 5.0), 1.0)
        self.cloud_token_timeout = max(float(cloud_token_timeout or 8.0), 1.0)
        self.discovery_budget = max(float(discovery_budget or 26.0), 5.0)
        self.manual_devices: list[dict[str, Any]] = list(devices or [])
        # Devices remembered from a previous successful discovery. Identical
        # shape to ``manual_devices`` (host/id/token/key) so we can connect
        # directly via LAN without round-tripping through the Midea cloud.
        self.cached_devices: list[dict[str, Any]] = list(cached_devices or [])
        self._cache_callback = cache_callback
        self._cache: dict[int, Any] = {}

    # -- discovery -----------------------------------------------------
    async def _discover_lan(self) -> list[Any]:
        _AC, Discover, _const = _import_msmart()

        async def _call(kwargs: dict[str, Any]) -> list[Any]:
            devices = list(await Discover.discover(target=self.discovery_target, **kwargs))
            return await self._connect_discovered_devices(Discover, devices)

        return await self._run_discovery_attempts(Discover, _call)

    def _cloud_attempts(self) -> list[dict[str, Any]]:
        if bool(self.account) != bool(self.password):
            raise MideaAcError("Completează atât contul Midea, cât și parola, sau lasă ambele câmpuri goale.")

        if self.region == "CN":
            if not (self.account and self.password):
                raise MideaAcError(
                    "Regiunea CN nu are credențiale publice în msmart-ng. "
                    "Folosește un cont Midea/SmartHome China sau configurează manual host/id/token/key."
                )
            return [{"provider": "smarthome_china", "region": "CN", "account": self.account, "password": self.password}]

        if self.region not in SUPPORTED_CLOUD_REGIONS:
            raise MideaAcError("Regiunea Midea trebuie să fie US, DE/EU sau KR/SEA.")

        if self.cloud_provider == "smarthome_china":
            if not (self.account and self.password):
                raise MideaAcError("SmartHome China cere cont și parolă Midea.")
            return [{"provider": "smarthome_china", "region": self.region, "account": self.account, "password": self.password}]

        if self.cloud_provider == "nethome":
            providers = ["nethome", "smarthome"]
        elif self.cloud_provider == "smarthome":
            providers = ["smarthome", "nethome"]
        else:
            providers = ["nethome", "smarthome"]

        attempts: list[dict[str, Any]] = []
        if self.account and self.password:
            attempts.extend(
                {"provider": provider, "region": self.region, "account": self.account, "password": self.password}
                for provider in providers
            )
            return attempts

        attempts.extend({"provider": provider, "region": self.region, "account": "", "password": ""} for provider in providers)
        return attempts

    async def _run_discovery_attempts(self, Discover: Any, callback: Callable[[dict[str, Any]], Any]) -> Any:
        errors: list[str] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.discovery_budget
        for attempt in self._cloud_attempts():
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            kwargs: dict[str, Any] = {
                "timeout": min(self.discovery_timeout, max(1.0, remaining)),
                "region": attempt["region"],
                "auto_connect": False,
            }
            if attempt["account"] and attempt["password"]:
                kwargs["account"] = attempt["account"]
                kwargs["password"] = attempt["password"]
            try:
                async with _cloud_provider_patch(Discover, attempt["provider"]):
                    return await asyncio.wait_for(callback(kwargs), timeout=remaining)
            except asyncio.TimeoutError:
                message = f"{attempt['provider']}/{attempt['region']}: timeout după {remaining:.0f}s"
                errors.append(message)
                log.warning("Midea discovery attempt failed: %s", message)
                break
            except Exception as exc:
                message = _cloud_error_message(attempt["region"], attempt["provider"], exc)
                errors.append(message)
                log.warning("Midea discovery attempt failed: %s", message)
        suffix = "; ".join(errors) if errors else "nu a mai rămas timp pentru încercări cloud"
        raise MideaAcError("Discovery Midea a eșuat. " + suffix)

    def _direct_entries(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        cached_by_id = {_coerce_int(e.get("id")): e for e in self.cached_devices if _coerce_int(e.get("id"))}
        manual_ids: set[int] = set()
        for entry in self.manual_devices:
            dev_id = _coerce_int(entry.get("id"))
            manual_ids.add(dev_id)
            merged = dict(entry)
            cached = cached_by_id.get(dev_id) or {}
            for key in ("token", "key", "port", "name"):
                if not merged.get(key) and cached.get(key):
                    merged[key] = cached.get(key)
            entries.append(merged)
        for entry in self.cached_devices:
            if _coerce_int(entry.get("id")) in manual_ids:
                continue
            entries.append(entry)
        return entries

    def _missing_credentials_error(self, entry: dict[str, Any] | None, target: int = 0) -> MideaAcError:
        dev_id = target or _coerce_int((entry or {}).get("id"))
        host = str((entry or {}).get("host") or "").strip()
        where = f" pentru Midea {dev_id}" if dev_id else " pentru Midea"
        if host:
            where += f" ({host})"
        return MideaAcError(
            f"Nu am token/key local{where}. Cloud-ul Midea este folosit doar ca să obținem token/key; "
            "configurează dispozitivul manual cu host/id/token/key sau rulează o descoperire cu cont/regiune valide "
            "ca Hyve să le cache-uiască."
        )

    async def _connect_manual(self, entry: dict[str, Any], *, allow_cloud_lookup: bool = True) -> Any:
        AC, Discover, _const = _import_msmart()
        host = entry["host"]
        token = entry.get("token")
        key = entry.get("key")
        # Prefer discover_single when token/key missing — Discover handles the
        # cloud lookup for V3 devices when broadcast is blocked.
        if not token or not key:
            if not allow_cloud_lookup:
                raise self._missing_credentials_error(entry)

            async def _call(kwargs: dict[str, Any]) -> Any:
                devices = list(await Discover.discover(target=host, **kwargs))
                connected = await self._connect_discovered_devices(Discover, devices)
                return connected[0] if connected else None

            device = await self._run_discovery_attempts(Discover, _call)
            if not device:
                raise MideaAcError(f"Nu pot conecta dispozitivul Midea la {host}.")
            return device
        try:
            dev_id = int(entry.get("id") or 0)
        except (TypeError, ValueError) as exc:
            raise MideaAcError(f"ID Midea invalid pentru {host}: {entry.get('id')!r}") from exc
        if not dev_id:
            raise MideaAcError(f"Lipsește id-ul dispozitivului Midea pentru {host}.")
        port = int(entry.get("port") or 6444)
        device = AC(ip=host, device_id=dev_id, port=port)
        await device.authenticate(str(token), str(key))
        return device

    async def _ensure_devices(self, *, allow_discovery: bool = True) -> list[Any]:
        devices: list[Any] = []
        seen_ids: set[int] = set()
        direct_entries = self._direct_entries()

        # Manual entries take priority — they're explicit and always tried.
        # Cached entries (from a previous successful discovery) follow the
        # same path: connect directly over LAN with the stored token/key,
        # so we never hit the flaky Midea cloud after the first run.
        for entry in direct_entries:
            try:
                device = await self._connect_manual(entry, allow_cloud_lookup=allow_discovery)
            except Exception as exc:
                log.warning("Midea direct connect %s failed: %s", entry.get("host"), exc)
                continue
            if entry.get("name"):
                try:
                    device.name = entry["name"]
                except Exception:
                    pass
            devices.append(device)
            try:
                seen_ids.add(int(getattr(device, "id", 0) or 0))
            except Exception:
                pass

        if devices:
            self._persist_cache_from_devices(devices)

        # Fall back to broadcast discovery only when we have no remembered
        # devices at all. This is the only path that touches the Midea cloud
        # (to look up V3 token/key) and we persist the result so subsequent
        # syncs run fully locally.
        if allow_discovery and not direct_entries and not devices:
            discovered = await self._discover_lan()
            for device in discovered:
                try:
                    dev_id = int(getattr(device, "id", 0) or 0)
                except Exception:
                    dev_id = 0
                if dev_id and dev_id in seen_ids:
                    continue
                devices.append(device)
                if dev_id:
                    seen_ids.add(dev_id)
            self._persist_cache_from_devices(devices)
        return devices

    async def _connect_discovered_devices(self, Discover: Any, devices: list[Any]) -> list[Any]:
        connected: list[Any] = []
        failed_ids: list[str] = []
        last_reason: str = ""
        for device in devices:
            try:
                await self._connect_discovered_device(Discover, device)
            except Exception as exc:
                dev_id = str(getattr(device, "id", "?"))
                failed_ids.append(dev_id)
                last_reason = str(exc).split("\n")[0]
                if "invalidSession" in last_reason:
                    last_reason = "sesiune cloud expirată"
                elif "token" in last_reason.lower():
                    last_reason = "autentificare cloud eșuată"
                continue
            connected.append(device)
        if failed_ids:
            from core.logger import log_line
            summary = f"{len(failed_ids)} dispozitiv(e) — {last_reason}"
            log_line("error", "❄️", "MIDEA", f"Auth failed: {summary}")
        if devices and not connected:
            raise MideaAcError(f"Midea: {len(devices)} dispozitive găsite, 0 autentificate — {last_reason}")
        return connected

    async def _connect_discovered_device(self, Discover: Any, device: Any) -> None:
        if _coerce_int(getattr(device, "version", 0)) == 3:
            await self._authenticate_v3_device(Discover, device)
        try:
            await device.refresh()
        except NotImplementedError as exc:
            raise MideaAcError(f"Dispozitivul Midea {getattr(device, 'id', '?')} nu este suportat de msmart-ng.") from exc

    async def _authenticate_v3_device(self, Discover: Any, device: Any) -> None:
        CloudError, AuthenticationError, Security = _import_lan_helpers()
        try:
            cloud = await Discover._get_cloud()
        except CloudError as exc:
            raise CloudError(f"Failed to login to cloud. {exc}") from exc
        if not cloud:
            raise CloudError("Cloud-ul Midea nu a returnat o conexiune validă.")

        token_errors: list[str] = []
        auth_errors: list[str] = []
        dev_id = _coerce_int(getattr(device, "id", 0))
        if not dev_id:
            raise MideaAcError("Dispozitiv Midea fără id în răspunsul de discovery.")

        for endian in ("little", "big"):
            udpid = Security.udpid(dev_id.to_bytes(6, endian)).hex()
            try:
                token, key = await asyncio.wait_for(cloud.get_token(udpid), timeout=self.cloud_token_timeout)
            except asyncio.TimeoutError as exc:
                token_errors.append(f"{endian}/{udpid}: token lookup timeout după {self.cloud_token_timeout:g}s")
                continue
            except CloudError as exc:
                token_errors.append(f"{endian}/{udpid}: {exc}")
                continue
            try:
                await device.authenticate(token, key)
                return
            except AuthenticationError as exc:
                auth_errors.append(f"{endian}/{udpid}: {exc}")
                continue

        if any("invalidSession" in e for e in token_errors):
            raise CloudError("Sesiune cloud Midea expirată — reautentifică din Integrări.")
        raise CloudError(f"Token/key cloud indisponibil ({len(token_errors)} token erori, {len(auth_errors)} auth erori)")

    def _persist_cache_from_devices(self, devices: list[Any]) -> None:
        """Push fresh host/id/token/key tuples back to the integration entry
        so the next sync skips the cloud entirely."""
        if not self._cache_callback:
            return
        snapshot: list[dict[str, Any]] = []
        for device in devices:
            try:
                dev_id = int(getattr(device, "id", 0) or 0)
                host = str(getattr(device, "ip", "") or "").strip()
                token = _device_credential(device, "token")
                key = _device_credential(device, "key")
                if not (dev_id and host and token and key):
                    continue
                snapshot.append({
                    "host": host,
                    "port": int(getattr(device, "port", 6444) or 6444),
                    "id": dev_id,
                    "token": str(token),
                    "key": str(key),
                    "name": str(getattr(device, "name", "") or ""),
                })
            except Exception as exc:  # pragma: no cover - defensive
                log.debug("Midea cache snapshot skipped device: %s", exc)
        if not snapshot:
            return
        try:
            self._cache_callback(snapshot)
        except Exception as exc:  # pragma: no cover - persistence is best-effort
            log.warning("Midea cache persist failed: %s", exc)

    # -- public API ----------------------------------------------------
    async def test_connection(self) -> dict[str, Any]:
        devices = await self._ensure_devices()
        usable = [d for d in devices if getattr(d, "supported", True)]
        if not devices:
            return {
                "ok": False,
                "message": (
                    "Niciun aer condiționat Midea găsit. "
                    "Verifică rețeaua sau adaugă manual host/id/token/key."
                ),
            }
        for device in usable:
            try:
                await device.refresh()
            except Exception:
                continue
            finally:
                _close_device_lan(device)
        return {
            "ok": True,
            "message": f"Conexiune OK ({len(usable)} dispozitive Midea).",
        }

    async def fetch_all(self) -> dict[str, Any]:
        devices = await self._ensure_devices()
        out_devices: list[dict[str, Any]] = []
        for device in devices:
            try:
                await device.refresh()
            except Exception as exc:
                log.warning("Midea refresh failed for %s: %s", getattr(device, "ip", "?"), exc)
            out_devices.append(_serialize_device(device))
            self._cache[int(getattr(device, "id", 0) or 0)] = device
            _close_device_lan(device)
        return {"devices": out_devices}

    async def fetch_live(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        """Refresh known AC units without repeating LAN/cloud discovery."""
        rows = list((cached or {}).get("devices") or [])
        if not rows:
            return await self.fetch_all()
        out_devices: list[dict[str, Any]] = []
        for row in rows:
            token = str(row.get("device_token") or row.get("id") or "")
            if not token:
                out_devices.append(dict(row))
                continue
            device = None
            try:
                device = await self._device_for_token(token)
                await device.refresh()
                out_devices.append(_serialize_device(device))
                self._cache[int(getattr(device, "id", 0) or 0)] = device
            except Exception as exc:
                log.warning("Midea live refresh failed for %s: %s", token, exc)
                out_devices.append(dict(row))
            finally:
                try:
                    _close_device_lan(device)
                except Exception:
                    pass
        return {"devices": out_devices}

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        AC, _Discover, _const = _import_msmart()
        data = data or {}
        action = (action or "").strip().lower()
        suffix = (entity_id or "").split(":", 2)[-1]
        device_token = (entity_id or "").split(":")[1] if ":" in (entity_id or "") else ""
        device = await self._device_for_token(device_token)
        if device is None:
            raise MideaAcError(f"Nu pot găsi dispozitivul Midea pentru {entity_id}.")

        try:
            await device.refresh()
        except Exception as exc:
            _close_device_lan(device)
            raise MideaAcError(
                f"Nu pot citi starea curentă Midea pentru {getattr(device, 'ip', device_token)} înainte de control: {exc}"
            ) from exc

        value = data.get("value") if "value" in data else data.get("state")
        if action == "set_hvac_mode":
            hvac_mode = data.get("hvac_mode") or data.get("mode") or value
            hvac_text = str(hvac_mode or "").strip().lower().replace("-", "_").replace(" ", "_")
            if not hvac_text:
                raise MideaAcError("hvac_mode lipsă pentru Midea.")
            if hvac_text == "off":
                device.power_state = False
            else:
                device.power_state = True
                device.operational_mode = _coerce_enum(AC.OperationalMode, hvac_text)
        elif action in {"set_temperature", "set_value"}:
            temperature = data.get("temperature") if "temperature" in data else value
            try:
                device.target_temperature = float(temperature)
            except (TypeError, ValueError) as exc:
                raise MideaAcError(f"target_temperature invalid: {temperature}") from exc
        elif suffix == "power":
            if action == "toggle":
                device.power_state = not bool(getattr(device, "power_state", False))
            elif action == "turn_off":
                device.power_state = False
            else:
                device.power_state = True
        elif suffix == "target_temperature":
            try:
                device.target_temperature = float(value)
            except (TypeError, ValueError) as exc:
                raise MideaAcError(f"target_temperature invalid: {value}") from exc
        elif suffix == "operational_mode":
            device.operational_mode = _coerce_enum(AC.OperationalMode, value)
        elif suffix == "fan_speed":
            device.fan_speed = _coerce_enum(AC.FanSpeed, value)
        elif suffix == "swing_mode":
            device.swing_mode = _coerce_enum(AC.SwingMode, value)
        elif suffix == "eco":
            device.eco = action != "turn_off" and bool(value if value is not None else True)
        elif suffix == "turbo":
            device.turbo = action != "turn_off" and bool(value if value is not None else True)
        elif suffix == "display_on":
            try:
                if action == "toggle":
                    await device.toggle_display()
                else:
                    desired_display = action != "turn_off"
                    current_display = getattr(device, "display_on", None)
                    if current_display is None:
                        raise MideaAcError("Nu pot determina starea display-ului Midea înainte de control.")
                    if bool(current_display) != desired_display:
                        await device.toggle_display()
                return {"ok": True, "state": _serialize_device(device)}
            finally:
                _close_device_lan(device)
        elif suffix == "climate":
            if action == "toggle":
                device.power_state = not bool(getattr(device, "power_state", False))
            elif action == "turn_off":
                device.power_state = False
            elif action == "turn_on":
                device.power_state = True

            temperature = data.get("temperature") if "temperature" in data else value
            if temperature not in (None, ""):
                try:
                    device.target_temperature = float(temperature)
                except (TypeError, ValueError) as exc:
                    raise MideaAcError(f"target_temperature invalid: {temperature}") from exc

            hvac_mode = data.get("hvac_mode") or data.get("mode")
            if hvac_mode not in (None, ""):
                hvac_text = str(hvac_mode).strip().lower().replace("-", "_").replace(" ", "_")
                if hvac_text == "off":
                    device.power_state = False
                else:
                    device.power_state = True
                    device.operational_mode = _coerce_enum(AC.OperationalMode, hvac_text)

            fan_mode = data.get("fan_mode")
            if fan_mode not in (None, ""):
                device.fan_speed = _coerce_enum(AC.FanSpeed, fan_mode)

            swing_mode = data.get("swing_mode")
            if swing_mode not in (None, ""):
                device.swing_mode = _coerce_enum(AC.SwingMode, swing_mode)
        else:
            raise MideaAcError(f"Comanda Midea pentru '{suffix}' nu este implementată.")

        try:
            await device.apply()
            return {"ok": True, "state": _serialize_device(device)}
        finally:
            _close_device_lan(device)

    # -- internals -----------------------------------------------------
    async def _device_for_token(self, token: str) -> Any:
        target = _coerce_int(token)
        if target and target in self._cache:
            return self._cache[target]
        if not target:
            return None
        matching_entries = [entry for entry in self._direct_entries() if _coerce_int(entry.get("id")) == target]
        if not matching_entries:
            raise self._missing_credentials_error(None, target)
        last_error: Exception | None = None
        for entry in matching_entries:
            try:
                device = await self._connect_manual(entry, allow_cloud_lookup=False)
            except MideaAcError as exc:
                raise exc
            except Exception as exc:
                last_error = exc
                log.warning("Midea LAN control connect %s failed: %s", entry.get("host"), exc)
                continue
            if entry.get("name"):
                try:
                    device.name = entry["name"]
                except Exception:
                    pass
            self._cache[target] = device
            return device
        if last_error is not None:
            raise MideaAcError(f"Conectarea LAN Midea pentru {target} a eșuat: {last_error}") from last_error
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


def _coerce_enum(enum_cls: Any, value: Any) -> Any:
    if value is None:
        raise MideaAcError(f"Valoare lipsă pentru {enum_cls.__name__}")
    try:
        if isinstance(enum_cls, type) and isinstance(value, enum_cls):
            return value
    except TypeError:
        pass
    text = str(value).strip()
    # Try by name (case-insensitive), then by integer value
    for member in enum_cls:
        if text.lower() == str(getattr(member, "name", "")).lower():
            return member
    try:
        return enum_cls(int(text))
    except Exception:  # pragma: no cover - pass-through error
        raise MideaAcError(f"Valoare invalidă '{value}' pentru {enum_cls.__name__}")


def _serialize_device(device: Any) -> dict[str, Any]:
    """Pull a stable JSON-ready snapshot from a msmart AirConditioner."""
    def _get(attr: str, default: Any = None) -> Any:
        try:
            value = getattr(device, attr, default)
        except Exception:
            return default
        if callable(value):
            return default
        return value

    supported_modes = [_enum_name(m) for m in (_get("supported_operation_modes") or [])]
    supported_fans = [_enum_name(m) for m in (_get("supported_fan_speeds") or [])]
    supported_swings = [_enum_name(m) for m in (_get("supported_swing_modes") or [])]

    return {
        "id": _coerce_int(_get("id"), 0),
        "name": str(_get("name") or "") or f"Midea AC {_coerce_int(_get('id'), 0)}",
        "ip": _get("ip") or "",
        "port": _coerce_int(_get("port"), 6444),
        "sn": _get("sn") or "",
        "online": bool(_get("online", True)),
        "supported": bool(_get("supported", True)),
        "version": _coerce_int(_get("version"), 0),
        "power_state": bool(_get("power_state", False)),
        "operational_mode": _enum_name(_get("operational_mode")),
        "fan_speed": _enum_name(_get("fan_speed")),
        "swing_mode": _enum_name(_get("swing_mode")),
        "target_temperature": _get("target_temperature"),
        "indoor_temperature": _get("indoor_temperature"),
        "outdoor_temperature": _get("outdoor_temperature"),
        "indoor_humidity": _get("indoor_humidity"),
        "min_target_temperature": _get("min_target_temperature"),
        "max_target_temperature": _get("max_target_temperature"),
        "eco": bool(_get("eco", False)),
        "turbo": bool(_get("turbo", False)),
        "sleep": bool(_get("sleep", False)),
        "display_on": bool(_get("display_on", False)),
        "fahrenheit": bool(_get("fahrenheit", False)),
        "error_code": _get("error_code"),
        "supports_humidity": bool(_get("supports_humidity", False)),
        "supports_eco": bool(_get("supports_eco", False)),
        "supports_turbo": bool(_get("supports_turbo", False)),
        "supports_display_control": bool(_get("supports_display_control", False)),
        "supported_operation_modes": supported_modes,
        "supported_fan_speeds": supported_fans,
        "supported_swing_modes": supported_swings,
    }
