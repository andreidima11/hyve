"""Docker bootstrap for docker-method add-ons."""

from __future__ import annotations

from addons import registry


def test_bootstrap_skips_when_daemon_up(monkeypatch):
    monkeypatch.setattr(registry, "_docker_daemon_reachable", lambda: True)
    assert registry._bootstrap_cmds_for_method("docker") == []


def test_bootstrap_linux_uses_apt(monkeypatch):
    monkeypatch.setattr(registry, "_docker_daemon_reachable", lambda: False)
    monkeypatch.setattr(registry.sys, "platform", "linux")

    def _which(name: str):
        return {
            "apt-get": "/usr/bin/apt-get",
            "docker": None,
            "systemctl": "/bin/systemctl",
        }.get(name)

    monkeypatch.setattr(registry.shutil, "which", _which)
    cmds = registry._bootstrap_cmds_for_method("docker")
    joined = "\n".join(" ".join(c) for c in cmds)
    assert "apt-get install -y docker.io" in joined
    assert "systemctl enable --now docker" in joined


def test_bootstrap_linux_start_only_when_docker_installed(monkeypatch):
    monkeypatch.setattr(registry, "_docker_daemon_reachable", lambda: False)
    monkeypatch.setattr(registry.sys, "platform", "linux")

    def _which(name: str):
        return {
            "docker": "/usr/bin/docker",
            "systemctl": "/bin/systemctl",
        }.get(name)

    monkeypatch.setattr(registry.shutil, "which", _which)
    cmds = registry._bootstrap_cmds_for_method("docker")
    assert len(cmds) == 1
    assert "systemctl enable --now docker" in " ".join(cmds[0])


def test_bootstrap_macos_uses_brew(monkeypatch):
    monkeypatch.setattr(registry, "_docker_daemon_reachable", lambda: False)
    monkeypatch.setattr(registry.sys, "platform", "darwin")

    def _which(name: str):
        return {
            "brew": "/opt/homebrew/bin/brew",
            "docker": None,
            "colima": None,
        }.get(name)

    monkeypatch.setattr(registry.shutil, "which", _which)
    cmds = registry._bootstrap_cmds_for_method("docker")
    assert cmds[0][:2] == ["brew", "install"]
    assert "colima start" in cmds[-1][-1]
