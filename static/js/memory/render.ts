/**
 * Memory UI — table render helpers.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
import type { MemoryLogEvent } from '../types/memory.js';
import { MEM_LOG_PAGE_SIZE, MEM_PER_PAGE, memoryState } from './state.js';

export function renderMemoryEventsTable(events: MemoryLogEvent[]) {
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
        <tr id="${detailsId}" class="hidden bg-white/[0.02] border-b border-theme-subtle"><td colspan="4" class="p-3"><pre class="text-[10px] mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">${escapeHtml(detailsJson)}</pre></td></tr>`;
    }).join('');
}

export function updateMemLogPagination() {
    const from = memoryState.logTotal === 0 ? 0 : memoryState.logOffset + 1;
    const to = Math.min(memoryState.logOffset + MEM_LOG_PAGE_SIZE, memoryState.logTotal);
    const rangeEl = document.getElementById('mem-log-range');
    const prevBtn = document.getElementById('mem-log-prev') as HTMLButtonElement | null;
    const nextBtn = document.getElementById('mem-log-next') as HTMLButtonElement | null;
    if (rangeEl) rangeEl.textContent = memoryState.logTotal === 0 ? '' : `${from}–${to} of ${memoryState.logTotal}`;
    if (prevBtn) prevBtn.disabled = memoryState.logOffset <= 0;
    if (nextBtn) nextBtn.disabled = memoryState.logOffset + MEM_LOG_PAGE_SIZE >= memoryState.logTotal;
}
export function formatLearnedTime(ts: number | string | undefined) {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return (t('intelligence.updated_just_now'));
    if (diff < 3600000) return (t('intelligence.updated_minutes_ago')).replace('{n}', String(Math.floor(diff / 60000)));
    if (diff < 86400000) return (t('intelligence.updated_hours_ago')).replace('{n}', String(Math.floor(diff / 3600000)));
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatMemoryDate(ts: number | string | undefined) {
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

export function renderMemoryTable() {
    const container = document.getElementById('mem-container');
    const empty = document.getElementById('mem-empty');
    if (!container) return;

    const searchEl = document.getElementById('mem-search') as HTMLInputElement | null;
    const term = searchEl?.value.toLowerCase() || '';
    const filtered = memoryState.cache.filter(m => m.document.toLowerCase().includes(term));

    if (!memoryState.cache.length) {
        container.innerHTML = '';
        if (empty) {
            empty.classList.remove('hidden');
            empty.innerHTML = `<i class="fas fa-brain hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('config.hub_memories_desc'))}</p>`;
        }
        return;
    }

    if (!filtered.length) {
        container.innerHTML = '';
        if (empty) empty.classList.add('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');

    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    if (memoryState.page > maxPage) memoryState.page = maxPage;
    const slice = filtered.slice((memoryState.page - 1) * MEM_PER_PAGE, memoryState.page * MEM_PER_PAGE);
    const pageInfoEl = document.getElementById('mem-page-info');
    if (pageInfoEl) {
        if (maxPage > 1) {
            pageInfoEl.classList.remove('hidden');
            pageInfoEl.textContent = `${t('memory.page_info', { page: memoryState.page })} / ${maxPage}`;
        } else {
            pageInfoEl.classList.add('hidden');
        }
    }
    const memPrev = document.getElementById('mem-prev') as HTMLButtonElement | null;
    const memNext = document.getElementById('mem-next') as HTMLButtonElement | null;
    if (memPrev) memPrev.disabled = memoryState.page <= 1;
    if (memNext) memNext.disabled = memoryState.page >= maxPage;

    container.innerHTML = slice.map(m => {
        const ts = m.timestamp ?? m.metadata?.timestamp ?? 0;
        const fd = formatMemoryDate(ts);
        const dateLine = fd.dateTime !== '—' ? fd.age : t('memory.no_date');
        const id = escapeHtml(m.id);
        const doc = escapeHtml(m.document);
        return `
        <article class="hyd-entity-row hyd-entity-row--static" role="listitem">
            <label class="flex items-center shrink-0 cursor-pointer" title="${escapeHtml(t('memory.select_all'))}">
                <input type="checkbox" class="mem-bulk-check accent-accent w-3.5 h-3.5 rounded border-theme-subtle bg-white/5" value="${id}" data-memory-input="updateMemBulkCount">
            </label>
            <span class="hyd-icon hyd-icon--list"><i class="fas fa-brain" aria-hidden="true"></i></span>
            <div class="hyd-entity-row__body min-w-0">
                <div class="hyd-entity-row__name line-clamp-2" title="${doc}">${doc}</div>
                <div class="hyd-entity-row__sub">${escapeHtml(dateLine)}</div>
            </div>
            <div class="hyd-row-actions" role="group">
                <button type="button" data-memory-action="deleteMemRow" data-memory-mem-id="${id}" class="hyd-row-actions__btn hyd-row-actions__btn--danger" title="${escapeHtml(t('common.delete'))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
            </div>
        </article>`;
    }).join('');
}
