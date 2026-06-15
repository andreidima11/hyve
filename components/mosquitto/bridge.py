"""Persistent MQTT bridge that powers live state push for the Mosquitto integration.

Runs in the background as a single ``asyncio.Task``. Maintains:

* ``discovery``  — retained ``homeassistant/+/+/config`` payloads, keyed by topic.
* ``states``     — latest payload per ``state_topic`` (any topic that isn't
  discovery, bridge metadata, or Z2M control echoes).
* ``z2m_devices`` — last ``zigbee2mqtt/bridge/devices`` snapshot.

Subscribers (e.g. the SSE endpoint) call :meth:`subscribe` to receive
``{"type": "state", "topic": ..., "payload": ...}`` events as they arrive. The
bridge re-publishes those events through the shared event bus so the existing
extractor logic in :mod:`components.mosquitto.extract` can derive entity
diffs without re-parsing discovery itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
import re
from typing import Any, Optional


def slugify(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", str(value or "")).strip("-").lower() or "host"

log = logging.getLogger("integrations.mosquitto.bridge")

_HA_DISCOVERY_2 = "homeassistant/+/+/config"
_HA_DISCOVERY_3 = "homeassistant/+/+/+/config"
_Z2M_BRIDGE_DEVICES = "zigbee2mqtt/bridge/devices"
_Z2M_BRIDGE_INFO = "zigbee2mqtt/bridge/info"
_Z2M_BRIDGE_STATE = "zigbee2mqtt/bridge/state"
_Z2M_BRIDGE_EVENT = "zigbee2mqtt/bridge/event"
_Z2M_BRIDGE_RESPONSE = "zigbee2mqtt/bridge/response/#"
_Z2M_DEVICE_TOP = "zigbee2mqtt/#"

_RECONNECT_BACKOFF = (1, 2, 5, 10, 20, 30)
_Z2M_REFRESH_DELAY_SECONDS = 2.0
_Z2M_RECONCILE_DELAY_SECONDS = 3.0
_Z2M_RECONCILE_RETRIES = 3
_Z2M_RENAME_REQUEST = "zigbee2mqtt/bridge/request/device/rename"
_Z2M_RENAME_RESPONSE = "zigbee2mqtt/bridge/response/device/rename"
_MQTT311_CLIENT_ID_MAX_BYTES = 23
_HANDLE_CONCURRENCY = 48
_MSG_QUEUE_MAX = 10_000

_IEEE_RE = re.compile(r"^0x[0-9a-fA-F]{16}$")


def _is_z2m_non_state_topic(topic: str) -> bool:
    t = str(topic or "").strip().lower()
    return not t or t.endswith("/get") or "/set" in t


def _flatten_bridge_info(info: dict[str, Any]) -> dict[str, Any]:
    """Flatten ``bridge/info`` for state indexing and Hyve entity extract."""
    coord = info.get("coordinator") if isinstance(info.get("coordinator"), dict) else {}
    meta = coord.get("meta") if isinstance(coord.get("meta"), dict) else {}
    coord_label = str(coord.get("type") or "").strip()
    if meta.get("maintrel") is not None:
        coord_label = f"{coord_label} rev {meta.get('maintrel')}".strip()
    flat: dict[str, Any] = {
        "version": info.get("version"),
        "permit_join": info.get("permit_join"),
        "coordinator_type": coord_label or None,
    }
    return {k: v for k, v in flat.items() if v is not None}


def _normalize_bridge_state(data: Any) -> dict[str, Any]:
    raw = str((data or {}).get("state") if isinstance(data, dict) else "").strip().lower()
    if raw == "online":
        connection = "on"
    elif raw == "offline":
        connection = "off"
    else:
        connection = "unknown"
    return {"connection": connection, "state": raw or "unknown"}


def _mqtt_client_id(entry_key: str, host: str, port: int) -> str:
    """Stable MQTT client id per broker entry (MQTT 3.1.1 max 23 UTF-8 bytes)."""
    seed = f"{entry_key}|{host}|{port}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    client_id = f"hyve-{digest}"
    if len(client_id.encode("utf-8")) > _MQTT311_CLIENT_ID_MAX_BYTES:
        client_id = digest[:_MQTT311_CLIENT_ID_MAX_BYTES]
    return client_id


def _z2m_names_equal(a: str, b: str) -> bool:
    """Case/space/underscore-insensitive compare for Z2M friendly names."""

    def norm(s: str) -> str:
        return re.sub(r"[\s_]+", "", str(s or "").strip().lower())

    return norm(a) == norm(b)


def _repair_registry_name_from_yaml(
    ieee: str,
    row: dict[str, Any] | None,
    yaml_name: str,
) -> None:
    """Align SQLite registry when ``device_aliases.yaml`` is ahead of a stale row."""
    reg_name = str((row or {}).get("name") or "").strip()
    if not ieee or not yaml_name or _z2m_names_equal(reg_name, yaml_name):
        return
    try:
        from core import device_registry

        device_registry.set_device_name(
            ieee,
            yaml_name,
            source="mosquitto",
            z2m_friendly_name=yaml_name,
        )
    except Exception as exc:
        log.debug("registry repair from YAML failed for %s: %s", ieee, exc)


def _repair_yaml_alias_from_registry(ieee: str, reg_name: str) -> None:
    """Align ``device_aliases.yaml`` when SQLite registry is ahead of a stale alias."""
    if not ieee or not reg_name or _IEEE_RE.match(reg_name):
        return
    try:
        from integrations import device_aliases

        device_aliases.set_alias("mosquitto", ieee, reg_name)
    except Exception as exc:
        log.debug("YAML alias repair from registry failed for %s: %s", ieee, exc)


def _resolve_desired_z2m_name(
    ieee: str,
    friendly: str,
    row: dict[str, Any] | None,
    yaml_alias: str | None,
) -> str:
    """Pick the friendly_name Hyve wants Z2M to use for ``ieee``.

    Priority when sources disagree:
    - Z2M already matches tracked ``z2m_friendly_name`` → repair stale display/YAML
    - Z2M shows IEEE (lost name) → user registry, then YAML
    - Z2M already matches registry display name → repair stale YAML, do nothing
    - Z2M shows a third name → push user registry (not stale YAML)
    """
    yaml_name = str(yaml_alias or "").strip()
    reg_name = str((row or {}).get("name") or "").strip()
    z2m_stored = str((row or {}).get("z2m_friendly_name") or "").strip()
    name_by_user = bool((row or {}).get("name_by_user"))
    friendly = str(friendly or "").strip()
    if not friendly:
        return ""

    # Registry ``name`` can lag behind ``z2m_friendly_name`` after a Z2M-side
    # rename or a partial sync. Never push the stale display label back to Z2M
    # when the live bridge already matches our last recorded friendly_name.
    if (
        z2m_stored
        and not _IEEE_RE.match(z2m_stored)
        and _z2m_names_equal(z2m_stored, friendly)
    ):
        if reg_name and not _z2m_names_equal(reg_name, z2m_stored):
            _repair_registry_name_from_yaml(ieee, row, z2m_stored)
        if yaml_name and not _z2m_names_equal(yaml_name, z2m_stored):
            _repair_yaml_alias_from_registry(ieee, z2m_stored)
        return ""

    if (
        yaml_name
        and reg_name
        and name_by_user
        and not _z2m_names_equal(reg_name, yaml_name)
        and not _IEEE_RE.match(yaml_name)
    ):
        if _IEEE_RE.match(friendly):
            return reg_name
        if _z2m_names_equal(friendly, reg_name):
            _repair_yaml_alias_from_registry(ieee, reg_name)
            return ""
        if _z2m_names_equal(friendly, yaml_name):
            if not z2m_stored or _IEEE_RE.match(z2m_stored) or _z2m_names_equal(z2m_stored, yaml_name):
                _repair_registry_name_from_yaml(ieee, row, yaml_name)
            return ""
        return reg_name

    human_reg = reg_name if reg_name and not _IEEE_RE.match(reg_name) else ""

    # Z2M reports bare IEEE (lost friendly_name). Home Assistant relies on Z2M's
    # persisted config; Hyve re-sends the same ``device/rename`` MQTT request HA uses.
    if _IEEE_RE.match(friendly):
        if human_reg:
            if yaml_name and not _z2m_names_equal(yaml_name, human_reg):
                _repair_yaml_alias_from_registry(ieee, human_reg)
            return human_reg
        if yaml_name and not _IEEE_RE.match(yaml_name):
            return yaml_name
        return ""

    if human_reg and name_by_user:
        if not _z2m_names_equal(human_reg, friendly):
            return human_reg
        if yaml_name and not _z2m_names_equal(yaml_name, human_reg):
            _repair_yaml_alias_from_registry(ieee, human_reg)
        return ""

    if yaml_name and not _IEEE_RE.match(yaml_name) and not _z2m_names_equal(yaml_name, friendly):
        return yaml_name

    return ""


class MosquittoBridge:
    """Persistent MQTT subscriber + per-topic state cache."""

    def __init__(self, cfg: dict[str, Any], *, entry_key: str = "") -> None:
        self._cfg = dict(cfg or {})
        self._entry_key = str(entry_key or "").strip()
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._client = None  # aiomqtt.Client when running
        self._msg_queue: asyncio.Queue | None = None
        self._worker_tasks: list[asyncio.Task] = []
        self._z2m_refresh_task: Optional[asyncio.Task] = None
        self._z2m_reconcile_task: Optional[asyncio.Task] = None
        self._z2m_reconciled: set[str] = set()

        self._discovery: dict[str, dict[str, Any]] = {}
        self._states: dict[str, Any] = {}
        self._z2m_devices: list[Any] = []
        self._z2m_bridge_info: dict[str, Any] = {}
        self._z2m_bridge_state: dict[str, Any] = {}

        self._listeners: set[asyncio.Queue] = set()
        self._publish_lock = asyncio.Lock()
        self._mirror_nudge_task: Optional[asyncio.Task] = None
        self._states_persist_task: Optional[asyncio.Task] = None
        self._sleepy_refresh_task: Optional[asyncio.Task] = None

    def _store_key(self) -> str:
        if self._entry_key:
            return f"mosquitto:{self._entry_key[:8]}"
        return "mosquitto"

    # ── lifecycle ──────────────────────────────────────────────────────────

    def is_running(self) -> bool:
        return bool(self._task and not self._task.done())

    async def start(self) -> None:
        if self.is_running():
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="mqtt-bridge")
        log.info("MQTT bridge starting (host=%s)", self._cfg.get("host"))

    async def stop(self) -> None:
        self._stop.set()
        await self._stop_workers()
        task = self._task
        self._task = None
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        log.info("MQTT bridge stopped")

    # ── public API ────────────────────────────────────────────────────────

    def snapshot(self) -> dict[str, Any]:
        return {
            "broker": {"host": self._cfg.get("host"), "port": self._cfg.get("port")},
            "discovery": dict(self._discovery),
            "states": dict(self._states),
            "z2m_devices": list(self._z2m_devices),
            "z2m_bridge": {
                "info": dict(self._z2m_bridge_info),
                "state": dict(self._z2m_bridge_state),
            },
        }

    def purge_discovery_for_device(
        self,
        device_ieee: str,
        old_friendly_names: list[str] | None = None,
    ) -> int:
        """Drop cached HA discovery rows for a device after rename.

        Retained MQTT configs for the old friendly name linger until Z2M
        republishes with ``homeassistant_rename``; Hyve must not keep serving
        them from the in-memory cache (or SQLite snapshot after sync).
        """
        try:
            from integrations.device_aliases import canonical_device_id
        except Exception:
            canonical_device_id = lambda x: str(x or "").strip()  # type: ignore[assignment]

        ieee_key = canonical_device_id(device_ieee) or str(device_ieee or "").strip()
        old_names = {
            str(n or "").strip().lower()
            for n in (old_friendly_names or [])
            if str(n or "").strip()
        }
        if not ieee_key and not old_names:
            return 0

        removed = 0
        for topic in list(self._discovery.keys()):
            msg = self._discovery.get(topic)
            if not isinstance(msg, dict):
                continue
            device = msg.get("device") or msg.get("dev") or {}
            identifiers = device.get("identifiers") or device.get("ids") or []
            if isinstance(identifiers, str):
                identifiers = [identifiers]
            matches_ieee = False
            for ident in identifiers:
                ident_s = str(ident or "").strip()
                if ident_s.lower().startswith("zigbee2mqtt_"):
                    ident_s = ident_s[len("zigbee2mqtt_"):]
                if canonical_device_id(ident_s) == ieee_key:
                    matches_ieee = True
                    break
            if not matches_ieee or not old_names:
                continue
            dev_name = str(device.get("name") or "").strip().lower()
            state_topic = str(msg.get("state_topic") or msg.get("stat_t") or "").lower()
            parts = topic.split("/")
            object_id = str(parts[-2] if len(parts) >= 2 and topic.endswith("/config") else "").lower()
            stale = dev_name in old_names or object_id in old_names
            if not stale:
                for old in old_names:
                    slug = old.replace(" ", "_").lower()
                    if (
                        f"zigbee2mqtt/{old.lower()}" in state_topic
                        or (slug and slug in object_id)
                    ):
                        stale = True
                        break
            if stale:
                self._discovery.pop(topic, None)
                removed += 1
        if removed:
            log.info(
                "Purged %d stale HA discovery topic(s) for %s after rename",
                removed,
                ieee_key or list(old_names),
            )
        return removed

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._listeners.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._listeners.discard(q)

    def _sync_device_registry(self, devices: list[Any]) -> None:
        try:
            from core import device_registry

            device_registry.bootstrap_from_aliases()
            device_registry.sync_z2m_devices(
                devices,
                source="mosquitto",
                config_entry_id=self._entry_key,
            )
        except Exception as exc:
            log.debug("device registry sync failed: %s", exc)

    def resolve_z2m_rename_from(self, device_id: str, hint: str | None = None) -> str:
        """Return the ``from`` value Z2M expects for device/rename.

        Prefer the live ``friendly_name`` from the bridge snapshot so Hyve-side
        aliases do not drift from what Z2M still has configured.
        """
        try:
            from integrations import device_aliases
        except Exception:
            device_aliases = None  # type: ignore[assignment]

        canonical = (
            device_aliases.canonical_device_id(device_id)
            if device_aliases is not None
            else str(device_id or "").strip()
        ) or str(device_id or "").strip()
        hint = (hint or "").strip()

        for d in self._z2m_devices:
            if not isinstance(d, dict):
                continue
            ieee = str(d.get("ieee_address") or "").strip()
            if not ieee:
                continue
            ieee_key = (
                device_aliases.canonical_device_id(ieee)
                if device_aliases is not None
                else ieee.lower()
            )
            if canonical and ieee_key == canonical:
                friendly = str(d.get("friendly_name") or "").strip()
                if friendly:
                    return friendly
                return canonical or ieee

        if hint and hint.lower() != canonical.lower():
            for d in self._z2m_devices:
                if not isinstance(d, dict):
                    continue
                friendly = str(d.get("friendly_name") or "").strip()
                if friendly and friendly == hint:
                    return friendly

        if hint:
            return hint
        return canonical

    async def request_z2m_device_rename(
        self,
        from_name: str,
        to_name: str,
        *,
        homeassistant_rename: bool = False,
    ) -> None:
        """Publish Z2M ``bridge/request/device/rename`` on the live bridge MQTT client.

        Home Assistant uses the same topic; ``homeassistant_rename: true`` tells Z2M
        to persist the new ``friendly_name`` *and* republish MQTT discovery topics
        so entity IDs follow the rename.
        """
        current = str(from_name or "").strip()
        target = str(to_name or "").strip()
        if not current or not target or current == target:
            return
        payload_obj: dict[str, Any] = {"from": current, "to": target}
        if homeassistant_rename:
            payload_obj["homeassistant_rename"] = True
        await self.publish(
            _Z2M_RENAME_REQUEST,
            json.dumps(payload_obj, ensure_ascii=False),
        )

    async def publish(self, topic: str, payload: str) -> None:
        client = self._client
        if client is None:
            raise RuntimeError("MQTT bridge nu este conectat")
        async with self._publish_lock:
            await client.publish(topic, payload, qos=0, retain=False)

    # ── internals ─────────────────────────────────────────────────────────

    async def _start_workers(self) -> None:
        await self._stop_workers()
        self._msg_queue = asyncio.Queue(maxsize=_MSG_QUEUE_MAX)
        self._worker_tasks = [
            asyncio.create_task(self._msg_worker(i), name=f"mqtt-worker-{i}")
            for i in range(_HANDLE_CONCURRENCY)
        ]

    async def _stop_workers(self) -> None:
        tasks = self._worker_tasks
        self._worker_tasks = []
        self._msg_queue = None
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _msg_worker(self, worker_id: int) -> None:
        del worker_id
        while not self._stop.is_set():
            queue = self._msg_queue
            if queue is None:
                return
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            try:
                await self._handle(msg)
            except Exception as exc:
                log.debug("MQTT handle failed for %s: %s", getattr(msg, "topic", "?"), exc)
            finally:
                queue.task_done()

    def _enqueue_message(self, msg: Any) -> None:
        queue = self._msg_queue
        if queue is None:
            return
        try:
            queue.put_nowait(msg)
        except asyncio.QueueFull:
            topic = getattr(msg, "topic", "?")
            log.warning("MQTT message queue full (%s); dropping message on %s", _MSG_QUEUE_MAX, topic)

    async def _run(self) -> None:
        import aiomqtt

        host = (self._cfg.get("host") or "localhost").strip()
        port = int(self._cfg.get("port") or 1883)
        username = (self._cfg.get("username") or "").strip() or None
        password = self._cfg.get("password") or None

        attempt = 0
        stable_reset_seconds = 10.0
        # Use clean_session=True so the broker does NOT queue messages for us
        # while offline. A persistent session (clean_session=False) with the
        # wildcard zigbee2mqtt/+ topic at QoS 1 accumulates every device state
        # update while the server is stopped; on reconnect the broker floods
        # the client with the full backlog, overwhelming paho-mqtt's buffers
        # and causing an immediate "Disconnected during message iteration"
        # crash-loop. The debounced _refresh_z2m_states() call handles catch-up
        # after the initial retained-message burst settles.
        client_id = _mqtt_client_id(self._entry_key or host, host, port)
        connected_at: float | None = None
        while not self._stop.is_set():
            try:
                async with aiomqtt.Client(
                    hostname=host,
                    port=port,
                    username=username,
                    password=password,
                    identifier=client_id,
                    clean_session=True,
                    keepalive=60,
                ) as client:
                    self._client = client
                    connected_at = time.monotonic()
                    # With clean sessions, we do not rely on broker-side
                    # queueing while offline; keep subscriptions at QoS 0 to
                    # reduce per-message ACK overhead during high traffic.
                    await client.subscribe(_HA_DISCOVERY_2, qos=0)
                    await client.subscribe(_HA_DISCOVERY_3, qos=0)
                    await client.subscribe(_Z2M_BRIDGE_DEVICES, qos=0)
                    await client.subscribe(_Z2M_BRIDGE_EVENT, qos=0)
                    await client.subscribe(_Z2M_BRIDGE_RESPONSE, qos=0)
                    await client.subscribe(_Z2M_DEVICE_TOP, qos=0)
                    from core.logger import log_line
                    log_line("sys", "📡", "MQTT", f"connected to {host}:{port}")
                    await self._dispatch({"type": "bridge", "status": "connected"})
                    if self._z2m_devices:
                        self._schedule_z2m_refresh(self._z2m_devices)
                    await self._start_workers()
                    try:
                        async for msg in client.messages:
                            if self._stop.is_set():
                                break
                            self._enqueue_message(msg)
                    finally:
                        await self._stop_workers()
                    # Reaching here means message loop ended without raising.
                    # If it stayed up for a while, clear reconnect penalties.
                    if connected_at is not None and (time.monotonic() - connected_at) >= stable_reset_seconds:
                        attempt = 0
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._client = None
                # Long-lived sessions should not inherit a maxed-out backoff after
                # a single broker-side disconnect (common after message bursts).
                if connected_at is not None and (time.monotonic() - connected_at) >= stable_reset_seconds:
                    attempt = 0
                wait = _RECONNECT_BACKOFF[min(attempt, len(_RECONNECT_BACKOFF) - 1)]
                attempt += 1
                reason = str(exc).split("\n")[0]
                cause = getattr(exc, "__cause__", None)
                if cause is not None:
                    cause_text = str(cause).split("\n")[0].strip()
                    if cause_text and cause_text not in reason:
                        reason = f"{reason} ({cause_text})"
                if len(reason) > 120:
                    reason = reason[:117] + "..."
                from core.logger import log_line
                hint = ""
                if "Disconnected during message iteration" in reason:
                    hint = " — broker closed link (often message burst or keepalive)"
                log_line("error", "📡", "MQTT", f"disconnected — {reason}{hint} (retry in {wait}s)")
                await self._dispatch({"type": "bridge", "status": "disconnected", "error": str(exc)})
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=wait)
                    break
                except asyncio.TimeoutError:
                    continue
            finally:
                self._client = None
                connected_at = None
                refresh = self._z2m_refresh_task
                self._z2m_refresh_task = None
                if refresh is not None and not refresh.done():
                    refresh.cancel()

    def _schedule_z2m_refresh(self, devices: list[Any]) -> None:
        """Debounce Z2M /get refresh so reconnect retained bursts don't flood the link."""
        task = self._z2m_refresh_task
        if task is not None and not task.done():
            task.cancel()

        async def _delayed() -> None:
            try:
                await asyncio.sleep(_Z2M_REFRESH_DELAY_SECONDS)
                if not self._stop.is_set():
                    await self._refresh_z2m_states(devices)
                    self._schedule_sleepy_device_refresh(devices)
            except asyncio.CancelledError:
                pass

        self._z2m_refresh_task = asyncio.create_task(_delayed())

    def _schedule_sleepy_device_refresh(self, devices: list[Any]) -> None:
        """Retry /get for battery-powered devices that did not answer the first poll."""
        task = self._sleepy_refresh_task
        if task is not None and not task.done():
            task.cancel()

        async def _delayed() -> None:
            try:
                await asyncio.sleep(12.0)
                if self._stop.is_set():
                    return
                missing: list[dict[str, Any]] = []
                for raw in devices:
                    if not isinstance(raw, dict) or raw.get("type") == "Coordinator":
                        continue
                    if raw.get("disabled"):
                        continue
                    friendly = str(raw.get("friendly_name") or "").strip()
                    if not friendly or _IEEE_RE.match(friendly):
                        continue
                    topic = f"zigbee2mqtt/{friendly}"
                    if topic not in self._states:
                        missing.append(raw)
                if missing:
                    await self._refresh_z2m_states(missing)
            except asyncio.CancelledError:
                pass

        self._sleepy_refresh_task = asyncio.create_task(_delayed())

    def _schedule_states_persist(self) -> None:
        """Debounced write of live MQTT states into the integration entity store."""
        task = self._states_persist_task
        if task is not None and not task.done():
            return

        async def _delayed() -> None:
            try:
                await asyncio.sleep(1.5)
                if self._stop.is_set():
                    return
                await self._persist_states_to_store()
            except asyncio.CancelledError:
                pass

        self._states_persist_task = asyncio.create_task(_delayed())

    async def _persist_states_to_store(self) -> None:
        if not self._states:
            return
        store_key = self._store_key()
        try:
            from core.entity_store import get_entity_store

            store = get_entity_store()
            row = store.get_entities(store_key) or {}
            payload = dict(row.get("entities") or {})
            if not isinstance(payload, dict):
                payload = {}
            payload["states"] = {
                k: v
                for k, v in dict(self._states).items()
                if not _is_z2m_non_state_topic(k)
            }
            if self._z2m_devices:
                payload["z2m_devices"] = list(self._z2m_devices)
            if self._z2m_bridge_info or self._z2m_bridge_state:
                payload["z2m_bridge"] = {
                    "info": dict(self._z2m_bridge_info),
                    "state": dict(self._z2m_bridge_state),
                }
            if self._discovery:
                payload["discovery"] = dict(self._discovery)
            store.set_entities(store_key, payload, error=row.get("last_error"))
        except Exception as exc:
            log.debug("persist MQTT states failed for %s: %s", store_key, exc)

    def _schedule_z2m_name_reconcile(self, devices: list[Any]) -> None:
        """Push Hyve-side renames back to Z2M when upstream forgot them."""
        task = self._z2m_reconcile_task
        if task is not None and not task.done():
            task.cancel()

        async def _delayed() -> None:
            try:
                await asyncio.sleep(_Z2M_RECONCILE_DELAY_SECONDS)
                if not self._stop.is_set():
                    await self._reconcile_z2m_friendly_names(devices)
            except asyncio.CancelledError:
                pass

        self._z2m_reconcile_task = asyncio.create_task(_delayed())

    async def _wait_for_mqtt_client(self, *, timeout_seconds: float = 15.0) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if self._stop.is_set():
                return False
            if self._client is not None:
                return True
            await asyncio.sleep(0.25)
        return False

    async def _reconcile_z2m_friendly_names(self, devices: list[Any]) -> None:
        """Push Hyve-side names to Z2M when upstream reports IEEE or a stale name.

        Home Assistant does not run this on startup — it relies on Z2M's own
        ``data/configuration.yaml`` persistence. Hyve keeps a local registry/YAML
        copy and re-applies user names when Z2M forgot them after a restart.
        """
        try:
            from integrations import device_aliases
            from core import device_registry
        except Exception:
            return

        if not await self._wait_for_mqtt_client():
            log.warning("Z2M name reconcile skipped: MQTT client not connected")
            return

        pending: list[tuple[str, str, str]] = []
        for raw in devices:
            if not isinstance(raw, dict) or raw.get("type") == "Coordinator":
                continue
            ieee = device_aliases.canonical_device_id(raw.get("ieee_address"))
            friendly = str(raw.get("friendly_name") or "").strip()
            if not ieee or not friendly:
                continue
            if ieee in self._z2m_reconciled:
                continue

            row = device_registry.get_device(ieee)
            yaml_alias = device_aliases.get_alias("mosquitto", ieee)
            desired = _resolve_desired_z2m_name(ieee, friendly, row, yaml_alias)
            if not desired or _IEEE_RE.match(desired) or _z2m_names_equal(desired, friendly):
                continue
            from_name = ieee if _IEEE_RE.match(friendly) else self.resolve_z2m_rename_from(ieee, friendly)
            pending.append((ieee, from_name, desired))

        if not pending:
            return

        for ieee, from_name, desired in pending:
            ok = False
            for attempt in range(_Z2M_RECONCILE_RETRIES):
                try:
                    await self.request_z2m_device_rename(
                        from_name,
                        desired,
                        homeassistant_rename=True,
                    )
                    ok = True
                    break
                except Exception as exc:
                    log.debug(
                        "Z2M name reconcile attempt %s for %s failed: %s",
                        attempt + 1,
                        ieee,
                        exc,
                    )
                    if attempt + 1 < _Z2M_RECONCILE_RETRIES:
                        await asyncio.sleep(1.0 + attempt)
            if ok:
                self._z2m_reconciled.add(ieee)
                self._patch_z2m_device_friendly_name(ieee, desired)
                try:
                    device_registry.set_device_name(
                        ieee,
                        desired,
                        source="mosquitto",
                        config_entry_id=self._entry_key,
                        z2m_friendly_name=desired,
                    )
                except Exception as exc:
                    log.debug("registry update after reconcile failed for %s: %s", ieee, exc)
                log.info("Reconciled Z2M friendly_name for %s -> %s", ieee, desired)
            else:
                log.warning("Z2M name reconcile failed for %s -> %s", ieee, desired)

    def _patch_z2m_device_friendly_name(self, ieee: str, friendly_name: str) -> None:
        try:
            from integrations import device_aliases
        except Exception:
            device_aliases = None  # type: ignore[assignment]
        target = (
            device_aliases.canonical_device_id(ieee)
            if device_aliases is not None
            else str(ieee or "").strip().lower()
        )
        for item in self._z2m_devices:
            if not isinstance(item, dict):
                continue
            key = str(item.get("ieee_address") or "").strip()
            if device_aliases is not None:
                key = device_aliases.canonical_device_id(key) or key
            if key == target:
                item["friendly_name"] = friendly_name
                break

    async def _handle(self, msg: Any) -> None:
        topic = str(msg.topic)
        raw_bytes = bytes(msg.payload)
        raw = raw_bytes.decode("utf-8", errors="replace")
        try:
            data: Any = json.loads(raw)
        except json.JSONDecodeError:
            data = raw

        if topic == _Z2M_BRIDGE_DEVICES and isinstance(data, list):
            self._z2m_devices = data
            await self._dispatch({"type": "z2m_devices", "count": len(data)})
            self._sync_device_registry(data)
            self._schedule_z2m_name_reconcile(data)
            self._schedule_z2m_refresh(data)
            self._schedule_mirror_nudge()
            return

        if topic == _Z2M_BRIDGE_INFO and isinstance(data, dict):
            self._z2m_bridge_info = dict(data)
            flat = _flatten_bridge_info(data)
            self._states[_Z2M_BRIDGE_INFO] = flat
            await self._dispatch({"type": "state", "topic": _Z2M_BRIDGE_INFO, "payload": flat})
            self._schedule_mirror_nudge()
            self._schedule_states_persist()
            return

        if topic == _Z2M_BRIDGE_STATE and isinstance(data, dict):
            self._z2m_bridge_state = dict(data)
            flat = _normalize_bridge_state(data)
            self._states[_Z2M_BRIDGE_STATE] = flat
            await self._dispatch({"type": "state", "topic": _Z2M_BRIDGE_STATE, "payload": flat})
            self._schedule_mirror_nudge()
            self._schedule_states_persist()
            return

        if topic == _Z2M_BRIDGE_EVENT:
            await self._dispatch({"type": "z2m_event", "payload": data})
            return

        if topic.startswith("zigbee2mqtt/bridge/response/"):
            await self._handle_bridge_response(topic, data)
            return

        if topic.startswith("homeassistant/") and topic.endswith("/config"):
            if isinstance(data, dict):
                self._discovery[topic] = data
                await self._dispatch({"type": "discovery", "topic": topic})
            elif data in (None, "", b""):
                self._discovery.pop(topic, None)
                await self._dispatch({"type": "discovery_removed", "topic": topic})
            return

        # Treat anything else as state. Skip Z2M control echoes (/set, /get).
        if _is_z2m_non_state_topic(topic):
            return
        if topic.startswith("zigbee2mqtt/bridge/"):
            return

        self._states[topic] = data
        await self._dispatch({"type": "state", "topic": topic, "payload": data})
        self._schedule_mirror_nudge()
        self._schedule_states_persist()

    async def _handle_bridge_response(self, topic: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        await self._dispatch({"type": "z2m_bridge_response", "topic": topic, "payload": data})
        if topic != _Z2M_RENAME_RESPONSE:
            return
        if str(data.get("status") or "").lower() != "ok":
            return
        payload = data.get("data") if isinstance(data.get("data"), dict) else {}
        asyncio.create_task(
            self._after_device_rename(
                payload,
                homeassistant_rename=bool(payload.get("homeassistant_rename")),
            )
        )

    async def _after_device_rename(
        self,
        payload: dict[str, Any],
        *,
        homeassistant_rename: bool,
    ) -> None:
        """Refresh Hyve caches after Z2M confirms a device rename."""
        old_name = str(payload.get("from") or "").strip()
        new_name = str(payload.get("to") or "").strip()
        if not new_name:
            return
        device_id = ""
        registry_row: dict[str, Any] | None = None
        try:
            from core import device_registry

            device_id = device_registry.resolve_device_id_from_z2m_devices(
                old_name,
                self._z2m_devices,
            ) or ""
            if not device_id:
                from integrations import device_aliases

                candidate = device_aliases.canonical_device_id(old_name)
                if candidate and _IEEE_RE.match(candidate):
                    device_id = candidate
            if device_id:
                registry_row = device_registry.get_device(device_id)
        except Exception:
            device_id = ""
            registry_row = None

        if registry_row and registry_row.get("name_by_user"):
            reg_name = str(registry_row.get("name") or "").strip()
            if reg_name and not _z2m_names_equal(reg_name, new_name):
                log.info(
                    "Ignoring Z2M rename %s -> %s; keeping user name %s for %s",
                    old_name,
                    new_name,
                    reg_name,
                    device_id,
                )
                if device_id:
                    self._patch_z2m_device_friendly_name(device_id, reg_name)
                return

        if device_id:
            self._patch_z2m_device_friendly_name(device_id, new_name)

        # Renames initiated by Hyve (UI or startup reconcile) already updated
        # device_registry + device_aliases.yaml before the MQTT request. The Z2M
        # echo must not rewrite YAML/SQLite — that loop is what resurrects stale
        # names such as an old Z2M friendly_name after the user renamed the device.
        if not homeassistant_rename:
            try:
                from core import device_registry

                if device_id and new_name:
                    device_registry.set_device_name(
                        device_id,
                        new_name,
                        source="mosquitto",
                        config_entry_id=self._entry_key,
                        z2m_friendly_name=new_name,
                    )
            except Exception as exc:
                log.debug("post-rename registry update failed: %s", exc)
            try:
                from integrations import device_aliases

                if device_id and new_name:
                    device_aliases.set_alias("mosquitto", device_id, new_name)
            except Exception as exc:
                log.debug("post-rename alias update failed: %s", exc)
        elif device_id and old_name and new_name:
            try:
                from core import entity_registry

                entity_registry.refresh_entity_ids_for_device_rename(
                    device_id,
                    old_friendly=old_name,
                    old_friendly_names=[old_name],
                    new_friendly=new_name,
                )
            except Exception as exc:
                log.debug("post-rename entity refresh failed: %s", exc)

        if homeassistant_rename:
            try:
                aliases = [old_name]
                if device_id:
                    from integrations import device_aliases

                    prev = device_aliases.get_alias("mosquitto", device_id)
                    if prev and prev != new_name:
                        aliases.append(prev)
                self.purge_discovery_for_device(device_id or old_name, aliases)
            except Exception as exc:
                log.debug("post-rename discovery purge failed: %s", exc)
            try:
                from core.entity_catalog import invalidate_entity_cache

                invalidate_entity_cache()
            except Exception as exc:
                log.debug("rename cache invalidate failed: %s", exc)
            try:
                from core.mirror_nudge import nudge_entity_mirror

                nudge_entity_mirror(self._store_key())
            except Exception as exc:
                log.debug("rename mirror nudge failed: %s", exc)
            log.info(
                "Z2M rename with HA rediscovery: %s -> %s",
                old_name,
                new_name,
            )

    async def _after_ha_rename(self, payload: dict[str, Any]) -> None:
        """Backward-compatible wrapper for older call sites."""
        await self._after_device_rename(payload, homeassistant_rename=True)

    async def _dispatch(self, event: dict[str, Any]) -> None:
        if not self._listeners:
            return
        for q in list(self._listeners):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Drop the oldest event but keep the subscriber — evicting slow
                # consumers permanently was causing live state to freeze.
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(event)

    def _schedule_mirror_nudge(self) -> None:
        """Debounced EntityMirror refresh after live MQTT state (HA instant-update pattern)."""
        task = self._mirror_nudge_task
        if task is not None and not task.done():
            return

        async def _delayed() -> None:
            try:
                await asyncio.sleep(0.35)
                if self._stop.is_set():
                    return
                from core.mirror_nudge import nudge_entity_mirror

                nudge_entity_mirror(self._store_key())
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                log.debug("mirror nudge failed: %s", exc)

        self._mirror_nudge_task = asyncio.create_task(_delayed())

    def _schedule_mirror_nudge_after_refresh(self) -> None:
        """Rebuild entity mirror after /get responses have time to arrive."""

        async def _delayed() -> None:
            try:
                await asyncio.sleep(3.0)
                if self._stop.is_set():
                    return
                from core.mirror_nudge import nudge_entity_mirror

                nudge_entity_mirror(self._store_key())
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                log.debug("post-refresh mirror nudge failed: %s", exc)

        asyncio.create_task(_delayed())

    async def _refresh_z2m_states(self, devices: list[Any]) -> None:
        """Ask Z2M to republish current state for each device via ``/get``.

        Requests every readable expose property (battery, linkquality, state_lN,
        etc.), not only ``state`` — remotes and sensors otherwise stay ``unknown``.
        """
        from components.mosquitto.extract import z2m_get_payload_for_device

        client = self._client
        if client is None:
            return

        sent = 0
        for d in devices:
            if not isinstance(d, dict):
                continue
            if d.get("type") == "Coordinator":
                continue
            if d.get("disabled"):
                continue
            friendly = (d.get("friendly_name") or "").strip()
            if not friendly:
                continue
            topic = f"zigbee2mqtt/{friendly}/get"
            payload_obj = z2m_get_payload_for_device(d)
            try:
                async with self._publish_lock:
                    await client.publish(
                        topic,
                        json.dumps(payload_obj, ensure_ascii=False),
                        qos=0,
                        retain=False,
                    )
                sent += 1
            except Exception as exc:
                log.debug("z2m get failed for %s: %s", friendly, exc)
            await asyncio.sleep(0.05)
        if sent:
            log.info("MQTT bridge requested state refresh for %d Z2M devices", sent)
            self._schedule_mirror_nudge_after_refresh()


# ── module singleton ───────────────────────────────────────────────────────


# Registry keyed by config-entry id so multiple Mosquitto brokers can each run
# their own live bridge. Empty-string key is the legacy/single-broker slot.
_bridges: dict[str, MosquittoBridge] = {}


def get_bridge(key: Optional[str] = None) -> Optional[MosquittoBridge]:
    """Return the bridge for ``key`` (config-entry id).

    Falls back to the only running bridge when the exact key is absent so the
    common single-broker setup (and legacy callers passing no key) keeps working.
    """
    if key is not None and key in _bridges:
        return _bridges[key]
    running = [b for b in _bridges.values() if b.is_running()]
    if len(running) == 1:
        return running[0]
    if key is None and running:
        return running[0]
    return None


async def start_bridge(cfg: dict[str, Any], key: str = "") -> MosquittoBridge:
    existing = _bridges.get(key)
    if existing is not None and existing.is_running():
        return existing
    bridge = MosquittoBridge(cfg, entry_key=key)
    _bridges[key] = bridge
    await bridge.start()
    return bridge


async def stop_bridge(key: Optional[str] = None) -> None:
    """Stop one bridge (by key) or all of them when key is None."""
    keys = [key] if key is not None else list(_bridges.keys())
    for k in keys:
        bridge = _bridges.pop(k, None)
        if bridge is None:
            continue
        try:
            await bridge.stop()
        except Exception:
            pass
