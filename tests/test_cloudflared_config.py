"""Tests for cloudflared Cloudflare API sync."""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock, patch

import pytest

from addons import cloudflared_config as cc


def _sample_token(account: str = "acc123", tunnel: str = "tun456") -> str:
    payload = json.dumps({"a": account, "t": tunnel, "s": "secret"}).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def test_decode_tunnel_token():
    account, tunnel = cc.decode_tunnel_token(_sample_token())
    assert account == "acc123"
    assert tunnel == "tun456"


def test_build_ingress_rules_includes_hostname_and_catchall():
    rules = cc.build_ingress_rules(
        hostname="hyve.example.com",
        origin="http://192.168.0.10:8082",
    )
    assert rules[0]["hostname"] == "hyve.example.com"
    assert rules[0]["service"] == "http://192.168.0.10:8082"
    assert rules[-1]["service"] == "http_status:404"


def test_resolve_effective_origin_prefers_explicit():
    assert cc.resolve_effective_origin("http://10.0.0.1:9000") == "http://10.0.0.1:9000"


def test_sync_tunnel_ingress_puts_config(monkeypatch):
    captured: dict = {}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"success": True}).encode()

    def fake_urlopen(req, timeout=30):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["body"] = json.loads(req.data.decode())
        return FakeResp()

    monkeypatch.setattr(cc.urllib.request, "urlopen", fake_urlopen)
    cc.sync_tunnel_ingress(
        tunnel_token=_sample_token(),
        api_token="cf_api_token",
        hostname="hv.example.com",
        origin="http://192.168.1.5:8082",
    )
    assert "acc123/cfd_tunnel/tun456/configurations" in captured["url"]
    assert captured["method"] == "PUT"
    ingress = captured["body"]["config"]["ingress"]
    assert ingress[0]["service"] == "http://192.168.1.5:8082"


def test_maybe_sync_from_addon_config_requires_api_token():
    assert cc.maybe_sync_from_addon_config({"tunnel_token": _sample_token()}) is None


def test_maybe_sync_from_addon_config_requires_hostname():
    with pytest.raises(ValueError):
        cc.maybe_sync_from_addon_config({
            "tunnel_token": _sample_token(),
            "cloudflare_api_token": "cf_api",
        })


def test_maybe_sync_from_addon_config_skips_without_token():
    assert cc.maybe_sync_from_addon_config({"origin_url": "http://127.0.0.1:8082"}) is None
