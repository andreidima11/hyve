/**
 * Apps page: HTML render helpers for addon cards and detail view.
 */
import { apiCall } from '../api.js';
import { showToast, escapeHtml, showConfirm } from '../utils.js';
import { t, translateApiDetail } from '../lang/index.js';
import { switchTab, openConfigSection } from '../nav_bridge.js';
import { isExplicitNonAdmin } from '../user_context.js';
import type {
    AddonCatalogEntry,
    AddonColorKey,
    AddonConfigField,
    AddonPreflightCheck,
    AddonProcessStatus,
    AddonProcessStatusMap,
    AddonSerialPort,
} from '../types/features_apps.js';
import { renderAddonConfigField, renderAddonSerialConfigField, resolveAddonConfigValue } from '../addons/config_form.js';
import { appsState } from './state.js';
export function _errMsg(err: unknown): string {
    if (err instanceof Error) {
        const msg = err.message.trim();
        if (msg && msg !== '[object Object]') return msg;
        return t('common.error');
    }
    if (err && typeof err === 'object') {
        const translated = translateApiDetail(err);
        if (translated) return translated;
    }
    return String(err);
}

/** Format manifest/runtime version — avoid "vstable" for Docker channel tags. */
export function _formatAddonVersion(version: string | null | undefined): string {
    const raw = String(version ?? '?').trim() || '?';
    if (raw === '?') return raw;
    if (/<[^>]+>|DOCTYPE/i.test(raw) || raw.length > 64) return '?';
    if (/^v[\d.]/i.test(raw)) return raw;
    if (/^\d/.test(raw)) return `v${raw}`;
    if (/^[a-zA-Z][\w.-]*$/.test(raw)) return raw;
    return `v${raw}`;
}
type AddonColorClasses = { bg: string; text: string };
const _colorMap: Record<AddonColorKey, AddonColorClasses> = {
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

export function _statusBadge(s: string) {
    if (s === 'running') return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px] animate-pulse"></i>${escapeHtml(t('apps.process_status_running'))}</span>`;
    if (s === 'exited')  return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('apps.process_status_exited'))}</span>`;
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('apps.process_status_stopped'))}</span>`;
}

export function _uptime(sec: number | undefined | null) {
    if (!sec) return '';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
}

export function _canUseIngressWebUi(addon: AddonCatalogEntry) {
    const webUi = addon?.web_ui || {};
    if (!Object.keys(webUi).length || webUi.ingress === false) return false;

    const cfg = addon?.state?.config || {};
    const directUrl = `${cfg[webUi.url_key || ''] || ''}`.trim();
    if (directUrl) {
        try {
            const parsed = new URL(directUrl);
            return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        } catch (_) {
            return false;
        }
    }

    const rawHost = `${webUi.host ?? cfg[webUi.host_key || 'host'] ?? cfg.host ?? 'localhost'}`.trim().toLowerCase();
    if (!rawHost || rawHost.includes('://')) return false;
    return ['localhost', '127.0.0.1', '::1'].includes(rawHost);
}

