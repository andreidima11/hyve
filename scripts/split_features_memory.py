#!/usr/bin/env python3
"""Split static/js/features_memory.ts into static/js/memory/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_memory.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/memory"

RENDER_NAMES = [
    "renderMemoryEventsTable",
    "updateMemLogPagination",
    "formatLearnedTime",
    "formatMemoryDate",
    "renderMemoryTable",
]


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


def replace_state_vars(text: str) -> str:
    text = text.replace("memCache = []", "memoryState.cache.length = 0")
    text = re.sub(
        r"memCache = await res\.json\(\) as MemoryFact\[\]",
        "memoryState.cache.splice(0, memoryState.cache.length, ...(await res.json() as MemoryFact[]))",
        text,
    )
    replacements = [
        ("MEM_LOG_PAGE_SIZE", "MEM_LOG_PAGE_SIZE"),
        ("MEM_PER_PAGE", "MEM_PER_PAGE"),
        ("_extractionExamples", "memoryState.extractionExamples"),
        ("memLogOffset", "memoryState.logOffset"),
        ("memLogTotal", "memoryState.logTotal"),
        ("memPage", "memoryState.page"),
        ("memCache", "memoryState.cache"),
        ("_memLogTypeDropdownBound", "memoryUiState.memLogTypeDropdownBound"),
    ]
    for old, new in replacements:
        if old.startswith("_") or old.startswith("mem"):
            text = re.sub(rf"\b{re.escape(old)}\b", new, text)
    return text


def rename_render_fns(text: str) -> str:
    for name in RENDER_NAMES:
        text = text.replace(f"export function {name}", f"function {name}")
        text = text.replace(f"function {name}", f"export function {name}", 1)
    return text


def namespace_render_refs(text: str) -> str:
    for name in sorted(RENDER_NAMES, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", f"render.{name}", text)
    # restore private originals that were renamed in source
    text = text.replace("render.renderMemoryEventsTable", "render.renderMemoryEventsTable")
    return text


STATE = fix_imports(
    """/**
 * Memory UI — shared state and constants.
 */
import type { MemoryExtractionExample, MemoryFact } from '../types/memory.js';

export const MEM_LOG_PAGE_SIZE = 12;
export const MEM_PER_PAGE = 12;

export const memoryState = {
    cache: [] as MemoryFact[],
    page: 1,
    logOffset: 0,
    logTotal: 0,
    extractionExamples: [] as MemoryExtractionExample[],
};

export const memoryUiState = {
    memLogTypeDropdownBound: false,
};

"""
)

RENDER = rename_render_fns(
    replace_state_vars(
        """/**
 * Memory UI — table render helpers.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
import type { MemoryLogEvent } from '../types/memory.js';
import { MEM_LOG_PAGE_SIZE, MEM_PER_PAGE, memoryState } from './state.js';

"""
        + chunk(48, 82).replace("function renderMemoryEventsTable", "function renderMemoryEventsTable")
        + chunk(275, 300)
        + chunk(304, 343)
    )
)

PAGE = (
    """/**
 * Memory UI — load, log, extraction examples, bulk actions.
 */
"""
    + fix_imports(chunk(1, 3))
    + """
import type {
    MemoryConsolidationResult,
    MemoryEventsResponse,
    MemoryExtractionExample,
    MemoryFact,
    MemoryLogEvent,
} from '../types/memory.js';
import { MEM_LOG_PAGE_SIZE, MEM_PER_PAGE, memoryState, memoryUiState } from './state.js';
import * as render from './render.js';

"""
    + namespace_render_refs(
        replace_state_vars(
            chunk(19, 47)
            + chunk(84, 132)
            + chunk(134, 193)
            + chunk(195, 202)
            + chunk(204, 224)
            + chunk(226, 252)
            + chunk(254, 273)
            + chunk(345, 377)
        )
    )
    + "\nexport { renderMemoryTable } from './render.js';\n"
)

FACADE = """/**
 * Memory UI facade.
 */
export { memoryState } from './memory/state.js';

export {
    loadMemory,
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
    renderMemoryTable,
    toggleAllMem,
    updateMemBulkCount,
    deleteMemBulk,
    changeMemPage,
    filterMemory,
    updateMemory,
} from './memory/page.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "render.ts").write_text(RENDER)
    (OUT / "page.ts").write_text(PAGE)
    (ROOT / "static/js/features_memory.ts").write_text(FACADE)
    print(f"state.ts: {len(STATE.splitlines())} lines")
    print(f"render.ts: {len(RENDER.splitlines())} lines")
    print(f"page.ts: {len(PAGE.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
