"""Huawei FusionSolar OpenAPI client."""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

import httpx

import settings as settings_mod

log = logging.getLogger("fusion_solar")


class FusionSolarError(Exception):
    """Raised when FusionSolar API calls fail."""


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or value == "" or value == "N/A":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _opt_float(value: Any) -> float | None:
    """Return a float when the API sent a value, else None — never fake zero."""
    return _safe_float(value)


def _add_summary(summary: dict[str, Any], key: str, value: float | None) -> None:
    if value is not None:
        summary[key] = float(summary.get(key) or 0.0) + value


def _normalize_host(host: str | None) -> str:
    text = str(host or "").strip()
    if not text:
        return "https://eu5.fusionsolar.huawei.com"
    if not re.match(r"^[a-z]+://", text, flags=re.I):
        text = "https://" + text.lstrip("/")
    parsed = urlparse(text)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    return text.rstrip("/")


def _candidate_hosts(host: str | None) -> list[str]:
    normalized = _normalize_host(host)
    parsed = urlparse(normalized)
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc or parsed.path
    candidates = [normalized]

    if netloc.startswith("eu5."):
        candidates.append(f"{scheme}://region01{netloc}")
        candidates.append(f"{scheme}://intl.fusionsolar.huawei.com")
    elif netloc.startswith("intl."):
        candidates.append(f"{scheme}://eu5.fusionsolar.huawei.com")
    elif "fusionsolar.huawei.com" in netloc and not netloc.startswith("region01"):
        candidates.append(f"{scheme}://region01{netloc}")
        candidates.append(f"{scheme}://intl.fusionsolar.huawei.com")

    seen = set()
    ordered = []
    for item in candidates:
        key = item.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    return ordered


def _extract_kiosk_id(url: str | None) -> str | None:
    text = str(url or "").strip()
    if not text:
        return None
    match = re.search(r"[?&]kk=([^&#]+)", text)
    if not match:
        return None
    return unquote(match.group(1))


class FusionSolarKioskClient:
    def __init__(self, kiosk_url: str, timeout: float = 20.0):
        self._kiosk_url = str(kiosk_url or "").strip()
        parsed = urlparse(self._kiosk_url)
        self._host = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
        self._kiosk_id = _extract_kiosk_id(self._kiosk_url)
        if not self._host or not self._kiosk_id:
            raise FusionSolarError("Invalid FusionSolar kiosk URL")
        self._timeout = httpx.Timeout(timeout, connect=10.0)
        self._cache: dict[str, Any] | None = None
        self._cache_ts = 0.0
        self._cache_ttl = 300.0

    async def _fetch_payload(self) -> dict[str, Any]:
        now = time.monotonic()
        if self._cache is not None and (now - self._cache_ts) < self._cache_ttl:
            return self._cache

        url = f"{self._host}/rest/pvms/web/kiosk/v1/station-kiosk-file?kk={self._kiosk_id}"
        async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=True) as client:
            response = await client.get(url, headers={"accept": "application/json"})
            response.raise_for_status()
            body = response.json()

        if body.get("success") is False:
            raise FusionSolarError(body.get("message") or "FusionSolar kiosk request failed")

        payload = body.get("data") or {}
        if isinstance(payload, str):
            payload = json.loads(html.unescape(payload))
        if not isinstance(payload, dict):
            raise FusionSolarError("FusionSolar kiosk payload is invalid")

        self._cache = payload
        self._cache_ts = time.monotonic()
        return payload

    async def fetch_all(self) -> dict[str, Any]:
        payload = await self._fetch_payload()
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        real = data.get("realKpi") if isinstance(data, dict) else {}
        if not isinstance(real, dict):
            real = payload.get("realKpi") if isinstance(payload.get("realKpi"), dict) else {}

        station_name = (
            (data.get("plantName") if isinstance(data, dict) else None)
            or (data.get("stationName") if isinstance(data, dict) else None)
            or payload.get("plantName")
            or payload.get("stationName")
            or "FusionSolar"
        )

        station = {
            "station_code": self._kiosk_id,
            "station_name": station_name,
            "station_address": (data.get("address") if isinstance(data, dict) else "") or payload.get("address") or "",
            "capacity_kw": _safe_float((data.get("capacity") if isinstance(data, dict) else None) or payload.get("capacity")),
            "status": "online",
            "realtime_power_kw": _opt_float(real.get("currentPower") or real.get("realTimePower") or real.get("current_power") or real.get("active_power")),
            "daily_energy_kwh": _opt_float(real.get("dailyEnergy") or real.get("dayPower") or real.get("daily_power") or real.get("day_power")),
            "month_energy_kwh": _opt_float(real.get("monthEnergy") or real.get("monthPower") or real.get("month_power")),
            "yearly_energy_kwh": _opt_float(real.get("yearEnergy") or real.get("yearPower") or real.get("year_power")),
            "lifetime_energy_kwh": _opt_float(real.get("cumulativeEnergy") or real.get("totalEnergy") or real.get("totalPower") or real.get("total_power")),
        }

        summary = {
            "station_count": 1,
            "realtime_power_kw": station["realtime_power_kw"],
            "daily_energy_kwh": station["daily_energy_kwh"],
            "month_energy_kwh": station["month_energy_kwh"],
            "yearly_energy_kwh": station["yearly_energy_kwh"],
            "lifetime_energy_kwh": station["lifetime_energy_kwh"],
            "status": "online",
        }

        return {
            "stations": [station],
            "realtime": [station],
            "yearly": [],
            "summary": summary,
        }

    async def test_connection(self) -> dict[str, Any]:
        data = await self.fetch_all()
        count = (data.get("summary") or {}).get("station_count", 1)
        return {
            "ok": True,
            "message_key": "integrations.fusion_solar_kiosk_connected",
            "message_params": {"count": count},
            "station_count": count,
        }

    def clear_cache(self):
        self._cache = None
        self._cache_ts = 0.0


