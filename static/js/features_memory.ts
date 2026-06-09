import { apiCall } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, showToast, showConfirm } from './utils.js';
import type {
    MemoryConsolidationResult,
    MemoryEventsResponse,
    MemoryExtractionExample,
    MemoryFact,
    MemoryLogEvent,
} from './types/memory.js';

export let memCache: MemoryFact[] = [];
export let memPage = 1;

const MEM_LOG_PAGE_SIZE = 12;
let memLogOffset = 0;
let memLogTotal = 0;

export async function loadMemory() {
    const res = await apiCall('/api/memory');
    if (!res.ok) { memCache = []; renderMemoryTable(); return; }
    memCache = await res.json() as MemoryFact[];
    renderMemoryTable();
    loadMemoryEvents(0);
}

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
        memLogTotal = data.total ?? 0;
        memLogOffset = offset;
        renderMemoryEventsTable(events);
        updateMemLogPagination();
    } catch (_) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-red-400">' + (t('memory.log_error')) + '</td></tr>';
    }
}

function renderMemoryEventsTable(events: MemoryLogEvent[]) {
    const tbody = document.getElementById('mem-log-tbody');
    if (!tbody) return;
    if (!events.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-500">' + (t('memory.log_empty')) + '</td></tr>';
        return;
    }
    tbody.innerHTML = events.map((ev, i) => {
        const ts = ev.ts ? new Date((typeof ev.ts === 'number' && ev.ts < 1e12 ? ev.ts * 1000 : ev.ts)).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
        const typeClass = ev.event_type && ev.event_type.startsWith('consolidation') ? 'text-amber-400/90' : (ev.event_type === 'fact_deleted' ? 'text-red-400/90' : 'text-slate-400');
        const detailsJson = ev.details && typeof ev.details === 'object' ? JSON.stringify(ev.details) : (ev.details ? String(ev.details) : '');
        const hasDetails = !!detailsJson;
        const rowId = `mem-log-row-${i}`;
        const detailsId = `mem-log-details-${i}`;
        return `<tr class="hover:bg-white/[0.02]" id="${rowId}">
            <td class="p-3 mono text-[11px] text-slate-500">${escapeHtml(ts)}</td>
            <td class="p-3"><span class="text-[11px] font-medium ${typeClass}">${escapeHtml(ev.event_type || '—')}</span></td>
            <td class="p-3 text-slate-300 max-w-md truncate" title="${escapeHtml(ev.summary || '')}">${escapeHtml(ev.summary || '—')}</td>
            <td class="p-3 text-center">${hasDetails ? `<button type="button" data-memory-action="toggleMemLogDetails" data-memory-details-id="${detailsId}" class="text-accent hover:underline text-[10px]">${t('memory.log_details')}</button>` : '—'}
            </td>
        </tr>
        <tr id="${detailsId}" class="hidden bg-white/[0.02] border-b border-white/5"><td colspan="4" class="p-3"><pre class="text-[10px] mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">${escapeHtml(detailsJson)}</pre></td></tr>`;
    }).join('');
}

function updateMemLogPagination() {
    const from = memLogTotal === 0 ? 0 : memLogOffset + 1;
    const to = Math.min(memLogOffset + MEM_LOG_PAGE_SIZE, memLogTotal);
    const rangeEl = document.getElementById('mem-log-range');
    const prevBtn = document.getElementById('mem-log-prev') as HTMLButtonElement | null;
    const nextBtn = document.getElementById('mem-log-next') as HTMLButtonElement | null;
    if (rangeEl) rangeEl.textContent = memLogTotal === 0 ? '' : `${from}–${to} of ${memLogTotal}`;
    if (prevBtn) prevBtn.disabled = memLogOffset <= 0;
    if (nextBtn) nextBtn.disabled = memLogOffset + MEM_LOG_PAGE_SIZE >= memLogTotal;
}

export function memLogPrevPage() {
    if (memLogOffset <= 0) return;
    loadMemoryEvents(Math.max(0, memLogOffset - MEM_LOG_PAGE_SIZE));
}

