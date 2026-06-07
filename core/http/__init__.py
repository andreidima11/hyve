"""HTTP layer — FastAPI factory and middleware."""

from core.http.app import HyveApp, create_app

__all__ = ["HyveApp", "create_app"]
