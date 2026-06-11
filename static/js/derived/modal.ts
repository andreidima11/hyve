// Derived entities — open, save, delete.
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

function resetForm() {
    const nameEl = $input('derived-name');
    const valueTypeEl = $select('derived-value-type');
    const unitEl = $input('derived-unit');
    const presetEl = $select('derived-preset');
    const expressionEl = $textarea('derived-expression');
    const searchEl = $input('derived-inputs-search');
    const previewValueEl = $('derived-preview-value');
    const previewInputsEl = $('derived-preview-inputs');
    const filterEl = $select('derived-transform-filter');
    const scaleEl = $input('derived-transform-scale');
    const offsetEl = $input('derived-transform-offset');
    const yamlEl = $textarea('derived-yaml');
    const deleteBtn = $('derived-delete-btn');
    const titleEl = $('derived-modal-title');

    if (nameEl) nameEl.value = '';
    if (valueTypeEl) valueTypeEl.value = 'number';
    if (unitEl) unitEl.value = '';
    if (presetEl) presetEl.value = 'sum';
    if (expressionEl) expressionEl.value = '';
    if (searchEl) searchEl.value = '';
    if (previewValueEl) previewValueEl.textContent = '—';
    if (previewInputsEl) previewInputsEl.innerHTML = '';
    if (filterEl) filterEl.value = 'none';
    if (scaleEl) scaleEl.value = '1';
    if (offsetEl) offsetEl.value = '0';
    if (yamlEl) yamlEl.value = '';
    derivedState.selectedInputs = new Set();
    derivedState.editingId = null;
    derivedState.yamlTouched = false;
    deleteBtn?.classList.add('hidden');
    if (titleEl) titleEl.textContent = t('derived.modal_title');
    setBuilderUi(BUILDER_PRESET);
    setViewUi(VIEW_FORM);
}

export async function openDerivedModal(entityId?: string) {
    resetForm();
    const modal = $('derived-modal') as DerivedModalEl | null;
    if (!modal) return;
    // Reparent la <body> ca să nu fie afectat de overflow/transform din strămoși (#view-smarthome)
    if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.classList.add('derived-page-open');
    await loadCandidates();

    if (!modal.__wired) {
        // Every input change triggers preview + YAML sync (if view=yaml & untouched)
        const ids = [
            'derived-name', 'derived-value-type', 'derived-unit',
            'derived-preset', 'derived-expression',
            'derived-transform-filter', 'derived-transform-scale', 'derived-transform-offset',
        ];
        for (const id of ids) {
            const el = $(id);
            if (!el) continue;
            el.addEventListener('input', () => { schedulePreview(); syncYamlIfUntouched(); });
            el.addEventListener('change', () => { schedulePreview(); syncYamlIfUntouched(); });
        }
        const yamlEl = $textarea('derived-yaml');
        if (yamlEl) {
            yamlEl.addEventListener('input', () => {
                derivedState.yamlTouched = true;
                updateYamlSyncBadge();
                schedulePreview();
            });
        }
        modal.__wired = true;
    }

    if (entityId) {
        try {
            const res = await apiCall('/api/derived/raw');
            const data = await res.json() as { entries?: DerivedEntry[] };
            const entry = (data.entries || []).find(e => e.entity_id === entityId);
            if (entry) populateForm(entry);
        } catch { /* ignore */ }
    }
    schedulePreview();
}

