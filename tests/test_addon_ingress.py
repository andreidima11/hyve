"""Tests for addon Web UI ingress (reverse proxy through Hyve)."""

import time

import pytest

from addons import ingress


def test_ingress_cookie_roundtrip():
    cookie = ingress.make_ingress_cookie(7, "zigbee2mqtt", ttl=120)
    assert ingress.verify_ingress_cookie(cookie, "zigbee2mqtt") == 7
    assert ingress.verify_ingress_cookie(cookie, "other") is None
    assert ingress.verify_ingress_cookie("bad", "zigbee2mqtt") is None


def test_ingress_cookie_expired():
    exp = int(time.time()) - 10
    cookie = ingress._sign_ingress_payload(f"1:z2m:{exp}")
    assert ingress.verify_ingress_cookie(cookie, "z2m") is None


def test_resolve_addon_upstream_localhost(monkeypatch):
    monkeypatch.setattr(
        ingress.registry,
        "get_manifest",
        lambda slug: {
            "web_ui": {"host": "localhost", "port_key": "web_port", "protocol": "http", "path": "/"},
        },
    )
    monkeypatch.setattr(
        ingress.registry,
        "get_state",
        lambda slug: {"config": {"web_port": 8080}},
    )
    assert ingress.resolve_addon_upstream("zigbee2mqtt") == "http://127.0.0.1:8080"


def test_resolve_addon_upstream_external_url_skipped(monkeypatch):
    monkeypatch.setattr(
        ingress.registry,
        "get_manifest",
        lambda slug: {"web_ui": {"url_key": "public_url"}},
    )
    monkeypatch.setattr(
        ingress.registry,
        "get_state",
        lambda slug: {"config": {"public_url": "https://z2m.example.com/"}},
    )
    assert ingress.resolve_addon_upstream("zigbee2mqtt") is None


def test_rewrite_location_header():
    upstream = "http://127.0.0.1:8080"
    assert ingress._rewrite_location("/devices", "zigbee2mqtt", upstream) == (
        "/api/addons/zigbee2mqtt/ui/devices"
    )
    assert ingress._rewrite_location("http://localhost:8080/foo", "zigbee2mqtt", upstream) == (
        "/api/addons/zigbee2mqtt/ui/foo"
    )


def test_rewrite_html_paths():
    html = b'<html><head></head><body><script src="/assets/app.js"></script><a href="/devices">x</a></body></html>'
    out = ingress._rewrite_html_paths(html, "zigbee2mqtt")
    assert b'src="/api/addons/zigbee2mqtt/ui/assets/app.js"' in out
    assert b'href="/api/addons/zigbee2mqtt/ui/devices"' in out


def test_inject_base_href():
    html = b"<!DOCTYPE html><html><head><title>x</title></head><body></body></html>"
    out = ingress._inject_base_href(html, "zigbee2mqtt")
    assert b'<base href="/api/addons/zigbee2mqtt/ui/">' in out


def test_build_upstream_target(monkeypatch):
    monkeypatch.setattr(
        ingress,
        "resolve_addon_upstream",
        lambda slug: "http://127.0.0.1:8080",
    )
    assert ingress.build_upstream_target("z2m", "") == "http://127.0.0.1:8080/"
    assert ingress.build_upstream_target("z2m", "assets/app.js") == (
        "http://127.0.0.1:8080/assets/app.js"
    )
