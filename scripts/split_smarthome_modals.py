#!/usr/bin/env python3
"""Split smarthome modals into alias + detail modules (from git features_smarthome source)."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static/js/smarthome"
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_smarthome.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)


def chunk(s: int, e: int) -> str:
    return "".join(lines[s - 1 : e])


def rep(text: str) -> str:
    for old, new in [
        ("_integrationEntitiesCache", "smarthomeDeviceState.integrationEntitiesCache"),
        ("_devicesVisibleEntityCache", "smarthomeDeviceState.devicesVisibleEntityCache"),
        ("_deviceControlPending", "smarthomeDeviceState.deviceControlPending"),
        ("_deviceOptimisticGuards", "smarthomeDeviceState.deviceOptimisticGuards"),
        ("_haAliasModalEntityId", "smarthomeModalState.haAliasModalEntityId"),
        ("_haAliasModalOriginalParent", "smarthomeModalState.haAliasModalOriginalParent"),
        ("_haRowActionsEntityId", "smarthomeModalState.haRowActionsEntityId"),
    ]:
        text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    for name in sorted(
        [
            "loadSmarthome", "renderDeviceCards", "DEVICE_OPTIMISTIC_GUARD_MS",
            "DOMAIN_ICONS", "DOMAIN_COLORS", "SOURCE_ICONS", "_entityDomain", "_norm",
            "_iconClass", "_domainLabel", "_optimisticStateForAction", "_markDeviceControlPending",
            "_errMsg", "_isActiveState",
        ],
        key=len,
        reverse=True,
    ):
        text = re.sub(rf"\b{re.escape(name)}\b", f"dev.{name}", text)
    return text


ALIAS = (
    """/**
 * Smart home — entity alias modal.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import * as dev from './devices.js';
import { smarthomeDeviceState, smarthomeModalState } from './device_state.js';

"""
    + rep(chunk(1195, 1267))
    + rep(chunk(1555, 1566))
)

DETAIL = (
    """/**
 * Smart home — entity detail modal (row actions, camera preview, device control).
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
import { smarthomeDeviceState, smarthomeModalState } from './device_state.js';
import { openAliasModal, closeAliasModal } from './modal_alias.js';

"""
    + rep(chunk(1276, 1531))
    + rep(chunk(1533, 1553))
)

FACADE = """/**
 * Smart home modals — facade.
 */
export {
    openAliasModal,
    addAliasInput,
    closeAliasModal,
    saveAliasesFromModal,
} from './modal_alias.js';

export {
    handleHaRowClick,
    openRowActionsModal,
    controlDeviceEntity,
    openAliasModalFromDetail,
    closeEntityDetailModal,
    closeRowActionsModal,
} from './modal_detail.js';
"""


def main() -> None:
    (OUT / "modal_alias.ts").write_text(ALIAS)
    (OUT / "modal_detail.ts").write_text(DETAIL)
    (OUT / "modals.ts").write_text(FACADE)
    for stale in ("modal_add_devices.ts", "modal_add_devices.js"):
        p = OUT / stale
        if p.exists():
            p.unlink()
    for name in ("modal_alias", "modal_detail", "modals"):
        print(f"{name}.ts: {len((OUT / f'{name}.ts').read_text().splitlines())} lines")


if __name__ == "__main__":
    main()
