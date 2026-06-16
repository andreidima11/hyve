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


def test_backup_includes_integration_entries_sqlite(tmp_path: Path):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text("{}", encoding="utf-8")
    _init_users_db(root / "users.db")

    entries_db = root / "config" / "integration_entries.sqlite"
    entries_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(entries_db)
    conn.execute(
        """
        CREATE TABLE integration_entries (
            entry_id TEXT PRIMARY KEY,
            slug TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO integration_entries(entry_id, slug, title, data_json, enabled, created_at, updated_at) "
        "VALUES ('e1', 'demo', 'Demo account', '{}', 1, 1, 1)"
    )
    conn.commit()
    conn.close()

    archive = tmp_path / "integrations.hyvebak"
    manifest = BackupCoordinator(root).create_backup(archive, BackupOptions())
    paths = {f.path for f in manifest.files}
    assert "config/integration_entries.sqlite" in paths

    conn = sqlite3.connect(entries_db)
    conn.execute("DELETE FROM integration_entries")
    conn.commit()
    conn.close()

    BackupCoordinator(root).restore_backup(archive)
    conn = sqlite3.connect(entries_db)
    row = conn.execute("SELECT slug, title FROM integration_entries").fetchone()
    conn.close()
    assert row == ("demo", "Demo account")


def test_backup_includes_memory_log_sqlite(tmp_path: Path):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text("{}", encoding="utf-8")
    _init_users_db(root / "users.db")

    mem_log = root / "memory_log.sqlite"
    conn = sqlite3.connect(mem_log)
    conn.execute(
        "CREATE TABLE memory_events (id INTEGER PRIMARY KEY, event_type TEXT, payload TEXT)"
    )
    conn.execute(
        "INSERT INTO memory_events (event_type, payload) VALUES ('fact_added', '{\"fact\":\"coffee\"}')"
    )
    conn.commit()
    conn.close()

    archive = tmp_path / "memory-log.hyvebak"
    manifest = BackupCoordinator(root).create_backup(archive, BackupOptions())
    paths = {f.path for f in manifest.files}
    assert "memory_log.sqlite" in paths

    conn = sqlite3.connect(mem_log)
    conn.execute("DELETE FROM memory_events")
    conn.commit()
    conn.close()

    BackupCoordinator(root).restore_backup(archive)
    conn = sqlite3.connect(mem_log)
    row = conn.execute("SELECT event_type, payload FROM memory_events").fetchone()
    conn.close()
    assert row == ("fact_added", '{"fact":"coffee"}')


def test_collect_backup_entries_respects_optional(tmp_path: Path):
    root = tmp_path / "hyve"
    chroma = root / "chroma_db"
    chroma.mkdir(parents=True)
    (chroma / "index.bin").write_bytes(b"x")

    default = collect_backup_entries(root, BackupOptions())
    assert not any(p.endswith("chroma_db/index.bin") for _, p in default)

    optional = collect_backup_entries(root, BackupOptions(include_optional=True))
    assert any(p.endswith("chroma_db/index.bin") for _, p in optional)


def test_backup_includes_non_sqlite_addon_db_files(tmp_path: Path):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text("{}", encoding="utf-8")
    _init_users_db(root / "users.db")

    mosq = root / "output" / "addons" / "mosquitto" / "data"
    mosq.mkdir(parents=True)
    (mosq / "mosquitto.db").write_bytes(b"\x00\xb5\x00mosquitto db\x00")

    z2m = root / "output" / "addons" / "zigbee2mqtt" / "data"
    z2m.mkdir(parents=True)
    (z2m / "database.db").write_text('{"1": {"friendly_name": "test"}}', encoding="utf-8")

    archive = tmp_path / "addon-db.hyvebak"
    manifest = BackupCoordinator(root).create_backup(archive, BackupOptions())
    paths = {f.path for f in manifest.files}
    assert "output/addons/mosquitto/data/mosquitto.db" in paths
    assert "output/addons/zigbee2mqtt/data/database.db" in paths
