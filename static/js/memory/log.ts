/**
 * Memory UI — load, log, extraction examples, bulk actions.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm } from '../utils.js';

import type {
    MemoryConsolidationResult,
    MemoryEventsResponse,
    MemoryExtractionExample,
    MemoryFact,
    MemoryLogEvent,
} from '../types/memory.js';
import { MEM_LOG_PAGE_SIZE, MEM_PER_PAGE, memoryState, memoryUiState } from './state.js';
import * as render from './render.js';
export async function loadMemoryEvents(offset = 0) {
    const tbody = document.getElementById('mem-log-tbody');
    const filterEl = document.getElementById('mem-log-type-filter') as HTMLInputElement | null;
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-500">' + (t('memory.log_loading')) + '</td></tr>';
    const eventType = (filterEl && filterEl.value) || '';
    try {
        let url = `/api/memory/events?limit=${MEM_LOG_PAGE_SIZE}&offset=${offset}`;
        if (eventType) url += `&event_type=${encodeURIComponent(eventType)}`;
        const res = await apiCall(url);
        const data = await res.json() as MemoryEventsResponse;
        const events = data.events || [];
        memoryState.logTotal = data.total ?? 0;
        memoryState.logOffset = offset;
        render.renderMemoryEventsTable(events);
        render.updateMemLogPagination();
    } catch (_) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-red-400">' + (t('memory.log_error')) + '</td></tr>';
    }
}

export function memLogPrevPage() {
    if (memoryState.logOffset <= 0) return;
    loadMemoryEvents(Math.max(0, memoryState.logOffset - MEM_LOG_PAGE_SIZE));
}

export function memLogNextPage() {
    if (memoryState.logOffset + MEM_LOG_PAGE_SIZE >= memoryState.logTotal) return;
    loadMemoryEvents(memoryState.logOffset + MEM_LOG_PAGE_SIZE);
}

export function toggleMemLogDetails(detailsId: string) {
    const row = document.getElementById(detailsId);
    if (!row) return;
    row.classList.toggle('hidden');
}

export async function clearMemoryLog() {
    const confirmed = await showConfirm(t('memory.log_clear_confirm'));
    if (!confirmed) return;
    try {
        const res = await apiCall('/api/memory/clear_events', { method: 'POST' });
        const data = await res.json() as { error?: string };
        if (!res.ok) throw new Error(data.error || t('common.error'));
        showToast(t('memory.log_cleared'), 'success');
        loadMemoryEvents(0);
    } catch (e) {
        showToast((t('memory.log_clear_error')) + ': ' + (e instanceof Error ? e.message : String(e)), 'error');
    }
}

export async function runConsolidationNow() {
    const resultEl = document.getElementById('consolidation-run-result');
    if (resultEl) resultEl.textContent = t('memory.consolidation_running');
    try {
        const res = await apiCall('/api/memory/consolidation/run', { method: 'POST' });
        const data = await res.json() as { error?: string; result?: MemoryConsolidationResult };
        if (!res.ok) throw new Error(data.error || t('common.error'));
        const r = data.result || {};
        const msg = t('memory.consolidation_result', {
            merged: r.merged || 0,
            deleted: (r.deleted_ids || []).length,
        });
        if (resultEl) resultEl.textContent = msg;
        loadMemoryEvents(0);
    } catch (e) {
        if (resultEl) resultEl.textContent = (t('memory.consolidation_error')) + ': ' + (e instanceof Error ? e.message : String(e));
    }
}


export function getExtractionExamples() { return memoryState.extractionExamples; }

export function renderExtractionExamples(examples: MemoryExtractionExample[] | unknown) {
    memoryState.extractionExamples = Array.isArray(examples) ? examples as MemoryExtractionExample[] : [];
    const container = document.getElementById('extraction-examples-list');
    if (!container) return;
    container.innerHTML = '';
    memoryState.extractionExamples.forEach((ex, i) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col sm:flex-row gap-2 items-start group';
        row.innerHTML = `
            <div class="flex-1 min-w-0 space-y-1 w-full">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Input</label>
                <input type="text" data-ex-idx="${i}" data-ex-field="input"
                    class="extraction-ex-input w-full bg-slate-900 border border-theme-subtle rounded-xl p-2.5 text-xs mono text-slate-300 focus:border-accent outline-none"
                    value="${(ex.input || '').replace(/"/g, '&quot;')}" placeholder="e.g. mi-e pofta de paste">
            </div>
            <div class="flex-1 min-w-0 space-y-1 w-full">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Output facts (comma-separated)</label>
                <input type="text" data-ex-idx="${i}" data-ex-field="output"
                    class="extraction-ex-output w-full bg-slate-900 border border-theme-subtle rounded-xl p-2.5 text-xs mono text-slate-300 focus:border-accent outline-none"
                    value="${(Array.isArray(ex.output) ? ex.output.join(', ') : (ex.output || '')).replace(/"/g, '&quot;')}" placeholder="e.g. Is craving pasta">
            </div>
            <button type="button" data-memory-action="removeExtractionExample" data-memory-index="${i}"
                class="mt-5 sm:mt-5 px-2.5 py-2 rounded-lg text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors flex-shrink-0 touch-manipulation"
                title="Remove"><i class="fas fa-trash-can"></i></button>
        `;
        container.appendChild(row);
    });

    container.querySelectorAll('input[data-ex-idx]').forEach(inp => {
        inp.addEventListener('input', () => {
            const el = inp as HTMLInputElement;
            const idx = parseInt(el.dataset.exIdx || '', 10);
            const field = el.dataset.exField;
            if (field === 'input') {
                memoryState.extractionExamples[idx].input = el.value;
            } else if (field === 'output') {
                memoryState.extractionExamples[idx].output = el.value.split(',').map(s => s.trim()).filter(Boolean);
            }
        });
    });
}

export function addExtractionExample() {
    memoryState.extractionExamples.push({ input: '', output: [] });
    renderExtractionExamples(memoryState.extractionExamples);
    const container = document.getElementById('extraction-examples-list');
    if (container) {
        const inputs = container.querySelectorAll('.extraction-ex-input');
        const last = inputs[inputs.length - 1] as HTMLInputElement | undefined;
        if (last) last.focus();
    }
}

export function removeExtractionExample(idx: number) {
    memoryState.extractionExamples.splice(idx, 1);
    renderExtractionExamples(memoryState.extractionExamples);
}
export function loadReminders() {}
export function deleteReminder() {}
export function openMementoEdit() {}
export function closeMementoEdit() {}
export async function saveMementoEdit() {}
export function updateMementoBulkCount() {}
export function toggleAllMemento() {}
export async function deleteMementoBulk() {}
export function toggleMemLogTypeDropdown() {
    const dd = document.getElementById('mem_log_type_dropdown');
    if (!dd) return;
    dd.querySelector<HTMLButtonElement>('.dashboard-custom-select__button')?.click();
}

export function setMemLogType(value: string, label: string) {
    const dd = document.getElementById('mem_log_type_dropdown');
    const hidden = document.getElementById('mem-log-type-filter') as HTMLInputElement | null;
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl) valueEl.textContent = label || value || (t('memory.log_type_all'));
        dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
            (o as HTMLElement).dataset.selected = (o as HTMLElement).dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden) hidden.value = value;
    loadMemoryEvents(0);
}

if (typeof document !== 'undefined' && !memoryUiState.memLogTypeFilterBound) {
    memoryUiState.memLogTypeFilterBound = true;
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (target instanceof HTMLInputElement && target.id === 'mem-log-type-filter') {
            loadMemoryEvents(0);
        }
    });
}
export function switchMemorySubtab(tab: string) {
    const panels = ['memories', 'log'];
    panels.forEach(id => {
        const panel = document.getElementById(`mem-panel-${id}`);
        const btn = document.getElementById(`mem-subtab-${id}`);
        const active = id === tab;
        if (panel) panel.classList.toggle('hidden', !active);
        if (btn) {
            btn.classList.toggle('bg-accent/20', active);
            btn.classList.toggle('text-accent', active);
            btn.classList.toggle('border-accent/40', active);
            btn.classList.toggle('bg-white/5', !active);
            btn.classList.toggle('text-slate-400', !active);
            btn.classList.toggle('border-theme-subtle', !active);
        }
    });
    if (tab === 'log') {
        loadMemoryEvents(0);
    }
}