class FusionSolarClient:
    def __init__(self, host: str, username: str, password: str, timeout: float = 20.0):
        self._host = _normalize_host(host)
        self._username = str(username or "").strip()
        self._password = str(password or "").strip()
        self._timeout = httpx.Timeout(timeout, connect=10.0)
        self._token: str | None = None
        self._lock = asyncio.Lock()
        self._last_request_at = 0.0
        self._last_call_at: dict[str, float] = {}
        self._cache: dict[str, Any] = {}
        self._blocked_until = 0.0
        self._user_sync_interval = 0
        self._global_min_interval = 1.25
        # Never block HTTP handlers / connection tests for minutes waiting on
        # Huawei cooldown — fail fast so the UI gets a clear message instead
        # of a generic timeout after 25s.
        self._max_inline_wait = 12.0
        self._endpoint_min_intervals = {
            "/thirdData/login": 15.0,
            "/thirdData/getStationList": 300.0,
            "/thirdData/stations": 300.0,
            "/thirdData/getStationRealKpi": 65.0,
            "/thirdData/getKpiStationYear": 600.0,
            "/thirdData/getDevList": 600.0,
            "/thirdData/getDevRealKpi": 65.0,
        }

    def _cache_key(self, path: str, payload: dict[str, Any]) -> str:
        return f"{path}:{json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)}"

    def _rate_limit_bucket(self, path: str, payload: dict[str, Any]) -> str:
        """Huawei rate-limits per endpoint, but ``getDevRealKpi`` accepts
        different ``devTypeId`` values — serial 65 s gaps between types made
        a full sync exceed the entity-store timeout."""
        if path == "/thirdData/getDevRealKpi":
            dev_type = payload.get("devTypeId")
            if dev_type is not None:
                return f"{path}#type={dev_type}"
        return path

    def set_user_sync_interval(self, seconds: int) -> None:
        """Configured scan_interval from Hyve UI — used in user-facing errors."""
        self._user_sync_interval = max(0, int(seconds))

    def _rate_limit_wait_or_raise(self, wait_for: float, path: str) -> None:
        if wait_for <= self._max_inline_wait:
            return
        secs = max(1, int(wait_for + 0.5))
        if self._user_sync_interval > 0:
            raise FusionSolarError(
                f"Limită Huawei temporară (~{secs}s până la următorul apel API). "
                f"Intervalul tău de sync e {self._user_sync_interval}s — "
                "lasă sync-ul automat să ruleze, fără apăsări repetate pe Sincronizează."
            )
        raise FusionSolarError(
            f"FusionSolar rate limit activ. Reîncearcă peste ~{secs}s."
        )

    async def _respect_rate_limit(self, path: str, cache_key: str, payload: dict[str, Any] | None = None):
        bucket = self._rate_limit_bucket(path, payload or {})
        now = time.monotonic()
        if self._blocked_until > now:
            cached = self._cache.get(cache_key)
            if cached is not None:
                log.warning("FusionSolar cooldown active; serving cached data for %s", path)
                return cached
            wait_for = self._blocked_until - now
            self._rate_limit_wait_or_raise(wait_for, path)
            log.warning("FusionSolar cooldown active; waiting %.1fs before %s", wait_for, path)
            await asyncio.sleep(wait_for)
            now = time.monotonic()

        elapsed_global = now - self._last_request_at
        if elapsed_global < self._global_min_interval:
            await asyncio.sleep(self._global_min_interval - elapsed_global)
            now = time.monotonic()

        min_interval = self._endpoint_min_intervals.get(path, 2.0)
        elapsed_endpoint = now - self._last_call_at.get(bucket, 0.0)
        if elapsed_endpoint < min_interval:
            cached = self._cache.get(cache_key)
            if cached is not None:
                log.debug("FusionSolar cached response for %s reused to respect cooldown", path)
                return cached
            wait_for = min_interval - elapsed_endpoint
            self._rate_limit_wait_or_raise(wait_for, path)
            log.debug("FusionSolar waiting %.1fs before calling %s", wait_for, path)
            await asyncio.sleep(wait_for)
        return None

    async def _login_once(self, host: str, payload: dict[str, Any]):
        url = f"{host}/thirdData/login"
        async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=True) as client:
            response = await client.post(url, headers={"accept": "application/json"}, json=payload)
            response.raise_for_status()
            try:
                data = response.json()
            except Exception as exc:
                raise FusionSolarError(f"Unexpected FusionSolar login response from {host}") from exc

        token = response.headers.get("xsrf-token") or response.cookies.get("xsrf-token")
        if not token or data.get("success") is False:
            message = data.get("message") or "Could not login with given credentials"
            if "user.login.user_or_value_invalid" in str(message):
                raise FusionSolarError("user.login.user_or_value_invalid")
            raise FusionSolarError(str(message))
        return token

    async def login(self) -> str:
        payload = {
            "userName": self._username,
            "systemCode": self._password,
        }
        cache_key = self._cache_key("/thirdData/login", {"userName": self._username})
        async with self._lock:
            cached = await self._respect_rate_limit("/thirdData/login", cache_key, payload)
            if cached is not None and self._token:
                return self._token

            last_error: Exception | None = None
            for host in _candidate_hosts(self._host):
                try:
                    token = await self._login_once(host, payload)
                    self._host = host.rstrip("/")
                    self._token = token
                    self._last_request_at = time.monotonic()
                    self._last_call_at[self._rate_limit_bucket("/thirdData/login", payload)] = self._last_request_at
                    self._cache[cache_key] = token
                    return token
                except Exception as exc:
                    last_error = exc
                    log.debug("FusionSolar login failed for %s: %s", host, exc)

            if last_error:
                raise last_error
            raise FusionSolarError("Could not login with given credentials")

    async def _do_call(self, path: str, payload: dict[str, Any], retry: bool = True):
        if not self._token:
            await self.login()

        url = f"{self._host}{path}"
        cache_key = self._cache_key(path, payload)
        should_retry = False

        bucket = self._rate_limit_bucket(path, payload)

        async with self._lock:
            cached = await self._respect_rate_limit(path, cache_key, payload)
            if cached is not None:
                return cached

            headers = {
                "accept": "application/json",
                "xsrf-token": self._token or "",
            }
            async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=True) as client:
                response = await client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()

            self._last_request_at = time.monotonic()
            self._last_call_at[bucket] = self._last_request_at

            fail_code = data.get("failCode")
            if fail_code == 305 and retry:
                self._token = None
                should_retry = True
            elif fail_code == 407 or "frequency" in str(data.get("message") or "").lower():
                self._blocked_until = time.monotonic() + max(self._endpoint_min_intervals.get(path, 60.0), 60.0)
                stale = self._cache.get(cache_key)
                if stale is not None:
                    log.warning("FusionSolar rate-limit hit for %s; returning cached data", path)
                    return stale
                raise FusionSolarError("FusionSolar rate limit active. The app is backing off automatically.")
            elif fail_code not in (None, 0):
                raise FusionSolarError(data.get("message") or f"FusionSolar API error {fail_code}")
            elif data.get("success") is False:
                raise FusionSolarError(data.get("message") or "FusionSolar request failed")
            else:
                result = data.get("data")
                self._cache[cache_key] = result
                return result

        if should_retry:
            await self.login()
            return await self._do_call(path, payload, retry=False)

        raise FusionSolarError("FusionSolar request failed")

    async def get_station_list(self) -> list[dict[str, Any]]:
        try:
            raw_stations = await self._do_call("/thirdData/getStationList", {}) or []
        except Exception:
            fallback = await self._do_call("/thirdData/stations", {"pageNo": 1}) or {}
            raw_stations = fallback.get("list") or []

        stations: list[dict[str, Any]] = []
        for station in raw_stations:
            code = station.get("stationCode") or station.get("plantCode") or ""
            if not code:
                continue
            stations.append({
                "station_code": code,
                "station_name": station.get("stationName") or station.get("plantName") or code,
                "station_address": station.get("stationAddr") or station.get("plantAddress") or "",
                "capacity_kw": _safe_float(station.get("capacity")),
                "contact_person": station.get("stationLinkman") or station.get("contactPerson") or "",
                "contact_phone": station.get("linkmanPho") or "",
            })
        return stations

    async def get_station_real_kpi(self, station_codes: list[str]) -> list[dict[str, Any]]:
        if not station_codes:
            return []
        data = await self._do_call("/thirdData/getStationRealKpi", {"stationCodes": ",".join(station_codes)})
        return data or []

    async def get_kpi_station_year(self, station_codes: list[str]) -> list[dict[str, Any]]:
        if not station_codes:
            return []
        next_year = datetime(year=datetime.now().year + 1, month=1, day=1, tzinfo=timezone.utc)
        data = await self._do_call(
            "/thirdData/getKpiStationYear",
            {"stationCodes": ",".join(station_codes), "collectTime": round(next_year.timestamp() * 1000)},
        )
        return data or []

    async def get_dev_list(self, station_codes: list[str]) -> list[dict[str, Any]]:
        if not station_codes:
            return []
        data = await self._do_call("/thirdData/getDevList", {"stationCodes": ",".join(station_codes)})
        return data or []

    async def get_dev_real_kpi(self, device_ids: list[str], type_id: int) -> list[dict[str, Any]]:
        if not device_ids:
            return []
        data = await self._do_call(
            "/thirdData/getDevRealKpi",
            {"devIds": ",".join(device_ids), "devTypeId": type_id},
        )
        return data or []

    async def fetch_all(self) -> dict[str, Any]:
        stations = await self.get_station_list()
        station_codes = [item["station_code"] for item in stations if item.get("station_code")]
        realtime_raw = await self.get_station_real_kpi(station_codes)
        try:
            yearly_raw = await self.get_kpi_station_year(station_codes)
        except Exception as exc:
            log.debug("FusionSolar yearly KPI fetch failed: %s", exc)
            yearly_raw = []

        # Fetch device list (inverters, batteries, meters, etc.)
        devices_raw: list[dict[str, Any]] = []
        try:
            devices_raw = await self.get_dev_list(station_codes)
        except Exception as exc:
            log.debug("FusionSolar device list fetch failed: %s", exc)

        # Fetch device real-time KPI per device type
        _DEVICE_TYPES = {
            1: "String Inverter",
            10: "EMI",
            17: "Grid Meter",
            38: "Residential Inverter",
            39: "Battery",
            41: "C&I and Utility ESS",
            47: "Power Sensor",
        }
        devices_grouped: dict[int, list[str]] = {}
        for dev in devices_raw:
            if not isinstance(dev, dict):
                continue
            tid = dev.get("devTypeId")
            did = str(dev.get("id") or "")
            if tid in _DEVICE_TYPES and did:
                devices_grouped.setdefault(tid, []).append(did)

        dev_real_kpi: dict[str, dict[str, Any]] = {}
        for type_id, dev_ids in devices_grouped.items():
            try:
                kpi_list = await self.get_dev_real_kpi(dev_ids, type_id)
                for kpi_item in (kpi_list or []):
                    if isinstance(kpi_item, dict):
                        dev_id = str(kpi_item.get("devId") or "")
                        if dev_id:
                            dev_real_kpi[dev_id] = kpi_item.get("dataItemMap") or {}
            except Exception as exc:
                log.debug("FusionSolar device KPI fetch failed for type %s: %s", type_id, exc)

        # Process devices into a clean structure
        devices: list[dict[str, Any]] = []
        for dev in devices_raw:
            if not isinstance(dev, dict):
                continue
            dev_id = str(dev.get("id") or "")
            type_id = dev.get("devTypeId")
            device_entry: dict[str, Any] = {
                "device_id": dev_id,
                "device_name": dev.get("devName") or dev_id,
                "station_code": dev.get("stationCode") or "",
                "esn_code": dev.get("esnCode") or "",
                "device_type_id": type_id,
                "device_type": _DEVICE_TYPES.get(type_id, f"Type {type_id}"),
                "software_version": dev.get("softwareVersion") or "",
                "latitude": _safe_float(dev.get("latitude")),
                "longitude": _safe_float(dev.get("longitude")),
            }
            if type_id in (1, 38):
                device_entry["inverter_type"] = dev.get("invType") or ""
            # Attach real-time KPI if available
            if dev_id in dev_real_kpi:
                device_entry["realtime_kpi"] = dev_real_kpi[dev_id]
            devices.append(device_entry)

        realtime_by_code = {
            item.get("stationCode"): item.get("dataItemMap") or {}
            for item in realtime_raw if isinstance(item, dict)
        }

        # Process yearly KPI: group by station, then by collectTime
        # Each entry has stationCode, collectTime (ms timestamp), dataItemMap
        yearly_by_station: dict[str, dict[int, dict[str, Any]]] = {}
        for item in yearly_raw:
            if not isinstance(item, dict):
                continue
            code = item.get("stationCode") or ""
            ct = item.get("collectTime") or 0
            dim = item.get("dataItemMap") or {}
            if code and dim:
                yearly_by_station.setdefault(code, {})[ct] = dim

        _KPI_FIELDS = [
            "installed_capacity", "radiation_intensity", "theory_power",
            "performance_ratio", "inverter_power", "ongrid_power",
            "use_power", "power_profit", "perpower_ratio",
            "reduction_total_co2", "reduction_total_coal", "reduction_total_tree",
        ]

        # Compute current year and lifetime per station
        yearly_current_by_code: dict[str, dict[str, Any]] = {}
        yearly_lifetime_by_code: dict[str, dict[str, Any]] = {}
        for code, years_dict in yearly_by_station.items():
            # Current year = latest collectTime
            if years_dict:
                latest_ct = max(years_dict.keys())
                latest_data = years_dict[latest_ct]
                current = {}
                for field in _KPI_FIELDS:
                    v = _safe_float(latest_data.get(field))
                    if v is not None:
                        current[field] = v
                current["collect_time"] = latest_ct
                yearly_current_by_code[code] = current

            # Lifetime = sum across all years
            lifetime: dict[str, float] = {}
            for _ct, data in years_dict.items():
                for field in _KPI_FIELDS:
                    v = _safe_float(data.get(field))
                    if v is not None:
                        lifetime[field] = lifetime.get(field, 0.0) + v
            yearly_lifetime_by_code[code] = lifetime

        realtime: list[dict[str, Any]] = []
        summary = {
            "station_count": len(stations),
            "realtime_power_kw": 0.0,
            "daily_energy_kwh": 0.0,
            "month_energy_kwh": 0.0,
            "yearly_energy_kwh": 0.0,
            "lifetime_energy_kwh": 0.0,
            "status": "offline",
        }
        for station in stations:
            code = station["station_code"]
            real = realtime_by_code.get(code, {})
            year_current = yearly_current_by_code.get(code, {})

            load_kw = _opt_float(
                real.get("loadPower") or real.get("load_power") or real.get("usePower") or real.get("use_power")
            )
            grid_kw = _opt_float(real.get("gridPower") or real.get("grid_power"))
            grid_import_kw = _opt_float(real.get("buyPower") or real.get("buy_power") or real.get("gridBuyPower"))
            grid_export_kw = _opt_float(real.get("sellPower") or real.get("sell_power") or real.get("gridSellPower"))
            if grid_export_kw is None:
                grid_export_kw = _opt_float(real.get("ongridPower") or real.get("ongrid_power"))

            station_data = {
                **station,
                "realtime_power_kw": _opt_float(real.get("realTimePower") or real.get("active_power")),
                "load_power_kw": load_kw,
                "grid_power_kw": grid_kw,
                "grid_import_power_kw": grid_import_kw,
                "grid_export_power_kw": grid_export_kw,
                "daily_energy_kwh": _opt_float(real.get("dailyEnergy") or real.get("day_power")),
                "month_energy_kwh": _opt_float(real.get("monthEnergy") or real.get("month_power")),
                "yearly_energy_kwh": _opt_float(real.get("yearEnergy") or year_current.get("inverter_power")),
                "lifetime_energy_kwh": _opt_float(real.get("cumulativeEnergy") or real.get("total_power")),
                # Plant-level injection/consumption in kWh come from yearly KPI or grid meter — not realtime power fields.
                "feed_in_energy_kwh": None,
                "consumption_kwh": None,
                "revenue": _opt_float(year_current.get("power_profit")),
                "status": "online",
            }
            realtime.append(station_data)
            _add_summary(summary, "realtime_power_kw", station_data["realtime_power_kw"])
            _add_summary(summary, "daily_energy_kwh", station_data["daily_energy_kwh"])
            _add_summary(summary, "month_energy_kwh", station_data["month_energy_kwh"])
            _add_summary(summary, "yearly_energy_kwh", station_data["yearly_energy_kwh"])
            _add_summary(summary, "lifetime_energy_kwh", station_data["lifetime_energy_kwh"])

        if stations:
            summary["status"] = "online"

        return {
            "stations": stations,
            "realtime": realtime,
            "yearly": yearly_raw,
            "yearly_current": yearly_current_by_code,
            "yearly_lifetime": yearly_lifetime_by_code,
            "devices": devices,
            "summary": summary,
        }

    async def fetch_realtime(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        """Refresh station KPIs only, reusing cached station/device metadata."""
        base = dict(cached or {})
        stations = list(base.get("stations") or [])
        station_codes = [s.get("station_code") for s in stations if s.get("station_code")]
        if not station_codes:
            return await self.fetch_all()
        await self.login()
        realtime_raw = await self.get_station_real_kpi(station_codes)
        realtime_by_code = {
            item.get("stationCode"): item.get("dataItemMap") or {}
            for item in realtime_raw if isinstance(item, dict)
        }
        yearly_current_by_code = base.get("yearly_current") or {}
        realtime: list[dict[str, Any]] = []
        summary = {
            "station_count": len(stations),
            "realtime_power_kw": 0.0,
            "daily_energy_kwh": 0.0,
            "month_energy_kwh": 0.0,
            "yearly_energy_kwh": 0.0,
            "lifetime_energy_kwh": 0.0,
            "status": "offline",
        }
        for station in stations:
            code = station.get("station_code")
            real = realtime_by_code.get(code, {})
            year_current = yearly_current_by_code.get(code, {}) if isinstance(yearly_current_by_code, dict) else {}
            station_data = {
                **station,
                "realtime_power_kw": _opt_float(real.get("realTimePower") or real.get("active_power")),
                "daily_energy_kwh": _opt_float(real.get("dailyEnergy") or real.get("day_power")),
                "month_energy_kwh": _opt_float(real.get("monthEnergy") or real.get("month_power")),
                "yearly_energy_kwh": _opt_float(real.get("yearEnergy") or year_current.get("inverter_power")),
                "lifetime_energy_kwh": _opt_float(real.get("cumulativeEnergy") or real.get("total_power")),
                "status": "online",
            }
            realtime.append(station_data)
            _add_summary(summary, "realtime_power_kw", station_data["realtime_power_kw"])
            _add_summary(summary, "daily_energy_kwh", station_data["daily_energy_kwh"])
            _add_summary(summary, "month_energy_kwh", station_data["month_energy_kwh"])
            _add_summary(summary, "yearly_energy_kwh", station_data["yearly_energy_kwh"])
            _add_summary(summary, "lifetime_energy_kwh", station_data["lifetime_energy_kwh"])
        if stations:
            summary["status"] = "online"
        base["realtime"] = realtime
        base["summary"] = summary
        return base

    async def test_connection(self) -> dict[str, Any]:
        await self.login()
        try:
            stations = await self.get_station_list()
        except FusionSolarError as exc:
            msg = str(exc)
            if "rate limit" in msg.lower():
                return {
                    "ok": True,
                    "message_key": "integrations.fusion_solar_rate_limit_stations_ok",
                    "message_params": {"detail": msg},
                    "station_count": 0,
                }
            raise
        return {
            "ok": True,
            "message_key": "integrations.fusion_solar_connected",
            "message_params": {"count": len(stations)},
            "station_count": len(stations),
        }

    def clear_cache(self):
        self._token = None
        self._cache.clear()
        self._blocked_until = 0.0


_client: Any | None = None


async def ensure_client() -> Any | None:
    global _client
    cfg = settings_mod.CFG.get("fusion_solar") or {}
    if not cfg.get("enabled"):
        return None

    mode = str(cfg.get("mode") or "auto").strip().lower()
    host = _normalize_host(cfg.get("host") or "https://eu5.fusionsolar.huawei.com")
    kiosk_url = str(cfg.get("kiosk_url") or "").strip()
    if not kiosk_url and "kk=" in host:
        kiosk_url = host
    username = (cfg.get("username") or "").strip()
    password = (cfg.get("password") or "").strip()

    wants_kiosk = mode == "kiosk" or (kiosk_url and (mode == "auto") and (not username or not password))
    if wants_kiosk:
        if not kiosk_url:
            return None
        if _client is None or not isinstance(_client, FusionSolarKioskClient) or _client._kiosk_url != kiosk_url:
            _client = FusionSolarKioskClient(kiosk_url)
        return _client

    if not username or not password:
        if kiosk_url:
            if _client is None or not isinstance(_client, FusionSolarKioskClient) or _client._kiosk_url != kiosk_url:
                _client = FusionSolarKioskClient(kiosk_url)
            return _client
        return None

    if _client is None or not isinstance(_client, FusionSolarClient) or _client._host != host.rstrip("/") or _client._username != username:
        _client = FusionSolarClient(host, username, password)
    return _client
