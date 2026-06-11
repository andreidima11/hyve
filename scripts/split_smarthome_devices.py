#!/usr/bin/env python3
"""Split static/js/smarthome/devices.ts into state + core modules."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "static/js/smarthome/devices.ts"
if SRC.stat().st_size < 5000:
    # devices.ts is already a facade — restore from git features_smarthome
    import subprocess
    full = subprocess.check_output(
        ["git", "show", "HEAD:static/js/features_smarthome.ts"], cwd=ROOT, text=True
    )
    # Re-run parent split inline: take lines 1-1190 + modal state from smarthome script
    raise SystemExit("Run scripts/split_features_smarthome.py first to restore devices.ts")

lines = SRC.read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/smarthome"
HEADER = "".join(lines[0:30])

STATE_MAP = [
    ("_haCurrentFilter", "haCurrentFilter"),
    ("_haCurrentSource", "haCurrentSource"),
    ("_haCurrentArea", "haCurrentArea"),
    ("_integrationEntitiesCache", "integrationEntitiesCache"),
    ("_devicesVisibleEntityCache", "devicesVisibleEntityCache"),
    ("_smarthomeLoadPromise", "smarthomeLoadPromise"),
    ("_smarthomeLoadRetryTimer", "smarthomeLoadRetryTimer"),
    ("_deviceControlPending", "deviceControlPending"),
    ("_deviceOptimisticGuards", "deviceOptimisticGuards"),
    ("_devicesState", "devicesState"),
    ("_devicesShellMounted", "devicesShellMounted"),
    ("_smarthomeLiveUnsub", "liveUnsub"),
    ("_smarthomeCacheRefreshTimer", "cacheRefreshTimer"),
    ("_haBulkMode", "haBulkMode"),
    ("_smarthomeFilterPickerEventsWired", "filterPickerEventsWired"),
]


def chunk(s: int, e: int) -> str:
    return "".join(lines[s - 1 : e])


def rep(text: str) -> str:
    for old, new in STATE_MAP:
        text = re.sub(rf"(?<!let )\b{re.escape(old)}\b", f"smarthomeDeviceState.{new}", text)
    return text


STATE = """/**
 * Smart home devices — shared state.
 */
import type {
    AvailableDeviceEntry,
    DevicesState,
    SmarthomeEntity,
} from '../types/features_smarthome.js';

export const DEVICE_OPTIMISTIC_GUARD_MS = 3500;
export const DEVICES_ENTITY_CACHE_KEY = 'hyve.devices.entities.cache.v1';
export const DEVICES_ENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_PAGE_SIZE_OPTIONS: number[] = [25, 50, 100, 200];

export const smarthomeDeviceState = {
    haCurrentFilter: 'all',
    haCurrentSource: 'all',
    haCurrentArea: 'all',
    integrationEntitiesCache: [] as SmarthomeEntity[],
    devicesVisibleEntityCache: new Map<string, SmarthomeEntity>(),
    smarthomeLoadPromise: null as Promise<void> | null,
    smarthomeLoadRetryTimer: null as ReturnType<typeof setTimeout> | null,
    deviceControlPending: new Map<string, { action: string; previousState: unknown; optimisticState: unknown; startedAt: number }>(),
    deviceOptimisticGuards: new Map<string, { state: unknown; until: number }>(),
    devicesState: {
        query: '', source: 'all', area: 'all', domain: 'all',
        page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc',
    } as DevicesState,
    devicesShellMounted: false,
    liveUnsub: null as (() => void) | null,
    cacheRefreshTimer: null as ReturnType<typeof setTimeout> | null,
    haBulkMode: false,
    filterPickerEventsWired: false,
};

export const smarthomeModalState = {
    haAliasModalEntityId: null as string | null,
    haAliasModalOriginalParent: null as ParentNode | null,
    haRowActionsEntityId: null as string | null,
    haRowActionsModalOriginalParent: null as ParentNode | null,
    availableDevices: [] as AvailableDeviceEntry[],
};

"""

CORE = (
    HEADER
    + "import { smarthomeDeviceState, smarthomeModalState, DEVICE_OPTIMISTIC_GUARD_MS, DEVICES_ENTITY_CACHE_KEY, DEVICES_ENTITY_CACHE_TTL_MS, DEVICE_PAGE_SIZE_OPTIONS } from './device_state.js';\n\n"
    + rep(chunk(31, 41))
    + rep(chunk(70, 1194))
    + rep(chunk(1202, 1209))
)

FACADE = """/**
 * Smart home devices list — facade.
 */
export { ACTIVE_STATES, CONTROLLABLE } from '../entity_constants.js';
export {
    smarthomeDeviceState,
    smarthomeModalState,
    DEVICE_OPTIMISTIC_GUARD_MS,
} from './device_state.js';
export * from './device_core.js';
"""


def patch_modals() -> None:
    path = OUT / "modals.ts"
    if not path.exists() or path.stat().st_size < 2000:
        return  # already split into modal_*.ts
    text = path.read_text()
    if "device_state.js" in text:
        return
    text = text.replace(
        "import * as dev from './devices.js';",
        "import * as dev from './devices.js';\nimport { smarthomeDeviceState, smarthomeModalState } from './device_state.js';",
    )
    for old, new in [
        ("dev._integrationEntitiesCache", "smarthomeDeviceState.integrationEntitiesCache"),
        ("dev._devicesVisibleEntityCache", "smarthomeDeviceState.devicesVisibleEntityCache"),
        ("dev._deviceControlPending", "smarthomeDeviceState.deviceControlPending"),
        ("dev._deviceOptimisticGuards", "smarthomeDeviceState.deviceOptimisticGuards"),
        ("dev.smarthomeModalState", "smarthomeModalState"),
    ]:
        text = text.replace(old, new)
    path.write_text(text)


def main() -> None:
    (OUT / "device_state.ts").write_text(STATE)
    (OUT / "device_core.ts").write_text(CORE)
    (OUT / "devices.ts").write_text(FACADE)
    patch_modals()
    # Remove obsolete split files if present
    for obsolete in ("device_list.ts", "device_filters_actions.ts"):
        p = OUT / obsolete
        if p.exists():
            p.unlink()
    for name in ("device_state", "device_core", "devices"):
        print(f"{name}.ts: {len((OUT / f'{name}.ts').read_text().splitlines())} lines")


if __name__ == "__main__":
    main()
