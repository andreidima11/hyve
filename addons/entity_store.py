"""Integration entity storage and sync service."""

import asyncio
import json
import logging
import threading
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Callable, Dict, Optional

import core.database as database
from sqlalchemy import text
from core.logger import log_line

log = logging.getLogger("integrations.entities")


class SyncThrottledError(Exception):
    """Raised when a sync is requested before the configured interval elapsed."""

    I18N_KEY = "integrations.sync_throttled"

    def __init__(self, *, retry_after: int = 0, interval: int = 0, message: str | None = None):
        self.retry_after = retry_after
        self.interval = interval
        super().__init__(message or f"sync throttled: {retry_after}s")

    def as_detail(self) -> dict[str, Any]:
        return {
            "key": self.I18N_KEY,
            "params": {"seconds": self.retry_after, "interval": self.interval},
        }


# Known error patterns → short human-readable messages
_ERROR_PATTERNS: list[tuple[str, str]] = [
    ("invalidSession", "cloud session expired — re-authenticate in Integrations"),
    ("Failed to get a usable token/key from cloud", "cloud authentication failed"),
    ("Connection refused", "connection refused — is the service running?"),
    ("Name or service not known", "host not found — check the address"),
    ("timed out", "timeout — service not responding"),
    ("ConnectTimeoutError", "connection timeout"),
    ("SSLError", "SSL error — invalid certificate"),
    ("401", "authentication failed — check credentials"),
    ("403", "access forbidden — check permissions"),
    ("ConnectionResetError", "connection reset by peer"),
]


def _format_sync_error(slug: str, exc: Exception) -> str:
    """Condense a sync exception into a short, readable log line."""
    raw = str(exc)
    for pattern, friendly in _ERROR_PATTERNS:
        if pattern in raw:
            return f"{slug} — {friendly}"
    # Fallback: truncate the raw message
    short = raw.split("\n")[0]
    if len(short) > 120:
        short = short[:117] + "..."
    return f"{slug} — {short}"


# Hard upper bound for any single integration fetch (HA's DataUpdateCoordinator
# uses update_interval as the timeout; we apply a global cap so a misbehaving
# provider can never freeze the event loop or exhaust the DB pool).
FETCH_TIMEOUT_SECONDS = 60.0


@contextmanager
def _db():
    """Properly yield a SQLAlchemy session."""
    gen = database.get_db()
    session = next(gen)
    try:
        yield session
    finally:
        session.close()


