"""Registry version string sanitization."""

from addons import registry as reg


def test_plausible_version_rejects_html():
    assert reg._plausible_version_string("<!DOCTYPE html>") is None
    assert reg._plausible_version_string("2024.11.0") == "2024.11.0"
    assert reg._plausible_version_string("v1.2.3") == "1.2.3"


def test_http_runtime_version_rejects_html_page(monkeypatch):
    class _FakeResp:
        def read(self):
            return b"<!DOCTYPE html><html><head><title>Zigbee2MQTT</title></head></html>"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: _FakeResp())
    manifest = {
        "slug": "zigbee2mqtt",
        "health_check": {"type": "http", "host": "localhost", "port_key": "web_port", "path": "/"},
    }
    state = {"config": {"web_port": 8080}}
    assert reg._http_runtime_version(manifest, state) is None


def test_resolve_display_version_ignores_corrupt_saved_version(monkeypatch):
    manifest = {
        "slug": "zigbee2mqtt",
        "version": "latest",
        "install": {"method": "npm", "packages": ["zigbee2mqtt@latest"]},
        "health_check": {"type": "http", "host": "localhost", "port_key": "web_port", "path": "/"},
    }
    html_version = "<!DOCTYPE html><html><title>Zigbee2MQTT</title></html>"
    state = {"installed": True, "version": html_version, "config": {"web_port": 8080}}
    monkeypatch.setattr(reg, "_http_runtime_version", lambda *args, **kwargs: None)
    monkeypatch.setattr(reg, "_resolve_installed_version", lambda *args, **kwargs: "2.1.0")
    assert reg._resolve_display_version(manifest, state) == "2.1.0"
