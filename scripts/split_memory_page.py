#!/usr/bin/env python3
"""Split static/js/memory/page.ts into facts and log modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = ROOT / "static/js/memory/page.ts"
if src.stat().st_size < 2000:
    raise SystemExit("Run scripts/split_features_memory.py first to restore page.ts")
lines = src.read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/memory"
HEADER = "".join(lines[0:16])


def chunk(s: int, e: int) -> str:
    return "".join(lines[s - 1 : e])


LOG = HEADER + chunk(26, 231)

FACTS = (
    HEADER
    + "import { loadMemoryEvents } from './log.js';\n\n"
    + chunk(18, 25)
    + chunk(232, 265)
    + "\nexport { renderMemoryTable } from './render.js';\n"
)

PAGE = """/**
 * Memory UI facade.
 */
export {
    loadMemoryEvents,
    memLogPrevPage,
    memLogNextPage,
    toggleMemLogDetails,
    clearMemoryLog,
    runConsolidationNow,
    getExtractionExamples,
    renderExtractionExamples,
    addExtractionExample,
    removeExtractionExample,
    loadReminders,
    deleteReminder,
    openMementoEdit,
    closeMementoEdit,
    saveMementoEdit,
    updateMementoBulkCount,
    toggleAllMemento,
    deleteMementoBulk,
    toggleMemLogTypeDropdown,
    setMemLogType,
    switchMemorySubtab,
} from './log.js';

export {
    loadMemory,
    renderMemoryTable,
    toggleAllMem,
    updateMemBulkCount,
    deleteMemBulk,
    changeMemPage,
    filterMemory,
    updateMemory,
} from './facts.js';
"""


def main() -> None:
    (OUT / "log.ts").write_text(LOG)
    (OUT / "facts.ts").write_text(FACTS)
    (OUT / "page.ts").write_text(PAGE)
    for name in ("log", "facts", "page"):
        print(f"{name}.ts: {len((OUT / f'{name}.ts').read_text().splitlines())} lines")


if __name__ == "__main__":
    main()
