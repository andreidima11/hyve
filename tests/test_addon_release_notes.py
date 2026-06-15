"""GitHub release notes resolution for add-ons."""

from addons import registry


def test_addon_release_notes_from_github(monkeypatch):
    manifest = registry.get_manifest("cloudflared")
    assert manifest is not None

    def _fake_info(repo, tag=None):
        if repo != "cloudflare/cloudflared":
            return None
        if tag == "2026.6.0":
            return {"version": "2026.6.0", "body": "### Fixes\n- tunnel", "url": "https://example/release"}
        if tag is None:
            return {"version": "2026.6.1", "body": "Latest body", "url": "https://example/latest"}
        return None

    monkeypatch.setattr(registry, "_github_release_info", _fake_info)
    notes = registry.addon_release_notes(manifest, "2026.6.0")
    assert notes["body"] == "### Fixes\n- tunnel"
    assert notes["url"] == "https://example/release"


def test_addon_release_notes_falls_back_to_project_url():
    manifest = registry.get_manifest("mosquitto")
    assert manifest is not None
    notes = registry.addon_release_notes(manifest, "2.0.18")
    assert notes["body"] == ""
    assert notes["url"]


def test_github_release_info_uses_cache(monkeypatch):
    calls = {"n": 0}

    def _fake_urlopen(req, timeout=12):
        calls["n"] += 1

        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"tag_name":"1.2.3","body":"hi","html_url":"https://ex"}'

        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)
    registry._release_info_cache.clear()
    first = registry._github_release_info("org/pkg", None)
    second = registry._github_release_info("org/pkg", None)
    assert first and first["version"] == "1.2.3"
    assert second == first
    assert calls["n"] == 1
