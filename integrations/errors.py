"""Structured sync errors raised by integration providers (not HTTP/core routers)."""

from __future__ import annotations

from typing import Any


class IntegrationSyncError(Exception):
    """Provider sync failure with an i18n payload for the API layer."""

    def __init__(
        self,
        *,
        message_key: str,
        params: dict[str, Any] | None = None,
        retry_after: int | None = None,
    ) -> None:
        self.message_key = message_key
        self.params = dict(params or {})
        self.retry_after = retry_after
        super().__init__(message_key)

    def as_detail(self) -> dict[str, Any]:
        return {"key": self.message_key, "params": self.params}


class IntegrationRateLimitError(IntegrationSyncError):
    """Upstream rate limit — HTTP layer should answer 429 with Retry-After."""

    def __init__(
        self,
        *,
        retry_after: int,
        interval: int = 0,
        message_key: str = "integrations.sync_rate_limited",
    ) -> None:
        secs = max(1, int(retry_after))
        self.interval = max(0, int(interval))
        super().__init__(
            message_key=message_key,
            params={"seconds": secs, "interval": self.interval or 90},
            retry_after=secs,
        )


def integration_sync_detail(exc: Exception) -> dict[str, Any] | None:
    if isinstance(exc, IntegrationSyncError):
        return exc.as_detail()
    return None


def integration_retry_after(exc: Exception, default: int = 600) -> int:
    if isinstance(exc, IntegrationSyncError) and exc.retry_after:
        return int(exc.retry_after)
    return default
