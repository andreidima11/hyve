/**
 * Admin — user management.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { isAdmin } from '../user_context.js';
import { escapeHtml, showToast, showConfirm, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from '../utils.js';
import type { AdminUser } from './types.js';

export async function loadAdminUsers() {
    const listEl = document.getElementById('admin-users-list');
    if (!listEl) return;
    try {
        const res = await apiCall('/api/users');
        if (!res.ok) {
            listEl.innerHTML = `<p class="text-red-400 text-sm">${t('admin.error_list')}</p>`;
            return;
        }
        const users = await res.json() as AdminUser[];
        if (!users.length) {
            listEl.innerHTML = `<p class="text-slate-500 text-sm">${t('admin.no_users')}</p>`;
            return;
        }
        listEl.innerHTML = users.map(u => {
            const displayName = escapeHtml(u.full_name || u.username || '');
            const userName = escapeHtml(u.username || '');
            const phones = u.phones || [];
            const phonesStr = phones.length ? escapeHtml(phones.join(', ')) : '—';
            return `
            <div class="flex items-center justify-between gap-4 p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:border-white/10 transition-colors">
                <div class="min-w-0">
                    <div class="font-semibold text-white truncate">${displayName}</div>
                    <div class="text-[11px] text-slate-500 mono">${userName}${u.is_admin ? ' • Admin' : ''}</div>
                    <div class="text-[11px] text-slate-400 mt-1" data-i18n="admin.phones">${t('admin.phones')}: ${phonesStr}</div>
                </div>
                <button type="button" data-config-action="deleteUser" data-config-user-id="${parseInt(String(u.id), 10) || 0}" class="flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] text-red-400 hover:bg-red-500/20 border border-red-500/30 transition-colors" data-i18n="admin.delete_user">${t('admin.delete_user')}</button>
            </div>`;
        }).join('');
    } catch (_) {
        listEl.innerHTML = `<p class="text-red-400 text-sm">${t('admin.error_list')}</p>`;
    }
}

export async function createUser(username: string, password: string, fullName: string) {
    const res = await apiCall('/api/users/register', {
        method: 'POST',
        body: { username, password, full_name: fullName || username, is_admin: false }
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: string };
        throw new Error(err.detail || t('admin.error_create'));
    }
    return res.json();
}

export async function deleteUser(userId: number | string) {
    if (!(await showConfirm(t('admin.delete_user_confirm')))) return;
    try {
        const res = await apiCall(`/api/users/${userId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        await loadAdminUsers();
    } catch (_) {
        showToast(t('admin.error_delete'), 'error');
    }
}
