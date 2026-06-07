from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


class BaseEntity(ABC):
    """Abstract integration component contract.

    Each integration owns its connectivity, fetch logic, and transformation
    into the unified entity shape consumed by the rest of the app.

    **Config-entries model** (Home Assistant inspired): subclasses declare a
    declarative ``CONFIG_SCHEMA`` describing the fields the user must fill
    in. The framework stores each user-created entry in SQLite and
    instantiates the provider class **once per entry**, passing the entry's
    data via ``entry_data``. Providers should read their config from
    ``self.entry_data`` (preferred) and fall back to ``config_section`` only
    for backward-compat with the legacy single-instance ``config.json``.
    """

    slug: str = ""
    label: str = ""
    description: str = ""
    icon: str = "fa-puzzle-piece"
    color: str = "text-slate-400"
    scan_interval_seconds: int = 300
    fetch_timeout_seconds: float = 60.0
    supports_sync: bool = True
    # Push-based integrations (MQTT bridge, WebSocket, etc.): state updates arrive
    # in real time; scan_interval only gates optional manual/startup broker rescan.
    updates_live: bool = False

    # ── declarative config flow (HA-style) ───────────────────────────────
    # Each field: {key, label, type: text|password|number|select|bool|url,
    #              required: bool, secret: bool, placeholder, default,
    #              options: [{value,label}], help}
    CONFIG_SCHEMA: list[dict[str, Any]] = []
    # Set True when the integration can have multiple independent accounts /
    # connections (e.g. two Pago accounts, several MQTT brokers).
    SUPPORTS_MULTIPLE: bool = False

    def __init__(
        self,
        entry_id: str | None = None,
        entry_data: dict[str, Any] | None = None,
        entry_title: str | None = None,
    ) -> None:
        if not self.slug:
            raise ValueError(f"{self.__class__.__name__} must define slug")
        self.entry_id: str = entry_id or ""
        self.entry_data: dict[str, Any] = dict(entry_data or {})
        self.entry_title: str = entry_title or self.label or self.slug

    @classmethod
    def get_config_schema(cls) -> list[dict[str, Any]]:
        return list(cls.CONFIG_SCHEMA or [])

    @classmethod
    async def async_validate_entry(cls, data: dict[str, Any]) -> dict[str, Any]:
        """Optional pre-save validation hook. Subclasses may override.

        Return ``{"ok": True, "title": "…"}`` on success, or
        ``{"ok": False, "errors": {field: msg, ...}}`` on failure.
        """
        return {"ok": True, "title": ""}

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        """Default connection test: instantiate a transient provider with the
        supplied data and call ``fetch_entities``. Subclasses can override
        for a lighter check (e.g. just authenticate without fetching).

        Returns ``{"ok": True, "message": "..."}`` on success or
        ``{"ok": False, "message": "..."}`` on failure.
        """
        try:
            inst = cls(entry_id="__test__", entry_data=dict(data or {}), entry_title="test")
            payload = await inst.fetch_entities()
            count = 0
            try:
                items = inst.extract_entities(payload)
                count = len(items) if isinstance(items, list) else 0
            except Exception:
                pass
            return {"ok": True, "message_key": "integrations.test_ok", "message_params": {"count": count}}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or exc.__class__.__name__}

    @property
    def config_key(self) -> str:
        return self.slug

    @property
    def store_key(self) -> str:
        """Key used inside the entity store. Multi-instance entries get a
        per-entry suffix so two accounts don't share the same payload.
        Legacy single-instance providers keep the bare slug for backward
        compatibility with stores written before config entries existed."""
        if self.entry_id:
            return f"{self.slug}:{self.entry_id[:8]}"
        return self.slug

    def config_section(self, cfg: dict[str, Any]) -> dict[str, Any]:
        # Prefer per-entry data (HA-style config entries). Falls back to the
        # legacy ``cfg[slug]`` so providers that haven't been migrated keep
        # working without changes.
        if self.entry_data:
            section = dict(self.entry_data)
            section.setdefault("enabled", True)
            return section
        section = cfg.get(self.config_key)
        return section if isinstance(section, dict) else {}

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        return bool(self.config_section(cfg))

    def is_enabled(self, cfg: dict[str, Any]) -> bool:
        if self.entry_data:
            return True
        section = self.config_section(cfg)
        return self.is_configured(cfg) and bool(section.get("enabled"))

    def uses_background_sync(self) -> bool:
        """Periodic background fetch+store (REST polling). False for push integrations."""
        return self.supports_sync and not self.updates_live

    def sync_interval(self, cfg: dict[str, Any]) -> int:
        """Return the user-configured sync interval in seconds.

        Reads ``scan_interval`` from the config entry (or legacy config section).
        Falls back to ``scan_interval_seconds`` class default. The only floor is
        the field ``min`` from ``CONFIG_SCHEMA`` (default 1 when unset).
        """
        section = self.config_section(cfg)
        configured = section.get("scan_interval") or section.get("scan_interval_seconds")
        try:
            value = int(configured)
        except (TypeError, ValueError):
            value = self.scan_interval_seconds
        return max(value, self._scan_interval_floor())

    def _scan_interval_floor(self) -> int:
        for field in self.get_config_schema():
            if field.get("key") in ("scan_interval", "scan_interval_seconds"):
                try:
                    return max(1, int(field.get("min", 1)))
                except (TypeError, ValueError):
                    break
        return 1

    def manifest_path(self) -> str:
        return str(Path(__file__).resolve())

    def source_meta(self) -> dict[str, str]:
        return {
            "slug": self.slug,
            "label": self.label or self.slug,
            "icon": self.icon,
            "color": self.color,
        }

    @abstractmethod
    async def fetch_entities(self) -> dict[str, Any]:
        """Fetch raw integration payload from the upstream system."""

    @abstractmethod
    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        """Convert a raw payload into the app's flat entity representation."""

    def format_context(self, entities: dict[str, Any]) -> str:
        return ""

    async def control_entity(
        self,
        entity_id: str,
        action: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Optional: subclasses implement per-integration control.

        ``action`` is a verb like ``turn_on``, ``turn_off``, ``toggle``, ``set``.
        ``data`` carries any extra payload (e.g. brightness, target value).
        Should raise ``NotImplementedError`` when control is unsupported so the
        router can return a 501.
        """
        raise NotImplementedError(
            f"Integrarea '{self.slug}' nu suportă comenzi de control."
        )

    def live_payload(self, stored: dict[str, Any]) -> dict[str, Any]:
        """Optional: merge the durable stored payload with any live runtime
        state (e.g. an MQTT bridge cache). Subclasses override this when they
        have an in-memory live source that's fresher than the SQLite snapshot.

        Default returns the stored payload unchanged. Must remain synchronous
        because the dashboard builds its entity list inside ``to_thread``.
        """
        return stored if isinstance(stored, dict) else {}

    async def list_entities(self, store) -> list[dict[str, Any]]:
        from smart_home_registry import normalize_entity_record

        if not self.supports_sync:
            return []
        stored = store.get_entities(self.store_key) or {}
        payload = stored.get("entities") or {}
        items = self.extract_entities(payload)
        # Tag every entity with its origin so the API layer can keep entries
        # separate (no dedupe collisions when two entries expose the same
        # entity_id, and the UI can group devices by entry).
        for item in items:
            item.setdefault("entry_id", self.entry_id or "")
            item.setdefault("entry_title", self.entry_title or self.label or self.slug)
            normalize_entity_record(item, default_source=self.slug)
        return items