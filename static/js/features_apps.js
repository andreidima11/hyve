/**
 * features_apps.js — Apps page: addon process management + lifecycle.
 */
import { apiCall } from './api.js';
import { showToast, escapeHtml, showConfirm } from './utils.js';
import { t } from './lang/index.js';

let _currentLogSlug = null;
let _pollTimer = null;
let _openSlug = null;          // which addon detail is expanded

// Tailwind can't detect dynamic class names — use static map.
const _colorMap = {
    cyan:    { bg: 'bg-cyan-500/10',    text: 'text-cyan-400'    },
    blue:    { bg: 'bg-blue-500/10',    text: 'text-blue-400'    },
    purple:  { bg: 'bg-purple-500/10',  text: 'text-purple-400'  },
    fuchsia: { bg: 'bg-fuchsia-500/10', text: 'text-fuchsia-400' },
    amber:   { bg: 'bg-amber-500/10',   text: 'text-amber-400'   },
    red:     { bg: 'bg-red-500/10',     text: 'text-red-400'     },
    green:   { bg: 'bg-green-500/10',   text: 'text-green-400'   },
    emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    slate:   { bg: 'bg-slate-500/10',   text: 'text-slate-400'   },
    indigo:  { bg: 'bg-indigo-500/10',  text: 'text-indigo-400'  },
    rose:    { bg: 'bg-rose-500/10',    text: 'text-rose-400'    },
};

// ── helpers ─────────────────────────────────────────────────────────────

function _statusBadge(s) {
    if (s === 'running') return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px] animate-pulse"></i>Running</span>';
    if (s === 'exited')  return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400"><i class="fas fa-circle text-[6px]"></i>Exited</span>';
    return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400"><i class="fas fa-circle text-[6px]"></i>Stopped</span>';
}

function _uptime(sec) {
    if (!sec) return '';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
}

