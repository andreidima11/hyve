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


def test_resolve_latest_release_enriches_notes_for_winning_version(monkeypatch):
    monkeypatch.setattr(
        hu,
        "_release_from_github",
        lambda: {
            "version": "0.9.7.0",
            "tag": "0.9.7.0",
            "source": "github",
            "body": "Old latest notes",
            "html_url": "https://github.com/example/hyve/releases/tag/0.9.7.0",
        },
    )
    monkeypatch.setattr(hu, "_git_remote_latest_tag", lambda: "0.9.7.3")
    monkeypatch.setattr(
        hu,
        "_enrich_release_notes_for_version",
        lambda v: {"body": f"Notes for {v}", "url": f"https://github.com/example/hyve/releases/tag/{v}"},
    )
    release = hu._resolve_latest_release()
    assert release["version"] == "0.9.7.3"
    assert release["body"] == "Notes for 0.9.7.3"
    assert release["html_url"].endswith("/0.9.7.3")


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
        "_enrich_release_notes_for_version",
        lambda _v: {"body": "Enriched", "url": "https://github.com/org/hyve/releases/tag/0.9.7.13"},
    )
    status = hu.get_status()
    assert status["release_notes"] == "Enriched"
    assert status["release_url"].endswith("/releases/tag/0.9.7.13")


def test_enrich_release_notes_for_version_falls_back_to_changelog(monkeypatch, tmp_path):
    from core import changelog_notes as cn

    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "## [0.9.8.20] — 2026-06\n\n### Frontend\n- Scroll fix\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(hu, "_enrich_release_notes_from_github", lambda _v: {"body": "", "url": ""})
    monkeypatch.setattr(
        hu,
        "changelog_section",
        lambda v: cn.changelog_section(v, changelog_path=changelog),
    )
    out = hu._enrich_release_notes_for_version("0.9.8.20")
    assert "Scroll fix" in out["body"]


def test_blocking_dirty_lines_ignores_build_artifacts():
    porcelain = "\n".join(
        [
            " M static/css/tailwind.built.css",
            " M static/js/app.js",
            " M package-lock.json",
            " M config.json",
            " M static/hyveview/elements/camera_stream.js",
            " M static/hyveview/elements/mammotion_camera.js.map",
            " M custom_components/demo_sensor/__pycache__/entity.cpython-313.pyc",
            " M core/settings.py",
        ]
    )
    blocking = hu._blocking_dirty_lines(porcelain)
    assert len(blocking) == 1
    assert "core/settings.py" in hu._dirty_path_from_porcelain(blocking[0])


def test_ignored_dirty_paths_from_porcelain():
    porcelain = "\n".join(
        [
            " M static/hyveview/elements/mammotion_camera.js.map",
            " M static/css/tailwind.built.css",
            " M core/settings.py",
        ]
    )
    paths = hu._ignored_dirty_paths_from_porcelain(porcelain)
    assert "static/hyveview/elements/mammotion_camera.js.map" in paths
    assert "static/css/tailwind.built.css" in paths
    assert "core/settings.py" not in paths


