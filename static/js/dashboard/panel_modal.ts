/**
 * Dashboard section (panel) create/edit modal — background, visibility, pagination pages.
 */

import { apiCall } from '../api.js';
import { syncModalViewportMetrics } from '../utils.js';
import { dashApiError, escapeHtml } from './helpers.js';
import { enhanceDashboardCustomSelects, syncDashboardCustomSelect } from './custom_selects.js';
import type { DashboardPanel, DashboardPanelModalDeps } from '../types/dashboard.js';

interface PanelModalPage {
    id: string;
    title: string;
    icon: string;
}

interface PanelModalInput {
    id?: string;
    title?: string;
    size?: string;
    icon?: string;
    show_pagination?: boolean;
    pages?: Array<{ id?: string; title?: string; icon?: string }>;
    background?: { color?: string; opacity?: number } | null;
    visibility?: {
        enabled?: boolean;
        logic?: string;
        conditions?: Array<Record<string, unknown>>;
    } | null;
}

let _deps: DashboardPanelModalDeps | null = null;

let _modalMode: 'add' | 'edit' = 'add';
let _modalPanelId: string | null = null;
let _modalPages: PanelModalPage[] = [];
let _panelVisCondSeq = 0;

const _SCREEN_PRESETS = [
    { label: 'Mobil (≤1023px)', value: '(max-width: 1023px)' },
    { label: 'Desktop (≥1024px)', value: '(min-width: 1024px)' },
];

function deps(): DashboardPanelModalDeps {
    if (!_deps) throw new Error('Dashboard panel modal not initialized');
    return _deps;
}

export function initDashboardPanelModal(depsIn: DashboardPanelModalDeps) {
    _deps = depsIn;
}

function panelModalElements() {
    return {
        modal: document.getElementById('dashboard-panel-modal'),
        modalTitle: document.getElementById('dashboard-panel-modal-title'),
        title: document.getElementById('dashboard-panel-title-input') as HTMLInputElement | null,
        size: document.getElementById('dashboard-panel-size-input') as HTMLSelectElement | null,
        sizeOptions: Array.from(document.querySelectorAll('[data-dashboard-panel-size-option]')) as HTMLElement[],
        icon: document.getElementById('dashboard-panel-icon-input') as HTMLInputElement | null,
        showPagination: document.getElementById('dashboard-panel-show-pagination-input') as HTMLInputElement | null,
        pagesList: document.getElementById('dashboard-panel-pages-list'),
        pagesEmpty: document.getElementById('dashboard-panel-pages-empty'),
        addPage: document.getElementById('dashboard-panel-page-add'),
    };
}

export function setDashboardPanelSize(value: string) {
    const els = panelModalElements();
    const normalized = ['sm', 'md', 'wide'].includes(value) ? value : 'sm';
    if (els.size) {
        els.size.value = normalized;
        syncDashboardCustomSelect(els.size);
    }
    els.sizeOptions.forEach(option => {
        const isActive = option.getAttribute('data-dashboard-panel-size-option') === normalized;
        option.dataset.active = isActive ? 'true' : 'false';
        option.setAttribute('aria-checked', isActive ? 'true' : 'false');
        option.tabIndex = isActive ? 0 : -1;
    });
}

function openDashboardPanelModal(mode: 'add' | 'edit', panel: PanelModalInput = {}) {
    const d = deps();
    const els = panelModalElements();
    if (!els.modal) return;
    enhanceDashboardCustomSelects(els.modal);
    _modalMode = mode === 'edit' ? 'edit' : 'add';
    _modalPanelId = mode === 'edit' ? String(panel.id || '') : null;
    _modalPages = Array.isArray(panel.pages)
        ? panel.pages.map(page => ({
            id: String(page.id || '').trim(),
            title: String(page.title || '').trim(),
            icon: String(page.icon || '').trim(),
        }))
        : [];

    if (els.modalTitle) {
        els.modalTitle.textContent = _modalMode === 'edit'
            ? d.t('dashboard.edit_section')
            : d.t('dashboard.create_section');
    }
    if (els.title) els.title.value = _modalMode === 'edit' ? String(panel.title || '') : '';
    setDashboardPanelSize(['sm', 'md', 'wide'].includes(String(panel.size || '')) ? String(panel.size) : 'sm');
    if (els.icon) els.icon.value = String(panel.icon || '');
    if (els.showPagination) els.showPagination.checked = panel.show_pagination !== false;
    populateDashboardPanelBackground(panel);
    populateDashboardPanelVisibility(panel);

    renderDashboardPanelPagesEditor();
    d.closeDashboardMenu();
    syncModalViewportMetrics();
    els.modal.classList.remove('hidden');
    els.modal.classList.add('flex');
    window.setTimeout(() => els.title?.focus?.(), 0);
}