function _buildAddonWebUrl(addon) {
    const webUi = addon?.web_ui || {};
    const cfg = addon?.state?.config || {};
    if (!Object.keys(webUi).length) return '';

    const directUrl = `${cfg[webUi.url_key || ''] || ''}`.trim();
    if (directUrl) return directUrl;

    const rawHost = `${webUi.host ?? cfg[webUi.host_key || 'host'] ?? cfg.host ?? 'localhost'}`.trim();
    if (!rawHost) return '';
    if (rawHost.includes('://')) return rawHost;

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
        const options = field.options.map(opt => {
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
                <button type="button" onclick="detectAddonSerialPorts('${escapeHtml(key)}')" ${disabled}
                    class="px-3 py-2 rounded-xl text-xs font-semibold bg-accent/15 text-accent hover:bg-accent/25 transition-colors whitespace-nowrap"
                    title="Scanează adaptoarele USB">
                    <i class="fas fa-magnifying-glass mr-1"></i>Detectează
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
    if (!schema.length) return '';

    const cfg = addon.state?.config || {};
    const webUrl = _buildAddonWebUrl(addon);
    const intro = addon.state?.installed
        ? 'Ajustează setările acestui add-on local.'
        : 'Setările se aplică după instalarea locală a add-on-ului.';

    return `
    <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-4">
        <div class="space-y-1">
            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Configurare</span>
            <p class="text-xs text-slate-500">${escapeHtml(intro)}</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${schema.map(field => _renderConfigField(field, cfg[field.key], isAdmin)).join('')}
        </div>
        <div class="flex flex-wrap gap-2">
            ${isAdmin ? `<button type="button" onclick="saveAddonConfig('${escapeHtml(addon.slug)}')" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-accent text-bg-main hover:bg-accent-hover transition-all shadow-lg shadow-accent/20"><i class="fas fa-save mr-1.5"></i>Salvează configurația</button>` : ''}
            ${isAdmin ? `<button type="button" onclick="testAddonHealth('${escapeHtml(addon.slug)}')" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all"><i class="fas fa-heart-pulse mr-1.5"></i>Verifică conexiunea</button>` : ''}
            ${webUrl ? `<button type="button" onclick="openAddonWebUI('${escapeHtml(addon.slug)}')" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all"><i class="fas fa-up-right-from-square mr-1.5"></i>Open Web UI</button>` : ''}
        </div>
    </div>`;
}


// ── render: summary card (list view) ────────────────────────────────────

function _addonStatusBadge(addon, processStatus) {
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    if (!installed) return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">Disponibil</span>';
    if (addon.start_command && processStatus) return _statusBadge(processStatus.status || 'stopped');
    if (enabled) return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>Activ</span>';
    return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>Instalat</span>';
}

function _updateIndicator(addon) {
    if (!addon || !addon.update_available) return '';
    return `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/15 text-amber-300 flex-shrink-0" title="${escapeHtml(t('updates.update_available') || 'Update available')}"><i class="fas fa-arrow-up text-[9px]"></i></span>`;
}

function _renderSummaryCard(addon, status) {
    const slug = addon.slug;
    const icon = addon.icon || 'fas fa-puzzle-piece';
    const cm = _colorMap[addon.color] || _colorMap.slate;
    const installed = addon.state?.installed;
    const iconHtml = addon.image
        ? `<img src="${escapeHtml(addon.image)}" alt="" class="w-10 h-10 rounded-xl object-contain flex-shrink-0" loading="lazy">`
        : `<div class="w-10 h-10 rounded-xl ${cm.bg} flex items-center justify-center flex-shrink-0"><i class="${escapeHtml(icon)} ${cm.text}"></i></div>`;

    return `
    <button type="button" onclick="openAppDetail('${escapeHtml(slug)}')"
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
    const cm = _colorMap[addon.color] || _colorMap.slate;
    const st = status?.status || 'stopped';
    const isRunning = st === 'running';
    const pid = status?.pid || '—';
    const up = _uptime(status?.uptime);
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    const hasProcess = !!addon.start_command;
    const isAdmin = !!window.__isAdmin;
    const configHtml = _renderConfigSection(addon, isAdmin);
    // Show the real installed version (resolved from the package) when installed;
    // fall back to the manifest version for not-installed add-ons.
    const displayVersion = (installed && addon.state?.version) ? addon.state.version : (addon.version || '?');

    // Lifecycle controls (install / enable-disable / uninstall) — admin only
    let lifecycleHtml = '';
    if (isAdmin) {
        if (!installed) {
            lifecycleHtml = `
            <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Instalare locală</span>
                <div id="preflight-area" class="hidden space-y-2"></div>
                <p class="text-xs text-slate-500">Serviciul nu este instalat local încă. Îl poți instala aici și apoi îi poți ajusta setările.</p>
                <div class="flex gap-2">
                    <button type="button" id="preflight-btn" onclick="runPreflight('${escapeHtml(slug)}')" class="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-colors">
                        <i class="fas fa-stethoscope mr-1.5"></i>Verifică cerințe
                    </button>
                    <button type="button" id="install-btn" onclick="installApp('${escapeHtml(slug)}')" class="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold bg-accent text-bg-main hover:bg-accent-hover transition-colors shadow-lg shadow-accent/20">
                        <i class="fas fa-download mr-1.5"></i>Instalează
                    </button>
                </div>
            </div>`;
        } else {
            const watchdogOn = !!addon.state?.watchdog;
            lifecycleHtml = `
            <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Administrare</span>
                ${hasProcess ? `
                <label class="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" id="addon-watchdog-${escapeHtml(slug)}" ${watchdogOn ? 'checked' : ''}
                        onchange="toggleAddonWatchdog('${escapeHtml(slug)}', this.checked)"
                        class="mt-0.5 rounded border-white/10 bg-slate-900 text-accent focus:ring-accent/40">
                    <span class="min-w-0">
                        <span class="block text-sm text-white"><i class="fas fa-shield-halved mr-1.5 opacity-70"></i>Restartare automată (watchdog)</span>
                        <span class="block text-[11px] text-slate-500 mt-1">Pornește serviciul odată cu Hyve și îl repornește dacă procesul cade.</span>
                    </span>
                </label>
                ` : ''}
                <div class="flex flex-wrap gap-2">
                    ${enabled
                        ? `<button type="button" onclick="toggleApp('${escapeHtml(slug)}', false)" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all"><i class="fas fa-power-off mr-1.5"></i>Disable</button>`
                        : `<button type="button" onclick="toggleApp('${escapeHtml(slug)}', true)" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"><i class="fas fa-check mr-1.5"></i>Enable</button>`
                    }
                    ${addon.update_available ? `<button type="button" onclick="goToAddonUpdates()" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-all"><i class="fas fa-arrow-up mr-1.5"></i>${escapeHtml(t('updates.update_available') || 'Update available')}</button>` : ''}
                    <button type="button" onclick="uninstallApp('${escapeHtml(slug)}')" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"><i class="fas fa-trash-alt mr-1.5"></i>Dezinstalează</button>
                </div>
            </div>`;
        }
    }

    return `
    <div id="app-detail" class="space-y-5" data-slug="${escapeHtml(slug)}">
        <!-- Header -->
        <div class="flex items-center gap-3">
            <button type="button" onclick="closeAppDetail()" class="w-9 h-9 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center text-slate-400 transition-all">
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
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Proces</span>
                <div id="app-detail-badge">${_statusBadge(st)}</div>
            </div>
            <div class="flex items-center gap-4 text-xs text-slate-500">
                <span><i class="fas fa-microchip mr-1 opacity-60"></i>PID: <span id="app-detail-pid">${pid}</span></span>
                <span id="app-detail-uptime-wrap" class="${up ? '' : 'hidden'}"><i class="fas fa-clock mr-1 opacity-60"></i>Uptime: <span id="app-detail-uptime">${up}</span></span>
                <span><i class="fas fa-tag mr-1 opacity-60"></i>v${escapeHtml(displayVersion)}</span>
            </div>
            <div class="flex flex-wrap gap-2">
                <button onclick="appAction('${slug}','start')" id="app-detail-start" class="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${isRunning ? 'bg-white/[0.03] text-slate-600 cursor-not-allowed' : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}" ${isRunning ? 'disabled' : ''}>
                    <i class="fas fa-play mr-1.5"></i>Start
                </button>
                <button onclick="appAction('${slug}','stop')" id="app-detail-stop" class="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${!isRunning ? 'bg-white/[0.03] text-slate-600 cursor-not-allowed' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}" ${!isRunning ? 'disabled' : ''}>
                    <i class="fas fa-stop mr-1.5"></i>Stop
                </button>
                <button onclick="appAction('${slug}','restart')" id="app-detail-restart" class="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${!isRunning ? 'bg-white/[0.03] text-slate-600 cursor-not-allowed' : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'}" ${!isRunning ? 'disabled' : ''}>
                    <i class="fas fa-sync-alt mr-1.5"></i>Restart
                </button>
                <button onclick="openAppLogModal('${slug}', '${escapeHtml(addon.name)}')" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] transition-all">
                    <i class="fas fa-terminal mr-1.5"></i>Loguri
                </button>
            </div>
        </div>
        ` : !installed ? `
        <!-- Not installed info -->
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>v${escapeHtml(displayVersion)}
                <span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">Disponibil</span>
            </div>
        </div>
        ` : `
        <!-- Installed but no process -->
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>v${escapeHtml(displayVersion)}
                ${enabled
                    ? '<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>Activ</span>'
                    : '<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>Instalat</span>'
                }
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
    if (!container) return;

    try {
        const [addonsRes, statusRes] = await Promise.all([
            apiCall('/api/addons'),
            apiCall('/api/addons/process/status'),
        ]);
        const addons = await addonsRes.json();
        const statuses = await statusRes.json();

        _addonsCache = addons;

        if (!addons.length) {
            container.innerHTML = '<div class="p-8 text-center text-slate-500 text-sm">Niciun add-on disponibil.</div>';
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
    } catch (e) {
        container.innerHTML = `<div class="p-8 text-center text-red-400 text-sm">Eroare: ${escapeHtml(String(e))}</div>`;
    }
}


// ── detail open/close ───────────────────────────────────────────────────

export async function openAppDetail(slug) {
    _openSlug = slug;
    const container = document.getElementById('apps-list');
    if (!container) return;

    try {
        const [addonRes, statusRes] = await Promise.all([
            apiCall(`/api/addons/${encodeURIComponent(slug)}`),
            apiCall(`/api/addons/${encodeURIComponent(slug)}/status`),
        ]);
        const addon = await addonRes.json();
        const status = await statusRes.json();
        const idx = _addonsCache.findIndex(a => a.slug === addon.slug);
        if (idx >= 0) _addonsCache[idx] = addon;
        else _addonsCache.push(addon);

        container.innerHTML = _renderDetail(addon, status);
    } catch (e) {
        showToast(`Eroare: ${e.message}`, 'error');
    }
}

export function closeAppDetail() {
    _openSlug = null;
    loadApps();
}

// ── actions ─────────────────────────────────────────────────────────────

export async function appAction(slug, action) {
    const btn = event?.target?.closest?.('button');
    if (btn) { btn.disabled = true; btn.classList.add('opacity-50'); }

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${action}`, { method: 'POST' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || res.statusText);
        }
        showToast(`${slug}: ${action} OK`, 'success');
        // Re-fetch status to update buttons
        await _refreshDetailStatus(slug);
    } catch (e) {
        showToast(`${slug}: ${e.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
    }
}

async function _refreshDetailStatus(slug) {
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/status`);
        const s = await res.json();
        _updateDetailUI(s);
    } catch (_) {}
}

function _updateDetailUI(s) {
    const st = s?.status || 'stopped';
    const isRunning = st === 'running';

    const badge = document.getElementById('app-detail-badge');
    if (badge) badge.innerHTML = _statusBadge(st);

    const pidEl = document.getElementById('app-detail-pid');
    if (pidEl) pidEl.textContent = s?.pid || '—';

    const upWrap = document.getElementById('app-detail-uptime-wrap');
    const upEl = document.getElementById('app-detail-uptime');
    if (upWrap) upWrap.classList.toggle('hidden', !s?.uptime);
    if (upEl) upEl.textContent = _uptime(s?.uptime);

    const startBtn = document.getElementById('app-detail-start');
    const stopBtn = document.getElementById('app-detail-stop');
    const restartBtn = document.getElementById('app-detail-restart');
    if (startBtn) { startBtn.disabled = isRunning; startBtn.classList.toggle('opacity-40', isRunning); }
    if (stopBtn) { stopBtn.disabled = !isRunning; stopBtn.classList.toggle('opacity-40', !isRunning); }
    if (restartBtn) { restartBtn.disabled = !isRunning; restartBtn.classList.toggle('opacity-40', !isRunning); }
}

// ── logs ────────────────────────────────────────────────────────────────

let _logPollTimer = null;

export function openAppLogModal(slug, name) {
    _currentLogSlug = slug;
    const modal = document.getElementById('app-log-modal');
    const title = document.getElementById('app-log-title');
    if (title) title.innerHTML = `<i class="fas fa-terminal"></i><span>Loguri — ${escapeHtml(name)}</span>`;
    if (modal) { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); }
    refreshAppLogs();
    _stopLogPoll();
    _logPollTimer = setInterval(refreshAppLogs, 3000);
}

export function closeAppLogModal() {
    _currentLogSlug = null;
    _stopLogPoll();
    const modal = document.getElementById('app-log-modal');
    if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
}

function _stopLogPoll() {
    if (_logPollTimer) { clearInterval(_logPollTimer); _logPollTimer = null; }
}

export async function refreshAppLogs() {
    if (!_currentLogSlug) return;
    const pre = document.getElementById('app-log-content');
    if (!pre) return;

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentLogSlug)}/logs?tail=300`);
        const data = await res.json();
        const lines = data.lines || [];
        pre.textContent = lines.length ? lines.join('\n') : '(niciun log disponibil)';
        pre.scrollTop = pre.scrollHeight;
    } catch (e) {
        pre.textContent = `Eroare: ${e.message}`;
    }
}

