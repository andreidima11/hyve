// Derived entities ("template sensors") — create, edit, delete, live preview.
//
// Architecture:
//   _builder  — which FORMULA shape is active: preset | transform | expression
//   _view     — which VIEW is shown: form | yaml
//   When switching to YAML view, we serialise the current builder's formula
//   into YAML (unless the user has manually edited YAML).
import { apiCall } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, showToast, showConfirm } from './utils.js';
import { loadSmarthome } from './features.js';
const BUILDER_PRESET = 'preset';
const BUILDER_TRANSFORM = 'transform';
const BUILDER_EXPRESSION = 'expression';
const VIEW_FORM = 'form';
const VIEW_YAML = 'yaml';
let _builder = BUILDER_PRESET;
let _view = VIEW_FORM;
let _editingId = null;
let _candidates = [];
let _selectedInputs = new Set();
let _previewTimer = null;
let _yamlTouched = false;
function $(id) {
    return document.getElementById(id);
}
function $input(id) {
    return document.getElementById(id);
}
function $select(id) {
    return document.getElementById(id);
}
function $textarea(id) {
    return document.getElementById(id);
}
/* ───────────────────── Builder (preset/transform/expression) ─────────── */
function _setBuilderUi(builder) {
    _builder = builder;
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
    if (builder === BUILDER_TRANSFORM && _selectedInputs.size > 1) {
        const first = _selectedInputs.values().next().value;
        _selectedInputs = new Set([first]);
        _renderCandidates();
    }
    _schedulePreview();
}
export function switchDerivedBuilder(builder) {
    if (![BUILDER_PRESET, BUILDER_TRANSFORM, BUILDER_EXPRESSION].includes(builder))
        return;
    _setBuilderUi(builder);
}
/* ───────────────────── View switcher (form/yaml) ─────────────────────── */
function _setViewUi(view) {
    _view = view;
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
        const shouldSync = !ta?.value || !_yamlTouched;
        if (shouldSync)
            _renderYamlFromForm();
        _updateYamlSyncBadge();
    }
    _schedulePreview();
}
export function switchDerivedView(view) {
    if (![VIEW_FORM, VIEW_YAML].includes(view))
        return;
    _setViewUi(view);
}
function _updateYamlSyncBadge() {
    const badge = $('derived-yaml-sync-badge');
    if (!badge)
        return;
    badge.textContent = _yamlTouched
        ? (t('derived.yaml_edited'))
        : (t('derived.yaml_synced'));
    badge.classList.toggle('text-amber-400', _yamlTouched);
    badge.classList.toggle('text-emerald-400', !_yamlTouched);
}
/* ───────────────────── Candidates + inputs picker ────────────────────── */
async function _loadCandidates() {
    const insertSelect = $select('derived-expression-insert');
    try {
        const res = await apiCall('/api/derived/candidates');
        const data = await res.json();
        _candidates = (data.entities || []).filter(e => !(e.entity_id || '').startsWith('derived.'));
    }
    catch {
        _candidates = [];
    }
    _renderCandidates();
    if (insertSelect) {
        const opts = ['<option value="">— ' + (t('derived.insert_entity')) + ' —</option>'];
        for (const e of _candidates) {
            opts.push(`<option value="${escapeHtml(e.entity_id)}">${escapeHtml(e.entity_id)} · ${escapeHtml(String(e.state ?? ''))}</option>`);
        }
        insertSelect.innerHTML = opts.join('');
    }
}
function _renderCandidates() {
    const list = $('derived-candidates-list');
    if (!list)
        return;
    const q = ($input('derived-inputs-search')?.value || '').toLowerCase().trim();
    const items = _candidates.filter(e => {
        if (!q)
            return true;
        return (e.entity_id || '').toLowerCase().includes(q)
            || String(e.state ?? '').toLowerCase().includes(q);
    });
    if (!items.length) {
        list.innerHTML = `<div class="text-center text-slate-500 text-sm py-6">${escapeHtml(t('derived.no_candidates'))}</div>`;
        _updateInputsCount();
        return;
    }
    const single = _builder === BUILDER_TRANSFORM;
    list.innerHTML = items.map(e => {
        const eid = e.entity_id;
        const checked = _selectedInputs.has(eid) ? 'checked' : '';
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
    _updateInputsCount();
}
function _updateInputsCount() {
    const el = $('derived-inputs-count');
    if (el)
        el.textContent = String(_selectedInputs.size);
}
export function toggleDerivedInput(el) {
    if (_builder === BUILDER_TRANSFORM) {
        _selectedInputs = new Set([el.value]);
        _renderCandidates();
    }
    else {
        if (el.checked)
            _selectedInputs.add(el.value);
        else
            _selectedInputs.delete(el.value);
        _updateInputsCount();
    }
    _schedulePreview();
    _syncYamlIfUntouched();
}
export function filterDerivedCandidates() { _renderCandidates(); }
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
    _schedulePreview();
    _syncYamlIfUntouched();
}
/* ───────────────────── Payload builders ──────────────────────────────── */
function _buildFormulaPayload() {
    if (_builder === BUILDER_EXPRESSION) {
        return {
            type: 'expression',
            expression: ($textarea('derived-expression')?.value || '').trim(),
            inputs: [],
        };
    }
    if (_builder === BUILDER_TRANSFORM) {
        const inputs = Array.from(_selectedInputs).slice(0, 1);
        return {
            type: 'transform',
            inputs,
            filter: $select('derived-transform-filter')?.value || 'none',
            scale: parseFloat($input('derived-transform-scale')?.value || '1'),
            offset: parseFloat($input('derived-transform-offset')?.value || '0'),
        };
    }
    const preset = $select('derived-preset')?.value || 'sum';
    return { type: preset, inputs: Array.from(_selectedInputs) };
}
function _buildEntryPayload() {
    return {
        name: ($input('derived-name')?.value || '').trim(),
        value_type: $select('derived-value-type')?.value || 'number',
        unit: ($input('derived-unit')?.value || '').trim(),
        selected: true,
        formula: _buildFormulaPayload(),
    };
}
/* ───────────────────── YAML ↔ Form sync ──────────────────────────────── */
async function _renderYamlFromForm() {
    const ta = $textarea('derived-yaml');
    if (!ta)
        return;
    try {
        const res = await apiCall('/api/derived/yaml/serialize', {
            method: 'POST',
            body: _buildEntryPayload(),
        });
        if (res.ok) {
            const data = await res.json();
            ta.value = data.yaml || '';
            _yamlTouched = false;
            _updateYamlSyncBadge();
        }
    }
    catch { /* ignore */ }
}
function _syncYamlIfUntouched() {
    if (_view !== VIEW_YAML)
        return;
    if (_yamlTouched)
        return;
    _renderYamlFromForm();
}
export async function reloadDerivedYaml() {
    await _renderYamlFromForm();
}
/* ───────────────────── Preview ───────────────────────────────────────── */
function _schedulePreview() {
    if (_previewTimer)
        clearTimeout(_previewTimer);
    _previewTimer = setTimeout(runDerivedPreview, 400);
}
async function _resolveFormulaForPreview() {
    if (_view === VIEW_YAML) {
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
        formula: _buildFormulaPayload(),
    };
}
function _setPreviewInputs(html) {
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
        resolved = await _resolveFormulaForPreview();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : 'invalid YAML';
        valueEl.textContent = '!';
        valueEl.classList.add('text-red-400');
        _setPreviewInputs(`<span class="text-red-400">${escapeHtml(msg)}</span>`);
        return;
    }
    valueEl.classList.remove('text-red-400');
    if (!resolved) {
        valueEl.textContent = '—';
        _setPreviewInputs('');
        return;
    }
    const { value_type, unit, formula } = resolved;
    if (formula.type === 'expression' && !('expression' in formula && formula.expression)) {
        valueEl.textContent = '—';
        _setPreviewInputs('');
        return;
    }
    if (formula.type !== 'expression' && (!formula.inputs || !formula.inputs.length)) {
        valueEl.textContent = '—';
        _setPreviewInputs('');
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
            _setPreviewInputs(`<span class="text-red-400">${escapeHtml(err.detail || 'error')}</span>`);
            return;
        }
        const data = await res.json();
        const state = data.state;
        const hasValue = state != null && state !== 'unavailable' && state !== '';
        valueEl.textContent = (state ?? '—') + (unit && hasValue ? ' ' + unit : '');
        const rows = Object.entries(data.input_states || {}).map(([k, v]) => `<div><span class="text-slate-600">${escapeHtml(k)}</span> = <span class="text-slate-300">${escapeHtml(String(v ?? '∅'))}</span></div>`);
        _setPreviewInputs(rows.join(''));
    }
    catch {
        valueEl.textContent = '!';
        valueEl.classList.add('text-red-400');
        _setPreviewInputs('<span class="text-red-400">network error</span>');
    }
}
/* ───────────────────── Open / populate / reset ───────────────────────── */
function _resetForm() {
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
    if (nameEl)
        nameEl.value = '';
    if (valueTypeEl)
        valueTypeEl.value = 'number';
    if (unitEl)
        unitEl.value = '';
    if (presetEl)
        presetEl.value = 'sum';
    if (expressionEl)
        expressionEl.value = '';
    if (searchEl)
        searchEl.value = '';
    if (previewValueEl)
        previewValueEl.textContent = '—';
    if (previewInputsEl)
        previewInputsEl.innerHTML = '';
    if (filterEl)
        filterEl.value = 'none';
    if (scaleEl)
        scaleEl.value = '1';
    if (offsetEl)
        offsetEl.value = '0';
    if (yamlEl)
        yamlEl.value = '';
    _selectedInputs = new Set();
    _editingId = null;
    _yamlTouched = false;
    deleteBtn?.classList.add('hidden');
    if (titleEl)
        titleEl.textContent = t('derived.modal_title');
    _setBuilderUi(BUILDER_PRESET);
    _setViewUi(VIEW_FORM);
}
export async function openDerivedModal(entityId) {
    _resetForm();
    const modal = $('derived-modal');
    if (!modal)
        return;
    // Reparent la <body> ca să nu fie afectat de overflow/transform din strămoși (#view-smarthome)
    if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.classList.add('derived-page-open');
    await _loadCandidates();
    if (!modal.__wired) {
        // Every input change triggers preview + YAML sync (if view=yaml & untouched)
        const ids = [
            'derived-name', 'derived-value-type', 'derived-unit',
            'derived-preset', 'derived-expression',
            'derived-transform-filter', 'derived-transform-scale', 'derived-transform-offset',
        ];
        for (const id of ids) {
            const el = $(id);
            if (!el)
                continue;
            el.addEventListener('input', () => { _schedulePreview(); _syncYamlIfUntouched(); });
            el.addEventListener('change', () => { _schedulePreview(); _syncYamlIfUntouched(); });
        }
        const yamlEl = $textarea('derived-yaml');
        if (yamlEl) {
            yamlEl.addEventListener('input', () => {
                _yamlTouched = true;
                _updateYamlSyncBadge();
                _schedulePreview();
            });
        }
        modal.__wired = true;
    }
    if (entityId) {
        try {
            const res = await apiCall('/api/derived/raw');
            const data = await res.json();
            const entry = (data.entries || []).find(e => e.entity_id === entityId);
            if (entry)
                _populateForm(entry);
        }
        catch { /* ignore */ }
    }
    _schedulePreview();
}
function _populateForm(entry) {
    _editingId = entry.entity_id || null;
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
    if (titleEl)
        titleEl.textContent = t('derived.modal_edit_title');
    deleteBtn?.classList.remove('hidden');
    if (nameEl)
        nameEl.value = entry.name || '';
    if (valueTypeEl)
        valueTypeEl.value = entry.value_type || 'number';
    if (unitEl)
        unitEl.value = entry.unit || '';
    const formula = entry.formula || { type: 'sum', inputs: [] };
    const ftype = (formula.type || '').toLowerCase();
    if (ftype === 'expression') {
        if (expressionEl)
            expressionEl.value = 'expression' in formula ? (formula.expression || '') : '';
        _selectedInputs = new Set();
        _setBuilderUi(BUILDER_EXPRESSION);
    }
    else if (ftype === 'transform') {
        _selectedInputs = new Set((formula.inputs || []).slice(0, 1));
        if (filterEl)
            filterEl.value = 'filter' in formula ? (formula.filter || 'none') : 'none';
        if (scaleEl)
            scaleEl.value = 'scale' in formula && formula.scale != null ? String(formula.scale) : '1';
        if (offsetEl)
            offsetEl.value = 'offset' in formula && formula.offset != null ? String(formula.offset) : '0';
        _setBuilderUi(BUILDER_TRANSFORM);
        _renderCandidates();
    }
    else {
        if (presetEl)
            presetEl.value = ftype || 'sum';
        _selectedInputs = new Set(formula.inputs || []);
        _setBuilderUi(BUILDER_PRESET);
        _renderCandidates();
    }
}
export function closeDerivedModal() {
    const modal = $('derived-modal');
    if (!modal)
        return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.classList.remove('derived-page-open');
}
/* ───────────────────── Save / delete ─────────────────────────────────── */
export async function saveDerived() {
    try {
        let res;
        if (_view === VIEW_YAML) {
            const text = ($textarea('derived-yaml')?.value || '').trim();
            if (!text) {
                showToast(t('derived.err_yaml'), 'error');
                return;
            }
            res = await apiCall('/api/derived/yaml/save', {
                method: 'POST',
                body: { yaml: text, entity_id: _editingId || null },
            });
        }
        else {
            const name = ($input('derived-name')?.value || '').trim();
            if (!name) {
                showToast(t('derived.err_name'), 'error');
                return;
            }
            const formula = _buildFormulaPayload();
            if (formula.type === 'expression') {
                if (!('expression' in formula) || !formula.expression) {
                    showToast(t('derived.err_expression'), 'error');
                    return;
                }
            }
            else if (!formula.inputs?.length) {
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
            if (_editingId) {
                res = await apiCall(`/api/derived/${encodeURIComponent(_editingId)}`, { method: 'PUT', body });
            }
            else {
                res = await apiCall('/api/derived/create', { method: 'POST', body });
            }
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || t('derived.save_failed'), 'error');
            return;
        }
        showToast(_editingId ? (t('derived.saved')) : (t('derived.created')), 'success');
        closeDerivedModal();
        await loadSmarthome();
    }
    catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}