function renderDashboardPanelPagesEditor() {
    const { pagesList, pagesEmpty } = panelModalElements();
    if (pagesEmpty) pagesEmpty.classList.toggle('hidden', _modalPages.length > 0);
    if (!pagesList) return;
    if (!_modalPages.length) {
        pagesList.innerHTML = '';
        return;
    }
    pagesList.innerHTML = _modalPages.map((page, index) => `
        <div class="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-xl border border-white/10 bg-slate-950/35 p-2" data-panel-page-row="${index}">
            <input type="text" value="${escapeHtml(page.title || '')}" placeholder="Titlu pagină"
                class="min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-accent/50"
                data-panel-page-title="${index}">
            <input type="text" value="${escapeHtml(page.icon || '')}" placeholder="Icon"
                class="min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-accent/50"
                data-panel-page-icon="${index}" data-icon-picker>
            <button type="button" class="w-9 h-9 rounded-lg bg-white/5 hover:bg-red-500/10 text-slate-400 hover:text-red-300"
                aria-label="Șterge pagina" data-panel-page-remove="${index}"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
    pagesList.querySelectorAll('[data-panel-page-title]').forEach(input => {
        input.addEventListener('input', () => {
            const index = Number(input.getAttribute('data-panel-page-title'));
            const row = input as HTMLInputElement;
            if (_modalPages[index]) _modalPages[index].title = row.value;
        });
    });
    pagesList.querySelectorAll('[data-panel-page-icon]').forEach(input => {
        input.addEventListener('input', () => {
            const index = Number(input.getAttribute('data-panel-page-icon'));
            const row = input as HTMLInputElement;
            if (_modalPages[index]) _modalPages[index].icon = row.value;
        });
    });
    pagesList.querySelectorAll('[data-panel-page-remove]').forEach(button => {
        button.addEventListener('click', () => {
            const index = Number(button.getAttribute('data-panel-page-remove'));
            _modalPages.splice(index, 1);
            renderDashboardPanelPagesEditor();
        });
    });
}

function readDashboardPanelModalBody() {
    const els = panelModalElements();
    const title = String(els.title?.value || '').trim();
    const sizeValue = String(els.size?.value || 'md');
    return {
        title,
        size: ['sm', 'md', 'wide'].includes(sizeValue) ? sizeValue : 'md',
        icon: String(els.icon?.value || '').trim(),
        show_pagination: els.showPagination?.checked !== false,
        pages: _modalPages
            .map((page, index) => ({
                id: String(page.id || '').trim() || `page_${index + 1}`,
                title: String(page.title || '').trim() || `Pagina ${index + 1}`,
                icon: String(page.icon || '').trim(),
            }))
            .slice(0, 10),
        background: readDashboardPanelBackground(),
        visibility: readDashboardPanelVisibility(),
    };
}

export function toggleDashboardPanelBackground() {
    const enabled = document.getElementById('dashboard-panel-bg-enabled') as HTMLInputElement | null;
    const body = document.getElementById('dashboard-panel-bg-body');
    if (body) body.classList.toggle('hidden', !enabled?.checked);
}

function populateDashboardPanelBackground(panel: PanelModalInput) {
    const enabled = document.getElementById('dashboard-panel-bg-enabled') as HTMLInputElement | null;
    const body = document.getElementById('dashboard-panel-bg-body');
    const color = document.getElementById('dashboard-panel-bg-color') as HTMLInputElement | null;
    const opacity = document.getElementById('dashboard-panel-bg-opacity') as HTMLInputElement | null;
    const opacityVal = document.getElementById('dashboard-panel-bg-opacity-value');
    const bg = panel?.background || null;
    const on = !!(bg && bg.color);
    if (enabled) enabled.checked = on;
    if (body) body.classList.toggle('hidden', !on);
    if (color) color.value = (bg && bg.color) || '#1e293b';
    const pct = on && typeof bg.opacity === 'number' ? Math.round(bg.opacity * 100) : 60;
    if (opacity) opacity.value = String(pct);
    if (opacityVal) opacityVal.textContent = `${pct}%`;
}

function readDashboardPanelBackground() {
    const enabled = document.getElementById('dashboard-panel-bg-enabled') as HTMLInputElement | null;
    if (!enabled?.checked) return null;
    const color = String((document.getElementById('dashboard-panel-bg-color') as HTMLInputElement | null)?.value || '#1e293b');
    const pct = parseInt((document.getElementById('dashboard-panel-bg-opacity') as HTMLInputElement | null)?.value || '60', 10);
    return { color, opacity: Math.min(Math.max(pct, 0), 100) / 100 };
}

export function toggleDashboardPanelVisibility() {
    const enabled = document.getElementById('dashboard-panel-visibility-enabled') as HTMLInputElement | null;
    const body = document.getElementById('dashboard-panel-visibility-body');
    if (body) body.classList.toggle('hidden', !enabled?.checked);
    if (enabled?.checked) {
        const wrap = document.getElementById('dashboard-panel-visibility-conditions');
        if (wrap && !wrap.children.length) addDashboardPanelVisibilityCondition();
    }
}

export function addDashboardPanelVisibilityCondition(cond: Record<string, unknown> | null = null) {
    const d = deps();
    const wrap = document.getElementById('dashboard-panel-visibility-conditions');
    if (!wrap) return;
    const idx = ++_panelVisCondSeq;
    const type = String((cond && (cond.condition || cond.type)) || 'entity').toLowerCase();
    const row = document.createElement('div');
    row.className = 'rounded-xl border border-white/10 bg-white/[0.02] p-2 space-y-2';
    row.dataset.panelCond = String(idx);
    row.innerHTML = `
        <div class="flex items-center gap-2">
            <select data-pvis-field="type" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
                <option value="entity">Entitate</option>
                <option value="user">Utilizator</option>
                <option value="screen">Ecran / dispozitiv</option>
            </select>
            <button type="button" data-pvis-remove class="ml-auto text-slate-500 hover:text-red-400 text-xs px-1" aria-label="Șterge condiție"><i class="fas fa-xmark"></i></button>
        </div>
        <div data-pvis-fields></div>`;
    const typeSel = row.querySelector('[data-pvis-field="type"]') as HTMLSelectElement | null;
    if (!typeSel) return;
    typeSel.value = ['entity', 'user', 'screen'].includes(type) ? type : 'entity';
    const renderFields = () => {
        const fields = row.querySelector('[data-pvis-fields]');
        if (fields) fields.innerHTML = panelVisibilityFieldsHtml(typeSel.value, idx, cond);
        enhanceDashboardCustomSelects(row);
    };
    typeSel.addEventListener('change', () => { renderFields(); });
    row.querySelector('[data-pvis-remove]')?.addEventListener('click', () => row.remove());
    wrap.appendChild(row);
    renderFields();
    enhanceDashboardCustomSelects(row);
}

function panelVisibilityFieldsHtml(type: string, idx: number, cond: Record<string, unknown> | null) {
    const d = deps();
    if (type === 'user') {
        const users = Array.isArray(cond?.users) ? (cond.users as string[]).join(', ') : '';
        const op = cond?.operator === 'is_not' ? 'is_not' : 'is';
        return `
            <div class="flex items-center gap-2">
                <select data-pvis-field="op" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
                    <option value="is"${op === 'is' ? ' selected' : ''}>este</option>
                    <option value="is_not"${op === 'is_not' ? ' selected' : ''}>nu este</option>
                </select>
                <input type="text" data-pvis-field="users" value="${escapeHtml(users)}" placeholder="utilizatori (separați prin virgulă)"
                    class="flex-1 min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            </div>`;
    }
    if (type === 'screen') {
        const media = String(cond?.media || cond?.value || '').trim();
        const listId = `pvis-screen-${idx}`;
        return `
            <input type="text" list="${listId}" data-pvis-field="media" value="${escapeHtml(media)}" placeholder="(max-width: 1023px)"
                class="w-full rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            <datalist id="${listId}">${_SCREEN_PRESETS.map(p => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join('')}</datalist>`;
    }
    const cache = d.getDashboardCache();
    const items = Array.isArray(cache.available_entities) ? cache.available_entities : [];
    const listId = `pvis-ent-${idx}`;
    const opts = items.slice(0, 200).map(it => `<option value="${escapeHtml(it.entity_id)}">${escapeHtml(it.name || it.entity_id)}</option>`).join('');
    const ent = escapeHtml(cond?.entity_id || '');
    const op = String(cond?.operator || cond?.op || 'is');
    const val = escapeHtml(cond?.value != null ? String(cond.value) : '');
    const opSel = (v: string, label: string) => `<option value="${v}"${op === v ? ' selected' : ''}>${label}</option>`;
    return `
        <div class="flex items-center gap-2">
            <input type="text" list="${listId}" data-pvis-field="entity" value="${ent}" placeholder="entity_id"
                class="flex-1 min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            <datalist id="${listId}">${opts}</datalist>
            <select data-pvis-field="op" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
                ${opSel('is', '=')}${opSel('is_not', '≠')}${opSel('>', '&gt;')}${opSel('>=', '≥')}${opSel('<', '&lt;')}${opSel('<=', '≤')}
            </select>
            <input type="text" data-pvis-field="value" value="${val}" placeholder="valoare"
                class="w-24 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
        </div>`;
}

