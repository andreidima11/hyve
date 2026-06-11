#!/usr/bin/env python3
"""Split static/js/features_notifications_config.ts into static/js/notifications_config/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_notifications_config.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/notifications_config"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


def replace_state_vars(text: str) -> str:
    replacements = [
        ("_notifWsStatusTimer", "notifState.wsStatusTimer"),
        ("_notifSettingsHydrating", "notifState.settingsHydrating"),
        ("_notifAutoSaveBound", "notifState.autoSaveBound"),
        ("_notifAutoSaveTimer", "notifState.autoSaveTimer"),
    ]
    for old, new in replacements:
        text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


STATE = (
    """/**
 * Notifications settings — shared types and state.
 */

export type NotifChannel = 'app' | 'whatsapp';
export type NotifTransport = 'websocket' | 'firebase' | 'off';

export const notifState = {
    wsStatusTimer: null as ReturnType<typeof setInterval> | null,
    settingsHydrating: false,
    autoSaveBound: false,
    autoSaveTimer: null as ReturnType<typeof setTimeout> | null,
};

"""
)

PAGE = (
    """/**
 * Settings → Notifications tab (FCM / WebSocket transport, channel prefs).
 */
"""
    + fix_imports(chunk(4, 7))
    + """
import type { NotifChannel, NotifTransport } from './state.js';
import { notifState } from './state.js';

"""
    + replace_state_vars(chunk(17, 364))
)

FACADE = """/**
 * Settings → Notifications tab (FCM / WebSocket transport, channel prefs).
 */
export {
    selectNotifChannel,
    selectNotifTransport,
    refreshNotifWsNativeStatus,
    testNotification,
    testWsNotification,
    testFcmNotification,
    loadNotificationPrefs,
    saveNotificationSettings,
} from './notifications_config/page.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "page.ts").write_text(PAGE)
    (ROOT / "static/js/features_notifications_config.ts").write_text(FACADE)
    print(f"state.ts: {len(STATE.splitlines())} lines")
    print(f"page.ts: {len(PAGE.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
