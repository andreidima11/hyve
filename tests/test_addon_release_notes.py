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


def test_github_repo_from_manifest_url():
    manifest = registry.get_manifest("piper")
    assert manifest is not None
    assert registry._github_repo(manifest) == "rhasspy/piper"


def test_github_tag_candidates_adds_v_prefix():
    assert registry._github_tag_candidates("1.2.3") == ["1.2.3", "v1.2.3"]
    assert registry._github_tag_candidates("v2.0.0") == ["v2.0.0", "2.0.0"]


def test_github_release_info_tries_tag_variants(monkeypatch):
    calls: list[str] = []

    def _fake_request(repo, tag):
        calls.append(str(tag))
        if tag == "v1.2.3":
            return {"version": "1.2.3", "body": "found", "url": "https://ex"}
        raise OSError("missing")

    monkeypatch.setattr(registry, "_github_release_info_request", _fake_request)
    registry._release_info_cache.clear()
    info = registry._github_release_info("org/pkg", "1.2.3")
    assert info and info["body"] == "found"
    assert "v1.2.3" in calls


def test_addon_release_notes_falls_back_to_project_url(monkeypatch):
    manifest = registry.get_manifest("mosquitto")
    assert manifest is not None
    monkeypatch.setattr(registry, "_github_release_info", lambda *args, **kwargs: None)
    notes = registry.addon_release_notes(manifest, "2.0.18")
    assert notes["body"] == ""
    assert notes["url"]


def test_addon_update_row_prefers_live_github_body(monkeypatch):
    from routers import updates as updates_router

    addon = {
        "slug": "frigate",
        "name": "Frigate",
        "icon": "fas fa-shield",
        "color": "indigo",
        "image": "",
        "version": "0.14.0",
        "update_available": False,
        "state": {
            "installed": True,
            "version": "0.14.0",
            "latest_version": "0.15.0",
            "release_notes": "",
            "release_url": "https://frigate.video/",
        },
    }
    monkeypatch.setattr(
        registry,
        "addon_release_notes",
        lambda _m, _v: {"version": "0.15.0", "body": "### New features", "url": "https://github.com/release"},
    )
    row = updates_router._addon_update_row(addon)
    assert row["release_notes"] == "### New features"
    assert row["release_url"] == "https://github.com/release"


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