function populateDashboardPanelVisibility(panel: PanelModalInput) {
    const enabled = document.getElementById('dashboard-panel-visibility-enabled') as HTMLInputElement | null;
    const body = document.getElementById('dashboard-panel-visibility-body');
    const logic = document.getElementById('dashboard-panel-visibility-logic') as HTMLSelectElement | null;
    const wrap = document.getElementById('dashboard-panel-visibility-conditions');
    if (!enabled || !wrap) return;
    const cfg = panel?.visibility || null;
    const conditions = Array.isArray(cfg?.conditions) ? cfg.conditions : [];
    const on = !!(cfg?.enabled && conditions.length);
    enabled.checked = on;
    if (body) body.classList.toggle('hidden', !on);
    if (logic) logic.value = cfg?.logic === 'or' ? 'or' : 'and';
    wrap.innerHTML = '';
    if (!on) return;
    for (const cond of conditions) addDashboardPanelVisibilityCondition(cond);
}

function readDashboardPanelVisibility() {
    const enabled = document.getElementById('dashboard-panel-visibility-enabled') as HTMLInputElement | null;
    if (!enabled?.checked) return { enabled: false, logic: 'and', conditions: [] };
    const logic = (document.getElementById('dashboard-panel-visibility-logic') as HTMLSelectElement | null)?.value === 'or' ? 'or' : 'and';
    const wrap = document.getElementById('dashboard-panel-visibility-conditions');
    const conditions: Array<Record<string, unknown>> = [];
    if (wrap) {
        for (const row of wrap.querySelectorAll('[data-panel-cond]')) {
            const type = (row.querySelector('[data-pvis-field="type"]') as HTMLSelectElement | null)?.value || 'entity';
            if (type === 'user') {
                const users = String((row.querySelector('[data-pvis-field="users"]') as HTMLInputElement | null)?.value || '')
                    .split(',').map(s => s.trim()).filter(Boolean);
                const op = (row.querySelector('[data-pvis-field="op"]') as HTMLSelectElement | null)?.value === 'is_not' ? 'is_not' : 'is';
                if (users.length) conditions.push({ condition: 'user', users, operator: op });
            } else if (type === 'screen') {
                const media = String((row.querySelector('[data-pvis-field="media"]') as HTMLInputElement | null)?.value || '').trim();
                if (media) conditions.push({ condition: 'screen', media });
            } else {
                const ent = String((row.querySelector('[data-pvis-field="entity"]') as HTMLInputElement | null)?.value || '').trim();
                const op = (row.querySelector('[data-pvis-field="op"]') as HTMLSelectElement | null)?.value || 'is';
                const value = String((row.querySelector('[data-pvis-field="value"]') as HTMLInputElement | null)?.value || '');
                if (ent) conditions.push({ condition: 'entity', entity_id: ent, operator: op, value });
            }
        }
    }
    return { enabled: conditions.length > 0, logic, conditions };
}