def test_reset_ignored_dirty_paths_checkout(monkeypatch, tmp_path: Path):
    (tmp_path / ".git").mkdir()
    calls: list[list[str]] = []

    def _fake_run(args, **kwargs):
        calls.append(list(args))
        class _Proc:
            returncode = 0
            stdout = " M static/hyveview/elements/mammotion_camera.js.map\n"
            stderr = ""
        return _Proc()

    monkeypatch.setattr(hu, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(hu, "is_git_install", lambda: True)
    monkeypatch.setattr(hu, "_run_cmd", _fake_run)

    reset = hu._reset_ignored_dirty_paths()
    assert reset == ["static/hyveview/elements/mammotion_camera.js.map"]
    assert ["git", "checkout", "--", "static/hyveview/elements/mammotion_camera.js.map"] in calls


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
    monkeypatch.setattr(hu, "_reset_ignored_dirty_paths", lambda: [])
    monkeypatch.setattr(hu, "_assert_git_ready", lambda: None)
    monkeypatch.setattr(hu, "_fetch_tags", lambda: None)
    monkeypatch.setattr(hu, "_pip_install", lambda: None)
    monkeypatch.setattr(hu, "_js_build", lambda: None)
    monkeypatch.setattr(hu, "_git_head_ref", lambda: "abc123")
    monkeypatch.setattr(hu, "_frontend_build_required", lambda: False)

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


def test_get_status_includes_prerequisites(monkeypatch):
    monkeypatch.setattr(hu, "current_version", lambda: "0.9.6.2")
    monkeypatch.setattr(
        hu,
        "_last_hyve_check",
        {
            "latest": "0.9.6.2",
            "tag": "0.9.6.2",
            "release_url": "",
            "release_notes": "",
            "checked_at": "2026-01-01T00:00:00+00:00",
            "error": None,
        },
    )
    monkeypatch.setattr(hu, "_npm_available", lambda: True)
    monkeypatch.setattr(hu, "_frontend_dist_ready", lambda: False)
    monkeypatch.setattr(hu, "_frontend_build_required", lambda: True)
    status = hu.get_status()
    prereq = status["prerequisites"]
    assert prereq["npm_available"] is True
    assert prereq["frontend_dist_ready"] is False
    assert prereq["frontend_build_required"] is True
    assert "npm ci" in prereq["frontend_build_commands"]


def test_apply_update_requires_npm_before_checkout(monkeypatch, tmp_path: Path):
    (tmp_path / ".git").mkdir()
    checkout_called: list[str] = []

    monkeypatch.setattr(hu, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(hu, "_last_hyve_check", {"tag": "0.9.6.3", "latest": "0.9.6.3"})
    monkeypatch.setattr(hu, "check_for_update", lambda: {"update_available": True})
    monkeypatch.setattr(hu, "get_status", lambda: {"update_available": True})
    monkeypatch.setattr(hu, "_reset_ignored_dirty_paths", lambda: [])
    monkeypatch.setattr(hu, "_assert_git_ready", lambda: None)
    monkeypatch.setattr(hu, "_fetch_tags", lambda: None)
    monkeypatch.setattr(hu, "_frontend_build_required", lambda: True)
    monkeypatch.setattr(hu, "_npm_path", lambda: None)
    monkeypatch.setattr(hu, "_checkout_tag", lambda tag: checkout_called.append(tag))
    restarted: list[int] = []
    monkeypatch.setattr("core.server_restart.schedule_restart", lambda **_: restarted.append(1))

    with pytest.raises(hu.HyveUpdateError) as exc:
        hu.apply_update()
    assert exc.value.key == "updates.hyve_npm_required"
    assert not checkout_called
    assert not restarted


def test_apply_update_rolls_back_on_frontend_build_failure(monkeypatch, tmp_path: Path):
    (tmp_path / ".git").mkdir()
    rollback_refs: list[str] = []

    monkeypatch.setattr(hu, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(hu, "_last_hyve_check", {"tag": "0.9.6.3", "latest": "0.9.6.3"})
    monkeypatch.setattr(hu, "check_for_update", lambda: {"update_available": True})
    monkeypatch.setattr(hu, "get_status", lambda: {"update_available": True})
    monkeypatch.setattr(hu, "_reset_ignored_dirty_paths", lambda: [])
    monkeypatch.setattr(hu, "_assert_git_ready", lambda: None)
    monkeypatch.setattr(hu, "_fetch_tags", lambda: None)
    monkeypatch.setattr(hu, "_pip_install", lambda: None)
    monkeypatch.setattr(hu, "_git_head_ref", lambda: "abc123")
    monkeypatch.setattr(hu, "_checkout_tag", lambda _tag: None)
    monkeypatch.setattr(hu, "_frontend_build_required", lambda: True)
    monkeypatch.setattr(hu, "_npm_path", lambda: "/usr/bin/npm")
    def _fail_build():
        raise hu.HyveUpdateError(
            "updates.hyve_frontend_build_failed",
            {"detail": "boom", "commands": "npm ci && npm run js:build"},
        )

    monkeypatch.setattr(hu, "_js_build", _fail_build)
    monkeypatch.setattr(hu, "_git_checkout_ref", lambda ref: rollback_refs.append(ref))
    restarted: list[int] = []
    monkeypatch.setattr("core.server_restart.schedule_restart", lambda **_: restarted.append(1))

    with pytest.raises(hu.HyveUpdateError) as exc:
        hu.apply_update()
    assert exc.value.key == "updates.hyve_frontend_build_failed"
    assert rollback_refs == ["abc123"]
    assert not restarted
