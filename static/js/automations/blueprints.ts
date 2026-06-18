import { apiCall, suppressLogout } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm, openSubPage, closeSubPage } from '../utils.js';
import type { AutomationPickerArea, AutomationPickerEntity } from '../types/features_automations.js';
import { autoEl, errMsg, inputVal } from './utils.js';
import { loadAutomations } from './list.js';

// --------------------------------------------------------------------------- //
// Blueprint picker — Sprint 5 slice 3                                         //
// --------------------------------------------------------------------------- //

let _blueprints: Record<string, unknown>[] = [];
let _activeBlueprint: Record<string, unknown> | null = null;
let _pickerEntityCache: AutomationPickerEntity[] | null = null;
let _pickerAreaCache: AutomationPickerArea[] | null = null;
let _blueprintCreatorInputs: Record<string, unknown>[] = [];

function _prepareBlueprintPickerModal(): HTMLElement | null {
    const modal = document.getElementById('blueprint-picker-modal');
    if (!modal) return null;
    const host = document.getElementById('view-config') || document.querySelector('main') || document.body;
    if (modal.parentElement !== host) {
        host.appendChild(modal);
    }
    modal.style.position = '';
    modal.style.inset = '';
    modal.style.zIndex = '';
    return modal;
}

function _setBlueprintHubSubview(open: boolean): void {
    document.getElementById('config-standalone')?.classList.toggle('hyd-config-standalone--subview', open);
}

async function _blueprintApiCall(url: string, options: RequestInit = {}): Promise<Response> {
    suppressLogout(true);
    try {
        return await apiCall(url, options);
    } finally {
        suppressLogout(false);
    }
}

export async function openBlueprintPicker(): Promise<void> {
    _prepareBlueprintPickerModal();
    _setBlueprintHubSubview(true);
    openSubPage('blueprint-picker-modal');
    backToBlueprintList();
    loadBlueprints();
}

export function closeBlueprintPicker(): void {
    closeSubPage('blueprint-picker-modal');
    _setBlueprintHubSubview(false);
    _activeBlueprint = null;
}

export function backToBlueprintList(): void {
    _activeBlueprint = null;
    document.getElementById('blueprint-picker-list-pane')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-form-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-form-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-create-btn')?.classList.add('hidden');
    document.getElementById('blueprint-picker-delete-btn')?.classList.add('hidden');
    const errEl = document.getElementById('blueprint-picker-form-error');
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
    const creatorErrEl = document.getElementById('blueprint-creator-error');
    if (creatorErrEl) { creatorErrEl.classList.add('hidden'); creatorErrEl.textContent = ''; }
}

function _defaultBlueprintTemplate(): string {
    return `id: morning_notice
title: "Morning notice"
mode: single
trigger:
  - platform: time
    at: "08:00"
action:
  - notify:
      text: "${t('blueprints.default_notify_text')}"`;
}

function _readBlueprintCreatorInputsFromDom(): Record<string, unknown>[] {
    const rows = Array.from(document.querySelectorAll('#blueprint-creator-inputs [data-bp-creator-input-row]'));
    return rows.map((row, idx) => {
        const read = (selector: string) => inputVal(row.querySelector(selector));
        return {
            id: read('[data-bp-creator-field="id"]').trim() || `input_${idx + 1}`,
            label: read('[data-bp-creator-field="label"]').trim(),
            type: read('[data-bp-creator-field="type"]').trim() || 'string',
            required: !!(row.querySelector('[data-bp-creator-field="required"]') as HTMLInputElement | null)?.checked,
            default: read('[data-bp-creator-field="default"]'),
            choices: read('[data-bp-creator-field="choices"]'),
        };
    });
}

function _yamlScalar(value: unknown) {
    return JSON.stringify(String(value ?? ''));
}

function _indentBlock(text: string) {
    return String(text || '').replace(/\s+$/g, '').split('\n').map(line => `  ${line}`).join('\n');
}

