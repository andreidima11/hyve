"""Hyveview card package discovery."""

from __future__ import annotations

import json

from core.cards.loader import (
    discover_bundled_card_packages,
    discover_custom_card_packages,
    list_card_packages,
)


def test_discover_bundled_fusion_solar_package():
    packages = discover_bundled_card_packages()
    ids = {p["id"] for p in packages}
    assert "fusion_solar" in ids
    fs = next(p for p in packages if p["id"] == "fusion_solar")
    assert fs["entry"].endswith("/fusion_solar/index.js")
    assert any(s.endswith("styles.css") for s in fs["styles"])


def test_discover_custom_card_packages(tmp_path, monkeypatch):
    card_dir = tmp_path / "hello_card"
    card_dir.mkdir()
    (card_dir / "manifest.json").write_text(
        json.dumps(
            {
                "id": "hello_card",
                "name": "Hello",
                "entry": "index.js",
                "styles": ["styles.css"],
                "hyve_card": True,
            }
        ),
        encoding="utf-8",
    )
    (card_dir / "index.js").write_text("export function register() {}", encoding="utf-8")
    (card_dir / "styles.css").write_text("/* test */", encoding="utf-8")

    monkeypatch.setattr("core.cards.loader.custom_cards_dir", lambda: tmp_path)
    custom = discover_custom_card_packages()
    assert len(custom) == 1
    assert custom[0]["id"] == "hello_card"
    assert custom[0]["entry"] == "/custom_components/cards/hello_card/index.js"


def test_list_card_packages_shape():
    data = list_card_packages()
    assert "bundled" in data
    assert "custom" in data
    assert isinstance(data["bundled"], list)
