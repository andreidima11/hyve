"""i18n and API error hygiene checks."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON_ROUTER = ROOT / "routers" / "addons.py"
ADDON_PKG = ROOT / "addons"
DIACRITICS = re.compile(r"[ăâîșțĂÂÎȘȚ]")
HTTPExc_STR = re.compile(
    r'HTTPException\s*\([^)]*detail\s*=\s*(["\'])(?:(?!\1).)+\1',
    re.DOTALL,
)


def test_frontend_i18n_keys_complete():
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_i18n_keys.py")],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_addons_router_uses_structured_api_errors():
    text = ADDON_ROUTER.read_text(encoding="utf-8")
    assert not DIACRITICS.search(text), "Romanian diacritics in routers/addons.py"
    for match in HTTPExc_STR.finditer(text):
        snippet = match.group(0)
        assert '{"key"' in snippet or "error_detail(" in snippet, snippet[:120]


def test_addons_preflight_has_no_romanian_diacritics():
    registry = (ADDON_PKG / "registry.py").read_text(encoding="utf-8")
    start = registry.find("async def preflight_check")
    end = registry.find("# ── install / uninstall", start)
    block = registry[start:end] if start >= 0 and end >= 0 else registry
    assert not DIACRITICS.search(block), "Romanian diacritics remain in preflight checks"
