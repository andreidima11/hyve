"""Frigate NVR integration.

The Home Assistant Frigate integration exposes more than the camera stream:
    camera devices, Birdseye, snapshot images, FPS/status telemetry, object
occupancy/count entities, camera feature switches, config numbers and update
metadata. Hyve mirrors the HTTP-observable part of that entity surface from
Frigate's ``/api/config`` and ``/api/stats`` endpoints.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_frigate_candidates = _extract_mod.extract_frigate_candidates
_as_bool = _extract_mod._as_bool

log = logging.getLogger("integrations.frigate")

_TIMEOUT = 8.0


class FrigateEntity(BaseEntity):
    slug = "frigate"
    label = "Frigate NVR"
    description = "Sistem de supraveghere video NVR cu detecție AI de obiecte, persoane și mișcare pe camerele IP."
    icon = "fa-shield-halved"
    color = "text-indigo-300"
    scan_interval_seconds = 300
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "host", "label": "Host Frigate", "type": "text", "required": True, "default": "localhost"},
        {"key": "port", "label": "Port HTTP", "type": "number", "default": 5000, "min": 1, "max": 65535,
         "help": "5000 = port intern fără auth. 8971 = proxy autentificat HTTPS (necesită user/parolă)."},
        {"key": "rtsp_port", "label": "Port RTSP restream", "type": "number", "default": 8554, "min": 1, "max": 65535},
        {"key": "username", "label": "Utilizator (pt. port 8971)", "type": "text"},
        {"key": "password", "label": "Parolă", "type": "password", "secret": True},
        {"key": "api_key", "label": "API key (alternativ la user/parolă)", "type": "password", "secret": True},
        {"key": "scheme", "label": "Schemă", "type": "select", "default": "auto",
         "options": [
             {"value": "auto", "label": "auto (https pe 8971, altfel http)"},
             {"value": "http", "label": "http"},
             {"value": "https", "label": "https"},
         ]},
        {"key": "verify_tls", "label": "Verifică certificat TLS", "type": "boolean", "default": False},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 300, "min": 60},
    ]

    @staticmethod
    def _resolve_scheme(data: dict[str, Any]) -> str:
        scheme = str((data or {}).get("scheme") or "auto").strip().lower() or "auto"
        if scheme in ("http", "https"):
            return scheme
        port = int((data or {}).get("port") or 5000)
        return "https" if port in (8971, 443) else "http"

    def _base_url(self) -> str:
        section = self.entry_data or {}
        scheme = self._resolve_scheme(section)
        host = str(section.get("host") or "localhost").strip() or "localhost"
        port = int(section.get("port") or 5000)
        return f"{scheme}://{host}:{port}"

    def _headers(self) -> dict[str, str]:
        api_key = str((self.entry_data or {}).get("api_key") or "").strip()
        return {"X-API-KEY": api_key} if api_key else {}

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool((section.get("host") or "").strip())

    @staticmethod
    async def _login(client: httpx.AsyncClient, base: str, user: str, password: str) -> None:
        """POST /api/login to populate the frigate_token cookie on the client."""
        resp = await client.post(
            f"{base}/api/login",
            json={"user": user, "password": password},
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"login Frigate eșuat (HTTP {resp.status_code}) — verifică user/parolă"
            )

    @classmethod
    def _build_client_kwargs(cls, data: dict[str, Any]) -> dict[str, Any]:
        api_key = str((data or {}).get("api_key") or "").strip()
        verify = _as_bool((data or {}).get("verify_tls"), False)
        headers = {"X-API-KEY": api_key} if api_key else {}
        return {"timeout": _TIMEOUT, "headers": headers, "verify": verify, "follow_redirects": True}

    @classmethod
    def _base_from_data(cls, data: dict[str, Any]) -> str:
        scheme = cls._resolve_scheme(data)
        host = str((data or {}).get("host") or "localhost").strip() or "localhost"
        port = int((data or {}).get("port") or 5000)
        return f"{scheme}://{host}:{port}"

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        base = cls._base_from_data(data)
        user = str((data or {}).get("username") or "").strip()
        password = str((data or {}).get("password") or "")
        try:
            payload = await cls._fetch_config(base, user, password, data)
        except Exception as exc:
            return {"ok": False, "message": f"Conexiune Frigate eșuată: {exc}"}
        cams = (payload or {}).get("cameras") or {}
        return {"ok": True, "message": f"Conectat la Frigate ({len(cams)} camere)."}

    @classmethod
    async def _fetch_config(cls, base: str, user: str, password: str, data: dict[str, Any]) -> dict[str, Any]:
        """Fetch /api/config with login + auto-fallback to verify=False on self-signed certs."""
        attempts: list[dict[str, Any]] = [data]
        if base.startswith("https://") and _as_bool((data or {}).get("verify_tls"), False):
            attempts.append({**data, "verify_tls": False})
        last_exc: Exception | None = None
        for attempt_data in attempts:
            try:
                async with httpx.AsyncClient(**cls._build_client_kwargs(attempt_data)) as client:
                    if user and password:
                        await cls._login(client, base, user, password)
                    resp = await client.get(f"{base}/api/config")
                    if resp.status_code in (400, 401, 403):
                        raise RuntimeError(
                            f"HTTP {resp.status_code} — verifică user/parolă "
                            f"(sau folosește portul intern 5000 fără auth)."
                        )
                    resp.raise_for_status()
                    return resp.json() or {}
            except Exception as exc:
                msg = str(exc).lower()
                if "certificate" in msg or "ssl" in msg or "self-signed" in msg or "self signed" in msg:
                    last_exc = exc
                    continue
                raise
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("nu s-a putut contacta Frigate")

    @classmethod
    async def _fetch_optional_json(
        cls,
        client: httpx.AsyncClient,
        base: str,
        path: str,
        fallback: Any,
    ) -> Any:
        try:
            resp = await client.get(f"{base}{path}")
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type.lower():
                return resp.json()
            text = resp.text.strip()
            return text if text else fallback
        except Exception as exc:
            log.debug("optional Frigate endpoint %s failed: %s", path, exc)
            return fallback

    @classmethod
    async def _fetch_api_payload(cls, base: str, user: str, password: str, data: dict[str, Any]) -> dict[str, Any]:
        attempts: list[dict[str, Any]] = [data]
        if base.startswith("https://") and _as_bool((data or {}).get("verify_tls"), False):
            attempts.append({**data, "verify_tls": False})
        last_exc: Exception | None = None
        for attempt_data in attempts:
            try:
                async with httpx.AsyncClient(**cls._build_client_kwargs(attempt_data)) as client:
                    if user and password:
                        await cls._login(client, base, user, password)
                    config_resp = await client.get(f"{base}/api/config")
                    if config_resp.status_code in (400, 401, 403):
                        raise RuntimeError(
                            f"HTTP {config_resp.status_code} — verifică user/parolă "
                            f"(sau folosește portul intern 5000 fără auth)."
                        )
                    config_resp.raise_for_status()
                    config = config_resp.json() or {}
                    stats = await cls._fetch_optional_json(client, base, "/api/stats", {})
                    version = await cls._fetch_optional_json(client, base, "/api/version", "")
                    go2rtc_streams = await cls._fetch_optional_json(client, base, "/api/go2rtc/streams", {})
                    return {
                        "config": config,
                        "stats": stats if isinstance(stats, dict) else {},
                        "version": version,
                        "go2rtc_streams": go2rtc_streams if isinstance(go2rtc_streams, dict) else {},
                    }
            except Exception as exc:
                msg = str(exc).lower()
                if "certificate" in msg or "ssl" in msg or "self-signed" in msg or "self signed" in msg:
                    last_exc = exc
                    continue
                raise
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("nu s-a putut contacta Frigate")

    async def fetch_entities(self) -> dict[str, Any]:
        section = self.entry_data or {}
        base = self._base_url()
        user = str(section.get("username") or "").strip()
        password = str(section.get("password") or "")
        try:
            return await self._fetch_api_payload(base, user, password, section)
        except Exception as exc:
            from logger import log_line
            reason = str(exc).split("\n")[0]
            if len(reason) > 100:
                reason = reason[:97] + "..."
            log_line("error", "📷", "FRIGATE", f"fetch failed — {reason}")
            return {}

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_frigate_candidates(
            payload,
            entry_data=self.entry_data or {},
            base_url=self._base_url(),
        )

    def format_context(self, entities: dict[str, Any]) -> str:
        items = self.extract_entities(entities)
        if not items:
            return ""
        return f"Frigate: {len(items)} camere disponibile."