function _validateBlueprintCreatorDraft(draft: Record<string, unknown>) {
    const title = String(draft.title || '').trim();
    if (!title) return t('blueprints.title_required');
    if (!String(draft.template || '').trim()) return t('blueprints.template_required');
    const seen = new Set();
    const inputs = Array.isArray(draft.inputs) ? draft.inputs as Record<string, unknown>[] : [];
    for (const input of inputs) {
        const inputId = String(input.id || '');
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inputId)) return t('blueprints.invalid_input_id', { id: inputId });
        if (seen.has(inputId)) return t('blueprints.duplicate_input', { id: inputId });
        seen.add(inputId);
        if (input.type === 'select' && !String(input.choices || '').split(',').map(v => v.trim()).filter(Boolean).length) {
            return t('blueprints.select_needs_options', { id: inputId });
        }
    }
    const refs = new Set();
    String(draft.template || '').replace(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, key) => {
        refs.add(key);
        return _m;
    });
    for (const key of refs) {
        if (!seen.has(key)) return t('blueprints.unknown_input_ref', { key });
    }
    return '';
}

function _composeBlueprintSourceYaml(draft: Record<string, unknown>) {
    const lines = [
        `title: ${_yamlScalar(draft.title)}`,
        `description: ${_yamlScalar(draft.description)}`,
    ];
    const draftInputs = Array.isArray(draft.inputs) ? draft.inputs as Record<string, unknown>[] : [];
    if (!draftInputs.length) {
        lines.push('inputs: []');
    } else {
        lines.push('inputs:');
        const inputs = Array.isArray(draft.inputs) ? draft.inputs as Record<string, unknown>[] : [];
    for (const input of inputs) {
            lines.push(`  - id: ${input.id}`);
            lines.push(`    label: ${_yamlScalar(input.label || input.id)}`);
            lines.push(`    type: ${input.type}`);
            if (input.required) lines.push('    required: true');
            if (String(input.default || '').trim()) lines.push(`    default: ${_yamlScalar(input.default)}`);
            if (input.type === 'select') {
                const choices = String(input.choices || '').split(',').map(v => v.trim()).filter(Boolean);
                lines.push('    choices:');
                for (const choice of choices) lines.push(`      - ${_yamlScalar(choice)}`);
            }
        }
    }
    lines.push('template: |');
    lines.push(_indentBlock(String(draft.template || '')));
    return `${lines.join('\n')}\n`;
}

function _currentBlueprintCreatorDraft(): Record<string, unknown> {
    return {
        title: autoEl('blueprint-creator-title')?.value || '',
        description: autoEl('blueprint-creator-description')?.value || '',
        inputs: _readBlueprintCreatorInputsFromDom(),
        template: autoEl('blueprint-creator-template')?.value || '',
    };
}

function _renderBlueprintCreatorInputs(): void {
    const host = document.getElementById('blueprint-creator-inputs');
    if (!host) return;
    host.innerHTML = _blueprintCreatorInputs.map((input, idx) => {
        const choicesVisible = input.type === 'select' ? '' : 'hidden';
        return `
            <div data-bp-creator-input-row="${idx}" class="hyd-app-card hyd-app-card--nested space-y-3">
                <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_140px_auto] gap-2 items-end">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">ID</label>
                        <input type="text" data-bp-creator-field="id" value="${escapeHtml(input.id)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-theme-subtle rounded-lg px-3 py-2 text-xs mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Label</label>
                        <input type="text" data-bp-creator-field="label" value="${escapeHtml(input.label)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-theme-subtle rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Tip</label>
                        <select data-bp-creator-field="type" data-memory-input="changeBlueprintCreatorInputType" data-memory-index="${idx}" class="w-full bg-slate-950 border border-theme-subtle rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                            ${['string', 'number', 'boolean', 'entity', 'area', 'select', 'duration'].map(type => `<option value="${type}" ${input.type === type ? 'selected' : ''}>${type}</option>`).join('')}
                        </select>
                    </div>
                    <button type="button" data-memory-action="removeBlueprintCreatorInput" data-memory-index="${idx}" class="w-9 h-9 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 flex items-center justify-center transition-colors" title="${escapeHtml(t('blueprints.remove_input_title'))}"><i class="fas fa-trash text-xs"></i></button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Default</label>
                        <input type="text" data-bp-creator-field="default" value="${escapeHtml(input.default)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-theme-subtle rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                    </div>
                    <label class="inline-flex items-center gap-2 rounded-lg border border-theme-subtle bg-white/[0.02] px-3 py-2 text-xs text-slate-300">
                        <input type="checkbox" data-bp-creator-field="required" ${input.required ? 'checked' : ''} data-memory-input="updateBlueprintCreatorYaml" class="w-4 h-4 rounded accent-blue-500 bg-slate-900 border-theme-subtle">
                        Obligatoriu
                    </label>
                </div>
                <div class="space-y-1 ${choicesVisible}">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${escapeHtml(t('blueprints.options_label'))}</label>
                    <input type="text" data-bp-creator-field="choices" value="${escapeHtml(input.choices)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-theme-subtle rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                </div>
            </div>
        `;
    }).join('');
    _renderBlueprintCreatorPlaceholders();
}