export function memLogNextPage() {
    if (memLogOffset + MEM_LOG_PAGE_SIZE >= memLogTotal) return;
    loadMemoryEvents(memLogOffset + MEM_LOG_PAGE_SIZE);
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

let _extractionExamples: MemoryExtractionExample[] = [];

export function getExtractionExamples() { return _extractionExamples; }

export function renderExtractionExamples(examples: MemoryExtractionExample[] | unknown) {
    _extractionExamples = Array.isArray(examples) ? examples as MemoryExtractionExample[] : [];
    const container = document.getElementById('extraction-examples-list');
    if (!container) return;
    container.innerHTML = '';
    _extractionExamples.forEach((ex, i) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col sm:flex-row gap-2 items-start group';
        row.innerHTML = `
            <div class="flex-1 min-w-0 space-y-1 w-full">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Input</label>
                <input type="text" data-ex-idx="${i}" data-ex-field="input"
                    class="extraction-ex-input w-full bg-slate-900 border border-white/5 rounded-xl p-2.5 text-xs mono text-slate-300 focus:border-accent outline-none"
                    value="${(ex.input || '').replace(/"/g, '&quot;')}" placeholder="e.g. mi-e pofta de paste">
            </div>
            <div class="flex-1 min-w-0 space-y-1 w-full">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Output facts (comma-separated)</label>
                <input type="text" data-ex-idx="${i}" data-ex-field="output"
                    class="extraction-ex-output w-full bg-slate-900 border border-white/5 rounded-xl p-2.5 text-xs mono text-slate-300 focus:border-accent outline-none"
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
                _extractionExamples[idx].input = el.value;
            } else if (field === 'output') {
                _extractionExamples[idx].output = el.value.split(',').map(s => s.trim()).filter(Boolean);
            }
        });
    });
}

export function addExtractionExample() {
    _extractionExamples.push({ input: '', output: [] });
    renderExtractionExamples(_extractionExamples);
    const container = document.getElementById('extraction-examples-list');
    if (container) {
        const inputs = container.querySelectorAll('.extraction-ex-input');
        const last = inputs[inputs.length - 1] as HTMLInputElement | undefined;
        if (last) last.focus();
    }
}

export function removeExtractionExample(idx: number) {
    _extractionExamples.splice(idx, 1);
    renderExtractionExamples(_extractionExamples);
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
    dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
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

let _memLogTypeDropdownBound = false;

if (typeof document !== 'undefined' && !_memLogTypeDropdownBound) {
    _memLogTypeDropdownBound = true;
    document.addEventListener('click', e => {
        const dd = document.getElementById('mem_log_type_dropdown');
        if (!dd) return;
        const target = e.target;
        if (!(target instanceof Element)) return;
        const toggleBtn = target.closest('[data-action="toggle-mem-log-type"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = target.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            setMemLogType((opt as HTMLElement).dataset.value || '', (opt.textContent || '').trim());
            return;
        }
        if (dd.dataset.open === 'true' && !dd.contains(target)) {
            dd.dataset.open = 'false';
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
            btn.classList.toggle('border-white/10', !active);
        }
    });
    if (tab === 'log') {
        loadMemoryEvents(0);
    }
}

function formatLearnedTime(ts: number | string | undefined) {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return (t('intelligence.updated_just_now'));
    if (diff < 3600000) return (t('intelligence.updated_minutes_ago')).replace('{n}', String(Math.floor(diff / 60000)));
    if (diff < 86400000) return (t('intelligence.updated_hours_ago')).replace('{n}', String(Math.floor(diff / 3600000)));
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatMemoryDate(ts: number | string | undefined) {
    if (!ts) return { dateTime: '—', age: '—' };
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    const dateStr = d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const now = Date.now();
    const diff = now - d.getTime();
    const days = Math.floor(diff / 86400000);
    let age = '';
    if (days === 0) age = formatLearnedTime(ts);
    else if (days === 1) age = t('memory.saved_1_day_ago');
    else if (days < 30) age = (t('memory.saved_days_ago')).replace('{n}', String(days));
    else age = (t('memory.saved_old'));
    return { dateTime: `${dateStr}, ${timeStr}`, age };
}

const MEM_PER_PAGE = 12;

export function renderMemoryTable() {
    const container = document.getElementById("mem-container");
    if (!container) return;
    const searchEl = document.getElementById("mem-search") as HTMLInputElement | null;
    const term = searchEl?.value.toLowerCase() || '';
    const filtered = memCache.filter(m => m.document.toLowerCase().includes(term));
    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    if (memPage > maxPage) memPage = maxPage;
    const slice = filtered.slice((memPage - 1) * MEM_PER_PAGE, memPage * MEM_PER_PAGE);
    const pageInfoEl = document.getElementById('mem-page-info');
    if (pageInfoEl) {
        if (maxPage > 1) {
            pageInfoEl.classList.remove('hidden');
            pageInfoEl.textContent = `${t('memory.page_info', { page: memPage })} / ${maxPage}`;
        } else {
            pageInfoEl.classList.add('hidden');
        }
    }
    const memPrev = document.getElementById('mem-prev') as HTMLButtonElement | null;
    const memNext = document.getElementById('mem-next') as HTMLButtonElement | null;
    if (memPrev) memPrev.disabled = memPage <= 1;
    if (memNext) memNext.disabled = memPage >= maxPage;
    container.innerHTML = slice.map(m => {
        const ts = m.timestamp ?? m.metadata?.timestamp ?? 0;
        const fd = formatMemoryDate(ts);
        const dateLine = fd.dateTime !== '—' ? `${fd.age}` : (t('memory.no_date'));
        return `
        <div class="mem-card group relative rounded-xl border border-white/5 bg-white/[0.02] hover:border-accent/20 hover:bg-white/[0.04] transition-all overflow-hidden">
            <div class="absolute top-0 left-0 w-0.5 h-full bg-accent/40 group-hover:bg-accent transition-colors"></div>
            <div class="flex items-start gap-2.5 p-3 pl-3.5">
                <input type="checkbox" class="mem-bulk-check accent-accent mt-0.5 w-3.5 h-3.5 rounded border-white/10 bg-white/5 flex-shrink-0" value="${escapeHtml(m.id)}" data-memory-input="updateMemBulkCount">
                <div class="flex-1 min-w-0">
                    <p class="text-[12px] text-slate-200 leading-relaxed line-clamp-3" title="${escapeHtml(m.document)}">${escapeHtml(m.document)}</p>
                    <p class="text-[10px] text-slate-500 mt-1.5 flex items-center gap-1"><i class="far fa-clock text-[8px]"></i>${escapeHtml(dateLine)}</p>
                </div>
                <button type="button" data-memory-action="deleteMemRow" data-memory-mem-id="${escapeHtml(m.id)}" class="flex-shrink-0 w-7 h-7 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100" title="Delete"><i class="fas fa-trash-alt text-[10px]"></i></button>
            </div>
        </div>`;
    }).join('');
}

export function toggleAllMem(checked: boolean) {
    document.querySelectorAll('.mem-bulk-check').forEach(cb => { (cb as HTMLInputElement).checked = checked; });
    updateMemBulkCount();
}

export function updateMemBulkCount() {
    const count = document.querySelectorAll('.mem-bulk-check:checked').length;
    const btn = document.getElementById('mem-bulk-delete-btn');
    if (btn) btn.style.display = count > 0 ? 'block' : 'none';
}

export async function deleteMemBulk(ids?: string[]) {
    const targetIds = ids || Array.from(document.querySelectorAll('.mem-bulk-check:checked')).map(i => (i as HTMLInputElement).value);
    if (!(await showConfirm(t('memory.delete_confirm')))) return;
    await apiCall('/api/memory/bulk_delete', { method: 'POST', body: { ids: targetIds } });
    loadMemory();
}

export function changeMemPage(step: number) {
    const searchEl = document.getElementById("mem-search") as HTMLInputElement | null;
    const term = searchEl?.value.toLowerCase() || '';
    const filtered = memCache.filter(m => m.document.toLowerCase().includes(term));
    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    memPage = Math.max(1, Math.min(memPage + step, maxPage));
    renderMemoryTable();
}

export function filterMemory() { memPage = 1; renderMemoryTable(); }

export async function updateMemory(id: string, text: string) {
    if (!text.trim()) return;
    await apiCall(`/api/memory/${id}`, { method: 'PUT', body: { text } });
}
