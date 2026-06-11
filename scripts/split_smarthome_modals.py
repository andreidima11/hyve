#!/usr/bin/env python3
"""Split static/js/smarthome/modals.ts into alias, detail, and add-devices modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static/js/smarthome"
src = OUT / "modals.ts"
if src.stat().st_size < 2000:
    raise SystemExit("Run split_features_smarthome.py + split_smarthome_devices.py first")

lines = src.read_text().splitlines(keepends=True)
HEADER = "".join(lines[0:13])


def chunk(s: int, e: int) -> str:
    return "".join(lines[s - 1 : e])


ALIAS = (
    """/**
 * Smart home — entity alias modal.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import * as dev from './devices.js';
import { smarthomeDeviceState, smarthomeModalState } from './device_state.js';

"""
    + chunk(15, 73)
    + chunk(355, 373)
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
    + chunk(76, 331)
    + chunk(333, 353)
)

ADD_DEVICES = (
    """/**
 * Smart home — legacy add-devices picker modal.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr } from '../utils.js';
import * as dev from './devices.js';
import { smarthomeModalState } from './device_state.js';

"""
    + chunk(377, 451)
)

FACADE = """/**
 * Smart home modals — facade.
 */
export {
    openAliasModal,
    addAliasInput,
    closeAliasModal,
    saveAliasesFromModal,
    saveAliases,
} from './modal_alias.js';

export {
    handleHaRowClick,
    openRowActionsModal,
    controlDeviceEntity,
    openAliasModalFromDetail,
    closeEntityDetailModal,
    closeRowActionsModal,
} from './modal_detail.js';

export {
    openAddDevicesModal,
    closeAddDevicesModal,
    toggleAvailableDevice,
    toggleAllAvailableDevices,
    filterAvailableDevices,
    confirmAddDevices,
} from './modal_add_devices.js';
"""


def main() -> None:
    (OUT / "modal_alias.ts").write_text(ALIAS)
    (OUT / "modal_detail.ts").write_text(DETAIL)
    (OUT / "modal_add_devices.ts").write_text(ADD_DEVICES)
    (OUT / "modals.ts").write_text(FACADE)
    for name in ("modal_alias", "modal_detail", "modal_add_devices", "modals"):
        print(f"{name}.ts: {len((OUT / f'{name}.ts').read_text().splitlines())} lines")


if __name__ == "__main__":
    main()
