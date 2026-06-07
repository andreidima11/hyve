import { apiCall } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, showToast, showConfirm, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from './utils.js';

// --- ADMIN (gestionare utilizatori) ---
export async function loadAdminUsers() {
    const listEl = document.getElementById('admin-users-list');
    if (!listEl) return;
    try {
        const res = await apiCall('/api/users');
        if (!res.ok) {
            listEl.innerHTML = `<p class="text-red-400 text-sm">${t('admin.error_list')}</p>`;
            return;
        }
        const users = await res.json();
        if (!users.length) {
            listEl.innerHTML = `<p class="text-slate-500 text-sm">${t('admin.no_users')}</p>`;
            return;
        }
        listEl.innerHTML = users.map(u => {
            const displayName = escapeHtml(u.full_name || u.username);
            const userName = escapeHtml(u.username);
            const phonesStr = (u.phones || []).length ? escapeHtml(u.phones.join(', ')) : '—';
            return `
            <div class="flex items-center justify-between gap-4 p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:border-white/10 transition-colors">
                <div class="min-w-0">
                    <div class="font-semibold text-white truncate">${displayName}</div>
                    <div class="text-[11px] text-slate-500 mono">${userName}${u.is_admin ? ' • Admin' : ''}</div>
                    <div class="text-[11px] text-slate-400 mt-1" data-i18n="admin.phones">${t('admin.phones')}: ${phonesStr}</div>
                </div>
                <button type="button" data-config-action="deleteUser" data-config-user-id="${parseInt(u.id) || 0}" class="flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] text-red-400 hover:bg-red-500/20 border border-red-500/30 transition-colors" data-i18n="admin.delete_user">${t('admin.delete_user')}</button>
            </div>`;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<p class="text-red-400 text-sm">${t('admin.error_list')}</p>`;
    }
}

export async function createUser(username, password, fullName) {
    const res = await apiCall('/api/users/register', {
        method: 'POST',
        body: { username, password, full_name: fullName || username, is_admin: false }
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || t('admin.error_create'));
    }
    return res.json();
}

export async function deleteUser(userId) {
    if (!(await showConfirm(t('admin.delete_user_confirm')))) return;
    try {
        const res = await apiCall(`/api/users/${userId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        await loadAdminUsers();
    } catch (e) {
        showToast(t('admin.error_delete'), 'error');
    }
}

// --- SKILLS ---
let skillEditName = null;

export async function loadSkills() {
    const listEl = document.getElementById('skills-list');
    if (!listEl) return;
    try {
        const res = await apiCall('/api/skills');
        if (!res.ok) { listEl.innerHTML = `<div class="p-4 text-slate-500 text-sm">${t('skills.load_error')}</div>`; return; }
        const data = await res.json();
        if (!data.length) {
            listEl.innerHTML = `<div class="cfg-section p-8 text-center text-slate-500 text-sm" data-i18n="skills.empty">No skills yet. Create one from chat with "Fă un skill care..." or add a .py file in skills/generated/.</div>`;
            return;
        }
        const isAdmin = !!window.__isAdmin;
        const DESC_MAX = 80;
        listEl.innerHTML = data.map(s => {
            const desc = s.description || '—';
            const isLong = desc.length > DESC_MAX;
            const shortDesc = isLong ? desc.slice(0, DESC_MAX) + '…' : desc;
            const fullDescEscaped = escapeHtml(desc).replace(/"/g, '&quot;');
            return `
            <div class="cfg-section border-white/10 flex flex-col sm:flex-row flex-wrap sm:items-center justify-between gap-3 sm:gap-4 p-4 ${s.disabled ? 'opacity-60' : ''}" data-skill-name="${escapeHtml(s.name)}">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-bold text-white">${escapeHtml(s.name)}</span>
                        ${s.generated ? '<span class="text-[10px] px-2 py-0.5 rounded bg-accent/20 text-accent uppercase tracking-wider">Generated</span>' : '<span class="text-[10px] px-2 py-0.5 rounded bg-slate-600/30 text-slate-400 uppercase tracking-wider">Built-in</span>'}
                        ${s.disabled ? '<span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 uppercase tracking-wider">Off</span>' : ''}
                    </div>
                    <div class="text-slate-400 text-sm mt-1 max-w-xl flex items-start gap-1 flex-wrap">
                        <span class="skill-desc-text" data-full="${fullDescEscaped}">${escapeHtml(shortDesc)}</span>
                        ${isLong ? `<button type="button" class="skill-desc-toggle shrink-0 min-w-[44px] min-h-[44px] w-8 flex items-center justify-center rounded text-slate-500 hover:text-accent hover:bg-white/5" data-skills-action="toggleDesc" data-skill-name="${escapeHtml(s.name)}" title="${escapeHtml(t('skills.show_description'))}"><i class="fas fa-chevron-down text-[10px]"></i></button>` : ''}
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2 flex-shrink-0">
                    ${isAdmin ? `<button type="button" data-skills-action="toggleDisabled" data-skill-name="${escapeHtml(s.name)}" class="min-h-[44px] px-3 py-2 rounded-lg text-[10px] font-bold touch-manipulation ${s.disabled ? 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400' : 'bg-white/5 hover:bg-amber-500/20 text-slate-400 hover:text-amber-400'} transition-all" data-i18n="skills.${s.disabled ? 'enable' : 'disable'}">${t(s.disabled ? 'skills.enable' : 'skills.disable')}</button>` : ''}
                    ${isAdmin ? `<button type="button" data-skills-action="openEdit" data-skill-name="${escapeHtml(s.name)}" class="min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold bg-white/5 hover:bg-accent/20 text-slate-300 hover:text-accent transition-all touch-manipulation" data-i18n="common.edit">Edit</button>` : ''}
                    ${isAdmin ? `<button type="button" data-skills-action="deleteSkill" data-skill-name="${escapeHtml(s.name)}" class="min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-all touch-manipulation" data-i18n="common.delete">Delete</button>` : ''}
                </div>
            </div>
        `;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<div class="cfg-section p-8 text-center text-red-400 text-sm">${t('skills.load_error')}</div>`;
    }
}

function escapeJs(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

export async function openSkillEdit(name) {
    skillEditName = name;
    const titleEl = document.getElementById('skill-edit-title');
    const sourceEl = document.getElementById('skill-edit-source');
    const modalEl = document.getElementById('skill-edit-modal');
    if (!titleEl || !sourceEl || !modalEl) return;
    titleEl.textContent = (t('skills.edit_skill')) + ': ' + name;
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(name));
        const data = await res.json();
        setupCodeEditor({ textareaId: 'skill-edit-source', mode: 'python' });
        setCodeEditorValue('skill-edit-source', data.source || '');
    } catch (e) {
        setupCodeEditor({ textareaId: 'skill-edit-source', mode: 'python' });
        setCodeEditorValue('skill-edit-source', '# Error loading skill');
    }
    openSubPage('skill-edit-modal');
    refreshCodeEditor('skill-edit-source');
    setTimeout(() => refreshCodeEditor('skill-edit-source'), 350);
}

export function closeSkillEditModal() {
    skillEditName = null;
    closeSubPage('skill-edit-modal');
}

export async function saveSkillEdit() {
    if (!skillEditName) return;
    const sourceEl = document.getElementById('skill-edit-source');
    if (!sourceEl) return;
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(skillEditName), {
            method: 'PATCH',
            body: { source: getCodeEditorValue('skill-edit-source') }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || t('skills.save_error'));
        }
        closeSkillEditModal();
        await loadSkills();
        showToast(t('config.save_success'), 'success');
    } catch (e) {
        showToast(e.message || t('skills.save_error'), 'error');
    }
}

export async function deleteSkill(name) {
    if (!(await showConfirm((t('skills.delete_confirm')).replace('%s', name)))) return;
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || t('skills.delete_error'));
        }
        await loadSkills();
    } catch (e) {
        showToast(e.message || t('skills.delete_error'), 'error');
    }
}

const DESC_TRUNCATE_LEN = 80;

export function toggleSkillDesc(skillName) {
    const card = Array.from(document.querySelectorAll('[data-skill-name]')).find(el => el.getAttribute('data-skill-name') === skillName);
    if (!card) return;
    const textEl = card.querySelector('.skill-desc-text');
    const btn = card.querySelector('.skill-desc-toggle');
    if (!textEl || !btn) return;
    const full = textEl.getAttribute('data-full') || '';
    const isExpanded = textEl.getAttribute('data-expanded') === '1';
    if (isExpanded) {
        textEl.textContent = full.length > DESC_TRUNCATE_LEN ? full.slice(0, DESC_TRUNCATE_LEN) + '…' : full;
        textEl.removeAttribute('data-expanded');
        btn.innerHTML = '<i class="fas fa-chevron-down"></i>';
        btn.title = t('skills.show_description');
    } else {
        textEl.textContent = full;
        textEl.setAttribute('data-expanded', '1');
        btn.innerHTML = '<i class="fas fa-chevron-up"></i>';
        btn.title = t('skills.hide_description');
    }
}

export async function toggleSkillDisabled(skillName) {
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(skillName) + '/toggle', { method: 'POST' });
        if (!res.ok) throw new Error('Toggle failed');
        await loadSkills();
    } catch (e) {
        showToast(e.message || (t('skills.toggle_error')), 'error');
    }
}
