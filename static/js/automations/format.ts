import { localeTag, t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr } from '../utils.js';
import type { AutomationListItem } from '../types/features_automations.js';

export function formatAutomationNextRun(item: AutomationListItem) {
    const nextRuns = Array.isArray(item?.next_runs) ? item.next_runs : [];
    const nextRunAt = nextRuns[0]?.next_run_at;
    if (!nextRunAt) return '—';
    try {
        return new Date(nextRunAt.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return nextRunAt;
    }
}

export function formatAutomationUpdatedAt(item: AutomationListItem) {
    if (!item?.updated_at) return '—';
    try {
        return new Date(item.updated_at.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return item.updated_at;
    }
}

export function formatAutomationHistoryAt(value: unknown) {
    if (!value) return '—';
    try {
        return new Date(String(value).replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return String(value);
    }
}

export function automationDot(item: AutomationListItem) {
    const defId = item?.id || '';
    const enabled = !!item?.enabled;
    const lastStatus = (item?.last_run_status || '').trim().toLowerCase();
    let color, label;
    if (!enabled) {
        color = 'auto-dot--yellow';
        label = t('automations.disabled_badge');
    } else if (lastStatus === 'error') {
        color = 'auto-dot--red';
        label = (t('automations.last_run_error_detail')) + (item?.last_error ? ': ' + item.last_error : '');
    } else {
        color = 'auto-dot--green';
        label = t('automations.enabled_badge');
    }
    return `<span class="auto-dot ${color} shrink-0" data-auto-dot="${escapeHtmlAttr(defId)}" data-auto-dot-label="${escapeHtmlAttr(label)}" data-memory-action="showAutoDotTooltip" data-memory-hover="showAutoDotTooltip"></span>`;
}

export function formatAutoTimestamp(isoStr: string) {
    if (!isoStr) return '';
    try {
        const d = new Date(isoStr);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        if (diffMs < 60000) return 'acum';
        if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)} min`;
        if (diffMs < 86400000) {
            return d.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
}

export function automationRunStatusBadge(status: string) {
    const normalized = String(status || '').trim().toLowerCase();
    const map: Record<string, string> = {
        ok: 'text-emerald-400/90 bg-emerald-500/15',
        skipped: 'text-amber-400/90 bg-amber-500/15',
        error: 'text-red-400/90 bg-red-500/15',
    };
    const labelMap: Record<string, string> = {
        ok: t('automations.history_status_ok'),
        skipped: t('automations.history_status_skipped'),
        error: t('automations.history_status_error'),
    };
    return `<span class="text-[9px] font-bold uppercase tracking-wider ${map[normalized] || 'text-slate-400 bg-slate-500/10'} px-2 py-0.5 rounded">${labelMap[normalized] || escapeHtml(normalized || '—')}</span>`;
}

export function formatTriggerSource(src: unknown) {
    if (!src) return '';
    if (src === 'manual') return t('automations.trigger_manual');
    if (typeof src === 'string' && src.startsWith('trigger:')) return t('automations.trigger_auto');
    return escapeHtml(String(src));
}
