"""HTTP app factory smoke tests."""

from fastapi.testclient import TestClient

from core.http.app import create_app


def test_create_app_registers_routers():
    bundle = create_app()
    paths = {getattr(route, "path", "") for route in bundle.app.routes}
    assert "/api/health" in paths
    assert "/api/chat" in paths
    assert bundle.templates is not None
    assert bundle.limiter is not None
    assert bundle.app_start_ts


def test_versioned_static_assets_do_not_500():
    client = TestClient(create_app().app)
    for url in (
        "/static/css/base.css?v=test",
        "/static/js/app.js?v=test",
    ):
        res = client.get(url)
        assert res.status_code == 200, url
        assert res.headers.get("cache-control", "").startswith("public")
