/**
 * Add-ons settings: list card HTML render helpers.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
const _addonColorMap = {
    cyan: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: '#22d3ee', btnBg: 'bg-cyan-500/15', btnHover: 'hover:bg-cyan-500/25', btnText: 'text-cyan-300', btnBorder: 'border-cyan-500/25' },
    blue: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: '#3b82f6', btnBg: 'bg-blue-500/15', btnHover: 'hover:bg-blue-500/25', btnText: 'text-blue-300', btnBorder: 'border-blue-500/25' },
    emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: '#10b981', btnBg: 'bg-emerald-500/15', btnHover: 'hover:bg-emerald-500/25', btnText: 'text-emerald-300', btnBorder: 'border-emerald-500/25' },
    amber: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: '#f59e0b', btnBg: 'bg-amber-500/15', btnHover: 'hover:bg-amber-500/25', btnText: 'text-amber-300', btnBorder: 'border-amber-500/25' },
    violet: { bg: 'bg-violet-500/20', text: 'text-violet-400', border: '#8b5cf6', btnBg: 'bg-violet-500/15', btnHover: 'hover:bg-violet-500/25', btnText: 'text-violet-300', btnBorder: 'border-violet-500/25' },
    rose: { bg: 'bg-rose-500/20', text: 'text-rose-400', border: '#f43f5e', btnBg: 'bg-rose-500/15', btnHover: 'hover:bg-rose-500/25', btnText: 'text-rose-300', btnBorder: 'border-rose-500/25' },
    indigo: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', border: '#6366f1', btnBg: 'bg-indigo-500/15', btnHover: 'hover:bg-indigo-500/25', btnText: 'text-indigo-300', btnBorder: 'border-indigo-500/25' },
};
const _defaultColor = { bg: 'bg-slate-500/20', text: 'text-slate-400', border: '#64748b', btnBg: 'bg-slate-500/15', btnHover: 'hover:bg-slate-500/25', btnText: 'text-slate-300', btnBorder: 'border-slate-500/25' };
export function _renderAddonCard(addon) {
    const s = addon.state || {};
    const installed = !!s.installed;
    const enabled = !!s.enabled;
    const c = _addonColorMap[addon.color || ''] || _defaultColor;
    const slug = escapeHtml(addon.slug);
    const name = escapeHtml(addon.name || addon.slug);
    const desc = escapeHtml(addon.description || '');
    const version = escapeHtml(addon.version || '');
    let statusBadge = '';
    let actions = '';
    if (installed) {
        if (enabled) {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 text-emerald-400 bg-emerald-500/10">${escapeHtml(t('hy.addon_status_active'))}</span>`;
        }
        else {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 bg-amber-500/10">${escapeHtml(t('hy.addon_status_installed'))}</span>`;
        }
        actions = `
            <button type="button" data-config-action="openAddonConfigModal" data-config-slug="${slug}" class="px-4 py-2 rounded-xl text-xs font-medium bg-white/5 hover:${c.btnBg} text-slate-300 hover:${c.btnText} border border-white/10 transition-colors">
                <i class="fas fa-cog mr-1"></i> ${escapeHtml(t('hy.addon_configure'))}
            </button>
            ${enabled
            ? `<button type="button" data-config-action="toggleAddon" data-config-slug="${slug}" data-config-enabled="false" class="integration-toggle-btn integration-btn-disable text-red-500/70 hover:text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-red-500/20"><i class="fas fa-power-off"></i> ${escapeHtml(t('integrations.disable'))}</button>`
            : `<button type="button" data-config-action="toggleAddon" data-config-slug="${slug}" data-config-enabled="true" class="integration-toggle-btn integration-btn-enable text-emerald-500/70 hover:text-emerald-500 hover:bg-emerald-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-emerald-500/20"><i class="fas fa-check"></i> ${escapeHtml(t('integrations.enable'))}</button>`}
            <button type="button" data-config-action="uninstallAddon" data-config-slug="${slug}" class="text-red-500/50 hover:text-red-500 hover:bg-red-500/10 px-2 py-2 rounded-xl text-[10px] transition-all border border-transparent hover:border-red-500/20" title="${escapeHtml(t('hy.addon_uninstall_title'))}"><i class="fas fa-trash-alt"></i></button>
        `;
    }
    else {
        statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-500/30 text-slate-500">${escapeHtml(t('hy.addon_status_available'))}</span>`;
        actions = `
            <button type="button" data-config-action="installAddon" data-config-slug="${slug}" class="${c.btnBg} ${c.btnHover} ${c.btnText} border ${c.btnBorder} px-4 py-2 rounded-xl text-xs font-medium transition-colors inline-flex items-center gap-1.5">
                <i class="fas fa-download"></i> ${escapeHtml(t('hy.addon_install_btn'))}
            </button>
        `;
    }
    return `
        <div class="cfg-section flex flex-wrap items-center justify-between gap-3" style="border-left: 4px solid ${c.border};" id="addon-card-${slug}">
            <div class="flex items-center gap-3 flex-wrap min-w-0">
                <span class="w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0"><i class="${escapeHtml(addon.icon || 'fas fa-puzzle-piece')} ${c.text} text-xl"></i></span>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-bold ${c.text}">${name}</span>
                        ${statusBadge}
                        ${version ? `<span class="text-[10px] text-slate-600">v${version}</span>` : ''}
                    </div>
                    <p class="text-[10px] text-slate-500 mt-0.5 leading-relaxed">${desc}</p>
                </div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
                ${actions}
            </div>
        </div>
    `;
}
