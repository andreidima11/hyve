"""Docker / GitHub add-on version resolution."""

from addons import registry


def test_is_channel_tag():
    assert registry._is_channel_tag("stable")
    assert registry._is_channel_tag("latest")
    assert not registry._is_channel_tag("0.17.1")
    assert not registry._is_channel_tag("v0.17.1")


def test_normalize_version_string():
    assert registry._normalize_version_string("v0.17.1") == "0.17.1"
    assert registry._normalize_version_string("0.17.1") == "0.17.1"


def test_resolve_display_version_uses_github_for_frigate(monkeypatch):
    manifest = registry.get_manifest("frigate")
    assert manifest is not None
    state = {"installed": False, "enabled": False, "version": None, "config": {}}

    monkeypatch.setattr(registry, "_github_latest_version", lambda repo: "0.17.1" if repo else None)
    monkeypatch.setattr(registry, "_docker_installed_version", lambda image: None)

    assert registry._resolve_display_version(manifest, state) == "0.17.1"


def test_resolve_display_version_prefers_runtime_when_installed(monkeypatch):
    manifest = registry.get_manifest("frigate")
    assert manifest is not None
    state = {
        "installed": True,
        "enabled": True,
        "version": "stable",
        "config": {"port": 5005},
    }

    monkeypatch.setattr(registry, "_http_runtime_version", lambda m, s: "0.16.2")
    monkeypatch.setattr(registry, "_resolve_installed_version", lambda m: None)

    assert registry._resolve_display_version(manifest, state) == "0.16.2"


def test_docker_installed_version_from_image_tag(monkeypatch):
    monkeypatch.setattr(registry, "_docker_image_exists", lambda _image: True)
    assert registry._docker_installed_version("ghcr.io/example/app:0.14.0") == "0.14.0"
    assert registry._docker_installed_version("ghcr.io/example/app:stable") == "stable"
    assert registry._docker_installed_version("ghcr.io/example/app:latest") == "latest"


def test_docker_installed_version_missing_image(monkeypatch):
    monkeypatch.setattr(registry, "_docker_image_exists", lambda _image: False)
    assert registry._docker_installed_version("ghcr.io/example/app:0.14.0") is None


def test_resolve_display_version_uses_github_for_cloudflared(monkeypatch):
    manifest = registry.get_manifest("cloudflared")
    assert manifest is not None
    assert manifest["install"].get("version_github") == "cloudflare/cloudflared"
    state = {"installed": False, "enabled": False, "version": None, "config": {}}

    monkeypatch.setattr(
        registry,
        "_github_latest_version",
        lambda repo: "2025.4.0" if repo == "cloudflare/cloudflared" else None,
    )
    monkeypatch.setattr(registry, "_docker_installed_version", lambda image: "latest")

    assert registry._resolve_display_version(manifest, state) == "2025.4.0"


def test_resolve_display_version_installed_cloudflared_skips_docker_latest(monkeypatch):
    manifest = registry.get_manifest("cloudflared")
    assert manifest is not None
    state = {
        "installed": True,
        "enabled": True,
        "version": "latest",
        "config": {},
    }

    monkeypatch.setattr(
        registry,
        "_github_latest_version",
        lambda repo: "2026.6.0" if repo == "cloudflare/cloudflared" else None,
    )
    monkeypatch.setattr(registry, "_http_runtime_version", lambda m, s: None)
    monkeypatch.setattr(registry, "_docker_installed_version", lambda image: "latest")

    assert registry._resolve_display_version(manifest, state) == "2026.6.0"


def test_addon_entry_overrides_manifest_channel_tag(monkeypatch):
    manifest = registry.get_manifest("frigate")
    assert manifest is not None

    monkeypatch.setattr(registry, "_resolve_display_version", lambda m, s: "0.17.1")
    from addons import versions as addon_versions

    monkeypatch.setattr(addon_versions, "_resolve_display_version", lambda m, s: "0.17.1")
    entry = registry.addon_entry(manifest, {"installed": False, "enabled": False, "config": {}})

    assert entry["version"] == "0.17.1"
    assert manifest["version"] == "stable"