function populateForm(entry: DerivedEntry) {
    derivedState.editingId = entry.entity_id || null;
    const titleEl = $('derived-modal-title');
    const deleteBtn = $('derived-delete-btn');
    const nameEl = $input('derived-name');
    const valueTypeEl = $select('derived-value-type');
    const unitEl = $input('derived-unit');
    const expressionEl = $textarea('derived-expression');
    const presetEl = $select('derived-preset');
    const filterEl = $select('derived-transform-filter');
    const scaleEl = $input('derived-transform-scale');
    const offsetEl = $input('derived-transform-offset');

    if (titleEl) titleEl.textContent = t('derived.modal_edit_title');
    deleteBtn?.classList.remove('hidden');
    if (nameEl) nameEl.value = entry.name || '';
    if (valueTypeEl) valueTypeEl.value = entry.value_type || 'number';
    if (unitEl) unitEl.value = entry.unit || '';
    const formula = entry.formula || { type: 'sum', inputs: [] };
    const ftype = (formula.type || '').toLowerCase();

    if (ftype === 'expression') {
        if (expressionEl) expressionEl.value = 'expression' in formula ? (formula.expression || '') : '';
        derivedState.selectedInputs = new Set();
        setBuilderUi(BUILDER_EXPRESSION);
    } else if (ftype === 'transform') {
        derivedState.selectedInputs = new Set((formula.inputs || []).slice(0, 1));
        if (filterEl) filterEl.value = 'filter' in formula ? (formula.filter || 'none') : 'none';
        if (scaleEl) scaleEl.value = 'scale' in formula && formula.scale != null ? String(formula.scale) : '1';
        if (offsetEl) offsetEl.value = 'offset' in formula && formula.offset != null ? String(formula.offset) : '0';
        setBuilderUi(BUILDER_TRANSFORM);
        renderCandidates();
    } else {
        if (presetEl) presetEl.value = ftype || 'sum';
        derivedState.selectedInputs = new Set(formula.inputs || []);
        setBuilderUi(BUILDER_PRESET);
        renderCandidates();
    }
}

export function closeDerivedModal() {
    const modal = $('derived-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.classList.remove('derived-page-open');
}

/* ───────────────────── Save / delete ─────────────────────────────────── */

export async function saveDerived() {
    try {
        let res: Response;
        if (derivedState.view === VIEW_YAML) {
            const text = ($textarea('derived-yaml')?.value || '').trim();
            if (!text) { showToast(t('derived.err_yaml'), 'error'); return; }
            res = await apiCall('/api/derived/yaml/save', {
                method: 'POST',
                body: { yaml: text, entity_id: derivedState.editingId || null },
            });
        } else {
            const name = ($input('derived-name')?.value || '').trim();
            if (!name) { showToast(t('derived.err_name'), 'error'); return; }
            const formula = buildFormulaPayload();
            if (formula.type === 'expression') {
                if (!('expression' in formula) || !formula.expression) {
                    showToast(t('derived.err_expression'), 'error');
                    return;
                }
            } else if (!formula.inputs?.length) {
                showToast(t('derived.err_inputs'), 'error');
                return;
            }
            const body = {
                name,
                value_type: $select('derived-value-type')?.value || 'number',
                unit: ($input('derived-unit')?.value || '').trim(),
                selected: true,
                formula,
            };
            if (derivedState.editingId) {
                res = await apiCall(`/api/derived/${encodeURIComponent(derivedState.editingId)}`, { method: 'PUT', body });
            } else {
                res = await apiCall('/api/derived/create', { method: 'POST', body });
            }
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            showToast(err.detail || t('derived.save_failed'), 'error');
            return;
        }
        showToast(derivedState.editingId ? (t('derived.saved')) : (t('derived.created')), 'success');
        closeDerivedModal();
        await loadSmarthome();
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function deleteDerivedFromModal() {
    if (!derivedState.editingId) return;
    const eid = derivedState.editingId;
    const ok = await showConfirm((t('derived.confirm_delete_title')) + `\n${eid}`);
    if (!ok) return;
    try {
        const res = await apiCall(`/api/derived/${encodeURIComponent(eid)}`, { method: 'DELETE' });
        if (!res.ok) {
            showToast(t('hy.delete_failed'), 'error');
            return;
        }
        showToast(t('derived.deleted'), 'success');
        closeDerivedModal();
        await loadSmarthome();
    } catch {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function toggleDerivedSelection(entityId: string, selected: boolean) {
    try {
        await apiCall(`/api/derived/${encodeURIComponent(entityId)}/selection`, {
            method: 'POST', body: { selected: !!selected },
        });
    } catch {
        showToast(t('hy.network_error'), 'error');
    }
}

// Back-compat for any stale inline handlers that may still call switchDerivedMode.
export function switchDerivedMode(kind: string) {
    if (kind === 'yaml') return switchDerivedView(VIEW_YAML);
    if (kind === BUILDER_PRESET || kind === BUILDER_TRANSFORM || kind === BUILDER_EXPRESSION) {
        switchDerivedView(VIEW_FORM);
        return switchDerivedBuilder(kind as BuilderKind);
    }
}
