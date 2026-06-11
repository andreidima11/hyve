#!/usr/bin/env python3
"""Split static/js/features_apps.ts into static/js/apps/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_apps.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)

RENDER_NAMES = [
    "_errMsg",
    "_renderDetail",
    "_renderSummaryCard",
    "_statusBadge",
    "_uptime",
    "_updateIndicator",
    "_addonStatusBadge",
    "_buildAddonWebUrl",
    "_canUseIngressWebUi",
    "_formatAddonVersion",
]


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./(?!render\.js)", "from '../", text)


def namespace_render_refs(text: str) -> str:
    for name in sorted(RENDER_NAMES, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", f"render.{name}", text)
    return text


RENDER = fix_imports(
    """/**
 * Apps page: HTML render helpers for addon cards and detail view.
 */
"""
    + chunk(4, 17)
    + chunk(19, 33)
    + chunk(42, 402)
)

for name in RENDER_NAMES:
    if name == "_errMsg":
        RENDER = RENDER.replace(f"function {name}", f"export function {name}", 1)
    else:
        RENDER = RENDER.replace(f"function {name}", f"export function {name}", 1)

PAGE = (
    """/**
 * Apps page: load, lifecycle, logs, config, Web UI.
 */
"""
    + fix_imports(chunk(4, 17))
    + "import * as render from './render.js';\n\n"
    + chunk(36, 40)
    + namespace_render_refs(
        chunk(406, 1028).replace("import('./api.js')", "import('../api.js')")
    )
)

FACADE = """/**
 * Apps page facade (addon process management + lifecycle).
 */
export {
    loadApps,
    openAppDetail,
    closeAppDetail,
    appAction,
    openAppLogModal,
    closeAppLogModal,
    refreshAppLogs,
    runPreflight,
    installApp,
    closeInstallLogModal,
    goToAddonUpdates,
    uninstallApp,
    toggleApp,
    toggleAddonWatchdog,
    detectAddonSerialPorts,
    saveAddonConfig,
    testAddonHealth,
    closeAddonWebUI,
    openAddonWebUI,
} from './apps/page.js';
"""

out = ROOT / "static/js/apps"
out.mkdir(parents=True, exist_ok=True)
(out / "render.ts").write_text(RENDER)
(out / "page.ts").write_text(PAGE)
(ROOT / "static/js/features_apps.ts").write_text(FACADE)

print(f"render.ts: {len(RENDER.splitlines())} lines")
print(f"page.ts: {len(PAGE.splitlines())} lines")
print(f"facade: {len(FACADE.splitlines())} lines")
