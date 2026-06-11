import { escapeHtml } from '../utils.js';
import { t } from '../lang/index.js';
import { isAdmin } from '../user_context.js';
export function _errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
/** Format manifest/runtime version — avoid "vstable" for Docker channel tags. */
export function _formatAddonVersion(version) {
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
export function _statusBadge(s) {
    if (s === 'running')
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px] animate-pulse"></i>${escapeHtml(t('apps.process_status_running'))}</span>`;
    if (s === 'exited')
        return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('apps.process_status_exited'))}</span>`;
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('apps.process_status_stopped'))}</span>`;
}
export function _uptime(sec) {
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
export function _canUseIngressWebUi(addon) {
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
export function _buildAddonWebUrl(addon) {
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
export function _addonStatusBadge(addon, processStatus) {
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
export function _updateIndicator(addon) {
    if (!addon || !addon.update_available)
        return '';
    return `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/15 text-amber-300 flex-shrink-0" title="${escapeHtml(t('updates.update_available'))}"><i class="fas fa-arrow-up text-[9px]"></i></span>`;
}
export function _renderSummaryCard(addon, status) {
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
export function _renderDetail(addon, status) {
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
