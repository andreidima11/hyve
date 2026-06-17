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
import { loadMemoryEvents } from './log.js';

export async function loadMemory() {
    const res = await apiCall('/api/memory');
    if (!res.ok) { memoryState.cache.length = 0; render.renderMemoryTable(); return; }
    memoryState.cache.splice(0, memoryState.cache.length, ...(await res.json() as MemoryFact[]));
    render.renderMemoryTable();
    loadMemoryEvents(0);
}

export function toggleAllMem(checked: boolean) {
    document.querySelectorAll('.mem-bulk-check').forEach(cb => { (cb as HTMLInputElement).checked = checked; });
    updateMemBulkCount();
}

export function updateMemBulkCount() {
    const count = document.querySelectorAll('.mem-bulk-check:checked').length;
    const btn = document.getElementById('mem-bulk-delete-btn');
    if (btn) btn.classList.toggle('hidden', count === 0);
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
    const filtered = memoryState.cache.filter(m => m.document.toLowerCase().includes(term));
    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    memoryState.page = Math.max(1, Math.min(memoryState.page + step, maxPage));
    render.renderMemoryTable();
}

export function filterMemory() { memoryState.page = 1; render.renderMemoryTable(); }

export async function updateMemory(id: string, text: string) {
    if (!text.trim()) return;
    await apiCall(`/api/memory/${id}`, { method: 'PUT', body: { text } });
}


export { renderMemoryTable } from './render.js';
