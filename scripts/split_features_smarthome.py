#!/usr/bin/env python3
"""Split features_smarthome.ts into smarthome/devices.ts + smarthome/modals.ts."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_smarthome.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)

MODAL_STATE_FIELDS = {
    "_haRowActionsEntityId": "haRowActionsEntityId",
    "_haAliasModalEntityId": "haAliasModalEntityId",
    "_haAliasModalOriginalParent": "haAliasModalOriginalParent",
    "_haRowActionsModalOriginalParent": "haRowActionsModalOriginalParent",
    "_availableDevices": "availableDevices",
}

DEV_NAMES = [
    "loadSmarthome",
    "renderDeviceCards",
    "_integrationEntitiesCache",
    "_devicesVisibleEntityCache",
    "_deviceControlPending",
    "_deviceOptimisticGuards",
    "DEVICE_OPTIMISTIC_GUARD_MS",
    "DOMAIN_ICONS",
    "DOMAIN_COLORS",
    "SOURCE_ICONS",
    "_entityDomain",
    "_norm",
    "_iconClass",
    "_domainLabel",
    "_optimisticStateForAction",
    "_markDeviceControlPending",
    "_errMsg",
    "_isActiveState",
]


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./(?!devices\.js)", "from '../", text)


def namespace_devices_refs(text: str) -> str:
    for name in sorted(DEV_NAMES, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", f"dev.{name}", text)
    return text


DEVICES = fix_imports(
    """/**
 * Smart home devices list: load, live updates, filters, selection.
 */
"""
    + chunk(1, 1190)
    + """
export const smarthomeModalState = {
    haAliasModalEntityId: null as string | null,
    haAliasModalOriginalParent: null as ParentNode | null,
    haRowActionsEntityId: null as string | null,
    haRowActionsModalOriginalParent: null as ParentNode | null,
    availableDevices: [] as import('../types/features_smarthome.js').AvailableDeviceEntry[],
};
"""
    + chunk(1637, 1644)
)

for old, field in MODAL_STATE_FIELDS.items():
    DEVICES = DEVICES.replace(old, f"smarthomeModalState.{field}")


def _modals_body() -> str:
    body = chunk(1195, 1634)
    for decl in [
        "let _haAliasModalEntityId: string | null = null;\n",
        "let _haAliasModalOriginalParent: ParentNode | null = null;\n",
        "let _haRowActionsEntityId: string | null = null;\n",
        "let _haRowActionsModalOriginalParent: ParentNode | null = null;\n",
        "let _availableDevices: AvailableDeviceEntry[] = [];\n",
    ]:
        body = body.replace(decl, "")
    for old, field in MODAL_STATE_FIELDS.items():
        body = re.sub(rf"\b{re.escape(old)}\b", f"dev.smarthomeModalState.{field}", body)
    return body


MODALS = (
    """/**
 * Entity detail modal, aliases, device control, legacy add-devices UI.
 */
import { apiCall } from '../api.js';
import { cameraProxyUrlSync, startCameraPreviewRefresh, stopCameraPreviewRefresh } from '../camera_auth.js';
import { cameraLoaderMarkup, bindCameraPreviewLoaders } from '../camera_loader.js';
import { t, tState } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast } from '../utils.js';
import { cameraPreferWebmPlayer } from '../camera_live.js';
import { renderEntityRegistrySection, wireEntityRegistryEditor } from '../entity_renderers.js';
import type { SmarthomeEntity } from '../types/features_smarthome.js';
import * as dev from './devices.js';

"""
    + namespace_devices_refs(_modals_body())
)

for old, new in [
    ("let _integrationEntitiesCache", "export let _integrationEntitiesCache"),
    ("let _devicesVisibleEntityCache", "export let _devicesVisibleEntityCache"),
    ("let _deviceControlPending", "export let _deviceControlPending"),
    ("let _deviceOptimisticGuards", "export let _deviceOptimisticGuards"),
    ("const DEVICE_OPTIMISTIC_GUARD_MS", "export const DEVICE_OPTIMISTIC_GUARD_MS"),
    ("const DOMAIN_ICONS", "export const DOMAIN_ICONS"),
    ("const DOMAIN_COLORS", "export const DOMAIN_COLORS"),
    ("const SOURCE_ICONS", "export const SOURCE_ICONS"),
    ("function _entityDomain", "export function _entityDomain"),
    ("function _norm", "export function _norm"),
    ("function _iconClass", "export function _iconClass"),
    ("function _domainLabel", "export function _domainLabel"),
    ("function _optimisticStateForAction", "export function _optimisticStateForAction"),
    ("function _markDeviceControlPending", "export function _markDeviceControlPending"),
    ("function _errMsg", "export function _errMsg"),
    ("function _isActiveState", "export function _isActiveState"),
    ("function renderDeviceCards()", "export function renderDeviceCards()"),
]:
    DEVICES = DEVICES.replace(old, new, 1)

FACADE = """/**
 * Smart home / devices facade.
 */
export { ACTIVE_STATES, CONTROLLABLE } from './smarthome/devices.js';

export {
    loadSmarthome,
    disconnectSmarthomeLive,
    setDevicesPage,
    setDevicesPageSize,
    sortDevicesBy,
    filterHAByDomain,
    filterHABySource,
    filterHAByArea,
    toggleSmarthomePicker,
    selectSmarthomePickerOption,
    filterDevices,
    toggleSmarthomeFilters,
    resetSmarthomeFilters,
    copyEntityIdFromRowActions,
    toggleSelection,
    toggleAllAI,
    syncHA,
    getIntegrationEntities,
} from './smarthome/devices.js';

export {
    openAliasModal,
    addAliasInput,
    closeAliasModal,
    handleHaRowClick,
    openRowActionsModal,
    controlDeviceEntity,
    openAliasModalFromDetail,
    closeEntityDetailModal,
    closeRowActionsModal,
    saveAliasesFromModal,
} from './smarthome/modals.js';
"""

out = ROOT / "static/js/smarthome"
out.mkdir(parents=True, exist_ok=True)
(out / "devices.ts").write_text(DEVICES)
(out / "modals.ts").write_text(MODALS)
(ROOT / "static/js/features_smarthome.ts").write_text(FACADE)

for stale in ("utils.ts", "state.ts", "list.ts"):
    p = out / stale
    if p.exists():
        p.unlink()

print(f"devices.ts: {len(DEVICES.splitlines())} lines")
print(f"modals.ts: {len(MODALS.splitlines())} lines")
