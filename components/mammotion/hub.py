"""Mammotion hub — HA-style runtime on pymammotion 0.8.x (Python 3.13+).

One hub per config entry: login, device registry, MQTT push watchers, sync/test.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

from components.mammotion.session_bootstrap import (
    bootstrap_device,
    device_handle_online,
    mark_client_rate_limited,
    mqtt_transport_connected,
    wait_for_telemetry,
)

log = logging.getLogger("mammotion")

_TEST_LOGIN_TIMEOUT = 120.0
_PUSH_DEBOUNCE_SECONDS = 10.0
_AUTH_RECOVERY_COOLDOWN = 45.0
_SYNC_TELEMETRY_CAP = 8.0
_MQTT_WAIT_SECONDS = 40.0
_CONTROL_PREP_TIMEOUT = 25.0


class MammotionHub:
    """Per-account Mammotion cloud session (mirrors HA entry runtime, Hyve-native)."""

    def __init__(
        self,
        *,
        account: str,
        password: str,
        cache: dict[str, Any] | None,
        device_settings: dict[str, Any] | None = None,
        movement_use_wifi: bool = False,
        persist_cache: Callable[[dict[str, Any]], None] | None = None,
        persist_settings: Callable[[dict[str, Any]], None] | None = None,
        client_factory: Callable[[], Any] | None = None,
        on_push: Callable[[], None] | None = None,
    ) -> None:
        self.account = account.strip()
        self.password = password
        self._cache = dict(cache or {})
        self._device_settings = dict(device_settings or {})
        self.movement_use_wifi = movement_use_wifi
        self._persist_cache = persist_cache
        self._persist_settings = persist_settings
        self._client_factory = client_factory
        self._on_push = on_push
        self._client: Any = None
        self._http: Any = None
        self._lock = asyncio.Lock()
        self._coordinators: dict[str, Any] = {}
        self._watchers: dict[str, Any] = {}
        self._push_task: asyncio.Task[None] | None = None
        self._push_debounce: dict[str, float] = {}
        self._auth_recovery_at = 0.0
        self._rate_limited_until = 0.0
        self._bootstrapped_devices: set[str] = set()
        self._stream_cache: dict[str, dict[str, Any]] = {}

    # ── client / cache (shared with legacy MammotionSession) ─────────────────

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        if self._client_factory is not None:
            self._client = self._client_factory()
            return self._client
        from components.mammotion.pymammotion_compat import apply_pymammotion_patches
        from pymammotion.client import MammotionClient
        from components.mammotion.utils import mammotion_ha_fingerprint

        apply_pymammotion_patches()
        client = MammotionClient(ha_version=mammotion_ha_fingerprint())

        async def _persist_refreshed_credentials() -> None:
            self._save_cache()

        client.on_credentials_updated = _persist_refreshed_credentials
        self._client = client
        return self._client

    async def close(self) -> None:
        async with self._lock:
            await self._close_unlocked()

    async def recover_auth(self) -> None:
        """Force fresh cloud login after stale Aliyun/MQTT tokens."""
        now = time.monotonic()
        if now - self._auth_recovery_at < _AUTH_RECOVERY_COOLDOWN:
            log.debug("mammotion auth recovery skipped (cooldown)")
            return
        self._auth_recovery_at = now
        log.warning("mammotion forcing fresh login for %s", self.account)
        self._cache = {}
        if self._persist_cache:
            self._persist_cache({})
        async with self._lock:
            await asyncio.sleep(1.0)
            await self._connect_unlocked(force_fresh=True)

    async def _close_unlocked(self) -> None:
        from components.mammotion.cloud_login import store_cloud_credentials
        from components.mammotion.session_teardown import teardown_mammotion_client

        for sub in self._watchers.values():
            try:
                sub.cancel()
            except Exception:
                pass
        self._watchers.clear()
        if self._push_task is not None:
            self._push_task.cancel()
            self._push_task = None
        self._coordinators.clear()
        self._bootstrapped_devices.clear()
        client = self._client
        self._client = None
        session = self._http
        self._http = None
        if client is not None:
            stored = store_cloud_credentials(client)
            if stored:
                self._cache = stored
                if self._persist_cache:
                    self._persist_cache(stored)
            await teardown_mammotion_client(client, self.account)
        if session is not None and not session.closed:
            try:
                await session.close()
            except Exception:
                pass

    async def _save_cache_if_healthy(self) -> None:
        """Persist cloud cache when devices are registered and MQTT is up."""
        names = self._iter_device_names()
        if not names:
            log.debug("mammotion skip cache persist — no devices in registry")
            return
        client = self._client
        if client is None:
            return
        if not any(mqtt_transport_connected(client, name) for name in names):
            from components.mammotion.device_registration import ensure_mqtt_transports
            from components.mammotion.session_bootstrap import any_pymammotion_handle_rate_limited

            if not any_pymammotion_handle_rate_limited(client, names):
                try:
                    await ensure_mqtt_transports(
                        client,
                        self.account,
                        password=self.password,
                        aiohttp_session=await self._ensure_http(),
                    )
                except Exception as exc:
                    log.debug("mammotion cache persist MQTT prep failed: %s", exc)
        if not any(mqtt_transport_connected(client, name) for name in names):
            log.debug("mammotion skip cache persist — MQTT not connected for %s", self.account)
            return
        self._save_cache()

    def _clear_persisted_cache(self) -> None:
        self._cache = {}
        if self._persist_cache:
            self._persist_cache({})

    def _session_active(self) -> bool:
        client = self._client
        if client is None:
            return False
        registry = getattr(client, "_account_registry", None)
        if registry is None:
            return False
        for session in getattr(registry, "all_sessions", []) or []:
            if getattr(session, "account_id", None) == self.account:
                return True
        return False

    async def _connect_unlocked(self, *, force_fresh: bool = False) -> None:
        from components.mammotion.cloud_login import async_attempt_cloud_login
        from components.mammotion.device_registration import ensure_mqtt_transports
        from components.mammotion.session_binding import bind_http_to_client

        if force_fresh:
            self._cache = {}
            if self._persist_cache:
                self._persist_cache({})
            await self._close_unlocked()

        client = self._ensure_client()
        http = await self._ensure_http()
        bind_http_to_client(client, http, account=self.account)

        if not force_fresh and self._session_active():
            names = self._iter_device_names()
            if names and any(mqtt_transport_connected(client, name) for name in names):
                await self._ensure_watchers()
                return
            if names:
                log.warning("mammotion MQTT down — soft reconnect for %s", self.account)
                if await ensure_mqtt_transports(
                    client,
                    self.account,
                    password=self.password,
                    aiohttp_session=http,
                ):
                    await self._ensure_watchers()
                    return
                log.warning("mammotion MQTT still down — rebuilding session for %s", self.account)
            await self._close_unlocked()
            client = self._ensure_client()
            http = await self._ensure_http()
            bind_http_to_client(client, http, account=self.account)

        try:
            self._cache = await async_attempt_cloud_login(
                client,
                self.account,
                self.password,
                http,
                self._cache,
                force_fresh=force_fresh,
            )
            if self._cache and self._persist_cache:
                self._persist_cache(self._cache)
        except RuntimeError:
            await self._close_unlocked()
            raise

        await self._finalize_connect(client, http)

    async def _finalize_connect(self, client: Any, http: Any) -> None:
        from components.mammotion.device_registration import complete_device_registration
        from components.mammotion.session_binding import bind_http_to_client

        bind_http_to_client(client, http, account=self.account)
        registry_count = len(self._iter_device_names())
        if registry_count == 0:
            await complete_device_registration(
                client,
                self.account,
                password=self.password,
                aiohttp_session=http,
            )
            registry_count = len(self._iter_device_names())
        if registry_count == 0:
            await self._close_unlocked()
            raise RuntimeError(
                "Autentificare Mammotion reușită parțial, dar robotul nu s-a conectat la MQTT. "
                "Integrări → Mammotion → Test → Save → Sync."
            )
        await self._wait_for_mqtt(client)
        await self._bootstrap_devices_once()
        log.info(
            "mammotion connect complete account=%s sessions=%d registry=%d mqtt=%s",
            self.account,
            len(getattr(getattr(client, "_account_registry", None), "all_sessions", []) or []),
            registry_count,
            any(mqtt_transport_connected(client, name) for name in self._iter_device_names()),
        )
        await self._ensure_watchers()
        await self._save_cache_if_healthy()

    async def _bootstrap_devices_once(self) -> None:
        """Run HA ``_async_setup`` command batch once per device after first MQTT connect."""
        client = self._client
        if client is None:
            return
        for device_name in self._iter_device_names():
            if device_name in self._bootstrapped_devices:
                continue
            if not mqtt_transport_connected(client, device_name):
                continue
            from components.mammotion.session_bootstrap import pymammotion_handle_rate_limited

            if pymammotion_handle_rate_limited(client, device_name):
                log.warning("mammotion deferring bootstrap for %s (device rate limited)", device_name)
                continue
            if time.monotonic() < self._rate_limited_until:
                log.debug("mammotion deferring bootstrap for %s (hub rate backoff)", device_name)
                continue
            try:
                await bootstrap_device(client, device_name)
                await wait_for_telemetry(
                    client,
                    device_name,
                    timeout_seconds=_SYNC_TELEMETRY_CAP,
                )
                self._bootstrapped_devices.add(device_name)
                log.info("mammotion bootstrap complete for %s", device_name)
            except Exception as exc:
                from components.mammotion.utils import is_rate_limited_error

                if is_rate_limited_error(exc):
                    self._rate_limited_until = time.monotonic() + 120.0
                    mark_client_rate_limited(client, seconds=120.0)
                    log.warning("mammotion bootstrap rate limited for %s", device_name)
                else:
                    log.warning("mammotion bootstrap failed for %s: %s", device_name, exc)

    async def _wait_for_mqtt(self, client: Any) -> bool:
        from components.mammotion.device_registration import ensure_mqtt_transports
        from components.mammotion.session_bootstrap import any_pymammotion_handle_rate_limited

        names = self._iter_device_names()
        if names and any_pymammotion_handle_rate_limited(client, names):
            log.debug("mammotion skip MQTT wait — cloud rate limit backoff")
            return any(mqtt_transport_connected(client, name) for name in names)

        deadline = time.monotonic() + _MQTT_WAIT_SECONDS
        while time.monotonic() < deadline:
            names = self._iter_device_names()
            if names and any(mqtt_transport_connected(client, name) for name in names):
                return True
            if names and any_pymammotion_handle_rate_limited(client, names):
                log.debug("mammotion stop MQTT wait — cloud rate limit backoff")
                break
            await ensure_mqtt_transports(
                client,
                self.account,
                password=self.password,
                aiohttp_session=await self._ensure_http(),
            )
            await asyncio.sleep(2.0)
        return any(mqtt_transport_connected(client, name) for name in self._iter_device_names())

    async def ensure_control_path(self) -> None:
        """Lightweight prep before user commands — avoid full re-login when possible."""
        from components.mammotion.session_bootstrap import (
            clear_pymammotion_rate_limit_for_command,
            control_path_ready,
        )

        self._rate_limited_until = 0.0
        async with self._lock:
            if not self.account or not self.password:
                raise RuntimeError("Cont Mammotion incomplet — completează e-mail și parola.")
            client = self._ensure_client()
            http = await self._ensure_http()
            from components.mammotion.session_binding import bind_http_to_client, ensure_account_http

            bind_http_to_client(client, http, account=self.account)

            names = self._iter_device_names()
            from components.mammotion.session_bootstrap import reset_mqtt_auth_failures

            for device_name in names:
                clear_pymammotion_rate_limit_for_command(client, device_name)
                reset_mqtt_auth_failures(client, device_name)

            if not self._session_active() or not names:
                await self._connect_unlocked()
            else:
                await ensure_account_http(client, self.account, self.password, aiohttp_session=http)
                from components.mammotion.device_registration import ensure_mqtt_transports

                names = self._iter_device_names()
                if not any(control_path_ready(client, name) for name in names):
                    await asyncio.wait_for(
                        ensure_mqtt_transports(
                            client,
                            self.account,
                            password=self.password,
                            aiohttp_session=http,
                            for_control=True,
                        ),
                        timeout=_CONTROL_PREP_TIMEOUT,
                    )

            names = self._iter_device_names()
            if not names:
                raise RuntimeError(
                    "Robotul nu este înregistrat în MQTT — Integrări → Mammotion → Sync și așteaptă ~1 minut."
                )
            if not any(control_path_ready(client, name) for name in names):
                raise RuntimeError(
                    "Robotul nu răspunde la comenzi — apasă Sync, așteaptă 30–60 secunde, apoi încearcă din nou."
                )
            await self._ensure_watchers()

    async def _ensure_http(self) -> Any:
        import aiohttp

        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession()
        return self._http

    async def connect(self, *, force_fresh: bool = False) -> None:
        if not self.account or not self.password:
            raise RuntimeError("Cont Mammotion incomplet — completează e-mail și parola.")
        async with self._lock:
            await self._connect_unlocked(force_fresh=force_fresh)

    def _save_cache(self) -> None:
        from components.mammotion.cloud_login import store_cloud_credentials

        if self._client is None or not self._persist_cache:
            return
        stored = store_cloud_credentials(self._client)
        if stored:
            self._cache = stored
            self._persist_cache(stored)

    def _save_settings(self) -> None:
        if not self._persist_settings:
            return
        payload = {
            name: {
                "operation_settings": coord.operation_settings.to_dict(),
                "map_offset_lat": coord.map_offset_lat,
                "map_offset_lon": coord.map_offset_lon,
                "bluetooth_enabled": coord.bluetooth_enabled,
                "cloud_enabled": coord.cloud_enabled,
            }
            for name, coord in self._coordinators.items()
        }
        self._device_settings = payload
        self._persist_settings(payload)

    def apply_runtime_options(self, *, movement_use_wifi: bool | None = None) -> None:
        """Push entry-level options into live coordinators (session already open)."""
        if movement_use_wifi is not None:
            self.movement_use_wifi = movement_use_wifi
            for coord in self._coordinators.values():
                coord.movement_use_wifi = movement_use_wifi

    def _coordinator_for(self, device_name: str) -> Any:
        from pymammotion.data.model.device_config import OperationSettings

        from components.mammotion.coordinator import MowerCoordinator

        if device_name not in self._coordinators:
            stored = self._device_settings.get(device_name) or {}
            op = stored.get("operation_settings") or {}
            self._coordinators[device_name] = MowerCoordinator(
                self._ensure_client(),
                device_name,
                operation_settings=OperationSettings.from_dict(op) if op else OperationSettings(),
                map_offset_lat=float(stored.get("map_offset_lat") or 0),
                map_offset_lon=float(stored.get("map_offset_lon") or 0),
                bluetooth_enabled=bool(stored.get("bluetooth_enabled", True)),
                cloud_enabled=bool(stored.get("cloud_enabled", True)),
                movement_use_wifi=self.movement_use_wifi,
                hub=self,
            )
        return self._coordinators[device_name]

    def _iter_device_names(self) -> list[str]:
        client = self._client
        if client is None:
            return []
        registry = getattr(client, "_device_registry", None)
        handles = getattr(registry, "all_devices", []) if registry is not None else []
        names: list[str] = []
        for handle in handles:
            name = str(getattr(handle, "device_name", "") or "").strip()
            if name:
                names.append(name)
        return names

    async def _http_device_names(self) -> list[str]:
        if self._client is None:
            return []
        from components.mammotion.device_registration import list_http_device_names

        return await list_http_device_names(
            self._client,
            self.account,
            password=self.password,
            aiohttp_session=await self._ensure_http(),
        )

    async def _ensure_devices_ready(self, *, max_attempts: int = 8) -> list[str]:
        client = self._ensure_client()
        names = self._iter_device_names()
        if names:
            return names

        from components.mammotion.device_registration import complete_device_registration

        try:
            await complete_device_registration(
                client,
                self.account,
                password=self.password,
                aiohttp_session=await self._ensure_http(),
            )
        except Exception as exc:
            log.warning("mammotion device bootstrap failed for %s: %s", self.account, exc)

        http_names: list[str] = []
        for attempt in range(max_attempts):
            names = self._iter_device_names()
            if names:
                return names
            http_names = await self._http_device_names()
            if http_names:
                wait = min(4 + attempt * 2, 12)
                await asyncio.sleep(wait)
                names = self._iter_device_names()
                if names:
                    return names
                if attempt >= 2:
                    return http_names
                continue
            await asyncio.sleep(2)
        return http_names or names

    async def _ensure_watchers(self) -> None:
        """Subscribe to MQTT state push (HA ``subscribe_state_changed``)."""
        client = self._client
        if client is None:
            return
        for device_name in self._iter_device_names():
            if device_name in self._watchers:
                continue
            handle = client.mower(device_name)
            if handle is None:
                continue

            async def _on_push(snapshot: Any, *, _name: str = device_name) -> None:
                now = time.monotonic()
                last = self._push_debounce.get(_name, 0.0)
                if now - last < _PUSH_DEBOUNCE_SECONDS:
                    return
                self._push_debounce[_name] = now
                log.debug("mammotion push update for %s", _name)
                if self._on_push is not None:
                    try:
                        self._on_push()
                    except Exception as exc:
                        log.debug("mammotion on_push failed: %s", exc)

            try:
                sub = handle.subscribe_state_changed(_on_push)
                if sub is not None:
                    self._watchers[device_name] = sub
            except Exception as exc:
                log.debug("mammotion watcher setup failed for %s: %s", device_name, exc)

    # ── test (auth only — never full sync) ───────────────────────────────────

    async def test_auth(self) -> tuple[bool, str, int]:
        """HA config-flow test: fresh ``login_and_initiate_cloud`` only (no MQTT/sync)."""
        from components.mammotion.cloud_login import async_test_cloud_login
        from components.mammotion.session_binding import bind_http_to_client

        if not self.account or not self.password:
            return False, "Cont Mammotion incomplet — completează e-mail și parola.", 0

        client = self._ensure_client()
        http = await self._ensure_http()
        bind_http_to_client(client, http, account=self.account)
        ok, message, count = await async_test_cloud_login(
            client,
            self.account,
            self.password,
            http,
            timeout=_TEST_LOGIN_TIMEOUT,
        )
        return ok, message, count

    # ── sync ─────────────────────────────────────────────────────────────────

    async def sync_devices(
        self,
        *,
        full: bool = True,
        skip_connect: bool = False,
        bootstrap: bool = False,
        snapshot: bool = False,
    ) -> dict[str, Any]:
        from components.mammotion.snapshot import build_device_snapshot, device_kind

        if not skip_connect:
            await self.connect()
        client = self._ensure_client()
        results: list[dict[str, Any]] = []

        async def _poll_one(device_name: str) -> dict[str, Any]:
            device_obj = client.get_device_by_name(device_name)
            handle = client.mower(device_name) if client is not None else None
            from components.mammotion.session_bootstrap import pymammotion_handle_rate_limited

            pymammotion_rate_limited = pymammotion_handle_rate_limited(client, device_name)
            if full and device_obj is not None and mqtt_transport_connected(client, device_name):
                if bootstrap and not pymammotion_rate_limited and time.monotonic() >= self._rate_limited_until:
                    if device_name not in self._bootstrapped_devices:
                        await self._bootstrap_devices_once()
                elif snapshot and not pymammotion_rate_limited and time.monotonic() >= self._rate_limited_until:
                    from components.mammotion.session_bootstrap import request_report_snapshot

                    try:
                        await request_report_snapshot(client, device_name)
                        await asyncio.sleep(1.0)
                    except Exception as exc:
                        from components.mammotion.utils import is_rate_limited_error

                        if is_rate_limited_error(exc):
                            self._rate_limited_until = time.monotonic() + 120.0
                            mark_client_rate_limited(client, seconds=120.0)
                            log.warning("mammotion snapshot rate limited for %s", device_name)
                        else:
                            log.debug("mammotion snapshot failed for %s: %s", device_name, exc)
            elif full and device_obj is not None:
                log.debug("mammotion skipping cloud poll for %s (MQTT not connected)", device_name)

            device = client.get_device_by_name(device_name)
            if device is None:
                from components.mammotion.snapshot.map_data import device_kind, mower_flags

                return {
                    "device_name": device_name,
                    "name": device_name,
                    "online": False,
                    "kind": device_kind(device_name),
                    "flags": mower_flags(device_name),
                    "sensors": {},
                    "switches": {},
                    "status": {},
                }
            coord = self._coordinator_for(device_name)
            return build_device_snapshot(
                device,
                device_name=device_name,
                coordinator_meta=coord.meta(),
                client=client,
            )

        device_names = await self._ensure_devices_ready()
        if not device_names:
            raise RuntimeError(
                "Niciun dispozitiv Mammotion pe cont. Dacă testul l-a găsit în cloud, "
                "așteaptă 1–2 minute și apasă Sync — înregistrarea MQTT poate dura."
            )

        await self._ensure_watchers()

        for name in device_names:
            try:
                item = await _poll_one(name)
                if isinstance(item, dict):
                    results.append(item)
            except Exception as exc:
                log.warning("mammotion device snapshot failed for %s: %s", name, exc)
                results.append(
                    {
                        "device_name": name,
                        "name": name,
                        "online": False,
                        "kind": device_kind(name),
                    }
                )
        await self._save_cache_if_healthy()
        self._save_settings()
        log.info(
            "mammotion sync complete account=%s devices=%d registry=%d",
            self.account,
            len(results),
            len(self._iter_device_names()),
        )
        return {"devices": results}

    async def build_live_payload(self) -> dict[str, Any]:
        """Fast in-memory snapshot from MQTT push (no bootstrap / telemetry wait)."""
        from components.mammotion.snapshot import build_device_snapshot, device_kind

        client = self._client
        if client is None:
            return {"devices": []}

        results: list[dict[str, Any]] = []
        for device_name in self._iter_device_names():
            device = client.get_device_by_name(device_name)
            if device is None:
                results.append(
                    {
                        "device_name": device_name,
                        "name": device_name,
                        "online": False,
                        "kind": device_kind(device_name),
                    }
                )
                continue
            coord = self._coordinator_for(device_name)
            results.append(
                build_device_snapshot(
                    device,
                    device_name=device_name,
                    coordinator_meta=coord.meta(),
                    client=client,
                )
            )
        return {"devices": results}

    async def pull_live(self) -> dict[str, Any]:
        """Light refresh from MQTT push state — no cloud command batch (HA coordinator pull)."""
        if not self._iter_device_names():
            await self.connect()
        await self._ensure_watchers()
        return await self.build_live_payload()