class IntegrationEntityStore:
    """Manage entity storage and sync for integrations."""

    def __init__(self):
        self._sync_tasks: Dict[str, asyncio.Task] = {}
        self._last_sync: Dict[str, datetime] = {}
        self._fetchers: Dict[str, Callable] = {}
        self._formatters: Dict[str, Callable] = {}
        self._fetch_timeouts: Dict[str, float] = {}
        self._descriptions: Dict[str, str] = {}
        self._unreachable_sources: set[str] = set()
        self._sync_locks: Dict[str, asyncio.Lock] = {}
        self._sync_locks_mu = threading.Lock()

    def _sync_lock(self, slug: str) -> asyncio.Lock:
        with self._sync_locks_mu:
            lock = self._sync_locks.get(slug)
            if lock is None:
                lock = asyncio.Lock()
                self._sync_locks[slug] = lock
            return lock

    async def initialize_schema(self):
        """Verify Alembic created integration entity tables (see migrations/003)."""
        import asyncio

        import core.database as database
        from core.db_schema import require_sqlite_tables

        await asyncio.to_thread(
            require_sqlite_tables,
            database.engine,
            "integration_entities",
            "integration_entity_schedule",
            "integration_entity_overrides",
        )

    # -- Registry ----------------------------------------------------------

    def register_fetcher(self, slug: str, fetch_fn: Callable,
                         formatter: Callable | None = None,
                         description: str = "",
                         timeout_seconds: float | None = None):
        """Register an async fetch function for an integration.

        *formatter*: optional ``(entities_dict) -> str`` that produces a
        human-readable summary for injection into the AI system prompt.
        *description*: short human-readable text explaining what this integration is.
        *timeout_seconds*: hard cap for a single fetch; defaults to
        ``FETCH_TIMEOUT_SECONDS`` when omitted.
        """
        self._fetchers[slug] = fetch_fn
        if timeout_seconds is not None:
            self._fetch_timeouts[slug] = float(timeout_seconds)
        elif slug not in self._fetch_timeouts:
            self._fetch_timeouts[slug] = FETCH_TIMEOUT_SECONDS
        if formatter:
            self._formatters[slug] = formatter
        if description:
            self._descriptions[slug] = description

    def get_fetcher(self, slug: str) -> Callable | None:
        return self._fetchers.get(slug)

    def source_is_reachable(self, store_key: str) -> bool:
        """False when the latest upstream sync for this source failed."""
        return str(store_key or "") not in self._unreachable_sources

    def _mark_source_reachable(self, store_key: str, reachable: bool) -> None:
        key = str(store_key or "").strip()
        if not key:
            return
        if reachable:
            self._unreachable_sources.discard(key)
        else:
            self._unreachable_sources.add(key)

    # -- CRUD --------------------------------------------------------------

    def get_entities(self, slug: str) -> Optional[Dict[str, Any]]:
        """Get stored entities for an integration."""
        return self.get_entities_many([slug]).get(slug)

    def get_entities_many(self, slugs: list[str]) -> dict[str, dict[str, Any] | None]:
        """Batch-read stored entity payloads for multiple store keys."""
        keys = [str(s or "").strip() for s in slugs if str(s or "").strip()]
        if not keys:
            return {}
        placeholders = ", ".join(f":s{i}" for i in range(len(keys)))
        params = {f"s{i}": key for i, key in enumerate(keys)}
        with _db() as db:
            rows = db.execute(
                text(
                    "SELECT integration_slug, entity_data, timestamp, last_error "
                    f"FROM integration_entities WHERE integration_slug IN ({placeholders})"
                ),
                params,
            ).fetchall()
        out: dict[str, dict[str, Any] | None] = {key: None for key in keys}
        for slug, entity_data, timestamp, last_error in rows:
            try:
                data = json.loads(entity_data)
                out[str(slug)] = {
                    "entities": data,
                    "timestamp": timestamp,
                    "updated_at": datetime.fromtimestamp(timestamp).isoformat(),
                    "last_error": last_error,
                }
            except json.JSONDecodeError:
                out[str(slug)] = None
        return out

    def set_entities(self, slug: str, entities: Dict[str, Any],
                     error: Optional[str] = None):
        """Store entity data for an integration."""
        with _db() as db:
            timestamp = datetime.now().timestamp()
            entity_json = json.dumps(entities, ensure_ascii=False)
            db.execute(text("""
                INSERT OR REPLACE INTO integration_entities
                (integration_slug, entity_data, timestamp, last_error)
                VALUES (:slug, :data, :ts, :err)
            """), {"slug": slug, "data": entity_json, "ts": timestamp, "err": error})
            db.commit()
        self._last_sync[slug] = datetime.now()

    def set_error(self, slug: str, error: str):
        """Record a sync error WITHOUT discarding the last good entity payload.

        A transient failure (timeout, network blip, provider 5xx) must not blank
        the dashboard — we keep the previous snapshot and only update last_error.
        If no row exists yet, store an empty payload so the error is visible.
        """
        with _db() as db:
            timestamp = datetime.now().timestamp()
            updated = db.execute(text("""
                UPDATE integration_entities
                SET last_error = :err, timestamp = :ts
                WHERE integration_slug = :slug
            """), {"err": error, "ts": timestamp, "slug": slug}).rowcount
            if not updated:
                db.execute(text("""
                    INSERT OR REPLACE INTO integration_entities
                    (integration_slug, entity_data, timestamp, last_error)
                    VALUES (:slug, :data, :ts, :err)
                """), {"slug": slug, "data": "{}", "ts": timestamp, "err": error})
            db.commit()
        self._mark_source_reachable(slug, False)
        self._signal_mirror_refresh(slug)

    def get_schedule(self, slug: str) -> Optional[Dict[str, Any]]:
        """Get sync schedule for an integration."""
        with _db() as db:
            row = db.execute(
                text("SELECT fetch_interval_seconds, enabled, last_fetch_time, next_fetch_time "
                     "FROM integration_entity_schedule WHERE integration_slug = :slug"),
                {"slug": slug}
            ).fetchone()
        if not row:
            return None
        return {
            "interval_seconds": row[0],
            "enabled": bool(row[1]),
            "last_fetch_time": row[2],
            "next_fetch_time": row[3],
        }

    def init_schedule(self, slug: str, interval_seconds: int = 300):
        """Initialize sync schedule for an integration."""
        with _db() as db:
            now = datetime.now().timestamp()
            db.execute(text("""
                INSERT OR REPLACE INTO integration_entity_schedule
                (integration_slug, fetch_interval_seconds, enabled, last_fetch_time, next_fetch_time)
                VALUES (:slug, :interval, 1, :now, :next)
            """), {"slug": slug, "interval": interval_seconds, "now": now, "next": now + interval_seconds})
            db.commit()

    def set_interval(self, slug: str, interval_seconds: int) -> None:
        """Update the configured sync interval without resetting last fetch times."""
        interval_seconds = max(1, int(interval_seconds))
        with _db() as db:
            updated = db.execute(text("""
                UPDATE integration_entity_schedule
                SET fetch_interval_seconds = :interval
                WHERE integration_slug = :slug
            """), {"interval": interval_seconds, "slug": slug}).rowcount
            if not updated:
                self.init_schedule(slug, interval_seconds)
            else:
                db.commit()

    def configured_interval(self, slug: str, fallback: int = 300) -> int:
        """Read the current sync interval from the schedule table."""
        schedule = self.get_schedule(slug)
        try:
            return max(1, int((schedule or {}).get("interval_seconds") or fallback))
        except (TypeError, ValueError):
            return max(1, int(fallback))

    def seconds_until_next_sync(self, slug: str) -> float:
        """Seconds remaining before another sync is allowed (per user config)."""
        schedule = self.get_schedule(slug)
        if not schedule:
            return 0.0
        last = float(schedule.get("last_fetch_time") or 0)
        if last <= 0:
            return 0.0
        interval = float(schedule.get("interval_seconds") or 300)
        elapsed = datetime.now().timestamp() - last
        return max(0.0, interval - elapsed)

    def touch_last_fetch(self, slug: str) -> None:
        """Record that a sync attempt happened (starts the interval countdown)."""
        interval = self.configured_interval(slug)
        self.update_schedule(slug, datetime.now().timestamp() + interval)

    def update_schedule(self, slug: str, next_fetch_time: float):
        """Update next fetch time after a sync."""
        with _db() as db:
            now = datetime.now().timestamp()
            db.execute(text("""
                UPDATE integration_entity_schedule
                SET last_fetch_time = :now, next_fetch_time = :next
                WHERE integration_slug = :slug
            """), {"now": now, "next": next_fetch_time, "slug": slug})
            db.commit()

    # -- Sync --------------------------------------------------------------

    async def do_sync(self, slug: str, *, force: bool = False) -> Dict[str, Any]:
        """Execute a single fetch+store cycle. Returns entity data.

        The fetch is wrapped in ``asyncio.wait_for`` with a hard cap so a
        misbehaving provider (network hang, slow LAN discovery, etc.) can
        never block the event loop or other integrations.

        Unless ``force=True``, respects the user-configured ``scan_interval``
        so the background sync loop cannot hammer upstream APIs more often
        than configured. Manual sync, startup bootstrap, and post-config
        refresh pass ``force=True`` and always run immediately.
        """
        async with self._sync_lock(slug):
            wait = self.seconds_until_next_sync(slug)
            if not force and wait > 0:
                interval = self.configured_interval(slug)
                secs = max(1, int(wait + 0.5))
                raise SyncThrottledError(
                    retry_after=secs,
                    interval=interval,
                )

            fn = self._fetchers.get(slug)
            if not fn:
                raise ValueError(f"No fetcher registered for '{slug}'")
            timeout = self._fetch_timeouts.get(slug, FETCH_TIMEOUT_SECONDS)
            started = datetime.now().timestamp()
            try:
                import inspect

                kwargs: dict[str, Any] = {}
                try:
                    if "force" in inspect.signature(fn).parameters:
                        kwargs["force"] = force
                except (TypeError, ValueError):
                    pass
                entities = await asyncio.wait_for(fn(**kwargs), timeout=timeout)
            except asyncio.TimeoutError:
                elapsed = datetime.now().timestamp() - started
                self.set_error(slug, f"timeout after {elapsed:.1f}s")
                self._mark_source_reachable(slug, False)
                self._signal_mirror_refresh(slug)
                schedule = self.get_schedule(slug)
                interval = (schedule or {}).get("interval_seconds", 3600)
                self.update_schedule(slug, datetime.now().timestamp() + interval)
                log_line("error", "⏱️", "SYNC", f"{slug} — timeout after {elapsed:.1f}s (cap {timeout:.0f}s)")
                raise
            self.touch_last_fetch(slug)
            self.set_entities(slug, entities, error=None)
            self._mark_source_reachable(slug, True)
            self._signal_mirror_refresh(slug)
            schedule = self.get_schedule(slug)
            interval = (schedule or {}).get("interval_seconds", 3600)
            self.update_schedule(slug, datetime.now().timestamp() + interval)
            log_line("sys", "🔄", "SYNC", f"{slug} — {len(entities)} keys")
            return entities

    def _signal_mirror_refresh(self, store_key: str) -> None:
        try:
            from core.entity_mirror import signal_source_refresh

            signal_source_refresh(store_key)
        except Exception:
            pass

    async def start_sync_loop(self, slug: str, interval_seconds: int = 300):
        """Start background sync loop for an integration."""
        if slug in self._sync_tasks:
            return
        if slug not in self._fetchers:
            log_line("error", "⚠️", "SYNC", f"{slug} — no fetcher registered, cannot start loop")
            return

        async def _sleep_interval() -> float:
            """Always read the live interval from DB — user edits take effect
            without restarting the server, and error backoff matches the same
            configured scan_interval (e.g. 600s stays 600s)."""
            return float(self.configured_interval(slug, fallback=interval_seconds))

        async def _loop():
            iv = await _sleep_interval()
            log_line("sys", "🔄", "SYNC", f"{slug} — loop started (every {iv:.0f}s)")
            while True:
                try:
                    await asyncio.sleep(await _sleep_interval())
                    await self.do_sync(slug)
                except asyncio.CancelledError:
                    log_line("sys", "🔄", "SYNC", f"{slug} — loop stopped")
                    break
                except asyncio.TimeoutError:
                    delay = await _sleep_interval()
                    log_line("error", "⏱️", "SYNC", f"{slug} — backing off {delay:.0f}s after timeout")
                    await asyncio.sleep(delay)
                except Exception as e:
                    err_msg = _format_sync_error(slug, e)
                    log_line("error", "⚠️", "SYNC", err_msg)
                    self.set_error(slug, str(e))
                    await asyncio.sleep(await _sleep_interval())

        self._sync_tasks[slug] = asyncio.create_task(_loop())

    async def restart_sync_loop(self, slug: str, interval_seconds: int | None = None) -> None:
        """Stop and restart the sync loop (picks up a new interval immediately)."""
        if interval_seconds is not None:
            self.set_interval(slug, interval_seconds)
        self.stop_sync_loop(slug)
        iv = interval_seconds if interval_seconds is not None else self.configured_interval(slug)
        await self.start_sync_loop(slug, iv)

    def stop_sync_loop(self, slug: str):
        """Stop background sync loop for an integration."""
        task = self._sync_tasks.pop(slug, None)
        if task:
            task.cancel()
            log_line("sys", "🔄", "SYNC", f"{slug} — loop cancelled")

    def unregister(self, slug: str, *, purge: bool = True):
        """Stop the sync loop, drop the fetcher and (optionally) purge the
        stored payload + schedule for an integration. Used when a config
        entry is deleted so its devices/entities disappear immediately.
        """
        self.stop_sync_loop(slug)
        self._fetchers.pop(slug, None)
        self._formatters.pop(slug, None)
        self._fetch_timeouts.pop(slug, None)
        self._last_sync.pop(slug, None)
        self._unreachable_sources.discard(slug)
        try:
            from integrations.source_refresh import detach_refresh_runner

            detach_refresh_runner(slug)
        except Exception:
            pass
        if not purge:
            return
        try:
            with _db() as db:
                db.execute(
                    text("DELETE FROM integration_entities WHERE integration_slug = :slug"),
                    {"slug": slug},
                )
                db.execute(
                    text("DELETE FROM integration_entity_schedule WHERE integration_slug = :slug"),
                    {"slug": slug},
                )
                db.commit()
        except Exception as exc:  # pragma: no cover - defensive
            log.debug("unregister(%s): purge failed: %s", slug, exc)

    def stop_all_sync_loops(self):
        for slug in list(self._sync_tasks):
            self.stop_sync_loop(slug)

    # -- AI Context --------------------------------------------------------

    def get_overrides(self) -> dict[str, dict[str, Any]]:
        """Return all entity overrides keyed by entity_id."""
        with _db() as db:
            rows = db.execute(
                text("SELECT entity_id, custom_name, aliases, selected FROM integration_entity_overrides")
            ).fetchall()
        result: dict[str, dict[str, Any]] = {}
        for entity_id, custom_name, aliases_json, selected in rows:
            try:
                aliases = json.loads(aliases_json) if aliases_json else []
            except (json.JSONDecodeError, TypeError):
                aliases = []
            result[entity_id] = {
                "custom_name": custom_name or "",
                "aliases": aliases,
                "selected": bool(selected),
            }
        return result

    def set_selection(self, entity_id: str, selected: bool) -> None:
        """Generic per-entity AI-exposure flag, used by every integration.

        This is the source of truth that the unified /all-entities endpoint
        reads back to the UI. Provider-specific stores (e.g.
        legacy entity stores) may keep a parallel flag for legacy code paths,
        but the UI should treat this as authoritative.
        """
        eid = (entity_id or "").strip()
        if not eid:
            return
        with _db() as db:
            existing = db.execute(
                text("SELECT 1 FROM integration_entity_overrides WHERE entity_id = :eid"),
                {"eid": eid},
            ).fetchone()
            if existing:
                db.execute(
                    text("UPDATE integration_entity_overrides SET selected = :sel WHERE entity_id = :eid"),
                    {"eid": eid, "sel": 1 if selected else 0},
                )
            else:
                db.execute(
                    text("INSERT INTO integration_entity_overrides (entity_id, custom_name, aliases, selected) VALUES (:eid, '', '[]', :sel)"),
                    {"eid": eid, "sel": 1 if selected else 0},
                )
            db.commit()

    def set_override(self, entity_id: str, custom_name: str | None = None,
                     aliases: list[str] | None = None):
        """Set or update a custom name and/or aliases for an integration entity."""
        with _db() as db:
            existing = db.execute(
                text("SELECT custom_name, aliases FROM integration_entity_overrides WHERE entity_id = :eid"),
                {"eid": entity_id},
            ).fetchone()
            if existing:
                cur_name = existing[0] or ""
                try:
                    cur_aliases = json.loads(existing[1]) if existing[1] else []
                except (json.JSONDecodeError, TypeError):
                    cur_aliases = []
                new_name = custom_name if custom_name is not None else cur_name
                new_aliases = aliases if aliases is not None else cur_aliases
                db.execute(
                    text("UPDATE integration_entity_overrides SET custom_name = :name, aliases = :aliases WHERE entity_id = :eid"),
                    {"eid": entity_id, "name": new_name, "aliases": json.dumps(new_aliases, ensure_ascii=False)},
                )
            else:
                db.execute(
                    text("INSERT INTO integration_entity_overrides (entity_id, custom_name, aliases) VALUES (:eid, :name, :aliases)"),
                    {"eid": entity_id, "name": custom_name or "", "aliases": json.dumps(aliases or [], ensure_ascii=False)},
                )
            db.commit()

    def apply_overrides(self, entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Apply custom names, aliases and the AI-selection flag to a list
        of entities in-place."""
        overrides = self.get_overrides()
        if not overrides:
            return entities
        for entity in entities:
            eid = entity.get("entity_id")
            uid = entity.get("unique_id")
            # Match by HA-style entity_id first, then fall back to the
            # provider's stable unique_id so selections survive renames
            # (where entity_id changes but unique_id stays constant).
            ov = overrides.get(eid) or (overrides.get(uid) if uid else None)
            if not ov:
                continue
            if ov.get("custom_name"):
                entity["name"] = ov["custom_name"]
            if ov.get("aliases"):
                entity["aliases"] = ov["aliases"]
            # Generic selection flag — overrides any provider-specific value
            # so HA, mosquitto, pago, future community integrations all use
            # the same truth source for AI exposure.
            if "selected" in ov:
                entity["selected"] = ov["selected"]
        return entities

    def get_all_entities(self) -> list[dict[str, Any]]:
        """Flat list of entities across ALL integrations in the unified shape.

        Delegates to the integrations router's builder (the single source of
        truth used by the /all-entities endpoint). Best-effort and synchronous;
        returns [] on failure so callers can degrade gracefully.
        """
        try:
            from core.entity_catalog import build_entities_uncached
            return build_entities_uncached(include_derived=False) or []
        except Exception as e:
            log.debug("get_all_entities failed: %s", e)
            return []

    def get_context_for_ai(self) -> str:
        """Build a combined context string from all integrations for the system prompt."""
        blocks: list[str] = []
        for slug, formatter in self._formatters.items():
            result = self.get_entities(slug)
            if not result or not result.get("entities"):
                continue
            try:
                block = formatter(result["entities"])
                if block:
                    desc = self._descriptions.get(slug)
                    if desc:
                        block = f"{block} ({desc})"
                    blocks.append(block)
            except Exception as e:
                log.debug("Context formatter error for %s: %s", slug, e)
        return "\n".join(blocks)


# Global instance
_store = IntegrationEntityStore()


def get_entity_store() -> IntegrationEntityStore:
    """Get the global entity store instance."""
    return _store
