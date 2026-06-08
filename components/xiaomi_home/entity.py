"""Xiaomi Home (MIoT cloud) integration provider.

Surfaces devices from a Xiaomi / Mi Home account in Hyve's unified entity
catalog and lets them be controlled through the official MIoT cloud API —
the same API used by ``xiaomi/ha_xiaomi_home``. Scope is **cloud-only**
control (no LAN / MQTT central gateway).

Config flow (form-based, self-serve): the user picks their cloud region and
opens Xiaomi's OAuth2 sign-in via the **Autentifică-te la Xiaomi** link. After
signing in, Xiaomi redirects to ``homeassistant.local:8123`` — the **only**
redirect host Xiaomi's public OAuth client accepts (every other host is
rejected with "invalid redirect uri"). That page won't load for the user; they
simply copy the resulting address (which contains ``?code=…``) back into the
form. The code is exchanged for tokens exactly once on Save and stored on the
entry; tokens are refreshed transparently on every sync.
"""
from __future__ import annotations

import logging
from typing import Any

import xiaomi_home_client as xh
from integrations.base import BaseEntity

from pathlib import Path
from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_xiaomi_home_candidates = _extract_mod.extract_xiaomi_home_candidates

log = logging.getLogger("xiaomi_home")

_AUTH_HELP = (
    "Apasă „Autentifică-te la Xiaomi”, conectează-te, apoi vei fi trimis către "
    "o adresă care NU se încarcă (homeassistant.local) — e normal și impus de "
    "Xiaomi. Copiază TOATĂ adresa din bara browserului (conține ?code=…) și "
    "lipește-o mai jos."
)


