/**
 * Dashboard layout normalization, localStorage view cache, and per-page snapshots.
 */

import { apiCall } from '../api.js';
import {
    DEFAULT_PREFS,
    DEFAULT_META,
    DASHBOARD_LOCAL_KEY,
    DASHBOARD_STANDALONE_PANEL_ID,
} from './constants.js';
import type { DashboardCache, DashboardPanel, DashboardWidget } from '../types/dashboard.js';

const DASHBOARD_PAGE_SNAPSHOTS_KEY = 'hyve.dash.pageSnapshots';
const DASHBOARD_PAGE_SNAPSHOTS_VERSION = '2';
const DASHBOARD_PAGE_SNAPSHOTS_VERSION_KEY = 'hyve.dash.pageSnapshots.v';
const DASHBOARD_PAGE_SNAPSHOTS_MAX = 24;

const _dashboardPageSnapshots = new Map<string, DashboardCache>();
let _dashboardPageSnapshotsHydrated = false;

export function isDashboardStandalonePanel(panel: DashboardPanel | null | undefined): boolean {
    return String(panel?.id || '') === DASHBOARD_STANDALONE_PANEL_ID || panel?.kind === 'standalone';
}

export function normalizeDashboardSectionPanels(
    rawPanels: DashboardPanel[] = [],
    rawWidgets: DashboardWidget[] = [],
): DashboardPanel[] {
    const panels = Array.isArray(rawPanels) ? rawPanels : [];
    const sectionPanels: DashboardPanel[] = [];
    const standaloneWidgets: DashboardWidget[] = [];
    panels.forEach((panel) => {
        if (!panel || typeof panel !== 'object') return;
        const copy: DashboardPanel = { ...panel, widgets: Array.isArray(panel.widgets) ? panel.widgets : [] };
        if (isDashboardStandalonePanel(copy)) standaloneWidgets.push(...(copy.widgets || []));
        else sectionPanels.push(copy);
    });
    if (sectionPanels.length) {
        if (standaloneWidgets.length) {
            sectionPanels[0] = {
                ...sectionPanels[0],
                widgets: [...standaloneWidgets, ...(sectionPanels[0].widgets || [])],
            };
        }
        return sectionPanels;
    }
    const looseWidgets = !panels.length && Array.isArray(rawWidgets) ? rawWidgets : [];
    const widgets = [...standaloneWidgets, ...looseWidgets];
    if (!widgets.length) return [];
    return [{
        id: 'panel_1',
        title: 'Panou',
        size: 'wide',
        icon: '',
        pages: [],
        show_pagination: true,
        widgets,
    }];
}

export function normalizeCache(payload: Record<string, unknown> = {}): DashboardCache {
    const panels = normalizeDashboardSectionPanels(
        payload.panels as DashboardPanel[] | undefined,
        payload.widgets as DashboardWidget[] | undefined,
    );
    const prefs = { ...DEFAULT_PREFS, ...((payload.preferences || {}) as object) };
    return {
        widgets: panels.flatMap((panel) => (Array.isArray(panel.widgets) ? panel.widgets : [])),
        available_entities: Array.isArray(payload.available_entities) ? payload.available_entities as DashboardCache['available_entities'] : [],
        preferences: prefs,
        title: String(payload.title || DEFAULT_META.title),
        subtitle: String(payload.subtitle || DEFAULT_META.subtitle),
        pages: Array.isArray(payload.pages) ? payload.pages as DashboardCache['pages'] : [],
        panels,
        page_id: (payload.page_id as string | null) || null,
        current_page_id: (payload.current_page_id as string | null) || (payload.page_id as string | null) || null,
        default_page_id: (payload.default_page_id as string | null) || null,
        icon: String(payload.icon || ''),
        columns: Number.isFinite(payload.columns as number) ? Number(payload.columns) : 0,
    };
}

function dashboardViewCachePayload(payload: Record<string, unknown> = {}): DashboardCache & { cached_at: number } {
    const normalized = normalizeCache(payload);
    return {
        ...normalized,
        available_entities: [],
        cached_at: Date.now(),
    };
}

export function saveDashboardViewCache(payload: Record<string, unknown>): void {
    try {
        localStorage.setItem(DASHBOARD_LOCAL_KEY, JSON.stringify(dashboardViewCachePayload(payload)));
    } catch { /* ignore */ }
}

