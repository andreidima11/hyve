"""Persistent MQTT bridge that powers live state push for the Mosquitto integration.

Runs in the background as a single ``asyncio.Task``. Maintains:

* ``discovery``  — retained ``homeassistant/+/+/config`` payloads, keyed by topic.
* ``states``     — latest payload per ``state_topic`` (any topic that isn't
  discovery, bridge metadata, or Z2M control echoes).
* ``z2m_devices`` — last ``zigbee2mqtt/bridge/devices`` snapshot.

Subscribers (e.g. the SSE endpoint) call :meth:`subscribe` to receive
``{"type": "state", "topic": ..., "payload": ...}`` events as they arrive. The
bridge re-publishes those events through the shared event bus so the existing
extractor logic in :mod:`integrations.providers.mosquitto` can derive entity
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
_Z2M_BRIDGE_EVENT = "zigbee2mqtt/bridge/event"
_Z2M_BRIDGE_RESPONSE = "zigbee2mqtt/bridge/response/#"
_Z2M_DEVICE_TOP = "zigbee2mqtt/+"

_RECONNECT_BACKOFF = (1, 2, 5, 10, 20, 30)
_Z2M_REFRESH_DELAY_SECONDS = 5.0
_MQTT311_CLIENT_ID_MAX_BYTES = 23
_HANDLE_CONCURRENCY = 48

_IEEE_RE = re.compile(r"^0x[0-9a-fA-F]{16}$")


def _mqtt_client_id(entry_key: str, host: str, port: int) -> str:
    """Stable MQTT client id per broker entry (MQTT 3.1.1 max 23 UTF-8 bytes)."""
    seed = f"{entry_key}|{host}|{port}"
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    client_id = f"hyve-{digest}"
    if len(client_id.encode("utf-8")) > _MQTT311_CLIENT_ID_MAX_BYTES:
        client_id = digest[:_MQTT311_CLIENT_ID_MAX_BYTES]
    return client_id


def _persist_z2m_friendly_names(devices: list[Any]) -> None:
    """Auto-save Z2M friendly names as device aliases so they survive restarts.

    Only writes when no local alias exists yet (respects Hyve-side renames).
    Skips names that are raw IEEE addresses.
    """
    try:
        from integrations import device_aliases
    except Exception:
        return
    for d in devices:
        if not isinstance(d, dict) or d.get("type") == "Coordinator":
            continue
        ieee = (d.get("ieee_address") or "").strip()
        friendly = (d.get("friendly_name") or "").strip()
        if not ieee or not friendly:
            continue
        if _IEEE_RE.match(friendly):
            continue
        existing = device_aliases.get_alias("mosquitto", ieee)
        if existing:
            continue
        try:
            device_aliases.set_alias("mosquitto", ieee, friendly)
        except Exception:
            pass


class MosquittoBridge:
    """Persistent MQTT subscriber + per-topic state cache."""

    def __init__(self, cfg: dict[str, Any], *, entry_key: str = "") -> None:
        self._cfg = dict(cfg or {})
        self._entry_key = str(entry_key or "").strip()
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._client = None  # aiomqtt.Client when running
        self._handle_sem = asyncio.Semaphore(_HANDLE_CONCURRENCY)
        self._z2m_refresh_task: Optional[asyncio.Task] = None
        self._z2m_reconcile_task: Optional[asyncio.Task] = None
        self._z2m_reconciled: set[str] = set()

        self._discovery: dict[str, dict[str, Any]] = {}
        self._states: dict[str, Any] = {}
        self._z2m_devices: list[Any] = []

        self._listeners: set[asyncio.Queue] = set()
        self._publish_lock = asyncio.Lock()

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
        }

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

    async def publish(self, topic: str, payload: str) -> None:
        client = self._client
        if client is None:
            raise RuntimeError("MQTT bridge nu este conectat")
        async with self._publish_lock:
            await client.publish(topic, payload, qos=0, retain=False)

    # ── internals ─────────────────────────────────────────────────────────

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
                    from logger import log_line
                    log_line("sys", "📡", "MQTT", f"connected to {host}:{port}")
                    await self._dispatch({"type": "bridge", "status": "connected"})
                    async for msg in client.messages:
                        if self._stop.is_set():
                            break
                        asyncio.create_task(self._handle_safe(msg))
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
                from logger import log_line
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

    async def _handle_safe(self, msg: Any) -> None:
        async with self._handle_sem:
            try:
                await self._handle(msg)
            except Exception as exc:
                log.debug("MQTT handle failed for %s: %s", getattr(msg, "topic", "?"), exc)

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
            except asyncio.CancelledError:
                pass

        self._z2m_refresh_task = asyncio.create_task(_delayed())

    def _schedule_z2m_name_reconcile(self, devices: list[Any]) -> None:
        """Push Hyve-side renames back to Z2M when upstream forgot them."""
        task = self._z2m_reconcile_task
        if task is not None and not task.done():
            task.cancel()

        async def _delayed() -> None:
            try:
                await asyncio.sleep(2.0)
                if not self._stop.is_set():
                    await self._reconcile_z2m_friendly_names(devices)
            except asyncio.CancelledError:
                pass

        self._z2m_reconcile_task = asyncio.create_task(_delayed())

    async def _reconcile_z2m_friendly_names(self, devices: list[Any]) -> None:
        """Re-apply user-chosen names when Z2M still reports the raw IEEE."""
        try:
            from integrations import device_aliases
            from core import device_registry
        except Exception:
            return

        pending: list[tuple[str, str, str]] = []
        for raw in devices:
            if not isinstance(raw, dict) or raw.get("type") == "Coordinator":
                continue
            ieee = device_aliases.canonical_device_id(raw.get("ieee_address"))
            friendly = str(raw.get("friendly_name") or "").strip()
            if not ieee or not friendly or not _IEEE_RE.match(friendly):
                continue
            if ieee in self._z2m_reconciled:
                continue

            desired = device_aliases.get_alias("mosquitto", ieee)
            row = device_registry.get_device(ieee)
            if not desired and row and row.get("name_by_user"):
                desired = str(row.get("name") or "").strip()
            if not desired or _IEEE_RE.match(desired) or desired == friendly:
                continue
            pending.append((ieee, friendly, desired))

        if not pending:
            return

        rename_fn = None
        try:
            from integrations import get_integration_manager

            inst = get_integration_manager().get("mosquitto")
            rename_fn = getattr(inst, "rename_zigbee_device", None) if inst else None
        except Exception:
            rename_fn = None
        if not callable(rename_fn):
            return

        for ieee, friendly, desired in pending:
            try:
                await rename_fn(
                    friendly,
                    desired,
                    device_id=ieee,
                    homeassistant_rename=False,
                )
                self._z2m_reconciled.add(ieee)
                log.info("Reconciled Z2M friendly_name for %s -> %s", ieee, desired)
            except Exception as exc:
                log.debug("Z2M name reconcile failed for %s: %s", ieee, exc)

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
            _persist_z2m_friendly_names(data)
            self._schedule_z2m_name_reconcile(data)
            self._schedule_z2m_refresh(data)
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

        # Treat anything else as state. Skip Z2M /set echoes.
        if "/set" in topic:
            return
        if topic.startswith("zigbee2mqtt/bridge/"):
            return

        self._states[topic] = data
        await self._dispatch({"type": "state", "topic": topic, "payload": data})

    async def _handle_bridge_response(self, topic: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        await self._dispatch({"type": "z2m_bridge_response", "topic": topic, "payload": data})
        if topic != "zigbee2mqtt/bridge/response/device/rename":
            return
        if str(data.get("status") or "").lower() != "ok":
            return
        payload = data.get("data") if isinstance(data.get("data"), dict) else {}
        if not payload.get("homeassistant_rename"):
            return
        asyncio.create_task(self._after_ha_rename(payload))

    async def _after_ha_rename(self, payload: dict[str, Any]) -> None:
        """Discovery topics are republished by Z2M; refresh Hyve caches and IDs."""
        old_name = str(payload.get("from") or "").strip()
        new_name = str(payload.get("to") or "").strip()
        try:
            from core import device_registry, entity_registry

            device_id = device_registry.resolve_device_id_from_z2m_devices(
                old_name,
                self._z2m_devices,
            )
            if device_id and new_name:
                device_registry.set_device_name(
                    device_id,
                    new_name,
                    source="mosquitto",
                    config_entry_id=self._entry_key,
                    z2m_friendly_name=new_name,
                )
            if device_id and old_name and new_name:
                entity_registry.refresh_entity_ids_for_device_rename(
                    device_id,
                    old_friendly=old_name,
                    old_friendly_names=[old_name],
                    new_friendly=new_name,
                )
        except Exception as exc:
            log.debug("post-rename registry update failed: %s", exc)
        try:
            from integrations import device_aliases

            device_id = device_aliases.canonical_device_id(old_name)
            if not device_id:
                from core import device_registry

                device_id = device_registry.resolve_device_id_from_z2m_devices(
                    old_name,
                    self._z2m_devices,
                )
            if device_id and new_name:
                device_aliases.set_alias("mosquitto", device_id, new_name)
        except Exception as exc:
            log.debug("post-rename alias update failed: %s", exc)
        try:
            from routers.integrations import helpers

            helpers.invalidate_all_entities_cache()
        except Exception as exc:
            log.debug("rename cache invalidate failed: %s", exc)
        try:
            from core.mirror_nudge import nudge_entity_mirror

            nudge_entity_mirror(self._entry_key or "mosquitto")
        except Exception as exc:
            log.debug("rename mirror nudge failed: %s", exc)
        log.info(
            "Z2M rename with HA rediscovery: %s -> %s",
            old_name,
            new_name,
        )

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

    async def _refresh_z2m_states(self, devices: list[Any]) -> None:
        """Ask Z2M to republish current state for each device.

        Iterates with a small delay so a large network of devices does not
        flood the broker. Silently ignores publish failures (devices without
        ``state`` exposes will simply not respond).

        Multi-gang devices (e.g. 3-channel relays) expose ``state_l1`` /
        ``state_l2`` / ``state_l3`` rather than a single ``state``. We
        introspect each device's ``definition.exposes`` and request every
        state-like property we find, falling back to a generic ``state``
        request when nothing is published.
        """
        client = self._client
        if client is None:
            return

        def _state_props(device: dict[str, Any]) -> list[str]:
            props: list[str] = []
            definition = device.get("definition") if isinstance(device.get("definition"), dict) else {}
            exposes = definition.get("exposes") or []

            def _walk(entry: Any) -> None:
                if not isinstance(entry, dict):
                    return
                # Direct property (binary/numeric/enum).
                prop = entry.get("property")
                if isinstance(prop, str) and (prop == "state" or prop.startswith("state_")):
                    if prop not in props:
                        props.append(prop)
                # Composite features (light, switch, etc.).
                features = entry.get("features")
                if isinstance(features, list):
                    for feat in features:
                        _walk(feat)

            for entry in exposes if isinstance(exposes, list) else []:
                _walk(entry)
            return props or ["state"]

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
            payload_obj = {prop: "" for prop in _state_props(d)}
            try:
                async with self._publish_lock:
                    await client.publish(topic, json.dumps(payload_obj), qos=0, retain=False)
                sent += 1
            except Exception as exc:
                log.debug("z2m get failed for %s: %s", friendly, exc)
            await asyncio.sleep(0.05)
        if sent:
            log.info("MQTT bridge requested state refresh for %d Z2M devices", sent)


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
