"""
Home Assistant WebSocket real-time event subscriber.

Maintains a persistent WebSocket connection to HA, subscribes to
state_changed events, and keeps a live entity-state cache.  Other modules
can register callbacks for specific domains or entities.

Usage (inside lifespan):
    from ha_websocket import ha_ws
    await ha_ws.start()          # connects + subscribes in background
    ...
    await ha_ws.stop()           # graceful shutdown

    # Query live state (faster than REST):
    state = ha_ws.get_state("light.bedroom")

    # Register a callback for state changes:
    ha_ws.on_change("light", my_callback)
"""

from __future__ import annotations

import asyncio
import copy
import json
import time
import traceback
from typing import Any, Callable, Coroutine, Dict, List, Optional, Set, Tuple

import httpx

import settings as settings_mod
from logger import log_line

# Type alias for callbacks: async def cb(entity_id, old_state, new_state, attributes) -> None
ChangeCallback = Callable[[str, str, str, Dict[str, Any]], Coroutine[Any, Any, None]]


class _HAWebSocket:
    """Singleton-style HA WebSocket manager."""

    def __init__(self) -> None:
        self._ws: Any = None  # httpx_ws.AsyncWebSocketSession
        self._task: Optional[asyncio.Task] = None
        self._msg_id: int = 0
        self._running: bool = False

        # Live entity state cache: {entity_id: {state, attributes, last_changed}}
        self._state_cache: Dict[str, Dict[str, Any]] = {}
        self._cache_lock = asyncio.Lock()

        # Domain-level callbacks: {"light": [cb1, cb2], "*": [cb3]}
        self._callbacks: Dict[str, List[ChangeCallback]] = {}

        # Significant event buffer for agent context injection
        self._recent_events: List[Dict[str, Any]] = []
        self._events_lock = asyncio.Lock()
        self._max_recent_events = 50

        # Reconnect settings
        self._reconnect_delay = 5.0
        self._max_reconnect_delay = 120.0

        # Debounce: suppress rapid-fire events for same entity within N seconds
        self._debounce_window = 1.0  # seconds
        self._last_event_ts: Dict[str, float] = {}

    # ------------------------------------------------------------------
    #  PUBLIC API
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the WebSocket listener as a background task."""
        ha_cfg = settings_mod.CFG.get("home_assistant", {})
        if not ha_cfg.get("enabled"):
            log_line("ws", "⏭️", "HA WS", "Home Assistant disabled — WebSocket skipped")
            return
        if not ha_cfg.get("url") or not ha_cfg.get("token"):
            log_line("ws", "⚠️", "HA WS", "Missing HA url/token — WebSocket skipped")
            return

        ws_events = ha_cfg.get("websocket_events", True)
        if ws_events is False:
            log_line("ws", "⏭️", "HA WS", "websocket_events disabled in config")
            return

        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name="ha_ws_listener")
        log_line("ws", "🔌", "HA WS", "Background listener started")

    async def stop(self) -> None:
        """Gracefully stop the WebSocket listener."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None
        log_line("ws", "🔌", "HA WS", "Listener stopped")

    def get_state(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """Return cached state for an entity, or None if not in cache."""
        state = self._state_cache.get(entity_id)
        return copy.deepcopy(state) if state is not None else None

    def get_all_states(self) -> Dict[str, Dict[str, Any]]:
        """Return a shallow copy of the full state cache."""
        return copy.deepcopy(self._state_cache)

    def on_change(self, domain_or_entity: str, callback: ChangeCallback) -> None:
        """
        Register an async callback for state changes.
        - domain_or_entity = "light" → fires for all light.* entities
        - domain_or_entity = "light.bedroom" → fires only for that entity
        - domain_or_entity = "*" → fires for all changes
        """
        self._callbacks.setdefault(domain_or_entity, []).append(callback)

    def remove_change(self, domain_or_entity: str, callback: ChangeCallback) -> None:
        """Remove a previously registered callback."""
        cbs = self._callbacks.get(domain_or_entity)
        if cbs:
            try:
                cbs.remove(callback)
            except ValueError:
                pass
            if not cbs:
                del self._callbacks[domain_or_entity]

    async def get_recent_events(self, limit: int = 10, domains: Optional[Set[str]] = None) -> List[Dict[str, Any]]:
        """Return recent significant state changes for agent context."""
        async with self._events_lock:
            events = list(self._recent_events)
        if domains:
            events = [e for e in events if e.get("domain") in domains]
        return events[-limit:]

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._running

    @property
    def cache_size(self) -> int:
        return len(self._state_cache)

    # ------------------------------------------------------------------
    #  INTERNAL: connection loop
    # ------------------------------------------------------------------

    async def _run_loop(self) -> None:
        """Reconnecting event loop."""
        delay = self._reconnect_delay

        while self._running:
            try:
                await self._connect_and_listen()
                delay = self._reconnect_delay  # reset on clean disconnect
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log_line("ws", "⚠️", "HA WS", f"Connection lost: {type(exc).__name__}: {exc}")

            if not self._running:
                break

            log_line("ws", "🔄", "HA WS", f"Reconnecting in {delay:.0f}s …")
            await asyncio.sleep(delay)
            delay = min(delay * 2, self._max_reconnect_delay)

    async def _connect_and_listen(self) -> None:
        """Single connection lifetime: auth → subscribe → read loop."""
        ha_cfg = settings_mod.CFG.get("home_assistant", {})
        http_url = ha_cfg["url"].rstrip("/")
        ws_url = http_url.replace("https://", "wss://").replace("http://", "ws://") + "/api/websocket"
        token = ha_cfg["token"]

        try:
            import websockets
        except ImportError:
            log_line("ws", "❌", "HA WS", "Install 'websockets' package: pip install websockets")
            self._running = False
            return

        async with websockets.connect(ws_url, close_timeout=10, ping_interval=30, ping_timeout=10) as ws:
            self._ws = ws
            try:
                # Step 1: receive auth_required
                raw = await ws.recv()
                msg = json.loads(raw)
                if msg.get("type") != "auth_required":
                    log_line("ws", "⚠️", "HA WS", f"Unexpected first message: {msg.get('type')}")
                    return
                # Step 2: authenticate
                await ws.send(json.dumps({"type": "auth", "access_token": token}))
                raw = await ws.recv()
                msg = json.loads(raw)
                if msg.get("type") != "auth_ok":
                    log_line("ws", "❌", "HA WS", f"Auth failed: {msg}")
                    self._running = False
                    return
                log_line("ws", "✅", "HA WS", f"Authenticated (HA {msg.get('ha_version', '?')})")

                # Step 3: fetch initial states to populate cache
                await self._fetch_initial_states(ws)

                # Step 4: subscribe to state_changed events
                self._msg_id += 1
                await ws.send(json.dumps({
                    "id": self._msg_id,
                    "type": "subscribe_events",
                    "event_type": "state_changed",
                }))
                raw = await ws.recv()
                sub_result = json.loads(raw)
                if sub_result.get("success"):
                    log_line("ws", "📡", "HA WS", f"Subscribed to state_changed (cache: {len(self._state_cache)} entities)")
                else:
                    log_line("ws", "⚠️", "HA WS", f"Subscribe failed: {sub_result}")

                # Step 5: read events forever
                async for raw in ws:
                    if not self._running:
                        break
                    try:
                        msg = json.loads(raw)
                        if msg.get("type") == "event":
                            await self._handle_event(msg.get("event", {}))
                    except json.JSONDecodeError:
                        continue
                    except Exception as exc:
                        log_line("ws", "⚠️", "HA WS EVENT", f"{type(exc).__name__}: {exc}")
            finally:
                self._ws = None

    async def _fetch_initial_states(self, ws) -> None:
        """Fetch all entity states via WS get_states to seed the cache."""
        self._msg_id += 1
        await ws.send(json.dumps({"id": self._msg_id, "type": "get_states"}))
        raw = await ws.recv()
        msg = json.loads(raw)
        if msg.get("success") and isinstance(msg.get("result"), list):
            async with self._cache_lock:
                for entity in msg["result"]:
                    eid = entity.get("entity_id", "")
                    if eid:
                        self._state_cache[eid] = {
                            "state": entity.get("state", "unknown"),
                            "attributes": entity.get("attributes", {}),
                            "last_changed": entity.get("last_changed", ""),
                            "last_updated": entity.get("last_updated", ""),
                        }
            log_line("ws", "📥", "HA WS", f"Cached {len(self._state_cache)} entity states")

    async def _handle_event(self, event: Dict[str, Any]) -> None:
        """Process a state_changed event."""
        data = event.get("data", {})
        entity_id = data.get("entity_id", "")
        if not entity_id:
            return

        old_state_obj = data.get("old_state") or {}
        new_state_obj = data.get("new_state") or {}

        old_state = old_state_obj.get("state", "unknown")
        new_state = new_state_obj.get("state", "unknown")
        new_attrs = new_state_obj.get("attributes", {})

        # Debounce: skip if same entity reported within debounce window
        now = time.monotonic()
        last_ts = self._last_event_ts.get(entity_id, 0)
        if now - last_ts < self._debounce_window and old_state == new_state:
            return
        self._last_event_ts[entity_id] = now

        # Update cache
        async with self._cache_lock:
            self._state_cache[entity_id] = {
                "state": new_state,
                "attributes": new_attrs,
                "last_changed": new_state_obj.get("last_changed", ""),
                "last_updated": new_state_obj.get("last_updated", ""),
            }

        # Skip uninteresting attribute-only updates (same state)
        if old_state == new_state:
            return

        domain = entity_id.split(".")[0] if "." in entity_id else ""

        # Record significant events
        if self._is_significant(domain, entity_id, old_state, new_state, new_attrs):
            event_record = {
                "entity_id": entity_id,
                "domain": domain,
                "friendly_name": new_attrs.get("friendly_name", entity_id),
                "old_state": old_state,
                "new_state": new_state,
                "timestamp": time.time(),
            }
            async with self._events_lock:
                self._recent_events.append(event_record)
                if len(self._recent_events) > self._max_recent_events:
                    self._recent_events = self._recent_events[-self._max_recent_events:]

        # Fire callbacks
        await self._fire_callbacks(entity_id, domain, old_state, new_state, new_attrs)

    def _is_significant(self, domain: str, entity_id: str, old_state: str, new_state: str, attrs: Dict) -> bool:
        """
        Determine if a state change is significant enough to record.
        Filters out noisy updates (e.g. sensor slight fluctuations).
        """
        # Always significant for these domains
        significant_domains = {"binary_sensor", "lock", "cover", "alarm_control_panel", "person"}
        if domain in significant_domains:
            return True

        # Lights, switches, climate on/off transitions
        if domain in ("light", "switch", "input_boolean", "climate", "media_player", "vacuum", "fan"):
            if old_state != new_state:
                return True

        # Sensors: only if state changed meaningfully
        if domain == "sensor":
            # Skip purely numeric sensors that fluctuate by small amounts
            try:
                old_val = float(old_state)
                new_val = float(new_state)
                if abs(new_val - old_val) / max(abs(old_val), 1) < 0.05:
                    return False  # less than 5% change
            except (ValueError, TypeError):
                pass
            return True

        # Motion / door / window — always significant
        friendly = (attrs.get("friendly_name") or "").lower()
        if any(kw in friendly for kw in ("motion", "door", "window", "presence", "occupancy")):
            return True

        return False

    async def _fire_callbacks(self, entity_id: str, domain: str, old_state: str, new_state: str, attrs: Dict) -> None:
        """Fire registered callbacks for this state change."""
        cbs_to_fire: List[ChangeCallback] = []

        # Exact entity match
        cbs_to_fire.extend(self._callbacks.get(entity_id, []))
        # Domain match
        cbs_to_fire.extend(self._callbacks.get(domain, []))
        # Wildcard
        cbs_to_fire.extend(self._callbacks.get("*", []))

        for cb in cbs_to_fire:
            try:
                await cb(entity_id, old_state, new_state, attrs)
            except Exception as exc:
                log_line("ws", "⚠️", "HA WS CB", f"Callback error: {type(exc).__name__}: {exc}")

    # ------------------------------------------------------------------
    #  Helper: verify entity state (used by post-action verification)
    # ------------------------------------------------------------------

    async def verify_entity_state(
        self,
        entity_id: str,
        expected_state: str,
        timeout: float = 5.0,
        check_attrs: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bool, Dict[str, Any]]:
        """
        Wait up to `timeout` seconds for entity to reach expected_state.
        Returns (matched, actual_state_dict).
        Used after control_device to verify the action took effect.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            cached = self.get_state(entity_id)
            if cached:
                actual = cached.get("state", "")
                if actual == expected_state:
                    # Optionally check attributes (e.g. brightness)
                    if check_attrs:
                        actual_attrs = cached.get("attributes", {})
                        all_match = True
                        for k, v in check_attrs.items():
                            actual_v = actual_attrs.get(k)
                            if actual_v is None:
                                continue  # attribute not present, skip
                            if isinstance(v, (int, float)) and isinstance(actual_v, (int, float)):
                                if abs(actual_v - v) > max(v * 0.1, 5):  # 10% tolerance or ±5
                                    all_match = False
                                    break
                            elif str(actual_v) != str(v):
                                all_match = False
                                break
                        if all_match:
                            return True, cached
                    else:
                        return True, cached
            await asyncio.sleep(0.3)

        # Timeout: return current state
        cached = self.get_state(entity_id) or {}
        return False, cached

    async def get_entity_state_snapshot(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """
        Get current state from cache, or fall back to REST API if not cached.
        """
        cached = self.get_state(entity_id)
        if cached:
            return cached

        # Fallback to REST
        try:
            import home_assistant
            states = await home_assistant.fetch_ha_states()
            for s in states:
                if s.get("entity_id") == entity_id:
                    return {
                        "state": s.get("state", "unknown"),
                        "attributes": s.get("attributes", {}),
                        "last_changed": s.get("last_changed", ""),
                    }
        except Exception:
            pass
        return None


# Singleton instance
ha_ws = _HAWebSocket()
