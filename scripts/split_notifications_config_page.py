#!/usr/bin/env python3
"""Split notifications_config/page.ts into ui (channel+transport) and persist modules."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
lines = (ROOT / "static/js/notifications_config/page.ts").read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/notifications_config"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def rep_notif_state(text: str) -> str:
    for old, new in [
        ("_notifWsStatusTimer", "notifState.wsStatusTimer"),
        ("_notifSettingsHydrating", "notifState.settingsHydrating"),
        ("_notifAutoSaveBound", "notifState.autoSaveBound"),
        ("_notifAutoSaveTimer", "notifState.autoSaveTimer"),
    ]:
        text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


UI = (
    """/**
 * Notifications settings — channel, transport, WS status, test sends.
 */
"""
    + chunk(4, 7)
    + """
import type { NotifChannel, NotifTransport } from './state.js';
import { notifState } from './state.js';

"""
    + rep_notif_state(
        chunk(12, 262).replace(
            "function _bindNotificationSettingsAutoSave",
            "export function bindNotificationSettingsAutoSave",
            1,
        )
    )
)

PERSIST = (
    """/**
 * Notifications settings — load/save prefs.
 */
"""
    + chunk(4, 7)
    + """
import type { NotifChannel, NotifTransport } from './state.js';
import { notifState } from './state.js';
import { selectNotifChannel, selectNotifTransport } from './ui.js';

"""
    + rep_notif_state(chunk(265, 359))
    .replace("_bindNotificationSettingsAutoSave()", "bindNotificationSettingsAutoSave()")
)

UI = rep_notif_state(UI)  # already done in chunk

PAGE = """/**
 * Notifications settings facade.
 */
export {
    selectNotifChannel,
    selectNotifTransport,
    refreshNotifWsNativeStatus,
    testNotification,
    testWsNotification,
    testFcmNotification,
} from './ui.js';

export { loadNotificationPrefs, saveNotificationSettings } from './persist.js';
"""


def main() -> None:
    for name, content in [("ui", UI), ("persist", PERSIST), ("page", PAGE)]:
        (OUT / f"{name}.ts").write_text(content)
        print(f"{name}.ts: {len(content.splitlines())} lines")


if __name__ == "__main__":
    main()
