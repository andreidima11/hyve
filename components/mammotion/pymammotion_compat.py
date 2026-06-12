"""Hyve runtime patches for pymammotion 0.8.x (Python 3.13+)."""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("mammotion")

_PATCHED = False
_ALIYUN_GATEWAY_PATCHED = False


def apply_pymammotion_patches() -> None:
    """Apply idempotent Hyve patches on top of pymammotion 0.8.x."""
    global _PATCHED
    if _PATCHED:
        return

    from pymammotion.client import MammotionClient

    _orig_login_cloud = MammotionClient.login_and_initiate_cloud
    _orig_full_relogin = MammotionClient._full_relogin
    _orig_restore_aliyun = MammotionClient._restore_aliyun

    async def _patched_full_relogin(self: Any, session: Any) -> None:
        """Full cloud re-login (fresh Aliyun IoT tokens), not token refresh only."""
        from pymammotion.transport.base import LoginFailedError

        if session is None or not session.email or not session.password:
            msg = "No stored credentials available for re-login"
            raise LoginFailedError("", msg)
        http_sess = getattr(self, "_hyve_http_session", None)
        await self._sign_out_existing_session(getattr(session, "account_id", None) or session.email)
        await _orig_login_cloud(self, session.email, session.password, http_sess)

    async def _patched_restore_aliyun(
        self: Any,
        account: str,
        password: str,
        cached_data: dict[str, Any],
        acct_session: Any,
        *,
        check_for_new_devices: bool,
    ) -> None:
        await _orig_restore_aliyun(
            self,
            account,
            password,
            cached_data,
            acct_session,
            check_for_new_devices=check_for_new_devices,
        )
        http_sess = getattr(self, "_hyve_http_session", None)
        if http_sess is None:
            return
        mammotion_http = getattr(acct_session, "mammotion_http", None)
        if mammotion_http is not None:
            mammotion_http._session = http_sess
        cloud_client = getattr(acct_session, "cloud_client", None)
        if cloud_client is not None:
            cloud_http = getattr(cloud_client, "mammotion_http", None)
            if cloud_http is not None:
                cloud_http._session = http_sess

    if not getattr(MammotionClient._full_relogin, "_hyve_patched", False):
        _patched_full_relogin._hyve_patched = True  # type: ignore[attr-defined]
        MammotionClient._full_relogin = _patched_full_relogin  # type: ignore[method-assign]

    _orig_setup_aliyun = MammotionClient._setup_aliyun_transport

    def _patched_setup_aliyun(self: Any, cloud_client: Any, acct_session: Any) -> Any:
        import time

        transport = _orig_setup_aliyun(self, cloud_client, acct_session)
        orig_failure = transport.on_auth_failure
        if orig_failure is None:
            return transport

        state = {"last_at": 0.0, "failures": 0}

        async def _guarded_auth_failure() -> bool:
            now = time.monotonic()
            if now - state["last_at"] < 120.0 or state["failures"] >= 1:
                return False
            state["last_at"] = now
            try:
                ok = await orig_failure()
            except Exception as exc:
                from components.mammotion.utils import is_auth_session_error

                if is_auth_session_error(exc):
                    state["failures"] = 1
                    log.warning("mammotion Aliyun token refresh aborted: %s", exc)
                return False
            if not ok:
                state["failures"] = 1
                log.warning("mammotion Aliyun token refresh failed — stopping retries")
            return ok

        transport.on_auth_failure = _guarded_auth_failure
        return transport

    if not getattr(MammotionClient._restore_aliyun, "_hyve_patched", False):
        _patched_restore_aliyun._hyve_patched = True  # type: ignore[attr-defined]
        MammotionClient._restore_aliyun = _patched_restore_aliyun  # type: ignore[method-assign]

    if not getattr(MammotionClient._setup_aliyun_transport, "_hyve_patched", False):
        _patched_setup_aliyun._hyve_patched = True  # type: ignore[attr-defined]
        MammotionClient._setup_aliyun_transport = _patched_setup_aliyun  # type: ignore[method-assign]

    _patch_aliyun_decode_noise()

    _PATCHED = True
    log.debug("applied pymammotion 0.8.x Hyve patches")


def _patch_aliyun_decode_noise() -> None:
    """Benign Aliyun JSON parse failures are debug-only (pymammotion returns code 22000)."""
    global _ALIYUN_GATEWAY_PATCHED
    if _ALIYUN_GATEWAY_PATCHED:
        return

    import json
    from json import JSONDecodeError

    from pymammotion.aliyun.cloud_gateway import CloudIOTGateway

    gateway_logger = logging.getLogger("pymammotion.aliyun.cloud_gateway")

    @staticmethod
    def _quiet_parse_json_response(response_body_str: str) -> dict:
        try:
            return json.loads(response_body_str) if response_body_str is not None else {}
        except JSONDecodeError:
            preview = (response_body_str or "")[:120]
            gateway_logger.debug("Couldn't decode Aliyun message (ignored): %r", preview)
            return {"code": 22000}

    if not getattr(CloudIOTGateway.parse_json_response, "_hyve_patched", False):
        _quiet_parse_json_response._hyve_patched = True  # type: ignore[attr-defined]
        CloudIOTGateway.parse_json_response = _quiet_parse_json_response  # type: ignore[method-assign]
        _ALIYUN_GATEWAY_PATCHED = True
