"""User-local data paths (dashboards, aliases, automations, skills)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core import user_data


def test_reset_user_data_clears_dashboards_and_aliases(tmp_path, monkeypatch):
    monkeypatch.setattr(user_data, "ROOT", tmp_path)

    dash = tmp_path / "dashboards"
    dash.mkdir()
    (dash / "acasa.json").write_text("{}", encoding="utf-8")
    (dash / "_meta.json").write_text("{}", encoding="utf-8")
    (dash / "README.md").write_text("keep", encoding="utf-8")
    backups = dash / ".backups"
    backups.mkdir()
    (backups / "store-1.json").write_text("{}", encoding="utf-8")

    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "device_aliases.yaml").write_text("aliases: {}\n", encoding="utf-8")

    auto = tmp_path / "core" / "automations" / "user_1"
    auto.mkdir(parents=True)
    (auto / "lights.yaml").write_text("id: x\n", encoding="utf-8")

    skills = tmp_path / "skills"
    skills.mkdir()
    (skills / "yahoo_finance.py").write_text("# user\n", encoding="utf-8")
    (skills / "__init__.py").write_text("", encoding="utf-8")
    gen = skills / "generated"
    gen.mkdir()
    (gen / "weather.py").write_text("# gen\n", encoding="utf-8")
    versions = gen / "__versions__"
    versions.mkdir()
    (versions / "old.py").write_text("# old\n", encoding="utf-8")

    comfy = tmp_path / "comfyui_workflows"
    comfy.mkdir()
    (comfy / "z_image_turbo.json").write_text("{}", encoding="utf-8")

    media = tmp_path / "static" / "generated"
    media.mkdir(parents=True)
    vendor = media / "vendor"
    vendor.mkdir()
    (vendor / "dompurify.min.js").write_text("// keep", encoding="utf-8")
    (media / "abc123.png").write_bytes(b"png")

    removed = user_data.reset_user_data()
    assert any("acasa.json" in line for line in removed)
    assert any("device_aliases" in line for line in removed)
    assert any("automations/user_1" in line for line in removed)
    assert any("skills/yahoo_finance.py" in line for line in removed)
    assert any("skills/generated" in line for line in removed)
    assert any("comfyui_workflows/z_image_turbo.json" in line for line in removed)
    assert any("static/generated/abc123.png" in line for line in removed)

    assert not (dash / "acasa.json").exists()
    assert (dash / "README.md").read_text(encoding="utf-8") == "keep"
    assert not (cfg / "device_aliases.yaml").exists()
    assert not auto.exists()
    assert (skills / "__init__.py").is_file()
    assert not (gen / "weather.py").exists()
    assert not (skills / "yahoo_finance.py").exists()
    assert not (comfy / "z_image_turbo.json").exists()
    assert not (media / "abc123.png").exists()
    assert (vendor / "dompurify.min.js").read_text(encoding="utf-8") == "// keep"


def test_install_fresh_calls_user_data_reset(tmp_path, monkeypatch):
    from scripts import install_hyve as ih

    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"setup_complete": True}), encoding="utf-8")
    db = tmp_path / "hyve.db"
    db.write_text("", encoding="utf-8")

    monkeypatch.setattr(ih, "ROOT", tmp_path)
    monkeypatch.setattr(ih, "CONFIG_FILE", cfg)
    calls: list[str] = []

    def _fake_reset():
        calls.append("user_data")
        return []

    monkeypatch.setattr("core.user_data.reset_user_data", _fake_reset)

    ih.reset_first_run_state()

    assert not db.exists()
    assert json.loads(cfg.read_text(encoding="utf-8"))["setup_complete"] is False
    assert calls == ["user_data"]
