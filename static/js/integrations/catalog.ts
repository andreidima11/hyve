/**
 * Settings → Integrations catalog list, toggles, subtabs.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { loadConfig } from '../features_config.js';
import { toggleVoiceRecording, isVoiceLoopActive } from '../voice.js';
import {
    getIntegrationCatalog,
    setIntegrationCatalog,
    integrationDefinition,
    integrationLabel,
    integrationDescription,
    normalizeIntegrationIcon,
    updateIntegrationCatalogEnabled,
} from './catalog_meta.js';
import { integrationEntitySourceSlug } from './catalog_meta.js';
import { syncIntegrationEntities } from './entities_sync.js';
import { findIntegrationCheckbox, integrationSlugCandidates } from './utils.js';

export function integrationEnabledForSave(slug: string) {
    const cb = findIntegrationCheckbox(slug);
    if (!cb) return undefined;
    return !!cb.checked;
}

export function withOptionalIntegrationEnabled(section: Record<string, unknown>, slug: string) {
    const enabled = integrationEnabledForSave(slug);
    if (enabled !== undefined) section.enabled = enabled;
    return section;
}

function _findIntegrationButton(slug: string, mode: string) {
    for (const candidate of integrationSlugCandidates(slug)) {
        const btn = document.getElementById(`${candidate}-btn-${mode}`);
        if (btn) return btn;
    }
    return null;
}

export function syncIntegrationToggles(): void {
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = (row as HTMLElement).dataset.integrationRow;
        if (!slug) return;
        const input = findIntegrationCheckbox(slug);
        const disableBtn = _findIntegrationButton(slug, 'disable');
        const enableBtn = _findIntegrationButton(slug, 'enable');
        if (!input || !disableBtn || !enableBtn) return;
        const on = !!input.checked;
        disableBtn.classList.toggle('hidden', !on);
        enableBtn.classList.toggle('hidden', on);
    });
    // Show/hide speak buttons depending on piper enabled
    const piperCheckbox = findIntegrationCheckbox('piper');
    const anyTtsOn = !!(piperCheckbox && piperCheckbox.checked);
    document.querySelectorAll('.chat-speak-btn').forEach(btn => {
        btn.classList.toggle('hidden', !anyTtsOn);
    });
    // Show/hide always-speak button depending on piper enabled
    const alwaysSpeakBtn = document.getElementById('btn-always-speak');
    if (alwaysSpeakBtn) alwaysSpeakBtn.classList.toggle('hidden', !anyTtsOn);
    // Show/hide voice button depending on whisper enabled
    const voiceBtn = document.getElementById('btn-voice') as HTMLButtonElement | null;
    if (voiceBtn) {
        const whisperCheckbox = findIntegrationCheckbox('whisper');
        const whisperEnabled = !!(whisperCheckbox && whisperCheckbox.checked);
        voiceBtn.classList.toggle('hidden', !whisperEnabled);
        if (!whisperEnabled) {
            if (voiceBtn.classList.contains('recording')) {
                toggleVoiceRecording({ btn: voiceBtn });
            } else {
                voiceBtn.disabled = false;
                voiceBtn.classList.remove('recording');
                const icon = voiceBtn.querySelector('i');
                if (icon) icon.className = isVoiceLoopActive() ? 'fas fa-sync-alt' : 'fas fa-microphone';
            }
        }
    }
    updateIntegrationSubtab();
}
let _activeIntegrationSubtab = 'active';

export function switchIntegrationSubtab(tab: string) {
    _activeIntegrationSubtab = tab;
    const btnActive = document.getElementById('int-subtab-active');
    const btnAvail  = document.getElementById('int-subtab-available');
    if (btnActive) {
        btnActive.classList.toggle('bg-accent/20', tab === 'active');
        btnActive.classList.toggle('text-accent', tab === 'active');
        btnActive.classList.toggle('border-accent/40', tab === 'active');
        btnActive.classList.toggle('bg-white/5', tab !== 'active');
        btnActive.classList.toggle('text-slate-400', tab !== 'active');
        btnActive.classList.toggle('border-white/10', tab !== 'active');
    }
    if (btnAvail) {
        btnAvail.classList.toggle('bg-accent/20', tab === 'available');
        btnAvail.classList.toggle('text-accent', tab === 'available');
        btnAvail.classList.toggle('border-accent/40', tab === 'available');
        btnAvail.classList.toggle('bg-white/5', tab !== 'available');
        btnAvail.classList.toggle('text-slate-400', tab !== 'available');
        btnAvail.classList.toggle('border-white/10', tab !== 'available');
    }
    updateIntegrationSubtab();
};

function updateIntegrationSubtab(): void {
    const tab = _activeIntegrationSubtab;
    const enabledMap: Record<string, boolean> = {};
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = (row as HTMLElement).dataset.integrationRow;
        if (!slug) return;
        enabledMap[slug] = !!findIntegrationCheckbox(slug)?.checked;
    });

    let visibleCount = 0;
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = (row as HTMLElement).dataset.integrationRow;
        const isEnabled = slug ? (enabledMap[slug] ?? false) : false;
        const show = tab === 'active' ? isEnabled : !isEnabled;
        row.classList.toggle('hidden', !show);
        if (show) visibleCount++;
    });

    const emptyEl = document.getElementById('int-subtab-empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0);

    const activeCount = Object.values(enabledMap).filter(Boolean).length;
    const availableCount = Object.keys(enabledMap).length - activeCount;
    const ac = document.getElementById('int-subtab-active-count');
    const avc = document.getElementById('int-subtab-available-count');
    if (ac) ac.textContent = activeCount > 0 ? `(${activeCount})` : '';
    if (avc) avc.textContent = availableCount > 0 ? `(${availableCount})` : '';
}

async function persistIntegrationEnabled(slug: string, configKey: string, enabled: boolean) {
    const enc = encodeURIComponent(slug);
    try {
        const res = await apiCall(`/api/integrations/${enc}/entries`);
        const data = await res.json().catch(() => ({}));
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (entries.length) {
            await Promise.all(entries.map((ent: Record<string, unknown>) => apiCall(
                `/api/integrations/${enc}/entries/${encodeURIComponent(String(ent.entry_id ?? ''))}`,
                { method: 'PATCH', body: { enabled: !!enabled } },
            )));
            updateIntegrationCatalogEnabled(slug, enabled);
            return;
        }
    } catch (_) {}
    if (enabled) {
        showToast(t('integrations.configure_entry_first') || 'Add a config entry first.', 'info');
    }
}

function applyCatalogEnabledToCheckboxes(): void {
    for (const entry of getIntegrationCatalog()) {
        const slug = String(entry.slug || '').trim();
        if (!slug) continue;
        const cb = findIntegrationCheckbox(slug);
        if (cb) cb.checked = !!entry.enabled;
    }
}

let _integrationToggleButtonsBound = false;

export function bindIntegrationToggleButtonsOnce(): void {
    if (_integrationToggleButtonsBound) return;
    _integrationToggleButtonsBound = true;

    document.addEventListener('click', (e: Event) => {
        const btn = (e.target as HTMLElement | null)?.closest?.('.integration-toggle-btn') as HTMLElement | null;
        if (!btn) return;
        const wrap = btn.parentElement;
        const checkbox = wrap?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (!checkbox) return;

        if (btn.id.includes('-btn-enable')) checkbox.checked = true;
        if (btn.id.includes('-btn-disable')) checkbox.checked = false;

        syncIntegrationToggles();

        const slug = (btn.id || '').replace(/-btn-(enable|disable)$/, '');
        if (slug) {
            const def = integrationDefinition(slug);
            const configKey = String(def?.config_key || slug).trim() || slug;
            persistIntegrationEnabled(slug, configKey, !!checkbox.checked).catch(() => {});
        }
    });

}
export async function syncConfiguredIntegration(integrationId: string, button: HTMLButtonElement | null = null) {
    const sourceSlug = integrationEntitySourceSlug(integrationId);
    const btn = (button || document.getElementById(`${sourceSlug}-sync-btn`) || document.getElementById(`${integrationId}-sync-btn`)) as HTMLButtonElement | null;
    const originalHtml = btn?.innerHTML || '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('integrations.entity_detail.sync_btn'))}</span>`;
    }
    try {
        await syncIntegrationEntities(sourceSlug, { toast: true });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml || `<i class="fas fa-arrows-rotate"></i><span>${escapeHtml(t('integrations.entity_detail.sync_btn'))}</span>`;
        }
    }
};

function _integrationIconHtml(entry: { icon?: unknown; image?: unknown; accent?: unknown }): string {
    const iconClass = escapeHtml(normalizeIntegrationIcon(entry.icon || 'fa-plug'));
    const image = String(entry.image || '').trim();
    const accent = escapeHtml(String(entry.accent || '#94a3b8'));
    if (image) {
        return `<span class="hyd-icon hyd-icon--list hyd-icon--photo"><img src="${escapeHtml(image)}" alt="" loading="lazy"></span>`;
    }
    return `<span class="hyd-icon hyd-icon--list" style="color:${accent};background:color-mix(in oklab, ${accent} 16%, var(--surface-card));"><i class="fas ${iconClass}"></i></span>`;
}

function _integrationRowHtml(entry: ReturnType<typeof getIntegrationCatalog>[number]): string {
    const slug = escapeHtml(String(entry.slug || ''));
    const toggleInputId = escapeHtml(String(entry.toggle_input_id || `${entry.slug}_enabled`));
    const toggleSlug = escapeHtml(String(entry.toggle_slug || entry.slug || ''));
    const label = escapeHtml(integrationLabel(entry));
    const description = escapeHtml(integrationDescription(entry));
    const adminOnly = entry.admin_only ? 'config-admin-only' : '';
    const enabled = !!entry.enabled;
    const offlineClass = enabled ? '' : ' is-offline';
    const disableHidden = enabled ? '' : ' hidden';
    const enableHidden = enabled ? ' hidden' : '';
    const toggle = `
        <div class="hyd-integration-row__toggle ${adminOnly}">
            <input type="checkbox" id="${toggleInputId}" class="sr-only" aria-hidden="true">
            <button type="button" id="${toggleSlug}-btn-disable" class="integration-toggle-btn hyd-btn hyd-btn--ghost hyd-btn--sm hyd-btn--danger${disableHidden}"><i class="fas fa-power-off"></i><span>${escapeHtml(t('integrations.disable'))}</span></button>
            <button type="button" id="${toggleSlug}-btn-enable" class="integration-toggle-btn hyd-btn hyd-btn--ghost hyd-btn--sm hyd-btn--success${enableHidden}"><i class="fas fa-check"></i><span>${escapeHtml(t('integrations.enable'))}</span></button>
        </div>`;
    return `
        <article data-integration-row="${slug}" class="hyd-entity-row hyd-integration-row${offlineClass} ${adminOnly}" role="listitem">
            ${_integrationIconHtml(entry)}
            <div class="hyd-entity-row__body" data-config-action="openIntegrationConfigModal" data-config-slug="${slug}" role="button" tabindex="0">
                <div class="hyd-entity-row__name">${label}</div>
                ${description ? `<div class="hyd-entity-row__sub">${description}</div>` : ''}
            </div>
            <div class="hyd-entity-row__meta hyd-integration-row__actions">
                <button type="button" data-config-action="openIntegrationConfigModal" data-config-slug="${slug}" class="hyd-btn hyd-btn--ghost hyd-btn--sm">${escapeHtml(t('integrations.settings_btn'))}</button>
                ${toggle}
                <i class="fas fa-chevron-right hyd-entity-row__chev hyd-integration-row__chev" aria-hidden="true"></i>
            </div>
        </article>`;
}

function _renderIntegrationCatalogRows(): void {
    const list = document.getElementById('integrations-list');
    if (!list) return;
    // Preserve the empty-state paragraph if it exists.
    const emptyEl = document.getElementById('int-subtab-empty');
    list.innerHTML = '';
    if (emptyEl) list.appendChild(emptyEl);

    const rowsHtml = getIntegrationCatalog().map((entry) => _integrationRowHtml(entry)).join('');

    list.insertAdjacentHTML('beforeend', rowsHtml);
}
export async function loadIntegrationCatalog(force = false) {
    if (getIntegrationCatalog().length && !force) return getIntegrationCatalog();
    try {
        const res = await apiCall('/api/integrations/catalog');
        const data = await res.json().catch(() => ({}));
        setIntegrationCatalog(Array.isArray(data.integrations) ? data.integrations : []);
    } catch (_) {
        setIntegrationCatalog([]);
    }
    _renderIntegrationCatalogRows();
    return getIntegrationCatalog();
}

let _activeIntegrationSubtabPreferred = 'auto';
export async function refreshIntegrationsSettingsView(preferredTab: string = 'auto') {
    _activeIntegrationSubtabPreferred = preferredTab;
    await loadIntegrationCatalog(true);
    // The catalog renderer creates fresh checkbox/inputs for each integration,
    // so we must re-apply the saved enabled flags from the catalog API.
    try { await loadConfig(); } catch (_) {}
    applyCatalogEnabledToCheckboxes();
    syncIntegrationToggles();
    bindIntegrationToggleButtonsOnce();

    let nextTab = preferredTab;
    if (preferredTab === 'auto') {
        const hasActive = Array.from(document.querySelectorAll('[data-integration-row]'))
            .some((row) => {
                const slug = (row as HTMLElement).dataset.integrationRow;
                return slug ? !!findIntegrationCheckbox(slug)?.checked : false;
            });
        nextTab = hasActive ? 'active' : 'available';
    }
    if (nextTab !== 'active' && nextTab !== 'available') nextTab = 'active';
    switchIntegrationSubtab(nextTab);
}