export async function deleteDerivedFromModal() {
    if (!_editingId)
        return;
    const eid = _editingId;
    const ok = await showConfirm((t('derived.confirm_delete_title')) + `\n${eid}`);
    if (!ok)
        return;
    try {
        const res = await apiCall(`/api/derived/${encodeURIComponent(eid)}`, { method: 'DELETE' });
        if (!res.ok) {
            showToast(t('hy.delete_failed'), 'error');
            return;
        }
        showToast(t('derived.deleted'), 'success');
        closeDerivedModal();
        await loadSmarthome();
    }
    catch {
        showToast(t('hy.network_error'), 'error');
    }
}
export async function toggleDerivedSelection(entityId, selected) {
    try {
        await apiCall(`/api/derived/${encodeURIComponent(entityId)}/selection`, {
            method: 'POST', body: { selected: !!selected },
        });
    }
    catch {
        showToast(t('hy.network_error'), 'error');
    }
}
// Back-compat for any stale inline handlers that may still call switchDerivedMode.
export function switchDerivedMode(kind) {
    if (kind === 'yaml')
        return switchDerivedView(VIEW_YAML);
    if (kind === BUILDER_PRESET || kind === BUILDER_TRANSFORM || kind === BUILDER_EXPRESSION) {
        switchDerivedView(VIEW_FORM);
        return switchDerivedBuilder(kind);
    }
}