// ── lifecycle (install / uninstall / enable / disable) ──────────────────

export async function runPreflight(slug) {
    const area = document.getElementById('preflight-area');
    const btn  = document.getElementById('preflight-btn');
    if (!area) return;

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Se verifică...'; }
    area.classList.remove('hidden');
    area.innerHTML = '<p class="text-xs text-slate-500"><i class="fas fa-spinner fa-spin mr-1.5"></i>Verificare cerințe...</p>';

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/install/preflight`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            area.innerHTML = `<p class="text-xs text-red-400"><i class="fas fa-exclamation-triangle mr-1.5"></i>${escapeHtml(err.detail || 'Eroare verificare')}</p>`;
            return;
        }
        const data = await res.json();
        const checks = data.checks || [];

        if (!checks.length) {
            area.innerHTML = '<p class="text-xs text-emerald-400"><i class="fas fa-check-circle mr-1.5"></i>Nicio verificare necesară — gata de instalare.</p>';
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
                    <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(c.fix)}')" class="px-2 py-1.5 rounded-lg text-[10px] font-bold bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] transition-all flex-shrink-0"><i class="fas fa-copy"></i></button>
                </div>` : ''}
            </div>`;
        }).join('');

        if (allOk) {
            area.innerHTML += '<p class="text-xs text-emerald-400 mt-1"><i class="fas fa-check-circle mr-1.5"></i>Toate cerințele sunt îndeplinite!</p>';
        }
    } catch (e) {
        area.innerHTML = `<p class="text-xs text-red-400"><i class="fas fa-exclamation-triangle mr-1.5"></i>Eroare: ${escapeHtml(e.message)}</p>`;
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stethoscope mr-1.5"></i>Verifică cerințe'; }
    }
}

let _installEventSource = null;

export async function installApp(slug) {
    // Open install-log modal and stream progress via SSE
    const modal   = document.getElementById('app-install-modal');
    const title   = document.getElementById('app-install-title');
    const content = document.getElementById('app-install-content');
    const status  = document.getElementById('app-install-status');
    const closeBtn = document.getElementById('app-install-close-btn');

    if (title) title.innerHTML = `<i class="fas fa-download"></i><span>Instalare — ${escapeHtml(slug)}</span>`;
    if (content) content.textContent = `${t('apps.install_preparing') || 'Preparing installation...'}\n`;
    if (status)  status.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Se instalează...';
    if (closeBtn) closeBtn.classList.add('hidden');
    if (modal)  { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); }

    // Get short-lived exchange token for SSE (avoids passing long-lived JWT in URL)
    let token;
    try {
        const { getSSEToken } = await import('./api.js');
        token = await getSSEToken();
    } catch (_) {
        token = '';
    }

    // Close previous stream if any
    if (_installEventSource) { _installEventSource.close(); _installEventSource = null; }

    const url = `/api/addons/${encodeURIComponent(slug)}/install/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    _installEventSource = es;

    es.onmessage = (ev) => {
        let line;
        try { line = JSON.parse(ev.data); } catch { line = ev.data; }

        if (line === '__DONE__') {
            es.close();
            _installEventSource = null;
            if (status)  status.innerHTML = '<i class="fas fa-check-circle mr-1.5 text-emerald-400"></i><span class="text-emerald-400">Instalare completă!</span>';
            if (closeBtn) closeBtn.classList.remove('hidden');
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
            if (content) content.textContent += `\n❌ ${msg}\n`;
            if (status)  status.innerHTML = '<i class="fas fa-times-circle mr-1.5 text-red-400"></i><span class="text-red-400">Instalare eșuată</span>';
            if (closeBtn) closeBtn.classList.remove('hidden');
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
        if (status)  status.innerHTML = '<i class="fas fa-times-circle mr-1.5 text-red-400"></i><span class="text-red-400">Conexiune pierdută</span>';
        if (closeBtn) closeBtn.classList.remove('hidden');
    };
}

