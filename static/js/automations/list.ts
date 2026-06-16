import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr } from '../utils.js';
import type { AutomationListItem } from '../types/features_automations.js';
import { listShellErrorHtml, listShellLoadingHtml, wireConfigListSearch } from '../config/list_shell.js';
import {
    automationDot,
    formatAutomationNextRun,
    formatAutoTimestamp,
    formatTriggerSource,
} from './format.js';

let _autoStatusTimer: ReturnType<typeof setInterval> | null = null;
let _automationsCache: AutomationListItem[] = [];
let _automationsListFilter = '';

function _startAutoStatusPoll(): void {
    _stopAutoStatusPoll();
    _autoStatusTimer = setInterval(_pollAutoStatuses, 3000);
}

function _stopAutoStatusPoll(): void {
    if (_autoStatusTimer) { clearInterval(_autoStatusTimer); _autoStatusTimer = null; }
}

export function switchIntelligenceTab(tabId: string) {
    document.querySelectorAll('.intelligence-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.intelligence-tab-btn').forEach(b => {
        b.classList.remove('border-accent', 'text-accent');
        b.classList.add('border-transparent', 'text-slate-500');
    });
    const panel = document.getElementById(`intelligence-panel-${tabId}`);
    const btn = document.getElementById(`intelligence-tab-${tabId}`);
    if (panel) panel.classList.remove('hidden');
    if (btn) {
        btn.classList.remove('border-transparent', 'text-slate-500');
        btn.classList.add('border-b-2', 'border-accent', 'text-accent');
    }
    if (tabId === 'automations') { _startAutoStatusPoll(); } else { _stopAutoStatusPoll(); }
}

let _autoMenuPortal: HTMLElement | null = null;

export function toggleAutoMenu(e: MouseEvent, defId: string, btnEl: HTMLElement) {
    e?.stopPropagation?.();
    const wasOpen = _autoMenuPortal?.dataset.defId === defId;
    closeAutoMenu();
    if (wasOpen) return;

    const src = document.getElementById(`auto-menu-${defId}`);
    if (!src) return;

    const btn = (btnEl || (e?.target as HTMLElement | null)?.closest?.('[data-memory-action="toggleAutoMenu"]')) as HTMLElement | null;
    if (!btn?.getBoundingClientRect) return;
    const r = btn.getBoundingClientRect();
    const portal = src.cloneNode(true) as HTMLElement;
    portal.id = 'auto-menu-portal';
    portal.dataset.defId = defId;
    portal.classList.remove('hidden');
    Object.assign(portal.style, { position: 'fixed', zIndex: '9999', top: (r.bottom + 4) + 'px', left: 'auto', right: 'auto' });
    document.body.appendChild(portal);
    _autoMenuPortal = portal;

    requestAnimationFrame(() => {
        const mw = portal.offsetWidth;
        let left = r.right - mw;
        if (left < 8) left = 8;
        if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw;
        portal.style.left = left + 'px';
    });
}

export function closeAutoMenu(): void {
    if (_autoMenuPortal) { _autoMenuPortal.remove(); _autoMenuPortal = null; }
}

let _autoDotTip: HTMLElement | null = null;

