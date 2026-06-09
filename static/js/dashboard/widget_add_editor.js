// @ts-nocheck — tighten types in a follow-up pass.
/**
 * Dashboard add-card modal — live preview, size grid, and visibility rules.
 */
import { DASHBOARD_COL_POINTS_MIN, DASHBOARD_COL_POINTS_MAX, SECTION_COLS, } from './constants.js';
import { escapeHtml } from './helpers.js';
import { enhanceDashboardCustomSelects } from './custom_selects.js';
/** @type {object | null} */
let _deps = null;
let _visibilityCondSeq = 0;
let _sizeSlidersWired = false;
let _addModalWired = false;
function deps() {
    if (!_deps)
        throw new Error('Dashboard widget add editor not initialized');
    return _deps;
}
export function initDashboardWidgetAddEditor(depsIn) {
    _deps = depsIn;
}
export function renderDashboardAddPreview() {
    const d = deps();
    const target = document.getElementById('dashboard-add-preview-card');
    if (!target)
        return;
    const cache = d.getDashboardCache();
    const type = (document.getElementById('dashboard-widget-type')?.value || 'button').trim();
    const title = (document.getElementById('dashboard-widget-title')?.value || '').trim();
    const subtitle = (document.getElementById('dashboard-widget-subtitle')?.value || '').trim();
    const size = document.getElementById('dashboard-widget-size')?.value || 'md';
    const colSpanPv = parseInt(document.getElementById('dashboard-widget-col-span')?.value || '0', 10);
    const rowSpanPv = parseInt(document.getElementById('dashboard-widget-row-span')?.value || '0', 10);
    const showBackground = !!document.getElementById('dashboard-widget-label-bg')?.checked;
    const switchStyle = !!document.getElementById('dashboard-widget-switch-style')?.checked;
    const cameraMode = String(document.getElementById('dashboard-widget-camera-mode')?.value || 'snapshots') === 'live' ? 'live' : 'snapshots';
    const icon = (document.getElementById('dashboard-widget-icon')?.value || '').trim();
    const entityInput = document.getElementById('dashboard-entity-select');
    const climateEntityRecords = type === 'climate' ? d.climateEntityRecordsForSave() : [];
    const climateEntityIds = climateEntityRecords.map(item => item.entity_id);
    const eid = type === 'climate'
        ? (climateEntityIds[0] || entityInput?.dataset?.currentValue || '')
        : (entityInput?.dataset?.currentValue || '');
    let entityState = '—';
    let entityAttrs = {};
    let entityUnit = '';
    let domain = '';
    if (eid && Array.isArray(cache.available_entities)) {
        const ent = cache.available_entities.find(x => x.entity_id === eid);
        if (ent) {
            entityState = ent.state != null ? String(ent.state) : '—';
            entityAttrs = ent.attributes || {};
            entityUnit = ent.unit || '';
            domain = String(eid).split('.')[0] || '';
        }
    }
    const widget = {
        id: '__preview__',
        type: type === 'label' ? 'label' : type,
        renderer: '',
        title: title || (type === 'label'
            ? (d.t('dashboard.preview_title_default') || 'Title')
            : (eid || (d.t('dashboard.preview_default') || 'Preview'))),
        entity_name: subtitle,
        entity_id: type === 'label' ? 'label.preview' : (eid || 'preview.placeholder'),
        size,
        icon,
        domain,
        unit: entityUnit,
        current_state: entityState,
        attributes: entityAttrs,
        available: true,
        controllable: true,
        show_background: showBackground,
        switch_style: switchStyle,
    };
    if (type === 'climate' && climateEntityIds.length) {
        widget.config = { entities: climateEntityRecords, entity_ids: climateEntityIds };
        widget.entities = climateEntityRecords.map(record => {
            const entityId = record.entity_id;
            const ent = d.getAvailableEntity(entityId) || {};
            return {
                entity_id: entityId,
                title: record.title,
                subtitle: record.subtitle,
                entity_name: ent.name || ent.entity_name || entityId,
                current_state: ent.state ?? ent.current_state ?? 'unknown',
                attributes: ent.attributes || {},
                unit: ent.unit || '',
                available: ent.available !== false,
                controllable: ent.controllable !== false,
            };
        });
    }
    if (type === 'camera') {
        widget.config = { ...(widget.config || {}), camera_mode: cameraMode };
    }
    if (Number.isFinite(colSpanPv) && colSpanPv >= 1)
        widget.col_span = Math.min(colSpanPv, SECTION_COLS);
    if (Number.isFinite(rowSpanPv) && rowSpanPv >= 1)
        widget.row_span = Math.min(rowSpanPv, 12);
    if (!eid && type !== 'label') {
        target.innerHTML = `<div class="text-center text-xs text-slate-500"><i class="fas fa-eye-slash mb-2 block text-lg text-slate-600"></i>${escapeHtml(d.t('dashboard.select_entity_for_preview') || 'Choose an entity for preview')}</div>`;
        return;
    }
    try {
        const html = d.renderWidgetCardForPreview(widget);
        target.innerHTML = `<div class="grid grid-cols-1 gap-3 w-full">${html}</div>`;
    }
    catch (e) {
        target.innerHTML = `<div class="text-xs text-red-400">${escapeHtml(d.t('dashboard.preview_unavailable', { message: e?.message || d.t('common.error') }))}</div>`;
    }
}
export function wireDashboardAddPreviewListeners() {
    if (_addModalWired)
        return;
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal)
        return;
    _addModalWired = true;
    const ids = [
        'dashboard-widget-type', 'dashboard-widget-title', 'dashboard-widget-subtitle',
        'dashboard-widget-size', 'dashboard-widget-col-span', 'dashboard-widget-row-span',
        'dashboard-widget-icon', 'dashboard-widget-color',
        'dashboard-widget-label-bg', 'dashboard-widget-switch-style', 'dashboard-widget-camera-mode', 'dashboard-entity-select',
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el)
            continue;
        const evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') ? 'change' : 'input';
        el.addEventListener(evt, () => renderDashboardAddPreview());
    }
}
export function setDashboardAddEditorMode(mode = 'visual') {
    const validModes = ['visual', 'visibility', 'size'];
    const active = validModes.includes(mode) ? mode : 'visual';
    const sections = {
        visual: document.getElementById('dashboard-add-editor-visual'),
        visibility: document.getElementById('dashboard-add-editor-visibility-wrap'),
        size: document.getElementById('dashboard-add-editor-size-wrap'),
    };
    const tabs = {
        visual: document.getElementById('dashboard-add-editor-visual-tab'),
        visibility: document.getElementById('dashboard-add-editor-visibility-tab'),
        size: document.getElementById('dashboard-add-editor-size-tab'),
    };
    for (const key of validModes) {
        if (sections[key])
            sections[key].classList.toggle('hidden', key !== active);
        if (tabs[key]) {
            const isActive = key === active;
            tabs[key].classList.toggle('bg-white/10', isActive);
            tabs[key].classList.toggle('text-slate-300', isActive);
            tabs[key].classList.toggle('text-slate-400', !isActive);
        }
    }
    if (active === 'visibility') {
        const conds = document.getElementById('dashboard-visibility-conditions');
        if (conds && !conds.children.length)
            addDashboardVisibilityCondition('add');
    }
    else if (active === 'size') {
        syncDashboardSizeSlidersFromSelects();
        wireDashboardSizeSliders();
        renderDashboardSizeGridPreview();
    }
}
export function syncDashboardSizeSlidersFromSelects() {
    const colSel = document.getElementById('dashboard-widget-col-span');
    const rowSel = document.getElementById('dashboard-widget-row-span');
    const colSlider = document.getElementById('dashboard-size-col-slider');
    const rowSlider = document.getElementById('dashboard-size-row-slider');
    const colVal = document.getElementById('dashboard-size-col-value');
    const rowVal = document.getElementById('dashboard-size-row-value');
    const col = Math.min(Math.max(parseInt(colSel?.value || String(DASHBOARD_COL_POINTS_MAX), 10) || DASHBOARD_COL_POINTS_MAX, DASHBOARD_COL_POINTS_MIN), DASHBOARD_COL_POINTS_MAX);
    const row = Math.min(Math.max(parseInt(rowSel?.value || '1', 10) || 1, 1), 8);
    if (colSlider)
        colSlider.value = String(col);
    if (rowSlider)
        rowSlider.value = String(row);
    if (colVal)
        colVal.textContent = String(col);
    if (rowVal)
        rowVal.textContent = String(row);
}
function wireDashboardSizeSliders() {
    if (_sizeSlidersWired)
        return;
    const colSlider = document.getElementById('dashboard-size-col-slider');
    const rowSlider = document.getElementById('dashboard-size-row-slider');
    const colSel = document.getElementById('dashboard-widget-col-span');
    const rowSel = document.getElementById('dashboard-widget-row-span');
    const colVal = document.getElementById('dashboard-size-col-value');
    const rowVal = document.getElementById('dashboard-size-row-value');
    if (!colSlider || !rowSlider)
        return;
    _sizeSlidersWired = true;
    const onCol = () => {
        const v = colSlider.value;
        if (colVal)
            colVal.textContent = v;
        if (colSel) {
            colSel.value = v;
            colSel.dispatchEvent(new Event('change'));
        }
        renderDashboardSizeGridPreview();
        renderDashboardAddPreview();
    };
    const onRow = () => {
        const v = rowSlider.value;
        if (rowVal)
            rowVal.textContent = v;
        if (rowSel) {
            rowSel.value = v;
            rowSel.dispatchEvent(new Event('change'));
        }
        renderDashboardSizeGridPreview();
        renderDashboardAddPreview();
    };
    colSlider.addEventListener('input', onCol);
    rowSlider.addEventListener('input', onRow);
}
function renderDashboardSizeGridPreview() {
    const target = document.getElementById('dashboard-size-grid-preview');
    if (!target)
        return;
    const col = Math.min(Math.max(parseInt(document.getElementById('dashboard-size-col-slider')?.value || String(DASHBOARD_COL_POINTS_MAX), 10) || DASHBOARD_COL_POINTS_MAX, DASHBOARD_COL_POINTS_MIN), DASHBOARD_COL_POINTS_MAX);
    const row = Math.min(Math.max(parseInt(document.getElementById('dashboard-size-row-slider')?.value || '1', 10) || 1, 1), 8);
    const visibleRows = Math.max(4, Math.min(row + 1, 8));
    target.style.gridTemplateRows = `repeat(${visibleRows}, 22px)`;
    const cells = [];
    for (let r = 1; r <= visibleRows; r++) {
        for (let c = 1; c <= DASHBOARD_COL_POINTS_MAX; c++) {
            const active = (c <= col && r <= row) ? 'true' : 'false';
            cells.push(`<div class="dashboard-size-grid-preview__cell" data-active="${active}"></div>`);
        }
    }
    target.innerHTML = cells.join('');
}
export function toggleDashboardVisibilityEditor(scope = 'add') {
    const enabledEl = document.getElementById('dashboard-visibility-enabled');
    const body = document.getElementById('dashboard-visibility-body');
    if (!enabledEl || !body)
        return;
    body.classList.toggle('hidden', !enabledEl.checked);
    if (enabledEl.checked) {
        const conds = document.getElementById('dashboard-visibility-conditions');
        if (conds && !conds.children.length)
            addDashboardVisibilityCondition(scope);
    }
}
export function addDashboardVisibilityCondition(_scope = 'add') {
    const d = deps();
    const wrap = document.getElementById('dashboard-visibility-conditions');
    if (!wrap)
        return;
    const idx = ++_visibilityCondSeq;
    const items = Array.isArray(d.getDashboardCache().available_entities) ? d.getDashboardCache().available_entities : [];
    const listId = `vis-cond-entities-${idx}`;
    const opts = items.slice(0, 200).map(it => `<option value="${escapeHtml(it.entity_id)}">${escapeHtml(it.name || it.entity_id)}</option>`).join('');
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-2';
    row.dataset.condIndex = String(idx);
    row.innerHTML = `
        <input type="text" list="${listId}" data-vis-field="entity" placeholder="entity_id"
               class="flex-1 min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50" />
        <datalist id="${listId}">${opts}</datalist>
        <select data-vis-field="op" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            <option value="eq">=</option>
            <option value="ne">≠</option>
            <option value="gt">&gt;</option>
            <option value="lt">&lt;</option>
            <option value="in">∈</option>
        </select>
        <input type="text" data-vis-field="value" placeholder="valoare"
               class="w-24 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50" />
        <button type="button" class="text-slate-500 hover:text-red-400 text-xs px-1" aria-label="Șterge condiție">
            <i class="fas fa-xmark"></i>
        </button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    wrap.appendChild(row);
    enhanceDashboardCustomSelects(row);
}
export function readDashboardVisibilityConfig() {
    const enabledEl = document.getElementById('dashboard-visibility-enabled');
    if (!enabledEl?.checked)
        return null;
    const logic = document.getElementById('dashboard-visibility-logic')?.value || 'and';
    const wrap = document.getElementById('dashboard-visibility-conditions');
    const conditions = [];
    if (wrap) {
        for (const row of wrap.querySelectorAll('[data-cond-index]')) {
            const ent = row.querySelector('[data-vis-field="entity"]')?.value?.trim();
            const op = row.querySelector('[data-vis-field="op"]')?.value || 'eq';
            const value = row.querySelector('[data-vis-field="value"]')?.value ?? '';
            if (ent)
                conditions.push({ entity_id: ent, op, value: String(value) });
        }
    }
    return { enabled: true, logic, conditions };
}
