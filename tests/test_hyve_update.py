"""Hyve self-update helpers (GitHub releases + version compare)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core import hyve_update as hu


def test_is_newer_semver():
    assert hu.is_newer("0.9.6.3", "0.9.6.2") is True
    assert hu.is_newer("0.9.6.2", "0.9.6.2") is False
    assert hu.is_newer("0.9.6.1", "0.9.6.2") is False
    assert hu.is_newer("0.10.0", "0.9.9") is True


def test_normalize_tag():
    assert hu._normalize_tag("v0.9.6.2") == "0.9.6.2"
    assert hu._normalize_tag("0.9.6.2") == "0.9.6.2"


def test_fetch_latest_release_parses_github_payload(monkeypatch):
    payload = {
        "tag_name": "0.9.6.3",
        "html_url": "https://github.com/andreidima11/hyve/releases/tag/0.9.6.3",
        "body": "Notes",
    }

    def _fake_request(url: str):
        assert "andreidima11/hyve" in url
        return payload

    monkeypatch.setattr(hu, "_github_request", _fake_request)
    release = hu.fetch_latest_release("andreidima11/hyve")
    assert release["version"] == "0.9.6.3"
    assert release["tag"] == "0.9.6.3"


def test_check_for_update_marks_available(monkeypatch):
    monkeypatch.setattr(hu, "current_version", lambda: "0.9.6.2")
    monkeypatch.setattr(
        hu,
        "_resolve_latest_release",
        lambda: {
            "tag": "0.9.6.3",
            "version": "0.9.6.3",
            "html_url": "https://example/release",
            "body": "Fixes",
            "source": "github",
        },
    )
    status = hu.check_for_update()
    assert status["current"] == "0.9.6.2"
    assert status["latest"] == "0.9.6.3"
    assert status["update_available"] is True
    assert status["error"] is None


def test_check_for_update_no_release_sources(monkeypatch):
    monkeypatch.setattr(hu, "current_version", lambda: "0.9.6.2")
    monkeypatch.setattr(hu, "_release_from_github", lambda: None)
    monkeypatch.setattr(hu, "_git_remote_latest_tag", lambda: None)
    status = hu.check_for_update()
    assert status["error"]["key"] == "updates.hyve_check_failed"
    assert status["latest"] == "0.9.6.2"
    assert status["update_available"] is False


def test_resolve_latest_release_picks_newest_semver(monkeypatch):
    monkeypatch.setattr(
        hu,
        "_release_from_github",
        lambda: {"version": "0.9.7.0", "tag": "0.9.7.0", "source": "github"},
    )
    monkeypatch.setattr(hu, "_git_remote_latest_tag", lambda: "0.9.7.3")
    release = hu._resolve_latest_release()
    assert release["version"] == "0.9.7.3"
    assert release["source"] == "git"


def test_resolve_latest_release_merges_github_notes_when_git_wins(monkeypatch):
    monkeypatch.setattr(
        hu,
        "_release_from_github",
        lambda: {
            "version": "0.9.7.0",
            "tag": "0.9.7.0",
            "source": "github",
            "body": "GitHub notes",
            "html_url": "https://github.com/example/hyve/releases/tag/0.9.7.0",
        },
    )
    monkeypatch.setattr(hu, "_git_remote_latest_tag", lambda: "0.9.7.3")
    release = hu._resolve_latest_release()
    assert release["version"] == "0.9.7.3"
    assert release["body"] == "GitHub notes"
    assert release["html_url"] == "https://github.com/example/hyve/releases/tag/0.9.7.0"


def test_get_status_enriches_empty_release_notes(monkeypatch):
    monkeypatch.setattr(hu, "current_version", lambda: "0.9.7.13")
    monkeypatch.setattr(
        hu,
        "_last_hyve_check",
        {
            "latest": "0.9.7.13",
            "tag": "0.9.7.13",
            "release_url": "",
            "release_notes": "",
            "checked_at": "2026-01-01T00:00:00+00:00",
            "error": None,
        },
    )
    monkeypatch.setattr(
        hu,
        "_enrich_release_notes_from_github",
        lambda _v: {"body": "Enriched", "url": "https://github.com/org/hyve/releases/tag/0.9.7.13"},
    )
    status = hu.get_status()
    assert status["release_notes"] == "Enriched"
    assert status["release_url"].endswith("/releases/tag/0.9.7.13")


def test_blocking_dirty_lines_ignores_build_artifacts():
    porcelain = "\n".join(
        [
            " M static/css/tailwind.built.css",
            " M static/js/app.js",
            " M package-lock.json",
            " M config.json",
        ]
    )
    blocking = hu._blocking_dirty_lines(porcelain)
    assert len(blocking) == 1
    assert "config.json" in hu._dirty_path_from_porcelain(blocking[0])


def test_apply_update_requires_git(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(hu, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(hu, "check_for_update", lambda: {"update_available": True})
    monkeypatch.setattr(hu, "get_status", lambda: {"update_available": True})
    monkeypatch.setattr(hu, "is_git_install", lambda: False)
    with pytest.raises(hu.HyveUpdateError) as exc:
        hu.apply_update()
    assert exc.value.key == "updates.hyve_not_git"


def test_apply_update_checkout_and_restart(monkeypatch, tmp_path: Path):
    (tmp_path / ".git").mkdir()
    calls: list[list[str]] = []

    monkeypatch.setattr(hu, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(hu, "_last_hyve_check", {"tag": "0.9.6.3", "latest": "0.9.6.3"})
    monkeypatch.setattr(hu, "check_for_update", lambda: {"update_available": True, "latest": "0.9.6.3"})
    monkeypatch.setattr(hu, "get_status", lambda: {"update_available": True, "latest": "0.9.6.3"})
    monkeypatch.setattr(hu, "_assert_git_ready", lambda: None)
    monkeypatch.setattr(hu, "_fetch_tags", lambda: None)
    monkeypatch.setattr(hu, "_pip_install", lambda: None)
    monkeypatch.setattr(hu, "_js_build", lambda: None)

    def _record_checkout(tag: str):
        calls.append(["checkout", tag])

    restarted: list[str] = []

    def _restart(**kwargs):
        restarted.append(kwargs.get("log_msg", ""))

    monkeypatch.setattr(hu, "_checkout_tag", _record_checkout)
    monkeypatch.setattr("core.server_restart.schedule_restart", _restart)

    result = hu.apply_update()
    assert calls == [["checkout", "0.9.6.3"]]
    assert result["version"] == "0.9.6.3"
    assert restarted
