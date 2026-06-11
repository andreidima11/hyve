#!/usr/bin/env python3
"""Split static/js/areas/page.ts into list and editor modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = ROOT / "static/js/areas/page.ts"
if src.stat().st_size < 2000:
    raise SystemExit("Run scripts/split_features_areas.py first to restore page.ts")
lines = src.read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/areas"
HEADER = "".join(lines[0:11])


def chunk(s: int, e: int) -> str:
    return "".join(lines[s - 1 : e])


LIST = HEADER + chunk(12, 51)

EDITOR = (
    HEADER
    + "import { loadAreas } from './list.js';\n\n"
    + chunk(52, 268)
)

PAGE = """/**
 * Areas UI facade.
 */
export { loadAreas, syncAreasFromHA } from './list.js';
export {
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
