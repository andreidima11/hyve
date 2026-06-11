/**
 * Memory UI — load, log, extraction examples, bulk actions.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showConfirm } from '../utils.js';
import { MEM_PER_PAGE, memoryState } from './state.js';
import * as render from './render.js';
import { loadMemoryEvents } from './log.js';
export async function loadMemory() {
    const res = await apiCall('/api/memory');
    if (!res.ok) {
        memoryState.cache.length = 0;
        render.renderMemoryTable();
        return;
    }
    memoryState.cache.splice(0, memoryState.cache.length, ...await res.json());
    render.renderMemoryTable();
    loadMemoryEvents(0);
}
export function toggleAllMem(checked) {
    document.querySelectorAll('.mem-bulk-check').forEach(cb => { cb.checked = checked; });
    updateMemBulkCount();
}
export function updateMemBulkCount() {
    const count = document.querySelectorAll('.mem-bulk-check:checked').length;
    const btn = document.getElementById('mem-bulk-delete-btn');
    if (btn)
        btn.style.display = count > 0 ? 'block' : 'none';
}
export async function deleteMemBulk(ids) {
    const targetIds = ids || Array.from(document.querySelectorAll('.mem-bulk-check:checked')).map(i => i.value);
    if (!(await showConfirm(t('memory.delete_confirm'))))
        return;
    await apiCall('/api/memory/bulk_delete', { method: 'POST', body: { ids: targetIds } });
    loadMemory();
}
export function changeMemPage(step) {
    const searchEl = document.getElementById("mem-search");
    const term = searchEl?.value.toLowerCase() || '';
    const filtered = memoryState.cache.filter(m => m.document.toLowerCase().includes(term));
    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    memoryState.page = Math.max(1, Math.min(memoryState.page + step, maxPage));
    render.renderMemoryTable();
}
export function filterMemory() { memoryState.page = 1; render.renderMemoryTable(); }
export async function updateMemory(id, text) {
    if (!text.trim())
        return;
    await apiCall(`/api/memory/${id}`, { method: 'PUT', body: { text } });
}
export { renderMemoryTable } from './render.js';
