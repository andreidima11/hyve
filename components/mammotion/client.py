"""PyMammotion session — thin wrapper over MammotionHub."""

from __future__ import annotations

import time
from typing import Any, Callable

from components.mammotion.hub import MammotionHub
from components.mammotion.utils import friendly_auth_error, hyve_client_version, json_safe

# Back-compat for tests/imports
_friendly_auth_error = friendly_auth_error
_hyve_client_version = hyve_client_version
_json_safe = json_safe


class MammotionSession:
    """Per-entry Mammotion cloud session (delegates to MammotionHub)."""

    _SYNC_WAIT_SECONDS = 5.0
    _LOGIN_TIMEOUT = 60.0
    _SYNC_TIMEOUT = 180.0
    _DEVICE_BOOTSTRAP_ATTEMPTS = 8
    _CONTROL_PREP_TIMEOUT = 30.0
    _CONTROL_TIMEOUT = 70.0

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
        hub: MammotionHub | None = None,
        on_push: Callable[[], None] | None = None,
    ) -> None:
        self._hub = hub or MammotionHub(
            account=account,
            password=password,
            cache=cache,
            device_settings=device_settings,
            movement_use_wifi=movement_use_wifi,
            persist_cache=persist_cache,
            persist_settings=persist_settings,
            on_push=on_push,
        )

    @property
    def account(self) -> str:
        return self._hub.account

    @property
    def password(self) -> str:
        return self._hub.password

    @property
    def _client(self) -> Any:
        return self._hub._client

    @_client.setter
    def _client(self, value: Any) -> None:
        self._hub._client = value

    async def close(self) -> None:
        await self._hub.close()

    async def connect(self, *, force_fresh: bool = False) -> None:
        await self._hub.connect(force_fresh=force_fresh)

    async def recover_auth(self) -> None:
        await self._hub.recover_auth()

    def _coordinator_for(self, device_name: str) -> Any:
        return self._hub._coordinator_for(device_name)

    def _iter_device_names(self) -> list[str]:
        return self._hub._iter_device_names()

    async def _ensure_devices_ready(self) -> list[str]:
        return await self._hub._ensure_devices_ready()

    async def sync_devices(
        self,
        *,
        full: bool = True,
        skip_connect: bool = False,
        bootstrap: bool = False,
        snapshot: bool = False,
    ) -> dict[str, Any]:
        return await self._hub.sync_devices(
            full=full,
            skip_connect=skip_connect,
            bootstrap=bootstrap,
            snapshot=snapshot,
        )

    async def control(self, target_id: str, action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        import asyncio

        from components.mammotion.control import control_mammotion, parse_target_id
        from components.mammotion.session_bootstrap import RATE_LIMIT_USER_MESSAGE

        try:
            await asyncio.wait_for(
                self._hub.ensure_control_path(),
                timeout=self._CONTROL_PREP_TIMEOUT,
            )
        except asyncio.TimeoutError as exc:
            raise ValueError(
                "Pregătire comandă — timeout MQTT. Apasă Sync, așteaptă ~1 minut, apoi încearcă din nou."
            ) from exc
        except RuntimeError as exc:
            raise ValueError(str(exc)) from exc

        device_name, _domain, _key = parse_target_id(
            target_id,
            known_devices=self._iter_device_names() or list(self._hub._coordinators.keys()),
        )
        coord = self._coordinator_for(device_name)
        try:
            result = await asyncio.wait_for(
                control_mammotion(coord, target_id, action, data),
                timeout=self._CONTROL_TIMEOUT,
            )
        except asyncio.TimeoutError as exc:
            raise ValueError(
                "Comanda a expirat — robotul poate fi în rate limit. Așteaptă 1–2 minute și încearcă din nou."
            ) from exc
        except ValueError:
            raise
        except Exception as exc:
            from components.mammotion.utils import is_rate_limited_error

            if is_rate_limited_error(exc):
                from components.mammotion.session_bootstrap import mark_client_rate_limited

                mark_client_rate_limited(self._hub._client, seconds=90.0)
                self._hub._rate_limited_until = time.monotonic() + 120.0
                raise ValueError(RATE_LIMIT_USER_MESSAGE) from exc
            raise
        finally:
            self._hub._save_settings()
            await self._hub._save_cache_if_healthy()
        return result

    async def test_connection(self) -> tuple[bool, str, int]:
        return await self._hub.test_auth()

    async def _sync_after_login(self, *, force_fresh: bool = False) -> dict[str, Any]:
        await self.connect(force_fresh=force_fresh)
        return await self.sync_devices(full=True, skip_connect=True)