export function showAutoDotTooltip(e: MouseEvent, dotEl: HTMLElement) {
    e?.stopPropagation?.();
    const dot = (dotEl || (e?.target as HTMLElement | null)?.closest?.('[data-memory-hover="showAutoDotTooltip"], [data-memory-action="showAutoDotTooltip"]')) as HTMLElement | null;
    if (!dot) return;
    const label = dot.dataset.autoDotLabel || '';
    if (!label) return;
    hideAutoDotTooltip();
    const tip = document.createElement('div');
    tip.className = 'auto-dot-tooltip';
    tip.textContent = label;
    document.body.appendChild(tip);
    _autoDotTip = tip;
    const rect = dot.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2 - tip.offsetWidth / 2}px`;
    tip.style.top = `${rect.top - tip.offsetHeight - 6}px`;
    requestAnimationFrame(() => tip.classList.add('is-visible'));
}

export function hideAutoDotTooltip(): void {
    if (_autoDotTip) { _autoDotTip.remove(); _autoDotTip = null; }
}

document.addEventListener('click', () => { closeAutoMenu(); hideAutoDotTooltip(); });

async function _pollAutoStatuses(): Promise<void> {
    const panel = document.getElementById('intelligence-panel-automations');
    if (!panel || panel.classList.contains('hidden')) { _stopAutoStatusPoll(); return; }
    try {
        const res = await apiCall('/api/automations/definitions/statuses');
        if (!res.ok) return;
        const data = await res.json();
        for (const item of (data.items || [])) {
            const dot = document.querySelector(`[data-auto-dot="${CSS.escape(item.id)}"]`);
            const timeEl = document.querySelector(`[data-auto-last-time="${CSS.escape(item.id)}"]`);
            if (dot && typeof item.enabled === 'boolean') {
                const lastStatus = (item.last_run_status || '').trim().toLowerCase();
                let cls, label;
                if (!item.enabled) {
                    cls = 'auto-dot--yellow';
                    label = t('automations.disabled_badge');
                } else if (lastStatus === 'error') {
                    cls = 'auto-dot--red';
                    label = (t('automations.last_run_error_detail')) + (item.last_error ? ': ' + item.last_error : '');
                } else {
                    cls = 'auto-dot--green';
                    label = t('automations.enabled_badge');
                }
                dot.className = `auto-dot ${cls} shrink-0`;
                (dot as HTMLElement).dataset.autoDotLabel = label;
            }
            const ts = item.last_run_at ? formatAutoTimestamp(item.last_run_at) : '—';
            if (timeEl) timeEl.textContent = ts;
        }
    } catch (_) {}
}

function _filteredAutomations(): AutomationListItem[] {
    const q = _automationsListFilter;
    if (!q) return _automationsCache;
    return _automationsCache.filter((a) => {
        const hay = `${a.title || ''} ${a.id || ''} ${a.description || ''}`.toLowerCase();
        return hay.includes(q);
    });
}

function _ensureAutomationsSearch(): void {
    wireConfigListSearch('automations-search', (query) => {
        _automationsListFilter = query;
        _renderAutomationsList();
    });
}

function _renderAutomationsList(): void {
    const listEl = document.getElementById('automations-list');
    const emptyEl = document.getElementById('automations-empty');
    if (!listEl) return;

    if (!_automationsCache.length) {
        listEl.innerHTML = '';
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.innerHTML = `
                <i class="fas fa-robot hyd-list-placeholder__icon" aria-hidden="true"></i>
                <p>${escapeHtml(t('automations.empty'))}</p>
                <button type="button" data-memory-action="openAutomationEditor" class="hyd-btn hyd-btn--glow">
                    <i class="fas fa-plus" aria-hidden="true"></i><span>${escapeHtml(t('automations.new_button'))}</span>
                </button>`;
        }
        return;
    }

    const automations = _filteredAutomations();
    if (!automations.length) {
        listEl.innerHTML = '';
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.innerHTML = `<i class="fas fa-magnifying-glass hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('hy.entity_search_no_results'))}</p>`;
        }
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    listEl.innerHTML = automations.map((a: AutomationListItem) => {
        const defId = escapeHtml(a.id).replace(/"/g, '&quot;');
        const title = escapeHtml(a.title || a.id || '—');
        const desc = escapeHtml(a.description || '');
        const lastTime = a.last_run_at ? formatAutoTimestamp(String(a.last_run_at)) : '—';
        const nextTime = escapeHtml(formatAutomationNextRun(a));
        const toggleLabel = a.enabled ? t('automations.disable') : t('automations.enable');
        const toggleIcon = a.enabled ? 'fa-pause' : 'fa-play-circle';
        const sub = desc || escapeHtml(a.id || '');
        const meta = `<span class="hyd-row-badge">${escapeHtml(t('automations.last_run_label'))}: <span data-auto-last-time="${escapeHtmlAttr(a.id)}">${lastTime}</span></span><span class="hyd-row-badge">${escapeHtml(t('automations.next_run'))}: ${nextTime}</span>`;
        return `
            <article class="hyd-entity-row hyd-entity-row--static automation-card" data-automation-card="${escapeHtmlAttr(a.id)}" role="listitem">
                <span class="hyd-icon hyd-icon--list hyd-glow--default"><i class="fas fa-robot" aria-hidden="true"></i></span>
                <div class="hyd-entity-row__body">
                    <div class="hyd-entity-row__name">${title}</div>
                    <div class="hyd-entity-row__sub">${sub}</div>
                    <div class="hyd-entity-row__tags">${automationDot(a)}${meta}</div>
                </div>
                <div class="relative shrink-0">
                    <button type="button" data-memory-action="toggleAutoMenu" data-memory-def-id="${defId}" class="hyd-row-actions__btn" aria-label="Menu"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button>
                    <div id="auto-menu-${defId}" class="dashboard-more-menu hidden" style="width:200px">
                        <button type="button" data-memory-action="runAutomationDefinition" data-memory-def-id="${defId}" data-memory-close-menu="true" class="dashboard-more-menu__item"><i class="fas fa-play text-emerald-400"></i><span>${t('automations.run')}</span></button>
                        <button type="button" data-memory-action="openAutomationEditorFromList" data-memory-def-id="${defId}" data-memory-close-menu="true" class="dashboard-more-menu__item"><i class="fas fa-pen"></i><span>${t('automations.edit')}</span></button>
                        <button type="button" data-memory-action="toggleAutomationDefinition" data-memory-def-id="${defId}" data-memory-enabled="${!!a.enabled}" data-memory-revision="${a.revision || 1}" data-memory-close-menu="true" class="dashboard-more-menu__item"><i class="fas ${toggleIcon} text-amber-400"></i><span>${toggleLabel}</span></button>
                        <div class="dashboard-more-menu__sep"></div>
                        <button type="button" data-memory-action="deleteAutomation" data-memory-def-id="${defId}" data-memory-close-menu="true" class="dashboard-more-menu__item" style="color:var(--red-400,#f87171)"><i class="fas fa-trash-alt" style="color:inherit"></i><span>${t('automations.delete')}</span></button>
                    </div>
                </div>
            </article>`;
    }).join('');
}

