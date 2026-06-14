"""install_hyve.py helpers."""

from __future__ import annotations

from scripts import install_hyve as ih


def test_build_access_urls_includes_localhost():
    urls = ih.build_access_urls(8082, lan_ip=None)
    assert "http://127.0.0.1:8082/" in urls


def test_build_access_urls_adds_lan_when_distinct():
    urls = ih.build_access_urls(8082, lan_ip="192.168.0.124")
    assert urls[0] == "http://127.0.0.1:8082/"
    assert "http://192.168.0.124:8082/" in urls


def test_build_access_urls_skips_duplicate_loopback():
    urls = ih.build_access_urls(8082, lan_ip="127.0.0.1")
    assert urls == ["http://127.0.0.1:8082/"]


def test_format_setup_banner_wizard():
    text = ih.format_setup_banner(complete=False, bootstrap=False)
    assert "wizard" in text.lower() or "Setup wizard" in text


def test_format_setup_banner_bootstrap():
    text = ih.format_setup_banner(complete=True, bootstrap=True)
    assert "bootstrap" in text.lower() or "admin" in text.lower()