function _renderBlueprintCreatorPlaceholders(): void {
    const host = document.getElementById('blueprint-creator-placeholders');
    if (!host) return;
    const inputs = _readBlueprintCreatorInputsFromDom().filter(input => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(input.id || '')));
    if (!inputs.length) {
        host.classList.add('hidden');
        host.innerHTML = '';
        return;
    }
    host.classList.remove('hidden');
    host.innerHTML = inputs.flatMap(input => [
        `<button type="button" data-memory-action="insertBlueprintCreatorPlaceholder" data-memory-input-id="${escapeHtml(input.id)}" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] mono text-slate-300 transition-colors">{{ inputs.${escapeHtml(input.id)} }}</button>`,
        `<button type="button" data-memory-action="insertBlueprintCreatorPlaceholder" data-memory-input-id="${escapeHtml(input.id)}" data-memory-slugify="true" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] mono text-violet-300 transition-colors">{{ inputs.${escapeHtml(input.id)} | slug }}</button>`,
    ]).join('');
}

export function openBlueprintCreator(): void {
    _prepareBlueprintPickerModal();
    openSubPage('blueprint-picker-modal');
    _activeBlueprint = null;
    document.getElementById('blueprint-picker-list-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-pane')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-actions')?.classList.remove('hidden');
    autoEl('blueprint-creator-title')!.value = '';
    autoEl('blueprint-creator-description')!.value = '';
    autoEl('blueprint-creator-template')!.value = _defaultBlueprintTemplate();
    _blueprintCreatorInputs = [];
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function addBlueprintCreatorInput(): void {
    _blueprintCreatorInputs = _readBlueprintCreatorInputsFromDom();
    const next = _blueprintCreatorInputs.length + 1;
    _blueprintCreatorInputs.push({
        id: next === 1 ? 'entity_id' : `input_${next}`,
        label: next === 1 ? 'Entity' : `Input ${next}`,
        type: next === 1 ? 'entity' : 'string',
        required: true,
        default: '',
        choices: '',
    });
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function removeBlueprintCreatorInput(index: number) {
    _blueprintCreatorInputs = _readBlueprintCreatorInputsFromDom();
    _blueprintCreatorInputs.splice(Number(index), 1);
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function changeBlueprintCreatorInputType(index: number, type: string) {
    _blueprintCreatorInputs = _readBlueprintCreatorInputsFromDom();
    if (_blueprintCreatorInputs[index]) _blueprintCreatorInputs[index].type = type;
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function insertBlueprintCreatorPlaceholder(inputId: string, slug = false) {
    const textarea = document.getElementById('blueprint-creator-template') as HTMLTextAreaElement | null;
    if (!textarea) return;
    const placeholder = `{{ inputs.${inputId}${slug ? ' | slug' : ''} }}`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = `${textarea.value.slice(0, start)}${placeholder}${textarea.value.slice(end)}`;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;
    updateBlueprintCreatorYaml();
}

export function updateBlueprintCreatorYaml(): void {
    const draft = _currentBlueprintCreatorDraft();
    const source = _composeBlueprintSourceYaml(draft);
    const preview = autoEl('blueprint-creator-source-yaml');
    if (preview) preview.value = source;
    const errEl = document.getElementById('blueprint-creator-error');
    if (errEl) {
        const err = _validateBlueprintCreatorDraft(draft);
        if (err && String(draft.title || '').trim()) {
            errEl.classList.remove('hidden');
            errEl.textContent = err;
        } else {
            errEl.classList.add('hidden');
            errEl.textContent = '';
        }
    }
    _renderBlueprintCreatorPlaceholders();
}

export async function saveCreatedBlueprint(): Promise<void> {
    const draft = _currentBlueprintCreatorDraft();
    const err = _validateBlueprintCreatorDraft(draft);
    const errEl = document.getElementById('blueprint-creator-error');
    if (err) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = err;
        }
        return;
    }
    const saveBtn = autoEl('blueprint-creator-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
        const sourceYaml = _composeBlueprintSourceYaml(draft);
        const res = await apiCall('/api/automations/blueprints', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.detail || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        showToast(t('hy.blueprint_saved'), 'success');
        backToBlueprintList();
        await loadBlueprints();
        if (payload.item?.id) await selectBlueprint(payload.item.id);
    } catch (e) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = errMsg(e) || t('blueprints.save_failed');
        }
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

export async function loadBlueprints(): Promise<void> {
    const listEl = document.getElementById('blueprint-picker-list');
    const emptyEl = document.getElementById('blueprint-picker-empty');
    if (!listEl) return;
    emptyEl?.classList.add('hidden');
    listEl.innerHTML = `<p class="text-[11px] text-slate-500">${escapeHtml(t('common.loading'))}</p>`;
    try {
        const res = await _blueprintApiCall('/api/automations/blueprints');
        if (!res.ok) throw new Error(res.status === 401 ? t('login.session_expired') : t('blueprints.load_failed'));
        const data = await res.json();
        _blueprints = data.items || [];
    } catch (e) {
        _blueprints = [];
        emptyEl?.classList.add('hidden');
        listEl.innerHTML = `<p class="text-[11px] text-red-300">${escapeHtml(errMsg(e) || t('blueprints.load_error'))}</p>`;
        return;
    }
    if (_blueprints.length === 0) {
        listEl.innerHTML = '';
        emptyEl?.classList.remove('hidden');
        return;
    }
    emptyEl?.classList.add('hidden');
    listEl.innerHTML = _blueprints.map(bp => `
        <button type="button" data-bp-id="${escapeHtml(bp.id)}" class="bp-pick-row hyd-entity-row w-full text-left" role="listitem">
            <span class="hyd-icon hyd-icon--list hyd-glow--default"><i class="fas fa-cube" aria-hidden="true"></i></span>
            <div class="hyd-entity-row__body min-w-0">
                <div class="hyd-entity-row__name">${escapeHtml(bp.title)}</div>
                <div class="hyd-entity-row__sub truncate">${escapeHtml(bp.description || t('blueprints.no_description'))}</div>
                <div class="hyd-entity-row__tags">
                    <span class="hyd-row-badge"><i class="fas fa-sliders" aria-hidden="true"></i>${escapeHtml(t('blueprints.inputs_count', { count: Array.isArray(bp.inputs) ? bp.inputs.length : 0 }))}</span>
                    <span class="hyd-row-badge">v${escapeHtml(bp.version || '1')}</span>
                </div>
            </div>
            <i class="fas fa-chevron-right hyd-entity-row__chev" aria-hidden="true"></i>
        </button>
    `).join('');
    listEl.querySelectorAll('.bp-pick-row').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.bpId;
            if (id) selectBlueprint(id);
        });
    });
}

