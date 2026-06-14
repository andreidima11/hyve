"""Round-trip tests for core.backup."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from core.backup.addons_policy import AddonsBackupOptions, should_include_addon_file
from core.backup.coordinator import BackupCoordinator, BackupOptions
from core.backup.paths import collect_backup_entries


def _init_users_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"
    )
    conn.execute("DELETE FROM alembic_version")
    conn.execute("INSERT INTO alembic_version (version_num) VALUES ('test_rev')")
    conn.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO users (name) VALUES ('alice')")
    conn.commit()
    conn.close()


def test_addons_policy_excludes_runtime_and_respects_frigate_media():
    opts = AddonsBackupOptions()
    assert not should_include_addon_file(
        "zigbee2mqtt",
        Path("runtime/node_modules/foo.js"),
        options=opts,
    )
    assert should_include_addon_file(
        "zigbee2mqtt", Path("data/configuration.yaml"), options=opts
    )
    assert not should_include_addon_file("frigate", Path("media/clips/foo.mp4"), options=opts)
    assert should_include_addon_file(
        "frigate",
        Path("media/clips/foo.mp4"),
        options=AddonsBackupOptions(include_frigate_media=True),
    )


def test_backup_roundtrip(tmp_path: Path):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text(
        json.dumps({"setup_complete": True, "server_name": "Test"}),
        encoding="utf-8",
    )
    _init_users_db(root / "users.db")

    dash = root / "dashboards"
    dash.mkdir()
    (dash / "home.json").write_text('{"title":"Home"}', encoding="utf-8")

    z2m = root / "output" / "addons" / "zigbee2mqtt"
    (z2m / "data").mkdir(parents=True)
    (z2m / "runtime" / "node_modules").mkdir(parents=True)
    (z2m / "data" / "configuration.yaml").write_text("mqtt: {}\n", encoding="utf-8")
    (z2m / "runtime" / "node_modules" / "pkg.js").write_text("// no", encoding="utf-8")

    archive = tmp_path / "test.hyvebak"
    coord = BackupCoordinator(root)
    manifest = coord.create_backup(archive, BackupOptions())
    assert manifest.format_version == 1
    assert manifest.alembic_revision == "test_rev"
    assert any(f.path == "dashboards/home.json" for f in manifest.files)
    assert any(f.path.endswith("zigbee2mqtt/data/configuration.yaml") for f in manifest.files)
    assert not any("node_modules" in f.path for f in manifest.files)

    coord.verify_archive(archive)

    # Mutate live data
    (dash / "home.json").write_text('{"title":"Gone"}', encoding="utf-8")
    conn = sqlite3.connect(root / "users.db")
    conn.execute("DELETE FROM users")
    conn.commit()
    conn.close()

    result = coord.restore_backup(archive)
    assert "dashboards/home.json" in result.restored_files
    assert json.loads((dash / "home.json").read_text(encoding="utf-8"))["title"] == "Home"

    conn = sqlite3.connect(root / "users.db")
    row = conn.execute("SELECT name FROM users").fetchone()
    conn.close()
    assert row[0] == "alice"


def test_collect_backup_entries_respects_optional(tmp_path: Path):
    root = tmp_path / "hyve"
    chroma = root / "chroma_db"
    chroma.mkdir(parents=True)
    (chroma / "index.bin").write_bytes(b"x")

    default = collect_backup_entries(root, BackupOptions())
    assert not any(p.endswith("chroma_db/index.bin") for _, p in default)

    optional = collect_backup_entries(root, BackupOptions(include_optional=True))
    assert any(p.endswith("chroma_db/index.bin") for _, p in optional)