export async function loadAutomations(): Promise<void> {
    _ensureAutomationsSearch();
    const listEl = document.getElementById('automations-list');
    const emptyEl = document.getElementById('automations-empty');
    if (!listEl) return;
    listEl.innerHTML = listShellLoadingHtml(escapeHtml(t('automations.loading')));
    if (emptyEl) emptyEl.classList.add('hidden');
    try {
        const res = await apiCall('/api/automations/definitions');
        const data = await res.json();
        _automationsCache = Array.isArray(data.items) ? data.items : [];
        _renderAutomationsList();
    } catch (e) {
        listEl.innerHTML = listShellErrorHtml(escapeHtml(t('automations.error')));
        if (emptyEl) emptyEl.classList.add('hidden');
    }
    const panel = document.getElementById('intelligence-panel-automations');
    if (panel && !panel.classList.contains('hidden')) _startAutoStatusPoll();
}

export async function refreshAutomationStatuses(): Promise<void> {
    await _pollAutoStatuses();
}

export async function loadAutomationEventLog(): Promise<void> {
    const logEl = document.getElementById('automation-event-log');
    if (!logEl) return;
    try {
        const res = await apiCall('/api/automations/definitions/events?limit=30');
        if (!res.ok) throw new Error();
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            logEl.innerHTML = `<p class="text-[11px] text-slate-500">${t('automations.event_log_empty')}</p>`;
            return;
        }
        logEl.innerHTML = items.map((r: Record<string, unknown>) => {
            const statusColor = r.status === 'ok' ? 'text-emerald-400' : r.status === 'error' ? 'text-red-400' : 'text-amber-400';
            const statusIcon = r.status === 'ok' ? 'fa-check' : r.status === 'error' ? 'fa-xmark' : 'fa-forward';
            const triggerLabel = formatTriggerSource(r.trigger_source);
            const timeStr = r.started_at ? formatAutoTimestamp(String(r.started_at)) : '—';
            return `<div class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/[0.02] transition-colors">
                <i class="fas ${statusIcon} ${statusColor} text-[9px] w-3 text-center shrink-0"></i>
                <span class="text-[12px] text-slate-200 font-medium truncate">${escapeHtml(r.title || r.automation_id)}</span>
                <span class="text-[10px] text-slate-500 shrink-0">${triggerLabel}</span>
                <span class="text-[10px] text-slate-500 ml-auto shrink-0">${timeStr}</span>
            </div>`;
        }).join('');
    } catch (_) {
        logEl.innerHTML = `<p class="text-[11px] text-red-400">${t('automations.event_log_error')}</p>`;
    }
}
