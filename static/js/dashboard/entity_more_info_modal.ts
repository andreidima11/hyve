/**
 * Entity more-info modal for dashboard cards.
 */

import {
    pauseBackgroundCameraStreams,
    pauseEntityDetailCameraStreams,
    resumeBackgroundCameraStreams,
    startCameraPreviewRefresh,
    stopCameraPreviewRefresh,
} from '../camera_auth.js';
import {
    entityDisplayName,
    getDomainIcon,
    renderEntityFriendlyNameSection,
    renderEntityModal,
    wireEntityFriendlyNameEditor,
    wireEntityRegistryEditor,
} from '../entity_renderers.js';
import { escapeHtml } from './helpers.js';
import {
    openEntityDetailModal,
    resolveEntityControlSlug,
} from '../entity_detail_modal.js';
import { t } from '../lang/index.js';
import { mountAndLoadHistoryPanel } from './history_panel.js';
import type { HyveEntity } from '../types/entity.js';
import type { DashboardWidgetLike, InteractionSpec } from './interactions/types.js';

type MoreInfoTab = 'overview' | 'history' | 'attributes';

interface MoreInfoOptions {
    tab?: MoreInfoTab;
    historyHours?: number;
}

function _label(key: string, fallback: string): string {
    const out = t(key);
    return out !== key ? out : fallback;
}

function modalElements() {
    return {
        modal: document.getElementById('dashboard-entity-more-info-modal'),
        iconEl: document.getElementById('dashboard-entity-more-info-icon'),
        labelEl: document.getElementById('dashboard-entity-more-info-label'),
        body: document.getElementById('dashboard-entity-more-info-body'),
    };
}

function widgetAsEntity(
    widget: DashboardWidgetLike,
    base: HyveEntity | null,
): HyveEntity {
    const entityId = String(widget.entity_id || base?.entity_id || '').trim();
    const domain = String(widget.domain || base?.domain || entityId.split('.')[0] || '').toLowerCase();
    return {
        ...(base || {}),
        entity_id: entityId,
        domain,
        name: String(widget.entity_name || widget.title || base?.name || entityId),
        state: widget.current_state ?? base?.state ?? 'unknown',
        attributes: (widget.attributes && typeof widget.attributes === 'object'
            ? widget.attributes
            : base?.attributes) as HyveEntity['attributes'],
        source: String(widget.source || base?.source || ''),
        available: widget.available !== false,
        controllable: widget.controllable !== false,
    } as HyveEntity;
}

