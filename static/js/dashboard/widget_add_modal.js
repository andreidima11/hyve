// @ts-nocheck — tighten types in a follow-up pass.
/**
 * Legacy dashboard add-card modal — open/close, type UI, and save (POST/PATCH).
 */
import { apiCall } from '../api.js';
import { showToast, syncModalViewportMetrics } from '../utils.js';
import { DASHBOARD_COL_POINTS_MAX, SECTION_COLS, } from './constants.js';
import { dashApiError, escapeHtml } from './helpers.js';
import { enhanceDashboardCustomSelects, syncDashboardCustomSelect } from './custom_selects.js';
import { readDashboardVisibilityConfig, renderDashboardAddPreview, setDashboardAddEditorMode, syncDashboardSizeSlidersFromSelects, wireDashboardAddPreviewListeners, } from './widget_add_editor.js';
import { renderEntityOptions, resolveEntityMatch, setEntitySelectState } from './entity_picker.js';
/** @type {object | null} */
let _deps = null;
function deps() {
    if (!_deps)
        throw new Error('Dashboard widget add modal not initialized');
    return _deps;
}
export function initDashboardWidgetAddModal(depsIn) {
    _deps = depsIn;
}
function slug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';
}
function applyDashboardModalMode(mode /* 'add' | 'edit' */) {
    const d = deps();
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal)
        return;
    const isEdit = mode === 'edit';
    modal.dataset.mode = isEdit ? 'edit' : 'add';
    const apply = (selector, i18nKey, fallback) => {
        const el = modal.querySelector(selector);
        if (!el)
            return;
        el.setAttribute('data-i18n', i18nKey);
        const translated = d.t(i18nKey);
        el.textContent = (translated && translated !== i18nKey) ? translated : fallback;
    };
    if (isEdit) {
        apply('h3', 'dashboard.edit_card', 'Edit card');
        apply('h3 + p', 'dashboard.edit_card_hint', 'Modifică setările cardului și salvează.');
        apply('button[data-dash-action="saveAddWidget"]', 'common.save', 'Salvează');
    }
    else {
        apply('h3', 'dashboard.add_card', 'Adaugă card');
        apply('h3 + p', 'dashboard.add_card_hint', 'Alege tipul de card și vezi preview înainte de salvare.');
        apply('button[data-dash-action="saveAddWidget"]', 'common.add', 'Adaugă');
    }
}
export function updateDashboardTypeUI() {
    const d = deps();
    const type = document.getElementById('dashboard-widget-type')?.value || 'button';
    const renderer = d.dashboardEditorRenderer(type);
    const entityGroup = document.getElementById('dashboard-entity-group');
    const titleSubtitleGroup = document.getElementById('dashboard-title-subtitle-group')
        || document.getElementById('dashboard-widget-title')?.closest?.('.grid');
    const subtitleLabel = document.getElementById('dashboard-widget-subtitle-label');
    const subtitleInput = document.getElementById('dashboard-widget-subtitle');
    const bgWrap = document.getElementById('dashboard-label-background-wrap');
    const switchWrap = document.getElementById('dashboard-button-switch-wrap');
    const climateEntitiesGroup = document.getElementById('dashboard-climate-entities-group');
    const cameraModeWrap = document.getElementById('dashboard-camera-mode-wrap');
    if (entityGroup)
        entityGroup.classList.toggle('hidden', type === 'label');
    if (titleSubtitleGroup)
        titleSubtitleGroup.classList.toggle('hidden', type === 'climate');
    if (climateEntitiesGroup)
        climateEntitiesGroup.classList.toggle('hidden', type !== 'climate');
    if (cameraModeWrap)
        cameraModeWrap.classList.toggle('hidden', renderer !== 'camera');
    if (bgWrap)
        bgWrap.classList.toggle('hidden', type !== 'label');
    if (switchWrap)
        switchWrap.classList.toggle('hidden', type !== 'button');
    if (subtitleLabel) {
        subtitleLabel.textContent = type === 'label'
            ? (d.t('dashboard.optional_text') || 'Optional text')
            : (d.t('dashboard.subtitle_or_text') || 'Subtitle / text');
    }
    if (subtitleInput) {
        subtitleInput.placeholder = type === 'label'
            ? (d.t('dashboard.subtitle_placeholder_label') || 'You can leave this empty for title only')
            : (d.t('dashboard.subtitle_placeholder_default') || 'e.g. Ground floor or short text');
    }
    const rowSpan = document.getElementById('dashboard-widget-row-span');
    const defaultRows = d.dashboardDefaultRowsForType(type);
    if (!d.getCurrentEditorId() && rowSpan && defaultRows > (parseInt(rowSpan.value || '1', 10) || 1)) {
        rowSpan.value = String(defaultRows);
        syncDashboardSizeSlidersFromSelects();
        syncDashboardCustomSelect(rowSpan);
    }
    renderEntityOptions(document.getElementById('dashboard-entity-select'), type);
    d.renderDashboardClimateEntityChips();
    enhanceDashboardCustomSelects(document.getElementById('dashboard-add-modal'));
    renderDashboardAddPreview();
}
export function updateDashboardEditTypeUI() {
    const type = document.getElementById('dashboard-edit-widget-type')?.value || 'button';
    const entityGroup = document.getElementById('dashboard-edit-entity-group');
    const bgWrap = document.getElementById('dashboard-edit-label-background-wrap');
    const switchWrap = document.getElementById('dashboard-edit-button-switch-wrap');
    if (entityGroup)
        entityGroup.classList.toggle('hidden', type === 'label');
    if (bgWrap)
        bgWrap.classList.toggle('hidden', type !== 'label');
    if (switchWrap)
        switchWrap.classList.toggle('hidden', type !== 'button');
    const current = document.getElementById('dashboard-edit-entity-select')?.dataset?.currentValue || '';
    renderEntityOptions(document.getElementById('dashboard-edit-entity-select'), type, current);
}
export function updateDashboardEntityOptions() {
    const select = document.getElementById('dashboard-entity-select');
    const type = document.getElementById('dashboard-widget-type')?.value || 'button';
    renderEntityOptions(select, type);
}
export async function openDashboardAddModal(kind = 'button') {
    const d = deps();
    if (!d.requireDashboardEditAccess())
        return;
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal)
        return;
    applyDashboardModalMode('add');
    d.closeDashboardMenu();
    syncModalViewportMetrics();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const type = document.getElementById('dashboard-widget-type');
    try {
        const cards = await d.loadDashboardCardCatalog();
        if (type && cards.length) {
            type.innerHTML = cards.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join('');
        }
    }
    catch (_) { /* keep existing options */ }
    const title = document.getElementById('dashboard-widget-title');
    const subtitle = document.getElementById('dashboard-widget-subtitle');
    const icon = document.getElementById('dashboard-widget-icon');
    const size = document.getElementById('dashboard-widget-size');
    const colSpan = document.getElementById('dashboard-widget-col-span');
    const rowSpan = document.getElementById('dashboard-widget-row-span');
    const showBackground = document.getElementById('dashboard-widget-label-bg');
    const cameraMode = document.getElementById('dashboard-widget-camera-mode');
    if (title)
        title.value = '';
    if (subtitle)
        subtitle.value = '';
    if (icon)
        icon.value = '';
    if (type)
        type.value = kind || 'button';
    if (size)
        size.value = 'md';
    if (colSpan)
        colSpan.value = String(DASHBOARD_COL_POINTS_MAX);
    if (rowSpan)
        rowSpan.value = String(d.dashboardDefaultRowsForType(kind || 'button'));
    if (showBackground)
        showBackground.checked = false;
    if (cameraMode)
        cameraMode.value = 'snapshots';
    const switchStyle = document.getElementById('dashboard-widget-switch-style');
    if (switchStyle)
        switchStyle.checked = false;
    const picker = document.getElementById('dashboard-entity-select');
    if (picker) {
        picker.value = '';
        picker.dataset.currentValue = '';
    }
    d.clearDashboardClimateEntitySelection();
    enhanceDashboardCustomSelects(modal);
    setEntitySelectState(d.t('dashboard.loading_entities') || 'Loading entities...', true);
    try {
        await d.refreshAvailableEntities();
        updateDashboardTypeUI();
    }
    catch (e) {
        setEntitySelectState(d.t('dashboard.loading_entities_error') || 'Could not load entities.', true);
        showToast(e.message || (d.t('dashboard.loading_entities_error_toast') || 'Error loading entities'), 'error');
    }
    wireDashboardAddPreviewListeners();
    setDashboardAddEditorMode('visual');
    const visEnabled = document.getElementById('dashboard-visibility-enabled');
    if (visEnabled)
        visEnabled.checked = false;
    const visBody = document.getElementById('dashboard-visibility-body');
    if (visBody)
        visBody.classList.add('hidden');
    const visConds = document.getElementById('dashboard-visibility-conditions');
    if (visConds)
        visConds.innerHTML = '';
    renderDashboardAddPreview();
}
export function closeDashboardAddModal() {
    const d = deps();
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal)
        return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    d.clearDashboardClimateEntitySelection();
    if (d.getCurrentEditorId()) {
        d.clearCurrentEditorId();
        const headerTitle = document.querySelector('#dashboard-add-modal h3');
        if (headerTitle)
            headerTitle.textContent = d.t('dashboard.add_card') || 'Add card';
        const saveBtn = document.querySelector('#dashboard-add-modal button[data-dash-action="saveAddWidget"]');
        if (saveBtn)
            saveBtn.textContent = d.t('common.add') || 'Add';
    }
}
export async function addDashboardSwitch() {
    const d = deps();
    if (!d.requireDashboardEditAccess())
        return;
    const entityInput = document.getElementById('dashboard-entity-select');
    const title = document.getElementById('dashboard-widget-title');
    const subtitle = document.getElementById('dashboard-widget-subtitle');
    const type = document.getElementById('dashboard-widget-type');
    const size = document.getElementById('dashboard-widget-size');
    const widgetType = type?.value || 'button';
    const widgetRenderer = d.dashboardEditorRenderer(widgetType);
    let selected = resolveEntityMatch(entityInput, widgetType);
    let climateEntityIds = [];
    let climateEntityRecords = [];
    if (widgetType === 'climate') {
        climateEntityRecords = d.climateEntityRecordsForSave();
        climateEntityIds = climateEntityRecords.map(item => item.entity_id);
        if (!selected && climateEntityIds.length) {
            const firstId = climateEntityIds[0];
            selected = d.getAvailableEntity(firstId) || { entity_id: firstId, name: firstId, source: 'integration' };
        }
    }
    if (widgetType !== 'label' && !selected) {
        showToast(d.t('dashboard.pick_entity'), 'warning');
        return;
    }
    if (widgetType === 'climate' && !climateEntityIds.length) {
        showToast(d.t('dashboard.pick_climate_multi'), 'warning');
        return;
    }
    const switchStyle = document.getElementById('dashboard-widget-switch-style');
    const showBackground = document.getElementById('dashboard-widget-label-bg');
    const iconInput = document.getElementById('dashboard-widget-icon');
    const colSpanEl = document.getElementById('dashboard-widget-col-span');
    const rowSpanEl = document.getElementById('dashboard-widget-row-span');
    const cameraMode = document.getElementById('dashboard-widget-camera-mode');
    const manualEntityId = `label.${slug(title?.value || subtitle?.value || 'section')}`;
    const resolvedEntityId = widgetType === 'label' ? manualEntityId : selected.entity_id;
    const body = {
        type: widgetType,
        entity_id: resolvedEntityId,
        entity_name: widgetType === 'label'
            ? (subtitle?.value || '').trim()
            : (widgetType === 'climate'
                ? (selected?.name || resolvedEntityId).trim()
                : (subtitle?.value || selected?.name || resolvedEntityId).trim()),
        title: widgetType === 'climate' ? '' : (title?.value || '').trim(),
        icon: (iconInput?.value || '').trim(),
        source: widgetType === 'label' ? 'manual' : (selected?.source || 'zigbee2mqtt'),
        size: size?.value || 'md',
        favorite: false,
        show_background: widgetType === 'label' ? !!showBackground?.checked : false,
        switch_style: widgetType === 'button' ? !!switchStyle?.checked : false,
    };
    if (widgetType === 'climate') {
        body.entity_id = climateEntityIds[0];
        body.config = { ...(body.config || {}), entities: climateEntityRecords, entity_ids: climateEntityIds };
    }
    if (widgetRenderer === 'camera') {
        const selectedMode = String(cameraMode?.value || 'snapshots').trim() === 'live' ? 'live' : 'snapshots';
        body.config = { ...(body.config || {}), camera_mode: selectedMode };
    }
    const colSpanVal = parseInt(colSpanEl?.value || '0', 10);
    const rowSpanVal = parseInt(rowSpanEl?.value || '0', 10);
    if (Number.isFinite(colSpanVal) && colSpanVal >= 1)
        body.col_span = Math.min(colSpanVal, SECTION_COLS);
    if (Number.isFinite(rowSpanVal) && rowSpanVal >= 1)
        body.row_span = Math.min(rowSpanVal, 12);
    const visibility = readDashboardVisibilityConfig();
    if (visibility)
        body.visibility = visibility;
    const activePageId = d.getCurrentPageId() || '';
    const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
    const editId = d.getCurrentEditorId();
    if (editId) {
        try {
            const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(editId)}${pageQS}`, {
                method: 'PATCH',
                body,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(dashApiError(err.detail, 'dashboard.card_update_error'));
            }
            d.closeDashboardWidgetEditor();
            await d.loadDashboard();
            showToast(d.t('dashboard.card_updated'), 'success');
        }
        catch (e) {
            showToast(e.message || d.t('dashboard.card_update_error'), 'error');
        }
        return;
    }
    try {
        const res = await apiCall(`/api/dashboard/widgets${pageQS}`, { method: 'POST', body });
        if (res.ok) {
            closeDashboardAddModal();
            await d.loadDashboard();
            showToast(body.type === 'label' ? d.t('dashboard.label_added') : (body.type === 'info' ? d.t('dashboard.widget_added') : (body.type === 'button' ? d.t('dashboard.button_added') : d.t('dashboard.switch_added'))), 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.save_widget_failed'));
        }
    }
    catch (e) {
        if (String(e?.message || '').includes(d.t('dashboard.save_widget_failed'))) {
            showToast(e.message, 'error');
            return;
        }
    }
    try {
        const section = await d.readDashboardSectionFallback();
        section.widgets.push({
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            ...body,
        });
        await d.writeDashboardSectionFallback(section);
        closeDashboardAddModal();
        await d.loadDashboard();
        showToast(d.t('dashboard.card_added') || 'Card added', 'success');
    }
    catch (e) {
        showToast(e.message || (d.t('dashboard.save_error') || 'Save error'), 'error');
    }
}
