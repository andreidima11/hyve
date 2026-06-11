#!/usr/bin/env python3
"""Split static/js/derived/page.ts into form+preview and modal modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = ROOT / "static/js/derived/page.ts"
if src.stat().st_size < 3000:
    raise SystemExit("Run scripts/split_features_derived.py first to restore page.ts")
lines = src.read_text().splitlines(keepends=True)
OUT = ROOT / "static/js/derived"

RENAMES = [
    ("_setBuilderUi", "setBuilderUi"),
    ("_setViewUi", "setViewUi"),
    ("_renderCandidates", "renderCandidates"),
    ("_buildFormulaPayload", "buildFormulaPayload"),
    ("_resetForm", "resetForm"),
    ("_populateForm", "populateForm"),
    ("_schedulePreview", "schedulePreview"),
    ("_syncYamlIfUntouched", "syncYamlIfUntouched"),
    ("_updateYamlSyncBadge", "updateYamlSyncBadge"),
    ("_loadCandidates", "loadCandidates"),
    ("_renderYamlFromForm", "renderYamlFromForm"),
    ("_updateInputsCount", "updateInputsCount"),
    ("_buildEntryPayload", "buildEntryPayload"),
    ("_resolveFormulaForPreview", "resolveFormulaForPreview"),
    ("_setPreviewInputs", "setPreviewInputs"),
]

EXPORT_FNS = [
    "setBuilderUi", "setViewUi", "renderCandidates", "buildFormulaPayload",
    "resetForm", "populateForm", "schedulePreview", "loadCandidates",
    "syncYamlIfUntouched", "updateYamlSyncBadge", "renderYamlFromForm",
]


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def apply_renames(text: str) -> str:
    for old, new in RENAMES:
        text = text.replace(old, new)
    return text


def export_fns(text: str) -> str:
    import re

    for name in EXPORT_FNS:
        if re.search(rf"\bexport\s+(async\s+)?function\s+{re.escape(name)}\b", text):
            continue
        if f"async function {name}" in text:
            text = text.replace(f"async function {name}", f"export async function {name}", 1)
        else:
            text = text.replace(f"function {name}", f"export function {name}", 1)
    return text


FORM_PREVIEW = export_fns(apply_renames(chunk(1, 361)))

MODAL = (
    """// Derived entities — open, save, delete.
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showToast, showConfirm } from '../utils.js';
import { loadSmarthome } from '../features.js';
import type { DerivedEntry, DerivedModalEl } from '../types/derived.js';
import {
    BUILDER_PRESET, BUILDER_TRANSFORM, BUILDER_EXPRESSION,
    VIEW_FORM, VIEW_YAML, derivedState,
    $, $input, $select, $textarea,
} from './state.js';
import type { BuilderKind } from './state.js';
import {
    buildFormulaPayload, setBuilderUi, setViewUi,
    renderCandidates, schedulePreview, loadCandidates, syncYamlIfUntouched,
    updateYamlSyncBadge, switchDerivedView, switchDerivedBuilder,
} from './form.js';

"""
    + apply_renames(chunk(365, 585))
)

PAGE = """// Derived entities — facade.
export {
    switchDerivedBuilder,
    switchDerivedView,
    toggleDerivedInput,
    filterDerivedCandidates,
    insertDerivedExpressionEntity,
    reloadDerivedYaml,
    runDerivedPreview,
} from './form.js';

export {
    openDerivedModal,
    closeDerivedModal,
    saveDerived,
    deleteDerivedFromModal,
    toggleDerivedSelection,
    switchDerivedMode,
} from './modal.js';
"""


def main() -> None:
    (OUT / "form.ts").write_text(FORM_PREVIEW)
    (OUT / "modal.ts").write_text(MODAL)
    (OUT / "page.ts").write_text(PAGE)
    for name in ("form", "modal", "page"):
        p = OUT / f"{name}.ts"
        print(f"{name}.ts: {len(p.read_text().splitlines())} lines")


if __name__ == "__main__":
    main()