export function closeInstallLogModal() {
    if (_installEventSource) { _installEventSource.close(); _installEventSource = null; }
    const modal = document.getElementById('app-install-modal');
    if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
}

/** Navigate to the Updates page where add-on updates are applied (generic, no slug needed). */
export function goToAddonUpdates() {
    try { if (typeof window.switchTab === 'function') window.switchTab('config'); } catch (_) {}
    if (typeof window.openConfigSection === 'function') window.openConfigSection('updates');
}

export async function uninstallApp(slug) {
    if (!(await showConfirm(`Dezinstalezi add-on-ul "${slug}"?`))) return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_uninstalled'), 'success');
            _openSlug = slug;
            await loadApps();
        } else {
            showToast(t('hy.addon_uninstall_error'), 'error');
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function toggleApp(slug, enabled) {
    const ep = enabled ? 'enable' : 'disable';
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${ep}`, { method: 'POST' });
        if (res.ok) {
            showToast(enabled ? 'Add-on activat' : 'Add-on dezactivat', 'success');
            _openSlug = slug;
            await loadApps();
        } else {
            showToast(t('common.error'), 'error');
        }
    } catch (e) {
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
            showToast(enabled ? 'Watchdog activat' : 'Watchdog dezactivat', 'success');
            const idx = _addonsCache.findIndex(a => a.slug === slug);
            if (idx >= 0) {
                _addonsCache[idx].state = { ...(_addonsCache[idx].state || {}), watchdog: !!enabled };
            }
        } else {
            const data = await res.json().catch(() => ({}));
            showToast(data.detail || 'Eroare la salvare watchdog', 'error');
            const cb = document.getElementById(`addon-watchdog-${slug}`);
            if (cb) cb.checked = !enabled;
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
        const cb = document.getElementById(`addon-watchdog-${slug}`);
        if (cb) cb.checked = !enabled;
    }
}

export async function detectAddonSerialPorts(fieldKey) {
    const safeKey = String(fieldKey || '');
    const root = document.getElementById('app-detail') || document;
    const input = root.querySelector(`[data-addon-config="${CSS.escape(safeKey)}"]`);
    const results = root.querySelector(`[data-addon-detect-results="${CSS.escape(safeKey)}"]`);
    if (!input || !results) return;
    results.classList.remove('hidden');
    results.innerHTML = `<div class="text-[11px] text-slate-500"><i class="fas fa-spinner fa-spin mr-1"></i>Scanare adaptoare USB...</div>`;
    try {
        const res = await apiCall('/api/addons/_helpers/detect-serial-ports');
        if (!res.ok) {
            results.innerHTML = `<div class="text-[11px] text-rose-300">Eroare la scanare</div>`;
            return;
        }
        const data = await res.json();
        const ports = data.ports || [];
        if (!ports.length) {
            results.innerHTML = `<div class="text-[11px] text-amber-300"><i class="fas fa-circle-info mr-1"></i>Niciun adaptor USB detectat. Verifică dacă dongle-ul Zigbee este conectat.</div>`;
            return;
        }
        results.innerHTML = `
            <div class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Adaptoare detectate (${ports.length})</div>
            ${ports.map(p => `
                <button type="button" data-detect-pick="${escapeHtml(p.path)}" class="w-full text-left px-3 py-2 rounded-lg bg-slate-950/80 hover:bg-slate-900 border border-white/[0.06] hover:border-accent/40 transition-colors flex items-center gap-2">
                    <i class="fas fa-plug text-accent text-xs"></i>
                    <span class="font-mono text-[11px] text-slate-300 flex-1 truncate">${escapeHtml(p.path)}</span>
                    <span class="text-[10px] text-accent">Selectează</span>
                </button>
            `).join('')}
        `;
        results.querySelectorAll('[data-detect-pick]').forEach(btn => {
            btn.addEventListener('click', () => {
                input.value = btn.dataset.detectPick;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                results.classList.add('hidden');
                showToast('Port selectat — nu uita să salvezi configurația', 'success');
            });
        });
    } catch (e) {
        results.innerHTML = `<div class="text-[11px] text-rose-300">Eroare de rețea</div>`;
    }
}

export async function saveAddonConfig(slug) {
    const detail = document.getElementById('app-detail');
    if (!detail) return;

    const fields = detail.querySelectorAll('[data-addon-config]');
    const body = {};
    fields.forEach(field => {
        const key = field.dataset.addonConfig;
        if (!key) return;
        if (field.type === 'checkbox') {
            body[key] = !!field.checked;
            return;
        }
        if (field.type === 'number') {
            const raw = `${field.value || ''}`.trim();
            body[key] = raw === '' ? '' : Number(raw);
            return;
        }
        body[key] = `${field.value || ''}`.trim();
    });

    // Persist watchdog state alongside config so a save can't desync it.
    const watchdogCb = document.getElementById(`addon-watchdog-${slug}`);
    if (watchdogCb) {
        try {
            await apiCall(`/api/addons/${encodeURIComponent(slug)}/watchdog`, {
                method: 'POST',
                body: { enabled: !!watchdogCb.checked },
            });
        } catch (_) { /* non-fatal — config save still proceeds */ }
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
        showToast('Configurația a fost salvată', 'success');
        _openSlug = slug;
        await openAppDetail(slug);
    } catch (e) {
        showToast(e.message || 'Eroare la salvare', 'error');
    }
}

export async function testAddonHealth(slug) {
    try {
        if (window.__isAdmin) {
            await saveAddonConfig(slug);
        }
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/health`);
        const data = await res.json();
        if (data?.ok) {
            showToast('Conexiune OK', 'success');
        } else {
            showToast(data?.detail || 'Serviciul nu răspunde', 'warning');
        }
        await _refreshDetailStatus(slug);
    } catch (e) {
        showToast(e.message || 'Verificare eșuată', 'error');
    }
}

