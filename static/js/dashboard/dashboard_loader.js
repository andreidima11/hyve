/**
 * Dashboard load/refresh — fetch layout, entity list, and orchestrate grid paint.
 */

import { apiCall } from '../api.js';
import { getCameraStreamToken } from '../camera_auth.js';
import {
    DEFAULT_PREFS,
    DEFAULT_META,
    DASHBOARD_LOCAL_KEY,
    DASHBOARD_LAST_PAGE_KEY,
} from './constants.js';
import {
    normalizeCache,
    saveDashboardViewCache,
    stashDashboardPageSnapshot,
    dashboardSnapshotFingerprint,
} from './dashboard_cache.js';
import { dashApiError } from './helpers.js';
import { bindHashRouter, readHashPageId, setHashForPage } from './pages_nav.js';

/** @type {object | null} */
let _deps = null;

let _loadInFlight = null;
let _loadStartedAt = 0;
let _loadAbortController = null;
let _refreshIndicatorSafetyTimer = null;

function deps() {
    if (!_deps) throw new Error('Dashboard loader not initialized');
    return _deps;
}

export function initDashboardLoader(depsIn) {
    _deps = depsIn;
}

export function setDashboardRefreshIndicator(active) {
    let bar = document.getElementById('dashboard-refresh-bar');
    if (!bar) {
        const grid = document.getElementById('dashboard-grid');
        if (!grid || !grid.parentElement) return;
        bar = document.createElement('div');
        bar.id = 'dashboard-refresh-bar';
        bar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent,#6366f1),transparent);background-size:200% 100%;animation:hyveDashRefresh 1.1s linear infinite;opacity:0;transition:opacity .2s;z-index:5;pointer-events:none;';
        if (!document.getElementById('hyve-dash-refresh-style')) {
            const st = document.createElement('style');
            st.id = 'hyve-dash-refresh-style';
            st.textContent = '@keyframes hyveDashRefresh{0%{background-position:200% 0}100%{background-position:-200% 0}}';
            document.head.appendChild(st);
        }
        const host = grid.parentElement;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(bar);
    }
    bar.style.opacity = active ? '1' : '0';
    if (_refreshIndicatorSafetyTimer) {
        clearTimeout(_refreshIndicatorSafetyTimer);
        _refreshIndicatorSafetyTimer = null;
    }
    if (active) {
        _refreshIndicatorSafetyTimer = setTimeout(() => {
            const b = document.getElementById('dashboard-refresh-bar');
            if (b) b.style.opacity = '0';
            _refreshIndicatorSafetyTimer = null;
        }, 15000);
    }
}

export function withDashboardTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || 'Dashboard refresh timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function fetchDashboardLayoutJson(url, timeoutMs = 8000, externalSignal = null) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    const onExternalAbort = () => {
        try { ctrl.abort(); } catch (_) {}
    };
    if (externalSignal) {
        if (externalSignal.aborted) onExternalAbort();
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const headers = {};
    const token = localStorage.getItem('hyve_token') || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        let res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) {
            const refreshToken = localStorage.getItem('hyve_refresh_token') || '';
            if (refreshToken) {
                const refreshRes = await fetch('/api/token/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: refreshToken }),
                    signal: ctrl.signal,
                });
                if (refreshRes.ok) {
                    const data = await refreshRes.json();
                    if (data?.access_token) localStorage.setItem('hyve_token', data.access_token);
                    if (data?.refresh_token) localStorage.setItem('hyve_refresh_token', data.refresh_token);
                    headers.Authorization = `Bearer ${data.access_token}`;
                    res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
                }
            }
        }
        if (!res.ok) throw new Error(`Dashboard page request failed (${res.status})`);
        return await res.json();
    } catch (err) {
        if (err && err.name === 'AbortError') {
            if (timedOut) throw new Error('Refresh-ul dashboardului a expirat.');
            const abortErr = new Error('Dashboard refresh superseded.');
            abortErr.name = 'DashboardRefreshAbortError';
            throw abortErr;
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
        if (externalSignal) {
            try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
        }
    }
}

export async function readDashboardSectionFallback() {
    try {
        const res = await apiCall('/api/config');
        if (res.ok) {
            const cfg = await res.json();
            const section = cfg?.dashboard || {};
            const result = {
                widgets: Array.isArray(section.widgets) ? section.widgets : [],
                panels: Array.isArray(section.panels) ? section.panels : [],
                pages: Array.isArray(section.pages) ? section.pages : [],
                preferences: { ...DEFAULT_PREFS, ...(section.preferences || {}) },
                title: String(section.title || DEFAULT_META.title),
                subtitle: String(section.subtitle || DEFAULT_META.subtitle),
                icon: String(section.icon || ''),
                columns: Number(section.columns || 0) || 0,
            };
            try { localStorage.setItem(DASHBOARD_LOCAL_KEY, JSON.stringify(result)); } catch (_) {}
            return result;
        }
    } catch (_) {}

    try {
        const localRaw = localStorage.getItem(DASHBOARD_LOCAL_KEY);
        if (localRaw) {
            const parsed = JSON.parse(localRaw);
            return {
                widgets: Array.isArray(parsed.widgets) ? parsed.widgets : [],
                panels: Array.isArray(parsed.panels) ? parsed.panels : [],
                pages: Array.isArray(parsed.pages) ? parsed.pages : [],
                preferences: { ...DEFAULT_PREFS, ...(parsed.preferences || {}) },
                title: String(parsed.title || DEFAULT_META.title),
                subtitle: String(parsed.subtitle || DEFAULT_META.subtitle),
                icon: String(parsed.icon || ''),
                columns: Number(parsed.columns || 0) || 0,
            };
        }
    } catch (_) {}

    return {
        widgets: [],
        panels: [],
        pages: [],
        preferences: { ...DEFAULT_PREFS },
        title: DEFAULT_META.title,
        subtitle: DEFAULT_META.subtitle,
        icon: '',
        columns: 0,
    };
}