export function readDashboardViewCache(): DashboardCache | null {
    try {
        const raw = localStorage.getItem(DASHBOARD_LOCAL_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const normalized = normalizeCache(parsed);
        if (!normalized.panels.length && !normalized.widgets.length && !normalized.pages.length) return null;
        return normalized;
    } catch {
        return null;
    }
}

function hydrateDashboardPageSnapshots(): void {
    if (_dashboardPageSnapshotsHydrated) return;
    _dashboardPageSnapshotsHydrated = true;
    try {
        const v = localStorage.getItem(DASHBOARD_PAGE_SNAPSHOTS_VERSION_KEY);
        if (v !== DASHBOARD_PAGE_SNAPSHOTS_VERSION) {
            localStorage.removeItem(DASHBOARD_PAGE_SNAPSHOTS_KEY);
            localStorage.setItem(DASHBOARD_PAGE_SNAPSHOTS_VERSION_KEY, DASHBOARD_PAGE_SNAPSHOTS_VERSION);
            return;
        }
        const raw = localStorage.getItem(DASHBOARD_PAGE_SNAPSHOTS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
            for (const [pid, snap] of Object.entries(parsed)) {
                const row = snap as DashboardCache;
                if (pid && snap && typeof snap === 'object' && Array.isArray(row.panels)) {
                    _dashboardPageSnapshots.set(String(pid), row);
                }
            }
        }
    } catch { /* ignore */ }
}

function persistDashboardPageSnapshots(): void {
    try {
        if (_dashboardPageSnapshots.size > DASHBOARD_PAGE_SNAPSHOTS_MAX) {
            const overflow = _dashboardPageSnapshots.size - DASHBOARD_PAGE_SNAPSHOTS_MAX;
            const keys = Array.from(_dashboardPageSnapshots.keys()).slice(0, overflow);
            for (const k of keys) _dashboardPageSnapshots.delete(k);
        }
        const obj: Record<string, DashboardCache> = {};
        for (const [pid, snap] of _dashboardPageSnapshots) obj[pid] = snap;
        localStorage.setItem(DASHBOARD_PAGE_SNAPSHOTS_KEY, JSON.stringify(obj));
    } catch { /* ignore */ }
}

export function stashDashboardPageSnapshot(pageId: string, cache: DashboardCache): void {
    if (!pageId || !cache) return;
    hydrateDashboardPageSnapshots();
    const lite: DashboardCache = {
        panels: cache.panels || [],
        widgets: cache.widgets || [],
        pages: cache.pages || [],
        preferences: cache.preferences || DEFAULT_PREFS,
        title: cache.title || DEFAULT_META.title,
        subtitle: cache.subtitle || DEFAULT_META.subtitle,
        icon: cache.icon || '',
        columns: cache.columns || 0,
        page_id: cache.page_id || pageId,
        current_page_id: cache.current_page_id || pageId,
        available_entities: [],
        cached_at: Date.now(),
    };
    _dashboardPageSnapshots.delete(String(pageId));
    _dashboardPageSnapshots.set(String(pageId), lite);
    persistDashboardPageSnapshots();
}

export function getDashboardPageSnapshot(pageId: string): DashboardCache | null {
    if (!pageId) return null;
    hydrateDashboardPageSnapshots();
    return _dashboardPageSnapshots.get(String(pageId)) || null;
}

export function dashboardSnapshotFingerprint(snap: DashboardCache | null): string {
    if (!snap) return '';
    try {
        return JSON.stringify({
            p: snap.panels,
            t: snap.title,
            s: snap.subtitle,
            i: snap.icon,
            c: snap.columns,
            pr: snap.preferences,
        });
    } catch { return String(Date.now()); }
}

export async function fetchDashboardPageSnapshot(pageId: string): Promise<DashboardCache | null> {
    if (!pageId) return null;
    try {
        const params = new URLSearchParams();
        params.set('page_id', pageId);
        params.set('include_entities', 'false');
        const res = await apiCall(`/api/dashboard/widgets?${params.toString()}`);
        if (!res.ok) return null;
        const payload = await res.json() as Record<string, unknown>;
        const normalized = normalizeCache(payload);
        stashDashboardPageSnapshot(pageId, normalized);
        return normalized;
    } catch { return null; }
}
