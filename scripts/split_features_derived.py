#!/usr/bin/env python3
"""Split static/js/features_derived.ts into static/js/derived/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_derived.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/derived"

STATE_VARS = [
    ("_builder", "builder", "BUILDER_PRESET as BuilderKind"),
    ("_view", "view", "VIEW_FORM as ViewKind"),
    ("_editingId", "editingId", "null as string | null"),
    ("_candidates", "candidates", "[] as DerivedCandidate[]"),
    ("_selectedInputs", "selectedInputs", "new Set<string>()"),
    ("_previewTimer", "previewTimer", "null as ReturnType<typeof setTimeout> | null"),
    ("_yamlTouched", "yamlTouched", "false"),
]


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


def replace_state_vars(text: str) -> str:
    for old, new, _ in STATE_VARS:
        text = re.sub(rf"\b{re.escape(old)}\b", f"derivedState.{new}", text)
    return text


STATE = fix_imports(
    """// Derived entities — shared modal state and DOM helpers.
import type { DerivedCandidate } from '../types/derived.js';

"""
    + chunk(20, 27)
    + "\n"
    + chunk(29, 35).replace("let _builder:", "export const derivedState = {\n    builder:")
    + "\n"
)

# Rebuild derivedState object properly from lines 29-35
STATE = fix_imports(
    """// Derived entities — shared modal state and DOM helpers.
import type { DerivedCandidate } from '../types/derived.js';

"""
    + chunk(20, 24)
    .replace("const BUILDER_PRESET", "export const BUILDER_PRESET")
    .replace("const BUILDER_TRANSFORM", "export const BUILDER_TRANSFORM")
    .replace("const BUILDER_EXPRESSION", "export const BUILDER_EXPRESSION")
    .replace("const VIEW_FORM", "export const VIEW_FORM")
    .replace("const VIEW_YAML", "export const VIEW_YAML")
    + chunk(26, 27).replace("type BuilderKind", "export type BuilderKind").replace(
        "type ViewKind", "export type ViewKind"
    )
    + """
export const derivedState = {
    builder: BUILDER_PRESET as BuilderKind,
    view: VIEW_FORM as ViewKind,
    editingId: null as string | null,
    candidates: [] as DerivedCandidate[],
    selectedInputs: new Set<string>(),
    previewTimer: null as ReturnType<typeof setTimeout> | null,
    yamlTouched: false,
};

"""
    + chunk(37, 51).replace("function $(", "export function $(")
    .replace("function $input", "export function $input")
    .replace("function $select", "export function $select")
    .replace("function $textarea", "export function $textarea")
)

PAGE = (
    """// Derived entities — create, edit, delete, live preview.
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm } from '../utils.js';
import { loadSmarthome } from '../features.js';
import type {
    DerivedCandidate,
    DerivedEntry,
    DerivedFormula,
    DerivedModalEl,
    DerivedPreviewResolved,
} from '../types/derived.js';
import {
    BUILDER_PRESET,
    BUILDER_TRANSFORM,
    BUILDER_EXPRESSION,
    VIEW_FORM,
    VIEW_YAML,
    derivedState,
    $,
    $input,
    $select,
    $textarea,
} from './state.js';
import type { BuilderKind, ViewKind } from './state.js';

"""
    + replace_state_vars(chunk(53, 611)).replace(
        "return switchDerivedBuilder(kind);",
        "return switchDerivedBuilder(kind as BuilderKind);",
    )
)

FACADE = """// Derived entities ("template sensors") — facade.
export {
    switchDerivedBuilder,
    switchDerivedView,
    toggleDerivedInput,
    filterDerivedCandidates,
    insertDerivedExpressionEntity,
    reloadDerivedYaml,
    runDerivedPreview,
    openDerivedModal,
    closeDerivedModal,
    saveDerived,
    deleteDerivedFromModal,
    toggleDerivedSelection,
    switchDerivedMode,
} from './derived/page.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "page.ts").write_text(PAGE)
    (ROOT / "static/js/features_derived.ts").write_text(FACADE)
    print(f"state.ts: {len(STATE.splitlines())} lines")
    print(f"page.ts: {len(PAGE.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
