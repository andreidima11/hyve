/**
 * Dashboard page selection — snapshot paint, network reconcile, stale-nav guard.
 */

import { DASHBOARD_LAST_PAGE_KEY } from './constants.js';
import { dashboardSnapshotFingerprint, getDashboardPageSnapshot } from './dashboard_cache.js';
import { escapeHtml } from './helpers.js';

/** @type {object | null} */
let _deps = null;
let _pageNavToken = 0;

function deps() {
    if (!_deps) throw new Error('Dashboard page select not initialized');
    return _deps;
}

export function initDashboardPageSelect(depsIn) {
    _deps = depsIn;
}

/** Invalidate in-flight page switches (tab leave, edit reset). */
export function abortDashboardPageNavigation() {
    _pageNavToken += 1;
}

export async function selectDashboardPage(pageId) {
    if (!pageId) return;
    const d = deps();
    const myToken = ++_pageNavToken;
    d.setCurrentPageId(String(pageId));
    const currentPageId = d.getCurrentPageId();
    try { localStorage.setItem(DASHBOARD_LAST_PAGE_KEY, currentPageId); } catch (_) {}
    d.setHashForPage(currentPageId);

    try {
        const cache = d.getCache();
        const pages = Array.isArray(cache.pages) ? cache.pages : [];
        const target = pages.find(p => p && String(p.id) === String(pageId));
        const eagerTitle = (target && target.title) || '';
        if (eagerTitle) {
            const headerTitleEl = document.getElementById('current-view-title');
            if (headerTitleEl) headerTitleEl.textContent = eagerTitle;
            const pageTitleEl = document.getElementById('dashboard-page-title');
            if (pageTitleEl) pageTitleEl.textContent = eagerTitle;
            try { localStorage.setItem('hyve.lastDashboardTitle', eagerTitle); } catch (_) {}
        }
    } catch (_) {}

    const grid = document.getElementById('dashboard-grid');
    if (grid) {
        grid.style.transition = 'opacity 0.14s ease';
        grid.style.opacity = '0.4';
    }

    let renderedFromSnapshot = false;
    let snapFp = null;
    try {
        const snap = getDashboardPageSnapshot(d.getCurrentPageId());
        if (snap) {
            const prev = d.getCache();
            d.setCache({
                ...snap,
                available_entities: Array.isArray(prev.available_entities)
                    ? prev.available_entities
                    : [],
            });
            const cache = d.getCache();
            if (cache.page_id) d.setCurrentPageId(cache.page_id);
            snapFp = dashboardSnapshotFingerprint(snap);
            d.renderDashboard();
            renderedFromSnapshot = true;
            if (grid) requestAnimationFrame(() => { grid.style.opacity = '1'; });
        }
    } catch (_) {}

    const t = d.t;
    if (!renderedFromSnapshot && grid && !grid.firstElementChild) {
        grid.innerHTML = `<div class="col-span-full p-6 text-sm" style="color:var(--text-tertiary,#94a3b8);">${escapeHtml(t('dashboard.loading_page'))}</div>`;
    }
    d.setDashboardRefreshIndicator(true);

    const watchdog = setTimeout(() => {
        if (myToken !== _pageNavToken) return;
        const g = document.getElementById('dashboard-grid');
        if (!g) return;
        if (g.textContent.includes(t('dashboard.loading_page'))) {
            g.innerHTML = `<div class="col-span-full p-6 text-sm rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-200">
                <div class="font-semibold mb-1">${escapeHtml(t('dashboard.page_load_timeout'))}</div>
                <button type="button" data-dash-action="selectPage" data-page-id="${String(pageId).replace(/'/g, "\\'")}" class="mt-2 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-xs font-semibold">${escapeHtml(t('common.try_again'))}</button>
            </div>`;
        }
    }, 12000);

    try {
        await d.withDashboardTimeout(
            d.refreshAvailableEntities({ includeEntities: false }),
            8000,
            t('dashboard.refresh_timeout')
        );
        if (myToken !== _pageNavToken) { if (watchdog) clearTimeout(watchdog); return; }
        const freshFp = dashboardSnapshotFingerprint(d.getCache());
        if (!renderedFromSnapshot || freshFp !== snapFp) d.renderDashboard();
        if (grid) requestAnimationFrame(() => { grid.style.opacity = '1'; });
    } catch (e) {
        if (myToken !== _pageNavToken) { if (watchdog) clearTimeout(watchdog); return; }
        if (e && e.name === 'DashboardRefreshAbortError') {
            if (watchdog) clearTimeout(watchdog);
            return;
        }
        console.error('[dashboard] selectDashboardPage refresh failed:', e);
        const gridNow = document.getElementById('dashboard-grid');
        const gridHasContent = !!(gridNow && gridNow.firstElementChild && !gridNow.textContent.includes(t('dashboard.loading_page')));
        if (gridHasContent) {
            d.showToast(t('dashboard.refresh_failed', { message: e.message || t('common.unknown_error') }), 'error');
        } else if (gridNow) {
            gridNow.innerHTML = `<div class="col-span-full p-6 text-sm rounded-2xl border border-red-500/20 bg-red-500/10 text-red-300">
                <div class="font-semibold mb-1">${escapeHtml(t('dashboard.load_failed_page'))}</div>
                <div class="text-xs opacity-80 mb-2">${escapeHtml(e.message || t('dashboard.unknown_error'))}</div>
                <button type="button" data-dash-action="selectPage" data-page-id="${String(pageId).replace(/'/g, "\\'")}" class="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs font-semibold">${escapeHtml(t('common.try_again'))}</button>
            </div>`;
        }
    } finally {
        if (watchdog) clearTimeout(watchdog);
        if (myToken === _pageNavToken) d.setDashboardRefreshIndicator(false);
        const gridEl = document.getElementById('dashboard-grid');
        if (gridEl) gridEl.style.opacity = '1';
    }
}
