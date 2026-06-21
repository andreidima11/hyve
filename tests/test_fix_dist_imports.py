"""Sanity checks for Vite dist chunk URL rewriting."""

from __future__ import annotations

from pathlib import Path


def test_app_bundle_uses_static_dist_chunk_urls():
    app_js = Path("static/dist/app.js")
    if not app_js.is_file():
        return
    text = app_js.read_text(encoding="utf-8")
    assert '"/static/dist/chunks/' in text
    assert 'return"/static/dist/"+e' in text.replace(" ", "")
    assert '"/chunks/' not in text.split("static/dist/chunks", 1)[0]