export function openAddonWebUI(slug) {
    const addon = _addonsCache.find(a => a.slug === slug);
    const url = _buildAddonWebUrl(addon);
    if (!url) {
        showToast('Configurează mai întâi host-ul sau URL-ul Web UI', 'warning');
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

// ── background poll ─────────────────────────────────────────────────────

function _startPoll() {
    _stopPoll();
    _pollTimer = setInterval(async () => {
        const panel = document.getElementById('cfg-tab-addons');
        if (!panel || panel.classList.contains('hidden')) { _stopPoll(); return; }

        try {
            // If detail view is open, update that
            const detail = document.getElementById('app-detail');
            if (detail) {
                const slug = detail.dataset.slug;
                await _refreshDetailStatus(slug);
                return;
            }

            // Otherwise update summary list badges
            const res = await apiCall('/api/addons/process/status');
            const statuses = await res.json();
            document.querySelectorAll('.app-summary').forEach(card => {
                const slug = card.dataset.slug;
                const s = statuses[slug];
                if (!s) return;
                const badgeWrap = card.querySelector('.app-summary-badge');
                if (badgeWrap) {
                    const cached = _addonsCache.find(a => a.slug === slug);
                    badgeWrap.innerHTML = _updateIndicator(cached) + _statusBadge(s.status) + '<i class="fas fa-chevron-right text-slate-600 text-xs ml-3"></i>';
                }
            });
        } catch (_) {}
    }, 5000);
}

function _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