export function _buildAddonWebUrl(addon: AddonCatalogEntry) {
    const webUi = addon?.web_ui || {};
    const cfg = addon?.state?.config || {};
    if (!Object.keys(webUi).length) return '';

    if (_canUseIngressWebUi(addon)) {
        const slug = encodeURIComponent(addon.slug || '');
        return `/api/addons/${slug}/ui/open`;
    }

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

function _renderConfigField(field: AddonConfigField, value: unknown, canEdit: boolean) {
    if (field.detect === 'serial') {
        return renderAddonSerialConfigField(field, value, canEdit, 'data-addon-config');
    }
    return renderAddonConfigField(field, value, canEdit, 'data-addon-config');
}

function _renderConfigSection(addon: AddonCatalogEntry, canEdit: boolean) {
    const schema = addon.config_schema || [];
    if (!schema.length) return '';

    const cfg = addon.state?.config || {};
    const suggestions = (addon as AddonCatalogEntry & { config_suggestions?: Record<string, unknown> }).config_suggestions;
    const webUrl = _buildAddonWebUrl(addon);
    const intro = addon.state?.installed
        ? t('apps.config_intro_installed')
        : t('apps.config_intro_not_installed');
    const tokenMode = addon.slug === 'cloudflared' && `${cfg.tunnel_token || ''}`.trim().length > 0;
    const tokenBanner = tokenMode
        ? `<div class="hyd-callout hyd-callout--warning sm:col-span-2">${escapeHtml(t('apps.cloudflared_token_origin_hint'))}</div>`
        : '';

    return `
    <section class="hyd-app-card space-y-4">
        <header class="hyd-app-card__head">
            <div class="flex flex-wrap items-start justify-between gap-3 w-full min-w-0">
                <div class="space-y-1 min-w-0 flex-1">
                    <h2 class="hyd-app-card__title">${escapeHtml(t('apps.config_section'))}</h2>
                    <p class="hyd-app-card__hint">${escapeHtml(intro)}</p>
                </div>
                ${canEdit ? `<button type="button" data-config-action="saveAddonConfig" data-config-slug="${escapeHtml(addon.slug)}" class="hyd-btn hyd-btn--glow hyd-btn--sm flex-shrink-0 max-w-full"><i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(t('apps.save_config'))}</span></button>` : ''}
            </div>
        </header>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${tokenBanner}
            ${schema.map((field: AddonConfigField) => _renderConfigField(field, resolveAddonConfigValue(field, cfg, suggestions), canEdit)).join('')}
        </div>
        <div class="flex flex-wrap gap-2">
            ${canEdit ? `<button type="button" data-config-action="testAddonHealth" data-config-slug="${escapeHtml(addon.slug)}" class="hyd-btn hyd-btn--ghost hyd-btn--sm"><i class="fas fa-heart-pulse" aria-hidden="true"></i><span>${escapeHtml(t('apps.test_connection'))}</span></button>` : ''}
            ${webUrl ? `<button type="button" data-config-action="openAddonWebUI" data-config-slug="${escapeHtml(addon.slug)}" class="hyd-btn hyd-btn--ghost hyd-btn--sm"><i class="fas fa-display" aria-hidden="true"></i><span>${escapeHtml(t('apps.open_web_ui'))}</span></button>` : ''}
        </div>
    </section>`;
}


const _addonAccentHex: Record<string, string> = {
    cyan: '#22d3ee', blue: '#60a5fa', purple: '#c084fc', fuchsia: '#e879f9',
    amber: '#fbbf24', red: '#f87171', green: '#4ade80', emerald: '#34d399',
    slate: '#94a3b8', indigo: '#818cf8', rose: '#fb7185',
};

function _addonIconHtml(addon: AddonCatalogEntry) {
    const icon = escapeHtml(addon.icon || 'fas fa-puzzle-piece');
    if (addon.image) {
        return `<span class="hyd-icon hyd-icon--list hyd-icon--photo"><img src="${escapeHtml(addon.image)}" alt="" loading="lazy"></span>`;
    }
    const accent = _addonAccentHex[(addon.color as AddonColorKey) || 'slate'] || _addonAccentHex.slate;
    return `<span class="hyd-icon hyd-icon--list" style="color:${escapeHtml(accent)};background:color-mix(in oklab, ${escapeHtml(accent)} 16%, var(--surface-card));"><i class="${icon}" aria-hidden="true"></i></span>`;
}

function _filteredAddons(addons: AddonCatalogEntry[]) {
    const q = appsState.listFilter;
    if (!q) return addons;
    return addons.filter((a) => {
        const hay = `${a.name || ''} ${a.description || ''} ${a.slug || ''}`.toLowerCase();
        return hay.includes(q);
    });
}

export function _addonRowTags(addon: AddonCatalogEntry, processStatus: AddonProcessStatus | undefined) {
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    const tags: string[] = [];

    if (addon.update_available) {
        tags.push(`<span class="hyd-row-badge hyd-row-badge--warn" title="${escapeHtml(t('updates.update_available'))}"><i class="fas fa-arrow-up" aria-hidden="true"></i>${escapeHtml(t('updates.update_available'))}</span>`);
    }

    if (!installed) {
        tags.push(`<span class="hyd-row-badge hyd-row-badge--muted">${escapeHtml(t('hy.addon_status_available'))}</span>`);
    } else if (!enabled) {
        tags.push(`<span class="hyd-status-dot hyd-status-dot--off" title="${escapeHtml(t('hy.addon_status_disabled'))}"></span>`);
        tags.push(`<span class="hyd-row-badge hyd-row-badge--muted">${escapeHtml(t('hy.addon_status_disabled'))}</span>`);
    } else if (addon.start_command && processStatus) {
        const st = processStatus.status || 'stopped';
        if (st === 'running') {
            tags.push(`<span class="hyd-status-dot hyd-status-dot--on" title="${escapeHtml(t('apps.process_status_running'))}"></span>`);
            tags.push(`<span class="hyd-row-badge hyd-row-badge--ok">${escapeHtml(t('apps.process_status_running'))}</span>`);
        } else if (st === 'exited') {
            tags.push(`<span class="hyd-status-dot hyd-status-dot--off"></span>`);
            tags.push(`<span class="hyd-row-badge hyd-row-badge--err">${escapeHtml(t('apps.process_status_exited'))}</span>`);
        } else {
            tags.push(`<span class="hyd-status-dot hyd-status-dot--off"></span>`);
            tags.push(`<span class="hyd-row-badge hyd-row-badge--muted">${escapeHtml(t('apps.process_status_stopped'))}</span>`);
        }
    } else if (enabled) {
        tags.push(`<span class="hyd-status-dot hyd-status-dot--on"></span>`);
        tags.push(`<span class="hyd-row-badge hyd-row-badge--ok">${escapeHtml(t('hy.addon_status_active'))}</span>`);
    } else {
        tags.push(`<span class="hyd-row-badge hyd-row-badge--warn">${escapeHtml(t('hy.addon_status_installed'))}</span>`);
    }

    const version = _formatAddonVersion(addon.version || addon.state?.version);
    if (version && version !== '?') {
        tags.push(`<span class="hyd-row-badge"><span class="mono">${escapeHtml(version)}</span></span>`);
    }

    return tags.join('');
}

