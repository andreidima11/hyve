/**
 * features_apps.js — Apps page: addon process management + lifecycle.
 */
import { apiCall } from './api.js';
import { showToast, escapeHtml, showConfirm } from './utils.js';

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



// ── render: summary card (list view) ────────────────────────────────────

function _addonStatusBadge(addon, processStatus) {
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    if (!installed) return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">Disponibil</span>';
    if (addon.start_command && processStatus) return _statusBadge(processStatus.status || 'stopped');
    if (enabled) return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>Activ</span>';
    return '<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>Instalat</span>';
}

function _renderSummaryCard(addon, status) {
    const slug = addon.slug;
    const icon = addon.icon || 'fas fa-puzzle-piece';
    const cm = _colorMap[addon.color] || _colorMap.slate;
    const installed = addon.state?.installed;
    const ext = status?.external ? ' (extern)' : '';

    return `
    <button type="button" onclick="openAppDetail('${escapeHtml(slug)}')"
        class="app-summary w-full text-left rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 transition-all hover:border-white/[0.12] hover:bg-white/[0.04] active:scale-[0.995]"
        data-slug="${escapeHtml(slug)}">
        <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-3.5 min-w-0">
                <div class="w-10 h-10 rounded-xl ${cm.bg} flex items-center justify-center flex-shrink-0">
                    <i class="${escapeHtml(icon)} ${cm.text}"></i>
                </div>
                <div class="min-w-0">
                    <h3 class="text-white font-semibold text-sm truncate">${escapeHtml(addon.name)}</h3>
                    <p class="text-slate-500 text-xs mt-0.5 truncate">${escapeHtml(addon.description || '')}</p>
                </div>
            </div>
            <div class="app-summary-badge flex items-center gap-3 flex-shrink-0">
                ${_addonStatusBadge(addon, status)}${ext ? `<span class="text-[10px] text-slate-500">${ext}</span>` : ''}
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
    const ext = status?.external;
    const hasProcess = !!addon.start_command;
    const isAdmin = !!window.__isAdmin;
    const hasSchema = (addon.config_schema || []).length > 0;

    // Lifecycle controls (install / enable-disable / uninstall) — admin only
    let lifecycleHtml = '';
    if (isAdmin) {
        if (!installed) {
            lifecycleHtml = `
            <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Instalare</span>
                <div id="preflight-area" class="hidden space-y-2"></div>
                <p class="text-xs text-slate-500">Add-on-ul nu este instalat.</p>
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
            const integrationLinkHtml = hasSchema ? `
                <button type="button" onclick="document.querySelector('[data-config-tab=integrations]')?.click(); setTimeout(() => window.openIntegrationConfigModal && window.openIntegrationConfigModal('${escapeHtml(slug)}'), 200);"
                    class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all">
                    <i class="fas fa-sliders-h mr-1.5"></i>Setări în Integrări
                </button>` : '';
            lifecycleHtml = `
            <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 space-y-3">
                <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Administrare</span>
                <div class="flex flex-wrap gap-2">
                    ${enabled
                        ? `<button type="button" onclick="toggleApp('${escapeHtml(slug)}', false)" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all"><i class="fas fa-power-off mr-1.5"></i>Disable</button>`
                        : `<button type="button" onclick="toggleApp('${escapeHtml(slug)}', true)" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"><i class="fas fa-check mr-1.5"></i>Enable</button>`
                    }
                    <button type="button" onclick="uninstallApp('${escapeHtml(slug)}')" class="px-3.5 py-2 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"><i class="fas fa-trash-alt mr-1.5"></i>Dezinstalează</button>
                    ${integrationLinkHtml}
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
            <div class="w-10 h-10 rounded-xl ${cm.bg} flex items-center justify-center flex-shrink-0">
                <i class="${escapeHtml(icon)} ${cm.text}"></i>
            </div>
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
                <div id="app-detail-badge">${_statusBadge(st)}${ext ? '<span class="ml-2 text-[10px] text-slate-500">(extern)</span>' : ''}</div>
            </div>
            <div class="flex items-center gap-4 text-xs text-slate-500">
                <span><i class="fas fa-microchip mr-1 opacity-60"></i>PID: <span id="app-detail-pid">${pid}</span></span>
                <span id="app-detail-uptime-wrap" class="${up ? '' : 'hidden'}"><i class="fas fa-clock mr-1 opacity-60"></i>Uptime: <span id="app-detail-uptime">${up}</span></span>
                <span><i class="fas fa-tag mr-1 opacity-60"></i>v${escapeHtml(addon.version || '?')}</span>
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
                <i class="fas fa-tag mr-1 opacity-60"></i>v${escapeHtml(addon.version || '?')}
                <span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">Disponibil</span>
            </div>
        </div>
        ` : `
        <!-- Installed but no process -->
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>v${escapeHtml(addon.version || '?')}
                ${enabled
                    ? '<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>Activ</span>'
                    : '<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>Instalat</span>'
                }
            </div>
        </div>
        `}

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
    const ext = s?.external;

    const badge = document.getElementById('app-detail-badge');
    if (badge) badge.innerHTML = _statusBadge(st) + (ext ? '<span class="ml-2 text-[10px] text-slate-500">(extern)</span>' : '');

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
    if (content) content.textContent = '';
    if (status)  status.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Se instalează...';
    if (closeBtn) closeBtn.classList.add('hidden');
    if (modal)  { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); }

    // Get short-lived exchange token for SSE (avoids passing long-lived JWT in URL)
    let token;
    try {
        const { getSSEToken } = await import('./api.js');
        token = await getSSEToken();
    } catch (_) {
        token = localStorage.getItem('memini_token') || '';
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
            showToast('Add-on instalat cu succes!', 'success');
            _openSlug = slug;
            loadApps();
            return;
        }

        if (typeof line === 'string' && line.startsWith('__FAIL__:')) {
            es.close();
            _installEventSource = null;
            const msg = line.slice('__FAIL__:'.length);
            if (content) content.textContent += `\n❌ ${msg}\n`;
            if (status)  status.innerHTML = '<i class="fas fa-times-circle mr-1.5 text-red-400"></i><span class="text-red-400">Instalare eșuată</span>';
            if (closeBtn) closeBtn.classList.remove('hidden');
            showToast('Eroare la instalare', 'error');
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

export async function uninstallApp(slug) {
    if (!(await showConfirm(`Dezinstalezi add-on-ul "${slug}"?`))) return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' });
        if (res.ok) {
            showToast('Add-on dezinstalat', 'success');
            _openSlug = slug;
            await loadApps();
        } else {
            showToast('Eroare la dezinstalare', 'error');
        }
    } catch (e) {
        showToast('Eroare de rețea', 'error');
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
            showToast('Eroare', 'error');
        }
    } catch (e) {
        showToast('Eroare de rețea', 'error');
    }
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
                    const ext = s.external ? '<span class="ml-1 text-[10px] text-slate-500">(extern)</span>' : '';
                    badgeWrap.innerHTML = _statusBadge(s.status) + ext + '<i class="fas fa-chevron-right text-slate-600 text-xs ml-3"></i>';
                }
            });
        } catch (_) {}
    }, 5000);
}

function _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
