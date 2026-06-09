/**
 * Multi-page dashboard sidebar navigation and hash routing.
 */
import { DASHBOARD_PAGES_NAV_KEY, DASHBOARD_LAST_PAGE_KEY } from './constants.js';
let _deps = null;
let _hashRouterBound = false;
function deps() {
    if (!_deps)
        throw new Error('Dashboard pages nav not initialized');
    return _deps;
}
export function initDashboardPagesNav(depsIn) {
    _deps = depsIn;
}
function persistDashboardPagesNav(pages) {
    if (!Array.isArray(pages) || !pages.length)
        return;
    try {
        const compact = pages.map((page) => ({
            id: String(page.id || ''),
            title: String(page.title || ''),
            icon: String(page.icon || 'fa-table-cells-large'),
        })).filter((p) => p.id);
        if (compact.length)
            localStorage.setItem(DASHBOARD_PAGES_NAV_KEY, JSON.stringify(compact));
    }
    catch { /* ignore */ }
}
function readDashboardPagesNav() {
    try {
        const raw = localStorage.getItem(DASHBOARD_PAGES_NAV_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
export function renderDashboardPagesList() {
    const d = deps();
    const list = document.getElementById('dashboard-pages-list');
    const actions = document.getElementById('dashboard-root-page-actions');
    const rootSlot = document.getElementById('dashboard-root-page-slot');
    const rootBtn = document.getElementById('nav-dashboard');
    const cache = d.getDashboardCache();
    const pages = Array.isArray(cache.pages) ? cache.pages : [];
    const currentPageId = d.getCurrentPageId();
    const activeId = currentPageId || cache.current_page_id || cache.page_id || (pages[0] && pages[0].id) || null;
    const onDashTab = (() => {
        const view = document.getElementById('view-dashboard');
        return !!view && !view.classList.contains('hidden');
    })();
    if (!list)
        return;
    if (pages.length > 0) {
        rootSlot?.classList.add('hidden');
        rootBtn?.classList.remove('bg-white/10', 'text-accent', 'border-accent/10');
        list.classList.remove('hidden');
        list.innerHTML = pages.map((page) => {
            const id = String(page.id || '');
            const title = d.escape(page.title || 'Pagină');
            const iconClass = d.escape(d.iconClass(page.icon || 'fa-table-cells-large'));
            const isActive = onDashTab && id === activeId;
            const activeCls = isActive ? ' bg-white/10 text-accent border-accent/10' : '';
            return `
                <button type="button"
                    id="nav-dashboard-page-${id}"
                    class="nav-btn dashboard-page-nav-btn w-full flex items-center gap-2.5 sm:gap-3 p-2.5 sm:p-3 rounded-lg sm:rounded-xl text-slate-500 hover:text-slate-300 hover:bg-white/[0.03] active:bg-white/[0.06] transition-all group min-h-[40px]${activeCls}"
                    data-page-id="${id}"
                    data-dash-action="openPageNav" data-page-id="${id.replace(/'/g, "\\'")}"
                    title="${title}">
                    <i class="${iconClass} w-5 sm:w-5 flex-shrink-0 text-sm group-hover:text-accent transition-colors"></i>
                    <span class="font-medium text-sm truncate">${title}</span>
                </button>`;
        }).join('');
        persistDashboardPagesNav(pages);
    }
    else {
        rootSlot?.classList.remove('hidden');
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    if (actions) {
        actions.classList.add('hidden');
        actions.innerHTML = '';
    }
}
/** Hydrate sidebar nav from localStorage before the dashboard API responds. */
export function initDashboardSidebarNav() {
    const d = deps();
    const cache = d.getDashboardCache();
    const existing = Array.isArray(cache.pages) ? cache.pages : [];
    if (!existing.length) {
        const cached = d.readDashboardViewCache();
        const fromView = Array.isArray(cached?.pages) ? cached.pages : [];
        const fromNav = readDashboardPagesNav();
        const pages = fromView.length ? fromView : fromNav;
        if (pages.length) {
            d.setDashboardPages(pages);
            if (!d.getCurrentPageId()) {
                const pid = cached?.page_id || cached?.current_page_id;
                if (pid)
                    d.setCurrentPageId(String(pid));
                else {
                    try {
                        const stored = String(localStorage.getItem(DASHBOARD_LAST_PAGE_KEY) || '');
                        if (stored)
                            d.setCurrentPageId(stored);
                    }
                    catch { /* ignore */ }
                }
            }
        }
    }
    renderDashboardPagesList();
}
export function resolveCurrentDashboardPageId() {
    const d = deps();
    const cache = d.getDashboardCache();
    const pages = Array.isArray(cache.pages) ? cache.pages : [];
    const hasPage = (pageId) => !!pageId && (!pages.length || pages.some((page) => String(page?.id || '') === String(pageId)));
    const hashPage = readHashPageId();
    if (hasPage(hashPage)) {
        d.setCurrentPageId(String(hashPage));
        return d.getCurrentPageId() || '';
    }
    const activeBtn = Array.from(document.querySelectorAll('.dashboard-page-nav-btn')).find((btn) => btn.classList.contains('bg-white/10')
        || btn.classList.contains('text-accent')
        || btn.classList.contains('border-accent/10'));
    const activeDomPage = activeBtn?.dataset?.pageId || '';
    if (hasPage(activeDomPage)) {
        d.setCurrentPageId(String(activeDomPage));
        return d.getCurrentPageId() || '';
    }
    let storedPage = '';
    try {
        storedPage = String(localStorage.getItem(DASHBOARD_LAST_PAGE_KEY) || '');
    }
    catch { /* ignore */ }
    if (hasPage(storedPage)) {
        d.setCurrentPageId(String(storedPage));
        return d.getCurrentPageId() || '';
    }
    const cachedPage = d.getCurrentPageId() || cache.current_page_id || cache.page_id || (pages[0] && pages[0].id) || '';
    if (hasPage(String(cachedPage || ''))) {
        d.setCurrentPageId(String(cachedPage));
        return d.getCurrentPageId() || '';
    }
    return '';
}
export async function openDashboardPageNav(pageId) {
    const d = deps();
    const view = document.getElementById('view-dashboard');
    const onDash = !!view && !view.classList.contains('hidden');
    if (pageId) {
        try {
            setHashForPage(String(pageId));
        }
        catch { /* ignore */ }
    }
    if (!onDash) {
        d.switchTab('dashboard', { syncHash: false });
    }
    if (pageId)
        await d.selectDashboardPage(pageId);
    if (window.innerWidth < 1024 && (typeof d.isSidebarOpen !== 'function' || d.isSidebarOpen())) {
        d.closeSidebar();
    }
}
export function setHashForPage(pageId) {
    if (!pageId)
        return;
    const desired = `/dashboard/${encodeURIComponent(String(pageId))}`;
    const current = (window.location.hash || '').replace(/^#/, '');
    if (current === desired || current === desired.slice(1))
        return;
    window.location.hash = desired;
}
export function readHashPageId() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const match = hash.match(/^\/?dashboard\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}
export function bindHashRouter() {
    const d = deps();
    if (_hashRouterBound)
        return;
    _hashRouterBound = true;
    window.addEventListener('hashchange', () => {
        const grid = document.getElementById('dashboard-grid');
        if (!grid)
            return;
        const onDashTab = (() => {
            const view = document.getElementById('view-dashboard');
            return !!view && !view.classList.contains('hidden');
        })();
        if (!onDashTab)
            return;
        const pageFromHash = readHashPageId();
        if (pageFromHash && pageFromHash !== d.getCurrentPageId()) {
            void d.selectDashboardPage(pageFromHash);
        }
    });
}
