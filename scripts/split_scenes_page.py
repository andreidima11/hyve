#!/usr/bin/env python3
"""Split static/js/scenes/page.ts into list and editor modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = ROOT / "static/js/scenes/page.ts"
if src.stat().st_size < 3000:
    raise SystemExit("Run scripts/split_features_scenes.py first to restore page.ts")
lines = src.read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/scenes"
HEADER = "".join(lines[0:16])


def chunk(s: int, e: int) -> str:
    return "".join(lines[s - 1 : e])


LIST = (
    HEADER
    + "import { ensureEntityCatalog } from './editor.js';\n\n"
    + (chunk(31, 67) + chunk(226, 270)).replace("_ensureEntityCatalog", "ensureEntityCatalog")
)

_editor_body = (
    chunk(17, 30)
    .replace("async function _ensureEntityCatalog", "export async function ensureEntityCatalog", 1)
    + chunk(69, 225)
    + chunk(272, 322)
).replace("_ensureEntityCatalog", "ensureEntityCatalog")

EDITOR = (
    HEADER
    + "import { loadScenes, deleteScene } from './list.js';\n\n"
    + _editor_body
)

PAGE = """/**
 * Scenes UI facade.
 */
export { loadScenes, openScenesPage, closeScenesPage, activateScene, deleteScene } from './list.js';
export {
    openSceneEditor,
    closeSceneEditor,
    addSceneEntry,
    removeSceneEntry,
    saveScene,
    deleteSceneFromEditor,
    openSceneEntityPicker,
    closeSceneEntityPicker,
    filterSceneEntityPicker,
    pickSceneEntity,
} from './editor.js';
"""


def main() -> None:
    (OUT / "list.ts").write_text(LIST)
    (OUT / "editor.ts").write_text(EDITOR)
    (OUT / "page.ts").write_text(PAGE)
    for name in ("list", "editor", "page"):
        print(f"{name}.ts: {len((OUT / f'{name}.ts').read_text().splitlines())} lines")


if __name__ == "__main__":
    main()
