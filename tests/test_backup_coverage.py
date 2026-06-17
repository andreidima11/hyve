"""Backup must capture a full instance move (settings, integrations, automations, add-ons)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from core.backup.addons_policy import list_addon_slugs_for_backup
from core.backup.coordinator import BackupCoordinator, BackupOptions
from core.backup.paths import collect_backup_entries


def _init_users_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"
    )
    conn.execute("DELETE FROM alembic_version")
    conn.execute("INSERT INTO alembic_version (version_num) VALUES ('test_rev')")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS addon_state (
            slug TEXT PRIMARY KEY,
            installed INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 0,
            version TEXT,
            latest_version TEXT,
            config_json TEXT NOT NULL DEFAULT '{}',
            watchdog INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        INSERT INTO addon_state
        (slug, installed, enabled, version, latest_version, config_json, watchdog, created_at, updated_at)
        VALUES ('cloudflared', 1, 1, '2026.6.0', '2026.6.0', '{"origin_url":"http://192.168.1.10:8082"}', 1, 1, 1)
        """
    )
    conn.commit()
    conn.close()


def test_collect_backup_entries_covers_full_instance(tmp_path: Path, monkeypatch):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text(
        json.dumps({"setup_complete": True, "server_name": "MoveTest"}),
        encoding="utf-8",
    )
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
        "INSERT INTO integration_entries VALUES ('e1', 'demo', 'Demo', '{\"host\":\"1.2.3.4\"}', 1, 1, 1)"
    )
    conn.commit()
    conn.close()

    auto_dir = root / "core" / "automations"
    auto_dir.mkdir(parents=True)
    (auto_dir / "lights.yaml").write_text("alias: test\n", encoding="utf-8")

    dash = root / "dashboards"
    dash.mkdir()
    (dash / "_meta.json").write_text('{"current_page_id":"home"}', encoding="utf-8")
    (dash / "home.json").write_text('{"title":"Home"}', encoding="utf-8")

    (root / "skills").mkdir()
    (root / "skills" / "my_skill.py").write_text("# user skill\n", encoding="utf-8")
    (root / "skills" / "generated").mkdir()
    (root / "skills" / "generated" / "weather.py").write_text("# gen\n", encoding="utf-8")

    cf = root / "output" / "addons" / "cloudflared" / "data"
    cf.mkdir(parents=True)
    (cf / "cert.pem").write_text("pem", encoding="utf-8")

    rels = {rel for _, rel in collect_backup_entries(root, BackupOptions())}
    assert "config.json" in rels
    assert "users.db" in rels
    assert "config/integration_entries.sqlite" in rels
    assert "core/automations/lights.yaml" in rels
    assert "dashboards/home.json" in rels
    assert "dashboards/_meta.json" in rels
    assert "skills/my_skill.py" in rels
    assert "skills/generated/weather.py" in rels
    assert "output/addons/cloudflared/data/cert.pem" in rels


def test_list_addon_slugs_for_backup_includes_installed_without_data_dir(
    tmp_path: Path,
    monkeypatch,
):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text("{}", encoding="utf-8")
    _init_users_db(root / "users.db")

    monkeypatch.chdir(root)
    monkeypatch.setattr(
        "addons.registry._PROJECT_ROOT",
        root,
        raising=False,
    )
    monkeypatch.setattr(
        "addons.registry.list_available",
        lambda: [{"slug": "cloudflared"}],
    )
    monkeypatch.setattr(
        "addons.registry.get_state",
        lambda slug: {"installed": slug == "cloudflared"},
    )

    slugs = list_addon_slugs_for_backup(root)
    assert "cloudflared" in slugs


def test_full_instance_backup_roundtrip(tmp_path: Path):
    root = tmp_path / "hyve"
    root.mkdir()
    (root / "config.json").write_text(
        json.dumps({"setup_complete": True, "server_name": "RoundTrip"}),
        encoding="utf-8",
    )
    _init_users_db(root / "users.db")

    auto_dir = root / "core" / "automations"
    auto_dir.mkdir(parents=True)
    (auto_dir / "motion.yaml").write_text("alias: motion\n", encoding="utf-8")

    archive = tmp_path / "full.hyvebak"
    BackupCoordinator(root).create_backup(archive, BackupOptions())

    (auto_dir / "motion.yaml").write_text("alias: gone\n", encoding="utf-8")
    conn = sqlite3.connect(root / "users.db")
    conn.execute("DELETE FROM addon_state")
    conn.commit()
    conn.close()

    result = BackupCoordinator(root).restore_backup(archive, refetch_addons=False)
    assert "core/automations/motion.yaml" in result.restored_files

    conn = sqlite3.connect(root / "users.db")
    row = conn.execute(
        "SELECT config_json FROM addon_state WHERE slug='cloudflared'"
    ).fetchone()
    conn.close()
    assert row is not None
    assert "192.168.1.10" in row[0]
    assert (auto_dir / "motion.yaml").read_text(encoding="utf-8") == "alias: motion\n"
