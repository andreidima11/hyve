"""Brew-method add-ons on Linux (apt instead of Homebrew)."""

from __future__ import annotations

from addons import registry


def test_mosquitto_install_cmd_linux_uses_apt(monkeypatch):
    monkeypatch.setattr(registry.sys, "platform", "linux")

    def _which(name: str):
        return "/usr/bin/apt-get" if name == "apt-get" else None

    monkeypatch.setattr(registry.shutil, "which", _which)
    manifest = registry.get_manifest("mosquitto")
    assert manifest is not None
    cmds = registry._build_install_cmds("brew", manifest["install"])
    assert len(cmds) == 1
    joined = " ".join(cmds[0])
    assert "apt-get install -y mosquitto" in joined


def test_mosquitto_install_cmd_macos_uses_brew(monkeypatch):
    monkeypatch.setattr(registry.sys, "platform", "darwin")
    monkeypatch.setattr(registry.shutil, "which", lambda _name: None)
    manifest = registry.get_manifest("mosquitto")
    assert manifest is not None
    cmds = registry._build_install_cmds("brew", manifest["install"])
    assert cmds == [["brew", "install", "mosquitto"]]


def test_brew_binary_path_finds_linux_via_path(monkeypatch, tmp_path):
    bin_path = tmp_path / "mosquitto"
    bin_path.write_text("#!/bin/sh\n", encoding="utf-8")
    bin_path.chmod(0o755)
    monkeypatch.setattr(registry.shutil, "which", lambda name: str(bin_path) if name == "mosquitto" else None)
    assert registry._brew_binary_path("mosquitto") == str(bin_path)
