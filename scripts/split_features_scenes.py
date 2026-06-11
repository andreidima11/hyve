#!/usr/bin/env python3
"""Split static/js/features_scenes.ts into static/js/scenes/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_scenes.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/scenes"

STATE_REPLACEMENTS = [
    ("_scenesCache", "sceneState.scenesCache"),
    ("_entityCatalogLoaded", "sceneState.entityCatalogLoaded"),
    ("_entityCatalog", "sceneState.entityCatalog"),
    ("_editorState", "sceneState.editorState"),
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
    "_escapeHtml",
    "_iconClass",
    "_entityDomain",
    "_serviceSelectHtml",
    "_entryRowHtml",
    "_renderEditorEntries",
    "_readEditorEntriesFromDOM",
    "_renderScenesList",
    "_renderEntityPickerList",
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
 * Scenes UI — shared state and constants.
 */
import type {
    SceneEntityCatalogItem,
    SceneEntry,
    SceneService,
    SceneSummary,
} from '../types/scenes.js';

"""
    + chunk(18, 19).replace("const _MAX_ENTRIES", "export const _MAX_ENTRIES").replace(
        "const _SERVICE_VALUES", "export const _SERVICE_VALUES"
    )
    + chunk(21, 26).replace("interface SceneEditorState", "export interface SceneEditorState")
    + """
export const sceneState = {
    scenesCache: [] as SceneSummary[],
    entityCatalog: [] as SceneEntityCatalogItem[],
    entityCatalogLoaded: false,
    editorState: {
        mode: 'create' as 'create' | 'edit',
        sceneId: null as string | null,
        entries: [] as SceneEntry[],
        entityPickerTargetIdx: -1,
    },
};

"""
)

RENDER = export_functions(
    replace_state_vars(
        """/**
 * Scenes UI — HTML render helpers.
 */
import { t } from '../lang/index.js';
import type { SceneEntry, SceneSummary, SceneService } from '../types/scenes.js';
import { _SERVICE_VALUES, sceneState } from './state.js';

"""
        + chunk(38, 56)
        + chunk(73, 150)
        + chunk(152, 202)
        + chunk(473, 504)
    ),
    RENDER_NAMES,
)

PAGE = (
    """/**
 * Scenes UI — list, editor, activation.
 */
"""
    + fix_imports(chunk(7, 16))
    + """import { _MAX_ENTRIES, sceneState } from './state.js';
import * as render from './render.js';

"""
    + replace_state_vars(chunk(58, 71))
    + namespace_render_refs(replace_state_vars(chunk(204, 472) + chunk(506, 527)))
)

FACADE = """/**
 * Scenes UI — list, editor, activation.
 */
export {
    loadScenes,
    openScenesPage,
    closeScenesPage,
    openSceneEditor,
    closeSceneEditor,
    addSceneEntry,
    removeSceneEntry,
    saveScene,
    deleteSceneFromEditor,
    deleteScene,
    activateScene,
    openSceneEntityPicker,
    closeSceneEntityPicker,
    filterSceneEntityPicker,
    pickSceneEntity,
} from './scenes/page.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "render.ts").write_text(RENDER)
    (OUT / "page.ts").write_text(PAGE)
    (ROOT / "static/js/features_scenes.ts").write_text(FACADE)
    print(f"state.ts: {len(STATE.splitlines())} lines")
    print(f"render.ts: {len(RENDER.splitlines())} lines")
    print(f"page.ts: {len(PAGE.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
