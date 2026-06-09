"""Roborock rate-limit handling and manager reset policy."""

from __future__ import annotations

from components.roborock.entity import RoborockEntity
from components.roborock.extract import _friendly_roborock_error


def test_friendly_roborock_error_rate_limit():
    class RoborockRateLimit(Exception):
        pass

    msg = _friendly_roborock_error(RoborockRateLimit("Reached maximum requests for home data"))
    assert "home data" in msg.lower() or "cloud" in msg.lower()
    assert "manual" in msg.lower() or "hyve" in msg.lower()


def test_should_reset_manager_skips_rate_limit_and_timeout():
    class RoborockRateLimit(Exception):
        pass

    class RoborockTimeout(Exception):
        pass

    assert RoborockEntity._should_reset_manager(RoborockRateLimit()) is False
    assert RoborockEntity._should_reset_manager(RoborockTimeout()) is False


def test_should_reset_manager_on_invalid_credentials():
    class RoborockInvalidCredentials(Exception):
        pass

    assert RoborockEntity._should_reset_manager(RoborockInvalidCredentials()) is True