export async function writeDashboardSectionFallback(section) {
    const payload = {
        widgets: Array.isArray(section.widgets) ? section.widgets : [],
        panels: Array.isArray(section.panels) ? section.panels : [],
        pages: Array.isArray(section.pages) ? section.pages : [],
        preferences: { ...DEFAULT_PREFS, ...(section.preferences || {}) },
        title: String(section.title || DEFAULT_META.title),
        subtitle: String(section.subtitle || DEFAULT_META.subtitle),
        icon: String(section.icon || ''),
        columns: Number(section.columns || 0) || 0,
    };

    const res = await apiCall('/api/config', {
        method: 'PATCH',
        body: { dashboard: payload },
    });
    if (!res.ok && res.status !== 403) {
        const err = await res.json().catch(() => ({}));
        throw new Error(dashApiError(err.detail, 'dashboard.save_failed'));
    }

    try { localStorage.setItem(DASHBOARD_LOCAL_KEY, JSON.stringify(payload)); } catch (_) {}
}

export async function refreshAvailableEntities(options = {}) {
    const d = deps();
    const includeEntities = options.includeEntities !== false;
    const externalSignal = options.signal || null;
    const cache = d.getDashboardCache();
    let fallbackSection = {
        widgets: cache.widgets || [],
        panels: cache.panels || [],
        pages: cache.pages || [],
        preferences: cache.preferences || DEFAULT_PREFS,
        title: cache.title || DEFAULT_META.title,
        subtitle: cache.subtitle || DEFAULT_META.subtitle,
        icon: cache.icon || '',
        columns: cache.columns || 0,
    };
    if (includeEntities) {
        try {
            fallbackSection = await readDashboardSectionFallback();
        } catch (_) {}
    }

    const currentPageId = d.getCurrentPageId();

    try {
        const params = new URLSearchParams();
        if (currentPageId) params.set('page_id', currentPageId);
        if (!includeEntities) params.set('include_entities', 'false');
        if (!includeEntities) params.set('_layout_refresh', String(Date.now()));
        const query = params.toString();
        const url = query ? `/api/dashboard/widgets?${query}` : '/api/dashboard/widgets';

        const applyNormalized = (payload, keepEntities = false) => {
            const normalized = normalizeCache(payload);
            if (keepEntities || !Array.isArray(payload.available_entities)) {
                normalized.available_entities = Array.isArray(cache.available_entities)
                    ? cache.available_entities
                    : [];
            }
            d.setDashboardCache(normalized);
            saveDashboardViewCache(normalized);
            if (normalized.page_id) d.setCurrentPageId(normalized.page_id);
            stashDashboardPageSnapshot(normalized.page_id || d.getCurrentPageId(), normalized);
            return normalized.available_entities;
        };

        if (!includeEntities) {
            const payload = await fetchDashboardLayoutJson(url, 20000, externalSignal);
            return applyNormalized(payload, true);
        }

        const res = await apiCall(url);
        if (res.ok) {
            const payload = await res.json();
            return applyNormalized(payload);
        }
    } catch (err) {
        if (!includeEntities) throw err;
    }

    const statesRes = await apiCall('/api/integrations/all-entities').catch(() => null);
    const states = statesRes && statesRes.ok ? await statesRes.json() : [];

    const items = (Array.isArray(states) ? states : [])
        .filter(raw => {
            const entityId = String(raw?.entity_id || '');
            const domain = entityId.includes('.') ? entityId.split('.', 1)[0] : '';
            return d.isControllableDomain(domain) || d.isInfoDomain(domain);
        })
        .map(raw => {
            const entityId = String(raw.entity_id || '');
            const attrs = raw.attributes || {};
            const name = attrs.friendly_name || entityId;
            const domain = entityId.split('.', 1)[0] || 'switch';
            const source = /zigbee|z2m/i.test(`${entityId} ${name}`) ? 'zigbee2mqtt' : 'unknown';
            return {
                entity_id: entityId,
                name,
                state: String(raw.state || 'unknown'),
                domain,
                source,
                aliases: [],
                unit: attrs.unit_of_measurement || '',
                controllable: d.isControllableDomain(domain),
            };
        })
        .sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`, 'ro'));

    d.setDashboardCache(normalizeCache({
        widgets: fallbackSection.widgets,
        panels: fallbackSection.panels,
        pages: fallbackSection.pages,
        preferences: fallbackSection.preferences,
        available_entities: items,
        title: fallbackSection.title,
        subtitle: fallbackSection.subtitle,
        icon: fallbackSection.icon,
        columns: fallbackSection.columns,
    }));
    return items;
}

function transientDashboardGridMatches(text) {
    const d = deps();
    const haystack = String(text || '');
    const patterns = [
        d.t('dashboard.loading_dashboard'),
        d.t('dashboard.loading_page'),
        d.t('dashboard.page_load_timeout'),
        d.t('dashboard.refresh_timeout'),
        d.t('dashboard.load_failed_short'),
        d.t('dashboard.load_error'),
    ];
    return patterns.some((p) => p && haystack.includes(p));
}

function dashboardGridHasRealContent(grid = document.getElementById('dashboard-grid')) {
    if (!grid || !grid.firstElementChild) return false;
    return !transientDashboardGridMatches(grid.textContent || '');
}

export function dashboardHasRenderedContent() {
    return dashboardGridHasRealContent();
}

export function abortPendingLoad() {
    try { _loadAbortController?.abort?.(); } catch (_) {}
    _loadInFlight = null;
    _loadStartedAt = 0;
    _loadAbortController = null;
}

export function loadDashboard(options = {}) {
    const force = !!options.force;
    const soft = !!options.soft;
    const now = Date.now();
    if (_loadInFlight && !force && (now - _loadStartedAt) < 12000) return _loadInFlight;
    if (_loadInFlight && (force || (now - _loadStartedAt) >= 12000)) {
        abortPendingLoad();
        setDashboardRefreshIndicator(false);
    }
    _loadStartedAt = now;
    _loadAbortController = new AbortController();
    _loadInFlight = loadDashboardImpl(_loadAbortController.signal, { soft }).finally(() => {
        _loadInFlight = null;
        _loadStartedAt = 0;
        _loadAbortController = null;
    });
    return _loadInFlight;
}

async function loadDashboardImpl(signal = null, { soft = false } = {}) {
    const d = deps();
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    setDashboardRefreshIndicator(false);
    d.applyDashboardEditAccess();
    if (!d.canEditDashboard() && d.getEditMode()) {
        d.resetDashboardEditingState();
    }
    bindHashRouter();
    const hashPage = readHashPageId();
    if (hashPage) {
        d.setCurrentPageId(hashPage);
    } else if (!d.getCurrentPageId()) {
        try {
            const storedPage = String(localStorage.getItem(DASHBOARD_LAST_PAGE_KEY) || '');
            if (storedPage) d.setCurrentPageId(storedPage);
        } catch (_) {}
    }

    const transientText = String(grid.textContent || '');
    if (grid.firstElementChild && transientDashboardGridMatches(transientText)) {
        grid.innerHTML = '';
    }

    const cache = d.getDashboardCache();
    const layoutFpBefore = dashboardSnapshotFingerprint(cache);
    const renderedFromCache = d.renderCachedDashboardIfEmpty();
    const hadRealContent = renderedFromCache || dashboardGridHasRealContent(grid);
    if (renderedFromCache) {
        try { d.resumeDashboardCameras(); } catch (_) {}
    }
    if (!renderedFromCache && !grid.firstElementChild) {
        grid.innerHTML = `<div class="col-span-full p-6 text-sm" style="color:var(--text-tertiary,#94a3b8);">${d.escapeHtml(d.t('dashboard.loading_dashboard'))}</div>`;
    }
    try {
        getCameraStreamToken().catch(() => {});
        await refreshAvailableEntities({ includeEntities: false, signal });
        if (d.getCurrentPageId()) setHashForPage(d.getCurrentPageId());
        const layoutFpAfter = dashboardSnapshotFingerprint(d.getDashboardCache());
        const layoutChanged = layoutFpBefore !== layoutFpAfter;
        if (!hadRealContent || layoutChanged || !soft) {
            d.renderDashboard();
        } else {
            try { d.configureHyveviewMounted(grid); } catch (_) {}
        }
        try { d.resumeDashboardCameras(); } catch (_) {}
        d.updateDashboardEntityOptions();
        d.connectDashboardLive();
    } catch (e) {
        if (e && (e.name === 'AbortError' || e.name === 'DashboardRefreshAbortError')) return;
        d.setEntitySelectState(d.t('dashboard.load_entities_failed'), true);
        const gridHasRealContent = !!grid.firstElementChild
            && !(grid.children.length === 1
                && transientDashboardGridMatches(grid.textContent || ''));
        if (!gridHasRealContent) {
            grid.innerHTML = `<div class="col-span-full rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">${d.escapeHtml(e.message || d.t('dashboard.load_error'))}</div>`;
        } else {
            try { console.warn('[dashboard] refresh failed, keeping cached cards:', e?.message || e); } catch (_) {}
        }
    }
}
