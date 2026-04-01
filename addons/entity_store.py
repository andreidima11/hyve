"""Integration entity storage and sync service."""

import asyncio
import json
import logging
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Callable, Dict, Optional

import database
from sqlalchemy import text

log = logging.getLogger("integrations.entities")


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

    async def initialize_schema(self):
        """Create tables if they don't exist."""
        with _db() as db:
            db.execute(text("""
                CREATE TABLE IF NOT EXISTS integration_entities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    integration_slug TEXT NOT NULL UNIQUE,
                    entity_data TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    last_error TEXT
                )
            """))
            db.execute(text("""
                CREATE TABLE IF NOT EXISTS integration_entity_schedule (
                    integration_slug TEXT PRIMARY KEY,
                    fetch_interval_seconds INTEGER NOT NULL DEFAULT 300,
                    enabled BOOLEAN NOT NULL DEFAULT 1,
                    last_fetch_time REAL,
                    next_fetch_time REAL
                )
            """))
            db.commit()

    # -- Registry ----------------------------------------------------------

    def register_fetcher(self, slug: str, fetch_fn: Callable,
                         formatter: Callable | None = None):
        """Register an async fetch function for an integration.

        *formatter*: optional ``(entities_dict) -> str`` that produces a
        human-readable summary for injection into the AI system prompt.
        """
        self._fetchers[slug] = fetch_fn
        if formatter:
            self._formatters[slug] = formatter

    def get_fetcher(self, slug: str) -> Callable | None:
        return self._fetchers.get(slug)

    # -- CRUD --------------------------------------------------------------

    def get_entities(self, slug: str) -> Optional[Dict[str, Any]]:
        """Get stored entities for an integration."""
        with _db() as db:
            row = db.execute(
                text("SELECT entity_data, timestamp, last_error "
                     "FROM integration_entities WHERE integration_slug = :slug"),
                {"slug": slug}
            ).fetchone()
        if not row:
            return None
        try:
            data = json.loads(row[0])
            return {
                "entities": data,
                "timestamp": row[1],
                "updated_at": datetime.fromtimestamp(row[1]).isoformat(),
                "last_error": row[2],
            }
        except json.JSONDecodeError:
            return None

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

    async def do_sync(self, slug: str) -> Dict[str, Any]:
        """Execute a single fetch+store cycle. Returns entity data."""
        fn = self._fetchers.get(slug)
        if not fn:
            raise ValueError(f"No fetcher registered for '{slug}'")
        entities = await fn()
        self.set_entities(slug, entities, error=None)
        schedule = self.get_schedule(slug)
        interval = (schedule or {}).get("interval_seconds", 3600)
        self.update_schedule(slug, datetime.now().timestamp() + interval)
        log.info("Synced entities for %s (%d keys)", slug, len(entities))
        return entities

    async def start_sync_loop(self, slug: str, interval_seconds: int = 300):
        """Start background sync loop for an integration."""
        if slug in self._sync_tasks:
            return
        if slug not in self._fetchers:
            log.warning("Cannot start sync loop for %s — no fetcher registered", slug)
            return

        async def _loop():
            log.info("Entity sync loop started: %s (every %ds)", slug, interval_seconds)
            while True:
                try:
                    await asyncio.sleep(interval_seconds)
                    await self.do_sync(slug)
                except asyncio.CancelledError:
                    log.info("Entity sync loop stopped: %s", slug)
                    break
                except Exception as e:
                    log.error("Entity sync error for %s: %s", slug, e)
                    self.set_entities(slug, {}, error=str(e))
                    await asyncio.sleep(60)

        self._sync_tasks[slug] = asyncio.create_task(_loop())

    def stop_sync_loop(self, slug: str):
        """Stop background sync loop for an integration."""
        task = self._sync_tasks.pop(slug, None)
        if task:
            task.cancel()
            log.info("Stopped entity sync loop: %s", slug)

    def stop_all_sync_loops(self):
        for slug in list(self._sync_tasks):
            self.stop_sync_loop(slug)

    # -- AI Context --------------------------------------------------------

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
                    blocks.append(block)
            except Exception as e:
                log.debug("Context formatter error for %s: %s", slug, e)
        return "\n".join(blocks)


# Global instance
_store = IntegrationEntityStore()


def get_entity_store() -> IntegrationEntityStore:
    """Get the global entity store instance."""
    return _store
