#!/usr/bin/env python3
"""Split static/js/features_addons_settings.ts into static/js/addons_settings/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_addons_settings.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)

OUT = ROOT / "static/js/addons_settings"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


RENDER_NAMES = ["_renderAddonCard"]


def namespace_render_refs(text: str) -> str:
    for name in sorted(RENDER_NAMES, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", f"render.{name}", text)
    return text


TYPES = chunk(10, 62).replace("interface ", "export interface ")

RENDER = (
    """/**
 * Add-ons settings: list card HTML render helpers.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
import type { AddonRecord, AddonColorScheme } from './types.js';

"""
    + chunk(70, 79)
    + chunk(102, 158).replace("function _renderAddonCard", "export function _renderAddonCard", 1)
)

LIST = (
    """/**
 * Add-ons settings: catalog list, install/enable, config modal.
 */
"""
    + fix_imports(chunk(4, 6))
    + fix_imports("import { loadIntegrationEntities } from './features_integrations_settings.js';\n")
    + """import type { AddonRecord } from './types.js';
import * as render from './render.js';

"""
    + chunk(68, 68)
    + namespace_render_refs(chunk(81, 100) + chunk(160, 364))
)

UPDATES = (
    """/**
 * Add-ons settings: Updates hub + check interval dropdown.
 */
"""
    + fix_imports(chunk(4, 6))
    + fix_imports("import { isExplicitNonAdmin } from './user_context.js';\n")
    + "import type { AddonUpdateRow } from './types.js';\n\n"
    + chunk(370, 633)
)

FACADE = """/**
 * Settings → Add-ons list + Updates hub (install/enable/update add-ons).
 */
export {
    loadAddons,
    installAddon,
    uninstallAddon,
    toggleAddon,
    openAddonConfigModal,
    closeAddonConfigModal,
    saveAddonConfig,
    checkAddonHealth,
} from './addons_settings/list.js';

export {
    updateHeaderUpdatesBadge,
    refreshUpdatesHeaderBadge,
    loadUpdatesAddons,
    checkAddonUpdates,
    updateAllAddons,
    updateSingleAddon,
    toggleUpdatesIntervalDropdown,
    setUpdatesInterval,
    syncUpdatesIntervalDropdown,
} from './addons_settings/updates.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "types.ts").write_text(TYPES)
    (OUT / "render.ts").write_text(RENDER)
    (OUT / "list.ts").write_text(LIST)
    (OUT / "updates.ts").write_text(UPDATES)
    (ROOT / "static/js/features_addons_settings.ts").write_text(FACADE)
    print(f"types.ts: {len(TYPES.splitlines())} lines")
    print(f"render.ts: {len(RENDER.splitlines())} lines")
    print(f"list.ts: {len(LIST.splitlines())} lines")
    print(f"updates.ts: {len(UPDATES.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
