/**
 * HA-style integration config entries (multi-instance, declarative).
 */
import { apiCall, isNetworkFetchError } from '../api.js';
import { t, translateApiDetail, integrationApiMessage } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast, showConfirm } from '../utils.js';
import { errMsg, intEl } from './utils.js';
import { integrationDefinition } from './catalog_meta.js';
import { loadIntegrationExposedEntities } from './exposed_devices.js';
let _entriesCurrent = { slug: null, schema: [], entries: [], supportsMultiple: false, label: '' };
const _syncingEntryIds = new Set();
export function integrationHasConfigSchema(integrationId) {
    const def = integrationDefinition(integrationId);
    return !!def?.has_config_schema;
}
function _showIntegrationSchemaLoadError(slug, message) {
    const generic = document.getElementById('integration-panel-generic');
    const desc = document.getElementById('integration-generic-description');
    if (generic)
        generic.classList.remove('hidden');
    if (desc) {
        desc.textContent = message;
        desc.classList.remove('hidden');
    }
    if (typeof showToast === 'function') {
        showToast(message, 'error', 4500);
    }
    console.warn(`[integrations] schema load failed for ${slug}:`, message);
}
export async function loadIntegrationConfigEntries(slug) {
    const section = document.getElementById('integration-entries-section');
    if (!section)
        return;
    const desc = document.getElementById('integration-generic-description');
    if (desc) {
        desc.textContent = '';
        desc.classList.add('hidden');
    }
    let payload = null;
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/schema`);
        if (!res.ok) {
            const o = await res.json().catch(() => ({}));
            const detail = o.detail || o.message || `HTTP ${res.status}`;
            section.classList.add('hidden');
            if (res.status === 404) {
                _showIntegrationSchemaLoadError(slug, t('integrations.config_provider_missing', { slug }));
            }
            else {
                _showIntegrationSchemaLoadError(slug, t('integrations.config_load_failed', { detail }));
            }
            return;
        }
        payload = await res.json();
    }
    catch (err) {
        section.classList.add('hidden');
        _showIntegrationSchemaLoadError(slug, errMsg(err) || t('integrations.schema_load_network'));
        return;
    }
    if (!payload || !Array.isArray(payload.schema) || payload.schema.length === 0) {
        section.classList.add('hidden');
        return;
    }
    _entriesCurrent = {
        slug,
        schema: payload.schema,
        entries: payload.entries || [],
        supportsMultiple: !!payload.supports_multiple,
        label: payload.label || slug,
    };
    section.classList.remove('hidden');
    const generic = document.getElementById('integration-panel-generic');
    if (generic)
        generic.classList.add('hidden');
    const addBtn = document.getElementById('integration-entries-add-btn');
    if (addBtn) {
        const disable = !_entriesCurrent.supportsMultiple && _entriesCurrent.entries.length > 0;
        addBtn.disabled = disable;
        addBtn.classList.toggle('opacity-40', disable);
        addBtn.title = disable ? t('integrations.single_entry_only') : '';
        addBtn.onclick = () => openEntryEditor(null);
    }
    // Hide the generic "no settings" hint — the entries section IS the settings UI.
    const hint = document.getElementById('integration-generic-empty-hint');
    if (hint)
        hint.classList.add('hidden');
    _renderEntriesList();
}
function _entryRefreshBadge(refresh) {
    if (!refresh || typeof refresh !== 'object')
        return '';
    const r = refresh;
    if (r.reachable === false) {
        const err = String(r.last_error || '').trim();
        const title = err ? t('integrations.refresh_last_error', { error: err }) : t('integrations.refresh_unreachable');
        return `<span class="inline-flex items-center gap-1 text-[10px] text-red-400/90" title="${escapeHtml(title)}"><i class="fas fa-plug-circle-xmark text-[8px]"></i>${escapeHtml(t('integrations.refresh_unreachable'))}</span>`;
    }
    const mode = String(r.last_mode || '').trim();
    if (mode === 'probe') {
        return `<span class="text-[10px] text-sky-400/80">${escapeHtml(t('integrations.refresh_mode_probe'))}</span>`;
    }
    if (mode === 'pull') {
        return `<span class="text-[10px] text-emerald-400/80">${escapeHtml(t('integrations.refresh_mode_pull'))}</span>`;
    }
    if (mode === 'fetch') {
        return `<span class="text-[10px] text-slate-500">${escapeHtml(t('integrations.refresh_mode_fetch'))}</span>`;
    }
    return '';
}
function _renderEntriesList() {
    const list = document.getElementById('integration-entries-list');
    const empty = document.getElementById('integration-entries-empty');
    if (!list)
        return;
    list.innerHTML = '';
    if (!_entriesCurrent.entries.length) {
        if (empty)
            empty.classList.remove('hidden');
        return;
    }
    if (empty)
        empty.classList.add('hidden');
    _entriesCurrent.entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 bg-white/[0.03] border border-white/5 rounded-lg p-2.5';
        row.dataset.entryId = String(entry.entry_id ?? '');
        const enabled = entry.enabled !== false;
        const entryId = String(entry.entry_id ?? '');
        const isSyncing = _syncingEntryIds.has(entryId);
        const syncBadge = isSyncing
            ? `<span class="inline-flex items-center gap-1 text-[10px] text-amber-400/80 animate-pulse"><i class="fas fa-spinner fa-spin text-[8px]"></i> ${escapeHtml(t('integrations.syncing_badge'))}</span>`
            : '';
        const refreshBadge = _entryRefreshBadge(entry.refresh);
        const statusText = enabled ? '' : '· dezactivat';
        row.innerHTML = `
            <div class="min-w-0 flex-1">
                <div class="text-[12px] font-semibold text-slate-100 truncate">${escapeHtml(entry.title || _entriesCurrent.label)}</div>
                <div class="text-[10px] text-slate-500 mono truncate flex items-center gap-2 flex-wrap">${escapeHtml(entryId.slice(0, 8))} ${statusText} ${syncBadge} ${refreshBadge}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-act="edit" class="px-2 py-1 rounded text-[10px] bg-white/5 hover:bg-white/10 text-slate-300" title="${escapeHtml(t('common.edit'))}"><i class="fas fa-pen"></i></button>
                <button type="button" data-act="delete" class="px-2 py-1 rounded text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-300" title="${escapeHtml(t('common.delete'))}"><i class="fas fa-trash"></i></button>
            </div>`;
        const editBtn = row.querySelector('[data-act="edit"]');
        const deleteBtn = row.querySelector('[data-act="delete"]');
        if (editBtn)
            editBtn.onclick = () => openEntryEditor(entry);
        if (deleteBtn)
            deleteBtn.onclick = async () => {
                if (!await showConfirm(t('integrations.entry_delete_config_confirm', { title: entry.title })))
                    return;
                try {
                    const slug = _entriesCurrent.slug;
                    const r = await apiCall(`/api/integrations/${encodeURIComponent(slug || '')}/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
                    if (!r.ok) {
                        const o = await r.json().catch(() => ({}));
                        throw new Error(translateApiDetail(o.detail) || t('integrations.delete_error'));
                    }
                    await loadIntegrationConfigEntries(slug || '');
                    try {
                        await loadIntegrationExposedEntities(slug || '');
                    }
                    catch (_) { }
                    if (typeof showToast === 'function')
                        showToast(t('hy.deleted'), 'success', 1800);
                }
                catch (e) {
                    if (typeof showToast === 'function')
                        showToast(errMsg(e) || t('common.error'), 'error', 2500);
                }
            };
        list.appendChild(row);
    });
}
function _pollForEntities(slug, attempts = 0, syncingEntryId = null) {
    const maxAttempts = 8;
    const delays = [1500, 2500, 3000, 4000, 5000, 7000, 10000, 15000];
    const grid = document.getElementById('integration-exposed-entities-grid');
    if (grid && attempts === 0) {
        grid.innerHTML = `<div class="flex items-center gap-2 text-slate-400 text-xs py-4 px-2">
            <i class="fas fa-spinner fa-spin"></i>
            <span>${escapeHtml(t('integrations.syncing_devices'))}</span>
        </div>`;
    }
    loadIntegrationExposedEntities(slug).then(count => {
        if (count != null && count > 0) {
            _clearSyncingState(syncingEntryId);
            return;
        }
        if (attempts < maxAttempts) {
            const delay = delays[Math.min(attempts, delays.length - 1)];
            setTimeout(() => _pollForEntities(slug, attempts + 1, syncingEntryId), delay);
        }
        else {
            _clearSyncingState(syncingEntryId);
            if (grid)
                grid.innerHTML = `<div class="text-slate-500 text-xs py-4 px-2">${escapeHtml(t('integrations.no_devices_yet'))}</div>`;
        }
    }).catch(() => {
        if (attempts < maxAttempts) {
            const delay = delays[Math.min(attempts, delays.length - 1)];
            setTimeout(() => _pollForEntities(slug, attempts + 1, syncingEntryId), delay);
        }
        else {
            _clearSyncingState(syncingEntryId);
        }
    });
}
function _clearSyncingState(entryId) {
    if (!entryId)
        return;
    _syncingEntryIds.delete(entryId);
    const row = document.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`);
    if (row) {
        const badge = row.querySelector('.animate-pulse');
        if (badge)
            badge.remove();
    }
}
function openEntryEditor(entry) {
    const modal = document.getElementById('integration-entry-modal');
    const titleEl = document.getElementById('integration-entry-modal-title');
    const fieldsEl = document.getElementById('integration-entry-fields');
    const errEl = document.getElementById('integration-entry-error');
    const titleInput = document.querySelector('#integration-entry-form input[name="__title__"]');
    if (!modal || !fieldsEl || !titleInput || !errEl || !titleEl)
        return;
    errEl.classList.add('hidden');
    errEl.textContent = '';
    titleEl.textContent = entry && entry.title ? t('integrations.entry_edit_title', { title: String(entry.title) }) : t('integrations.entry_add_title', { label: _entriesCurrent.label });
    titleInput.value = entry?.title ? String(entry.title) : '';
    fieldsEl.innerHTML = '';
    const data = (entry?.data || {});
    _entriesCurrent.schema.forEach(field => {
        const wrap = document.createElement('div');
        const fkey = String(field.key || '');
        const id = `entry_field_${fkey}`;
        const required = field.required ? '<span class="text-red-400">*</span>' : '';
        const help = field.help ? `<div class="text-[10px] text-slate-500 mt-1">${escapeHtml(field.help)}</div>` : '';
        let input = '';
        const value = data[fkey] !== undefined ? data[fkey] : (field.default !== undefined ? field.default : '');
        const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
        if (field.type === 'link') {
            const href = escapeHtmlAttr(field.url || '#');
            input = `<a href="${href}" target="_blank" rel="noopener noreferrer"
                class="w-full flex items-center justify-center gap-2 bg-accent/15 border border-accent/40 text-accent rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 transition-colors no-underline">
                <i class="fas fa-arrow-up-right-from-square"></i> <span>Deschide pagina Xiaomi</span>
            </a>`;
        }
        else if (field.type === 'select' && Array.isArray(field.options)) {
            const opts = field.options.map(o => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
            input = `<select id="${id}" name="${fkey}" class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-accent outline-none">${opts}</select>`;
        }
        else if (field.type === 'bool' || field.type === 'boolean') {
            input = `<label class="flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" id="${id}" name="${fkey}" ${value ? 'checked' : ''} class="accent-accent"> <span>${escapeHtml(field.label || fkey)}</span></label>`;
        }
        else {
            const t = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : (field.type === 'url' ? 'url' : 'text'));
            const minAttr = field.min != null ? ` min="${escapeHtmlAttr(field.min)}"` : '';
            const maxAttr = field.max != null ? ` max="${escapeHtmlAttr(field.max)}"` : '';
            input = `<input type="${t}" id="${id}" name="${fkey}"${minAttr}${maxAttr} ${placeholder} value="${escapeHtml(String(value ?? ''))}" class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-accent outline-none">`;
        }
        if (field.type === 'bool' || field.type === 'boolean') {
            wrap.innerHTML = input;
        }
        else {
            wrap.innerHTML = `<label class="block text-[10px] font-semibold text-slate-400 uppercase mb-1">${escapeHtml(field.label || fkey)} ${required}</label>${input}${help}`;
        }
        fieldsEl.appendChild(wrap);
    });
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const close = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
    const closeBtn = document.getElementById('integration-entry-modal-close');
    const cancelBtn = document.getElementById('integration-entry-cancel');
    if (closeBtn)
        closeBtn.onclick = close;
    if (cancelBtn)
        cancelBtn.onclick = close;
    const editingEntryId = entry?.entry_id ? String(entry.entry_id) : '';
    // Helper: collect form data, skipping masked secrets when editing.
    const collectData = () => {
        const out = {};
        for (const field of _entriesCurrent.schema) {
            if (field.type === 'oauth' || field.type === 'link')
                continue;
            const fkey = String(field.key || '');
            const el = intEl(`entry_field_${fkey}`);
            if (!el)
                continue;
            let v;
            if (field.type === 'bool' || field.type === 'boolean')
                v = !!el.checked;
            else if (field.type === 'number')
                v = el.value === '' ? null : Number(el.value);
            else
                v = el.value;
            if (editingEntryId && field.secret && typeof v === 'string' && /^[•*]+$/.test(v))
                continue;
            out[fkey] = v;
        }
        return out;
    };
    // Test connection — runs the provider's ``async_test_connection`` against
    // the unsaved form data. Does NOT persist the entry.
    const testBtn = document.getElementById('integration-entry-test');
    if (testBtn) {
        testBtn.onclick = async () => {
            errEl.classList.add('hidden');
            errEl.textContent = '';
            const orig = testBtn.innerHTML;
            testBtn.disabled = true;
            testBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('integrations.test_connecting'))}`;
            const testTimeoutMs = _entriesCurrent.slug === 'mammotion' ? 90000 : 45000;
            try {
                const r = await apiCall(`/api/integrations/${encodeURIComponent(_entriesCurrent.slug || '')}/entries/test`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: collectData(), entry_id: entry?.entry_id ? String(entry.entry_id) : null }),
                    timeout: testTimeoutMs,
                });
                const o = await r.json().catch(() => ({}));
                if (r.ok && o.ok) {
                    if (typeof showToast === 'function')
                        showToast(integrationApiMessage(o) || t('integrations.connection_ok'), 'success', 2200);
                }
                else {
                    errEl.textContent = integrationApiMessage(o) || t('integrations.test_failed');
                    errEl.classList.remove('hidden');
                }
            }
            catch (e) {
                errEl.textContent = e.name === 'TimeoutError'
                    ? t('integrations.test_timeout')
                    : (errMsg(e) || t('common.error'));
                errEl.classList.remove('hidden');
            }
            finally {
                testBtn.disabled = false;
                testBtn.innerHTML = orig;
            }
        };
    }
    const saveBtnEl = document.getElementById('integration-entry-save');
    if (saveBtnEl)
        saveBtnEl.onclick = async () => {
            const saveBtn = saveBtnEl;
            const payload = { title: (titleInput.value || '').trim() || _entriesCurrent.label, data: collectData() };
            const slug = _entriesCurrent.slug;
            // Disable save button to prevent double-clicks
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.classList.add('opacity-50');
            }
            try {
                const url = editingEntryId
                    ? `/api/integrations/${encodeURIComponent(slug || '')}/entries/${encodeURIComponent(editingEntryId)}`
                    : `/api/integrations/${encodeURIComponent(slug || '')}/entries`;
                const r = await apiCall(url, {
                    method: editingEntryId ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    timeout: 30000,
                });
                const o = await r.json().catch(() => ({}));
                if (!r.ok) {
                    errEl.textContent = translateApiDetail(o.detail) || translateApiDetail(o.errors) || t('integrations.save_error');
                    errEl.classList.remove('hidden');
                    return;
                }
                // Close modal immediately — entry is saved, sync runs in background
                close();
                if (typeof showToast === 'function')
                    showToast(t('hy.saved'), 'success', 1800);
                // Mark entry as syncing so the row shows a loading indicator
                const savedEntryId = o.entry?.entry_id ? String(o.entry.entry_id) : null;
                if (savedEntryId)
                    _syncingEntryIds.add(savedEntryId);
                // Refresh the entries list right away (entry already persisted, shows syncing badge)
                await loadIntegrationConfigEntries(slug || '');
                // Poll for entities — clears syncing state when done
                _pollForEntities(slug || '', 0, savedEntryId);
            }
            catch (e) {
                const msg = e.name === 'TimeoutError'
                    ? t('integrations.test_timeout')
                    : isNetworkFetchError(e)
                        ? t('integrations.save_network_error')
                        : (errMsg(e) || t('common.error'));
                errEl.textContent = msg;
                errEl.classList.remove('hidden');
            }
            finally {
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.classList.remove('opacity-50');
                }
            }
        };
}
// ── OAuth connect flow (Xiaomi Home & future OAuth providers) ──────────
// Opens the provider's auth page in a popup, then polls the provider's status
// endpoint until the server-side redirect callback has captured the code and
// created the config entry. No copy/paste, no homeassistant.local.
async function _runOAuthConnect(field, btn, errEl, closeModal) {
    const slug = _entriesCurrent.slug;
    const labelEl = btn.querySelector('[data-oauth-label]');
    const statusEl = btn.parentElement?.querySelector('[data-oauth-status]');
    const origLabel = labelEl ? labelEl.textContent : '';
    const setBusy = (txt) => { if (labelEl)
        labelEl.textContent = txt; btn.disabled = true; };
    const reset = () => { if (labelEl)
        labelEl.textContent = origLabel; btn.disabled = false; };
    if (errEl) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
    }
    // Build the start URL with declared form params (e.g. cloud_server).
    const qs = new URLSearchParams();
    (Array.isArray(field.params) ? field.params : []).forEach((key) => {
        const el = intEl(`entry_field_${key}`);
        if (el)
            qs.set(key, el.value);
    });
    setBusy(t('integrations.oauth_opening'));
    let state;
    let popup;
    try {
        // Open the popup synchronously (inside the click) to avoid blockers.
        popup = window.open('about:blank', 'xiaomi_oauth', 'width=480,height=720');
        const r = await apiCall(`${field.start}?${qs.toString()}`);
        const o = await r.json().catch(() => ({}));
        if (!r.ok || !o.auth_url) {
            if (popup)
                popup.close();
            throw new Error(o.detail || t('integrations.oauth_start_failed'));
        }
        state = o.state;
        if (popup)
            popup.location.href = o.auth_url;
        else
            window.open(o.auth_url, '_blank');
    }
    catch (e) {
        reset();
        if (errEl) {
            errEl.textContent = errMsg(e) || t('common.error');
            errEl.classList.remove('hidden');
        }
        return;
    }
    setBusy(t('integrations.oauth_waiting'));
    const deadline = Date.now() + 5 * 60 * 1000;
    const poll = async () => {
        if (Date.now() > deadline) {
            reset();
            if (errEl) {
                errEl.textContent = t('integrations.oauth_expired');
                errEl.classList.remove('hidden');
            }
            return;
        }
        try {
            const r = await apiCall(`${field.status}?state=${encodeURIComponent(state)}`);
            const o = await r.json().catch(() => ({}));
            if (o.status === 'completed') {
                if (statusEl)
                    statusEl.innerHTML = `<span class="text-[11px] text-emerald-400 font-semibold"><i class="fas fa-check-circle mr-1"></i>${escapeHtml(t('integrations.oauth_connected'))}</span>`;
                if (typeof showToast === 'function')
                    showToast(t('hy.xiaomi_connected'), 'success', 2200);
                try {
                    if (popup && !popup.closed)
                        popup.close();
                }
                catch (_) { }
                if (typeof closeModal === 'function')
                    closeModal();
                if (o.entry_id)
                    _syncingEntryIds.add(o.entry_id);
                await loadIntegrationConfigEntries(slug || '');
                _pollForEntities(slug || '', 0, o.entry_id ? String(o.entry_id) : null);
                return;
            }
            if (o.status === 'error' || o.status === 'expired') {
                reset();
                if (errEl) {
                    errEl.textContent = o.error || t('integrations.oauth_auth_failed');
                    errEl.classList.remove('hidden');
                }
                return;
            }
        }
        catch (_) { /* keep polling */ }
        setTimeout(poll, 2000);
    };
    setTimeout(poll, 2500);
}