export function importBlueprintYaml(): void {
    const input = document.getElementById('blueprint-yaml-import-input') as HTMLInputElement | null;
    if (!input) return;
    input.value = '';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const res = await apiCall('/api/automations/blueprints', {
                method: 'POST',
                body: { source_yaml: text },
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            showToast(t('blueprints.import_done', { name: file.name }), 'success');
            await loadBlueprints();
        } catch (e) {
            showToast(t('blueprints.import_failed', { detail: errMsg(e) || t('common.unknown') }), 'error');
        }
    };
    input.click();
}

async function _loadPickerCaches(): Promise<void> {
    if (_pickerEntityCache && _pickerAreaCache) return;
    try {
        const [entRes, areaRes] = await Promise.all([
            apiCall('/api/integrations/picker/entities?limit=1000'),
            apiCall('/api/integrations/picker/areas'),
        ]);
        _pickerEntityCache = entRes.ok ? (await entRes.json()).items || [] : [];
        _pickerAreaCache = areaRes.ok ? (await areaRes.json()).items || [] : [];
    } catch (e) {
        _pickerEntityCache = _pickerEntityCache || [];
        _pickerAreaCache = _pickerAreaCache || [];
    }
}

async function selectBlueprint(blueprintId: string) {
    const bp = _blueprints.find(b => b.id === blueprintId);
    if (!bp) return;
    _activeBlueprint = bp;
    document.getElementById('blueprint-picker-list-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-pane')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-creator-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-actions')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-create-btn')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-delete-btn')?.classList.remove('hidden');
    const formTitle = document.getElementById('blueprint-picker-form-title');
    const formDesc = document.getElementById('blueprint-picker-form-description');
    if (formTitle) formTitle.textContent = String(bp.title || '');
    if (formDesc) formDesc.textContent = String(bp.description || '');
    await _loadPickerCaches();
    const formEl = document.getElementById('blueprint-picker-form-inputs');
    if (!formEl) return;
    if (!formEl) return;
    formEl.innerHTML = (Array.isArray(bp.inputs) ? bp.inputs : []).map((spec: Record<string, unknown>) => _renderBlueprintInputField(spec)).join('');
}

