import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { isAdmin } from '../user_context.js';
import { escapeHtml, showToast, showConfirm, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from '../utils.js';
import type { SkillSummary } from './types.js';
import { skillState } from './state.js';

function _skillTags(s: SkillSummary): string {
    const tags: string[] = [];
    if (s.generated) {
        tags.push('<span class="hyd-row-badge hyd-row-badge--ok">Generated</span>');
    } else {
        tags.push('<span class="hyd-row-badge hyd-row-badge--muted">Built-in</span>');
    }
    if (s.disabled) {
        tags.push('<span class="hyd-row-badge hyd-row-badge--warn">Off</span>');
    }
    return tags.join('');
}

export async function loadSkills() {
    const listEl = document.getElementById('skills-list');
    const emptyEl = document.getElementById('skills-empty');
    if (!listEl) return;
    try {
        const res = await apiCall('/api/skills');
        if (!res.ok) {
            listEl.innerHTML = '';
            if (emptyEl) {
                emptyEl.classList.remove('hidden');
                emptyEl.innerHTML = `<i class="fas fa-circle-exclamation hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('skills.load_error'))}</p>`;
            }
            return;
        }
        const data = await res.json() as SkillSummary[];
        if (!data.length) {
            listEl.innerHTML = '';
            if (emptyEl) {
                emptyEl.classList.remove('hidden');
                emptyEl.innerHTML = `<i class="fas fa-code hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('skills.empty'))}</p>`;
            }
            return;
        }
        if (emptyEl) emptyEl.classList.add('hidden');
        const isAdminUser = isAdmin();
        const DESC_MAX = 80;
        listEl.innerHTML = data.map(s => {
            const desc = s.description || '—';
            const isLong = desc.length > DESC_MAX;
            const shortDesc = isLong ? desc.slice(0, DESC_MAX) + '…' : desc;
            const fullDescEscaped = escapeHtml(desc).replace(/"/g, '&quot;');
            const name = escapeHtml(s.name);
            return `
            <article class="hyd-entity-row hyd-entity-row--static${s.disabled ? ' opacity-60' : ''}" data-skill-name="${name}" role="listitem">
                <span class="hyd-icon hyd-icon--list"><i class="fas fa-code" aria-hidden="true"></i></span>
                <div class="hyd-entity-row__body min-w-0">
                    <div class="hyd-entity-row__name">${name}</div>
                    <div class="hyd-entity-row__sub flex items-start gap-1 flex-wrap">
                        <span class="skill-desc-text" data-full="${fullDescEscaped}">${escapeHtml(shortDesc)}</span>
                        ${isLong ? `<button type="button" class="skill-desc-toggle hyd-row-actions__btn" data-skills-action="toggleDesc" data-skill-name="${name}" title="${escapeHtml(t('skills.show_description'))}"><i class="fas fa-chevron-down text-[10px]" aria-hidden="true"></i></button>` : ''}
                    </div>
                    <div class="hyd-entity-row__tags">${_skillTags(s)}</div>
                </div>
                ${isAdminUser ? `<div class="hyd-row-actions" role="group">
                    <button type="button" data-skills-action="toggleDisabled" data-skill-name="${name}" class="hyd-row-actions__btn" title="${escapeHtml(t(s.disabled ? 'skills.enable' : 'skills.disable'))}"><i class="fas fa-power-off" aria-hidden="true"></i></button>
                    <button type="button" data-skills-action="openEdit" data-skill-name="${name}" class="hyd-row-actions__btn" title="${escapeHtml(t('common.edit'))}"><i class="fas fa-pen" aria-hidden="true"></i></button>
                    <button type="button" data-skills-action="deleteSkill" data-skill-name="${name}" class="hyd-row-actions__btn hyd-row-actions__btn--danger" title="${escapeHtml(t('common.delete'))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
                </div>` : ''}
            </article>`;
        }).join('');
    } catch (_) {
        listEl.innerHTML = '';
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.innerHTML = `<i class="fas fa-circle-exclamation hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('skills.load_error'))}</p>`;
        }
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
        btn.innerHTML = '<i class="fas fa-chevron-down text-[10px]" aria-hidden="true"></i>';
        btn.title = t('skills.show_description');
    } else {
        textEl.textContent = full;
        textEl.setAttribute('data-expanded', '1');
        btn.innerHTML = '<i class="fas fa-chevron-up text-[10px]" aria-hidden="true"></i>';
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
