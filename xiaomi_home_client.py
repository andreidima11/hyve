"""Xiaomi Home (MIoT) cloud client — cloud-only control.

A self-contained async client for the official Xiaomi MIoT cloud API used by
the ``xiaomi/ha_xiaomi_home`` integration. It speaks the same HTTP endpoints
(OAuth2 + MIoT-Spec-V2 prop/get, prop/set, action) but is trimmed down to the
cloud control path Hyve needs — no LAN/MQTT central-gateway support.

The protocol constants and request shapes mirror upstream
``custom_components/xiaomi_home/miot/{const,miot_cloud}.py`` so the same
registered OAuth client works. Device capabilities are derived from the public
MIoT-Spec-V2 instance catalog (``miot-spec.org``) so we can map a device's
``siid``/``piid`` pairs to controllable Hyve entities without bundling specs.

Usage::

    # one-time, during config flow
    url = gen_auth_url("de")            # user logs in, gets redirected
    tokens = await exchange_code("de", code)

    # recurring sync / control
    async with XiaomiHomeClient("de", tokens["access_token"],
                                tokens["refresh_token"]) as client:
        payload = await client.fetch_all()
        await client.control_device(profile, "turn_on", {})
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any, Callable, Optional
from urllib.parse import urlencode

import aiohttp

log = logging.getLogger("xiaomi_home")

# ── protocol constants (mirror upstream const.py) ─────────────────────────
OAUTH2_CLIENT_ID = "2882303761520251711"
OAUTH2_AUTH_URL = "https://account.xiaomi.com/oauth2/authorize"
DEFAULT_OAUTH2_API_HOST = "ha.api.io.mi.com"
OAUTH_REDIRECT_URL = "http://homeassistant.local:8123"
DEFAULT_CLOUD_SERVER = "cn"
TOKEN_EXPIRES_TS_RATIO = 0.7
HTTP_TIMEOUT = 30
# Fixed device id: only the OAuth/exchange pair must agree on it, and the
# refresh call doesn't send it at all, so a stable value is safe and lets us
# present a single static auth URL in the config form.
DEVICE_UUID = "hyve"
DEVICE_ID = f"ha.{DEVICE_UUID}"

CLOUD_SERVERS: dict[str, str] = {
    "cn": "China (中国大陆)",
    "de": "Europe",
    "i2": "India",
    "ru": "Russia",
    "sg": "Singapore",
    "us": "United States",
}

UNSUPPORTED_MODELS = {
    "chuangmi.ir.v2",
    "era.airp.cwb03",
    "hmpace.motion.v6nfc",
    "k0918.toothbrush.t700",
}

SPEC_INSTANCE_URL = "https://miot-spec.org/miot-spec-v2/instance?type={urn}"

# ── MIoT-Spec-V2 → Hyve domain mapping ────────────────────────────────────
# Keyed by the device *category* (4th segment of the device urn).
CATEGORY_DOMAIN: dict[str, str] = {
    "light": "light",
    "light-bath-heater": "light",
    "switch": "switch",
    "outlet": "switch",
    "socket": "switch",
    "fan": "fan",
    "ceiling-fan": "fan",
    "air-purifier": "fan",
    "air-fresh": "fan",
    "air-conditioner": "climate",
    "air-condition-outlet": "climate",
    "heater": "climate",
    "thermostat": "climate",
    "curtain": "cover",
    "window-opener": "cover",
    "airer": "cover",
    "humidifier": "humidifier",
    "dehumidifier": "humidifier",
    "water-heater": "water_heater",
    "vacuum": "vacuum",
    "robot-cleaner": "vacuum",
    "lock": "lock",
    "magnet-sensor": "binary_sensor",
    "motion-sensor": "binary_sensor",
    "submersion-sensor": "binary_sensor",
    "gas-sensor": "binary_sensor",
    "smoke-sensor": "binary_sensor",
    "occupancy-sensor": "binary_sensor",
    "temperature-humidity-sensor": "sensor",
    "sensor": "sensor",
}

# Read-only properties surfaced as their own sensor entities.
READ_PROP_DOMAINS: dict[str, str] = {
    "temperature": "sensor",
    "relative-humidity": "sensor",
    "humidity": "sensor",
    "battery-level": "sensor",
    "illumination": "sensor",
    "pm2.5-density": "sensor",
    "co2-density": "sensor",
    "tvoc-density": "sensor",
    "voltage": "sensor",
    "electric-power": "sensor",
    "power-consumption": "sensor",
    "electric-current": "sensor",
    "water-level": "sensor",
    "target-temperature": "sensor",
    "contact-state": "binary_sensor",
    "occupancy-status": "binary_sensor",
    "motion-state": "binary_sensor",
    "submersion-state": "binary_sensor",
    "smoke-concentration": "sensor",
}

# Writable control properties recognised on the primary service.
CONTROL_PROPS = {
    "on",
    "brightness",
    "color-temperature",
    "color",
    "mode",
    "fan-level",
    "target-temperature",
    "target-humidity",
    "speed-level",
    "motor-control",
    "target-position",
}

# Read-only status properties used to derive a primary state (e.g. vacuum).
STATUS_PROPS = {
    "status",
    "device-status",
    "sweep-status",
    "working-status",
    "vacuum-status",
    "robot-cleaner-status",
}

# Per-property presentation metadata (device_class / unit / state_class),
# mirroring upstream ``SPEC_PROP_TRANS_MAP``. Used to enrich generic
# sensor/number entities derived from arbitrary MIoT properties.
PROP_META: dict[str, dict[str, str]] = {
    "battery-level": {"device_class": "battery", "unit": "%"},
    "temperature": {"device_class": "temperature", "unit": "°C"},
    "target-temperature": {"device_class": "temperature", "unit": "°C"},
    "relative-humidity": {"device_class": "humidity", "unit": "%"},
    "humidity": {"device_class": "humidity", "unit": "%"},
    "target-humidity": {"device_class": "humidity", "unit": "%"},
    "illumination": {"device_class": "illuminance", "unit": "lx"},
    "pm2.5-density": {"device_class": "pm25", "unit": "µg/m³"},
    "pm10-density": {"device_class": "pm10", "unit": "µg/m³"},
    "co2-density": {"device_class": "carbon_dioxide", "unit": "ppm"},
    "co-density": {"device_class": "carbon_monoxide", "unit": "ppm"},
    "tvoc-density": {"device_class": "volatile_organic_compounds", "unit": "µg/m³"},
    "voltage": {"device_class": "voltage", "unit": "V"},
    "electric-power": {"device_class": "power", "unit": "W"},
    "power-consumption": {"device_class": "energy", "unit": "kWh"},
    "electric-current": {"device_class": "current", "unit": "A"},
    "brightness": {"unit": "%"},
}


def _classify_prop(
    fmt: str | None, access: list[str], value_range: Any, value_list: Any
) -> Optional[str]:
    """Map a MIoT property to a Hyve platform using the HA general rule.

    Writable → switch (bool) / select (value-list) / number (value-range);
    read-only or notifiable → binary_sensor (bool) / sensor (else).
    Returns ``None`` for properties Hyve cannot represent (e.g. writable
    strings or writable props with neither a range nor a list).
    """
    writable = "write" in (access or [])
    readable = "read" in (access or []) or "notify" in (access or [])
    fmt = fmt or ""
    if writable:
        if fmt == "bool":
            return "switch"
        if value_list:
            return "select"
        if isinstance(value_range, list) and len(value_range) >= 2:
            return "number"
        return None
    if readable:
        if fmt == "bool":
            return "binary_sensor"
        return "sensor"
    return None


class XiaomiHomeError(Exception):
    """Generic Xiaomi Home cloud error."""


class XiaomiHomeAuthError(XiaomiHomeError):
    """Raised when the access/refresh token is rejected (401)."""


# ── module-level spec cache (shared across instances in this process) ─────
_SPEC_CACHE: dict[str, dict[str, Any]] = {}
_SPEC_LOCK = asyncio.Lock()


def _oauth_host(cloud_server: str) -> str:
    cs = (cloud_server or DEFAULT_CLOUD_SERVER).strip().lower()
    return DEFAULT_OAUTH2_API_HOST if cs == "cn" else f"{cs}.{DEFAULT_OAUTH2_API_HOST}"


def _api_host(cloud_server: str) -> str:
    return _oauth_host(cloud_server)


def _auth_state() -> str:
    return hashlib.sha1(f"d={DEVICE_ID}".encode("utf-8")).hexdigest()


def gen_auth_url(
    cloud_server: str = DEFAULT_CLOUD_SERVER,
    redirect_url: str = OAUTH_REDIRECT_URL,
    state: str | None = None,
) -> str:
    """Build the Xiaomi account OAuth2 authorization URL.

    The user opens this, signs in, and is redirected to ``redirect_url`` with
    a ``?code=…&state=…`` query. When Hyve hosts its own redirect-capture
    endpoint the user never has to copy anything — the browser lands back on
    Hyve which exchanges the code automatically.
    """
    del cloud_server  # auth URL host is always account.xiaomi.com
    params = {
        "redirect_uri": redirect_url,
        "client_id": int(OAUTH2_CLIENT_ID),
        "response_type": "code",
        "device_id": DEVICE_ID,
        "state": state or _auth_state(),
        "skip_confirm": "false",
    }
    return f"{OAUTH2_AUTH_URL}?{urlencode(params)}"


def parse_auth_code(raw: str) -> str:
    """Extract the OAuth ``code`` from either a bare code or a redirect URL."""
    text = (raw or "").strip()
    if not text:
        return ""
    if "code=" in text:
        from urllib.parse import parse_qs, urlparse

        parsed = urlparse(text)
        qs = parse_qs(parsed.query)
        code = qs.get("code", [""])[0]
        if code:
            return code.strip()
        # Fallback: split manually if it wasn't a well-formed URL.
        tail = text.split("code=", 1)[1]
        return tail.split("&", 1)[0].strip()
    return text


async def _oauth_get_token(cloud_server: str, data: dict[str, Any]) -> dict[str, Any]:
    host = _oauth_host(cloud_server)
    url = f"https://{host}/app/v2/ha/oauth/get_token"
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(
            url,
            params={"data": json.dumps(data)},
            headers={"content-type": "application/x-www-form-urlencoded"},
        ) as resp:
            if resp.status == 401:
                raise XiaomiHomeAuthError("Token Xiaomi respins (401). Reautentifică-te.")
            if resp.status != 200:
                raise XiaomiHomeError(f"OAuth get_token a eșuat (HTTP {resp.status}).")
            res_obj = json.loads(await resp.text())
    result = res_obj.get("result") if isinstance(res_obj, dict) else None
    if res_obj.get("code") != 0 or not isinstance(result, dict):
        raise XiaomiHomeError(f"Răspuns OAuth invalid: {res_obj}")
    for key in ("access_token", "refresh_token", "expires_in"):
        if key not in result:
            raise XiaomiHomeError(f"Răspuns OAuth incomplet (lipsește {key}).")
    expires_in = int(result.get("expires_in") or 0)
    return {
        "access_token": result["access_token"],
        "refresh_token": result["refresh_token"],
        "expires_in": expires_in,
        "expires_ts": int(time.time() + expires_in * TOKEN_EXPIRES_TS_RATIO),
    }


async def exchange_code(
    cloud_server: str,
    code: str,
    redirect_url: str = OAUTH_REDIRECT_URL,
) -> dict[str, Any]:
    """Exchange an authorization ``code`` for access/refresh tokens."""
    code = parse_auth_code(code)
    if not code:
        raise XiaomiHomeError("Cod de autorizare lipsă.")
    return await _oauth_get_token(
        cloud_server,
        {
            "client_id": int(OAUTH2_CLIENT_ID),
            "redirect_uri": redirect_url,
            "code": code,
            "device_id": DEVICE_ID,
        },
    )


async def refresh_tokens(
    cloud_server: str,
    refresh_token: str,
    redirect_url: str = OAUTH_REDIRECT_URL,
) -> dict[str, Any]:
    """Obtain a fresh access token using a stored ``refresh_token``."""
    if not refresh_token:
        raise XiaomiHomeError("refresh_token lipsă.")
    return await _oauth_get_token(
        cloud_server,
        {
            "client_id": int(OAUTH2_CLIENT_ID),
            "redirect_uri": redirect_url,
            "refresh_token": refresh_token,
        },
    )


def _spec_segment(urn: str, index: int) -> str:
    parts = (urn or "").split(":")
    return parts[index] if len(parts) > index else ""


def _prop_name(type_urn: str) -> str:
    # urn:miot-spec-v2:property:<name>:<...>
    return _spec_segment(type_urn, 3)


def parse_spec(instance: dict[str, Any]) -> dict[str, Any]:
    """Reduce a MIoT-Spec-V2 instance into the bits Hyve needs.

    Returns ``{"category", "domain", "controls": {prop: {...}}, "reads":
    [{...}], "actions": [{...}]}`` where ``controls`` maps a recognised
    writable property to its ``siid``/``piid`` plus value metadata.
    """
    urn = str(instance.get("type") or "")
    category = _spec_segment(urn, 3)
    controls: dict[str, dict[str, Any]] = {}
    reads: list[dict[str, Any]] = []
    props: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []

    for service in instance.get("services") or []:
        siid = service.get("iid")
        svc_name = _prop_name(service.get("type", ""))
        if svc_name == "device-information":
            continue
        for prop in service.get("properties") or []:
            piid = prop.get("iid")
            name = _prop_name(prop.get("type", ""))
            access = prop.get("access") or []
            fmt = prop.get("format")
            if siid is None or piid is None or not name:
                continue
            value_range = prop.get("value-range")
            value_list = {
                item.get("value"): item.get("description")
                for item in (prop.get("value-list") or [])
                if "value" in item
            } or None
            descriptor = {
                "siid": siid,
                "piid": piid,
                "prop": name,
                "service": svc_name,
                "access": list(access),
                "format": fmt,
                "unit": prop.get("unit"),
                "value_range": value_range,
                "value_list": value_list,
            }
            writable = "write" in access
            if writable and name in CONTROL_PROPS:
                # Keep the first occurrence of each control prop.
                controls.setdefault(name, descriptor)
            elif "read" in access and name in READ_PROP_DOMAINS:
                reads.append(descriptor)
            elif "read" in access and name in STATUS_PROPS:
                # Read-only status surfaced as the primary state (vacuum, etc.).
                controls.setdefault("status", descriptor)
            # Generic, HA-style classification of *every* usable property.
            platform = _classify_prop(fmt, access, value_range, value_list)
            if platform:
                props.append({**descriptor, "platform": platform})
        for act in service.get("actions") or []:
            aiid = act.get("iid")
            act_name = _prop_name(act.get("type", ""))
            if siid is None or aiid is None or not act_name:
                continue
            actions.append(
                {
                    "siid": siid,
                    "aiid": aiid,
                    "action": act_name,
                    "service": svc_name,
                    "has_in": bool(act.get("in")),
                }
            )

    domain = CATEGORY_DOMAIN.get(category)
    if not domain:
        domain = "switch" if "on" in controls else "sensor"
    return {
        "urn": urn,
        "category": category,
        "domain": domain,
        "controls": controls,
        "reads": reads,
        "props": props,
        "actions": actions,
    }


class XiaomiHomeClient:
    """Async MIoT cloud client (cloud-only control path)."""

    def __init__(
        self,
        cloud_server: str,
        access_token: str,
        refresh_token: str = "",
        *,
        expires_ts: int = 0,
        redirect_url: str = OAUTH_REDIRECT_URL,
        token_saver: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> None:
        self.cloud_server = (cloud_server or DEFAULT_CLOUD_SERVER).strip().lower()
        self.access_token = access_token or ""
        self.refresh_token = refresh_token or ""
        self.expires_ts = int(expires_ts or 0)
        self.redirect_url = redirect_url or OAUTH_REDIRECT_URL
        self._token_saver = token_saver
        self._host = _api_host(self.cloud_server)
        self._base_url = f"https://{self._host}"
        self._session: Optional[aiohttp.ClientSession] = None

    # ── lifecycle ─────────────────────────────────────────────────────
    async def __aenter__(self) -> "XiaomiHomeClient":
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
        )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    def _require_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            raise XiaomiHomeError("Clientul Xiaomi nu este inițializat (folosește async with).")
        return self._session

    @property
    def _headers(self) -> dict[str, str]:
        # NOTE: upstream sends ``Bearer<token>`` with no space — keep as-is.
        return {
            "Host": self._host,
            "X-Client-BizId": "haapi",
            "Content-Type": "application/json",
            "Authorization": f"Bearer{self.access_token}",
            "X-Client-AppId": OAUTH2_CLIENT_ID,
        }

    # ── token management ──────────────────────────────────────────────
    async def ensure_token(self) -> None:
        """Refresh the access token when it's near or past expiry."""
        if self.expires_ts and time.time() < self.expires_ts - 60:
            return
        if not self.refresh_token:
            return
        await self._do_refresh()

    async def _do_refresh(self) -> None:
        tokens = await refresh_tokens(
            self.cloud_server, self.refresh_token, self.redirect_url
        )
        self.access_token = tokens["access_token"]
        self.refresh_token = tokens["refresh_token"]
        self.expires_ts = tokens["expires_ts"]
        if self._token_saver:
            try:
                self._token_saver(tokens)
            except Exception as exc:  # pragma: no cover - best effort
                log.warning("xiaomi token_saver failed: %s", exc)

    # ── low-level HTTP ────────────────────────────────────────────────
    async def _post(self, path: str, data: dict[str, Any], *, _retry: bool = True) -> dict[str, Any]:
        session = self._require_session()
        async with session.post(
            f"{self._base_url}{path}", json=data, headers=self._headers
        ) as resp:
            if resp.status == 401:
                if _retry and self.refresh_token:
                    await self._do_refresh()
                    return await self._post(path, data, _retry=False)
                raise XiaomiHomeAuthError("Token Xiaomi invalid (401).")
            if resp.status != 200:
                raise XiaomiHomeError(f"{path} a eșuat (HTTP {resp.status}).")
            res_obj = json.loads(await resp.text())
        if res_obj.get("code") != 0:
            raise XiaomiHomeError(
                f"{path} cod {res_obj.get('code')}: {res_obj.get('message', '')}"
            )
        if "result" not in res_obj:
            raise XiaomiHomeError(f"{path}: răspuns fără 'result'.")
        return res_obj

    # ── device discovery ──────────────────────────────────────────────
    async def get_homeinfos(self) -> dict[str, Any]:
        res = await self._post(
            "/app/v2/homeroom/gethome",
            {
                "limit": 150,
                "fetch_share": True,
                "fetch_share_dev": True,
                "plat_form": 0,
                "app_ver": 9,
            },
        )
        result = res["result"]
        uid = None
        for home in result.get("homelist", []) or []:
            if "uid" in home:
                uid = str(home["uid"])
                break
        return {"uid": uid, "result": result}

    async def get_device_pages(self) -> list[dict[str, Any]]:
        """Page through ``device_list_page`` and return the raw device dicts."""
        devices: list[dict[str, Any]] = []
        start_did: Optional[str] = None
        # Guard against pathological pagination loops.
        for _ in range(50):
            req: dict[str, Any] = {
                "limit": 200,
                "get_split_device": True,
                "get_third_device": True,
                "dids": [],
            }
            if start_did:
                req["start_did"] = start_did
            res = await self._post("/app/v2/home/device_list_page", req)
            result = res["result"]
            for dev in result.get("list", []) or []:
                if dev.get("did") and dev.get("model") not in UNSUPPORTED_MODELS:
                    devices.append(dev)
            start_did = result.get("next_start_did")
            if not (result.get("has_more") and start_did):
                break
        return devices

    # ── spec resolution ───────────────────────────────────────────────
    async def get_spec(self, urn: str) -> dict[str, Any]:
        """Fetch & parse a device's MIoT-Spec-V2 instance (cached by urn)."""
        if not urn:
            return {}
        async with _SPEC_LOCK:
            cached = _SPEC_CACHE.get(urn)
        if cached is not None:
            return cached
        session = self._require_session()
        try:
            async with session.get(SPEC_INSTANCE_URL.format(urn=urn)) as resp:
                if resp.status != 200:
                    raise XiaomiHomeError(f"spec HTTP {resp.status}")
                instance = json.loads(await resp.text())
            parsed = parse_spec(instance)
        except Exception as exc:
            log.debug("xiaomi spec fetch failed for %s: %s", urn, exc)
            parsed = {}
        async with _SPEC_LOCK:
            _SPEC_CACHE[urn] = parsed
        return parsed

    # ── property get/set + action ─────────────────────────────────────
    async def get_props(self, params: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not params:
            return []
        out: list[dict[str, Any]] = []
        # The cloud caps batch size; chunk conservatively.
        for i in range(0, len(params), 100):
            chunk = params[i : i + 100]
            res = await self._post(
                "/app/v2/miotspec/prop/get",
                {"datasource": 1, "params": chunk},
            )
            out.extend(res["result"] or [])
        return out

    async def set_props(self, params: list[dict[str, Any]]) -> list[dict[str, Any]]:
        res = await self._post("/app/v2/miotspec/prop/set", {"params": params})
        return res["result"] or []

    async def action(
        self, did: str, siid: int, aiid: int, in_list: Optional[list[Any]] = None
    ) -> Any:
        res = await self._post(
            "/app/v2/miotspec/action",
            {"params": {"did": did, "siid": siid, "aiid": aiid, "in": in_list or []}},
        )
        return res["result"]

    # ── high-level sync ───────────────────────────────────────────────
    async def fetch_all(self) -> dict[str, Any]:
        """Discover devices, resolve specs, and read current property values.

        Returns ``{"uid", "devices": [...], "profiles": {did: profile}}`` where
        each ``profile`` carries the spec-derived control/read maps plus the
        latest property values, ready for ``extract_entities``.
        """
        await self.ensure_token()
        home = await self.get_homeinfos()
        raw_devices = await self.get_device_pages()

        # Resolve specs (deduplicated by urn) in parallel.
        urns = {d.get("spec_type") for d in raw_devices if d.get("spec_type")}
        specs: dict[str, dict[str, Any]] = {}
        results = await asyncio.gather(
            *(self.get_spec(u) for u in urns), return_exceptions=True
        )
        for urn, parsed in zip(urns, results):
            specs[urn] = parsed if isinstance(parsed, dict) else {}

        profiles: dict[str, dict[str, Any]] = {}
        read_params: list[dict[str, Any]] = []
        for dev in raw_devices:
            did = str(dev.get("did"))
            urn = dev.get("spec_type") or ""
            spec = specs.get(urn) or {}
            controls = spec.get("controls") or {}
            reads = spec.get("reads") or []
            props = spec.get("props") or []
            profile = {
                "did": did,
                "name": dev.get("name") or did,
                "model": dev.get("model") or "",
                "urn": urn,
                "online": bool(dev.get("isOnline")),
                "domain": spec.get("domain") or ("switch" if "on" in controls else "sensor"),
                "controls": controls,
                "reads": reads,
                "props": props,
                "actions": spec.get("actions") or [],
                "values": {},
            }
            profiles[did] = profile
            # Queue a prop/get for every readable property (HA reads them all).
            queued: set[tuple[int, int]] = set()
            for desc in props:
                access = desc.get("access") or []
                if "read" not in access and "notify" not in access:
                    continue
                key = (desc["siid"], desc["piid"])
                if key not in queued:
                    read_params.append({"did": did, "siid": desc["siid"], "piid": desc["piid"]})
                    queued.add(key)
            # Ensure on-state and read/status descriptors are covered even if
            # they were filtered out of ``props`` (e.g. write-only ``on``).
            for desc in [controls.get("on"), controls.get("status"), *reads]:
                if not desc:
                    continue
                key = (desc["siid"], desc["piid"])
                if key not in queued:
                    read_params.append({"did": did, "siid": desc["siid"], "piid": desc["piid"]})
                    queued.add(key)

        if read_params:
            try:
                values = await self.get_props(read_params)
            except XiaomiHomeError as exc:
                log.debug("xiaomi get_props failed: %s", exc)
                values = []
            for item in values:
                did = str(item.get("did"))
                if did in profiles and item.get("code") in (0, None):
                    key = f"{item.get('siid')}.{item.get('piid')}"
                    profiles[did]["values"][key] = item.get("value")

        return {
            "uid": home.get("uid"),
            "cloud_server": self.cloud_server,
            "devices": raw_devices,
            "profiles": profiles,
        }

    # ── control ───────────────────────────────────────────────────────
    async def control_device(
        self,
        profile: dict[str, Any],
        action: str,
        data: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Apply a control ``action`` to a device using its stored profile."""
        await self.ensure_token()
        data = data or {}
        did = str(profile.get("did"))
        controls = profile.get("controls") or {}
        sets: list[dict[str, Any]] = []

        def _ctrl(name: str) -> Optional[dict[str, Any]]:
            return controls.get(name)

        act = (action or "").strip().lower()
        on = _ctrl("on")

        # Friendly remap: "turn on/off the vacuum" has no on/off property on
        # robot cleaners — translate to the proper MIoT start/dock actions so
        # the natural command still works.
        if act in ("turn_on", "turn_off", "toggle") and not on:
            domain = str(profile.get("domain") or "").lower()
            has_vacuum_actions = _match_action(
                profile.get("actions") or [],
                _VACUUM_ACTION_ALIASES["start"] + _VACUUM_ACTION_ALIASES["dock"],
            ) is not None
            if domain == "vacuum" or has_vacuum_actions:
                act = "start" if act == "turn_on" else "dock"

        # Action-based commands (vacuum start/pause/dock, etc.) invoke a MIoT
        # action rather than setting a property.
        if act in _VACUUM_ACTION_ALIASES:
            actions = profile.get("actions") or []
            found = _match_action(actions, _VACUUM_ACTION_ALIASES[act])
            if not found:
                raise XiaomiHomeError(f"Acțiune nesuportată de acest dispozitiv: {action}")
            res = await self.action(did, found["siid"], found["aiid"], [])
            return {"status": "ok", "result": res, "action": found.get("action")}

        if act in ("turn_on", "turn_off", "toggle"):
            if not on:
                raise XiaomiHomeError("Acest dispozitiv nu suportă pornire/oprire.")
            if act == "toggle":
                current = None
                try:
                    res = await self.get_props(
                        [{"did": did, "siid": on["siid"], "piid": on["piid"]}]
                    )
                    if res:
                        current = res[0].get("value")
                except XiaomiHomeError:
                    current = None
                value = not bool(current)
            else:
                value = act == "turn_on"
            sets.append({"did": did, "siid": on["siid"], "piid": on["piid"], "value": value})

        elif act in ("set", "set_state"):
            # Optional implicit power-on when a value is being set.
            if data.get("state") is not None and on:
                sets.append(
                    {"did": did, "siid": on["siid"], "piid": on["piid"], "value": bool(data["state"])}
                )
            _append_numeric(sets, did, _ctrl("brightness"), data.get("brightness"))
            _append_numeric(sets, did, _ctrl("color-temperature"), data.get("color_temp") or data.get("color_temperature"))
            _append_numeric(sets, did, _ctrl("target-temperature"), data.get("temperature") or data.get("target_temperature"))
            _append_numeric(sets, did, _ctrl("target-humidity"), data.get("humidity") or data.get("target_humidity"))
            _append_numeric(sets, did, _ctrl("fan-level"), data.get("fan_level") or data.get("fan_speed"))
            _append_numeric(sets, did, _ctrl("speed-level"), data.get("speed"))
            _append_numeric(sets, did, _ctrl("mode"), data.get("mode"))
            _append_numeric(sets, did, _ctrl("target-position"), data.get("position"))
            if not sets:
                raise XiaomiHomeError("Comandă 'set' fără parametri recunoscuți.")
        else:
            raise XiaomiHomeError(f"Acțiune nesuportată: {action}")

        result = await self.set_props(sets)
        return {"status": "ok", "result": result, "applied": sets}

    async def control_property(
        self,
        did: str,
        prop: dict[str, Any],
        action: str,
        data: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Set a single MIoT property (generic per-entity control).

        ``action`` is one of ``turn_on`` / ``turn_off`` / ``toggle`` (bool
        props) or ``set`` (any writable prop, value taken from
        ``data['value']``). Values are coerced/clamped to the spec.
        """
        await self.ensure_token()
        data = data or {}
        did = str(did)
        siid, piid = prop["siid"], prop["piid"]
        fmt = prop.get("format") or ""
        act = (action or "").strip().lower()

        if act == "toggle":
            current = None
            try:
                res = await self.get_props([{"did": did, "siid": siid, "piid": piid}])
                if res:
                    current = res[0].get("value")
            except XiaomiHomeError:
                current = None
            value: Any = not bool(current)
        elif act == "turn_on":
            value = True
        elif act == "turn_off":
            value = False
        elif act in ("set", "set_state"):
            value = data.get("value")
            if value is None:
                raise XiaomiHomeError("Comandă 'set' fără 'value'.")
        else:
            raise XiaomiHomeError(f"Acțiune nesuportată: {action}")

        sets: list[dict[str, Any]] = []
        if fmt == "bool" and act in ("set", "set_state"):
            sets.append({"did": did, "siid": siid, "piid": piid, "value": bool(value)})
        elif fmt == "bool":
            sets.append({"did": did, "siid": siid, "piid": piid, "value": bool(value)})
        else:
            _append_numeric(sets, did, prop, value)
            if not sets:
                # Non-numeric (e.g. enum stored as raw value, or string) — pass
                # through after a best-effort int coercion for value-list props.
                coerced = value
                if prop.get("value_list") is not None:
                    try:
                        coerced = int(value)
                    except (TypeError, ValueError):
                        coerced = value
                sets.append({"did": did, "siid": siid, "piid": piid, "value": coerced})

        result = await self.set_props(sets)
        return {"status": "ok", "result": result, "applied": sets}

    async def test_connection(self) -> dict[str, Any]:
        await self.ensure_token()
        devices = await self.get_device_pages()
        return {"ok": True, "message": f"Conexiune OK ({len(devices)} dispozitive)."}


# Generic vacuum/robot-cleaner commands → candidate MIoT action names. The
# first action whose name matches (exactly, then by substring) is invoked.
_VACUUM_ACTION_ALIASES: dict[str, tuple[str, ...]] = {
    "start": ("start-sweep", "start-clean", "start-sweeping", "start-room-sweep", "start"),
    "start_clean": ("start-sweep", "start-clean", "start-sweeping", "start-room-sweep", "start"),
    "clean": ("start-sweep", "start-clean", "start-sweeping", "start"),
    "resume": ("continue-sweep", "resume-clean", "start-sweep", "start-clean"),
    "pause": ("pause-sweeping", "pause-clean", "pause"),
    "stop": ("stop-sweeping", "stop-clean", "stop-sweep", "stop"),
    "return_to_base": ("start-charge", "start-charging", "stop-and-gocharge", "set-charge", "charge"),
    "dock": ("start-charge", "start-charging", "stop-and-gocharge", "set-charge", "charge"),
    "locate": ("find-device", "identify", "locate-robot", "find"),
}


def _match_action(
    actions: list[dict[str, Any]], candidates: tuple[str, ...]
) -> Optional[dict[str, Any]]:
    """Pick the first action matching a candidate name (exact, then substring)."""
    for cand in candidates:
        for a in actions:
            if (a.get("action") or "") == cand:
                return a
    for cand in candidates:
        for a in actions:
            if cand in (a.get("action") or ""):
                return a
    return None


def _append_numeric(
    sets: list[dict[str, Any]],
    did: str,
    descriptor: Optional[dict[str, Any]],
    value: Any,
) -> None:
    """Append a prop/set entry, coercing & clamping ``value`` to the spec."""
    if descriptor is None or value is None:
        return
    fmt = descriptor.get("format") or ""
    try:
        if fmt in ("bool",):
            coerced: Any = bool(value)
        elif fmt in ("float",):
            coerced = float(value)
        elif fmt.startswith("uint") or fmt.startswith("int"):
            coerced = int(round(float(value)))
        else:
            coerced = value
    except (TypeError, ValueError):
        return
    rng = descriptor.get("value_range")
    if isinstance(rng, list) and len(rng) >= 2 and isinstance(coerced, (int, float)):
        lo, hi = rng[0], rng[1]
        coerced = max(lo, min(hi, coerced))
    sets.append(
        {
            "did": did,
            "siid": descriptor["siid"],
            "piid": descriptor["piid"],
            "value": coerced,
        }
    )
