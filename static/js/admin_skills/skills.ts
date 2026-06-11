import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { isAdmin } from '../user_context.js';
import { escapeHtml, showToast, showConfirm, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from '../utils.js';
import type { SkillSummary } from './types.js';
import { skillState } from './state.js';


export async function loadSkills() {
    const listEl = document.getElementById('skills-list');
    if (!listEl) return;
    try {
        const res = await apiCall('/api/skills');
        if (!res.ok) { listEl.innerHTML = `<div class="p-4 text-slate-500 text-sm">${t('skills.load_error')}</div>`; return; }
        const data = await res.json() as SkillSummary[];
        if (!data.length) {
            listEl.innerHTML = `<div class="cfg-section p-8 text-center text-slate-500 text-sm" data-i18n="skills.empty">No skills yet. Create one from chat with "Fă un skill care..." or add a .py file in skills/generated/.</div>`;
            return;
        }
        const isAdminUser = isAdmin();
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
                    ${isAdminUser ? `<button type="button" data-skills-action="toggleDisabled" data-skill-name="${escapeHtml(s.name)}" class="min-h-[44px] px-3 py-2 rounded-lg text-[10px] font-bold touch-manipulation ${s.disabled ? 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400' : 'bg-white/5 hover:bg-amber-500/20 text-slate-400 hover:text-amber-400'} transition-all" data-i18n="skills.${s.disabled ? 'enable' : 'disable'}">${t(s.disabled ? 'skills.enable' : 'skills.disable')}</button>` : ''}
                    ${isAdminUser ? `<button type="button" data-skills-action="openEdit" data-skill-name="${escapeHtml(s.name)}" class="min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold bg-white/5 hover:bg-accent/20 text-slate-300 hover:text-accent transition-all touch-manipulation" data-i18n="common.edit">Edit</button>` : ''}
                    ${isAdminUser ? `<button type="button" data-skills-action="deleteSkill" data-skill-name="${escapeHtml(s.name)}" class="min-h-[44px] px-4 py-2 rounded-xl text-xs font-bold bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-all touch-manipulation" data-i18n="common.delete">Delete</button>` : ''}
                </div>
            </div>
        `;
        }).join('');
    } catch (_) {
        listEl.innerHTML = `<div class="cfg-section p-8 text-center text-red-400 text-sm">${t('skills.load_error')}</div>`;
    }
}

export async function openSkillEdit(name: string) {
    skillState.editName = name;
    const titleEl = document.getElementById('skill-edit-title');
    const sourceEl = document.getElementById('skill-edit-source');
    const modalEl = document.getElementById('skill-edit-modal');
    if (!titleEl || !sourceEl || !modalEl) return;
    titleEl.textContent = (t('skills.edit_skill')) + ': ' + name;
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(name));
        const data = await res.json() as { source?: string };
        setupCodeEditor({ textareaId: 'skill-edit-source', mode: 'python' });
        setCodeEditorValue('skill-edit-source', data.source || '');
    } catch (_) {
        setupCodeEditor({ textareaId: 'skill-edit-source', mode: 'python' });
        setCodeEditorValue('skill-edit-source', '# Error loading skill');
    }
    openSubPage('skill-edit-modal');
    refreshCodeEditor('skill-edit-source');
    setTimeout(() => refreshCodeEditor('skill-edit-source'), 350);
}

export function closeSkillEditModal() {
    skillState.editName = null;
    closeSubPage('skill-edit-modal');
}

export async function saveSkillEdit() {
    if (!skillState.editName) return;
    const sourceEl = document.getElementById('skill-edit-source');
    if (!sourceEl) return;
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(skillState.editName), {
            method: 'PATCH',
            body: { source: getCodeEditorValue('skill-edit-source') }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err.detail || t('skills.save_error'));
        }
        closeSkillEditModal();
        await loadSkills();
        showToast(t('config.save_success'), 'success');
    } catch (e) {
        showToast(e instanceof Error ? e.message : t('skills.save_error'), 'error');
    }
}

export async function deleteSkill(name: string) {
    if (!(await showConfirm((t('skills.delete_confirm')).replace('%s', name)))) return;
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err.detail || t('skills.delete_error'));
        }
        await loadSkills();
    } catch (e) {
        showToast(e instanceof Error ? e.message : t('skills.delete_error'), 'error');
    }
}

const DESC_TRUNCATE_LEN = 80;

export function toggleSkillDesc(skillName: string) {
    const card = Array.from(document.querySelectorAll('[data-skill-name]')).find(el => el.getAttribute('data-skill-name') === skillName);
    if (!card) return;
    const textEl = card.querySelector('.skill-desc-text');
    const btn = card.querySelector('.skill-desc-toggle') as HTMLButtonElement | null;
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

export async function toggleSkillDisabled(skillName: string) {
    try {
        const res = await apiCall('/api/skills/' + encodeURIComponent(skillName) + '/toggle', { method: 'POST' });
        if (!res.ok) throw new Error('Toggle failed');
        await loadSkills();
    } catch (e) {
        showToast(e instanceof Error ? e.message : t('skills.toggle_error'), 'error');
    }
}