export function openDashboardPanelCreator() {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    openDashboardPanelModal('add', { title: '', size: 'sm', icon: '', show_pagination: true, pages: [] });
}

export function openDashboardPanelEditor(panelId: string) {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const panel = (d.getDashboardCache().panels || []).find(p => String(p.id) === String(panelId)) as DashboardPanel | undefined;
    if (!panel) return;
    openDashboardPanelModal('edit', panel as PanelModalInput);
}

export function closeDashboardPanelModal() {
    const modal = document.getElementById('dashboard-panel-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    _modalMode = 'add';
    _modalPanelId = null;
    _modalPages = [];
}

export async function saveDashboardPanel() {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const body = readDashboardPanelModalBody();
    try {
        const pageId = d.getCurrentPageId();
        const params = pageId ? `?page_id=${encodeURIComponent(pageId)}` : '';
        const isEdit = _modalMode === 'edit' && _modalPanelId;
        const path = isEdit && _modalPanelId
            ? `/api/dashboard/panels/${encodeURIComponent(_modalPanelId)}${params}`
            : `/api/dashboard/panels${params}`;
        const res = await apiCall(path, {
            method: isEdit ? 'PATCH' : 'POST',
            body,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, isEdit ? 'dashboard.section_update_error' : 'dashboard.section_save_error'));
        }
        closeDashboardPanelModal();
        await d.refreshAvailableEntities();
        d.renderDashboard();
        d.showToast(isEdit ? d.t('dashboard.section_updated') : d.t('dashboard.section_added'), 'success');
    } catch (e) {
        d.showToast(e instanceof Error ? e.message : d.t('dashboard.section_save_error'), 'error');
    }
}

export function addDashboardPanelModalPage() {
    const nextIndex = _modalPages.length + 1;
    _modalPages.push({
        id: `page_${Date.now().toString(36)}_${nextIndex}`,
        title: `Pagina ${nextIndex}`,
        icon: '',
    });
    renderDashboardPanelPagesEditor();
}
