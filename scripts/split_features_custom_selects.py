#!/usr/bin/env python3
"""Split static/js/features_custom_selects.ts into static/js/custom_selects/ modules."""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_custom_selects.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/custom_selects"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


TYPES = chunk(6, 17).replace("interface ", "export interface ")

GENERIC = (
    """/**
 * Custom dropdown — rebuild, portal menu, document bindings.
 */
import { escapeHtml } from '../utils.js';
import type { GenericCustomSelectElement, PortaledSelectMenu } from './types.js';
import { selectUiState } from './state.js';

"""
    + chunk(19, 27)
    + chunk(29, 50)
    .replace("function _rebuildGenericSelect", "export function rebuildGenericSelect", 1)
    .replace("_rebuildGenericSelect", "rebuildGenericSelect")
    + chunk(52, 112).replace("_rebuildGenericSelect", "rebuildGenericSelect")
    + chunk(114, 114).replace("let _genericSelectBound = false;", "")
    + chunk(116, 168).replace("_genericSelectBound", "selectUiState.genericSelectBound")
)

STATE = """/**
 * Custom select UI — module-load flags.
 */
export const selectUiState = {
    genericSelectBound: false,
    nativeSelectAutoUpgrade: false,
    genericSelectSeq: 0,
};

"""

UPGRADE = (
    """/**
 * Native <select> auto-upgrade to custom dropdown.
 */
import type { GenericCustomSelectElement, UpgradableNativeSelect } from './types.js';
import { rebuildGenericSelect } from './generic.js';
import { selectUiState } from './state.js';

"""
    + chunk(171, 178)
    + chunk(179, 207).replace("_genericSelectSeq", "selectUiState.genericSelectSeq").replace(
        "_rebuildGenericSelect", "rebuildGenericSelect"
    )
    + chunk(209, 209).replace("let _nativeSelectAutoUpgrade = false;", "")
    + chunk(211, 247).replace("_nativeSelectAutoUpgrade", "selectUiState.nativeSelectAutoUpgrade").replace(
        "_rebuildGenericSelect", "rebuildGenericSelect"
    )
)

FACADE = """/**
 * Generic custom dropdown + native <select> auto-upgrade (settings UI).
 */
export { initGenericCustomSelects } from './custom_selects/generic.js';
export { upgradeNativeSelect, upgradeNativeSelects } from './custom_selects/upgrade.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "types.ts").write_text(TYPES)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "generic.ts").write_text(GENERIC)
    (OUT / "upgrade.ts").write_text(UPGRADE)
    (ROOT / "static/js/features_custom_selects.ts").write_text(FACADE)
    for name in ("types", "state", "generic", "upgrade"):
        p = OUT / f"{name}.ts"
        print(f"{name}.ts: {len(p.read_text().splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