function _renderBlueprintInputField(spec: Record<string, unknown>) {
    const id = `bp-input-${spec.id}`;
    const labelHtml = `<label for="${id}">${escapeHtml(spec.label || spec.id)}${spec.required ? ' <span class="text-red-400">*</span>' : ''}</label>`;
    let field = '';
    const defaultVal = spec.default == null ? '' : String(spec.default);
    if (spec.type === 'entity') {
        const opts = (_pickerEntityCache || []).map(e =>
            `<option value="${escapeHtml(e.id)}" ${e.id === defaultVal ? 'selected' : ''}>${escapeHtml(e.label)} (${escapeHtml(e.domain)})</option>`
        ).join('');
        field = `<select id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="entity"><option value="">${escapeHtml(t('blueprints.choose'))}</option>${opts}</select>`;
    } else if (spec.type === 'area') {
        const opts = (_pickerAreaCache || []).map(a =>
            `<option value="${escapeHtml(a.id)}" ${a.id === defaultVal ? 'selected' : ''}>${escapeHtml(a.label)}</option>`
        ).join('');
        field = `<select id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="area"><option value="">${escapeHtml(t('blueprints.choose'))}</option>${opts}</select>`;
    } else if (spec.type === 'select') {
        const opts = (Array.isArray(spec.choices) ? spec.choices : []).map((c: string) =>
            `<option value="${escapeHtml(c)}" ${c === defaultVal ? 'selected' : ''}>${escapeHtml(c)}</option>`
        ).join('');
        field = `<select id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="select">${opts}</select>`;
    } else if (spec.type === 'boolean') {
        field = `<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="boolean" ${defaultVal === 'true' || defaultVal === '1' ? 'checked' : ''} class="w-4 h-4">${escapeHtml(t('common.enable'))}</label>`;
    } else if (spec.type === 'number' || spec.type === 'duration') {
        field = `<input type="number" id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="${spec.type}" value="${escapeHtml(defaultVal)}"${spec.type === 'duration' ? ' placeholder="seconds"' : ''} />`;
    } else {
        field = `<input type="text" id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="string" value="${escapeHtml(defaultVal)}" />`;
    }
    return `<div>${labelHtml}${field}</div>`;
}

function _collectBlueprintInputs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    document.querySelectorAll('#blueprint-picker-form-inputs [data-bp-input]').forEach(el => {
        const node = el as HTMLInputElement | HTMLSelectElement;
        const key = node.dataset.bpInput;
        const type = node.dataset.bpType;
        if (!key) return;
        let val;
        if (type === 'boolean') val = (node as HTMLInputElement).checked;
        else val = node.value;
        out[key] = val;
    });
    return out;
}

export async function instantiateCurrentBlueprint(): Promise<void> {
    if (!_activeBlueprint) return;
    const errEl = document.getElementById('blueprint-picker-form-error');
    errEl?.classList.add('hidden');
    const inputs = _collectBlueprintInputs();
    try {
        const res = await apiCall(`/api/automations/blueprints/${encodeURIComponent(String(_activeBlueprint.id ?? ''))}/instantiate`, {
            method: 'POST',
            body: { inputs },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        showToast(t('blueprints.automation_created', { id: data.item?.id || '' }), 'success');
        closeBlueprintPicker();
        await loadAutomations();
        if (data.item?.id) {
            const { openAutomationEditor } = await import('../features_automations.js');
            await openAutomationEditor(data.item.id);
        }
    } catch (e) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = errMsg(e) || t('blueprints.instantiate_error');
        }
    }
}

export async function deleteCurrentBlueprint(): Promise<void> {
    if (!_activeBlueprint) return;
    const ok = await showConfirm(t('blueprints.delete_confirm', { title: String(_activeBlueprint.title ?? '') }));
    if (!ok) return;
    try {
        const res = await apiCall(`/api/automations/blueprints/${encodeURIComponent(String(_activeBlueprint.id ?? ''))}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast(t('hy.blueprint_deleted'), 'success');
        backToBlueprintList();
        await loadBlueprints();
    } catch (e) {
        showToast(t('hy.delete_failed'), 'error');
    }
}