export function _renderAddonRow(addon: AddonCatalogEntry, status: AddonProcessStatus | undefined) {
    const slug = escapeHtml(addon.slug);
    const name = escapeHtml(addon.name || addon.slug || '');
    const sub = escapeHtml(addon.description || addon.slug || '');
    const tags = _addonRowTags(addon, status);
    return `
    <article class="hyd-entity-row" data-addon-row="${slug}" data-config-action="openAppDetail" data-config-slug="${slug}" role="listitem">
        ${_addonIconHtml(addon)}
        <div class="hyd-entity-row__body">
            <div class="hyd-entity-row__name">${name}</div>
            <div class="hyd-entity-row__sub">${sub}</div>
            <div class="hyd-entity-row__tags">${tags}</div>
        </div>
        <div class="hyd-entity-row__meta">
            <i class="fas fa-chevron-right hyd-entity-row__chev" aria-hidden="true"></i>
        </div>
    </article>`;
}

export function _renderAppsList() {
    const wrap = document.getElementById('apps-list');
    const empty = document.getElementById('apps-empty');
    if (!wrap) return;

    const addons = _filteredAddons(appsState.addonsCache);
    if (!appsState.addonsCache.length) {
        wrap.innerHTML = '';
        if (empty) {
            empty.classList.remove('hidden');
            empty.innerHTML = `<i class="fas fa-puzzle-piece hyd-list-placeholder__icon" aria-hidden="true"></i><p>${escapeHtml(t('hy.addon_list_empty'))}</p>`;
        }
        return;
    }

    if (!addons.length) {
        wrap.innerHTML = '';
        if (empty) empty.classList.add('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');
    wrap.innerHTML = addons.map((a) => _renderAddonRow(a, appsState.statusMap[a.slug])).join('');
}

// ── render: detail view ─────────────────────────────────────────────────

export function _renderDetail(addon: AddonCatalogEntry, status: AddonProcessStatus | undefined) {
    const slug = addon.slug;
    const icon = addon.icon || 'fas fa-puzzle-piece';
    const cm = _colorMap[(addon.color as AddonColorKey) || 'slate'] || _colorMap.slate;
    const st = status?.status || 'stopped';
    const installed = addon.state?.installed;
    const enabled = addon.state?.enabled;
    const isRunning = !!enabled && st === 'running';
    const canStart = !!enabled && !isRunning;
    const pid = status?.pid || '—';
    const up = _uptime(status?.uptime);
    const hasProcess = !!addon.start_command;
    const canEdit = !isExplicitNonAdmin();
    const isAdminUser = canEdit;
    const hasConfigSchema = !!(addon.config_schema || []).length;
    const configHtml = _renderConfigSection(addon, canEdit);
    // Show the real installed version (resolved from the package) when installed;
    // fall back to the manifest version for not-installed add-ons.
    const displayVersion = addon.version || addon.state?.version || '?';
    const descriptionText = String(addon.long_description || addon.description || '').trim();
    const descriptionHtml = descriptionText ? `
        <section class="hyd-app-card">
            <header class="hyd-app-card__head">
                <h2 class="hyd-app-card__title">${escapeHtml(t('apps.description_section'))}</h2>
            </header>
            <p class="text-xs sm:text-sm text-slate-400 leading-relaxed">${escapeHtml(descriptionText)}</p>
        </section>` : '';

    // Lifecycle controls (install / enable-disable / uninstall) — admin only
    let lifecycleHtml = '';
    if (isAdminUser) {
        if (!installed) {
            lifecycleHtml = `
            <section class="hyd-app-card space-y-3">
                <header class="hyd-app-card__head">
                    <h2 class="hyd-app-card__title">${escapeHtml(t('apps.local_install_title'))}</h2>
                </header>
                <div id="preflight-area" class="hidden space-y-2"></div>
                <p class="text-xs text-slate-500">${escapeHtml(t('apps.local_install_desc'))}</p>
                <div class="flex gap-2">
                    <button type="button" id="preflight-btn" data-config-action="runPreflight" data-config-slug="${escapeHtml(slug)}" class="hyd-btn hyd-btn--ghost flex-1">
                        <i class="fas fa-stethoscope" aria-hidden="true"></i><span>${escapeHtml(t('apps.check_requirements'))}</span>
                    </button>
                    <button type="button" id="install-btn" data-config-action="installApp" data-config-slug="${escapeHtml(slug)}" class="hyd-btn hyd-btn--glow flex-1">
                        <i class="fas fa-download" aria-hidden="true"></i><span>${escapeHtml(t('hy.addon_install_btn'))}</span>
                    </button>
                </div>
            </section>`;
        } else {
            const watchdogOn = !!addon.state?.watchdog;
            const adminSaveBtn = isAdminUser && hasProcess && !hasConfigSchema
                ? `<button type="button" data-config-action="saveAddonConfig" data-config-slug="${escapeHtml(slug)}" class="hyd-btn hyd-btn--glow hyd-btn--sm flex-shrink-0"><i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(t('apps.save_config'))}</span></button>`
                : '';
            lifecycleHtml = `
            <section class="hyd-app-card space-y-3">
                <header class="hyd-app-card__head">
                    <div class="flex flex-wrap items-start justify-between gap-3 w-full min-w-0">
                        <h2 class="hyd-app-card__title min-w-0">${escapeHtml(t('apps.admin_section'))}</h2>
                        ${adminSaveBtn}
                    </div>
                </header>
                ${hasProcess ? `
                <label class="rounded-xl border border-theme-light bg-white/[0.02] px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" id="addon-watchdog-${escapeHtml(slug)}" ${watchdogOn ? 'checked' : ''}
                        data-addon-watchdog="${escapeHtml(slug)}"
                        class="mt-0.5 rounded border-theme-subtle bg-slate-900 text-accent focus:ring-accent/40">
                    <span class="min-w-0">
                        <span class="block text-sm text-white"><i class="fas fa-shield-halved mr-1.5 opacity-70"></i>${escapeHtml(t('apps.watchdog_auto_restart'))}</span>
                        <span class="block text-[11px] text-slate-500 mt-1">${escapeHtml(t('apps.watchdog_auto_restart_hint'))}</span>
                    </span>
                </label>
                ` : ''}
                <div class="flex flex-wrap gap-2">
                    ${enabled
                        ? `<button type="button" data-config-action="toggleApp" data-config-slug="${escapeHtml(slug)}" data-config-enabled="false" class="hyd-btn hyd-btn--ghost hyd-btn--sm"><i class="fas fa-power-off" aria-hidden="true"></i><span>${escapeHtml(t('common.disable'))}</span></button>`
                        : `<button type="button" data-config-action="toggleApp" data-config-slug="${escapeHtml(slug)}" data-config-enabled="true" class="hyd-btn hyd-btn--success hyd-btn--sm"><i class="fas fa-check" aria-hidden="true"></i><span>${escapeHtml(t('common.enable'))}</span></button>`
                    }
                    ${addon.update_available ? `<button type="button" data-config-action="goToAddonUpdates" class="hyd-btn hyd-btn--ghost hyd-btn--sm"><i class="fas fa-arrow-up" aria-hidden="true"></i><span>${escapeHtml(t('updates.update_available'))}</span></button>` : ''}
                    <button type="button" data-config-action="uninstallApp" data-config-slug="${escapeHtml(slug)}" class="hyd-btn hyd-btn--danger hyd-btn--sm"><i class="fas fa-trash-alt" aria-hidden="true"></i><span>${escapeHtml(t('apps.uninstall'))}</span></button>
                </div>
            </section>`;
        }
    }

    return `
    <div id="app-detail" class="space-y-5 min-w-0 max-w-full" data-slug="${escapeHtml(slug)}">
        <header class="hyd-page__header min-w-0">
            <button type="button" data-config-action="closeAppDetail" class="hyd-page__back" data-i18n-title="hy.back" aria-label="Back">
                <i class="fas fa-arrow-left" aria-hidden="true"></i>
            </button>
            <div class="hyd-page__titles min-w-0 flex items-center gap-3">
                ${addon.image
                    ? `<img src="${escapeHtml(addon.image)}" alt="" class="w-10 h-10 rounded-xl object-contain flex-shrink-0" loading="lazy">`
                    : `<div class="w-10 h-10 rounded-xl ${cm.bg} flex items-center justify-center flex-shrink-0"><i class="${escapeHtml(icon)} ${cm.text}"></i></div>`}
                <h2 class="text-white font-semibold text-lg truncate min-w-0">${escapeHtml(addon.name)}</h2>
            </div>
        </header>

        ${descriptionHtml}

        ${hasProcess && installed ? `
        <section class="hyd-app-card space-y-4">
            <header class="hyd-app-card__head">
                <div class="flex flex-wrap items-center justify-between gap-3 w-full min-w-0">
                    <h2 class="hyd-app-card__title min-w-0">${escapeHtml(t('apps.process_section'))}</h2>
                    <div id="app-detail-badge" class="flex-shrink-0">${enabled ? _statusBadge(st) : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_disabled'))}</span>`}</div>
                </div>
            </header>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 min-w-0">
                <span><i class="fas fa-microchip mr-1 opacity-60"></i>PID: <span id="app-detail-pid">${pid}</span></span>
                <span id="app-detail-uptime-wrap" class="${up ? '' : 'hidden'}"><i class="fas fa-clock mr-1 opacity-60"></i>${escapeHtml(t('apps.uptime'))}: <span id="app-detail-uptime">${up}</span></span>
                <span><i class="fas fa-tag mr-1 opacity-60"></i>${escapeHtml(_formatAddonVersion(displayVersion))}</span>
            </div>
            <div class="flex flex-wrap gap-2">
                <button data-config-action="appAction" data-config-slug="${slug}" data-config-app-action="start" id="app-detail-start" class="hyd-btn hyd-btn--success hyd-btn--sm ${!canStart ? 'opacity-40 cursor-not-allowed' : ''}" ${!canStart ? 'disabled' : ''}>
                    <i class="fas fa-play" aria-hidden="true"></i><span>${escapeHtml(t('apps.start'))}</span>
                </button>
                <button data-config-action="appAction" data-config-slug="${slug}" data-config-app-action="stop" id="app-detail-stop" class="hyd-btn hyd-btn--danger hyd-btn--sm ${!isRunning ? 'opacity-40 cursor-not-allowed' : ''}" ${!isRunning ? 'disabled' : ''}>
                    <i class="fas fa-stop" aria-hidden="true"></i><span>${escapeHtml(t('apps.stop'))}</span>
                </button>
                <button data-config-action="appAction" data-config-slug="${slug}" data-config-app-action="restart" id="app-detail-restart" class="hyd-btn hyd-btn--ghost hyd-btn--sm ${!isRunning ? 'opacity-40 cursor-not-allowed' : ''}" ${!isRunning ? 'disabled' : ''}>
                    <i class="fas fa-sync-alt" aria-hidden="true"></i><span>${escapeHtml(t('apps.restart'))}</span>
                </button>
                <button data-config-action="openAppLogModal" data-config-slug="${slug}" data-config-app-name="${escapeHtml(addon.name)}" class="hyd-btn hyd-btn--ghost hyd-btn--sm">
                    <i class="fas fa-terminal" aria-hidden="true"></i><span>${escapeHtml(t('apps.logs'))}</span>
                </button>
            </div>
        </section>
        ` : !installed ? `
        <section class="hyd-app-card">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>${escapeHtml(_formatAddonVersion(displayVersion))}
                <span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400">${escapeHtml(t('hy.addon_status_available'))}</span>
            </div>
        </section>
        ` : `
        <section class="hyd-app-card">
            <div class="flex items-center gap-2 text-xs text-slate-500">
                <i class="fas fa-tag mr-1 opacity-60"></i>${escapeHtml(_formatAddonVersion(displayVersion))}
                ${enabled
                    ? `<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_active'))}</span>`
                    : `<span class="ml-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_installed'))}</span>`
                }
            </div>
        </section>
        `}

        ${configHtml}

        <!-- Lifecycle -->
        ${lifecycleHtml}
    </div>`;
}
