"""Sanity checks for Vite dist chunk URL rewriting."""

from __future__ import annotations

from pathlib import Path


def test_app_bundle_uses_vite_base_with_relative_chunk_deps():
    app_js = Path("static/dist/app.js")
    if not app_js.is_file():
        return
    text = app_js.read_text(encoding="utf-8")
    compact = text.replace(" ", "")
    assert 'return"/static/dist/"+e' in compact
    assert '"/static/dist/static/dist' not in text
    assert '"chunks/' in text
    assert '"/static/dist/chunks/' not in text