class XiaomiHomeEntity(BaseEntity):
    slug = "xiaomi_home"
    label = "Xiaomi Home"
    description = "Dispozitive Xiaomi/Mi Home — becuri, senzori, prize, purificatoare aer și alte gadgeturi smart Xiaomi."
    icon = "fa-house-signal"
    color = "text-orange-400"
    scan_interval_seconds = 60
    uses_refresh_layers = True
    probe_interval_cycles = 12
    SUPPORTS_MULTIPLE = True  # one entry per Xiaomi account / region

    CONFIG_SCHEMA = [
        {
            "key": "cloud_server",
            "label": "Regiune cloud",
            "type": "select",
            "default": "de",
            "options": [
                {"value": code, "label": name}
                for code, name in xh.CLOUD_SERVERS.items()
            ],
            "help": "Alege regiunea contului Xiaomi (Europe pentru România).",
        },
        {
            "key": "_auth_link",
            "label": "1. Autentifică-te la Xiaomi",
            "type": "link",
            "url": xh.gen_auth_url(),
            "help": "Se deschide pagina de login Xiaomi într-o filă nouă.",
        },
        {
            "key": "auth_code",
            "label": "2. Lipește adresa de redirecționare",
            "type": "text",
            "placeholder": "http://homeassistant.local:8123/?code=…",
            "help": _AUTH_HELP,
        },
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 60, "min": 30},
    ]

    # ── config flow ───────────────────────────────────────────────────
    @classmethod
    async def async_validate_entry(cls, data: dict[str, Any]) -> dict[str, Any]:
        """Exchange the pasted auth code for tokens and stash them on the entry.

        Mutates ``data`` in place — the same dict is handed to
        ``config_entries.create_entry``, so the injected ``_oauth`` block is
        persisted. The transient ``auth_code`` is cleared afterwards so the
        single-use code can't be exchanged twice.
        """
        cloud_server = str(data.get("cloud_server") or xh.DEFAULT_CLOUD_SERVER).strip().lower()
        raw_code = str(data.get("auth_code") or "").strip()
        # Allow re-saving an already-authenticated entry without a new code.
        if not raw_code and data.get("_oauth", {}).get("refresh_token"):
            return {"ok": True, "title": str(data.get("_title") or cls.label)}
        if not raw_code:
            return {"ok": False, "errors": {"auth_code": "Lipsește adresa/codul de redirecționare."}}
        try:
            tokens = await xh.exchange_code(cloud_server, raw_code)
        except xh.XiaomiHomeError as exc:
            return {"ok": False, "errors": {"auth_code": str(exc)}}

        data["_oauth"] = {
            "access_token": tokens["access_token"],
            "refresh_token": tokens["refresh_token"],
            "expires_ts": tokens["expires_ts"],
            "cloud_server": cloud_server,
        }
        data["auth_code"] = ""  # don't persist / reuse the one-time code

        title = cls.label
        try:
            client = cls._build_client(data)
            async with client:
                home = await client.get_homeinfos()
                if home.get("uid"):
                    title = f"Xiaomi Home ({home['uid']})"
        except Exception as exc:  # pragma: no cover - title is best-effort
            log.debug("xiaomi home info during validate failed: %s", exc)
        data["_title"] = title
        return {"ok": True, "title": title}

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        # The OAuth code is single-use, so we must NOT exchange it here — that
        # would consume it and make the subsequent Save fail (error 96013).
        # Only test connectivity when the entry is already authenticated.
        oauth = (data or {}).get("_oauth") or {}
        if not oauth.get("access_token"):
            if str((data or {}).get("auth_code") or "").strip():
                return {"ok": True, "message_key": "integrations.xiaomi_code_detected"}
            return {"ok": False, "message_key": "integrations.xiaomi_auth_redirect"}
        try:
            client = cls._build_client(data)
            async with client:
                return await client.test_connection()
        except xh.XiaomiHomeError as exc:
            return {"ok": False, "message": str(exc)}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or None, "message_key": "integrations.xiaomi_failed"}

    # ── helpers ───────────────────────────────────────────────────────
    @classmethod
    def _build_client(
        cls,
        data: dict[str, Any],
        *,
        token_saver=None,
    ) -> xh.XiaomiHomeClient:
        oauth = (data or {}).get("_oauth") or {}
        cloud_server = str(
            oauth.get("cloud_server") or data.get("cloud_server") or xh.DEFAULT_CLOUD_SERVER
        ).strip().lower()
        return xh.XiaomiHomeClient(
            cloud_server=cloud_server,
            access_token=str(oauth.get("access_token") or ""),
            refresh_token=str(oauth.get("refresh_token") or ""),
            expires_ts=int(oauth.get("expires_ts") or 0),
            token_saver=token_saver,
        )

    def _make_token_saver(self):
        """Persist refreshed OAuth tokens back onto the config entry."""
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return None

        def _persist(tokens: dict[str, Any]) -> None:
            try:
                from integrations import config_entries as _ce
            except Exception as exc:  # pragma: no cover - import guard
                log.debug("xiaomi token persist skipped: %s", exc)
                return
            try:
                existing = _ce.get_entry(entry_id) or {}
                oauth = dict((existing.get("data") or {}).get("_oauth") or {})
                oauth.update(
                    {
                        "access_token": tokens.get("access_token"),
                        "refresh_token": tokens.get("refresh_token"),
                        "expires_ts": tokens.get("expires_ts"),
                    }
                )
                _ce.update_entry(entry_id, data={"_oauth": oauth}, schema=self.get_config_schema())
                self.entry_data["_oauth"] = oauth
                log.info("xiaomi_home %s: refreshed OAuth token", entry_id[:8])
            except Exception as exc:
                log.warning("xiaomi token persist failed: %s", exc)

        return _persist

    def _persist_profiles(self, profiles: dict[str, Any]) -> None:
        """Cache spec-derived control maps so stateless control_entity works."""
        entry_id = self.entry_id
        if not entry_id or entry_id == "__test__":
            return
        # Strip live values — we only need the control/read maps for routing.
        compact = {
            did: {
                "did": p.get("did"),
                "name": p.get("name"),
                "model": p.get("model"),
                "domain": p.get("domain"),
                "controls": p.get("controls"),
                "props": p.get("props"),
                "actions": p.get("actions"),
            }
            for did, p in (profiles or {}).items()
        }
        try:
            from integrations import config_entries as _ce

            if (self.entry_data.get("_profiles") or {}) != compact:
                _ce.update_entry(entry_id, data={"_profiles": compact}, schema=self.get_config_schema())
            self.entry_data["_profiles"] = compact
        except Exception as exc:
            log.debug("xiaomi profile persist skipped: %s", exc)

    # ── BaseEntity overrides ──────────────────────────────────────────
    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return bool((section.get("_oauth") or {}).get("refresh_token"))

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self) -> dict[str, Any]:
        client = self._build_client(self.entry_data or {}, token_saver=self._make_token_saver())
        async with client:
            payload = await client.fetch_all()
        self._persist_profiles(payload.get("profiles") or {})
        return payload

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        client = self._build_client(self.entry_data or {}, token_saver=self._make_token_saver())
        async with client:
            return await client.fetch_live(cached)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_xiaomi_home_candidates(payload)

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        # unique_id forms:
        #   ``xiaomi_home:{did}``              → primary device entity
        #   ``xiaomi_home:{did}:p:{siid}:{piid}`` → single property control
        #   ``xiaomi_home:{did}:a:{siid}:{aiid}`` → invoke a MIoT action
        parts = str(entity_id).split(":")
        if len(parts) < 2 or parts[0] != self.slug:
            raise ValueError(f"entity_id Xiaomi invalid: {entity_id}")
        did = parts[1]
        profiles = self.entry_data.get("_profiles") or {}
        profile = profiles.get(did)
        if not profile:
            raise ValueError(f"Dispozitiv Xiaomi necunoscut: {did}")
        client = self._build_client(self.entry_data or {}, token_saver=self._make_token_saver())

        # Per-property control: ``…:p:{siid}:{piid}``.
        if len(parts) >= 5 and parts[2] == "p":
            try:
                siid, piid = int(parts[3]), int(parts[4])
            except ValueError as exc:
                raise ValueError(f"entity_id Xiaomi invalid: {entity_id}") from exc
            prop = next(
                (
                    p
                    for p in (profile.get("props") or [])
                    if p.get("siid") == siid and p.get("piid") == piid
                ),
                None,
            )
            if prop is None:
                raise ValueError(f"Proprietate Xiaomi necunoscută: {siid}.{piid}")
            async with client:
                return await client.control_property(did, prop, action, data or {})

        # Per-action button: ``…:a:{siid}:{aiid}``.
        if len(parts) >= 5 and parts[2] == "a":
            try:
                siid, aiid = int(parts[3]), int(parts[4])
            except ValueError as exc:
                raise ValueError(f"entity_id Xiaomi invalid: {entity_id}") from exc
            async with client:
                res = await client.action(did, siid, aiid, [])
            return {"status": "ok", "result": res}

        # Primary device entity → domain-aware device control.
        async with client:
            return await client.control_device(profile, action, data or {})

    def format_context(self, entities: dict[str, Any]) -> str:
        items = self.extract_entities(entities)
        if not items:
            return ""
        on = sum(1 for i in items if str(i.get("state")) == "on")
        return f"Xiaomi Home: {len(items)} entități, {on} pornite"
