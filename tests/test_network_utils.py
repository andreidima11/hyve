"""Tests for core.network_utils."""

from __future__ import annotations

from pathlib import Path

from core import network_utils as nu


def test_read_hyve_port_from_config(tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text('{"port": 9001}', encoding="utf-8")
    assert nu.read_hyve_port(cfg) == 9001


def test_read_hyve_port_invalid_falls_back(tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text('{"port": 99999}', encoding="utf-8")
    assert nu.read_hyve_port(cfg) == 8082


def test_suggest_origin_url_prefers_lan(monkeypatch):
    monkeypatch.setattr(nu, "detect_lan_ip", lambda: "192.168.0.50")
    monkeypatch.setattr(nu.sys, "platform", "linux")
    out = nu.suggest_origin_url(port=8082, prefer_lan=True)
    assert out["origin_url"] == "http://192.168.0.50:8082"
    assert "http://127.0.0.1:8082" in out["origin_url_alternatives"]


def test_suggest_origin_url_darwin_fallback(monkeypatch):
    monkeypatch.setattr(nu, "detect_lan_ip", lambda: None)
    monkeypatch.setattr(nu.sys, "platform", "darwin")
    out = nu.suggest_origin_url(port=8082, prefer_lan=True)
    assert out["origin_url"] == "http://host.docker.internal:8082"


def test_suggest_origin_url_respects_prefer_lan_false(monkeypatch):
    monkeypatch.setattr(nu, "detect_lan_ip", lambda: "10.0.0.8")
    monkeypatch.setattr(nu.sys, "platform", "linux")
    out = nu.suggest_origin_url(port=8082, prefer_lan=False)
    assert out["origin_url"] == "http://127.0.0.1:8082"
