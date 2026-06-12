import { apiCall } from '../api.js';
import { showToast, escapeHtml, showConfirm } from '../utils.js';
import { t, translateApiDetail } from '../lang/index.js';
import { switchTab, openConfigSection } from '../nav_bridge.js';
import { isAdmin } from '../user_context.js';
import { appsState } from './state.js';
import * as render from './render.js';
import { stopPoll, refreshDetailStatus } from './poll.js';
import { openAppDetail, loadApps } from './core.js';
function _preflightField(check, field) {
    const keyName = field === 'detail' ? 'detail_key' : 'fix_key';
    const paramsName = field === 'detail' ? 'detail_params' : 'fix_params';
    const key = check[keyName];
    if (typeof key === 'string' && key) {
        const params = check[paramsName];
        return t(key, typeof params === 'object' && params ? params : undefined);
    }
    const raw = check[field];
    return typeof raw === 'string' ? raw : '';
}
export async function runPreflight(slug) {
    const area = document.getElementById('preflight-area');
    const btn = document.getElementById('preflight-btn');
    if (!area)
        return;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('apps.preflight_checking_btn'))}`;
    }
    area.classList.remove('hidden');
    area.innerHTML = `<p class="text-xs text-slate-500"><i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('apps.preflight_checking'))}</p>`;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/install/preflight`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            area.innerHTML = `<p class="text-xs text-red-400"><i class="fas fa-exclamation-triangle mr-1.5"></i>${escapeHtml(translateApiDetail(err.detail) || t('apps.preflight_error'))}</p>`;
            return;
        }
        const data = await res.json();
        const checks = (data.checks || []);
        if (!checks.length) {
            area.innerHTML = `<p class="text-xs text-emerald-400"><i class="fas fa-check-circle mr-1.5"></i>${escapeHtml(t('apps.preflight_no_checks'))}</p>`;
            return;
        }
        const allOk = checks.every(c => c.ok);
        area.innerHTML = checks.map(c => {
            if (c.ok) {
                return `<div class="flex items-center gap-2 text-xs text-emerald-400"><i class="fas fa-check-circle"></i><span>${escapeHtml(c.name)}</span></div>`;
            }
            return `<div class="rounded-lg bg-red-500/10 border border-red-500/20 p-3 space-y-1">
                <div class="flex items-center gap-2 text-xs text-red-400 font-semibold"><i class="fas fa-times-circle"></i><span>${escapeHtml(c.name)}</span></div>
                <p class="text-[11px] text-slate-400">${escapeHtml(_preflightField(c, 'detail'))}</p>
                ${(_preflightField(c, 'fix')) ? `<div class="flex items-center gap-2 mt-1">
                    <code class="flex-1 text-[11px] bg-slate-800 text-amber-300 px-2.5 py-1.5 rounded-lg font-mono select-all">${escapeHtml(_preflightField(c, 'fix'))}</code>
                    <button type="button" data-config-action="copyPreflightFix" data-config-copy-text="${escapeHtml(_preflightField(c, 'fix'))}" class="px-2 py-1.5 rounded-lg text-[10px] font-bold bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] transition-all flex-shrink-0"><i class="fas fa-copy"></i></button>
                </div>` : ''}
            </div>`;
        }).join('');
        if (allOk) {
            area.innerHTML += `<p class="text-xs text-emerald-400 mt-1"><i class="fas fa-check-circle mr-1.5"></i>${escapeHtml(t('apps.preflight_all_ok'))}</p>`;
        }
    }
    catch (e) {
        area.innerHTML = `<p class="text-xs text-red-400"><i class="fas fa-exclamation-triangle mr-1.5"></i>${escapeHtml(t('common.error'))}: ${escapeHtml(render._errMsg(e))}</p>`;
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-stethoscope mr-1.5"></i>${escapeHtml(t('apps.check_requirements'))}`;
        }
    }
}
let _installEventSource = null;
export async function installApp(slug) {
    // Open install-log modal and stream progress via SSE
    const modal = document.getElementById('app-install-modal');
    const title = document.getElementById('app-install-title');
    const content = document.getElementById('app-install-content');
    const status = document.getElementById('app-install-status');
    const closeBtn = document.getElementById('app-install-close-btn');
    if (title)
        title.innerHTML = `<i class="fas fa-download"></i><span>${escapeHtml(t('apps.install_log_title', { slug }))}</span>`;
    if (content)
        content.textContent = `${t('apps.install_preparing')}\n`;
    if (status)
        status.innerHTML = `<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('config.app_install_status'))}`;
    if (closeBtn)
        closeBtn.classList.add('hidden');
    if (modal) {
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
    }
    // Get short-lived exchange token for SSE (avoids passing long-lived JWT in URL)
    let token;
    try {
        const { getSSEToken } = await import('../api.js');
        token = await getSSEToken();
    }
    catch (_) {
        token = '';
    }
    // Close previous stream if any
    if (_installEventSource) {
        _installEventSource.close();
        _installEventSource = null;
    }
    const url = `/api/addons/${encodeURIComponent(slug)}/install/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    _installEventSource = es;
    es.onmessage = (ev) => {
        let line;
        try {
            line = JSON.parse(ev.data);
        }
        catch {
            line = ev.data;
        }
        if (line === '__DONE__') {
            es.close();
            _installEventSource = null;
            if (status)
                status.innerHTML = `<i class="fas fa-check-circle mr-1.5 text-emerald-400"></i><span class="text-emerald-400">${escapeHtml(t('apps.install_complete'))}</span>`;
            if (closeBtn)
                closeBtn.classList.remove('hidden');
            showToast(t('hy.addon_installed'), 'success');
            appsState.openSlug = slug;
            setTimeout(() => {
                closeInstallLogModal();
                loadApps();
            }, 900);
            return;
        }
        if (typeof line === 'string' && line.startsWith('__FAIL__:')) {
            es.close();
            _installEventSource = null;
            const msg = line.slice('__FAIL__:'.length);
            if (content)
                content.textContent += `\n❌ ${msg}\n`;
            if (status)
                status.innerHTML = `<i class="fas fa-times-circle mr-1.5 text-red-400"></i><span class="text-red-400">${escapeHtml(t('apps.install_failed'))}</span>`;
            if (closeBtn)
                closeBtn.classList.remove('hidden');
            showToast(t('hy.addon_install_error'), 'error');
            return;
        }
        if (content) {
            content.textContent += line;
            content.scrollTop = content.scrollHeight;
        }
    };
    es.onerror = () => {
        es.close();
        _installEventSource = null;
        if (status)
            status.innerHTML = `<i class="fas fa-times-circle mr-1.5 text-red-400"></i><span class="text-red-400">${escapeHtml(t('apps.install_connection_lost'))}</span>`;
        if (closeBtn)
            closeBtn.classList.remove('hidden');
    };
}
export function closeInstallLogModal() {
    if (_installEventSource) {
        _installEventSource.close();
        _installEventSource = null;
    }
    const modal = document.getElementById('app-install-modal');
    if (modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
    }
}
/** Navigate to the Updates page where add-on updates are applied (generic, no slug needed). */
export function goToAddonUpdates() {
    try {
        switchTab('config');
    }
    catch (_) { }
    openConfigSection('updates');
}
export async function uninstallApp(slug) {
    if (!(await showConfirm(t('hy.addon_uninstall_confirm', { slug }))))
        return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_uninstalled'), 'success');
            appsState.openSlug = slug;
            await loadApps();
        }
        else {
            showToast(t('hy.addon_uninstall_error'), 'error');
        }
    }
    catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}
export async function toggleApp(slug, enabled) {
    const ep = enabled ? 'enable' : 'disable';
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${ep}`, { method: 'POST' });
        if (res.ok) {
            showToast(enabled ? t('hy.addon_enabled_toast') : t('hy.addon_disabled_toast'), 'success');
            appsState.openSlug = slug;
            await loadApps();
        }
        else {
            showToast(t('common.error'), 'error');
        }
    }
    catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}
