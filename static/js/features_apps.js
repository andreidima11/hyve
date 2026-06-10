/**
 * features_apps.js — Apps page: addon process management + lifecycle.
 */
import { apiCall } from './api.js';
import { showToast, escapeHtml, showConfirm } from './utils.js';
import { t } from './lang/index.js';
import { switchTab, openConfigSection } from './nav_bridge.js';
import { isAdmin } from './user_context.js';
function _errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
/** Format manifest/runtime version — avoid "vstable" for Docker channel tags. */
function _formatAddonVersion(version) {
    const raw = String(version ?? '?').trim() || '?';
    if (raw === '?')
        return raw;
    if (/^v[\d.]/i.test(raw))
        return raw;
    if (/^\d/.test(raw))
        return `v${raw}`;
    if (/^[a-zA-Z][\w.-]*$/.test(raw))
        return raw;
    return `v${raw}`;
}
let _currentLogSlug = null;
let _pollTimer = null;
let _openSlug = null; // which addon detail is expanded
let _addonUiSlug = null; // embedded Web UI viewer
// Tailwind can't detect dynamic class names — use static map.
const _colorMap = {
    cyan: { bg: 'bg-cyan-500/10', text: 'text-cyan-400' },
    blue: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
    purple: { bg: 'bg-purple-500/10', text: 'text-purple-400' },
    fuchsia: { bg: 'bg-fuchsia-500/10', text: 'text-fuchsia-400' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400' },
    green: { bg: 'bg-green-500/10', text: 'text-green-400' },
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    slate: { bg: 'bg-slate-500/10', text: 'text-slate-400' },
    indigo: { bg: 'bg-indigo-500/10', text: 'text-indigo-400' },
    rose: { bg: 'bg-rose-500/10', text: 'text-rose-400' },
};
// ── helpers ─────────────────────────────────────────────────────────────
function _statusBadge(s) {
    if (s === 'running')
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px] animate-pulse"></i>${escapeHtml(t('apps.process_status_running'))}</span>`;
    if (s === 'exited')
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('apps.process_status_exited'))}</span>`;
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('apps.process_status_stopped'))}</span>`;
}
function _uptime(sec) {
    if (!sec)
        return '';
    if (sec < 60)
        return `${sec}s`;
    if (sec < 3600)
        return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
}
function _canUseIngressWebUi(addon) {
    const webUi = addon?.web_ui || {};
    if (!Object.keys(webUi).length || webUi.ingress === false)
        return false;
    const cfg = addon?.state?.config || {};
    const directUrl = `${cfg[webUi.url_key || ''] || ''}`.trim();
    if (directUrl) {
        try {
            const parsed = new URL(directUrl);
            return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        }
        catch (_) {
            return false;
        }
    }
    const rawHost = `${webUi.host ?? cfg[webUi.host_key || 'host'] ?? cfg.host ?? 'localhost'}`.trim().toLowerCase();
    if (!rawHost || rawHost.includes('://'))
        return false;
    return ['localhost', '127.0.0.1', '::1'].includes(rawHost);
}
function _buildAddonWebUrl(addon) {
    const webUi = addon?.web_ui || {};
    const cfg = addon?.state?.config || {};
    if (!Object.keys(webUi).length)
        return '';
    if (_canUseIngressWebUi(addon)) {
        const slug = encodeURIComponent(addon.slug || '');
        return `/api/addons/${slug}/ui/open`;
    }
    const directUrl = `${cfg[webUi.url_key || ''] || ''}`.trim();
    if (directUrl)
        return directUrl;
    const rawHost = `${webUi.host ?? cfg[webUi.host_key || 'host'] ?? cfg.host ?? 'localhost'}`.trim();
    if (!rawHost)
        return '';
    if (rawHost.includes('://'))
        return rawHost;
    const protocol = `${cfg[webUi.protocol_key || 'protocol'] || webUi.protocol || 'http'}`.replace(/:$/, '');
    const portValue = cfg[webUi.port_key || 'port'] ?? webUi.port ?? '';
    const port = `${portValue}`.trim() ? `:${portValue}` : '';
    const path = webUi.path || '/';
    return `${protocol}://${rawHost}${port}${path}`;
}
function _renderConfigField(field, value, isAdmin) {
    const key = field.key || '';
    const label = field.label || key;
    const desc = field.description || '';
    const placeholder = field.placeholder || '';
    const type = (field.type || 'text').toLowerCase();
    const safeValue = value ?? field.default ?? '';
    const disabled = isAdmin ? '' : 'disabled';
    const wideClass = type === 'textarea' ? 'sm:col-span-2' : '';
    if (type === 'checkbox' || type === 'boolean') {
        return `
        <label class="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex items-start gap-3 cursor-pointer">
            <input type="checkbox" data-addon-config="${escapeHtml(key)}" ${safeValue ? 'checked' : ''} ${disabled}
                class="mt-0.5 rounded border-white/10 bg-slate-900 text-accent focus:ring-accent/40">
            <span class="min-w-0">
                <span class="block text-sm text-white">${escapeHtml(label)}</span>
                ${desc ? `<span class="block text-[11px] text-slate-500 mt-1">${escapeHtml(desc)}</span>` : ''}
            </span>
        </label>`;
    }
    if (type === 'select' && Array.isArray(field.options)) {
        const options = field.options.map((opt) => {
            const option = typeof opt === 'object' ? opt : { value: opt, label: opt };
            const val = `${option.value ?? option.label ?? ''}`;
            const selected = `${safeValue}` === val ? 'selected' : '';
            return `<option value="${escapeHtml(val)}" ${selected}>${escapeHtml(option.label ?? val)}</option>`;
        }).join('');
        return `
        <label class="block space-y-1.5 ${wideClass}">
            <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
            <select data-addon-config="${escapeHtml(key)}" ${disabled}
                class="w-full rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40">
                ${options}
            </select>
            ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
        </label>`;
    }
    if (type === 'textarea') {
        return `
        <label class="block space-y-1.5 ${wideClass}">
            <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
            <textarea data-addon-config="${escapeHtml(key)}" placeholder="${escapeHtml(placeholder)}" ${disabled}
                class="w-full min-h-[96px] rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40">${escapeHtml(String(safeValue))}</textarea>
            ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
        </label>`;
    }
    const inputType = ['number', 'password', 'url'].includes(type) ? type : 'text';
    if (field.detect === 'serial') {
        return `
        <label class="block space-y-1.5 sm:col-span-2">
            <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
            <div class="flex gap-2">
                <input type="${escapeHtml(inputType)}" data-addon-config="${escapeHtml(key)}" value="${escapeHtml(String(safeValue))}" placeholder="${escapeHtml(placeholder)}" ${disabled}
                    class="flex-1 rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40">
                <button type="button" data-config-action="detectAddonSerialPorts" data-config-key="${escapeHtml(key)}" ${disabled}
                    class="px-3 py-2 rounded-xl text-xs font-semibold bg-accent/15 text-accent hover:bg-accent/25 transition-colors whitespace-nowrap"
                    title="${escapeHtml(t('apps.detect_serial_title'))}">
                    <i class="fas fa-magnifying-glass mr-1"></i>${escapeHtml(t('apps.detect_serial'))}
                </button>
            </div>
            <div data-addon-detect-results="${escapeHtml(key)}" class="hidden space-y-1"></div>
            ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
        </label>`;
    }
    return `
    <label class="block space-y-1.5 ${wideClass}">
        <span class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</span>
        <input type="${escapeHtml(inputType)}" data-addon-config="${escapeHtml(key)}" value="${escapeHtml(String(safeValue))}" placeholder="${escapeHtml(placeholder)}" ${disabled}
            class="w-full rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2.5 text-sm text-white outline-none focus:border-accent/40">
        ${desc ? `<p class="text-[11px] text-slate-500">${escapeHtml(desc)}</p>` : ''}
    </label>`;
}
function _renderConfigSection(addon, isAdmin) {
    const schema = addon.config_schema || [];
    if (!schema.length)
        return '';
    const cfg = addon.state?.config || {};
    const webUrl = _buildAddonWebUrl(addon);
    const intro = addon.state?.installed
        ? t('apps.config_intro_installed')
        : t('apps.config_intro_not_installed');
    return `
    <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <div class="space-y-1">
            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${escapeHtml(t('apps.config_section'))}</span>
            <p class="text-xs text-slate-500">${escapeHtml(intro)}</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${schema.map((field) => _renderConfigField(field, cfg[field.key ?? ''], isAdmin)).join('')}
        </div>
        <div class="flex flex-wrap gap-2">
            ${isAdmin ? `<button type="button" data-config-action="saveAddonConfig" data-config-slug="${escapeHtml(addon.slug)}" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-accent text-bg-main hover:bg-accent-hover transition-all shadow-lg shadow-accent/20"><i class="fas fa-save mr-1.5"></i>${escapeHtml(t('apps.save_config'))}</button>` : ''}
            ${isAdmin ? `<button type="button" data-config-action="testAddonHealth" data-config-slug="${escapeHtml(addon.slug)}" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all"><i class="fas fa-heart-pulse mr-1.5"></i>${escapeHtml(t('apps.test_connection'))}</button>` : ''}
            ${webUrl ? `<button type="button" data-config-action="openAddonWebUI" data-config-slug="${escapeHtml(addon.slug)}" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all"><i class="fas fa-display mr-1.5"></i>${escapeHtml(t('apps.open_web_ui'))}</button>` : ''}
        </div>
    </div>`;
}
// ── render: summary card (list view) ────────────────────────────────────
function _addonStatusBadge(addon, processStatus) {
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    if (!installed)
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">${escapeHtml(t('hy.addon_status_available'))}</span>`;
    if (addon.start_command && processStatus)
        return _statusBadge(processStatus.status || 'stopped');
    if (enabled)
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_active'))}</span>`;
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_installed'))}</span>`;
}
function _updateIndicator(addon) {
    if (!addon || !addon.update_available)
        return '';
    return `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/15 text-amber-300 flex-shrink-0" title="${escapeHtml(t('updates.update_available'))}"><i class="fas fa-arrow-up text-[9px]"></i></span>`;
}
function _renderSummaryCard(addon, status) {
    const slug = addon.slug;
    const icon = addon.icon || 'fas fa-puzzle-piece';
    const cm = _colorMap[addon.color || 'slate'] || _colorMap.slate;
    const installed = addon.state?.installed;
    const iconHtml = addon.image
        ? `<img src="${escapeHtml(addon.image)}" alt="" class="w-10 h-10 rounded-xl object-contain flex-shrink-0" loading="lazy">`
        : `<div class="w-10 h-10 rounded-xl ${cm.bg} flex items-center justify-center flex-shrink-0"><i class="${escapeHtml(icon)} ${cm.text}"></i></div>`;
    return `
    <button type="button" data-config-action="openAppDetail" data-config-slug="${escapeHtml(slug)}"
        class="app-summary w-full text-left rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 transition-all hover:border-white/[0.12] hover:bg-white/[0.04] active:scale-[0.995]"
        data-slug="${escapeHtml(slug)}">
        <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-3.5 min-w-0">
                ${iconHtml}
                <div class="min-w-0">
                    <h3 class="text-white font-semibold text-sm truncate">${escapeHtml(addon.name)}</h3>
                    <p class="text-slate-500 text-xs mt-0.5 truncate">${escapeHtml(addon.description || '')}</p>
                </div>
            </div>
            <div class="app-summary-badge flex items-center gap-3 flex-shrink-0">
                ${_updateIndicator(addon)}
                ${_addonStatusBadge(addon, status)}
                <i class="fas fa-chevron-right text-slate-600 text-xs"></i>
            </div>
        </div>
    </button>`;
}
// ── render: detail view ─────────────────────────────────────────────────
function _renderDetail(addon, status) {
    const slug = addon.slug;
    const icon = addon.icon || 'fas fa-puzzle-piece';
    const cm = _colorMap[addon.color || 'slate'] || _colorMap.slate;
    const st = status?.status || 'stopped';
    const isRunning = st === 'running';
    const pid = status?.pid || '—';
    const up = _uptime(status?.uptime);
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    const hasProcess = !!addon.start_command;
    const isAdminUser = isAdmin();
    const configHtml = _renderConfigSection(addon, isAdminUser);
    // Show the real installed version (resolved from the package) when installed;
    // fall back to the manifest version for not-installed add-ons.
    const displayVersion = addon.version || addon.state?.version || '?';
    // Lifecycle controls (install / enable-disable / uninstall) — admin only
    let lifecycleHtml = '';
    if (isAdminUser) {
        if (!installed) {
            lifecycleHtml = `
            <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${escapeHtml(t('apps.local_install_title'))}</span>
                <div id="preflight-area" class="hidden space-y-2"></div>
                <p class="text-xs text-slate-500">${escapeHtml(t('apps.local_install_desc'))}</p>
                <div class="flex gap-2">
                    <button type="button" id="preflight-btn" data-config-action="runPreflight" data-config-slug="${escapeHtml(slug)}" class="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-colors">
                        <i class="fas fa-stethoscope mr-1.5"></i>${escapeHtml(t('apps.check_requirements'))}
                    </button>
                    <button type="button" id="install-btn" data-config-action="installApp" data-config-slug="${escapeHtml(slug)}" class="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold bg-accent text-bg-main hover:bg-accent-hover transition-colors shadow-lg shadow-accent/20">
                        <i class="fas fa-download mr-1.5"></i>${escapeHtml(t('hy.addon_install_btn'))}
                    </button>
                </div>
            </div>`;
        }
        else {
            const watchdogOn = !!addon.state?.watchdog;
            lifecycleHtml = `
            <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${escapeHtml(t('apps.admin_section'))}</span>
                ${hasProcess ? `
                <label class="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" id="addon-watchdog-${escapeHtml(slug)}" ${watchdogOn ? 'checked' : ''}
                        data-config-input="toggleAddonWatchdog" data-config-slug="${escapeHtml(slug)}"
                        class="mt-0.5 rounded border-white/10 bg-slate-900 text-accent focus:ring-accent/40">
                    <span class="min-w-0">
                        <span class="block text-sm text-white"><i class="fas fa-shield-halved mr-1.5 opacity-70"></i>${escapeHtml(t('apps.watchdog_auto_restart'))}</span>
                        <span class="block text-[11px] text-slate-500 mt-1">${escapeHtml(t('apps.watchdog_auto_restart_hint'))}</span>
                    </span>
                </label>
                ` : ''}
                <div class="flex flex-wrap gap-2">
                    ${enabled
                ? `<button type="button" data-config-action="toggleApp" data-config-slug="${escapeHtml(slug)}" data-config-enabled="false" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all"><i class="fas fa-power-off mr-1.5"></i>${escapeHtml(t('common.disable'))}</button>`
                : `<button type="button" data-config-action="toggleApp" data-config-slug="${escapeHtml(slug)}" data-config-enabled="true" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"><i class="fas fa-check mr-1.5"></i>${escapeHtml(t('common.enable'))}</button>`}
                    ${addon.update_available ? `<button type="button" data-config-action="goToAddonUpdates" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-all"><i class="fas fa-arrow-up mr-1.5"></i>${escapeHtml(t('updates.update_available'))}</button>` : ''}
                    <button type="button" data-config-action="uninstallApp" data-config-slug="${escapeHtml(slug)}" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"><i class="fas fa-trash-alt mr-1.5"></i>${escapeHtml(t('apps.uninstall'))}</button>
                </div>
            </div>`;
        }
    }
    return `
    <div id="app-detail" class="space-y-5" data-slug="${escapeHtml(slug)}">
        <!-- Header -->
        <div class="flex items-center gap-3">
            <button type="button" data-config-action="closeAppDetail" class="w-9 h-9 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center text-slate-400 transition-all">
                <i class="fas fa-arrow-left"></i>
            </button>
            ${addon.image
        ? `<img src="${escapeHtml(addon.image)}" alt="" class="w-10 h-10 rounded-xl object-contain flex-shrink-0" loading="lazy">`
        : `<div class="w-10 h-10 rounded-xl ${cm.bg} flex items-center justify-center flex-shrink-0"><i class="${escapeHtml(icon)} ${cm.text}"></i></div>`}
            <div class="min-w-0 flex-1">
                <h2 class="text-white font-semibold text-lg">${escapeHtml(addon.name)}</h2>
                <p class="text-slate-500 text-xs">${escapeHtml(addon.long_description || addon.description || '')}</p>
            </div>
        </div>

        ${hasProcess && installed ? `
        <!-- Status + Controls -->
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-4">
            <div class="flex items-center justify-between">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">${escapeHtml(t('apps.process_section'))}</span>
                <div id="app-detail-badge">${_statusBadge(st)}</div>
            </div>
            <div class="flex items-center gap-4 text-xs text-slate-500">
                <span><i class="fas fa-microchip mr-1 opacity-60"></i>PID: <span id="app-detail-pid">${pid}</span></span>
                <span id="app-detail-uptime-wrap" class="${up ? '' : 'hidden'}"><i class="fas fa-clock mr-1 opacity-60"></i>${escapeHtml(t('apps.uptime'))}: <span id="app-detail-uptime">${up}</span></span>
                <span><i class="fas fa-tag mr-1 opacity-60"></i>${escapeHtml(_formatAddonVersion(displayVersion))}</span>
            </div>
            <div class="flex flex-wrap gap-2">
                <button data-config-action="appAction" data-config-slug="${slug}" data-config-app-action="start" id="app-detail-start" class="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${isRunning ? 'bg-white/[0.03] text-slate-600 cursor-not-allowed' : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}" ${isRunning ? 'disabled' : ''}>
                    <i class="fas fa-play mr-1.5"></i>${escapeHtml(t('apps.start'))}
                </button>
                <button data-config-action="appAction" data-config-slug="${slug}" data-config-app-action="stop" id="app-detail-stop" class="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${!isRunning ? 'bg-white/[0.03] text-slate-600 cursor-not-allowed' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}" ${!isRunning ? 'disabled' : ''}>
                    <i class="fas fa-stop mr-1.5"></i>${escapeHtml(t('apps.stop'))}
                </button>
                <button data-config-action="appAction" data-config-slug="${slug}" data-config-app-action="restart" id="app-detail-restart" class="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${!isRunning ? 'bg-white/[0.03] text-slate-600 cursor-not-allowed' : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'}" ${!isRunning ? 'disabled' : ''}>
                    <i class="fas fa-sync-alt mr-1.5"></i>${escapeHtml(t('apps.restart'))}
                </button>
                <button data-config-action="openAppLogModal" data-config-slug="${slug}" data-config-app-name="${escapeHtml(addon.name)}" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] transition-all">
                    <i class="fas fa-terminal mr-1.5"></i>${escapeHtml(t('apps.logs'))}
                </button>
            </div>
        </div>
        ` : !installed ? `
        <!-- Not installed info -->
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>${escapeHtml(_formatAddonVersion(displayVersion))}
                <span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">${escapeHtml(t('hy.addon_status_available'))}</span>
            </div>
        </div>
        ` : `
        <!-- Installed but no process -->
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>${escapeHtml(_formatAddonVersion(displayVersion))}
                ${enabled
        ? `<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_active'))}</span>`
        : `<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_installed'))}</span>`}
            </div>
        </div>
        `}

        ${configHtml}

        <!-- Lifecycle -->
        ${lifecycleHtml}
    </div>`;
}
// ── load ────────────────────────────────────────────────────────────────
let _addonsCache = [];
export async function loadApps() {
    const container = document.getElementById('apps-list');
    if (!container)
        return;
    try {
        const [addonsRes, statusRes] = await Promise.all([
            apiCall('/api/addons'),
            apiCall('/api/addons/process/status'),
        ]);
        const addons = await addonsRes.json();
        const statuses = await statusRes.json();
        _addonsCache = addons;
        if (!addons.length) {
            container.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm">${escapeHtml(t('hy.addon_list_empty'))}</div>`;
            return;
        }
        // If a detail was open, re-open it; otherwise show list
        if (_openSlug) {
            const addon = addons.find(a => a.slug === _openSlug);
            if (addon) {
                container.innerHTML = _renderDetail(addon, statuses[addon.slug]);
                _startPoll();
                return;
            }
        }
        container.innerHTML = addons.map(a => _renderSummaryCard(a, statuses[a.slug])).join('');
        _startPoll();
    }
    catch (e) {
        container.innerHTML = `<div class="p-8 text-center text-red-400 text-sm">${escapeHtml(t('common.error'))}: ${escapeHtml(String(e))}</div>`;
    }
}
// ── detail open/close ───────────────────────────────────────────────────
export async function openAppDetail(slug) {
    _openSlug = slug;
    const container = document.getElementById('apps-list');
    if (!container)
        return;
    try {
        const [addonRes, statusRes] = await Promise.all([
            apiCall(`/api/addons/${encodeURIComponent(slug)}`),
            apiCall(`/api/addons/${encodeURIComponent(slug)}/status`),
        ]);
        const addon = await addonRes.json();
        const status = await statusRes.json();
        const idx = _addonsCache.findIndex(a => a.slug === addon.slug);
        if (idx >= 0)
            _addonsCache[idx] = addon;
        else
            _addonsCache.push(addon);
        container.innerHTML = _renderDetail(addon, status);
    }
    catch (e) {
        showToast(t('apps.error_detail', { message: _errMsg(e) }), 'error');
    }
}
export function closeAppDetail() {
    _openSlug = null;
    loadApps();
}
// ── actions ─────────────────────────────────────────────────────────────
export async function appAction(slug, action) {
    const ev = window.event;
    const btn = ev?.target?.closest?.('button');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50');
    }
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${action}`, { method: 'POST' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || res.statusText);
        }
        showToast(t('apps.process_action_ok', { slug, action }), 'success');
        // Re-fetch status to update buttons
        await _refreshDetailStatus(slug);
    }
    catch (e) {
        showToast(t('apps.process_action_error', { slug, message: _errMsg(e) }), 'error');
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('opacity-50');
        }
    }
}
async function _refreshDetailStatus(slug) {
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/status`);
        const s = await res.json();
        _updateDetailUI(s);
    }
    catch (_) { }
}
function _updateDetailUI(s) {
    const st = s?.status || 'stopped';
    const isRunning = st === 'running';
    const badge = document.getElementById('app-detail-badge');
    if (badge)
        badge.innerHTML = _statusBadge(st);
    const pidEl = document.getElementById('app-detail-pid');
    if (pidEl)
        pidEl.textContent = String(s?.pid ?? '—');
    const upWrap = document.getElementById('app-detail-uptime-wrap');
    const upEl = document.getElementById('app-detail-uptime');
    if (upWrap)
        upWrap.classList.toggle('hidden', !s?.uptime);
    if (upEl)
        upEl.textContent = _uptime(s?.uptime);
    const startBtn = document.getElementById('app-detail-start');
    const stopBtn = document.getElementById('app-detail-stop');
    const restartBtn = document.getElementById('app-detail-restart');
    if (startBtn) {
        startBtn.disabled = isRunning;
        startBtn.classList.toggle('opacity-40', isRunning);
    }
    if (stopBtn) {
        stopBtn.disabled = !isRunning;
        stopBtn.classList.toggle('opacity-40', !isRunning);
    }
    if (restartBtn) {
        restartBtn.disabled = !isRunning;
        restartBtn.classList.toggle('opacity-40', !isRunning);
    }
}
// ── logs ────────────────────────────────────────────────────────────────
let _logPollTimer = null;
export function openAppLogModal(slug, name) {
    _currentLogSlug = slug;
    const modal = document.getElementById('app-log-modal');
    const title = document.getElementById('app-log-title');
    if (title)
        title.innerHTML = `<i class="fas fa-terminal"></i><span>${escapeHtml(t('apps.log_title', { name }))}</span>`;
    if (modal) {
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
    }
    refreshAppLogs();
    _stopLogPoll();
    _logPollTimer = setInterval(refreshAppLogs, 3000);
}
export function closeAppLogModal() {
    _currentLogSlug = null;
    _stopLogPoll();
    const modal = document.getElementById('app-log-modal');
    if (modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
    }
}
function _stopLogPoll() {
    if (_logPollTimer) {
        clearInterval(_logPollTimer);
        _logPollTimer = null;
    }
}
export async function refreshAppLogs() {
    if (!_currentLogSlug)
        return;
    const pre = document.getElementById('app-log-content');
    if (!pre)
        return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentLogSlug)}/logs?tail=300`);
        const data = await res.json();
        const lines = data.lines || [];
        pre.textContent = lines.length ? lines.join('\n') : t('apps.logs_empty');
        pre.scrollTop = pre.scrollHeight;
    }
    catch (e) {
        pre.textContent = t('apps.logs_error', { message: _errMsg(e) });
    }
}
// ── lifecycle (install / uninstall / enable / disable) ──────────────────
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
            area.innerHTML = `<p class="text-xs text-red-400"><i class="fas fa-exclamation-triangle mr-1.5"></i>${escapeHtml(err.detail || t('apps.preflight_error'))}</p>`;
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
                <p class="text-[11px] text-slate-400">${escapeHtml(c.detail)}</p>
                ${c.fix ? `<div class="flex items-center gap-2 mt-1">
                    <code class="flex-1 text-[11px] bg-slate-800 text-amber-300 px-2.5 py-1.5 rounded-lg font-mono select-all">${escapeHtml(c.fix)}</code>
                    <button type="button" data-config-action="copyPreflightFix" data-config-copy-text="${escapeHtml(c.fix)}" class="px-2 py-1.5 rounded-lg text-[10px] font-bold bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] transition-all flex-shrink-0"><i class="fas fa-copy"></i></button>
                </div>` : ''}
            </div>`;
        }).join('');
        if (allOk) {
            area.innerHTML += `<p class="text-xs text-emerald-400 mt-1"><i class="fas fa-check-circle mr-1.5"></i>${escapeHtml(t('apps.preflight_all_ok'))}</p>`;
        }
    }
    catch (e) {
        area.innerHTML = `<p class="text-xs text-red-400"><i class="fas fa-exclamation-triangle mr-1.5"></i>${escapeHtml(t('common.error'))}: ${escapeHtml(_errMsg(e))}</p>`;
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
        const { getSSEToken } = await import('./api.js');
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
            _openSlug = slug;
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
            _openSlug = slug;
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
            _openSlug = slug;
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
            const idx = _addonsCache.findIndex(a => a.slug === slug);
            if (idx >= 0) {
                _addonsCache[idx].state = { ...(_addonsCache[idx].state || {}), watchdog: !!enabled };
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
    // Persist watchdog state alongside config so a save can't desync it.
    const watchdogCb = document.getElementById(`addon-watchdog-${slug}`);
    if (watchdogCb) {
        try {
            await apiCall(`/api/addons/${encodeURIComponent(slug)}/watchdog`, {
                method: 'POST',
                body: { enabled: !!watchdogCb.checked },
            });
        }
        catch (_) { /* non-fatal — config save still proceeds */ }
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
        _openSlug = slug;
        await openAppDetail(slug);
    }
    catch (e) {
        showToast(_errMsg(e) || t('hy.addon_config_save_error'), 'error');
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
        await _refreshDetailStatus(slug);
    }
    catch (e) {
        showToast(_errMsg(e) || t('apps.health_check_failed'), 'error');
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
    _addonUiSlug = null;
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
    let addon = _addonsCache.find(a => a.slug === slug);
    if (!addon) {
        try {
            const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}`);
            if (res.ok)
                addon = await res.json();
        }
        catch (_) { /* ignore */ }
    }
    if (!addon || !_buildAddonWebUrl(addon)) {
        showToast(t('apps.configure_web_ui_first'), 'warning');
        return;
    }
    if (!_canUseIngressWebUi(addon)) {
        let url = _buildAddonWebUrl(addon);
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
    }
    const viewer = document.getElementById('addon-ui-viewer');
    const frame = document.getElementById('addon-ui-frame');
    if (!viewer || !frame) {
        window.open(_buildAddonUiEmbedUrl(slug), '_blank', 'noopener,noreferrer');
        return;
    }
    _addonUiSlug = slug;
    _prepareAddonUiOverlay();
    _setAddonUiHeader(addon);
    frame.title = addon.name || slug;
    viewer.classList.add('open');
    viewer.setAttribute('aria-hidden', 'false');
    frame.src = _buildAddonUiEmbedUrl(slug);
    _stopPoll();
}
// ── background poll ─────────────────────────────────────────────────────
function _startPoll() {
    _stopPoll();
    _pollTimer = setInterval(async () => {
        const panel = document.getElementById('cfg-tab-addons');
        if (!panel || panel.classList.contains('hidden')) {
            _stopPoll();
            return;
        }
        try {
            // If detail view is open, update that
            const detail = document.getElementById('app-detail');
            if (detail) {
                const slug = detail.dataset.slug;
                if (slug)
                    await _refreshDetailStatus(slug);
                return;
            }
            // Otherwise update summary list badges
            const res = await apiCall('/api/addons/process/status');
            const statuses = await res.json();
            document.querySelectorAll('.app-summary').forEach(card => {
                const cardEl = card;
                const slug = cardEl.dataset.slug;
                if (!slug)
                    return;
                const s = statuses[slug];
                if (!s)
                    return;
                const badgeWrap = card.querySelector('.app-summary-badge');
                if (badgeWrap) {
                    const cached = _addonsCache.find(a => a.slug === slug);
                    badgeWrap.innerHTML = _updateIndicator(cached) + _statusBadge(s.status || 'stopped') + '<i class="fas fa-chevron-right text-slate-600 text-xs ml-3"></i>';
                }
            });
        }
        catch (_) { }
    }, 5000);
}
function _stopPoll() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}
