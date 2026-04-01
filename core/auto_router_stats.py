"""Auto model-router runtime counters (shared across routes and chat flow)."""

_auto_router_stats = {"local": 0, "api": 0}


def record_auto_router_usage(kind: str) -> None:
    if kind in _auto_router_stats:
        _auto_router_stats[kind] += 1


def get_auto_router_stats() -> dict:
    return dict(_auto_router_stats)
