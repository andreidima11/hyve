#!/usr/bin/env python3
"""Split static/js/apps/page.ts into state, core, logs, lifecycle, and poll modules."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = ROOT / "static/js/apps/page.ts"
if src.stat().st_size < 5000:
    raise SystemExit("Run scripts/split_features_apps.py first to restore page.ts")
lines = src.read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/apps"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def rep_state(text: str) -> str:
    mapping = {
        "_currentLogSlug": "appsState.currentLogSlug",
        "_pollTimer": "appsState.pollTimer",
        "_openSlug": "appsState.openSlug",
        "_addonUiSlug": "appsState.addonUiSlug",
        "_addonsCache": "appsState.addonsCache",
    }
    for old, new in mapping.items():
        text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


STATE = """/**
 * Apps page — shared mutable state.
 */
import type { AddonCatalogEntry } from '../types/features_apps.js';

export const appsState = {
    currentLogSlug: null as string | null,
    pollTimer: null as ReturnType<typeof setInterval> | null,
    openSlug: null as string | null,
    addonUiSlug: null as string | null,
    addonsCache: [] as AddonCatalogEntry[],
};

"""

POLL = (
    chunk(4, 7)
    + """
import type { AddonProcessStatus, AddonProcessStatusMap } from '../types/features_apps.js';
import { appsState } from './state.js';
import * as render from './render.js';

"""
    + rep_state(chunk(116, 147))
    .replace("async function _refreshDetailStatus", "export async function refreshDetailStatus", 1)
    .replace("function _updateDetailUI", "function updateDetailUI", 1)
    .replace("_updateDetailUI(", "updateDetailUI(")
    + rep_state(chunk(611, 647))
    .replace("function _startPoll", "export function startPoll", 1)
    .replace("function _stopPoll", "export function stopPoll", 1)
    .replace("_stopPoll()", "stopPoll()")
    .replace("await _refreshDetailStatus", "await refreshDetailStatus")
)

LOGS = (
    chunk(4, 7)
    + "import { appsState } from './state.js';\n"
    + "import * as render from './render.js';\n\n"
    + rep_state(chunk(149, 188))
)

CORE = (
    """/**
 * Apps page — list, detail, actions.
 */
"""
    + chunk(4, 7)
    + chunk(9, 17)
    + """
import { appsState } from './state.js';
import * as render from './render.js';
import { startPoll, stopPoll, refreshDetailStatus } from './poll.js';

"""
    + rep_state(chunk(27, 114)).replace("_startPoll()", "startPoll()").replace("_stopPoll()", "stopPoll()").replace(
        "_refreshDetailStatus", "refreshDetailStatus"
    )
)

LIFECYCLE = (
    chunk(4, 17)
    + """
import { appsState } from './state.js';
import * as render from './render.js';
import { startPoll, stopPoll, refreshDetailStatus } from './poll.js';
import { openAppDetail, loadApps } from './core.js';

"""
    + rep_state(chunk(191, 607))
    .replace("_startPoll()", "startPoll()")
    .replace("_stopPoll()", "stopPoll()")
    .replace("_refreshDetailStatus", "refreshDetailStatus")
)

PAGE = """/**
 * Apps page facade.
 */
export { loadApps, openAppDetail, closeAppDetail, appAction } from './core.js';
export { openAppLogModal, closeAppLogModal, refreshAppLogs } from './logs.js';
export {
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
} from './lifecycle.js';
"""


def main() -> None:
    for name, content in [
        ("state", STATE),
        ("poll", POLL),
        ("logs", LOGS),
        ("core", CORE),
        ("lifecycle", LIFECYCLE),
        ("page", PAGE),
    ]:
        (OUT / f"{name}.ts").write_text(content)
        print(f"{name}.ts: {len(content.splitlines())} lines")


if __name__ == "__main__":
    main()
