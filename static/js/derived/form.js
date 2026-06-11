// Derived entities — create, edit, delete, live preview.
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
import { BUILDER_PRESET, BUILDER_TRANSFORM, BUILDER_EXPRESSION, VIEW_FORM, VIEW_YAML, derivedState, $, $input, $select, $textarea, } from './state.js';
/* ───────────────────── Builder (preset/transform/expression) ─────────── */
export function setBuilderUi(builder) {
    derivedState.builder = builder;
    $('derived-pane-preset')?.classList.toggle('hidden', builder !== BUILDER_PRESET);
    $('derived-pane-transform')?.classList.toggle('hidden', builder !== BUILDER_TRANSFORM);
    $('derived-pane-expression')?.classList.toggle('hidden', builder !== BUILDER_EXPRESSION);
    // Inputs section is only relevant for preset + transform
    const inputsSection = $('derived-inputs-section');
    if (inputsSection)
        inputsSection.classList.toggle('hidden', builder === BUILDER_EXPRESSION);
    // Helper text adapts to builder
    const helper = $('derived-inputs-helper');
    if (helper) {
        helper.textContent = builder === BUILDER_TRANSFORM
            ? (t('derived.inputs_helper_transform'))
            : (t('derived.inputs_helper_preset'));
    }
    // Visual state on the segmented builder buttons
    const btns = [
        ['derived-builder-preset', BUILDER_PRESET],
        ['derived-builder-transform', BUILDER_TRANSFORM],
        ['derived-builder-expression', BUILDER_EXPRESSION],
    ];
    for (const [id, key] of btns) {
        const el = $(id);
        if (!el)
            continue;
        const active = key === builder;
        el.classList.toggle('bg-white/10', active);
        el.classList.toggle('text-slate-100', active);
        el.classList.toggle('text-slate-400', !active);
    }
    // Transform wants exactly one input
    if (builder === BUILDER_TRANSFORM && derivedState.selectedInputs.size > 1) {
        const first = derivedState.selectedInputs.values().next().value;
        derivedState.selectedInputs = new Set([first]);
        renderCandidates();
    }
    schedulePreview();
}
export function switchDerivedBuilder(builder) {
    if (![BUILDER_PRESET, BUILDER_TRANSFORM, BUILDER_EXPRESSION].includes(builder))
        return;
    setBuilderUi(builder);
}
/* ───────────────────── View switcher (form/yaml) ─────────────────────── */
export function setViewUi(view) {
    derivedState.view = view;
    $('derived-view-form-pane')?.classList.toggle('hidden', view !== VIEW_FORM);
    const yamlPane = $('derived-view-yaml-pane');
    if (yamlPane)
        yamlPane.classList.toggle('hidden', view !== VIEW_YAML);
    const tabs = [['derived-view-form', VIEW_FORM], ['derived-view-yaml', VIEW_YAML]];
    for (const [id, key] of tabs) {
        const btn = $(id);
        if (!btn)
            continue;
        const active = key === view;
        btn.classList.toggle('bg-white/10', active);
        btn.classList.toggle('text-slate-100', active);
        btn.classList.toggle('text-slate-400', !active);
    }
    if (view === VIEW_YAML) {
        const ta = $textarea('derived-yaml');
        const shouldSync = !ta?.value || !derivedState.yamlTouched;
        if (shouldSync)
            renderYamlFromForm();
        updateYamlSyncBadge();
    }
    schedulePreview();
}
export function switchDerivedView(view) {
    if (![VIEW_FORM, VIEW_YAML].includes(view))
        return;
    setViewUi(view);
}
export function updateYamlSyncBadge() {
    const badge = $('derived-yaml-sync-badge');
    if (!badge)
        return;
    badge.textContent = derivedState.yamlTouched
        ? (t('derived.yaml_edited'))
        : (t('derived.yaml_synced'));
    badge.classList.toggle('text-amber-400', derivedState.yamlTouched);
    badge.classList.toggle('text-emerald-400', !derivedState.yamlTouched);
}
/* ───────────────────── Candidates + inputs picker ────────────────────── */
export async function loadCandidates() {
    const insertSelect = $select('derived-expression-insert');
    try {
        const res = await apiCall('/api/derived/candidates');
        const data = await res.json();
        derivedState.candidates = (data.entities || []).filter(e => !(e.entity_id || '').startsWith('derived.'));
    }
    catch {
        derivedState.candidates = [];
    }
    renderCandidates();
    if (insertSelect) {
        const opts = ['<option value="">— ' + (t('derived.insert_entity')) + ' —</option>'];
        for (const e of derivedState.candidates) {
            opts.push(`<option value="${escapeHtml(e.entity_id)}">${escapeHtml(e.entity_id)} · ${escapeHtml(String(e.state ?? ''))}</option>`);
        }
        insertSelect.innerHTML = opts.join('');
    }
}
export function renderCandidates() {
    const list = $('derived-candidates-list');
    if (!list)
        return;
    const q = ($input('derived-inputs-search')?.value || '').toLowerCase().trim();
    const items = derivedState.candidates.filter(e => {
        if (!q)
            return true;
        return (e.entity_id || '').toLowerCase().includes(q)
            || String(e.state ?? '').toLowerCase().includes(q);
    });
    if (!items.length) {
        list.innerHTML = `<div class="text-center text-slate-500 text-sm py-6">${escapeHtml(t('derived.no_candidates'))}</div>`;
        updateInputsCount();
        return;
    }
    const single = derivedState.builder === BUILDER_TRANSFORM;
    list.innerHTML = items.map(e => {
        const eid = e.entity_id;
        const checked = derivedState.selectedInputs.has(eid) ? 'checked' : '';
        const state = e.state != null ? `${e.state}${e.unit ? ' ' + e.unit : ''}` : '';
        const inputType = single ? 'radio' : 'checkbox';
        const name = single ? 'name="derived-single"' : '';
        return `<label class="flex items-center gap-3 px-3 py-2 hover:bg-white/5 cursor-pointer">
            <input type="${inputType}" ${name} class="accent-accent" value="${escapeHtml(eid)}" ${checked} data-smarthome-change="toggleDerivedInput">
            <div class="flex-1 min-w-0">
                <div class="text-xs text-slate-200 mono truncate">${escapeHtml(eid)}</div>
                <div class="text-[10px] text-slate-500 truncate">${escapeHtml(state)}</div>
            </div>
        </label>`;
    }).join('');
    updateInputsCount();
}
function updateInputsCount() {
    const el = $('derived-inputs-count');
    if (el)
        el.textContent = String(derivedState.selectedInputs.size);
}
export function toggleDerivedInput(el) {
    if (derivedState.builder === BUILDER_TRANSFORM) {
        derivedState.selectedInputs = new Set([el.value]);
        renderCandidates();
    }
    else {
        if (el.checked)
            derivedState.selectedInputs.add(el.value);
        else
            derivedState.selectedInputs.delete(el.value);
        updateInputsCount();
    }
    schedulePreview();
    syncYamlIfUntouched();
}
export function filterDerivedCandidates() { renderCandidates(); }
export function insertDerivedExpressionEntity() {
    const select = $select('derived-expression-insert');
    const textarea = $textarea('derived-expression');
    if (!select || !textarea || !select.value)
        return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const needsSpaceBefore = before && !/[\s(+\-*/%<>=&|!,]$/.test(before);
    const snippet = (needsSpaceBefore ? ' ' : '') + select.value;
    textarea.value = before + snippet + after;
    const pos = (before + snippet).length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    select.value = '';
    schedulePreview();
    syncYamlIfUntouched();
}
/* ───────────────────── Payload builders ──────────────────────────────── */
export function buildFormulaPayload() {
    if (derivedState.builder === BUILDER_EXPRESSION) {
        return {
            type: 'expression',
            expression: ($textarea('derived-expression')?.value || '').trim(),
            inputs: [],
        };
    }
    if (derivedState.builder === BUILDER_TRANSFORM) {
        const inputs = Array.from(derivedState.selectedInputs).slice(0, 1);
        return {
            type: 'transform',
            inputs,
            filter: $select('derived-transform-filter')?.value || 'none',
            scale: parseFloat($input('derived-transform-scale')?.value || '1'),
            offset: parseFloat($input('derived-transform-offset')?.value || '0'),
        };
    }
    const preset = $select('derived-preset')?.value || 'sum';
    return { type: preset, inputs: Array.from(derivedState.selectedInputs) };
}
function buildEntryPayload() {
    return {
        name: ($input('derived-name')?.value || '').trim(),
        value_type: $select('derived-value-type')?.value || 'number',
        unit: ($input('derived-unit')?.value || '').trim(),
        selected: true,
        formula: buildFormulaPayload(),
    };
}
/* ───────────────────── YAML ↔ Form sync ──────────────────────────────── */
export async function renderYamlFromForm() {
    const ta = $textarea('derived-yaml');
    if (!ta)
        return;
    try {
        const res = await apiCall('/api/derived/yaml/serialize', {
            method: 'POST',
            body: buildEntryPayload(),
        });
        if (res.ok) {
            const data = await res.json();
            ta.value = data.yaml || '';
            derivedState.yamlTouched = false;
            updateYamlSyncBadge();
        }
    }
    catch { /* ignore */ }
}
export function syncYamlIfUntouched() {
    if (derivedState.view !== VIEW_YAML)
        return;
    if (derivedState.yamlTouched)
        return;
    renderYamlFromForm();
}
export async function reloadDerivedYaml() {
    await renderYamlFromForm();
}
/* ───────────────────── Preview ───────────────────────────────────────── */
export function schedulePreview() {
    if (derivedState.previewTimer)
        clearTimeout(derivedState.previewTimer);
    derivedState.previewTimer = setTimeout(runDerivedPreview, 400);
}
async function resolveFormulaForPreview() {
    if (derivedState.view === VIEW_YAML) {
        const text = ($textarea('derived-yaml')?.value || '').trim();
        if (!text)
            return null;
        const res = await apiCall('/api/derived/yaml/parse', { method: 'POST', body: { yaml: text } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'invalid YAML');
        }
        const parsed = await res.json();
        return {
            value_type: parsed.value_type || 'number',
            unit: parsed.unit || '',
            formula: parsed.formula || { type: 'sum', inputs: [] },
        };
    }
    return {
        value_type: $select('derived-value-type')?.value || 'number',
        unit: ($input('derived-unit')?.value || '').trim(),
        formula: buildFormulaPayload(),
    };
}
function setPreviewInputs(html) {
    const inputsEl = $('derived-preview-inputs');
    if (inputsEl)
        inputsEl.innerHTML = html || '<span class="text-slate-600">—</span>';
}
export async function runDerivedPreview() {
    const valueEl = $('derived-preview-value');
    if (!valueEl)
        return;
    let resolved;
    try {
        resolved = await resolveFormulaForPreview();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : 'invalid YAML';
        valueEl.textContent = '!';
        valueEl.classList.add('text-red-400');
        setPreviewInputs(`<span class="text-red-400">${escapeHtml(msg)}</span>`);
        return;
    }
    valueEl.classList.remove('text-red-400');
    if (!resolved) {
        valueEl.textContent = '—';
        setPreviewInputs('');
        return;
    }
    const { value_type, unit, formula } = resolved;
    if (formula.type === 'expression' && !('expression' in formula && formula.expression)) {
        valueEl.textContent = '—';
        setPreviewInputs('');
        return;
    }
    if (formula.type !== 'expression' && (!formula.inputs || !formula.inputs.length)) {
        valueEl.textContent = '—';
        setPreviewInputs('');
        return;
    }
    try {
        const res = await apiCall('/api/derived/preview', {
            method: 'POST',
            body: { value_type, formula },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            valueEl.textContent = '!';
            valueEl.classList.add('text-red-400');
            setPreviewInputs(`<span class="text-red-400">${escapeHtml(err.detail || 'error')}</span>`);
            return;
        }
        const data = await res.json();
        const state = data.state;
        const hasValue = state != null && state !== 'unavailable' && state !== '';
        valueEl.textContent = (state ?? '—') + (unit && hasValue ? ' ' + unit : '');
        const rows = Object.entries(data.input_states || {}).map(([k, v]) => `<div><span class="text-slate-600">${escapeHtml(k)}</span> = <span class="text-slate-300">${escapeHtml(String(v ?? '∅'))}</span></div>`);
        setPreviewInputs(rows.join(''));
    }
    catch {
        valueEl.textContent = '!';
        valueEl.classList.add('text-red-400');
        setPreviewInputs('<span class="text-red-400">network error</span>');
    }
}
