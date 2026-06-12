"""Nudge MQTT transport recovery."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from components.mammotion.session_bootstrap import ensure_nudge_transport, reset_mqtt_auth_failures
from pymammotion.transport.base import TransportType


def test_reset_mqtt_auth_failures_clears_breaker():
    aliyun = MagicMock()
    aliyun._unrecoverable_auth_failure = True
    mammotion = MagicMock()
    mammotion._unrecoverable_auth_failure = True
    handle = MagicMock()
    handle.get_transport.side_effect = lambda tt: {
        TransportType.CLOUD_ALIYUN: aliyun,
        TransportType.CLOUD_MAMMOTION: mammotion,
    }.get(tt)
    client = MagicMock()
    client.mower.return_value = handle

    reset_mqtt_auth_failures(client, "Luba-TEST")

    aliyun.clear_auth_failed.assert_called_once()
    mammotion.clear_auth_failed.assert_called_once()
    assert aliyun._unrecoverable_auth_failure is False
    assert mammotion._unrecoverable_auth_failure is False


def test_ensure_nudge_transport_raises_when_no_mqtt():
    client = MagicMock()
    handle = MagicMock()
    handle.get_transport.return_value = None
    handle.active_transport.side_effect = Exception("no transport")
    from pymammotion.transport.base import NoTransportAvailableError

    handle.active_transport.side_effect = NoTransportAvailableError("none")
    client.mower.return_value = handle

    with pytest.raises(ValueError, match="MQTT"):
        asyncio.run(ensure_nudge_transport(client, "Luba-TEST"))
