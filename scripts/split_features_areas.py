#!/usr/bin/env python3
"""Split static/js/features_areas.ts into static/js/areas/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_areas.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/areas"

STATE_REPLACEMENTS = [
    ("_entitiesCacheTime", "areaState.entitiesCacheTime"),
    ("_allEntitiesCache", "areaState.allEntitiesCache"),
    ("_areasCache", "areaState.areasCache"),
    ("_pickerFilter", "areaState.pickerFilter"),
    ("_pickerSelected", "areaState.pickerSelected"),
    ("_editorState", "areaState.editorState"),
]


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


def replace_state_vars(text: str) -> str:
    for old, new in STATE_REPLACEMENTS:
        text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


RENDER_NAMES = [
    "_esc",
    "_iconClass",
    "_renderAreas",
    "_entityLookup",
    "_renderEditorEntities",
    "_renderPickerList",
]


def namespace_render_refs(text: str) -> str:
    for name in sorted(RENDER_NAMES, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", f"render.{name}", text)
    return text


def export_functions(text: str, names: list[str]) -> str:
    for name in names:
        text = text.replace(f"function {name}", f"export function {name}", 1)
    return text


STATE = (
    """/**
 * Areas UI — shared types and state.
 */
import type { HyveEntity } from '../types/entity.js';

"""
    + chunk(12, 27).replace("interface HyveArea", "export interface HyveArea").replace(
        "interface AreaEditorState", "export interface AreaEditorState"
    )
    + chunk(29, 32).replace("type AreaEntityRef", "export type AreaEntityRef")
    + """
export const areaState = {
    areasCache: [] as HyveArea[],
    allEntitiesCache: [] as AreaEntityRef[],
    entitiesCacheTime: 0,
    editorState: {
        mode: 'create' as 'create' | 'edit',
        areaId: null as string | null,
        synced: false,
        entities: [] as string[],
    },
    pickerSelected: new Set<string>(),
    pickerFilter: '',
};

"""
)

RENDER = export_functions(
    replace_state_vars(
        """/**
 * Areas UI — HTML render helpers.
 */
import { t } from '../lang/index.js';
import { areaState } from './state.js';

"""
        + chunk(41, 54)
        + chunk(56, 100)
        + chunk(310, 312)
        + chunk(314, 334)
        + chunk(378, 414)
    ),
    RENDER_NAMES,
)

PAGE = (
    """/**
 * Areas (rooms/zones/floors) UI.
 */
"""
    + fix_imports(chunk(7, 10))
    + """import type { AreaEntityRef, HyveArea } from './state.js';
import { areaState } from './state.js';
import * as render from './render.js';

"""
    + namespace_render_refs(replace_state_vars(chunk(102, 141)))
    + namespace_render_refs(replace_state_vars(chunk(143, 196)))
    + namespace_render_refs(replace_state_vars(chunk(198, 297)))
    + replace_state_vars(chunk(299, 308))
    + namespace_render_refs(replace_state_vars(chunk(336, 376) + chunk(416, 427)))
)

FACADE = """/**
 * Areas (rooms/zones/floors) UI.
 */
export {
    loadAreas,
    syncAreasFromHA,
    closeAreaEditor,
    openCreateAreaModal,
    editArea,
    saveAreaFromEditor,
    deleteArea,
    deleteAreaFromEditor,
    removeAreaEditorEntity,
    openAreaEntityPicker,
    closeAreaEntityPicker,
    filterAreaEntityPicker,
    toggleAreaPickerEntity,
    confirmAreaEntityPicker,
} from './areas/page.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "render.ts").write_text(RENDER)
    (OUT / "page.ts").write_text(PAGE)
    (ROOT / "static/js/features_areas.ts").write_text(FACADE)
    print(f"state.ts: {len(STATE.splitlines())} lines")
    print(f"render.ts: {len(RENDER.splitlines())} lines")
    print(f"page.ts: {len(PAGE.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
