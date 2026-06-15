"""HTTP layer — FastAPI factory and middleware."""

__all__ = ["HyveApp", "create_app"]


def __getattr__(name: str):
    if name == "HyveApp":
        from core.http.app import HyveApp

        return HyveApp
    if name == "create_app":
        from core.http.app import create_app

        return create_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