function renderAttributesTab(entity: HyveEntity, hidden = false): string {
    const attrs = entity.attributes || {};
    const flatAttrs = Object.entries(attrs)
        .filter(([k, v]) => k !== 'capabilities' && k !== 'raw_state' && v != null && typeof v !== 'object')
        .slice(0, 50);
    const attrGrid = flatAttrs.length
        ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1">
            ${flatAttrs.map(([k, v]) => `
              <div class="flex items-center justify-between gap-2 px-2 py-1 bg-white/[0.03] rounded">
                <span class="text-[10px] text-slate-500 uppercase tracking-wider truncate">${escapeHtml(k)}</span>
                <span class="text-[11px] mono text-slate-200 truncate">${escapeHtml(String(v))}</span>
              </div>`).join('')}
          </div>`
        : `<p class="dashboard-more-info-empty">${_label('dashboard.interactions.attributes_empty', 'No attributes to show.')}</p>`;
    return `
      <div class="dashboard-more-info-tab-panel${hidden ? ' hidden' : ''}" data-more-info-panel="attributes">
        ${attrGrid}
        <details class="rounded-2xl bg-white/5 border border-theme-subtle p-3 mt-3">
          <summary class="text-[11px] uppercase tracking-wider text-slate-400 cursor-pointer select-none">${_label('dashboard.interactions.raw_json', 'Raw JSON')}</summary>
          <pre class="text-[10px] text-slate-400 mono whitespace-pre-wrap break-all mt-2 max-h-64 overflow-auto">${escapeHtml(JSON.stringify(entity, null, 2))}</pre>
        </details>
      </div>`;
}

function renderTabs(active: MoreInfoTab): string {
    const tabs: Array<{ id: MoreInfoTab; labelKey: string; fallback: string }> = [
        { id: 'overview', labelKey: 'dashboard.interactions.tab_overview', fallback: 'Overview' },
        { id: 'history', labelKey: 'dashboard.interactions.tab_history', fallback: 'History' },
        { id: 'attributes', labelKey: 'dashboard.interactions.tab_attributes', fallback: 'Attributes' },
    ];
    return `
      <nav class="dashboard-more-info-tabs" data-role="more-info-tabs">
        ${tabs.map((tab) => `
          <button type="button" class="dashboard-more-info-tab${tab.id === active ? ' is-active' : ''}" data-more-info-tab="${tab.id}">
            ${_label(tab.labelKey, tab.fallback)}
          </button>`).join('')}
      </nav>`;
}

let _activeTab: MoreInfoTab = 'overview';
let _historyLoader: { reload: (hours: number) => Promise<void> } | null = null;

function switchMoreInfoTab(
    tab: MoreInfoTab,
    body: HTMLElement,
    widget: DashboardWidgetLike,
    entity: HyveEntity,
    slug: string,
    historyHours: number,
): void {
    _activeTab = tab;
    body.querySelectorAll('[data-more-info-tab]').forEach((btn) => {
        btn.classList.toggle('is-active', (btn as HTMLElement).dataset.moreInfoTab === tab);
    });
    body.querySelectorAll('[data-more-info-panel]').forEach((panel) => {
        const id = (panel as HTMLElement).dataset.moreInfoPanel;
        panel.classList.toggle('hidden', id !== tab);
    });
    if (tab === 'history') {
        const host = body.querySelector('[data-more-info-panel="history"]') as HTMLElement | null;
        if (host && host.dataset.loaded !== 'true') {
            host.dataset.loaded = 'true';
            void mountAndLoadHistoryPanel(host, widget, historyHours).then((loader) => {
                _historyLoader = loader;
            });
        }
    }
    if (tab === 'overview') {
        startCameraPreviewRefresh();
    } else {
        stopCameraPreviewRefresh();
    }
}

export function closeDashboardEntityMoreInfo(): void {
    const { modal } = modalElements();
    _historyLoader = null;
    _activeTab = 'overview';
    stopCameraPreviewRefresh();
    pauseEntityDetailCameraStreams(modal);
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    resumeBackgroundCameraStreams(modal);
}

export function openDashboardEntityMoreInfo(
    widget: DashboardWidgetLike,
    lookupEntity: (entityId: string) => HyveEntity | null,
    options: MoreInfoOptions = {},
): void {
    const entityId = String(widget?.entity_id || '').trim();
    if (!entityId) return;

    const { modal, iconEl, labelEl, body } = modalElements();
    if (!modal || !body) {
        const base = lookupEntity(entityId);
        if (base) openEntityDetailModal(widgetAsEntity(widget, base));
        return;
    }

    stopCameraPreviewRefresh();
    pauseBackgroundCameraStreams(modal);
    pauseEntityDetailCameraStreams(modal);

    const base = lookupEntity(entityId);
    const entity = widgetAsEntity(widget, base);
    const slug = resolveEntityControlSlug(entity);
    const dom = String(entity.domain || entityId.split('.')[0] || '').toLowerCase();
    const attrs = (entity.attributes || {}) as Record<string, unknown>;
    const caps = (attrs.capabilities || {}) as Record<string, unknown>;
    const dc = String(caps.device_class || attrs.device_class || '');
    const icon = getDomainIcon(dom, dc);
    const initialTab = options.tab || 'overview';
    const historyHours = Number(options.historyHours) || 24;

    if (iconEl) iconEl.className = `fas ${icon}`;
    if (labelEl) labelEl.textContent = entityDisplayName(entity) || entityId;

    body.innerHTML = `
      ${renderTabs(initialTab)}
      <div class="dashboard-more-info-tab-panel${initialTab !== 'overview' ? ' hidden' : ''}" data-more-info-panel="overview">
        ${renderEntityFriendlyNameSection(entity)}
        ${renderEntityModal(entity, slug, { omitMetaSections: true } as Record<string, unknown>)}
      </div>
      <div class="dashboard-more-info-tab-panel${initialTab !== 'history' ? ' hidden' : ''}" data-more-info-panel="history"></div>
      ${renderAttributesTab(entity, initialTab !== 'attributes')}
    `;

    wireEntityFriendlyNameEditor(body, entity, {
        onUpdated: ({ name }) => {
            entity.name = name;
            if (labelEl) labelEl.textContent = name;
        },
    });
    wireEntityRegistryEditor(body, entity, {
        onUpdated: ({ oldEntityId, newEntityId }) => {
            if (entity.entity_id === oldEntityId) entity.entity_id = newEntityId;
            openDashboardEntityMoreInfo({ ...widget, entity_id: newEntityId }, lookupEntity, options);
        },
    });

    body.querySelector('[data-role=more-info-tabs]')?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('[data-more-info-tab]') as HTMLElement | null;
        if (!btn) return;
        const tab = String(btn.dataset.moreInfoTab || 'overview') as MoreInfoTab;
        switchMoreInfoTab(tab, body, widget, entity, slug, historyHours);
    });

    if (modal.parentNode !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    if (initialTab === 'history') {
        switchMoreInfoTab('history', body, widget, entity, slug, historyHours);
    } else {
        startCameraPreviewRefresh();
    }
}

export function openDashboardEntityMoreInfoFromSpec(
    widget: DashboardWidgetLike,
    lookupEntity: (entityId: string) => HyveEntity | null,
    spec?: InteractionSpec,
): void {
    const tab = spec?.tab === 'history' || spec?.tab === 'attributes'
        ? spec.tab
        : 'overview';
    openDashboardEntityMoreInfo(widget, lookupEntity, {
        tab,
        historyHours: Number(spec?.hours) || 24,
    });
}

export function initDashboardEntityMoreInfoModal(): void {
    const { modal } = modalElements();
    if (!modal || modal.dataset.bound === 'true') return;
    modal.dataset.bound = 'true';
    modal.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('[data-dashboard-more-info-stop]')) return;
        if (target.closest('[data-dashboard-more-info-close]') || target === modal) {
            closeDashboardEntityMoreInfo();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (modal.classList.contains('hidden')) return;
        closeDashboardEntityMoreInfo();
    });
}
