/**
 * Admin — user management.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm } from '../utils.js';
import type { AdminUser } from './types.js';

export async function loadAdminUsers() {
    const listEl = document.getElementById('admin-users-list');
    const emptyEl = document.getElementById('admin-users-empty');
    if (!listEl) return;
    try {
        const res = await apiCall('/api/users');
        if (!res.ok) {
            listEl.innerHTML = '';
            if (emptyEl) {
                emptyEl.classList.remove('hidden');
                emptyEl.innerHTML = `<i class="fas fa-circle-exclamation hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('admin.error_list'))}</p>`;
            }
            return;
        }
        const users = await res.json() as AdminUser[];
        if (!users.length) {
            listEl.innerHTML = '';
            if (emptyEl) {
                emptyEl.classList.remove('hidden');
                emptyEl.innerHTML = `<i class="fas fa-users hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('admin.no_users'))}</p>`;
            }
            return;
        }
        if (emptyEl) emptyEl.classList.add('hidden');
        listEl.innerHTML = users.map(u => {
            const displayName = escapeHtml(u.full_name || u.username || '');
            const userName = escapeHtml(u.username || '');
            const phones = u.phones || [];
            const phonesStr = phones.length ? escapeHtml(phones.join(', ')) : '—';
            const userId = parseInt(String(u.id), 10) || 0;
            return `
            <article class="hyd-entity-row hyd-entity-row--static" role="listitem">
                <span class="hyd-icon hyd-icon--list"><i class="fas fa-user" aria-hidden="true"></i></span>
                <div class="hyd-entity-row__body min-w-0">
                    <div class="hyd-entity-row__name">${displayName}</div>
                    <div class="hyd-entity-row__sub">${userName}${u.is_admin ? ' • Admin' : ''}</div>
                    <div class="hyd-entity-row__sub">${escapeHtml(t('admin.phones'))}: ${phonesStr}</div>
                </div>
                <div class="hyd-row-actions" role="group">
                    <button type="button" data-config-action="deleteUser" data-config-user-id="${userId}" class="hyd-row-actions__btn hyd-row-actions__btn--danger" title="${escapeHtml(t('admin.delete_user'))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
                </div>
            </article>`;
        }).join('');
    } catch (_) {
        listEl.innerHTML = '';
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.innerHTML = `<i class="fas fa-circle-exclamation hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('admin.error_list'))}</p>`;
        }
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
