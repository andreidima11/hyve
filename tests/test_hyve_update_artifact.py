"""Tests for artifact-based Hyve self-update."""

from __future__ import annotations

import tarfile
from pathlib import Path

from core import hyve_update_artifact as artifact
from core import hyve_update_paths as paths


def test_should_preserve_config_and_databases():
    assert paths.should_preserve_path("config.json") is True
    assert paths.should_preserve_path("users.db") is True
    assert paths.should_preserve_path("dashboards/home.json") is True
    assert paths.should_preserve_path("core/settings.py") is False


def test_copy_staged_tree_skips_preserved_and_updates_code(tmp_path: Path):
    root = tmp_path / "root"
    staging = tmp_path / "staging"
    rollback = tmp_path / "rollback"
    root.mkdir()
    staging.mkdir()
    (root / "config.json").write_text('{"version":"old"}', encoding="utf-8")
    (root / "core").mkdir()
    (root / "core" / "settings.py").write_text('RELEASE_VERSION = "0.0.1"\n', encoding="utf-8")
    (staging / "core").mkdir(parents=True)
    (staging / "core" / "settings.py").write_text('RELEASE_VERSION = "0.9.9.8"\n', encoding="utf-8")
    (staging / "config.json").write_text('{"version":"new"}', encoding="utf-8")

    replaced = artifact._copy_staged_tree(staging, root, rollback_dir=rollback)

    assert "core/settings.py" in replaced
    assert "config.json" not in replaced
    assert '0.9.9.8' in (root / "core" / "settings.py").read_text(encoding="utf-8")
    assert '"old"' in (root / "config.json").read_text(encoding="utf-8")


def test_apply_artifact_update_end_to_end(monkeypatch, tmp_path: Path):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "requirements.txt").write_text("# empty\n", encoding="utf-8")
    (root / "config.json").write_text("{}", encoding="utf-8")
    (root / "core").mkdir()
    (root / "core" / "settings.py").write_text('RELEASE_VERSION = "0.9.9.7"\n', encoding="utf-8")

    staging_src = tmp_path / "payload"
    (staging_src / "core").mkdir(parents=True)
    (staging_src / "core" / "settings.py").write_text('RELEASE_VERSION = "0.9.9.8"\n', encoding="utf-8")
    (staging_src / "static" / "dist").mkdir(parents=True)
    (staging_src / "static" / "dist" / "app.js").write_text("// built\n", encoding="utf-8")

    tarball = tmp_path / "hyve-0.9.9.8.tar.gz"
    with tarfile.open(tarball, "w:gz") as archive:
        for path in staging_src.rglob("*"):
            if path.is_file():
                archive.add(path, arcname=path.relative_to(staging_src).as_posix())

    manifest = {
        "format_version": 1,
        "version": "0.9.9.8",
        "sha256": artifact._sha256_file(tarball),
    }

    monkeypatch.setattr(artifact, "_download", lambda url, dest: dest.write_bytes(tarball.read_bytes()))
    monkeypatch.setattr(artifact, "_create_pre_update_backup", lambda _root: None)
    monkeypatch.setattr(artifact, "_pip_install", lambda _root: None)
    monkeypatch.setattr(artifact, "_run_migrations", lambda: None)

    result = artifact.apply_artifact_update(
        root=root,
        repo="andreidima11/hyve",
        tag="0.9.9.8",
        metadata={
            "version": "0.9.9.8",
            "artifact_url": "https://example/hyve-0.9.9.8.tar.gz",
            "manifest": manifest,
        },
    )

    assert result["version"] == "0.9.9.8"
    assert '0.9.9.8' in (root / "core" / "settings.py").read_text(encoding="utf-8")
    assert (root / "static" / "dist" / "app.js").is_file()


def test_fetch_artifact_metadata_falls_back_to_conventional_urls(monkeypatch):
    monkeypatch.setattr(artifact, "_release_by_tag", lambda _repo, _tag: None)
    monkeypatch.setattr(artifact, "_download_url_available", lambda url: url.endswith("hyve-0.9.9.10.tar.gz"))
    monkeypatch.setattr(
        artifact,
        "_download_json",
        lambda _url: {"format_version": 1, "version": "0.9.9.10", "sha256": "abc"},
    )

    meta = artifact.fetch_artifact_metadata("andreidima11/hyve", "0.9.9.10")

    assert meta is not None
    assert meta["artifact_url"].endswith("hyve-0.9.9.10.tar.gz")
    assert "andreidima11/hyve/releases/download/0.9.9.10/" in meta["artifact_url"]


def test_fetch_artifact_metadata_uses_api_when_available(monkeypatch):
    release = {
        "tag_name": "0.9.9.10",
        "html_url": "https://github.com/andreidima11/hyve/releases/tag/0.9.9.10",
        "assets": [
            {
                "name": "hyve-0.9.9.10.tar.gz",
                "browser_download_url": "https://example/hyve-0.9.9.10.tar.gz",
            },
            {
                "name": "hyve-0.9.9.10.manifest.json",
                "browser_download_url": "https://example/hyve-0.9.9.10.manifest.json",
            },
        ],
    }
    monkeypatch.setattr(artifact, "_release_by_tag", lambda _repo, _tag: release)
    monkeypatch.setattr(
        artifact,
        "_download_json",
        lambda _url: {"format_version": 1, "version": "0.9.9.10", "sha256": "abc"},
    )
    monkeypatch.setattr(artifact, "_conventional_artifact_metadata", lambda *_a, **_k: None)

    meta = artifact.fetch_artifact_metadata("andreidima11/hyve", "0.9.9.10")

    assert meta is not None
    assert meta["artifact_url"] == "https://example/hyve-0.9.9.10.tar.gz"
    assert meta["manifest"]["sha256"] == "abc"
