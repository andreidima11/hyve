#!/usr/bin/env python3
"""Fast CI smoke checks: app boots, key routes respond, bundled components import."""
from __future__ import annotations

import sys

from fastapi.testclient import TestClient

from core.http.app import create_app
from integrations.component_import import load_component_module


def main() -> int:
    bundle = create_app()
    paths = {getattr(route, "path", "") for route in bundle.app.routes}
    required = {"/api/health", "/api/chat", "/api/dashboard/widgets"}
    missing = sorted(required - paths)
    if missing:
        print("Smoke failed: missing routes:", ", ".join(missing))
        return 1

    client = TestClient(bundle.app)
    health = client.get("/api/health")
    if health.status_code != 200:
        print(f"Smoke failed: /api/health -> {health.status_code}")
        return 1

    for url in (
        "/static/css/base.css?v=smoke",
        "/static/js/app.js?v=smoke",
    ):
        res = client.get(url)
        if res.status_code != 200:
            print(f"Smoke failed: {url} -> {res.status_code}")
            return 1

    load_component_module("comfyui", "client")
    load_component_module("forge", "pipeline")

    print("Smoke checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