export async function toggleAddonWatchdog(slug, enabled) {
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/watchdog`, {
            method: 'POST',
            body: { enabled: !!enabled },
        });
        if (res.ok) {
            showToast(enabled ? t('apps.watchdog_enabled_toast') : t('apps.watchdog_disabled_toast'), 'success');
            const idx = appsState.addonsCache.findIndex(a => a.slug === slug);
            if (idx >= 0) {
                appsState.addonsCache[idx].state = { ...(appsState.addonsCache[idx].state || {}), watchdog: !!enabled };
            }
        }
        else {
            const data = await res.json().catch(() => ({}));
            showToast(data.detail || t('apps.watchdog_save_error'), 'error');
            const cb = document.getElementById(`addon-watchdog-${slug}`);
            if (cb)
                cb.checked = !enabled;
        }
    }
    catch (e) {
        showToast(t('hy.network_error'), 'error');
        const cb = document.getElementById(`addon-watchdog-${slug}`);
        if (cb)
            cb.checked = !enabled;
    }
}
export async function detectAddonSerialPorts(fieldKey) {
    const safeKey = String(fieldKey || '');
    const root = document.getElementById('app-detail') || document;
    const input = root.querySelector(`[data-addon-config="${CSS.escape(safeKey)}"]`);
    const results = root.querySelector(`[data-addon-detect-results="${CSS.escape(safeKey)}"]`);
    if (!input || !results)
        return;
    results.classList.remove('hidden');
    results.innerHTML = `<div class="text-[11px] text-slate-500"><i class="fas fa-spinner fa-spin mr-1"></i>${escapeHtml(t('apps.usb_scanning'))}</div>`;
    try {
        const res = await apiCall('/api/addons/_helpers/detect-serial-ports');
        if (!res.ok) {
            results.innerHTML = `<div class="text-[11px] text-rose-300">${escapeHtml(t('apps.scan_error'))}</div>`;
            return;
        }
        const data = await res.json();
        const ports = (data.ports || []);
        if (!ports.length) {
            results.innerHTML = `<div class="text-[11px] text-amber-300"><i class="fas fa-circle-info mr-1"></i>${escapeHtml(t('apps.no_usb_adapters'))}</div>`;
            return;
        }
        results.innerHTML = `
            <div class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Adaptoare detectate (${ports.length})</div>
            ${ports.map(p => `
                <button type="button" data-detect-pick="${escapeHtml(p.path)}" class="w-full text-left px-3 py-2 rounded-lg bg-slate-950/80 hover:bg-slate-900 border border-white/[0.06] hover:border-accent/40 transition-colors flex items-center gap-2">
                    <i class="fas fa-plug text-accent text-xs"></i>
                    <span class="font-mono text-[11px] text-slate-300 flex-1 truncate">${escapeHtml(p.path)}</span>
                    <span class="text-[10px] text-accent">${escapeHtml(t('apps.select_port'))}</span>
                </button>
            `).join('')}
        `;
        results.querySelectorAll('[data-detect-pick]').forEach(btn => {
            btn.addEventListener('click', () => {
                input.value = btn.dataset.detectPick || '';
                input.dispatchEvent(new Event('change', { bubbles: true }));
                results.classList.add('hidden');
                showToast(t('apps.port_selected_hint'), 'success');
            });
        });
    }
    catch (e) {
        results.innerHTML = `<div class="text-[11px] text-rose-300">${escapeHtml(t('hy.network_error'))}</div>`;
    }
}
export async function saveAddonConfig(slug) {
    const detail = document.getElementById('app-detail');
    if (!detail)
        return;
    const fields = detail.querySelectorAll('[data-addon-config]');
    const body = {};
    fields.forEach((field) => {
        const el = field;
        const key = el.dataset.addonConfig;
        if (!key)
            return;
        if (el.type === 'checkbox') {
            body[key] = !!el.checked;
            return;
        }
        if (el.type === 'number') {
            const raw = `${el.value || ''}`.trim();
            body[key] = raw === '' ? '' : Number(raw);
            return;
        }
        body[key] = `${el.value || ''}`.trim();
    });
    // Persist watchdog state alongside config.
    const watchdogCb = document.getElementById(`addon-watchdog-${slug}`);
    if (watchdogCb) {
        const wdRes = await apiCall(`/api/addons/${encodeURIComponent(slug)}/watchdog`, {
            method: 'POST',
            body: { enabled: !!watchdogCb.checked },
        });
        if (!wdRes.ok) {
            const data = await wdRes.json().catch(() => ({}));
            throw new Error(data.detail || t('apps.watchdog_save_error'));
        }
        const idx = appsState.addonsCache.findIndex(a => a.slug === slug);
        if (idx >= 0) {
            appsState.addonsCache[idx].state = {
                ...(appsState.addonsCache[idx].state || {}),
                watchdog: !!watchdogCb.checked,
            };
        }
    }
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Config save failed');
        }
        showToast(t('hy.addon_config_saved'), 'success');
        appsState.openSlug = slug;
        await openAppDetail(slug);
    }
    catch (e) {
        showToast(render._errMsg(e) || t('hy.addon_config_save_error'), 'error');
    }
}
export async function testAddonHealth(slug) {
    try {
        if (isAdmin()) {
            await saveAddonConfig(slug);
        }
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/health`);
        const data = await res.json();
        if (data?.ok) {
            showToast(t('integrations.connection_ok'), 'success');
        }
        else {
            showToast(data?.detail || t('hy.addon_health_no_response'), 'warning');
        }
        await refreshDetailStatus(slug);
    }
    catch (e) {
        showToast(render._errMsg(e) || t('apps.health_check_failed'), 'error');
    }
}
function _buildAddonUiEmbedUrl(slug) {
    const encoded = encodeURIComponent(slug || '');
    const base = `/api/addons/${encoded}/ui/`;
    const token = typeof localStorage !== 'undefined' ? (localStorage.getItem('hyve_token') || '') : '';
    if (!token)
        return base;
    return `${base}?token=${encodeURIComponent(token)}`;
}
function _restoreConfigHeader() {
    const titleEl = document.getElementById('current-view-title');
    if (!titleEl || titleEl.dataset.addonUiActive !== '1')
        return;
    delete titleEl.dataset.addonUiActive;
    titleEl.classList.remove('flex', 'items-center', 'gap-2', 'min-w-0');
    titleEl.classList.add('truncate');
    titleEl.setAttribute('data-i18n', 'nav.config');
    titleEl.textContent = t('nav.config');
}
function _setAddonUiHeader(addon) {
    const titleEl = document.getElementById('current-view-title');
    if (!titleEl)
        return;
    titleEl.dataset.addonUiActive = '1';
    titleEl.removeAttribute('data-i18n');
    titleEl.classList.remove('truncate');
    titleEl.classList.add('flex', 'items-center', 'gap-2', 'min-w-0');
    titleEl.innerHTML = `
        <button type="button" data-config-action="closeAddonWebUI"
            class="min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 text-slate-500 hover:text-slate-300 hover:bg-white/[0.03] transition-all touch-manipulation"
            aria-label="${escapeHtml(t('common.back'))}">
            <i class="fas fa-arrow-left text-sm"></i>
        </button>
        <span class="truncate normal-case tracking-normal text-sm sm:text-base font-semibold text-slate-300">${escapeHtml(addon?.name || addon?.slug || '')}</span>
    `;
}
export function closeAddonWebUI() {
    appsState.addonUiSlug = null;
    document.body.classList.remove('addon-ui-sidebar-active');
    const viewer = document.getElementById('addon-ui-viewer');
    const frame = document.getElementById('addon-ui-frame');
    const viewConfig = document.getElementById('view-config');
    if (viewer) {
        viewer.classList.remove('open');
        viewer.setAttribute('aria-hidden', 'true');
    }
    if (frame) {
        frame.removeAttribute('src');
        frame.src = 'about:blank';
        frame.title = '';
    }
    if (viewConfig) {
        viewConfig.classList.remove('overflow-hidden');
    }
    _restoreConfigHeader();
}
function _prepareAddonUiOverlay() {
    const viewConfig = document.getElementById('view-config');
    if (viewConfig) {
        viewConfig.scrollTop = 0;
        viewConfig.classList.add('overflow-hidden');
    }
    document.querySelector('#app-main-wrap .flex-1')?.scrollTo?.(0, 0);
}
export async function openAddonWebUI(slug) {
    let addon = appsState.addonsCache.find(a => a.slug === slug);
    if (!addon) {
        try {
            const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}`);
            if (res.ok)
                addon = await res.json();
        }
        catch (_) { /* ignore */ }
    }
    if (!addon || !render._buildAddonWebUrl(addon)) {
        showToast(t('apps.configure_web_ui_first'), 'warning');
        return;
    }
    if (!render._canUseIngressWebUi(addon)) {
        let url = render._buildAddonWebUrl(addon);
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
    }
    const viewer = document.getElementById('addon-ui-viewer');
    const frame = document.getElementById('addon-ui-frame');
    if (!viewer || !frame) {
        window.open(_buildAddonUiEmbedUrl(slug), '_blank', 'noopener,noreferrer');
        return;
    }
    appsState.addonUiSlug = slug;
    _prepareAddonUiOverlay();
    _setAddonUiHeader(addon);
    frame.title = addon.name || slug;
    viewer.classList.add('open');
    viewer.setAttribute('aria-hidden', 'false');
    frame.src = _buildAddonUiEmbedUrl(slug);
    stopPoll();
}
