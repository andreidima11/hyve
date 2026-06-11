import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from '../utils.js';
import { autoEl, errMsg } from './utils.js';
import { loadAutomations, refreshAutomationStatuses } from './list.js';
import { automationState, automationIdString, editorAutomationId, } from './state.js';
import { _automationLoadCapabilities, _automationResetBuilder, _automationHydrateBuilderFromNormalized, _buildAutomationTemplate, _upgradeAutoBuilderSelects, loadAutomationEditorHistory, } from './builder.js';
export async function deleteAutomation(jobId) {
    if (!(await showConfirm(t('automations.delete_confirm'))))
        return;
    try {
        const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(jobId), { method: 'DELETE' });
        if (!res.ok)
            throw new Error();
        if (automationState.editorId === jobId)
            closeAutomationEditor();
        showToast(t('automations.deleted'), 'success');
        await loadAutomations();
    }
    catch (e) {
        showToast(t('automations.delete_error'), 'error');
    }
}
export async function openAutomationEditor(automationId) {
    automationId = automationIdString(automationId);
    const validateEl = document.getElementById('automation-editor-validation');
    const infoEl = document.getElementById('automation-editor-info');
    const pathEl = document.getElementById('automation-editor-path');
    const idEl = autoEl('automation-editor-id');
    const revEl = autoEl('automation-editor-revision');
    const idDisplayEl = document.getElementById('automation-editor-id-display');
    const titleEl = document.getElementById('automation-editor-title');
    automationState.editorId = automationId || null;
    automationState.editorRevision = null;
    if (validateEl)
        validateEl.classList.add('hidden');
    if (infoEl)
        infoEl.textContent = '';
    if (pathEl)
        pathEl.textContent = '—';
    if (idEl)
        idEl.value = automationId || '';
    if (revEl)
        revEl.value = '';
    if (idDisplayEl)
        idDisplayEl.textContent = automationId || 'YAML';
    _automationResetBuilder();
    automationState.idManuallyEdited = !!automationId;
    // Prefetch capabilities (entities/areas/schema) so the inline pickers
    // have fresh data before the user starts typing. Fire-and-forget — the
    // editor still works on stale cache (or empty) if the call is slow.
    _automationLoadCapabilities({ force: true });
    if (!automationId) {
        if (titleEl)
            titleEl.textContent = t('automations.editor_new_title');
        setCodeEditorValue('automation-editor-yaml', _buildAutomationTemplate());
        await refreshAutomationEntityOptions();
        openSubPage('automation-editor-modal');
        _upgradeAutoBuilderSelects(document.getElementById('automation-editor-modal'));
        refreshCodeEditor('automation-editor-yaml');
        return;
    }
    if (titleEl)
        titleEl.textContent = t('automations.editor_edit_title');
    setCodeEditorValue('automation-editor-yaml', '');
    if (infoEl)
        infoEl.textContent = t('automations.loading');
    openSubPage('automation-editor-modal');
    _upgradeAutoBuilderSelects(document.getElementById('automation-editor-modal'));
    refreshCodeEditor('automation-editor-yaml');
    try {
        const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(automationId));
        const data = await res.json();
        const item = data.item || {};
        automationState.editorId = item.id || automationId;
        automationState.editorRevision = item.revision || 1;
        if (idEl)
            idEl.value = item.id || automationId;
        if (idDisplayEl)
            idDisplayEl.textContent = item.id || automationId;
        if (revEl)
            revEl.value = String(item.revision || 1);
        if (pathEl)
            pathEl.textContent = item.yaml_path || '—';
        setCodeEditorValue('automation-editor-yaml', item.source_yaml || _buildAutomationTemplate());
        if (infoEl)
            infoEl.textContent = `${t('automations.revision')} ${item.revision || 1} • ${item.enabled ? (t('automations.enabled_badge')) : (t('automations.disabled_badge'))}`;
        await _automationHydrateBuilderFromNormalized(item.normalized || {}, '');
        await refreshAutomationEntityOptions();
        refreshCodeEditor('automation-editor-yaml');
        await loadAutomationEditorHistory(automationId);
    }
    catch (e) {
        showToast(t('automations.load_error'), 'error');
    }
}
export function closeAutomationEditor() {
    const historyList = document.getElementById('automation-history-list');
    const historyEmpty = document.getElementById('automation-history-empty');
    if (historyList)
        historyList.innerHTML = '';
    if (historyEmpty) {
        historyEmpty.classList.remove('hidden');
        historyEmpty.textContent = t('automations.history_unavailable');
    }
    closeSubPage('automation-editor-modal');
}
export async function validateAutomationEditor() {
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml)
        return;
    try {
        const res = await apiCall('/api/automations/definitions/validate', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        await _automationHydrateBuilderFromNormalized(data.normalized || {}, '');
        const name = data.normalized?.title || data.normalized?.id || '';
        const msg = t('automations.validation_ok', { name });
        showToast(msg, 'success');
        _renderAutomationLintWarnings(data.warnings || []);
    }
    catch (e) {
        let detail = t('automations.validation_error');
        try {
            const payload = JSON.parse(errMsg(e) || '{}');
            if (payload?.detail)
                detail = payload.detail;
        }
        catch (_) { }
        if (errMsg(e) && !errMsg(e).startsWith('{'))
            detail = errMsg(e);
        showToast(detail, 'error');
    }
}
export async function saveAutomationEditor() {
    const revisionEl = autoEl('automation-editor-revision');
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) {
        showToast(t('automations.validation_error'), 'error');
        return;
    }
    try {
        const editorId = editorAutomationId();
        if (editorId) {
            const expectedRevision = Number(revisionEl?.value || automationState.editorRevision || 1);
            const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(editorId), {
                method: 'PUT',
                body: { source_yaml: sourceYaml, expected_revision: expectedRevision },
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
                throw new Error(String(detail));
            }
            showToast(t('automations.saved'), 'success');
        }
        else {
            const res = await apiCall('/api/automations/definitions', {
                method: 'POST',
                body: { source_yaml: sourceYaml },
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
                throw new Error(String(detail));
            }
            showToast(t('automations.created'), 'success');
        }
        await loadAutomations();
    }
    catch (e) {
        const msg = (e && errMsg(e)) ? errMsg(e) : (t('automations.save_error'));
        showToast(msg, 'error');
    }
}
export async function toggleAutomationDefinition(automationId, enabled, revision) {
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(automationId)}/${enabled ? 'disable' : 'enable'}`, {
            method: 'POST',
            body: { expected_revision: Number(revision || 1) },
        });
        if (!res.ok)
            throw new Error();
        showToast(enabled ? (t('automations.disabled')) : (t('automations.enabled')), 'success');
        if (automationState.editorId === automationId) {
            const infoEl = document.getElementById('automation-editor-info');
            if (infoEl)
                infoEl.textContent = enabled ? (t('automations.disabled_badge')) : (t('automations.enabled_badge'));
        }
        await loadAutomations();
    }
    catch (e) {
        showToast(t('automations.toggle_error'), 'error');
    }
}
export async function runAutomationDefinition(automationId) {
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(automationId)}/run`, { method: 'POST' });
        if (!res.ok)
            throw new Error();
        showToast(t('automations.ran'), 'success');
        if (automationState.editorId === automationId)
            await loadAutomationEditorHistory(automationId);
        await refreshAutomationStatuses();
    }
    catch (e) {
        showToast(t('automations.run_error'), 'error');
    }
}
export async function testAutomationEditor() {
    // Dry-run the currently-open automation. Requires the automation to
    // already be saved (we need an id on the server to walk).
    const editorId = editorAutomationId();
    if (!editorId) {
        showToast(t('automations.test_save_first'), 'warning');
        return;
    }
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(editorId)}/test`, { method: 'POST' });
        if (!res.ok)
            throw new Error();
        const data = await res.json();
        const result = data.result || {};
        _renderAutomationDryRunTrace(result);
        const status = result.status || 'unknown';
        const tone = status === 'ok' ? 'success' : status === 'skipped' ? 'warning' : 'error';
        showToast(`${t('automations.test_done')}: ${status}`, tone);
    }
    catch (e) {
        showToast(t('automations.test_error'), 'error');
    }
}
function _pathDepth(path) {
    // Path depth = number of `[` chars (each array index = one nesting level).
    // E.g. "action[2]" = 1, "action[2].choices[0].actions[1]" = 3.
    if (!path)
        return 0;
    return (path.match(/\[/g) || []).length;
}
function _pathLeaf(path) {
    // Last segment, e.g. "action[2].choices[0].actions[1]" -> "actions[1]".
    if (!path)
        return '';
    const parts = path.split('.');
    return parts[parts.length - 1] || path;
}
function _renderAutomationDryRunTrace(result) {
    // Render the trace as an indented tree so branching `choose` actions
    // (and nested `repeat` blocks) are visually obvious. Nesting is
    // derived from the step's `path` (each `[...]` segment adds a level).
    const listEl = document.getElementById('automation-editor-history-list');
    const emptyEl = document.getElementById('automation-editor-history-empty');
    if (!listEl)
        return;
    const trace = (result.trace || { steps: [] });
    const steps = Array.isArray(trace.steps) ? trace.steps : [];
    const headerLabel = t('automations.test_header');
    const statusLabel = String(result.status || 'unknown').toUpperCase();
    const statusColor = result.status === 'ok' ? 'text-emerald-300'
        : result.status === 'skipped' ? 'text-amber-300' : 'text-red-300';
    const stepsHtml = steps.length === 0
        ? `<p class="text-[11px] text-slate-500">${escapeHtml(t('automations.test_no_steps'))}</p>`
        : steps.map((s) => {
            const tone = s.status === 'ok' ? 'text-emerald-300'
                : s.status === 'dry_run' ? 'text-sky-300'
                    : s.status === 'skipped' ? 'text-amber-300'
                        : s.status === 'error' ? 'text-red-300' : 'text-slate-400';
            const dotTone = s.status === 'ok' ? 'bg-emerald-400'
                : s.status === 'dry_run' ? 'bg-sky-400'
                    : s.status === 'skipped' ? 'bg-amber-400'
                        : s.status === 'error' ? 'bg-red-400' : 'bg-slate-500';
            const depth = _pathDepth(String(s.path || ''));
            const leaf = _pathLeaf(String(s.path || ''));
            const ms = (s.ts_offset_ms != null) ? `+${Math.round(Number(s.ts_offset_ms))}ms` : '';
            const dur = (s.duration_ms != null) ? ` · ${Math.round(Number(s.duration_ms))}ms` : '';
            const indentStyle = `padding-left: ${depth * 14}px;`;
            const branchHint = depth > 0
                ? `<span class="text-slate-700 font-mono mr-1">${'│ '.repeat(Math.max(0, depth - 1))}└─</span>`
                : '';
            return `<div class="text-[11px] flex gap-2 items-baseline border-l border-white/5" style="${indentStyle}">
                <span class="inline-block w-1.5 h-1.5 rounded-full ${dotTone} flex-none mt-1"></span>
                <span class="text-slate-600 font-mono text-[10px] flex-none">${escapeHtml(ms)}${escapeHtml(dur)}</span>
                <span class="${tone} font-bold uppercase text-[10px] flex-none">${escapeHtml(String(s.status || '?'))}</span>
                <span class="text-slate-400 font-mono text-[10px] flex-none">${branchHint}${escapeHtml(leaf)}</span>
                <span class="text-slate-300 flex-1">${escapeHtml(String(s.message || s.error || ''))}</span>
            </div>`;
        }).join('');
    listEl.innerHTML = `
        <div class="rounded-lg bg-white/5 border border-white/10 p-3 space-y-2">
            <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-200"><i class="fas fa-flask text-emerald-400 mr-1"></i>${escapeHtml(headerLabel)}</span>
                <span class="text-[10px] font-bold ${statusColor}">${escapeHtml(statusLabel)}</span>
            </div>
            <div class="space-y-0.5">${stepsHtml}</div>
        </div>`;
    listEl.classList.remove('hidden');
    if (emptyEl)
        emptyEl.classList.add('hidden');
}
function _renderAutomationLintWarnings(warnings) {
    // Render non-fatal lint warnings into the validation panel as a sub-list.
    // Each warning has {code, severity, message, path}. severity ∈ info|warning.
    const validateEl = document.getElementById('automation-editor-validation');
    if (!validateEl)
        return;
    let panel = document.getElementById('automation-editor-warnings');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'automation-editor-warnings';
        panel.className = 'mt-2 space-y-1';
        validateEl.insertAdjacentElement('afterend', panel);
    }
    if (!warnings || warnings.length === 0) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = warnings.map((w) => {
        const tone = String(w.severity) === 'warning'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-sky-500/30 bg-sky-500/10 text-sky-200';
        const icon = String(w.severity) === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info';
        return `<div class="rounded-lg border ${tone} px-3 py-2 text-[11px] flex items-start gap-2">
            <i class="fas ${icon} mt-0.5"></i>
            <div class="flex-1">
                <div>${escapeHtml(String(w.message || ''))}</div>
                <div class="text-[10px] opacity-70 mt-0.5"><span class="font-mono">${escapeHtml(String(w.path || ''))}</span> · <span class="uppercase">${escapeHtml(String(w.code || ''))}</span></div>
            </div>
        </div>`;
    }).join('');
}
export function exportAutomationYaml() {
    // Download the current editor YAML as a .yaml file. Filename is derived
    // from the automation id (or "automation" if unsaved).
    const yaml = getCodeEditorValue('automation-editor-yaml') || '';
    if (!yaml.trim()) {
        showToast(t('automations.export_empty'), 'warning');
        return;
    }
    const baseName = (automationState.editorId || 'automation').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.yaml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('automations.export_done'), 'success');
}
export function importAutomationYaml() {
    // Open the hidden <input type="file"> and load its contents into the
    // editor. Does NOT save — the user still has to hit Save.
    const input = document.getElementById('automation-yaml-import-input');
    if (!input)
        return;
    input.value = '';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file)
            return;
        try {
            const text = await file.text();
            if (!text.trim()) {
                showToast(t('automations.import_empty'), 'warning');
                return;
            }
            setCodeEditorValue('automation-editor-yaml', text);
            refreshCodeEditor('automation-editor-yaml');
            showToast(t('automations.import_done', { name: file.name }), 'success');
        }
        catch (e) {
            showToast(t('automations.import_error'), 'error');
        }
    };
    input.click();
}
export async function refreshAutomationEntityOptions() {
    const selects = document.querySelectorAll('[data-automation-entity-select]');
    if (!selects.length)
        return;
    try {
        const res = await apiCall('/api/integrations/all-entities');
        const data = await res.json();
        const entities = Array.isArray(data.entities) ? data.entities : [];
        selects.forEach(sel => {
            const select = sel;
            const current = select.value;
            select.innerHTML = `<option value="">${t('automations.entity_placeholder')}</option>` +
                entities.map((e) => `<option value="${escapeHtml(e.entity_id)}"${e.entity_id === current ? ' selected' : ''}>${escapeHtml(e.entity_id)}${e.friendly_name ? ' — ' + escapeHtml(e.friendly_name) : ''}</option>`).join('');
        });
    }
    catch (_) { }
}
