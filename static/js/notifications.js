import { apiCall, getSSEToken } from './api.js';
import { escapeHtml, showConfirm, showToast } from './utils.js';
import { t } from './lang/index.js';
import { switchTab, openConfigSection } from './nav_bridge.js';
import { refreshUpdatesHeaderBadge } from './features_addons_settings.js';
import { installHyveNativeBridge } from './native_bridge.js';
let _currentFilter = 'all';
let _notificationPage = 1;
let _notificationTotal = 0;
let _ws = null;
let _wsReconnectAttempts = 0;
let _wsReconnectTimer = null;
let _wsEnabled = true;
let _connectInFlight = null;
let _countPollTimer = null;
let _wsWatchdogTimer = null;
let _lastKnownUnread = 0;
const _filters = ['all', 'unread', 'reminder', 'automation', 'system', 'archived'];
const _notificationPageSize = 10;
function _filterLabel(filter) {
    const key = `notifications.filter_${filter}`;
    const val = t(key);
    return val === key ? t('notifications.filter_all') : val;
}
function _viewLabel(filter) {
    return filter === 'archived' ? t('notifications.view_archive') : t('notifications.view_inbox');
}
const _fallbackCountPollMs = 12000;
const _watchdogMs = 5000;
function _playNotificationCue() {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass)
            return;
        const ctx = new AudioContextClass();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const now = ctx.currentTime;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.2);
        setTimeout(() => { try {
            ctx.close();
        }
        catch (_) { } }, 320);
    }
    catch (_) { }
}
window.__hyvePlayNotificationCue = _playNotificationCue;
function _setText(id, value) {
    const el = document.getElementById(id);
    if (el)
        el.textContent = value;
}
function _isNotificationsPanelVisible() {
    const userView = document.getElementById('view-user');
    const panel = document.getElementById('user-tab-panel-notifications');
    return !!(userView && panel && !userView.classList.contains('hidden') && !panel.classList.contains('hidden'));
}
function _stateForFilter(filter) {
    if (filter === 'archived')
        return 'archived';
    return filter === 'unread' ? 'unread' : 'all';
}
function _normalizeFilter(filter) {
    return _filters.includes(filter) ? filter : 'all';
}
function _pageCount(total = _notificationTotal) {
    return Math.max(1, Math.ceil(Number(total || 0) / _notificationPageSize));
}
function _clampPage(page, total = _notificationTotal) {
    const value = typeof page === 'number'
        ? page
        : Number.parseInt(String(page ?? ''), 10);
    const safePage = Number.isFinite(value) ? value : 1;
    return Math.min(Math.max(1, safePage), _pageCount(total));
}
function _categoryForFilter(filter) {
    return ['reminder', 'automation', 'system'].includes(filter) ? filter : '';
}
function _setFilterMenuOpen(open) {
    const menu = document.getElementById('user-notifications-filter-menu');
    const button = document.getElementById('user-notifications-filter-button');
    if (menu)
        menu.classList.toggle('hidden', !open);
    if (button)
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
}
export function toggleUserNotificationFilterMenu(open) {
    const menu = document.getElementById('user-notifications-filter-menu');
    const next = typeof open === 'boolean' ? open : !!menu?.classList.contains('hidden');
    _setFilterMenuOpen(next);
}
function _syncFilterButtons() {
    _setText('user-notifications-filter-label', _filterLabel(_currentFilter));
    _setText('user-notifications-view-label', _viewLabel(_currentFilter));
    document.querySelectorAll('[data-user-notification-filter]').forEach((btn) => {
        const active = btn.getAttribute('data-user-notification-filter') === _currentFilter;
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
        btn.classList.toggle('bg-accent/10', active);
        btn.classList.toggle('text-accent', active);
        btn.classList.toggle('text-slate-300', !active);
        btn.querySelector('.fa-check')?.classList.toggle('opacity-0', !active);
    });
}
function _formatDate(value) {
    if (!value)
        return '—';
    try {
        return new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    }
    catch (_) {
        return value;
    }
}
function _dayGroup(value) {
    if (!value)
        return t('notifications.group_older');
    const date = new Date(value);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const days = Math.round((startToday.getTime() - startDate.getTime()) / 86400000);
    if (days === 0)
        return t('notifications.group_today');
    if (days === 1)
        return t('notifications.group_yesterday');
    if (days < 7)
        return t('notifications.group_this_week');
    return t('notifications.group_older');
}
function _categoryLabel(category) {
    const key = `notifications.category_${String(category || '').trim().toLowerCase()}`;
    const val = t(key);
    return val !== key ? val : (category || t('notifications.category_default'));
}
function _severityClasses(severity) {
    if (severity === 'warning')
        return 'border-amber-500/20 text-amber-300 bg-amber-500/10';
    if (severity === 'critical' || severity === 'error')
        return 'border-red-500/20 text-red-300 bg-red-500/10';
    if (severity === 'success')
        return 'border-emerald-500/20 text-emerald-300 bg-emerald-500/10';
    return 'border-blue-500/20 text-blue-300 bg-blue-500/10';
}
export function updateNotificationBadge(count) {
    const value = Number(count || 0);
    _lastKnownUnread = value;
    const badge = document.getElementById('nav-user-notification-badge');
    const tabCount = document.getElementById('user-tab-notification-count');
    const unreadCount = document.getElementById('user-notifications-unread-count');
    const label = value > 9 ? '9+' : String(value);
    if (badge) {
        badge.textContent = label;
        badge.setAttribute('aria-label', value > 0 ? t('notifications.unread_badge_aria', { count: value }) : t('notifications.unread_badge_none'));
        badge.classList.toggle('hidden', value <= 0);
    }
    if (tabCount) {
        tabCount.textContent = label;
        tabCount.setAttribute('aria-label', value > 0 ? t('notifications.unread_badge_aria', { count: value }) : t('notifications.unread_badge_none'));
        tabCount.classList.toggle('hidden', value <= 0);
    }
    if (unreadCount)
        unreadCount.textContent = String(value);
}
export async function loadNotificationCounts() {
    try {
        const res = await apiCall('/api/notifications/counts');
        if (!res.ok)
            return;
        const data = await res.json();
        updateNotificationBadge(data.unread_count || 0);
    }
    catch (_) { }
}
export function switchUserNotificationFilter(filter = 'all') {
    _currentFilter = _normalizeFilter(filter);
    _notificationPage = 1;
    _setFilterMenuOpen(false);
    _syncFilterButtons();
    loadUserNotifications(_currentFilter, { page: 1 });
}
export async function loadUserNotifications(filter = _currentFilter, options = {}) {
    const nextFilter = _normalizeFilter(filter);
    if (nextFilter !== _currentFilter)
        _notificationPage = 1;
    _currentFilter = nextFilter;
    if (Object.prototype.hasOwnProperty.call(options, 'page')) {
        _notificationPage = _clampPage(options.page);
    }
    const listEl = document.getElementById('user-notifications-list');
    const emptyEl = document.getElementById('user-notifications-empty');
    const statusEl = document.getElementById('user-notifications-status');
    if (!listEl)
        return;
    _syncFilterButtons();
    if (statusEl)
        statusEl.textContent = t('notifications.loading');
    emptyEl?.classList.add('hidden');
    try {
        const offset = (_notificationPage - 1) * _notificationPageSize;
        const params = new URLSearchParams({
            state: _stateForFilter(_currentFilter),
            limit: String(_notificationPageSize),
            offset: String(offset),
        });
        const category = _categoryForFilter(_currentFilter);
        if (category)
            params.set('category', category);
        const res = await apiCall(`/api/notifications?${params.toString()}`);
        if (!res.ok)
            throw new Error('load failed');
        const data = await res.json();
        const total = Number(data.total || 0);
        if (total > 0 && _notificationPage > _pageCount(total)) {
            _notificationPage = _pageCount(total);
            return loadUserNotifications(_currentFilter);
        }
        if (total <= 0)
            _notificationPage = 1;
        _notificationTotal = total;
        updateNotificationBadge(data.unread_count || 0);
        _renderNotifications(data.items || [], total);
        if (statusEl) {
            if (total > _notificationPageSize && (data.items || []).length) {
                const start = ((_notificationPage - 1) * _notificationPageSize) + 1;
                const end = Math.min(start + (data.items || []).length - 1, total);
                statusEl.textContent = t('notifications.status_range', { start, end, total });
            }
            else {
                statusEl.textContent = t('notifications.status_total', { total });
            }
        }
    }
    catch (_) {
        listEl.innerHTML = `<div class="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">${escapeHtml(t('notifications.load_error'))}</div>`;
        if (statusEl)
            statusEl.textContent = t('notifications.status_error');
    }
}
export async function changeUserNotificationsPage(delta) {
    const step = Number.parseInt(String(delta), 10);
    const nextPage = _clampPage(_notificationPage + (Number.isFinite(step) ? step : 0));
    if (nextPage === _notificationPage)
        return;
    _notificationPage = nextPage;
    await loadUserNotifications(_currentFilter);
}
function _renderNotifications(items, total = _notificationTotal) {
    const listEl = document.getElementById('user-notifications-list');
    const emptyEl = document.getElementById('user-notifications-empty');
    if (!listEl)
        return;
    if (!items.length) {
        listEl.innerHTML = '';
        emptyEl?.classList.remove('hidden');
        return;
    }
    emptyEl?.classList.add('hidden');
    let currentGroup = '';
    let renderedClearAll = false;
    const html = [];
    for (const item of items) {
        const group = _dayGroup(item.created_at);
        if (group !== currentGroup) {
            currentGroup = group;
            if (_currentFilter !== 'archived' && !renderedClearAll) {
                renderedClearAll = true;
                html.push(`
                    <div class="pt-2 flex items-center justify-between gap-3">
                        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-500">${escapeHtml(group)}</span>
                        <button type="button" data-user-action="notifClearAll" data-i18n-title="notifications.clear_inbox_title" title="${escapeHtml(t('notifications.clear_inbox_title'))}" class="inline-flex h-8 items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 text-[11px] font-bold text-red-300 hover:bg-red-500/20 hover:text-red-200 transition-colors">
                            <i class="fas fa-trash text-[10px]"></i>
                            <span>${escapeHtml(t('notifications.clear'))}</span>
                        </button>
                    </div>`);
            }
            else {
                html.push(`<div class="pt-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">${escapeHtml(group)}</div>`);
            }
        }
        html.push(_renderNotificationItem(item));
    }
    html.push(_renderNotificationPagination(total));
    listEl.innerHTML = html.join('');
}
function _renderNotificationPagination(total) {
    if (total <= _notificationPageSize)
        return '';
    const pageCount = _pageCount(total);
    const start = ((_notificationPage - 1) * _notificationPageSize) + 1;
    const end = Math.min(start + _notificationPageSize - 1, total);
    const prevDisabled = _notificationPage <= 1;
    const nextDisabled = _notificationPage >= pageCount;
    return `
        <nav class="pt-1 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px] text-slate-500" aria-label="${escapeHtml(t('notifications.pagination_aria'))}">
            <span class="font-medium">${escapeHtml(t('notifications.status_range', { start, end, total }))}</span>
            <div class="inline-flex items-center gap-2 self-start sm:self-auto rounded-xl border border-theme-subtle bg-white/[0.025] p-1">
                <button type="button" data-user-action="notifPage" data-user-delta="-1" ${prevDisabled ? 'disabled' : ''} aria-label="${escapeHtml(t('notifications.prev_page'))}" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-white/5 disabled:hover:text-slate-400"><i class="fas fa-chevron-left text-[10px]"></i></button>
                <span class="min-w-[74px] text-center text-[10px] font-bold uppercase text-slate-400">${escapeHtml(t('notifications.page_of', { page: _notificationPage, total: pageCount }))}</span>
                <button type="button" data-user-action="notifPage" data-user-delta="1" ${nextDisabled ? 'disabled' : ''} aria-label="${escapeHtml(t('notifications.next_page'))}" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-white/5 disabled:hover:text-slate-400"><i class="fas fa-chevron-right text-[10px]"></i></button>
            </div>
        </nav>`;
}
function _renderNotificationItem(item) {
    const unread = !item.read_at;
    const archived = !!item.archived_at;
    const category = escapeHtml(_categoryLabel(item.category));
    const severity = escapeHtml(item.severity || 'info');
    const severityClasses = _severityClasses(item.severity);
    const payload = (item.payload && typeof item.payload === 'object') ? item.payload : {};
    const titleKey = typeof payload.title_key === 'string' ? payload.title_key : '';
    const bodyKey = typeof payload.body_key === 'string' ? payload.body_key : '';
    const titleParams = (payload.title_params && typeof payload.title_params === 'object')
        ? payload.title_params : {};
    const bodyParams = (payload.body_params && typeof payload.body_params === 'object')
        ? payload.body_params : {};
    const title = escapeHtml(titleKey ? t(titleKey, titleParams) : (item.title || t('notifications.default_title')));
    const body = escapeHtml(bodyKey ? t(bodyKey, bodyParams) : (item.body || ''));
    const id = escapeHtml(item.id);
    const actionUrl = item.action_url || '';
    const hasAction = !!actionUrl;
    const clickAttr = hasAction ? `data-user-action="notifNavigate" data-notif-url="${escapeHtml(actionUrl)}" data-notif-id="${id}" style="cursor:pointer"` : '';
    const chevron = hasAction ? `<i class="fas fa-chevron-right text-[10px] text-slate-500 ml-auto shrink-0"></i>` : '';
    const suggested = (item.payload && Array.isArray(item.payload.suggested_actions)) ? item.payload.suggested_actions : [];
    let suggestedHtml = '';
    const navActions = suggested.filter((a) => a.tool === 'navigate' && a.args && a.args.url);
    if (!archived && navActions.length) {
        const btns = navActions.map(a => {
            const label = escapeHtml(a.label || t('notifications.apply'));
            const url = escapeHtml(a.args?.url || '');
            return `<button type="button" data-user-action="notifNavigate" data-user-stop-propagation="true" data-notif-url="${url}" data-notif-id="${id}" class="px-3 h-8 rounded-lg text-[12px] font-semibold bg-accent/15 hover:bg-accent/25 text-accent border border-accent/30 transition-colors"><i class="fas fa-arrow-right mr-1.5 text-[10px]"></i>${label}</button>`;
        }).join('');
        suggestedHtml = `<div class="flex flex-wrap items-center gap-2 pt-1">${btns}</div>`;
    }
    return `
        <article class="rounded-xl border ${archived ? 'border-[var(--border-light)] bg-[var(--overlay-6)]' : (unread ? 'border-accent/30 bg-accent/5' : 'border-[var(--border-light)] bg-[var(--overlay-6)]')} p-4 transition-colors ${hasAction ? 'hover:bg-[var(--overlay-8)]' : ''}" ${clickAttr}>
            <div class="flex items-start gap-3">
                <span class="mt-1 h-2.5 w-2.5 rounded-full ${unread ? 'bg-accent shadow-[0_0_0_4px_rgba(168,199,250,0.08)]' : 'bg-[var(--text-tertiary)]'} shrink-0"></span>
                <div class="min-w-0 flex-1 space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <h3 class="text-sm font-semibold text-[var(--text-primary)] leading-snug">${title}</h3>
                        <span class="px-2 py-0.5 rounded-full border text-[10px] font-bold ${severityClasses}">${category}</span>
                        <span class="px-2 py-0.5 rounded-full border border-[var(--border-light)] text-[10px] font-bold text-[var(--text-secondary)] bg-[var(--overlay-6)]">${severity}</span>
                        ${archived ? `<span class="px-2 py-0.5 rounded-full border border-[var(--border-light)] text-[10px] font-bold text-[var(--text-tertiary)] bg-[var(--overlay-6)]"><i class="fas fa-box-archive mr-1"></i>${escapeHtml(t('notifications.archived'))}</span>` : ''}
                        ${chevron}
                    </div>
                    <p class="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">${body}</p>
                    ${suggestedHtml}
                    <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <span class="text-[11px] text-[var(--text-tertiary)]">${escapeHtml(_formatDate(item.created_at))}</span>
                        <div class="flex items-center gap-2">
                            ${!archived && unread ? `<button type="button" data-user-action="notifMarkRead" data-user-stop-propagation="true" data-notif-id="${id}" data-i18n-title="notifications.mark_read_title" title="${escapeHtml(t('notifications.mark_read_title'))}" class="w-8 h-8 rounded-lg text-[11px] bg-[var(--overlay-6)] hover:bg-[var(--overlay-10)] text-[var(--text-secondary)] hover:text-accent transition-colors"><i class="fas fa-check"></i></button>` : ''}
                            ${!archived ? `<button type="button" data-user-action="notifArchive" data-user-stop-propagation="true" data-notif-id="${id}" data-i18n-title="notifications.archive_title" title="${escapeHtml(t('notifications.archive_title'))}" class="w-8 h-8 rounded-lg text-[11px] bg-[var(--overlay-6)] hover:bg-[var(--overlay-10)] text-[var(--text-secondary)] hover:text-accent transition-colors"><i class="fas fa-box-archive"></i></button>` : ''}
                            ${archived ? `<button type="button" data-user-action="notifDelete" data-user-stop-propagation="true" data-notif-id="${id}" data-i18n-title="notifications.delete_title" title="${escapeHtml(t('notifications.delete_title'))}" class="w-8 h-8 rounded-lg text-[11px] bg-red-500/10 hover:bg-red-500/20 text-red-300 hover:text-red-200 transition-colors"><i class="fas fa-trash"></i></button>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        </article>`;
}
export async function markUserNotificationRead(id) {
    try {
        const res = await apiCall(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH' });
        if (!res.ok)
            throw new Error();
        const data = await res.json();
        updateNotificationBadge(data.unread_count || 0);
        showToast(t('notifications.marked_read'), 'success', 2200);
        await loadUserNotifications(_currentFilter);
    }
    catch (_) {
        showToast(t('notifications.mark_read_error'), 'error');
    }
}
export async function archiveUserNotification(id) {
    try {
        const res = await apiCall(`/api/notifications/${encodeURIComponent(id)}/archive`, { method: 'PATCH' });
        if (!res.ok)
            throw new Error();
        const data = await res.json();
        updateNotificationBadge(data.unread_count || 0);
        await loadUserNotifications(_currentFilter);
    }
    catch (_) {
        showToast(t('notifications.archive_error'), 'error');
    }
}
export async function deleteUserNotification(id) {
    if (!(await showConfirm(t('notifications.confirm_delete'))))
        return;
    try {
        const res = await apiCall(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok)
            throw new Error();
        const data = await res.json();
        updateNotificationBadge(data.unread_count || 0);
        showToast(t('notifications.deleted'), 'success', 2200);
        await loadUserNotifications(_currentFilter);
    }
    catch (_) {
        showToast(t('notifications.delete_error'), 'error');
    }
}
export async function clearAllUserNotifications() {
    if (!(await showConfirm(t('notifications.confirm_clear_inbox'))))
        return;
    try {
        const res = await apiCall('/api/notifications', { method: 'DELETE' });
        if (!res.ok)
            throw new Error();
        const data = await res.json();
        updateNotificationBadge(data.unread_count || 0);
        showToast(data.deleted ? t('notifications.cleared_count', { count: data.deleted }) : t('notifications.nothing_to_clear'), 'success', 2200);
        await loadUserNotifications(_currentFilter);
    }
    catch (_) {
        showToast(t('notifications.clear_error'), 'error');
    }
}
async function _loadWsEnabledFromConfig() {
    try {
        const res = await apiCall('/api/config');
        if (!res.ok)
            return true;
        const cfg = await res.json();
        const fcm = cfg?.fcm || {};
        const mode = String(fcm.transport_mode || 'websocket').toLowerCase();
        return fcm.websocket_enabled !== false && mode !== 'firebase';
    }
    catch (_) {
        return true;
    }
}
function _handleNotificationPayload(data) {
    if (data.event === 'notification.created') {
        updateNotificationBadge(data.unread_count || 0);
        if (_isNotificationsPanelVisible()) {
            loadUserNotifications(_currentFilter);
        }
        else if (data.notification?.body) {
            showToast(data.notification.body, 'info', 4500);
        }
        _playNotificationCue();
        // If it's an update-availability notification, refresh the header updates badge
        if (data.notification?.action_url === '#updates/addons') {
            refreshUpdatesHeaderBadge().catch(() => { });
        }
        return;
    }
    if (data.event === 'notification.updated' || data.event === 'notification.deleted' || data.event === 'notification.counts') {
        updateNotificationBadge(data.unread_count || 0);
        if (_isNotificationsPanelVisible())
            loadUserNotifications(_currentFilter);
        return;
    }
    if (data.type === 'reminder' || data.type === 'automation') {
        const isSettingsTest = String(data.notification_id || '').startsWith('test_ws_') || String(data.notification_id || '').startsWith('test_fcm_');
        showToast(isSettingsTest ? 'Test WebSocket primit ✓' : (data.message || 'Notificare Hyve'), isSettingsTest ? 'success' : 'info', 3500);
        if (Number.isFinite(Number(data.unread_count)))
            updateNotificationBadge(Number(data.unread_count));
        else if (!isSettingsTest)
            updateNotificationBadge(_lastKnownUnread + 1);
        loadNotificationCounts();
    }
}
export async function navigateNotification(actionUrl, notifId) {
    if (notifId) {
        try {
            await apiCall(`/api/notifications/${encodeURIComponent(notifId)}/read`, { method: 'PATCH' });
        }
        catch (_) { }
    }
    if (!actionUrl)
        return;
    const _routeMap = {
        '#updates/addons': () => {
            switchTab('config');
            openConfigSection('updates');
        },
        '#smarthome': () => {
            switchTab('smarthome');
        },
        '#integrations': () => {
            switchTab('smarthome');
        },
    };
    const handler = _routeMap[actionUrl];
    if (handler) {
        handler();
    }
    else if (actionUrl.startsWith('#')) {
        const section = actionUrl.replace('#', '').split('/')[0];
        if (['smarthome', 'integrations', 'devices'].includes(section)) {
            switchTab('smarthome');
        }
        else {
            switchTab('config');
            openConfigSection(section);
        }
    }
    else if (actionUrl.startsWith('http')) {
        window.open(actionUrl, '_blank');
    }
}
export function initNotifications() {
    async function connectWebSocket() {
        if (_connectInFlight)
            return _connectInFlight;
        if (!_wsEnabled) {
            closeWebSocket();
            return;
        }
        const token = localStorage.getItem('hyve_token');
        if (!token)
            return;
        if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING))
            return;
        _connectInFlight = (async () => {
            let wsToken = token;
            try {
                wsToken = await getSSEToken();
            }
            catch (_) { }
            if (!wsToken)
                return;
            if (_ws) {
                try {
                    if (_ws._pingInterval)
                        clearInterval(_ws._pingInterval);
                    _ws.onclose = null;
                    _ws.onerror = null;
                    _ws.onmessage = null;
                    _ws.close();
                }
                catch (_) { }
                _ws = null;
            }
            try {
                const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
                _ws = new WebSocket(`${proto}//${location.host}/ws/notifications?token=${encodeURIComponent(wsToken)}`);
                _ws.onopen = () => {
                    _wsReconnectAttempts = 0;
                    loadNotificationCounts();
                    const ws = _ws;
                    if (!ws)
                        return;
                    ws._pingInterval = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN)
                            ws.send('ping');
                    }, 30000);
                };
                _ws.onmessage = (event) => {
                    try {
                        _handleNotificationPayload(JSON.parse(event.data));
                    }
                    catch (_) { }
                };
                _ws.onerror = () => {
                    try {
                        _ws?.close();
                    }
                    catch (_) { }
                };
                _ws.onclose = () => {
                    if (_ws?._pingInterval)
                        clearInterval(_ws._pingInterval);
                    _ws = null;
                    if (_wsReconnectTimer)
                        clearTimeout(_wsReconnectTimer);
                    if (_wsEnabled && localStorage.getItem('hyve_token')) {
                        _wsReconnectAttempts += 1;
                        _wsReconnectTimer = setTimeout(() => {
                            _wsReconnectTimer = null;
                            connectWebSocket();
                        }, Math.min(_wsReconnectAttempts * 4000, 30000));
                    }
                };
            }
            catch (_) { }
        })().finally(() => { _connectInFlight = null; });
        return _connectInFlight;
    }
    function ensureWebSocket() {
        if (!_wsEnabled || !localStorage.getItem('hyve_token'))
            return;
        if (!_ws || _ws.readyState === WebSocket.CLOSED || _ws.readyState === WebSocket.CLOSING)
            connectWebSocket();
    }
    function startLiveFallbacks() {
        if (_countPollTimer)
            clearInterval(_countPollTimer);
        if (_wsWatchdogTimer)
            clearInterval(_wsWatchdogTimer);
        _countPollTimer = setInterval(() => {
            if (!localStorage.getItem('hyve_token') || document.hidden)
                return;
            loadNotificationCounts();
            if (_isNotificationsPanelVisible())
                loadUserNotifications(_currentFilter);
        }, _fallbackCountPollMs);
        _wsWatchdogTimer = setInterval(() => {
            if (!document.hidden)
                ensureWebSocket();
        }, _watchdogMs);
    }
    function closeWebSocket() {
        if (_wsReconnectTimer)
            clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
        if (_ws) {
            try {
                if (_ws._pingInterval)
                    clearInterval(_ws._pingInterval);
                _ws.onclose = null;
                _ws.close();
            }
            catch (_) { }
            _ws = null;
        }
    }
    function stop() {
        if (_countPollTimer)
            clearInterval(_countPollTimer);
        if (_wsWatchdogTimer)
            clearInterval(_wsWatchdogTimer);
        _countPollTimer = null;
        _wsWatchdogTimer = null;
        closeWebSocket();
    }
    async function setEnabled(enabled) {
        const next = !!enabled;
        if (_wsEnabled === next)
            return;
        _wsEnabled = next;
        if (!_wsEnabled) {
            closeWebSocket();
            if (_wsReconnectTimer)
                clearTimeout(_wsReconnectTimer);
            _wsReconnectTimer = null;
            return;
        }
        _wsReconnectAttempts = 0;
        connectWebSocket();
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            loadNotificationCounts();
            if (_isNotificationsPanelVisible())
                loadUserNotifications(_currentFilter);
            if (_wsReconnectTimer) {
                clearTimeout(_wsReconnectTimer);
                _wsReconnectTimer = null;
            }
            ensureWebSocket();
        }
    });
    window.addEventListener('focus', () => {
        loadNotificationCounts();
        if (_isNotificationsPanelVisible())
            loadUserNotifications(_currentFilter);
        ensureWebSocket();
    });
    window.addEventListener('online', () => {
        loadNotificationCounts();
        ensureWebSocket();
    });
    window.addEventListener('pageshow', () => {
        loadNotificationCounts();
        ensureWebSocket();
    });
    document.addEventListener('click', (event) => {
        const menu = document.getElementById('user-notifications-filter-menu');
        const button = document.getElementById('user-notifications-filter-button');
        if (!menu || menu.classList.contains('hidden'))
            return;
        const target = event.target;
        if (!(target instanceof Node))
            return;
        if (menu.contains(target) || button?.contains(target))
            return;
        _setFilterMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape')
            _setFilterMenuOpen(false);
    });
    installHyveNativeBridge({ loadUserNotifications });
    loadNotificationCounts();
    startLiveFallbacks();
    _loadWsEnabledFromConfig().then((enabled) => {
        _wsEnabled = !!enabled;
        if (_wsEnabled)
            connectWebSocket();
        else
            closeWebSocket();
    });
    return { stop, setEnabled, isEnabled: () => !!_wsEnabled };
}
