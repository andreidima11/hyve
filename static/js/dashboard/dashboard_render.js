/**
 * Dashboard grid render — standalone layout, panel sections, and empty states.
 */
import { DEFAULT_PREFS } from './constants.js';
import { bindDashboardScreenWatch, dashboardElementVisible, dashboardPanelBackgroundCss, visibleDashboardWidgets, } from './dashboard_visibility.js';
import { renderWidgetCard } from './widget_cards.js';
import { dashboardPanelSpan, setupDashboardSortables, syncDashboardPanelGridSpans, teardownDashboardSortables, } from './drag_resize.js';
let _deps = null;
const _panelActivePage = new Map();
function deps() {
    if (!_deps)
        throw new Error('Dashboard render not initialized');
    return _deps;
}
export function initDashboardRender(depsIn) {
    _deps = depsIn;
}
export function renderDashboard() {
    const d = deps();
    const grid = document.getElementById('dashboard-grid');
    if (!grid)
        return;
    bindDashboardScreenWatch();
    teardownDashboardSortables();
    d.syncPreferenceControls();
    d.updateStats();
    d.renderDashboardPagesList();
    const cache = d.getCache();
    const editMode = d.getEditMode();
    const compact = (cache.preferences || DEFAULT_PREFS).layout_mode === 'compact';
    const panels = Array.isArray(cache.panels) ? cache.panels : [];
    const sectionPanels = panels.filter((panel) => !d.isStandalonePanel(panel));
    const hasGroupedPanels = sectionPanels.length > 0;
    if (hasGroupedPanels) {
        grid.className = editMode
            ? 'dashboard-panels-stack dashboard-panel__grid--editing'
            : 'dashboard-panels-stack';
        grid.removeAttribute('data-panel-grid');
    }
    else {
        const standaloneGridClass = compact
            ? 'grid dashboard-panel__grid dashboard-panel__grid--compact dashboard-panel__grid--standalone'
            : 'grid dashboard-panel__grid dashboard-panel__grid--standalone';
        grid.className = editMode
            ? `${standaloneGridClass} dashboard-panel__grid--editing`
            : standaloneGridClass;
        grid.setAttribute('data-panel-grid', '');
    }
    const totalWidgets = panels.reduce((acc, p) => acc + (Array.isArray(p.widgets) ? p.widgets.length : 0), 0)
        || d.filteredWidgets().length;
    if (!totalWidgets && !hasGroupedPanels) {
        if (editMode) {
            grid.className = 'dashboard-panels-stack';
            grid.removeAttribute('data-panel-grid');
            grid.innerHTML = `
                <button type="button" class="dashboard-panel dashboard-panel--add-section" data-dash-action="openPanelCreator" aria-label="${d.escapeHtml(d.t('dashboard.aria.add_section'))}">
                    <i class="fas fa-plus"></i>
                    <span>${d.t('dashboard.create_section') || 'Secțiune nouă'}</span>
                </button>`;
        }
        else {
            grid.innerHTML = `
                <div class="hyve-dashboard-empty">
                    <div class="hyve-dashboard-empty__icon"><i class="fas fa-table-cells-large"></i></div>
                    <h3 class="hyve-dashboard-empty__title">Dashboard gol</h3>
                    <p class="hyve-dashboard-empty__sub">Apasă pe cele 3 puncte din dreapta sus ca să adaugi un card sau un panou.</p>
                </div>`;
        }
        setupDashboardSortables();
        return;
    }
    if (!hasGroupedPanels) {
        const standalonePanel = panels.find(d.isStandalonePanel);
        const widgets = standalonePanel
            ? (standalonePanel.widgets || [])
            : panels.length
                ? (panels[0].widgets || [])
                : d.filteredWidgets();
        grid.innerHTML = visibleDashboardWidgets(widgets).map((widget) => renderWidgetCard(widget)).join('');
        d.enhanceSparklines();
        try {
            d.configureHyveviewMounted(grid);
        }
        catch (_) { }
        setupDashboardSortables();
        try {
            d.resumeDashboardCameras();
        }
        catch (_) { }
        return;
    }
    const items = sectionPanels.map((panel) => renderPanelSection(panel, compact));
    const addSectionBtn = editMode
        ? `<button type="button" class="dashboard-panel dashboard-panel--add-section" data-dash-action="openPanelCreator" aria-label="${d.escapeHtml(d.t('dashboard.aria.add_section'))}">
                <i class="fas fa-plus"></i>
                <span>${d.t('dashboard.create_section') || 'Secțiune nouă'}</span>
           </button>`
        : '';
    grid.innerHTML = items.join('') + addSectionBtn;
    d.enhanceSparklines();
    try {
        d.configureHyveviewMounted(grid);
    }
    catch (_) { }
    syncDashboardPanelGridSpans();
    setupDashboardSortables();
    try {
        d.resumeDashboardCameras();
    }
    catch (_) { }
}
function renderPanelSection(panel, compact) {
    const d = deps();
    const panelId = String(panel.id || '');
    if (!dashboardElementVisible(panel))
        return '';
    const widgets = Array.isArray(panel.widgets) ? panel.widgets : [];
    const pages = Array.isArray(panel.pages) ? panel.pages : [];
    const showTabs = pages.length > 0 && panel.show_pagination !== false;
    const editMode = d.getEditMode();
    let activePageId = _panelActivePage.get(panelId);
    if (showTabs) {
        if (!activePageId || !pages.some((p) => String(p.id) === String(activePageId))) {
            activePageId = String(pages[0].id);
            _panelActivePage.set(panelId, activePageId);
        }
    }
    else {
        activePageId = undefined;
    }
    const visibleWidgets = visibleDashboardWidgets(activePageId
        ? widgets.filter((w) => String(w.page_id || '') === String(activePageId))
        : widgets);
    const title = String(panel.title || '').trim();
    const icon = String(panel.icon || '').trim();
    const titleHtml = title || icon || editMode
        ? `<div class="dashboard-panel__title">
                ${icon ? `<i class="${d.escapeHtml(d.iconClass(icon))} dashboard-panel__icon"></i>` : ''}
                ${title ? `<span>${d.escapeHtml(title)}</span>` : ''}
            </div>`
        : '';
    const tabsHtml = showTabs
        ? `<div class="dashboard-panel__tabs" role="tablist">
                ${pages.map((p) => {
            const id = String(p.id);
            const isActive = id === activePageId;
            return `<button type="button" role="tab"
                        class="dashboard-panel__tab"
                        data-active="${isActive ? 'true' : 'false'}"
                        data-dash-action="selectPanelPage" data-panel-id="${d.escapeHtml(panelId)}" data-page-id="${d.escapeHtml(id)}">
                        ${p.icon ? `<i class="${d.escapeHtml(d.iconClass(p.icon))}"></i>` : ''}
                        <span>${d.escapeHtml(p.title || 'Pagină')}</span>
                    </button>`;
        }).join('')}
            </div>`
        : '';
    const editControls = editMode
        ? `<div class="dashboard-panel__edit">
                <button type="button" class="dashboard-panel__add" data-dash-action="openAddPicker" aria-label="${d.escapeHtml(d.t('dashboard.aria.add_card'))}"><i class="fas fa-plus"></i></button>
                <button type="button" data-dash-action="openPanelEditor" data-panel-id="${d.escapeHtml(panelId)}" aria-label="${d.escapeHtml(d.t('dashboard.aria.edit_section'))}"><i class="fas fa-pen"></i></button>
                <button type="button" class="is-danger" data-dash-action="removePanel" data-panel-id="${d.escapeHtml(panelId)}" aria-label="${d.escapeHtml(d.t('dashboard.aria.delete_section'))}"><i class="fas fa-trash"></i></button>
            </div>`
        : '';
    const dragHandle = editMode
        ? `<button type="button" class="dashboard-panel__drag" data-dash-pointer="panelDrag" data-panel-id="${d.escapeHtml(panelId)}" title="${d.escapeHtml(d.t('dashboard.aria.move_section'))}" aria-label="${d.escapeHtml(d.t('dashboard.aria.move_section'))}"><i class="fas fa-grip-vertical"></i></button>`
        : '';
    const gridClass = compact
        ? 'dashboard-panel__grid dashboard-panel__grid--compact'
        : 'dashboard-panel__grid';
    const gridClassFull = editMode
        ? `${gridClass} dashboard-panel__grid--editing`
        : gridClass;
    const body = visibleWidgets.length
        ? `<div class="${gridClassFull}" data-panel-grid="${d.escapeHtml(panelId)}">${visibleWidgets.map((w) => renderWidgetCard(w)).join('')}</div>`
        : (editMode
            ? `<div class="dashboard-panel__empty dashboard-panel__empty--edit" data-panel-grid="${d.escapeHtml(panelId)}"><button type="button" class="dashboard-panel__add-card" data-dash-action="openAddPicker"><i class="fas fa-plus"></i></button></div>`
            : `<div class="dashboard-panel__empty" data-panel-grid="${d.escapeHtml(panelId)}">Niciun card pe această pagină.</div>`);
    const headerHtml = titleHtml || editControls
        ? `<header class="dashboard-panel__header"><div class="dashboard-panel__header-main">${dragHandle}${titleHtml || '<span></span>'}</div>${editControls}</header>`
        : '';
    const span = dashboardPanelSpan(panel);
    const panelBg = dashboardPanelBackgroundCss(panel);
    const styleVars = [
        `--panel-col-span:${span.col}`,
        span.colStart ? `--panel-col-start:${span.colStart}` : '',
        span.rowStart ? `--panel-row-start:${span.rowStart}` : '',
        `--panel-row-span:${span.row}`,
        panelBg ? `--panel-bg:${panelBg}` : '',
    ].filter(Boolean).join('; ');
    return `
        <section class="dashboard-panel" data-panel-id="${d.escapeHtml(panelId)}" data-size="${d.escapeHtml(panel.size || 'md')}" style="${styleVars}">
            ${headerHtml}
            ${tabsHtml}
            ${body}
        </section>`;
}
export function selectDashboardPanelPage(panelId, pageId) {
    if (!panelId || !pageId)
        return;
    _panelActivePage.set(String(panelId), String(pageId));
    renderDashboard();
}
