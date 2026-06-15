"""Cloudflared add-on manifest and config tests."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from addons import registry
from addons.process_manager import _effective_config, _resolve_args

ROOT = Path(__file__).resolve().parents[1]
RUN_SH = ROOT / "addons" / "available" / "cloudflared" / "run.sh"


def test_cloudflared_is_registered():
    addons = {item["slug"]: item for item in registry.list_available()}
    assert "cloudflared" in addons
    manifest = addons["cloudflared"]
    assert manifest["install"]["method"] == "docker"
    assert manifest["install"]["image"] == "cloudflare/cloudflared:latest"


def test_cloudflared_config_schema():
    manifest = registry.get_manifest("cloudflared")
    assert manifest is not None
    keys = {field["key"] for field in manifest.get("config_schema", [])}
    assert {
        "tunnel_token",
        "external_hostname",
        "tunnel_name",
        "origin_url",
        "sync_origin_to_cloudflare",
        "cloudflare_api_token",
        "additional_hosts",
        "catch_all_service",
        "metrics_port",
        "log_level",
        "post_quantum",
    }.issubset(keys)


def test_cloudflared_start_command_resolves_placeholders():
    manifest = registry.get_manifest("cloudflared")
    assert manifest is not None
    merged = _effective_config(
        manifest,
        {
            "external_hostname": "hyve.example.com",
            "tunnel_name": "hyve",
            "metrics_port": 36500,
            "log_level": "info",
            "post_quantum": False,
            "additional_hosts": "[]",
        },
    )
    args = _resolve_args(manifest["start_command"]["args"], merged)
    assert args[0] == "run.sh"
    assert args[2] == "hyve.example.com"
    assert args[3] == "hyve"
    assert args[7] == "36500"
    assert args[8] == "info"


def test_cloudflared_run_sh_syntax():
    assert RUN_SH.is_file()
    proc = subprocess.run(["bash", "-n", str(RUN_SH)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_cloudflared_manifest_json_valid():
    manifest_path = ROOT / "addons" / "available" / "cloudflared" / "manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert data["slug"] == "cloudflared"
    assert data["health_check"]["port_key"] == "metrics_port"


def test_cloudflared_addon_entry_includes_origin_suggestion(monkeypatch):
    monkeypatch.setattr(
        "core.network_utils.detect_lan_ip",
        lambda: "192.168.1.100",
    )
    entry = registry.addon_entry(registry.get_manifest("cloudflared"))
    assert entry["config_suggestions"]["origin_url"] == "http://192.168.1.100:8082"
