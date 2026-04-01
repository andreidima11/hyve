import { apiCall, suppressLogout } from './api.js';
import { setLanguage, t, getAvailableLanguages } from './lang/index.js';
import { escapeHtml, showToast, showConfirm, debounce, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from './utils.js';
export {
    loadSessionsList,
    openSession,
    newChatSession,
    deleteSession,
    cancelDeleteSession,
    confirmDeleteSession,
    clearSessionContext
} from './features_sessions.js';
export {
    loadAdminUsers,
    createUser,
    deleteUser,
    loadSkills,
    openSkillEdit,
    closeSkillEditModal,
    saveSkillEdit,
    deleteSkill,
    toggleSkillDesc,
    toggleSkillDisabled
} from './features_admin_skills.js';

export let haDevicesCache = [];
export let memCache = [];
export let memPage = 1;

const MEM_LOG_PAGE_SIZE = 50;
let memLogOffset = 0;
let memLogTotal = 0;

// --- SMART HOME (IoT) ---
let _haCurrentFilter = 'all';

const DOMAIN_ICONS = {
    light: 'fa-lightbulb', switch: 'fa-toggle-on', script: 'fa-play',
    input_boolean: 'fa-toggle-on', cover: 'fa-door-open', lock: 'fa-lock',
    sensor: 'fa-gauge', binary_sensor: 'fa-circle-dot', climate: 'fa-temperature-half',
    media_player: 'fa-music', vacuum: 'fa-robot', weather: 'fa-cloud-sun',
    person: 'fa-user'
};
const DOMAIN_COLORS = {
    light: 'bg-yellow-500/15 text-yellow-400', switch: 'bg-blue-500/15 text-blue-400',
    script: 'bg-emerald-500/15 text-emerald-400', input_boolean: 'bg-blue-500/15 text-blue-400',
    cover: 'bg-orange-500/15 text-orange-400', lock: 'bg-red-500/15 text-red-400',
    sensor: 'bg-cyan-500/15 text-cyan-400', binary_sensor: 'bg-teal-500/15 text-teal-400',
    climate: 'bg-rose-500/15 text-rose-400', media_player: 'bg-purple-500/15 text-purple-400',
    vacuum: 'bg-indigo-500/15 text-indigo-400', weather: 'bg-sky-500/15 text-sky-400',
    person: 'bg-slate-500/15 text-slate-400'
};
const CONTROLLABLE = ['light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum', 'media_player', 'climate'];
const ACTIVE_STATES = ['on', 'home', 'open', 'unlocked', 'playing', 'cleaning'];

export async function loadSmarthome() {
    const grid = document.getElementById('ha-cards-grid');
    if (!grid) return;
    try {
        const [resConfig, resLive] = await Promise.all([
            apiCall('/api/ha/manage'),
            apiCall('/api/ha/states')
        ]);
        const configEntities = await resConfig.json();
        const liveStates = await resLive.json();
        const stateMap = {};
        liveStates.forEach(s => {
            stateMap[s.entity_id] = { state: s.state, unit: s.attributes?.unit_of_measurement || '' };
        });

        haDevicesCache = configEntities.map(entity => {
            const live = stateMap[entity.entity_id] || { state: 'unavailable', unit: '' };
            return { ...entity, state: live.state, unit: live.unit };
        });

        _updateStats();
        renderDeviceCards();
    } catch (e) {
        grid.innerHTML = `<div class="col-span-full p-10 text-center text-red-400">${t('ha.sync_error')}</div>`;
    }
}

function _updateStats() {
    const total = haDevicesCache.length;
    const active = haDevicesCache.filter(d => ACTIVE_STATES.includes(String(d.state).toLowerCase())).length;
    const aiSel = haDevicesCache.filter(d => d.selected).length;
    const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
    el('ha-count', total);
    el('ha-active-count', active);
    el('ha-ai-count', `${aiSel}/${total}`);
}

function _getFilteredDevices() {
    const search = (document.getElementById('ha-search')?.value || '').toLowerCase();
    return haDevicesCache.filter(d => {
        if (_haCurrentFilter === 'active') {
            if (!ACTIVE_STATES.includes(String(d.state).toLowerCase())) return false;
        } else if (_haCurrentFilter === 'ai') {
            if (!d.selected) return false;
        } else if (_haCurrentFilter !== 'all') {
            const dom = d.domain || d.entity_id.split('.')[0];
            if (_haCurrentFilter === 'sensor' && dom === 'binary_sensor') { /* include */ }
            else if (dom !== _haCurrentFilter) return false;
        }
        if (search) {
            const haystack = `${(d.name || '').toLowerCase()} ${(d.entity_id || '').toLowerCase()} ${(d.aliases || []).join(' ').toLowerCase()}`;
            if (!haystack.includes(search)) return false;
        }
        return true;
    });
}

let _haBulkMode = false;

export function toggleHABulkMode() {
    const wrap = document.querySelector('.ha-list-wrap');
    const btn = document.getElementById('ha-bulk-mode-btn');
    if (!wrap || !btn) return;
    _haBulkMode = !_haBulkMode;
    wrap.classList.toggle('ha-bulk-mode', _haBulkMode);
    if (!_haBulkMode) {
        document.querySelectorAll('.ha-bulk-check').forEach(cb => { cb.checked = false; });
        const allCheck = document.getElementById('ha-select-all');
        if (allCheck) allCheck.checked = false;
        updateHABulkCount();
    }
    btn.classList.toggle('active', _haBulkMode);
    btn.querySelector('span').textContent = _haBulkMode ? (t('ha.cancel') || 'Cancel') : (t('ha.select') || 'Select');
}

function renderDeviceCards() {
    const tbody = document.getElementById('ha-list-tbody');
    if (!tbody) return;
    const devices = _getFilteredDevices();
    if (!devices.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="ha-list-placeholder"><i class="fas fa-plug text-slate-600 mr-2"></i>${t('ha.no_devices_found')}</td></tr>`;
        updateHABulkCount();
        return;
    }
    tbody.innerHTML = devices.map(d => {
        const domain = d.domain || d.entity_id.split('.')[0];
        const stateLower = String(d.state).toLowerCase();
        const isOn = ACTIVE_STATES.includes(stateLower);
        const isUnavail = ['unavailable', 'unknown', 'offline'].includes(stateLower);
        const isControl = CONTROLLABLE.includes(domain);
        const icon = DOMAIN_ICONS[domain] || 'fa-microchip';
        const color = DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400';
        const stateDisplay = isUnavail ? 'Offline' : `${d.state}${d.unit ? ' ' + d.unit : ''}`;
        const aliases = d.aliases || [];
        const aliasCount = aliases.length;
        const aliasBtnText = aliasCount === 0 ? (t('ha.alias_add') || 'Adaugă alias') : aliasCount === 1 ? (t('ha.alias_1') || '1 alias') : (t('ha.alias_n', { count: aliasCount }) || `${aliasCount} aliasuri`);
        const aliasStr = aliases.join(', ');
        const name = escapeHtml(d.name || d.entity_id);
        const eid = escapeHtml(d.entity_id);

        return `<tr class="ha-row ha-row-clickable ${isUnavail ? 'ha-row-unavailable' : ''}" data-entity="${eid}" data-domain="${domain}" data-search="${(d.name || '').toLowerCase()} ${(d.entity_id || '').toLowerCase()} ${aliasStr.toLowerCase()}" onclick="handleHaRowClick(event)">
            <td class="ha-col-bulk"><input type="checkbox" class="ha-bulk-check accent-red-500 cursor-pointer" value="${eid}" onchange="updateHABulkCount()" aria-label="Select ${name}"></td>
            <td class="ha-col-icon"><div class="ha-row-icon ${color}"><i class="fas ${icon}"></i></div></td>
            <td class="ha-col-name">
                <div class="ha-row-name">${name}</div>
                <div class="ha-row-entity mono">${eid}</div>
            </td>
            <td class="ha-col-alias">
                <button type="button" class="ha-row-alias-btn" onclick="openAliasModal('${eid}')" title="${t('ha.alias_modal_title') || 'Alias'}">${escapeHtml(aliasBtnText)}</button>
            </td>
            <td class="ha-col-state">
                <span class="ha-row-state-wrap">
                    <span class="ha-row-state mono ${isUnavail ? 'text-red-500/70' : (isOn ? 'text-accent' : 'text-slate-400')}">${stateDisplay}</span>
                    ${isControl ? `<button type="button" onclick="toggleDevice('${eid}', this)" class="ha-row-toggle ${isOn ? 'ha-toggle-on' : 'ha-toggle-off'}" aria-label="Toggle"><i class="fas fa-power-off"></i></button>` : ''}
                </span>
            </td>
            <td class="ha-col-ai"><label class="ha-row-ai cursor-pointer select-none" title="Include in AI context"><input type="checkbox" onchange="toggleSelection('${eid}', this.checked)" ${d.selected ? 'checked' : ''} class="accent-accent cursor-pointer" aria-label="AI"></label></td>
            <td class="ha-col-actions">
                <button type="button" onclick="deleteHASingle('${eid}')" class="ha-row-remove" title="Remove"><i class="fas fa-xmark"></i></button>
            </td>
            <td class="ha-col-menu ha-col-menu-only">
                <button type="button" onclick="openRowActionsModal('${eid}')" class="ha-row-menu-btn" aria-label="Acțiuni"><i class="fas fa-ellipsis-v"></i></button>
            </td>
        </tr>`;
    }).join('');
    updateHABulkCount();
}

export function filterHAByDomain(domain) {
    _haCurrentFilter = domain;
    document.querySelectorAll('.ha-domain-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-domain') === domain);
    });
    renderDeviceCards();
}

export function filterDevices() {
    renderDeviceCards();
}

export function toggleAllHA(checked) {
    document.querySelectorAll('.ha-bulk-check').forEach(cb => cb.checked = checked);
    updateHABulkCount();
}

export function updateHABulkCount() {
    const count = document.querySelectorAll('.ha-bulk-check:checked').length;
    const panel = document.getElementById('ha-bulk-panel');
    const info = document.getElementById('bulk-selection-info');
    const bulkModeOn = !!document.querySelector('.ha-list-wrap.ha-bulk-mode');
    if (panel) {
        if (bulkModeOn && count > 0) {
            panel.classList.remove('hidden');
            if (info) info.innerText = t('ha.bulk_selected', { count });
        } else {
            panel.classList.add('hidden');
        }
    }
}

export async function deleteHABulk() {
    const checked = document.querySelectorAll('.ha-bulk-check:checked');
    const ids = Array.from(checked).map(cb => cb.value);
    if (!ids.length) return;
    if (!(await showConfirm(t('ha.delete_bulk_confirm', { count: ids.length })))) return;
    try {
        const res = await apiCall('/api/ha/bulk_delete', { method: 'POST', body: { ids } });
        if (res.ok) {
            await loadSmarthome();
            updateHABulkCount();
        }
    } catch (e) { showToast(t('ha.delete_error'), 'error'); }
}

export async function deleteHASingle(eid) {
    if (!(await showConfirm(t('ha.delete_single_confirm')))) return;
    try {
        await apiCall(`/api/ha/delete/${encodeURIComponent(eid)}`, { method: 'DELETE' });
        await loadSmarthome();
    } catch (e) { /* silent */ }
}

export async function toggleDevice(eid, btnEl) {
    if (btnEl) {
        const icon = btnEl.querySelector('i');
        if (icon) icon.className = 'fas fa-spinner fa-spin';
    }
    await apiCall('/api/ha/toggle', { method: 'POST', body: { entity_id: eid } });
    setTimeout(loadSmarthome, 800);
}

export async function toggleSelection(eid, sel) {
    await apiCall('/api/ha/update_selection', { method: 'POST', body: { entity_id: eid, selected: sel } });
    if (haDevicesCache) {
        const d = haDevicesCache.find(x => x.entity_id === eid);
        if (d) d.selected = sel;
        _updateStats();
    }
}

export async function toggleAllAI(checked) {
    if (!haDevicesCache || !haDevicesCache.length) return;
    await apiCall('/api/ha/bulk_selection', { method: 'POST', body: { selected: checked } });
    haDevicesCache.forEach(d => d.selected = checked);
    _updateStats();
    renderDeviceCards();
}

let _haAliasModalEntityId = null;
let _haAliasModalOriginalParent = null;

export function openAliasModal(eid) {
    const modal = document.getElementById('ha-alias-modal');
    const container = document.getElementById('ha-alias-inputs');
    const titleEl = document.getElementById('ha-alias-modal-title');
    const entityEl = document.getElementById('ha-alias-modal-entity');
    if (!modal || !container) return;
    const d = haDevicesCache?.find(x => x.entity_id === eid);
    _haAliasModalEntityId = eid;
    if (titleEl) titleEl.textContent = typeof t === 'function' ? t('ha.alias_modal_title') : 'Alias';
    if (entityEl) entityEl.textContent = eid;
    container.innerHTML = '';
    const list = d?.aliases?.length ? [...d.aliases] : [''];
    list.forEach(alias => _appendAliasInput(container, alias));
    if (modal.parentNode !== document.body) {
        _haAliasModalOriginalParent = modal.parentNode;
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function _appendAliasInput(container, value = '') {
    const wrap = document.createElement('div');
    wrap.className = 'flex gap-2 items-center';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'flex-1 bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-accent outline-none';
    input.placeholder = typeof t === 'function' ? t('ha.alias_placeholder') : 'Alias';
    input.value = value;
    input.dataset.haAlias = '1';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'w-9 h-9 rounded-lg bg-white/5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 flex items-center justify-center flex-shrink-0';
    rm.innerHTML = '<i class="fas fa-minus text-xs"></i>';
    rm.setAttribute('aria-label', 'Remove alias');
    rm.onclick = () => wrap.remove();
    wrap.appendChild(input);
    wrap.appendChild(rm);
    container.appendChild(wrap);
}

export function addAliasInput() {
    const container = document.getElementById('ha-alias-inputs');
    if (!container) return;
    _appendAliasInput(container, '');
}

export function closeAliasModal() {
    const modal = document.getElementById('ha-alias-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (_haAliasModalOriginalParent && modal.parentNode === document.body) {
            _haAliasModalOriginalParent.appendChild(modal);
            _haAliasModalOriginalParent = null;
        }
    }
    _haAliasModalEntityId = null;
}

let _haRowActionsEntityId = null;
let _haRowActionsModalOriginalParent = null;

export function handleHaRowClick(event) {
    const row = event.currentTarget;
    if (!row || row.getAttribute('data-entity') == null) return;
    if (event.target.closest('button, input, a, label')) return;
    const eid = row.getAttribute('data-entity');
    if (eid) openRowActionsModal(eid);
}

export function openRowActionsModal(eid) {
    const modal = document.getElementById('ha-row-actions-modal');
    if (!modal) return;
    const d = haDevicesCache?.find(x => x.entity_id === eid);
    if (!d) return;
    _haRowActionsEntityId = eid;
    const nameEl = document.getElementById('ha-row-actions-name');
    const entityEl = document.getElementById('ha-row-actions-entity');
    const stateEl = document.getElementById('ha-row-actions-state');
    const toggleBtn = document.getElementById('ha-row-action-toggle');
    const aiCb = document.getElementById('ha-row-action-ai-cb');
    if (nameEl) nameEl.innerHTML = `<i class="fas fa-ellipsis-vertical"></i>${d.name || d.entity_id}`;
    if (entityEl) entityEl.textContent = eid;
    if (stateEl) stateEl.textContent = (d.state ?? '') + (d.unit ? ' ' + d.unit : '');
    const domain = d.domain || eid.split('.')[0];
    const isControl = CONTROLLABLE.includes(domain);
    if (toggleBtn) {
        toggleBtn.classList.toggle('hidden', !isControl);
            toggleBtn.onclick = () => {
                closeRowActionsModal();
                toggleDevice(eid, null);
            };
    }
    if (aiCb) {
        aiCb.checked = !!d.selected;
        aiCb.onchange = () => toggleSelection(eid, aiCb.checked);
    }
    const aliasBtn = document.getElementById('ha-row-action-alias');
    if (aliasBtn) {
        aliasBtn.onclick = () => {
            closeRowActionsModal();
            openAliasModal(eid);
        };
    }
    const deleteBtn = document.getElementById('ha-row-action-delete');
    if (deleteBtn) {
        deleteBtn.onclick = async () => {
            if (!(await showConfirm(t('ha.delete_single_confirm')))) return;
            closeRowActionsModal();
            try {
                await apiCall(`/api/ha/delete/${encodeURIComponent(eid)}`, { method: 'DELETE' });
                await loadSmarthome();
            } catch (e) { /* silent */ }
        };
    }
    if (modal.parentNode !== document.body) {
        _haRowActionsModalOriginalParent = modal.parentNode;
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

export function closeRowActionsModal() {
    const modal = document.getElementById('ha-row-actions-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (_haRowActionsModalOriginalParent && modal.parentNode === document.body) {
            _haRowActionsModalOriginalParent.appendChild(modal);
            _haRowActionsModalOriginalParent = null;
        }
    }
    _haRowActionsEntityId = null;
}

export async function saveAliasesFromModal() {
    if (!_haAliasModalEntityId) return;
    const container = document.getElementById('ha-alias-inputs');
    if (!container) return;
    const inputs = container.querySelectorAll('input[data-ha-alias="1"]');
    const aliases = Array.from(inputs).map(inp => inp.value.trim()).filter(s => s);
    await apiCall('/api/ha/update_alias', { method: 'POST', body: { entity_id: _haAliasModalEntityId, aliases } });
    const d = haDevicesCache?.find(x => x.entity_id === _haAliasModalEntityId);
    if (d) d.aliases = aliases;
    closeAliasModal();
    renderDeviceCards();
}

export async function saveAliases(eid, val) {
    const aliases = val.split(',').map(s => s.trim()).filter(s => s);
    await apiCall('/api/ha/update_alias', { method: 'POST', body: { entity_id: eid, aliases } });
    const d = haDevicesCache.find(x => x.entity_id === eid);
    if (d) d.aliases = aliases;
}

// --- Add Devices Modal ---
let _availableDevices = [];

export async function openAddDevicesModal() {
    const modal = document.getElementById('add-devices-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const list = document.getElementById('add-devices-list');
    if (list) list.innerHTML = `<div class="text-center text-slate-500 text-sm py-8"><i class="fas fa-spinner fa-spin mr-2"></i>${t('ha.loading_available')}</div>`;
    try {
        const res = await apiCall('/api/ha/available');
        _availableDevices = await res.json();
        _renderAvailableDevices();
    } catch (e) {
        if (list) list.innerHTML = `<div class="text-center text-red-400 text-sm py-8">${t('ha.sync_error')}</div>`;
    }
}

export function closeAddDevicesModal() {
    const modal = document.getElementById('add-devices-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    _availableDevices = [];
}

function _renderAvailableDevices() {
    const list = document.getElementById('add-devices-list');
    if (!list) return;
    const search = (document.getElementById('add-devices-search')?.value || '').toLowerCase();
    const filtered = search ? _availableDevices.filter(d => `${d.name} ${d.entity_id}`.toLowerCase().includes(search)) : _availableDevices;

    if (!filtered.length) {
        list.innerHTML = `<div class="text-center text-slate-500 text-sm py-8">${search ? t('ha.no_devices_found') : t('ha.all_synced')}</div>`;
        _updateAddCount();
        return;
    }

    let currentDomain = '';
    let html = '';
    filtered.forEach(d => {
        const domain = d.domain || d.entity_id.split('.')[0];
        if (domain !== currentDomain) {
            currentDomain = domain;
            html += `<div class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-3 mb-1 px-1">${domain.replace('_', ' ')}</div>`;
        }
        const icon = DOMAIN_ICONS[domain] || 'fa-microchip';
        const color = DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400';
        const isActive = ACTIVE_STATES.includes(String(d.state).toLowerCase());
        html += `<div class="add-device-item" onclick="toggleAvailableDevice(this, '${d.entity_id}')">
            <input type="checkbox" class="add-device-check accent-accent cursor-pointer w-3.5 h-3.5 flex-shrink-0" value="${d.entity_id}" onclick="event.stopPropagation(); toggleAvailableDevice(this.parentElement, '${d.entity_id}')">
            <div class="ha-card-icon ${color} w-8 h-8 text-xs"><i class="fas ${icon}"></i></div>
            <div class="min-w-0 flex-1">
                <div class="text-sm text-white font-medium truncate">${escapeHtml(d.name || d.entity_id)}</div>
                <div class="text-[10px] text-slate-500 mono truncate">${d.entity_id}</div>
            </div>
            <span class="text-[10px] font-bold mono ${isActive ? 'text-green-400' : 'text-slate-500'}">${d.state}</span>
        </div>`;
    });
    list.innerHTML = html;
    _updateAddCount();
}

export function toggleAvailableDevice(el, eid) {
    const cb = el.querySelector('.add-device-check');
    if (cb && document.activeElement !== cb) cb.checked = !cb.checked;
    el.classList.toggle('selected', cb?.checked);
    _updateAddCount();
}

export function toggleAllAvailableDevices() {
    const checks = document.querySelectorAll('.add-device-check');
    const allChecked = Array.from(checks).every(c => c.checked);
    checks.forEach(c => { c.checked = !allChecked; c.closest('.add-device-item')?.classList.toggle('selected', !allChecked); });
    _updateAddCount();
}

function _updateAddCount() {
    const count = document.querySelectorAll('.add-device-check:checked').length;
    const el = document.getElementById('add-devices-count');
    if (el) el.innerText = t('ha.bulk_selected', { count });
}

export function filterAvailableDevices() {
    _renderAvailableDevices();
}

export async function confirmAddDevices() {
    const ids = Array.from(document.querySelectorAll('.add-device-check:checked')).map(c => c.value);
    if (!ids.length) return;
    try {
        await apiCall('/api/ha/add', { method: 'POST', body: { ids } });
        closeAddDevicesModal();
        await loadSmarthome();
    } catch (e) { showToast(t('ha.sync_error'), 'error'); }
}

// ... (Păstrează restul funcțiilor de Memory și Config neschimbate)
export async function loadMemory() {
    const res = await apiCall('/api/memory');
    memCache = await res.json();
    renderMemoryTable();
    loadMemoryEvents(0);
}

export async function loadMemoryEvents(offset = 0) {
    const tbody = document.getElementById('mem-log-tbody');
    const filterEl = document.getElementById('mem-log-type-filter');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-500">' + (t('memory.log_loading') || 'Loading...') + '</td></tr>';
    const eventType = (filterEl && filterEl.value) || '';
    try {
        let url = `/api/memory/events?limit=${MEM_LOG_PAGE_SIZE}&offset=${offset}`;
        if (eventType) url += `&event_type=${encodeURIComponent(eventType)}`;
        const res = await apiCall(url);
        const data = await res.json();
        const events = data.events || [];
        memLogTotal = data.total ?? 0;
        memLogOffset = offset;
        renderMemoryEventsTable(events);
        updateMemLogPagination();
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-red-400">' + (t('memory.log_error') || 'Error loading log') + '</td></tr>';
    }
}

function renderMemoryEventsTable(events) {
    const tbody = document.getElementById('mem-log-tbody');
    if (!tbody) return;
    if (!events.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-500">' + (t('memory.log_empty') || 'No events') + '</td></tr>';
        return;
    }
    tbody.innerHTML = events.map((ev, i) => {
        const ts = ev.ts ? new Date((typeof ev.ts === 'number' && ev.ts < 1e12 ? ev.ts * 1000 : ev.ts)).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
        const typeClass = ev.event_type && ev.event_type.startsWith('consolidation') ? 'text-amber-400/90' : (ev.event_type === 'fact_deleted' ? 'text-red-400/90' : 'text-slate-400');
        const detailsJson = ev.details && typeof ev.details === 'object' ? JSON.stringify(ev.details) : (ev.details ? String(ev.details) : '');
        const hasDetails = !!detailsJson;
        const rowId = `mem-log-row-${i}`;
        const detailsId = `mem-log-details-${i}`;
        return `<tr class="hover:bg-white/[0.02]" id="${rowId}">
            <td class="p-3 mono text-[11px] text-slate-500">${escapeHtml(ts)}</td>
            <td class="p-3"><span class="text-[11px] font-medium ${typeClass}">${escapeHtml(ev.event_type || '—')}</span></td>
            <td class="p-3 text-slate-300 max-w-md truncate" title="${escapeHtml(ev.summary || '')}">${escapeHtml(ev.summary || '—')}</td>
            <td class="p-3 text-center">${hasDetails ? `<button type="button" onclick="toggleMemLogDetails('${detailsId}')" class="text-accent hover:underline text-[10px]">${t('memory.log_details') || 'Details'}</button>` : '—'}
            </td>
        </tr>
        <tr id="${detailsId}" class="hidden bg-white/[0.02] border-b border-white/5"><td colspan="4" class="p-3"><pre class="text-[10px] mono text-slate-500 overflow-x-auto whitespace-pre-wrap break-all">${escapeHtml(detailsJson)}</pre></td></tr>`;
    }).join('');
}

// escapeHtml imported from utils.js

function updateMemLogPagination() {
    const from = memLogTotal === 0 ? 0 : memLogOffset + 1;
    const to = Math.min(memLogOffset + MEM_LOG_PAGE_SIZE, memLogTotal);
    const rangeEl = document.getElementById('mem-log-range');
    const prevBtn = document.getElementById('mem-log-prev');
    const nextBtn = document.getElementById('mem-log-next');
    if (rangeEl) rangeEl.textContent = memLogTotal === 0 ? '' : `${from}–${to} of ${memLogTotal}`;
    if (prevBtn) prevBtn.disabled = memLogOffset <= 0;
    if (nextBtn) nextBtn.disabled = memLogOffset + MEM_LOG_PAGE_SIZE >= memLogTotal;
}

export function memLogPrevPage() {
    if (memLogOffset <= 0) return;
    loadMemoryEvents(Math.max(0, memLogOffset - MEM_LOG_PAGE_SIZE));
}

export function memLogNextPage() {
    if (memLogOffset + MEM_LOG_PAGE_SIZE >= memLogTotal) return;
    loadMemoryEvents(memLogOffset + MEM_LOG_PAGE_SIZE);
}

export function toggleMemLogDetails(detailsId) {
    const row = document.getElementById(detailsId);
    if (!row) return;
    row.classList.toggle('hidden');
}

export async function clearMemoryLog() {
    const confirmed = await showConfirm(t('memory.log_clear_confirm') || 'Clear the entire memory log? This cannot be undone.');
    if (!confirmed) return;
    try {
        const res = await apiCall('/api/memory/clear_events', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        showToast(t('memory.log_cleared') || 'Memory log cleared', 'success');
        loadMemoryEvents(0);
    } catch (e) {
        showToast((t('memory.log_clear_error') || 'Failed to clear log') + ': ' + (e.message || String(e)), 'error');
    }
}

export async function runConsolidationNow() {
    const resultEl = document.getElementById('consolidation-run-result');
    if (resultEl) resultEl.textContent = t('memory.consolidation_running') || 'Running...';
    try {
        const res = await apiCall('/api/memory/consolidation/run', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        const r = data.result || {};
        const msg = (t('memory.consolidation_done') || 'Done') + ': merged ' + (r.merged || 0) + ', deleted ' + (r.deleted_ids || []).length + '.';
        if (resultEl) resultEl.textContent = msg;
        loadMemoryEvents(0);
    } catch (e) {
        if (resultEl) resultEl.textContent = (t('memory.consolidation_error') || 'Error') + ': ' + (e.message || String(e));
    }
}

// ── Extraction examples (few-shot) ──

let _extractionExamples = [];

export function getExtractionExamples() { return _extractionExamples; }

export function renderExtractionExamples(examples) {
    _extractionExamples = Array.isArray(examples) ? examples : [];
    const container = document.getElementById('extraction-examples-list');
    if (!container) return;
    container.innerHTML = '';
    _extractionExamples.forEach((ex, i) => {
        const row = document.createElement('div');
        row.className = 'flex flex-col sm:flex-row gap-2 items-start group';
        row.innerHTML = `
            <div class="flex-1 min-w-0 space-y-1 w-full">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Input</label>
                <input type="text" data-ex-idx="${i}" data-ex-field="input"
                    class="extraction-ex-input w-full bg-slate-900 border border-white/5 rounded-xl p-2.5 text-xs mono text-slate-300 focus:border-accent outline-none"
                    value="${(ex.input || '').replace(/"/g, '&quot;')}" placeholder="e.g. mi-e pofta de paste">
            </div>
            <div class="flex-1 min-w-0 space-y-1 w-full">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Output facts (comma-separated)</label>
                <input type="text" data-ex-idx="${i}" data-ex-field="output"
                    class="extraction-ex-output w-full bg-slate-900 border border-white/5 rounded-xl p-2.5 text-xs mono text-slate-300 focus:border-accent outline-none"
                    value="${(Array.isArray(ex.output) ? ex.output.join(', ') : (ex.output || '')).replace(/"/g, '&quot;')}" placeholder="e.g. Is craving pasta">
            </div>
            <button type="button" onclick="removeExtractionExample(${i})"
                class="mt-5 sm:mt-5 px-2.5 py-2 rounded-lg text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-colors flex-shrink-0 touch-manipulation"
                title="Remove"><i class="fas fa-trash-can"></i></button>
        `;
        container.appendChild(row);
    });

    // Live edits update the in-memory array
    container.querySelectorAll('input[data-ex-idx]').forEach(inp => {
        inp.addEventListener('input', () => {
            const idx = parseInt(inp.dataset.exIdx);
            const field = inp.dataset.exField;
            if (field === 'input') {
                _extractionExamples[idx].input = inp.value;
            } else if (field === 'output') {
                _extractionExamples[idx].output = inp.value.split(',').map(s => s.trim()).filter(Boolean);
            }
        });
    });
}

export function addExtractionExample() {
    _extractionExamples.push({ input: '', output: [] });
    renderExtractionExamples(_extractionExamples);
    // Focus last input
    const container = document.getElementById('extraction-examples-list');
    if (container) {
        const inputs = container.querySelectorAll('.extraction-ex-input');
        if (inputs.length) inputs[inputs.length - 1].focus();
    }
}

export function removeExtractionExample(idx) {
    _extractionExamples.splice(idx, 1);
    renderExtractionExamples(_extractionExamples);
}

// Daily news is now a skill (skills/daily_news.py) — no longer a core system feature.

// --- MEMENTO (removed — replaced by Planner calendar events) ---
export function loadReminders() {}
export function deleteReminder() {}
export function openMementoEdit() {}
export function closeMementoEdit() {}
export async function saveMementoEdit() {}
export function updateMementoBulkCount() {}
export function toggleAllMemento() {}
export async function deleteMementoBulk() {}

// --- CONȘTIINȚĂ (tabs Memorii | Automatizări) ---
export function switchIntelligenceTab(tabId) {
    document.querySelectorAll('.intelligence-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.intelligence-tab-btn').forEach(b => {
        b.classList.remove('border-accent', 'text-accent');
        b.classList.add('border-transparent', 'text-slate-500');
    });
    const panel = document.getElementById(`intelligence-panel-${tabId}`);
    const btn = document.getElementById(`intelligence-tab-${tabId}`);
    if (panel) panel.classList.remove('hidden');
    if (btn) {
        btn.classList.remove('border-transparent', 'text-slate-500');
        btn.classList.add('border-b-2', 'border-accent', 'text-accent');
    }
}

function formatLearnedTime(ts) {
    if (!ts) return '—';
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return (t('intelligence.updated_just_now') || 'just now');
    if (diff < 3600000) return (t('intelligence.updated_minutes_ago') || '{n} min ago').replace('{n}', Math.floor(diff / 60000));
    if (diff < 86400000) return (t('intelligence.updated_hours_ago') || '{n} h ago').replace('{n}', Math.floor(diff / 3600000));
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Data/ora exactă + cât de veche (pentru memorii). */
function formatMemoryDate(ts) {
    if (!ts) return { dateTime: '—', age: '—' };
    const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
    const dateStr = d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const now = Date.now();
    const diff = now - d.getTime();
    const days = Math.floor(diff / 86400000);
    let age = '';
    if (days === 0) age = formatLearnedTime(ts);
    else if (days === 1) age = t('memory.saved_1_day_ago') || 'acum 1 zi';
    else if (days < 30) age = (t('memory.saved_days_ago') || 'acum {n} zile').replace('{n}', String(days));
    else age = (t('memory.saved_old') || 'veche');
    return { dateTime: `${dateStr}, ${timeStr}`, age };
}

// --- Automatizări (tab Conștiință) ---
let _automationEditorRevision = null;
let _automationEditorId = null;
let _automationEditorMode = 'builder';
let _automationBuilderTriggers = [];
let _automationBuilderConditions = [];
let _automationBuilderActions = [];

const _AUTOMATION_SERVICE_PRESETS = {
    light: ['light.turn_on', 'light.turn_off', 'light.toggle'],
    switch: ['switch.turn_on', 'switch.turn_off', 'switch.toggle'],
    input_boolean: ['input_boolean.turn_on', 'input_boolean.turn_off', 'input_boolean.toggle'],
    cover: ['cover.open_cover', 'cover.close_cover', 'cover.stop_cover', 'cover.toggle', 'cover.set_cover_position'],
    lock: ['lock.lock', 'lock.unlock', 'lock.open'],
    climate: ['climate.turn_on', 'climate.turn_off', 'climate.set_temperature', 'climate.set_hvac_mode'],
    media_player: ['media_player.turn_on', 'media_player.turn_off', 'media_player.toggle', 'media_player.volume_set', 'media_player.media_play_pause'],
    vacuum: ['vacuum.start', 'vacuum.pause', 'vacuum.return_to_base', 'vacuum.stop'],
    script: ['script.turn_on', 'script.turn_off'],
    notify: ['notify.notify'],
    scene: ['scene.turn_on'],
    automation: ['automation.trigger', 'automation.turn_on', 'automation.turn_off'],
};

const _AUTOMATION_SERVICE_DATA_FIELDS = {
    'light.turn_on': [
        { key: 'brightness', labelKey: 'automations.service_field_brightness', fallback: 'Brightness', type: 'number', min: 0, max: 255, step: 1 },
        { key: 'color_temp', labelKey: 'automations.service_field_color_temp', fallback: 'Color temp', type: 'number', min: 153, max: 500, step: 1 },
        { key: 'transition', labelKey: 'automations.service_field_transition', fallback: 'Transition', type: 'number', min: 0, max: 300, step: 0.1 },
    ],
    'climate.set_temperature': [
        { key: 'temperature', labelKey: 'automations.service_field_temperature', fallback: 'Temperature', type: 'number', min: 5, max: 35, step: 0.5 },
    ],
    'climate.set_hvac_mode': [
        { key: 'hvac_mode', labelKey: 'automations.service_field_hvac_mode', fallback: 'HVAC mode', type: 'select', options: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only', 'heat_cool'] },
    ],
    'media_player.volume_set': [
        { key: 'volume_level', labelKey: 'automations.service_field_volume_level', fallback: 'Volume level', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
    'cover.set_cover_position': [
        { key: 'position', labelKey: 'automations.service_field_position', fallback: 'Position', type: 'number', min: 0, max: 100, step: 1 },
    ],
};

function _automationDefaultBuilderState() {
    return {
        id: 'new_automation',
        title: 'New automation',
        description: '',
        enabled: true,
        channel: 'web',
        mode: 'single',
    };
}

function _automationSetBuilderState(state) {
    const next = { ..._automationDefaultBuilderState(), ...(state || {}) };
    const fields = {
        id: 'automation-builder-id',
        title: 'automation-builder-title',
        description: 'automation-builder-description',
        channel: 'automation-builder-channel',
        mode: 'automation-builder-mode',
    };
    Object.entries(fields).forEach(([key, elementId]) => {
        const element = document.getElementById(elementId);
        if (element) element.value = next[key] ?? '';
    });
    const enabledEl = document.getElementById('automation-builder-enabled');
    if (enabledEl) enabledEl.checked = !!next.enabled;
}

function _automationGetBuilderState() {
    return {
        id: document.getElementById('automation-builder-id')?.value?.trim() || 'new_automation',
        title: document.getElementById('automation-builder-title')?.value?.trim() || 'New automation',
        description: document.getElementById('automation-builder-description')?.value?.trim() || '',
        enabled: !!document.getElementById('automation-builder-enabled')?.checked,
        channel: document.getElementById('automation-builder-channel')?.value || 'web',
        mode: document.getElementById('automation-builder-mode')?.value || 'single',
    };
}

function _automationYamlScalar(value) {
    const text = String(value ?? '');
    return JSON.stringify(text);
}

function _automationYamlBoolean(value) {
    return value ? 'true' : 'false';
}

function _automationSortHaEntities(items) {
    return [...(items || [])].sort((left, right) => {
        const leftName = String(left?.name || left?.entity_id || '').toLowerCase();
        const rightName = String(right?.name || right?.entity_id || '').toLowerCase();
        return leftName.localeCompare(rightName) || String(left?.entity_id || '').localeCompare(String(right?.entity_id || ''));
    });
}

function _automationInferServiceDomain(target) {
    const current = String(target?.value || '').trim();
    if (current.includes('.')) return current.split('.')[0];
    const card = target?.closest('.automation-builder-action-card');
    const entityInput = card?.querySelector('[data-action-field="entity_id"]');
    const entityId = String(entityInput?.value || '').trim();
    if (entityId.includes('.')) return entityId.split('.')[0];
    return '';
}

function _automationServicePresetList(domain = '') {
    const normalized = String(domain || '').trim().toLowerCase();
    const common = ['homeassistant.turn_on', 'homeassistant.turn_off', 'homeassistant.toggle'];
    if (normalized && _AUTOMATION_SERVICE_PRESETS[normalized]) {
        return [..._AUTOMATION_SERVICE_PRESETS[normalized], ...common.filter(item => !item.startsWith(`${normalized}.`))];
    }
    const flat = Object.values(_AUTOMATION_SERVICE_PRESETS).flat();
    return [...new Set([...flat, ...common])].sort();
}

function _automationRenderHaEntityOptions(items) {
    const listEl = document.getElementById('automation-ha-entity-options');
    if (!listEl) return;
    listEl.innerHTML = _automationSortHaEntities(items).map(item => {
        const entityId = escapeHtml(item?.entity_id || '');
        const name = escapeHtml(item?.name || item?.entity_id || '');
        const domain = escapeHtml(item?.domain || String(item?.entity_id || '').split('.')[0] || '');
        const aliases = Array.isArray(item?.aliases) && item.aliases.length ? ` [${escapeHtml(item.aliases.join(', '))}]` : '';
        return `<option value="${entityId}" label="${name} (${domain})${aliases}"></option>`;
    }).join('');
}

/* ═══════════════════════════════════════════════════════
   INLINE AUTOCOMPLETE — replaces standalone picker panels
   ═══════════════════════════════════════════════════════ */
let _activeAutocomplete = null;   // current open dropdown element
let _acHighlightIndex = -1;       // keyboard-highlighted item index

function _acClose() {
    if (_activeAutocomplete) {
        _activeAutocomplete.classList.remove('open');
        _activeAutocomplete = null;
    }
    _acHighlightIndex = -1;
}

function _acEntityItems(search) {
    const source = Array.isArray(haDevicesCache) ? haDevicesCache : [];
    const sorted = _automationSortHaEntities(source);
    if (!search) return sorted.slice(0, 60);
    const q = search.toLowerCase();
    return sorted.filter(item => {
        const haystack = [
            item?.name || '',
            item?.entity_id || '',
            item?.domain || '',
            ...(Array.isArray(item?.aliases) ? item.aliases : []),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
    }).slice(0, 60);
}

function _acServiceItems(search, domain) {
    const items = _automationServicePresetList(domain);
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(s => s.toLowerCase().includes(q));
}

function _acRenderEntity(dropdown, search) {
    const items = _acEntityItems(search);
    if (!items.length) {
        dropdown.innerHTML = `<div class="ac-empty">${t('automations.entity_empty_filtered') || 'Nicio entitate găsită.'}</div>`;
        return;
    }
    dropdown.innerHTML = items.map((item, i) => {
        const entityId = escapeHtml(item?.entity_id || '');
        const name = escapeHtml(item?.name || item?.entity_id || '');
        const domain = escapeHtml(item?.domain || String(item?.entity_id || '').split('.')[0] || '');
        return `<div class="ac-item${i === _acHighlightIndex ? ' ac-highlighted' : ''}" data-ac-value="${entityId}" data-ac-index="${i}">
            <div class="min-w-0" style="overflow:hidden">
                <div class="ac-item-name">${name}</div>
                <div class="ac-item-id">${entityId}</div>
            </div>
            <span class="ac-item-badge">${domain}</span>
        </div>`;
    }).join('');
}

function _acRenderService(dropdown, search, domain) {
    const items = _acServiceItems(search, domain);
    if (!items.length) {
        dropdown.innerHTML = `<div class="ac-empty">${t('automations.service_empty') || 'Niciun serviciu găsit.'}</div>`;
        return;
    }
    dropdown.innerHTML = items.map((item, i) => {
        return `<div class="ac-item${i === _acHighlightIndex ? ' ac-highlighted' : ''}" data-ac-value="${escapeHtml(item)}" data-ac-index="${i}">
            <div class="ac-item-name" style="font-family:var(--font-mono,monospace)">${escapeHtml(item)}</div>
        </div>`;
    }).join('');
}

function _acOpen(input, type, domain) {
    const wrapper = input.closest('.automation-inline-ac');
    if (!wrapper) return;
    const dropdown = wrapper.querySelector('.automation-inline-ac-dropdown');
    if (!dropdown) return;
    if (_activeAutocomplete && _activeAutocomplete !== dropdown) _acClose();
    _activeAutocomplete = dropdown;
    _acHighlightIndex = -1;
    const search = input.value.trim();
    if (type === 'entity') {
        _acRenderEntity(dropdown, search);
    } else {
        _acRenderService(dropdown, search, domain || '');
    }
    dropdown.classList.add('open');
}

function _acSelect(input, value, type) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    _acClose();
    if (type === 'service') {    }
}

function _acKeydown(e, input, type, domain) {
    const wrapper = input.closest('.automation-inline-ac');
    const dropdown = wrapper?.querySelector('.automation-inline-ac-dropdown');
    if (!dropdown || !dropdown.classList.contains('open')) return;
    const items = dropdown.querySelectorAll('.ac-item[data-ac-value]');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _acHighlightIndex = Math.min(_acHighlightIndex + 1, items.length - 1);
        _acUpdateHighlight(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _acHighlightIndex = Math.max(_acHighlightIndex - 1, 0);
        _acUpdateHighlight(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_acHighlightIndex >= 0 && items[_acHighlightIndex]) {
            _acSelect(input, items[_acHighlightIndex].getAttribute('data-ac-value'), type);
        }
    } else if (e.key === 'Escape') {
        e.preventDefault();
        _acClose();
        input.blur();
    }
}

function _acUpdateHighlight(items) {
    items.forEach((el, i) => {
        el.classList.toggle('ac-highlighted', i === _acHighlightIndex);
    });
    if (_acHighlightIndex >= 0 && items[_acHighlightIndex]) {
        items[_acHighlightIndex].scrollIntoView({ block: 'nearest' });
    }
}

// Global click handler to close autocomplete when clicking outside
document.addEventListener('mousedown', (e) => {
    if (_activeAutocomplete && !e.target.closest('.automation-inline-ac')) {
        _acClose();
    }
});

// Delegated click handler for autocomplete items
document.addEventListener('click', (e) => {
    const item = e.target.closest('.ac-item[data-ac-value]');
    if (!item) return;
    const dropdown = item.closest('.automation-inline-ac-dropdown');
    const wrapper = dropdown?.closest('.automation-inline-ac');
    const input = wrapper?.querySelector('input');
    if (!input) return;
    const type = input.hasAttribute('data-automation-entity-input') ? 'entity' : 'service';
    _acSelect(input, item.getAttribute('data-ac-value'), type);
});

/* Helper: builds inline-ac wrapper HTML around an entity input */
function _acEntityInputHtml(attrs) {
    return `<div class="automation-inline-ac">
        <input type="text" ${attrs}
            class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none"
            autocomplete="off">
        <div class="automation-inline-ac-dropdown"></div>
    </div>`;
}

/* Helper: builds inline-ac wrapper HTML around a service input */
function _acServiceInputHtml(attrs) {
    return `<div class="automation-inline-ac">
        <input type="text" ${attrs}
            class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none"
            autocomplete="off">
        <div class="automation-inline-ac-dropdown"></div>
    </div>`;
}

/* Attach inline-ac event listeners to dynamically rendered inputs */
function _acBindInputs(host) {
    host.querySelectorAll('[data-automation-entity-input]').forEach(input => {
        if (input._acBound) return;
        input._acBound = true;
        input.addEventListener('focus', () => _acOpen(input, 'entity'));
        input.addEventListener('input', () => {
            _acHighlightIndex = -1;
            _acOpen(input, 'entity');        });
        input.addEventListener('keydown', (e) => _acKeydown(e, input, 'entity'));
    });
    host.querySelectorAll('[data-automation-service-input]').forEach(input => {
        if (input._acBound) return;
        input._acBound = true;
        const getDomain = () => _automationInferServiceDomain(input);
        input.addEventListener('focus', () => _acOpen(input, 'service', getDomain()));
        input.addEventListener('input', () => {
            _acHighlightIndex = -1;
            _acOpen(input, 'service', getDomain());        });
        input.addEventListener('keydown', (e) => _acKeydown(e, input, 'service', getDomain()));
    });
}

// Legacy exports kept as no-ops so onclick attributes in templates don't throw
export function setAutomationEntityPickerTarget() {}
export function pickAutomationEntity() {}
export function filterAutomationEntityPicker() {}
export function setAutomationServicePickerTarget() {}
export function pickAutomationService() {}
export function filterAutomationServicePicker() {}

function _automationBuilderActionTemplate(kind = 'notify') {
    if (kind === 'service') {
        return { kind: 'service', service: 'light.turn_on', entity_id: '', data: '{}' };
    }
    if (kind === 'skill') {
        return { kind: 'skill', name: '', input: '{}' };
    }
    return { kind: 'notify', text: 'Automation created.' };
}

function _automationParseJsonObject(text) {
    try {
        const value = text ? JSON.parse(text) : {};
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

function _automationServiceDataFieldDefs(serviceName) {
    return _AUTOMATION_SERVICE_DATA_FIELDS[String(serviceName || '').trim()] || [];
}

function _automationRenderServiceStructuredFields(action, index) {
    const fields = _automationServiceDataFieldDefs(action?.service);
    if (!fields.length) return '';
    const data = _automationParseJsonObject(action?.data || '{}');
    const body = fields.map(field => {
        const label = t(field.labelKey) || field.fallback;
        const rawValue = data[field.key];
        if (field.type === 'select') {
            return `
                <div class="space-y-1">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                    <select data-service-data-field="${field.key}" data-action-index="${index}" onchange="updateAutomationStructuredServiceData(${index})" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                        <option value=""></option>
                        ${field.options.map(option => `<option value="${escapeHtml(option)}" ${rawValue === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
                    </select>
                </div>`;
        }
        return `
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                <input type="number" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} ${field.step != null ? `step="${field.step}"` : ''} data-service-data-field="${field.key}" data-action-index="${index}" value="${rawValue ?? ''}" oninput="updateAutomationStructuredServiceData(${index})" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
            </div>`;
    }).join('');
    return `
        <div class="space-y-3 sm:col-span-2 rounded-xl border border-white/5 bg-slate-950/50 p-3">
            <div>
                <div class="text-[10px] font-bold uppercase tracking-widest text-slate-400">${t('automations.service_data_assist_title') || 'Quick fields'}</div>
                <p class="text-[10px] text-slate-500 mt-1">${t('automations.service_data_assist_hint') || 'Common parameters for this service. The JSON stays editable below.'}</p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${body}</div>
        </div>`;
}

function _automationBuilderTriggerTemplate(platform = 'time') {
    if (platform === 'datetime') {
        return { platform: 'datetime', at: '' };
    }
    if (platform === 'interval') {
        return { platform: 'interval', every_minutes: '60', start_at: '' };
    }
    if (platform === 'home_assistant_state') {
        return { platform: 'home_assistant_state', entity_id: '', to: '', from: '' };
    }
    return { platform: 'time', at: '09:00', weekdays: '' };
}

function _automationBuilderConditionTemplate(kind = 'home_assistant_state') {
    if (kind === 'time_window') {
        return { kind: 'time_window', after: '', before: '' };
    }
    return { kind: 'home_assistant_state', entity_id: '', state: 'on' };
}

function _automationNormalizeTrigger(trigger) {
    const platform = trigger?.platform || 'time';
    return { ..._automationBuilderTriggerTemplate(platform), ...trigger, platform };
}

function _automationStateOptions(currentValue, includeEmpty = false) {
    const common = ['on', 'off', 'open', 'closed', 'home', 'not_home', 'unavailable', 'unknown'];
    const current = String(currentValue || '').trim();
    const values = includeEmpty ? [''].concat(common) : [...common];
    if (current && !values.includes(current)) values.push(current);
    return values.map((value) => {
        const selected = value === current ? 'selected' : '';
        const label = value || '—';
        return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

function _automationNormalizeCondition(condition) {
    const kind = condition?.kind || 'home_assistant_state';
    return { ..._automationBuilderConditionTemplate(kind), ...condition, kind };
}

function _automationRenderBuilderTriggers() {
    const host = document.getElementById('automation-builder-triggers');
    if (!host) return;
    host.innerHTML = _automationBuilderTriggers.map((trigger, index) => {
        const platform = trigger?.platform || 'time';
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-3 automation-builder-action-card" data-action-card-index="${index}">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${t('automations.builder_trigger_item') || 'Trigger'}</div>
                    <button type="button" onclick="removeAutomationBuilderTrigger(${index})" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete') || 'Delete'}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_platform') || 'Trigger type'}</label>
                        <select data-trigger-field="platform" data-trigger-index="${index}" onchange="syncAutomationYamlFromBuilder({ rerenderTriggers: true })" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                            <option value="time" ${platform === 'time' ? 'selected' : ''}>time</option>
                            <option value="datetime" ${platform === 'datetime' ? 'selected' : ''}>datetime</option>
                            <option value="interval" ${platform === 'interval' ? 'selected' : ''}>interval</option>
                            <option value="home_assistant_state" ${platform === 'home_assistant_state' ? 'selected' : ''}>home_assistant_state</option>
                        </select>
                    </div>
                    <div data-trigger-kind-wrap="time" class="space-y-1 ${platform === 'time' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_at') || 'Time'}</label>
                        <input type="text" data-trigger-field="at" data-trigger-index="${index}" value="${escapeHtml(trigger?.at || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="time" class="space-y-1 sm:col-span-2 ${platform === 'time' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_weekdays') || 'Weekdays'}</label>
                        <input type="text" data-trigger-field="weekdays" data-trigger-index="${index}" value="${escapeHtml(trigger?.weekdays || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="datetime" class="space-y-1 sm:col-span-2 ${platform === 'datetime' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_datetime') || 'ISO date and time'}</label>
                        <input type="text" data-trigger-field="at" data-trigger-index="${index}" value="${escapeHtml(trigger?.at || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="interval" class="space-y-1 ${platform === 'interval' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_every_minutes') || 'Every minutes'}</label>
                        <input type="number" min="1" max="10080" data-trigger-field="every_minutes" data-trigger-index="${index}" value="${escapeHtml(trigger?.every_minutes || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="interval" class="space-y-1 ${platform === 'interval' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_start_at') || 'Start at'}</label>
                        <input type="text" data-trigger-field="start_at" data-trigger-index="${index}" value="${escapeHtml(trigger?.start_at || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="home_assistant_state" class="space-y-1 sm:col-span-2 ${platform === 'home_assistant_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_entity_id') || 'Entity ID'}</label>
                        <div class="automation-inline-ac">
                            <input type="text" data-automation-entity-input="1" data-trigger-field="entity_id" data-trigger-index="${index}" value="${escapeHtml(trigger?.entity_id || '')}" autocomplete="off" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" placeholder="${t('automations.entity_search_placeholder') || 'Caută entități HA...'}">
                            <div class="automation-inline-ac-dropdown"></div>
                        </div>
                    </div>
                    <div data-trigger-kind-wrap="home_assistant_state" class="space-y-1 ${platform === 'home_assistant_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_to') || 'To state'}</label>
                        <select data-trigger-field="to" data-trigger-index="${index}" onchange="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                            ${_automationStateOptions(trigger?.to || 'on')}
                        </select>
                    </div>
                    <div data-trigger-kind-wrap="home_assistant_state" class="space-y-1 ${platform === 'home_assistant_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_from') || 'From state (opțional)'}</label>
                        <select data-trigger-field="from" data-trigger-index="${index}" onchange="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                            ${_automationStateOptions(trigger?.from || '', true)}
                        </select>
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
}

function _automationRenderBuilderConditions() {
    const host = document.getElementById('automation-builder-conditions');
    if (!host) return;
    if (!_automationBuilderConditions.length) {
        host.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-4 text-[11px] text-slate-500">${t('automations.builder_condition_empty') || 'No conditions. The automation will run whenever a trigger fires.'}</div>`;
        return;
    }
    host.innerHTML = _automationBuilderConditions.map((condition, index) => {
        const kind = condition?.kind || 'home_assistant_state';
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${t('automations.builder_condition_item') || 'Condition'}</div>
                    <button type="button" onclick="removeAutomationBuilderCondition(${index})" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete') || 'Delete'}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="space-y-1 sm:col-span-2">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_kind') || 'Condition type'}</label>
                        <select data-condition-field="kind" data-condition-index="${index}" onchange="syncAutomationYamlFromBuilder({ rerenderConditions: true })" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                            <option value="home_assistant_state" ${kind === 'home_assistant_state' ? 'selected' : ''}>home_assistant_state</option>
                            <option value="time_window" ${kind === 'time_window' ? 'selected' : ''}>time_window</option>
                        </select>
                    </div>
                    <div data-condition-kind-wrap="home_assistant_state" class="space-y-1 ${kind === 'home_assistant_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_entity_id') || 'Entity ID'}</label>
                        <div class="automation-inline-ac">
                            <input type="text" data-automation-entity-input="1" data-condition-field="entity_id" data-condition-index="${index}" value="${escapeHtml(condition?.entity_id || '')}" autocomplete="off" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" placeholder="${t('automations.entity_search_placeholder') || 'Caută entități HA...'}">
                            <div class="automation-inline-ac-dropdown"></div>
                        </div>
                    </div>
                    <div data-condition-kind-wrap="home_assistant_state" class="space-y-1 ${kind === 'home_assistant_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_state') || 'State'}</label>
                        <input type="text" data-condition-field="state" data-condition-index="${index}" value="${escapeHtml(condition?.state || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-condition-kind-wrap="time_window" class="space-y-1 ${kind === 'time_window' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_after') || 'After'}</label>
                        <input type="text" data-condition-field="after" data-condition-index="${index}" value="${escapeHtml(condition?.after || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-condition-kind-wrap="time_window" class="space-y-1 ${kind === 'time_window' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_before') || 'Before'}</label>
                        <input type="text" data-condition-field="before" data-condition-index="${index}" value="${escapeHtml(condition?.before || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
}

function _automationRenderBuilderActions() {
    const host = document.getElementById('automation-builder-actions');
    if (!host) return;
    host.innerHTML = _automationBuilderActions.map((action, index) => {
        const type = action?.kind || 'notify';
        const labelMap = {
            notify: t('automations.builder_action_notify') || 'Notify',
            service: t('automations.builder_action_service') || 'Service',
            skill: t('automations.builder_action_skill') || 'Skill',
        };
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-3 automation-builder-action-card" data-action-card-index="${index}">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${labelMap[type] || type}</div>
                    <button type="button" onclick="removeAutomationBuilderAction(${index})" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete') || 'Delete'}</button>
                </div>
                <div class="space-y-3">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_action_type') || 'Type'}</label>
                        <select data-action-field="kind" data-action-index="${index}" onchange="syncAutomationYamlFromBuilder({ rerenderActions: true })" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                            <option value="notify" ${type === 'notify' ? 'selected' : ''}>${t('automations.builder_action_notify') || 'Notify'}</option>
                            <option value="service" ${type === 'service' ? 'selected' : ''}>${t('automations.builder_action_service') || 'Service'}</option>
                            <option value="skill" ${type === 'skill' ? 'selected' : ''}>${t('automations.builder_action_skill') || 'Skill'}</option>
                        </select>
                    </div>
                    <div data-action-kind-wrap="notify" class="space-y-1 ${type === 'notify' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_notify_text') || 'Message'}</label>
                        <textarea data-action-field="text" data-action-index="${index}" oninput="syncAutomationYamlFromBuilder()" class="w-full min-h-[88px] bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none resize-y">${escapeHtml(action?.text || '')}</textarea>
                    </div>
                    <div data-action-kind-wrap="service" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${type === 'service' ? '' : 'hidden'}">
                        <div class="space-y-1 sm:col-span-2">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_name') || 'Service'}</label>
                            <div class="automation-inline-ac">
                                <input type="text" data-automation-service-input="1" data-action-field="service" data-action-index="${index}" value="${escapeHtml(action?.service || '')}" autocomplete="off" onchange="syncAutomationYamlFromBuilder({ rerenderActions: true })" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" placeholder="${t('automations.service_search_placeholder') || 'Caută servicii HA...'}">
                                <div class="automation-inline-ac-dropdown"></div>
                            </div>
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_entity_id') || 'Entity ID'}</label>
                            <div class="automation-inline-ac">
                                <input type="text" data-automation-entity-input="1" data-action-field="entity_id" data-action-index="${index}" value="${escapeHtml(action?.entity_id || '')}" autocomplete="off" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" placeholder="${t('automations.entity_search_placeholder') || 'Caută entități HA...'}">
                                <div class="automation-inline-ac-dropdown"></div>
                            </div>
                        </div>
                        ${_automationRenderServiceStructuredFields(action, index)}
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_data') || 'Data JSON'}</label>
                            <textarea data-action-field="data" data-action-index="${index}" oninput="syncAutomationYamlFromBuilder({ rerenderActions: true })" class="w-full min-h-[88px] bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none resize-y">${escapeHtml(action?.data || '{}')}</textarea>
                        </div>
                    </div>
                    <div data-action-kind-wrap="skill" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${type === 'skill' ? '' : 'hidden'}">
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_skill_name') || 'Skill name'}</label>
                            <input type="text" data-action-field="name" data-action-index="${index}" value="${escapeHtml(action?.name || '')}" oninput="syncAutomationYamlFromBuilder()" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_skill_input') || 'Input JSON'}</label>
                            <textarea data-action-field="input" data-action-index="${index}" oninput="syncAutomationYamlFromBuilder()" class="w-full min-h-[88px] bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none resize-y">${escapeHtml(action?.input || '{}')}</textarea>
                        </div>
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
}

function _automationReadBuilderActionsFromDom() {
    const next = _automationBuilderActions.map(action => ({ ...action }));
    document.querySelectorAll('[data-action-index][data-action-field]').forEach(element => {
        const index = Number(element.getAttribute('data-action-index'));
        const field = element.getAttribute('data-action-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderActionTemplate();
        next[index][field] = element.value;
    });
    _automationBuilderActions = next.map(action => {
        const kind = action?.kind || 'notify';
        return { ..._automationBuilderActionTemplate(kind), ...action, kind };
    });
}

function _automationReadBuilderTriggersFromDom() {
    const next = _automationBuilderTriggers.map(trigger => ({ ...trigger }));
    document.querySelectorAll('[data-trigger-index][data-trigger-field]').forEach(element => {
        const index = Number(element.getAttribute('data-trigger-index'));
        const field = element.getAttribute('data-trigger-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderTriggerTemplate();
        next[index][field] = element.value;
    });
    _automationBuilderTriggers = next.map(_automationNormalizeTrigger);
}

function _automationReadBuilderConditionsFromDom() {
    const next = _automationBuilderConditions.map(condition => ({ ...condition }));
    document.querySelectorAll('[data-condition-index][data-condition-field]').forEach(element => {
        const index = Number(element.getAttribute('data-condition-index'));
        const field = element.getAttribute('data-condition-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderConditionTemplate();
        next[index][field] = element.value;
    });
    _automationBuilderConditions = next.map(_automationNormalizeCondition);
}

function _automationBuilderWeekdaysList(raw) {
    return String(raw || '')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function _automationBuildYamlFromBuilder() {
    _automationReadBuilderTriggersFromDom();
    _automationReadBuilderConditionsFromDom();
    _automationReadBuilderActionsFromDom();
    const state = _automationGetBuilderState();
    const lines = [
        'version: 1',
        `id: ${state.id || 'new_automation'}`,
        `title: ${_automationYamlScalar(state.title || 'New automation')}`,
        `enabled: ${_automationYamlBoolean(state.enabled)}`,
        `channel: ${state.channel || 'web'}`,
        `mode: ${state.mode || 'single'}`,
    ];
    if (state.description) lines.push(`description: ${_automationYamlScalar(state.description)}`);
    lines.push('trigger:');
    (_automationBuilderTriggers.length ? _automationBuilderTriggers : [_automationBuilderTriggerTemplate('time')]).forEach(trigger => {
        const platform = trigger?.platform || 'time';
        if (platform === 'datetime') {
            lines.push('  - platform: datetime');
            lines.push(`    at: ${_automationYamlScalar(trigger.at || '')}`);
        } else if (platform === 'interval') {
            lines.push('  - platform: interval');
            lines.push(`    every_minutes: ${Number(trigger.every_minutes || 0) || 0}`);
            if (trigger.start_at) lines.push(`    start_at: ${_automationYamlScalar(trigger.start_at)}`);
        } else if (platform === 'home_assistant_state') {
            lines.push('  - platform: home_assistant_state');
            lines.push(`    entity_id: ${_automationYamlScalar(trigger.entity_id || '')}`);
            lines.push(`    to: ${_automationYamlScalar(trigger.to || '')}`);
            if (trigger.from) lines.push(`    from: ${_automationYamlScalar(trigger.from)}`);
        } else {
            lines.push('  - platform: time');
            lines.push(`    at: ${_automationYamlScalar(trigger.at || '')}`);
            const weekdays = _automationBuilderWeekdaysList(trigger.weekdays);
            if (weekdays.length) {
                lines.push('    weekdays:');
                weekdays.forEach(day => lines.push(`      - ${day}`));
            }
        }
    });
    if (_automationBuilderConditions.length) {
        lines.push('condition:');
        _automationBuilderConditions.forEach(condition => {
            if (condition.kind === 'home_assistant_state') {
                lines.push('  - kind: home_assistant_state');
                lines.push(`    entity_id: ${_automationYamlScalar(condition.entity_id || '')}`);
                lines.push(`    state: ${_automationYamlScalar(condition.state || '')}`);
            } else if (condition.kind === 'time_window') {
                lines.push('  - kind: time_window');
                if (condition.after) lines.push(`    after: ${_automationYamlScalar(condition.after)}`);
                if (condition.before) lines.push(`    before: ${_automationYamlScalar(condition.before)}`);
            }
        });
    }
    lines.push('action:');
    (_automationBuilderActions.length ? _automationBuilderActions : [_automationBuilderActionTemplate('notify')]).forEach(action => {
        const kind = action?.kind || 'notify';
        if (kind === 'service') {
            lines.push(`  - service: ${action.service || ''}`);
            if (action.entity_id) {
                lines.push('    target:');
                lines.push(`      entity_id: ${_automationYamlScalar(action.entity_id)}`);
            } else {
                lines.push('    target: {}');
            }
            let parsedData = {};
            try { parsedData = action.data ? JSON.parse(action.data) : {}; } catch (_) { parsedData = {}; }
            const entries = Object.entries(parsedData || {});
            if (!entries.length) {
                lines.push('    data: {}');
            } else {
                lines.push('    data:');
                entries.forEach(([key, value]) => lines.push(`      ${key}: ${typeof value === 'string' ? _automationYamlScalar(value) : JSON.stringify(value)}`));
            }
        } else if (kind === 'skill') {
            lines.push('  - skill:');
            lines.push(`      name: ${_automationYamlScalar(action.name || '')}`);
            let parsedInput = {};
            try { parsedInput = action.input ? JSON.parse(action.input) : {}; } catch (_) { parsedInput = {}; }
            const entries = Object.entries(parsedInput || {});
            if (!entries.length) {
                lines.push('      input: {}');
            } else {
                lines.push('      input:');
                entries.forEach(([key, value]) => lines.push(`        ${key}: ${typeof value === 'string' ? _automationYamlScalar(value) : JSON.stringify(value)}`));
            }
        } else {
            lines.push('  - notify:');
            lines.push(`      text: ${_automationYamlScalar(action.text || '')}`);
        }
    });
    return lines.join('\n') + '\n';
}

function _automationSetBuilderWarning(message = '') {
    const element = document.getElementById('automation-builder-warning');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('hidden', !message);
}

async function _automationHydrateBuilderFromNormalized(normalized, warningMessage = '') {
    const triggers = Array.isArray(normalized?.trigger) ? normalized.trigger : [];
    const conditions = Array.isArray(normalized?.condition) ? normalized.condition : [];
    const actions = Array.isArray(normalized?.action) ? normalized.action : [];
    if (!triggers.length || !actions.length) {
        _automationSetBuilderWarning(t('automations.builder_sync_error') || 'Builder could not load this YAML.');
        return false;
    }
    const nextState = {
        id: normalized.id || 'new_automation',
        title: normalized.title || 'New automation',
        description: normalized.description || '',
        enabled: normalized.enabled !== false,
        channel: normalized.channel || 'web',
        mode: normalized.mode || 'single',
    };
    _automationBuilderTriggers = triggers.map(trigger => _automationNormalizeTrigger({
        ...trigger,
        weekdays: Array.isArray(trigger?.weekdays) ? trigger.weekdays.join(', ') : '',
        every_minutes: trigger?.every_minutes != null ? String(trigger.every_minutes) : '60',
    }));
    _automationBuilderConditions = conditions.map(condition => _automationNormalizeCondition(condition));
    _automationBuilderActions = actions.map(action => {
        if (action?.kind === 'service') {
            return {
                kind: 'service',
                service: action.service || '',
                entity_id: action?.target?.entity_id || '',
                data: JSON.stringify(action.data || {}, null, 2),
            };
        }
        if (action?.kind === 'skill') {
            return {
                kind: 'skill',
                name: action.name || '',
                input: JSON.stringify(action.input || {}, null, 2),
            };
        }
        return {
            kind: 'notify',
            text: action.text || '',
        };
    });
    _automationSetBuilderState(nextState);
    _automationRenderBuilderTriggers();
    _automationRenderBuilderConditions();
    _automationRenderBuilderActions();
    _automationSetBuilderWarning(warningMessage);
    return true;
}

function _automationResetBuilder() {
    _automationBuilderTriggers = [_automationBuilderTriggerTemplate('time')];
    _automationBuilderConditions = [];
    _automationBuilderActions = [_automationBuilderActionTemplate('notify')];
    _acClose();
    _automationSetBuilderState(_automationDefaultBuilderState());
    _automationRenderBuilderTriggers();
    _automationRenderBuilderConditions();
    _automationRenderBuilderActions();
    _automationSetBuilderWarning('');
}

function _automationSetEditorMode(mode) {
    _automationEditorMode = mode === 'yaml' ? 'yaml' : 'builder';
    document.querySelectorAll('[data-automation-editor-mode]').forEach(element => {
        const active = element.getAttribute('data-automation-editor-mode') === _automationEditorMode;
        element.classList.toggle('bg-accent', active);
        element.classList.toggle('text-bg-main', active);
        element.classList.toggle('text-slate-300', !active);
        element.classList.toggle('bg-white/5', !active);
    });
    document.querySelectorAll('[data-automation-editor-panel]').forEach(element => {
        element.classList.toggle('hidden', element.getAttribute('data-automation-editor-panel') !== _automationEditorMode);
    });
}

function _formatAutomationNextRun(item) {
    const nextRuns = Array.isArray(item?.next_runs) ? item.next_runs : [];
    const nextRunAt = nextRuns[0]?.next_run_at;
    if (!nextRunAt) return '—';
    try {
        return new Date(nextRunAt.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return nextRunAt;
    }
}

function _formatAutomationUpdatedAt(item) {
    if (!item?.updated_at) return '—';
    try {
        return new Date(item.updated_at.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return item.updated_at;
    }
}

function _formatAutomationHistoryAt(value) {
    if (!value) return '—';
    try {
        return new Date(value.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return value;
    }
}

function _automationStatusBadge(item) {
    const enabled = !!item?.enabled;
    return enabled
        ? `<span class="text-[9px] font-bold uppercase tracking-wider text-emerald-400/90 bg-emerald-500/15 px-2 py-0.5 rounded">${t('automations.enabled_badge') || 'Activă'}</span>`
        : `<span class="text-[9px] font-bold uppercase tracking-wider text-slate-400 bg-slate-500/15 px-2 py-0.5 rounded">${t('automations.disabled_badge') || 'Oprită'}</span>`;
}

function _automationLastRunBadge(item) {
    const status = (item?.last_run_status || '').trim().toLowerCase();
    if (!status) {
        return `<span class="text-[9px] font-bold uppercase tracking-wider text-slate-400 bg-slate-500/10 px-2 py-0.5 rounded">${t('automations.never_run') || 'Nerulată'}</span>`;
    }
    const map = {
        ok: 'text-emerald-400/90 bg-emerald-500/15',
        skipped: 'text-amber-400/90 bg-amber-500/15',
        error: 'text-red-400/90 bg-red-500/15',
    };
    const labelMap = {
        ok: t('automations.last_run_ok') || 'Ultima: OK',
        skipped: t('automations.last_run_skipped') || 'Ultima: skip',
        error: t('automations.last_run_error') || 'Ultima: eroare',
    };
    return `<span class="text-[9px] font-bold uppercase tracking-wider ${map[status] || 'text-slate-400 bg-slate-500/10'} px-2 py-0.5 rounded">${labelMap[status] || status}</span>`;
}

function _automationRunStatusBadge(status) {
    const normalized = String(status || '').trim().toLowerCase();
    const map = {
        ok: 'text-emerald-400/90 bg-emerald-500/15',
        skipped: 'text-amber-400/90 bg-amber-500/15',
        error: 'text-red-400/90 bg-red-500/15',
    };
    const labelMap = {
        ok: t('automations.history_status_ok') || 'OK',
        skipped: t('automations.history_status_skipped') || 'Skipped',
        error: t('automations.history_status_error') || 'Error',
    };
    return `<span class="text-[9px] font-bold uppercase tracking-wider ${map[normalized] || 'text-slate-400 bg-slate-500/10'} px-2 py-0.5 rounded">${labelMap[normalized] || escapeHtml(normalized || '—')}</span>`;
}

function _buildAutomationTemplate() {
    return [
        'version: 1',
        'id: new_automation',
        'title: New automation',
        'enabled: true',
        'trigger:',
        '  - platform: time',
        '    at: "09:00"',
        'action:',
        '  - notify:',
        '      text: Automation created.',
        '',
    ].join('\n');
}

export async function loadAutomationEditorHistory(targetId) {
    const listEl = document.getElementById('automation-history-list');
    const emptyEl = document.getElementById('automation-history-empty');
    if (!listEl || !emptyEl) return;
    listEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    listEl.innerHTML = `<p class="text-[11px] text-slate-500">${t('automations.loading') || 'Loading...'}</p>`;
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(targetId)}/history`);
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            listEl.innerHTML = '';
            listEl.classList.add('hidden');
            emptyEl.classList.remove('hidden');
            emptyEl.textContent = t('automations.history_empty') || 'No runs yet.';
            return;
        }
        listEl.innerHTML = items.map(item => {
            const detailsText = item?.details ? escapeHtml(JSON.stringify(item.details)) : '';
            return `
                <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-2">
                    <div class="flex items-center justify-between gap-3">
                        <div class="text-[11px] text-slate-300">${escapeHtml(_formatAutomationHistoryAt(item.started_at))}</div>
                        ${_automationRunStatusBadge(item.status)}
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
                        <span><span class="text-slate-400">${t('automations.history_trigger') || 'Trigger'}:</span> ${escapeHtml(item.trigger_source || '—')}</span>
                        <span><span class="text-slate-400">${t('automations.history_finished') || 'Finished'}:</span> ${escapeHtml(_formatAutomationHistoryAt(item.finished_at))}</span>
                    </div>
                    ${item.message ? `<p class="text-[11px] text-slate-300">${escapeHtml(item.message)}</p>` : ''}
                    ${detailsText ? `<p class="text-[10px] text-slate-500 break-all">${detailsText}</p>` : ''}
                </div>`;
        }).join('');
    } catch (_) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = t('automations.history_error') || 'Could not load history.';
    }
}

export function switchAutomationEditorMode(mode) {
    _automationSetEditorMode(mode);
    if (mode === 'yaml') {
        refreshCodeEditor('automation-editor-yaml');
    }
}

export async function syncAutomationYamlFromBuilder(options = {}) {
    if (options.rerenderTriggers) {
        _automationReadBuilderTriggersFromDom();
        _automationRenderBuilderTriggers();
    }
    if (options.rerenderConditions) {
        _automationReadBuilderConditionsFromDom();
        _automationRenderBuilderConditions();
    }
    if (options.rerenderActions) {
        _automationReadBuilderActionsFromDom();
        _automationRenderBuilderActions();
    }
    const yamlEl = document.getElementById('automation-editor-yaml');
    if (!yamlEl) return;
    setCodeEditorValue('automation-editor-yaml', _automationBuildYamlFromBuilder());
    if (!options.silent) {
        const validateEl = document.getElementById('automation-editor-validation');
        if (validateEl) validateEl.classList.add('hidden');
    }
}

export async function syncAutomationBuilderFromYaml(options = {}) {
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) return false;
    try {
        const res = await apiCall('/api/automations/definitions/validate', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const normalized = data.normalized || {};
        return await _automationHydrateBuilderFromNormalized(normalized, '');
    } catch (e) {
        _automationSetBuilderWarning(options.silent ? '' : (t('automations.builder_sync_error') || 'Builder could not load this YAML.'));
        return false;
    }
}

export async function loadAutomations() {
    const listEl = document.getElementById('automations-list');
    const emptyEl = document.getElementById('automations-empty');
    if (!listEl) return;
    listEl.innerHTML = `<p class="text-[11px] text-slate-500">${t('automations.loading') || 'Loading...'}</p>`;
    try {
        const res = await apiCall('/api/automations/definitions');
        const data = await res.json();
        const automations = Array.isArray(data.items) ? data.items : [];
        if (!automations.length) {
            listEl.classList.add('hidden');
            if (emptyEl) emptyEl.classList.remove('hidden');
        } else {
            listEl.classList.remove('hidden');
            if (emptyEl) emptyEl.classList.add('hidden');
            listEl.innerHTML = automations.map(a => {
                const defId = escapeHtml(a.id).replace(/"/g, '&quot;');
                const triggerText = escapeHtml((a.trigger_summary || []).join(' • ') || '—');
                const actionText = escapeHtml((a.action_summary || []).join(' • ') || '—');
                const yamlPath = escapeHtml(a.yaml_path || '—');
                return `
                <div class="py-3 px-4 rounded-xl bg-white/[0.02] border border-white/5 group automation-card">
                    <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <p class="text-sm text-slate-200 font-medium">${escapeHtml(a.title || a.id || '—')}</p>
                            ${_automationStatusBadge(a)}
                            ${_automationLastRunBadge(a)}
                        </div>
                        <p class="text-[10px] text-slate-500 mt-1">${escapeHtml(a.id)} • r${escapeHtml(String(a.revision || 1))}</p>
                        <p class="text-[11px] text-slate-400 mt-2">${triggerText}</p>
                        <p class="text-[10px] text-slate-500 mt-1">${actionText}</p>
                        <div class="mt-2 text-[10px] text-slate-500">
                            <span class="text-slate-400">YAML:</span> ${yamlPath}
                            <span class="ml-2 text-slate-400">${t('automations.next_run') || 'Next'}:</span> ${escapeHtml(_formatAutomationNextRun(a))}
                        </div>
                    </div>
                    <div class="flex items-center gap-1 flex-shrink-0 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-all">
                        <button type="button" onclick="runAutomationDefinition('${defId}')" class="p-2 rounded-lg text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors" title="${t('automations.run') || 'Run'}"><i class="fas fa-play text-xs"></i></button>
                        <button type="button" onclick="toggleAutomationDefinition('${defId}', ${!!a.enabled}, ${a.revision || 1})" class="p-2 rounded-lg text-slate-500 hover:text-amber-400 hover:bg-amber-500/10 transition-colors" title="${a.enabled ? (t('automations.disable') || 'Disable') : (t('automations.enable') || 'Enable')}"><i class="fas ${a.enabled ? 'fa-pause' : 'fa-play-circle'} text-xs"></i></button>
                        <button type="button" onclick="openAutomationEditor('${defId}')" class="p-2 rounded-lg text-slate-500 hover:text-accent hover:bg-accent/10 transition-colors" title="${t('automations.edit') || 'Edit'}"><i class="fas fa-pen text-xs"></i></button>
                        <button type="button" onclick="deleteAutomation('${defId}')" class="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="${t('automations.delete') || 'Delete'}"><i class="fas fa-trash-alt text-xs"></i></button>
                    </div>
                    </div>
                </div>`;
            }).join('');
        }
    } catch (e) {
        listEl.innerHTML = '<p class="text-red-400 text-sm">' + (t('automations.error') || 'Eroare la încărcare') + '</p>';
        if (emptyEl) emptyEl.classList.add('hidden');
    }
}

export async function deleteAutomation(jobId) {
    if (!(await showConfirm(t('automations.delete_confirm') || 'Ștergi această automatizare?'))) return;
    try {
        const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(jobId), { method: 'DELETE' });
        if (!res.ok) throw new Error();
        if (_automationEditorId === jobId) closeAutomationEditor();
        showToast(t('automations.deleted') || 'Automation deleted.', 'success');
        await loadAutomations();
    } catch (e) {
        showToast(t('automations.delete_error') || 'Could not delete.', 'error');
    }
}

export async function openAutomationEditor(automationId) {
    const validateEl = document.getElementById('automation-editor-validation');
    const infoEl = document.getElementById('automation-editor-info');
    const pathEl = document.getElementById('automation-editor-path');
    const idEl = document.getElementById('automation-editor-id');
    const revEl = document.getElementById('automation-editor-revision');
    const idDisplayEl = document.getElementById('automation-editor-id-display');
    const titleEl = document.getElementById('automation-editor-title');
    _automationEditorId = automationId || null;
    _automationEditorRevision = null;
    if (validateEl) validateEl.classList.add('hidden');
    if (infoEl) infoEl.textContent = '';
    if (pathEl) pathEl.textContent = '—';
    if (idEl) idEl.value = automationId || '';
    if (revEl) revEl.value = '';
    if (idDisplayEl) idDisplayEl.textContent = automationId || 'YAML';
    _automationResetBuilder();
    if (!automationId) {
        if (titleEl) titleEl.textContent = t('automations.editor_new_title') || 'Automatizare nouă';
        setCodeEditorValue('automation-editor-yaml', _buildAutomationTemplate());
        await refreshAutomationEntityOptions();
        openSubPage('automation-editor-modal');
        refreshCodeEditor('automation-editor-yaml');
        return;
    }
    if (titleEl) titleEl.textContent = t('automations.editor_edit_title') || 'Editează automatizarea';
    setCodeEditorValue('automation-editor-yaml', '');
    if (infoEl) infoEl.textContent = t('automations.loading') || 'Se încărcă...';
    openSubPage('automation-editor-modal');
    refreshCodeEditor('automation-editor-yaml');
    try {
        const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(automationId));
        const data = await res.json();
        const item = data.item || {};
        _automationEditorId = item.id || automationId;
        _automationEditorRevision = item.revision || 1;
        if (idEl) idEl.value = item.id || automationId;
        if (idDisplayEl) idDisplayEl.textContent = item.id || automationId;
        if (revEl) revEl.value = String(item.revision || 1);
        if (pathEl) pathEl.textContent = item.yaml_path || '—';
        setCodeEditorValue('automation-editor-yaml', item.source_yaml || _buildAutomationTemplate());
        if (infoEl) infoEl.textContent = `${t('automations.revision') || 'Revision'} ${item.revision || 1} • ${item.enabled ? (t('automations.enabled_badge') || 'Activă') : (t('automations.disabled_badge') || 'Oprită')}`;
        await _automationHydrateBuilderFromNormalized(item.normalized || {}, '');
        await refreshAutomationEntityOptions();
        refreshCodeEditor('automation-editor-yaml');
        await loadAutomationEditorHistory(automationId);
    } catch (e) {
        showToast(t('automations.load_error') || 'Could not load automation.', 'error');
    }
}

export function closeAutomationEditor() {
    const historyList = document.getElementById('automation-history-list');
    const historyEmpty = document.getElementById('automation-history-empty');
    if (historyList) historyList.innerHTML = '';
    if (historyEmpty) {
        historyEmpty.classList.remove('hidden');
        historyEmpty.textContent = t('automations.history_unavailable') || 'History will appear after the first run.';
    }
    closeSubPage('automation-editor-modal');
}

export async function validateAutomationEditor() {
    const validateEl = document.getElementById('automation-editor-validation');
    if (!validateEl) return;
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) return;
    try {
        const res = await apiCall('/api/automations/definitions/validate', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        await _automationHydrateBuilderFromNormalized(data.normalized || {}, '');
        validateEl.classList.remove('hidden');
        validateEl.className = 'mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300';
        validateEl.textContent = `${t('automations.validation_ok') || 'YAML valid.'} ${data.normalized?.id || ''}`.trim();
    } catch (e) {
        let detail = t('automations.validation_error') || 'YAML invalid.';
        try {
            const payload = JSON.parse(e?.message || '{}');
            if (payload?.detail) detail = payload.detail;
        } catch (_) {}
        if (e?.message && !e.message.startsWith('{')) detail = e.message;
        validateEl.classList.remove('hidden');
        validateEl.className = 'mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300';
        validateEl.textContent = detail;
    }
}

export async function saveAutomationEditor() {
    const revisionEl = document.getElementById('automation-editor-revision');
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) {
        showToast(t('automations.validation_error') || 'YAML invalid.', 'error');
        return;
    }
    try {
        if (_automationEditorId) {
            const expectedRevision = Number(revisionEl?.value || _automationEditorRevision || 1);
            const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(_automationEditorId), {
                method: 'PUT',
                body: { source_yaml: sourceYaml, expected_revision: expectedRevision },
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
                throw new Error(String(detail));
            }
            showToast(t('automations.saved') || 'Automation saved.', 'success');
        } else {
            const res = await apiCall('/api/automations/definitions', {
                method: 'POST',
                body: { source_yaml: sourceYaml },
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
                throw new Error(String(detail));
            }
            showToast(t('automations.created') || 'Automation created.', 'success');
        }
        await loadAutomations();
    } catch (e) {
        const msg = (e && e.message) ? e.message : (t('automations.save_error') || 'Could not save automation.');
        showToast(msg, 'error');
    }
}

export async function toggleAutomationDefinition(automationId, enabled, revision) {
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(automationId)}/${enabled ? 'disable' : 'enable'}`, {
            method: 'POST',
            body: { expected_revision: Number(revision || 1) },
        });
        if (!res.ok) throw new Error();
        showToast(enabled ? (t('automations.disabled') || 'Automation disabled.') : (t('automations.enabled') || 'Automation enabled.'), 'success');
        if (_automationEditorId === automationId) {
            const infoEl = document.getElementById('automation-editor-info');
            if (infoEl) infoEl.textContent = enabled ? (t('automations.disabled_badge') || 'Oprită') : (t('automations.enabled_badge') || 'Activă');
        }
        await loadAutomations();
    } catch (e) {
        showToast(t('automations.toggle_error') || 'Could not update automation.', 'error');
    }
}

export async function runAutomationDefinition(automationId) {
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(automationId)}/run`, { method: 'POST' });
        if (!res.ok) throw new Error();
        showToast(t('automations.ran') || 'Automation executed.', 'success');
        if (_automationEditorId === automationId) await loadAutomationEditorHistory(automationId);
    } catch (e) {
        showToast(t('automations.run_error') || 'Could not run automation.', 'error');
    }
}

export async function refreshAutomationEntityOptions() {
    const selects = document.querySelectorAll('[data-automation-entity-select]');
    if (!selects.length) return;
    try {
        const res = await apiCall('/api/ha/entities');
        const data = await res.json();
        const entities = Array.isArray(data.entities) ? data.entities : [];
        selects.forEach(sel => {
            const current = sel.value;
            sel.innerHTML = `<option value="">${t('automations.entity_placeholder') || '— alege entitate —'}</option>` +
                entities.map(e => `<option value="${escapeHtml(e.entity_id)}"${e.entity_id === current ? ' selected' : ''}>${escapeHtml(e.entity_id)}${e.friendly_name ? ' — ' + escapeHtml(e.friendly_name) : ''}</option>`).join('');
        });
    } catch (_) {}
}

export function addAutomationBuilderTrigger(platform) {
    _automationBuilderTriggers.push(_automationBuilderTriggerTemplate(platform || 'time'));
    _automationRenderBuilderTriggers();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderTrigger(idx) {
    _automationBuilderTriggers.splice(Number(idx), 1);
    if (!_automationBuilderTriggers.length) _automationBuilderTriggers.push(_automationBuilderTriggerTemplate('time'));
    _automationRenderBuilderTriggers();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function addAutomationBuilderCondition(kind) {
    _automationBuilderConditions.push(_automationBuilderConditionTemplate(kind || 'time_range'));
    _automationRenderBuilderConditions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderCondition(idx) {
    _automationBuilderConditions.splice(Number(idx), 1);
    _automationRenderBuilderConditions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function addAutomationBuilderAction(kind) {
    _automationBuilderActions.push(_automationBuilderActionTemplate(kind || 'notify'));
    _automationRenderBuilderActions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderAction(idx) {
    _automationBuilderActions.splice(Number(idx), 1);
    if (!_automationBuilderActions.length) _automationBuilderActions.push(_automationBuilderActionTemplate('notify'));
    _automationRenderBuilderActions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function updateAutomationStructuredServiceData(index) {
    _automationReadBuilderActionsFromDom();
    syncAutomationYamlFromBuilder({ silent: true });
}

const MEM_PER_PAGE = 12;

export function renderMemoryTable() {
    const container = document.getElementById("mem-container");
    if (!container) return;
    const term = document.getElementById("mem-search")?.value.toLowerCase() || '';
    const filtered = memCache.filter(m => m.document.toLowerCase().includes(term));
    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    if (memPage > maxPage) memPage = maxPage;
    const slice = filtered.slice((memPage - 1) * MEM_PER_PAGE, memPage * MEM_PER_PAGE);
    const pageInfoEl = document.getElementById('mem-page-info');
    if (pageInfoEl) {
        if (maxPage > 1) {
            pageInfoEl.classList.remove('hidden');
            pageInfoEl.textContent = `${t('memory.page_info', { page: memPage })} / ${maxPage}`;
        } else {
            pageInfoEl.classList.add('hidden');
        }
    }
    const memPrev = document.getElementById('mem-prev');
    const memNext = document.getElementById('mem-next');
    if (memPrev) memPrev.disabled = memPage <= 1;
    if (memNext) memNext.disabled = memPage >= maxPage;
    container.innerHTML = slice.map(m => {
        const ts = m.timestamp ?? m.metadata?.timestamp ?? 0;
        const fd = formatMemoryDate(ts);
        const dateTitle = (t('memory.saved_at') || 'Salvat la') + ': ' + fd.dateTime;
        const dateLine = fd.dateTime !== '—' ? `${fd.dateTime} · ${fd.age}` : (t('memory.no_date') || 'fără dată');
        return `
        <div class="mem-card group relative rounded-2xl border border-white/5 bg-white/[0.02] hover:border-white/10 transition-colors overflow-hidden">
            <div class="flex items-start gap-3 p-4">
                <input type="checkbox" class="mem-bulk-check accent-accent mt-1 w-4 h-4 rounded border-white/10 bg-white/5 flex-shrink-0" value="${escapeHtml(m.id)}" onchange="updateMemBulkCount()">
                <div class="flex-1 min-w-0">
                    <div class="mem-card-content" title="${escapeHtml(m.document)}">${escapeHtml(m.document)}</div>
                    <p class="mem-card-date text-xs text-slate-400 mt-2 flex items-center gap-1.5" title="${escapeHtml(dateTitle)}"><span class="text-slate-500">${escapeHtml(t('memory.saved_at') || 'Salvat')}:</span> ${escapeHtml(dateLine)}</p>
                </div>
                <button type="button" onclick="deleteMemBulk(['${escapeHtml(m.id)}'])" class="flex-shrink-0 p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100" title="Delete"><i class="fas fa-trash-alt text-xs"></i></button>
            </div>
        </div>`;
    }).join('');
}
export function toggleAllMem(checked) { document.querySelectorAll('.mem-bulk-check').forEach(cb => cb.checked = checked); updateMemBulkCount(); }
export function updateMemBulkCount() {
    const count = document.querySelectorAll('.mem-bulk-check:checked').length;
    const btn = document.getElementById('mem-bulk-delete-btn');
    if(btn) btn.style.display = count > 0 ? 'block' : 'none';
}
export async function deleteMemBulk(ids) {
    const targetIds = ids || Array.from(document.querySelectorAll('.mem-bulk-check:checked')).map(i => i.value);
    if(!(await showConfirm(t('memory.delete_confirm')))) return;
    await apiCall('/api/memory/bulk_delete', { method: 'POST', body: { ids: targetIds } });
    loadMemory();
}
export function changeMemPage(step) {
    const term = document.getElementById("mem-search")?.value.toLowerCase() || '';
    const filtered = memCache.filter(m => m.document.toLowerCase().includes(term));
    const maxPage = Math.max(1, Math.ceil(filtered.length / MEM_PER_PAGE));
    memPage = Math.max(1, Math.min(memPage + step, maxPage));
    renderMemoryTable();
}
export function filterMemory() { memPage = 1; renderMemoryTable(); }
export async function updateMemory(id, text) { if (!text.trim()) return; await apiCall(`/api/memory/${id}`, { method: 'PUT', body: { text: text } }); }

const _SEARCH_TENDENCY_HINTS = {
    1: 'Minimal — almost never searches. Only when you explicitly ask it to.',
    2: 'Conservative — prefers own knowledge, searches only for today\'s news/weather.',
    3: 'Balanced — searches for current events, uses knowledge for known facts.',
    4: 'Proactive — searches when not fully confident, verifies uncertain facts.',
    5: 'Aggressive — actively searches to provide the freshest information.',
};
function _updateSearchTendencyHint(val) {
    const hint = document.getElementById('search_tendency_hint');
    if (hint) hint.textContent = _SEARCH_TENDENCY_HINTS[val] || _SEARCH_TENDENCY_HINTS[3];
}

let _configAutoSaveBound = false;
let _configAutoSaveTimer = null;
let _configAutoSavePauseUntil = 0;

function _queueConfigAutoSave() {
    if (Date.now() < _configAutoSavePauseUntil) return;
    if (_configAutoSaveTimer) clearTimeout(_configAutoSaveTimer);
    _configAutoSaveTimer = setTimeout(() => {
        _configAutoSaveTimer = null;
        saveConfig({ silent: true });
    }, 320);
}

function _bindConfigAutoSaveOnce() {
    if (_configAutoSaveBound) return;
    const panels = document.getElementById('config-panels');
    if (!panels) return;
    _configAutoSaveBound = true;

    const onFieldEdit = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest('#cfg-tab-notifications')) return; // handled by dedicated notification autosave
        if (target.closest('[data-no-autosave="1"]')) return;

        if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
            _queueConfigAutoSave();
            return;
        }

        if (target.tagName === 'INPUT') {
            const type = String(target.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'file', 'hidden'].includes(type)) return;
            _queueConfigAutoSave();
        }
    };

    panels.addEventListener('input', onFieldEdit, true);
    panels.addEventListener('change', onFieldEdit, true);

    // Also listen on the integration config modal (it's outside config-panels)
    const integModal = document.getElementById('integration-config-modal');
    if (integModal) {
        integModal.addEventListener('input', onFieldEdit, true);
        integModal.addEventListener('change', onFieldEdit, true);
    }
}

export async function loadConfig() {
    _bindConfigAutoSaveOnce();
    _configAutoSavePauseUntil = Date.now() + 1500;

    const res = await apiCall('/api/config');
    const cfg = await res.json();

    const wsServiceShouldRunFromCfg = (() => {
        const fcm = cfg?.fcm || {};
        const mode = String(fcm.transport_mode || 'hybrid').toLowerCase();
        const wsEnabled = fcm.websocket_enabled !== false;
        return wsEnabled && mode !== 'firebase';
    })();
    if (window.__MEMINI_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try { window.__setNativeWsServiceEnabled(!!wsServiceShouldRunFromCfg); } catch (_) {}
    }

    const updateLoggingModeBadge = (isVerbose) => {
        const badge = document.getElementById('header-log-mode-badge');
        if (!badge) return;
        const verbose = !!isVerbose;
        badge.textContent = verbose ? 'LOG: VERBOSE' : 'LOG: COMPACT';
        badge.classList.remove(
            'border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10',
            'border-amber-500/30', 'text-amber-300', 'bg-amber-500/10'
        );
        if (verbose) {
            badge.classList.add('border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
        } else {
            badge.classList.add('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10');
        }
    };
    updateLoggingModeBadge(!!cfg.verbose_logging);

    // Limbă UI
    const uiLangSelect = document.getElementById('ui_language');
    if (uiLangSelect) {
        const opts = getAvailableLanguages();
        uiLangSelect.innerHTML = opts.map(o => `<option value="${o.code}">${o.label}</option>`).join('');
        if (cfg.ui && cfg.ui.language) uiLangSelect.value = cfg.ui.language;
    }

    if (cfg.security) {
        const wlNum = document.getElementById('wl_numbers');
        if (wlNum) wlNum.value = (cfg.security.allowed_numbers || []).join('\n');
        const secAntiInj = document.getElementById('security_anti_injection');
        if (secAntiInj) secAntiInj.checked = cfg.security.anti_injection !== false;
        const secAntiInjPrompt = document.getElementById('security_anti_injection_prompt');
        if (secAntiInjPrompt) secAntiInjPrompt.value = cfg.security.anti_injection_prompt_template || '';
        const secGuardrails = document.getElementById('security_tool_guardrails');
        if (secGuardrails) secGuardrails.checked = cfg.security.tool_guardrails !== false;
        const secRestrictUntrustedTools = document.getElementById('security_restrict_untrusted_tools');
        if (secRestrictUntrustedTools) secRestrictUntrustedTools.checked = cfg.security.restrict_mutating_tools_on_untrusted_content !== false;
    }

    const map = {
        'logging_mode': (cfg.verbose_logging ? 'verbose' : 'compact'),
        'target_url': cfg.llm?.target_url, 'model_name': cfg.llm?.model_name,
        'llm_api_key': cfg.llm?.api_key ?? '',
        'llm_provider': cfg.llm?.source ?? cfg.llm?.provider ?? 'local',
        'llm_temperature': cfg.llm?.temperature ?? 0.7,
        'llm_timeout': cfg.llm?.timeout ?? 120,
        'llm_context_length': cfg.llm?.context_length ?? 24000,
        'coder_target_url': cfg.coder?.target_url, 'coder_model_name': cfg.coder?.model_name,
        'coder_api_key': cfg.coder?.api_key ?? '',
        'coder_provider': cfg.coder?.source ?? cfg.coder?.provider ?? 'local',
        'coder_timeout': cfg.coder?.timeout ?? 180,
        'vision_llm_target_url': cfg.vision_llm?.target_url,
        'vision_llm_model_name': cfg.vision_llm?.model_name,
        'vision_llm_api_key': cfg.vision_llm?.api_key ?? '',
        'vision_llm_provider': cfg.vision_llm?.source ?? cfg.vision_llm?.provider ?? 'local',
        'vision_llm_timeout': cfg.vision_llm?.timeout ?? 60,
        'vision_llm_respond_directly': cfg.vision_llm?.respond_directly,
        'embed_model_name': cfg.librarian?.model_name,
        'waha_url': cfg.waha?.api_url, 'waha_enabled': cfg.waha?.enabled,
        'pago_enabled': cfg.pago?.enabled, 'pago_email': cfg.pago?.email, 'pago_password': cfg.pago?.password, 'pago_scan_interval': cfg.pago?.scan_interval ?? 3600,
        'fcm_enabled': cfg.fcm?.enabled,
        'fcm_project_id': cfg.fcm?.project_id,
        'fcm_service_account_path': cfg.fcm?.service_account_path,
        'ha_url': cfg.home_assistant?.url, 'ha_token': cfg.home_assistant?.token,
        'ha_device_match_priority': Array.isArray(cfg.home_assistant?.device_match_priority) ? cfg.home_assistant.device_match_priority.join(', ') : 'alias, friendly_name, entity_id',
        'ha_assist_use_bridge_agent': cfg.home_assistant?.assist_use_bridge_agent !== false,
        'p_persona': cfg.prompts?.system_persona,
        'p_agent_instructions': cfg.prompts?.agent_instructions,
        'p_agent_instructions_fallback': cfg.prompts?.agent_instructions_fallback,
        'p_agent_instruction_overrides': Array.isArray(cfg.prompts?.agent_instruction_overrides) ? cfg.prompts.agent_instruction_overrides.join('\n') : (cfg.prompts?.agent_instruction_overrides ?? ''),
        'p_agent_principles': Array.isArray(cfg.prompts?.agent_principles) ? cfg.prompts.agent_principles.join('\n') : (cfg.prompts?.agent_principles ?? ''),
        'p_search_web_single_message_instruction': cfg.prompts?.search_web_single_message_instruction ?? '',
        'p_web_content_reply_instruction': cfg.prompts?.web_content_reply_instruction ?? '',
        'p_image_placeholder': cfg.prompts?.image_placeholder ?? '',
        'p_summarize': cfg.prompts?.summarize ?? '',
        'p_conversation_too_long': cfg.prompts?.conversation_too_long ?? '',
        'p_clear_context_message': cfg.prompts?.clear_context_message ?? '',
        'config_timezone': cfg.timezone || '',
        'aux_llm_url': (cfg.intelligence?.aux_llm?.target_url ?? ''),
        'aux_llm_model': (cfg.intelligence?.aux_llm?.model_name ?? ''),
        'aux_llm_api_key': (cfg.intelligence?.aux_llm?.api_key ?? ''),
        'aux_llm_provider': (cfg.intelligence?.aux_llm?.source ?? cfg.intelligence?.aux_llm?.provider ?? 'local')
    };
    for (const [id, val] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = (val ?? '') + '';
    }
    // Normalize old "custom" to "local" (Custom option removed)
    ['llm_provider', 'coder_provider', 'aux_llm_provider', 'vision_llm_provider'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.value === 'custom') el.value = 'local';
    });

    // Infer provider from URL when source not set
    function inferSource(url) {
        if (!url || !url.trim()) return 'local';
        const u = url.toLowerCase();
        if (u.includes('api.z.ai') && u.includes('coding')) return 'z_ai';
        if (u.includes('api.z.ai')) return 'z_ai';
        if (u.includes('api.x.ai')) return 'grok';
        if (u.includes('api.deepseek.com')) return 'deepseek';
        if (u.includes('openai.com')) return 'openai';
        return 'local';
    }
    const llmProv = document.getElementById('llm_provider');
    if (llmProv && !cfg.llm?.source && !cfg.llm?.provider) llmProv.value = inferSource(cfg.llm?.target_url);
    const coderProv = document.getElementById('coder_provider');
    if (coderProv && !cfg.coder?.source && !cfg.coder?.provider) coderProv.value = inferSource(cfg.coder?.target_url);
    const auxProv = document.getElementById('aux_llm_provider');
    if (auxProv && !(cfg.intelligence?.aux_llm?.source || cfg.intelligence?.aux_llm?.provider)) auxProv.value = inferSource(cfg.intelligence?.aux_llm?.target_url);
    const visionProv = document.getElementById('vision_llm_provider');
    if (visionProv && !(cfg.vision_llm?.source || cfg.vision_llm?.provider)) visionProv.value = inferSource(cfg.vision_llm?.target_url);

    // Prefill when dropdown changes
    function applyProvider(providerId, urlId, modelId, keyRowId, isCoder) {
        const sel = document.getElementById(providerId);
        if (!sel) return;
        const urlEl = document.getElementById(urlId);
        const modelEl = document.getElementById(modelId);
        const keyRow = keyRowId ? document.getElementById(keyRowId) : null;
        // Billing link (only for main LLM provider)
        const billingLink = (providerId === 'llm_provider') ? document.getElementById('zai_billing_link') : null;
        function syncBillingLink(v) {
            if (billingLink) billingLink.classList.toggle('hidden', v !== 'z_ai');
        }
        sel.onchange = () => {
            const v = sel.value;
            syncBillingLink(v);
            if (v === 'local') {
                if (urlEl) urlEl.value = isCoder ? '' : 'http://localhost:11434/v1';
                if (modelEl) modelEl.value = '';
                if (keyRow) keyRow.style.display = 'none';
            } else {
                if (keyRow) keyRow.style.display = '';
                if (v === 'z_ai') {
                    if (urlEl) urlEl.value = isCoder ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4';
                    if (modelEl) modelEl.value = 'glm-5';
                } else if (v === 'grok') {
                    if (urlEl) urlEl.value = 'https://api.x.ai/v1/chat/completions';
                    if (modelEl && !modelEl.value.trim()) modelEl.value = 'grok-4-1-fast-reasoning';
                } else if (v === 'deepseek') {
                    if (urlEl) urlEl.value = 'https://api.deepseek.com/chat/completions';
                    if (modelEl && !modelEl.value.trim()) modelEl.value = 'deepseek-chat';
                } else if (v === 'openai') {
                    if (urlEl) urlEl.value = 'https://api.openai.com/v1';
                    if (modelEl && !modelEl.value.trim()) modelEl.value = 'gpt-4o';
                }
            }
        };
        // Initial visibility for API key row
        if (keyRow) keyRow.style.display = (sel.value === 'local') ? 'none' : '';
        syncBillingLink(sel.value);
    }
    applyProvider('llm_provider', 'target_url', 'model_name', 'llm_api_key_row', false);
    applyProvider('coder_provider', 'coder_target_url', 'coder_model_name', 'coder_api_key_row', true);
    applyProvider('aux_llm_provider', 'aux_llm_url', 'aux_llm_model', 'aux_llm_api_key_row', false);
    applyProvider('vision_llm_provider', 'vision_llm_target_url', 'vision_llm_model_name', 'vision_llm_api_key_row', false);

    const m = cfg.memory || {};
    const parseListToText = (arr) => Array.isArray(arr) ? arr.join('\n') : '';
    const intelMw = document.getElementById('intel_working_window');
    const intelMs = document.getElementById('intel_summarize_every');
    if (intelMw) intelMw.value = m.working_window ?? 12;
    if (intelMs) intelMs.value = m.summarize_every ?? 8;
    const mFactSim = document.getElementById('memory_fact_similarity');
    if (mFactSim) mFactSim.value = m.fact_similarity_threshold ?? 0.45;
    const mExtractionTimeout = document.getElementById('memory_extraction_timeout');
    const mExtractionInputMaxChars = document.getElementById('memory_extraction_input_max_chars');
    const mExtractionMaxTokensFull = document.getElementById('memory_extraction_max_tokens_full');
    const mExtractionMaxLines = document.getElementById('memory_extraction_max_lines');
    if (mExtractionTimeout) mExtractionTimeout.value = m.extraction_timeout ?? (cfg.llm?.timeout ?? 120);
    if (mExtractionInputMaxChars) mExtractionInputMaxChars.value = m.extraction_input_max_chars ?? 900;
    if (mExtractionMaxTokensFull) mExtractionMaxTokensFull.value = m.extraction_max_tokens_full ?? 800;
    if (mExtractionMaxLines) mExtractionMaxLines.value = m.extraction_max_lines ?? 2;

    // Logging mode (live toggle)
    const loggingModeEl = document.getElementById('logging_mode');
    if (loggingModeEl && !loggingModeEl.dataset.bound) {
        loggingModeEl.dataset.bound = '1';
        loggingModeEl.addEventListener('change', async () => {
            updateLoggingModeBadge(loggingModeEl.value === 'verbose');
            try {
                await saveConfig();
            } catch (e) { /* handled in saveConfig via toast/error path */ }
        });
    }

    // Memory: extraction examples (few-shot)
    renderExtractionExamples(m.extraction_examples || []);

    // Intelligence: consolidation
    const consolidation = (cfg.intelligence || {}).consolidation || {};
    const cEn = document.getElementById('consolidation_enabled');
    const cTime = document.getElementById('consolidation_time');
    const cInterval = document.getElementById('consolidation_interval');
    const cThr = document.getElementById('consolidation_threshold');
    if (cEn) cEn.checked = !!consolidation.enabled;
    if (cTime) cTime.value = consolidation.time || '03:00';
    if (cInterval) cInterval.value = consolidation.interval || 'daily';
    if (cThr) cThr.value = consolidation.similarity_threshold ?? 0.92;
    const cSessionTrig = document.getElementById('consolidation_session_trigger_messages');
    const cCompression = document.getElementById('consolidation_compression_ratio');
    const cHistoryPath = document.getElementById('consolidation_history_log_path');
    if (cSessionTrig) cSessionTrig.value = consolidation.session_trigger_messages ?? 80;
    if (cCompression) cCompression.value = consolidation.compression_ratio ?? 0.15;
    if (cHistoryPath) cHistoryPath.value = consolidation.history_log_path || 'history_log.md';

    // Daily news
    // Daily news config removed — now handled by skills/daily_news.py

    // Intelligence: Agent config
    const intel = cfg.intelligence || {};
    const maxAgentTurnsEl = document.getElementById('max_agent_turns');
    if (maxAgentTurnsEl) maxAgentTurnsEl.value = intel.max_agent_turns ?? 10;
    const postRespConcEl = document.getElementById('post_response_concurrency');
    if (postRespConcEl) postRespConcEl.value = intel.post_response_concurrency ?? 1;
    const injectFactsEl = document.getElementById('inject_relevant_facts');
    const richerResultsEl = document.getElementById('richer_tool_results');
    if (injectFactsEl) injectFactsEl.checked = !!intel.inject_relevant_facts;
    if (richerResultsEl) richerResultsEl.checked = !!intel.richer_tool_results;
    const lazyHistEl = document.getElementById('intel_lazy_history');
    if (lazyHistEl) lazyHistEl.checked = intel.lazy_history !== false;  // default true

    // Intelligence: Knowledge cutoff
    const iFreshCut = document.getElementById('intel_knowledge_cutoff');
    if (iFreshCut) iFreshCut.value = intel.knowledge_cutoff ?? '2024-01';

    // Intelligence: Search tendency slider
    const searchTendencyEl = document.getElementById('intel_search_tendency');
    if (searchTendencyEl) {
        searchTendencyEl.value = intel.search_tendency ?? 3;
        _updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        searchTendencyEl.addEventListener('input', () => {
            _updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        });
    }

    // Intelligence: Search context (use previous message in web search query)
    const searchUseCtx = document.getElementById('search_use_conversation_context');
    const searchCtxThreshold = document.getElementById('search_context_similarity_threshold');
    if (searchUseCtx) searchUseCtx.checked = !!intel.search_use_conversation_context;
    if (searchCtxThreshold) searchCtxThreshold.value = intel.search_context_similarity_threshold ?? 0.55;

    // Intelligence: Shell & Tool calling
    const shell = intel.shell || {};
    const shellEn = document.getElementById('shell_enabled');
    const shellAllowed = document.getElementById('shell_allowed_commands');
    const shellBlocked = document.getElementById('shell_blocked_patterns');
    const shellMaxOut = document.getElementById('shell_max_output_chars');
    const shellTimeout = document.getElementById('shell_timeout_seconds');
    const shellRate = document.getElementById('shell_rate_limit');
    if (shellEn) shellEn.checked = shell.enabled !== false;
    if (shellAllowed) shellAllowed.value = Array.isArray(shell.allowed_commands) ? shell.allowed_commands.join('\n') : '';
    if (shellBlocked) shellBlocked.value = Array.isArray(shell.blocked_patterns) ? shell.blocked_patterns.join('\n') : '';
    if (shellMaxOut) shellMaxOut.value = shell.max_output_chars ?? 8000;
    if (shellTimeout) shellTimeout.value = shell.timeout_seconds ?? 15;
    if (shellRate) shellRate.value = shell.rate_limit_per_minute ?? 5;

    const fileRead = intel.file_read || {};
    const frEn = document.getElementById('file_read_enabled');
    const frMaxBytes = document.getElementById('file_read_max_bytes');
    const frRate = document.getElementById('file_read_rate_limit');
    if (frEn) frEn.checked = fileRead.enabled !== false;
    if (frMaxBytes) frMaxBytes.value = fileRead.max_bytes ?? 51200;
    if (frRate) frRate.value = fileRead.rate_limit_per_minute ?? 10;

    const runScript = intel.run_script || {};
    const rsEn = document.getElementById('run_script_enabled');
    const rsTimeout = document.getElementById('run_script_timeout');
    const rsMaxOut = document.getElementById('run_script_max_output');
    const rsRate = document.getElementById('run_script_rate_limit');
    if (rsEn) rsEn.checked = runScript.enabled !== false;
    if (rsTimeout) rsTimeout.value = runScript.timeout_seconds ?? 15;
    if (rsMaxOut) rsMaxOut.value = runScript.max_output_chars ?? 20000;
    if (rsRate) rsRate.value = runScript.rate_limit_per_minute ?? 3;

    const proposePatch = intel.propose_patch || {};
    const ppEn = document.getElementById('propose_patch_enabled');
    const ppDirs = document.getElementById('propose_patch_allowed_dirs');
    if (ppEn) ppEn.checked = proposePatch.enabled !== false;
    if (ppDirs) ppDirs.value = Array.isArray(proposePatch.allowed_dirs) ? proposePatch.allowed_dirs.join(', ') : 'scripts, docs, ai_suggestions';

    // Librarian (memory recall) – loaded from cfg.librarian
    const lib = cfg.librarian || {};
    const iRetLimit = document.getElementById('intel_retrieval_limit');
    const iMemDist = document.getElementById('intel_memory_relevance_max_distance');
    if (iRetLimit) iRetLimit.value = lib.retrieval_limit ?? 5;
    if (iMemDist) iMemDist.value = lib.memory_relevance_max_distance != null ? lib.memory_relevance_max_distance : '';

    // SearXNG
    const searxng = cfg.searxng || {};
    const sxEn = document.getElementById('searxng_enabled');
    const sxUrl = document.getElementById('searxng_url');
    if (sxEn) sxEn.checked = !!searxng.enabled;
    if (sxUrl) sxUrl.value = searxng.url || '';
    const sxFetch = document.getElementById('searxng_fetch_pages');
    const sxMaxPages = document.getElementById('searxng_max_pages');
    const sxMaxResults = document.getElementById('searxng_max_results');
    const sxSearchTimeout = document.getElementById('searxng_search_timeout');
    const sxMaxSearchesPerRequest = document.getElementById('searxng_max_searches_per_request');
    if (sxFetch) sxFetch.checked = searxng.fetch_pages !== false;
    if (sxMaxPages) sxMaxPages.value = Math.min(3, Math.max(0, parseInt(searxng.max_pages_to_fetch, 10) || 2));
    if (sxMaxResults) sxMaxResults.value = searxng.max_search_results ?? 5;
    if (sxSearchTimeout) sxSearchTimeout.value = searxng.search_timeout ?? 10;
    if (sxMaxSearchesPerRequest) sxMaxSearchesPerRequest.value = Math.min(20, Math.max(1, parseInt(searxng.max_searches_per_request, 10) || 5));

    if (sxUrl) sxUrl.addEventListener('input', () => {}); // reserved: update freshness-related UI if needed

    // CCTV
    const cctvCfg = cfg.cctv || {};
    const cctvEnEl = document.getElementById('cctv_enabled');
    if (cctvEnEl) cctvEnEl.checked = !!cctvCfg.enabled;
    renderCctvCameras(cctvCfg.cameras || []);

    // Whisper
    const whisperCfg = cfg.whisper || {};
    const whisperEnEl = document.getElementById('whisper_enabled');
    if (whisperEnEl) whisperEnEl.checked = !!whisperCfg.enabled;
    const whisperHostEl = document.getElementById('whisper_host');
    const whisperPortEl = document.getElementById('whisper_port');
    const whisperLangEl = document.getElementById('whisper_language');
    if (whisperHostEl) whisperHostEl.value = whisperCfg.host || 'localhost';
    if (whisperPortEl) whisperPortEl.value = whisperCfg.port || 10300;
    if (whisperLangEl) whisperLangEl.value = whisperCfg.language || 'ro';
    const whisperVadMsEl = document.getElementById('whisper_vad_silence_ms');
    const whisperVadSensEl = document.getElementById('whisper_vad_sensitivity');
    if (whisperVadMsEl) whisperVadMsEl.value = whisperCfg.vad_silence_ms || 2500;
    if (whisperVadSensEl) whisperVadSensEl.value = whisperCfg.vad_sensitivity || 'medium';

    // Piper
    const piperCfg = cfg.piper || {};
    const piperEnEl = document.getElementById('piper_enabled');
    if (piperEnEl) piperEnEl.checked = !!piperCfg.enabled;
    const piperAlwaysSpeakEl = document.getElementById('piper_always_speak');
    if (piperAlwaysSpeakEl) piperAlwaysSpeakEl.checked = !!piperCfg.always_speak;
    // Sync runtime flag
    if (window.__tts) window.__tts.alwaysSpeak = !!piperCfg.always_speak;

    // ComfyUI
    const comfyuiCfg = cfg.comfyui || {};
    const comfyEnEl = document.getElementById('comfyui_enabled');
    if (comfyEnEl) comfyEnEl.checked = !!comfyuiCfg.enabled;
    const comfyFields = {
        'comfyui_url': comfyuiCfg.url || 'http://localhost:8188',
        'comfyui_checkpoint': comfyuiCfg.default_checkpoint || '',
        'comfyui_steps': comfyuiCfg.default_steps ?? 20,
        'comfyui_cfg': comfyuiCfg.default_cfg_scale ?? 7,
        'comfyui_width': comfyuiCfg.default_width ?? 1024,
        'comfyui_height': comfyuiCfg.default_height ?? 1024,
        'comfyui_sampler': comfyuiCfg.default_sampler || 'euler',
        'comfyui_scheduler': comfyuiCfg.default_scheduler || 'normal',
        'comfyui_timeout': comfyuiCfg.timeout ?? 120,
        'comfyui_negative': comfyuiCfg.default_negative_prompt || '',
        'comfyui_workflow_file': comfyuiCfg.workflow_file || '',
    };
    for (const [id, val] of Object.entries(comfyFields)) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }
    // Load workflow list on init
    if (comfyuiCfg.workflow_file) {
        refreshComfyUIWorkflows().catch(() => {});
    }
    // Webhook WAHA (nu se salvează, doar se afișează)
    const wh = document.getElementById('waha_webhook');
    if (wh && typeof window !== 'undefined') {
        wh.value = `${window.location.origin}/api/webhook/waha`;
    }



    // Integrări + restricții non-admin: whitelist per user, ascundere Models/HA/WhatsApp config/Prompts
    try {
        const meRes = await apiCall('/api/users/me');
        if (!meRes.ok) return;
        const profile = await meRes.json();
        window.__isAdmin = profile.is_admin;
        const isAdmin = profile.is_admin;

        document.querySelectorAll('.config-admin-only').forEach(el => {
            if (el.id && el.id.startsWith('cfg-tab-')) return;
            el.classList.toggle('hidden', !isAdmin);
        });
        const personaUser = document.getElementById('cfg-general-persona-user');
        const userPersona = document.getElementById('user_persona');
        if (personaUser && userPersona) {
            personaUser.classList.toggle('hidden', isAdmin);
            userPersona.value = profile.persona || '';
        }

        const adminBlock = document.getElementById('integrations-whitelist-admin');
        const userBlock = document.getElementById('integrations-whitelist-user');
        const addInput = document.getElementById('user-phone-add');
        const addBtn = document.getElementById('user-phone-add-btn');
        if (adminBlock && userBlock) {
            if (isAdmin) {
                adminBlock.classList.remove('hidden');
                userBlock.classList.add('hidden');
            } else {
                adminBlock.classList.add('hidden');
                userBlock.classList.remove('hidden');
                renderUserPhonesList(profile.phones || []);
                if (addBtn && addInput) {
                    addBtn.onclick = () => addUserPhone(addInput.value.trim(), addInput);
                }
            }
        }
        syncIntegrationToggles();
        bindIntegrationToggleButtonsOnce();
    } catch (e) { /* not logged in or error */ }

    _configAutoSavePauseUntil = Date.now() + 350;
}

function syncIntegrationToggles() {
    const sx = document.getElementById('searxng_enabled');
    const sxDis = document.getElementById('searxng-btn-disable');
    const sxEn = document.getElementById('searxng-btn-enable');
    if (sx && sxDis && sxEn) {
        const on = !!sx.checked;
        sxDis.classList.toggle('hidden', !on);
        sxEn.classList.toggle('hidden', on);
    }
    const wa = document.getElementById('waha_enabled');
    const waDis = document.getElementById('waha-btn-disable');
    const waEn = document.getElementById('waha-btn-enable');
    if (wa && waDis && waEn) {
        const on = !!wa.checked;
        waDis.classList.toggle('hidden', !on);
        waEn.classList.toggle('hidden', on);
    }
    const cctv = document.getElementById('cctv_enabled');
    const cctvDis = document.getElementById('cctv-btn-disable');
    const cctvEn = document.getElementById('cctv-btn-enable');
    if (cctv && cctvDis && cctvEn) {
        const on = !!cctv.checked;
        cctvDis.classList.toggle('hidden', !on);
        cctvEn.classList.toggle('hidden', on);
    }
    const wh = document.getElementById('whisper_enabled');
    const whDis = document.getElementById('whisper-btn-disable');
    const whEns = document.getElementById('whisper-btn-enable');
    if (wh && whDis && whEns) {
        const on = !!wh.checked;
        whDis.classList.toggle('hidden', !on);
        whEns.classList.toggle('hidden', on);
    }
    const comfy = document.getElementById('comfyui_enabled');
    const comfyDis = document.getElementById('comfyui-btn-disable');
    const comfyEn = document.getElementById('comfyui-btn-enable');
    if (comfy && comfyDis && comfyEn) {
        const on = !!comfy.checked;
        comfyDis.classList.toggle('hidden', !on);
        comfyEn.classList.toggle('hidden', on);
    }
    const pip = document.getElementById('piper_enabled');
    const pipDis = document.getElementById('piper-btn-disable');
    const pipEn = document.getElementById('piper-btn-enable');
    if (pip && pipDis && pipEn) {
        const on = !!pip.checked;
        pipDis.classList.toggle('hidden', !on);
        pipEn.classList.toggle('hidden', on);
    }
    const pago = document.getElementById('pago_enabled');
    const pagoDis = document.getElementById('pago-btn-disable');
    const pagoEn = document.getElementById('pago-btn-enable');
    if (pago && pagoDis && pagoEn) {
        const on = !!pago.checked;
        pagoDis.classList.toggle('hidden', !on);
        pagoEn.classList.toggle('hidden', on);
    }
    // Show/hide speak buttons depending on piper enabled
    const anyTtsOn = !!(pip && pip.checked);
    document.querySelectorAll('.chat-speak-btn').forEach(btn => {
        btn.classList.toggle('hidden', !anyTtsOn);
    });
    // Show/hide always-speak button depending on piper enabled
    const alwaysSpeakBtn = document.getElementById('btn-always-speak');
    if (alwaysSpeakBtn) alwaysSpeakBtn.classList.toggle('hidden', !anyTtsOn);
    // Show/hide voice button depending on whisper enabled
    const voiceBtn = document.getElementById('btn-voice');
    if (voiceBtn) {
        const whisperEnabled = !!(wh && wh.checked);
        voiceBtn.classList.toggle('hidden', !whisperEnabled);
        if (!whisperEnabled) {
            if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
                try { _voiceMediaRecorder.stop(); } catch (e) {}
            }
            if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
            if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
            if (_voiceStream) {
                _voiceStream.getTracks().forEach(t => t.stop());
                _voiceStream = null;
            }
            voiceBtn.disabled = false;
            voiceBtn.classList.remove('recording');
            const icon = voiceBtn.querySelector('i');
            if (icon) icon.className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
    }
    updateIntegrationSubtab();
}

// ---------------------------------------------------------------------------
// Integration sub-tabs: Active / Available
// ---------------------------------------------------------------------------
let _activeIntegrationSubtab = 'active';

window.switchIntegrationSubtab = function(tab) {
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

function updateIntegrationSubtab() {
    const tab = _activeIntegrationSubtab;
    // Map: integration slug → enabled state (HA is always active)
    const enabledMap = {
        ha:       true,
        waha:     !!document.getElementById('waha_enabled')?.checked,
        searxng:  !!document.getElementById('searxng_enabled')?.checked,
        cctv:     !!document.getElementById('cctv_enabled')?.checked,
        comfyui:  !!document.getElementById('comfyui_enabled')?.checked,
        whisper:  !!document.getElementById('whisper_enabled')?.checked,
        piper:    !!document.getElementById('piper_enabled')?.checked,
        pago:     !!document.getElementById('pago_enabled')?.checked,
    };
    let visibleCount = 0;
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        const isEnabled = enabledMap[slug] ?? false;
        const show = tab === 'active' ? isEnabled : !isEnabled;
        row.classList.toggle('hidden', !show);
        if (show) visibleCount++;
    });
    const emptyEl = document.getElementById('int-subtab-empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0);
    // Update count badges
    const activeCount   = Object.values(enabledMap).filter(Boolean).length;
    const availableCount = Object.keys(enabledMap).length - activeCount;
    const ac = document.getElementById('int-subtab-active-count');
    const avc = document.getElementById('int-subtab-available-count');
    if (ac) ac.textContent = activeCount > 0 ? `(${activeCount})` : '';
    if (avc) avc.textContent = availableCount > 0 ? `(${availableCount})` : '';
}

// --- ComfyUI helpers ---

window.testComfyUIConnection = async function() {
    const resultEl = document.getElementById('comfyui-test-result');
    if (!resultEl) return;
    resultEl.className = 'text-xs rounded-xl p-3 bg-slate-800 text-slate-400';
    resultEl.textContent = 'Connecting…';
    resultEl.classList.remove('hidden');
    try {
        const urlVal = (document.getElementById('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/test${qs}`);
        const data = await res.json();
        if (data.ok) {
            const stats = data.system_stats || {};
            const gpu = stats.devices?.[0]?.name || 'Unknown';
            const vram = stats.devices?.[0]?.vram_total ? `${(stats.devices[0].vram_total / (1024**3)).toFixed(1)} GB VRAM` : '';
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
            resultEl.textContent = `✓ Connected! GPU: ${gpu}${vram ? ' — ' + vram : ''}`;
        } else {
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
            resultEl.textContent = `✗ ${data.error || 'Connection failed'}`;
        }
    } catch (e) {
        resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
        resultEl.textContent = `✗ ${e.message || 'Request failed'}`;
    }
};

window.refreshComfyUICheckpoints = async function() {
    const select = document.getElementById('comfyui_checkpoint');
    if (!select) return;
    const current = select.value;
    try {
        const urlVal = (document.getElementById('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/checkpoints${qs}`);
        const data = await res.json();
        const checkpoints = data.checkpoints || [];
        select.innerHTML = '<option value="">— selectează —</option>';
        for (const ckpt of checkpoints) {
            const opt = document.createElement('option');
            opt.value = ckpt;
            opt.textContent = ckpt;
            select.appendChild(opt);
        }
        if (current && checkpoints.includes(current)) select.value = current;
        if (checkpoints.length) showToast(`${checkpoints.length} checkpoints found`, 'success');
        else showToast('No checkpoints found', 'warning');
    } catch (e) {
        showToast('Failed to fetch checkpoints: ' + (e.message || e), 'error');
    }
};

window.refreshComfyUIWorkflows = async function() {
    const select = document.getElementById('comfyui_workflow_file');
    if (!select) return;
    const current = select.value;
    try {
        const res = await apiCall('/api/comfyui/workflows');
        const data = await res.json();
        const workflows = data.workflows || [];
        select.innerHTML = '<option value="">— none (auto-detect) —</option>';
        for (const wf of workflows) {
            const opt = document.createElement('option');
            opt.value = `comfyui_workflows/${wf.file}`;
            opt.textContent = wf.name;
            select.appendChild(opt);
        }
        if (current) select.value = current;
        if (workflows.length) showToast(`${workflows.length} workflow(s) found`, 'success');
        else showToast('No workflow templates found. Upload one from ComfyUI.', 'info');
    } catch (e) {
        showToast('Failed to fetch workflows: ' + (e.message || e), 'error');
    }
};

window.uploadComfyUIWorkflow = async function(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/comfyui/workflows/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${window._authToken || ''}` },
            body: formData,
        });
        const data = await res.json();
        if (data.ok) {
            showToast(`Workflow uploaded: ${data.file}`, 'success');
            await refreshComfyUIWorkflows();
            // Auto-select the uploaded workflow
            const select = document.getElementById('comfyui_workflow_file');
            if (select) select.value = `comfyui_workflows/${data.file}`;
        } else {
            showToast('Upload failed: ' + (data.error || 'unknown error'), 'error');
        }
    } catch (e) {
        showToast('Upload failed: ' + (e.message || e), 'error');
    }
    input.value = ''; // reset file input
};

let _integrationToggleButtonsBound = false;
function bindIntegrationToggleButtonsOnce() {
    if (_integrationToggleButtonsBound) return;
    _integrationToggleButtonsBound = true;
    const wrapSx = document.getElementById('searxng-toggle-wrap');
    const wrapWa = document.getElementById('integrations-waha-enabled-wrap');
    const wrapCctv = document.getElementById('cctv-toggle-wrap');
    wrapSx?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const sx = document.getElementById('searxng_enabled');
        if (!sx) return;
        if (btn.id === 'searxng-btn-enable') { sx.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'searxng-btn-disable') { sx.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    wrapWa?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const wa = document.getElementById('waha_enabled');
        if (!wa) return;
        if (btn.id === 'waha-btn-enable') { wa.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'waha-btn-disable') { wa.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    wrapCctv?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const cctv = document.getElementById('cctv_enabled');
        if (!cctv) return;
        if (btn.id === 'cctv-btn-enable') { cctv.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'cctv-btn-disable') { cctv.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    const wrapWh = document.getElementById('whisper-toggle-wrap');
    wrapWh?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const wh = document.getElementById('whisper_enabled');
        if (!wh) return;
        if (btn.id === 'whisper-btn-enable') { wh.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'whisper-btn-disable') { wh.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    const wrapComfy = document.getElementById('comfyui-toggle-wrap');
    wrapComfy?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const comfy = document.getElementById('comfyui_enabled');
        if (!comfy) return;
        if (btn.id === 'comfyui-btn-enable') { comfy.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'comfyui-btn-disable') { comfy.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    const wrapPiper = document.getElementById('piper-toggle-wrap');
    wrapPiper?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const pip = document.getElementById('piper_enabled');
        if (!pip) return;
        if (btn.id === 'piper-btn-enable') { pip.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'piper-btn-disable') { pip.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    const wrapPago = document.getElementById('pago-toggle-wrap');
    wrapPago?.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn) return;
        const pago = document.getElementById('pago_enabled');
        if (!pago) return;
        if (btn.id === 'pago-btn-enable') { pago.checked = true; syncIntegrationToggles(); saveConfig(); }
        if (btn.id === 'pago-btn-disable') { pago.checked = false; syncIntegrationToggles(); saveConfig(); }
    });
    const addCamBtn = document.getElementById('cctv-add-camera');
    if (addCamBtn) addCamBtn.addEventListener('click', addCctvCameraRow);
}

function slugForId(s) {
    if (!s || typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || '';
}

function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function addCctvCameraRow(camera) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    const name = (camera && camera.name) || '';
    const rtsp = (camera && camera.rtsp_url) || '';
    const context = (camera && camera.context) || '';
    const id = (camera && camera.id) || '';
    const ctxPlaceholder = t('config.cctv_camera_context') || 'e.g. 2 cars, one green one white';
    const row = document.createElement('div');
    row.className = 'cctv-camera-row flex flex-wrap gap-2 p-3 rounded-xl bg-slate-900/50 border border-white/5';
    row.innerHTML = `
        <input type="text" class="cctv-cam-name flex-1 min-w-[100px] bg-slate-900 border border-white/5 rounded-lg p-2 text-xs text-slate-300 focus:border-violet-400 outline-none" placeholder="${escapeHtmlAttr(t('config.cctv_camera_name') || 'Name')}" value="${escapeHtmlAttr(name)}">
        <input type="text" class="cctv-cam-rtsp flex-1 min-w-[120px] bg-slate-900 border border-white/5 rounded-lg p-2 text-xs mono text-slate-400 focus:border-violet-400 outline-none" placeholder="rtsp://..." value="${escapeHtmlAttr(rtsp)}">
        <input type="text" class="cctv-cam-context w-full min-w-0 bg-slate-900 border border-white/5 rounded-lg p-2 text-xs text-slate-400 focus:border-violet-400 outline-none" placeholder="${escapeHtmlAttr(ctxPlaceholder)}" value="${escapeHtmlAttr(context)}" title="${escapeHtmlAttr(t('config.cctv_camera_context_hint') || 'Expected scene; model will flag if something does not match')}">
        <button type="button" class="cctv-cam-remove px-2 py-1.5 rounded-lg text-[10px] text-red-400 hover:bg-red-500/20 border border-red-500/20 shrink-0" data-i18n="common.delete">Delete</button>
    `;
    if (id) row.dataset.cctvId = id;
    list.appendChild(row);
    const removeBtn = row.querySelector('.cctv-cam-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => row.remove());
}

function renderCctvCameras(cameras) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    list.innerHTML = '';
    (cameras || []).forEach(cam => addCctvCameraRow(cam));
}

function renderUserPhonesList(phones) {
    const listEl = document.getElementById('user-phones-list');
    if (!listEl) return;
    if (!phones.length) {
        listEl.innerHTML = `<span class="text-slate-500 text-[11px]">—</span>`;
        return;
    }
    listEl.innerHTML = phones.map(num => {
        const safeNum = escapeHtml(num);
        const escNum = num.replace(/'/g, "\\'");
        return `
        <div class="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg bg-white/[0.02] border border-white/5">
            <span class="mono text-slate-300">${safeNum}</span>
            <button type="button" onclick="unlinkUserPhone('${escNum}')" class="text-[10px] text-red-400 hover:bg-red-500/20 px-2 py-0.5 rounded">${t('common.delete')}</button>
        </div>`;
    }).join('');
}

export async function addUserPhone(phone, inputEl) {
    if (!phone) return;
    try {
        const res = await apiCall('/api/users/link-whatsapp', { method: 'POST', body: { phone_number: phone } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Error', 'error');
            return;
        }
        if (inputEl) inputEl.value = '';
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    } catch (e) { showToast('Error', 'error'); }
}

export async function unlinkUserPhone(number) {
    if (!number || !(await showConfirm(t('config.unlink_phone_confirm')))) return;
    try {
        const res = await apiCall('/api/users/me/phones/unlink', { method: 'POST', body: { number } });
        if (!res.ok) throw new Error();
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    } catch (e) { showToast('Error', 'error'); }
}

// ─── MODEL PROFILES ─────────────────────────────────────────────────
let _modelProfiles = [];
let _activeProfileId = '';
let _defaultProfileId = '';  // per-user default (selector); active_id is global for admin

export async function loadModelProfiles() {
    try {
        const res = await apiCall('/api/model-profiles');
        if (!res.ok) return;
        const data = await res.json();
        _modelProfiles = data.profiles || [];
        _activeProfileId = data.active_id || '';
        _defaultProfileId = data.default_profile_id || '';
        renderProfilesList();
        renderModelSelector(data);
        renderAutoRouterStats(data.auto_router_stats);
    } catch (e) { console.warn('loadModelProfiles error', e); }
}

function renderAutoRouterStats(stats) {
    const el = document.getElementById('auto-router-stats');
    if (!el) return;
    if (!stats || typeof stats.local !== 'number' || typeof stats.api !== 'number') {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    const label = typeof t === 'function' ? t('config.auto_router_stats_label') : 'Auto (this session):';
    el.innerHTML = `${label} <span class="text-slate-400">${stats.local} local</span>, <span class="text-slate-400">${stats.api} API</span>`;
}

function renderProfilesList() {
    const container = document.getElementById('model-profiles-list');
    if (!container) return;
    if (!_modelProfiles.length) {
        container.innerHTML = '<p class="text-[10px] text-slate-600 col-span-2 text-center py-4">Niciun profil salvat. Creează un profil pentru comutare rapidă.</p>';
        return;
    }
    container.innerHTML = _modelProfiles.map((p, index) => {
        const visible = p.visible_in_selector !== false;
        const providerLabel = { local: 'Local', z_ai: 'Z.AI', openai: 'OpenAI', grok: 'Grok', deepseek: 'DeepSeek' }[p.provider] || p.provider;
        const auxBadge = p.aux_llm_enabled ? '<span class="inline-flex items-center text-[9px] bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded-full ml-1">AUX</span>' : '';
        const coderBadge = p.coder_enabled ? '<span class="inline-flex items-center text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded-full ml-0.5">COD</span>' : '';
        const visionBadge = p.vision_enabled ? '<span class="inline-flex items-center text-[9px] bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded-full ml-0.5">VIS</span>' : '';
        const embedBadge = p.embed_enabled ? '<span class="inline-flex items-center text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded-full ml-0.5">EMB</span>' : '';
        const personaOverrideBadge = (p.persona_override || '').trim() ? '<span class="inline-flex items-center gap-0.5 text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded-full ml-0.5" title="' + (typeof t === 'function' ? t('config.profile_persona_override_badge_title') : 'Override prompt activ') + '"><i class="fas fa-file-alt text-[8px]"></i><span>' + (typeof t === 'function' ? t('config.profile_prompt_override_pill') : 'Prompt') + '</span></span>' : '';
        const inSelectorClass = visible ? ' profile-card-in-selector' : '';
        const reasoning = p.capability_reasoning !== false;
        const tools = p.capability_tool_calling !== false;
        const vision = p.capability_vision !== false;
        const capIcons = [reasoning && '<i class="fas fa-brain profile-cap-icon" title="Reasoning"></i>', tools && '<i class="fas fa-wrench profile-cap-icon" title="Tool calling"></i>', vision && '<i class="fas fa-eye profile-cap-icon" title="Vision"></i>'].filter(Boolean).join('');
        const canMoveUp = index > 0;
        const canMoveDown = index < _modelProfiles.length - 1;
        const moveUpTitle = typeof t === 'function' ? t('config.profile_move_up') : 'Sus';
        const moveDownTitle = typeof t === 'function' ? t('config.profile_move_down') : 'Jos';
        const orderBtns = `<span class="profile-card-order-btns">
            ${canMoveUp ? `<button type="button" class="profile-card-order-btn" onclick="moveProfileOrder('${escapeHtml(p.id)}', 'up'); event.stopPropagation();" title="${moveUpTitle}" aria-label="${moveUpTitle}"><i class="fas fa-chevron-up"></i></button>` : '<span class="profile-card-order-btn profile-card-order-btn-disabled" aria-hidden="true"><i class="fas fa-chevron-up"></i></span>'}
            ${canMoveDown ? `<button type="button" class="profile-card-order-btn" onclick="moveProfileOrder('${escapeHtml(p.id)}', 'down'); event.stopPropagation();" title="${moveDownTitle}" aria-label="${moveDownTitle}"><i class="fas fa-chevron-down"></i></button>` : '<span class="profile-card-order-btn profile-card-order-btn-disabled" aria-hidden="true"><i class="fas fa-chevron-down"></i></span>'}
        </span>`;
        return `
            <div class="profile-card${inSelectorClass}" data-profile-id="${escapeHtml(p.id)}">
                <span class="profile-card-drag-handle" draggable="true" data-profile-id="${escapeHtml(p.id)}" title="${typeof t === 'function' ? t('config.profile_drag_reorder') : 'Mută pentru a reordona'}"><i class="fas fa-grip-vertical"></i></span>
                ${orderBtns}
                <div class="profile-card-dot" style="background:${escapeHtml(p.color || '#6366f1')}"></div>
                <div class="profile-card-info">
                    <div class="profile-card-name">${escapeHtml(p.name)}${auxBadge}${coderBadge}${visionBadge}${embedBadge}${personaOverrideBadge}</div>
                    <div class="profile-card-meta"><span class="profile-card-meta-text">${escapeHtml(providerLabel)} · ${escapeHtml(p.model_name || '?')}</span>${capIcons ? `<span class="profile-card-caps">${capIcons}</span>` : ''}</div>
                </div>
                <button type="button" class="profile-card-activate" onclick="openProfileCardMenu('${escapeHtml(p.id)}', event)">${typeof t === 'function' ? t('config.profile_options_btn') : 'Opțiuni'}</button>
            </div>`;
    }).join('');
    bindProfileCardDragDrop(container);
}

window.moveProfileOrder = async function(profileId, direction) {
    const ids = _modelProfiles.map(p => p.id);
    const idx = ids.indexOf(profileId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ids.length) return;
    const reordered = [...ids];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    try {
        const res = await apiCall('/api/model-profiles/reorder', { method: 'POST', body: { order: reordered } });
        if (!res.ok) throw new Error();
        showToast(typeof t === 'function' ? t('config.profile_order_saved') : 'Ordine salvată', 'success');
        await loadModelProfiles();
    } catch (err) {
        showToast(typeof t === 'function' ? t('config.profile_order_error') : 'Eroare la salvare ordine', 'error');
    }
};

function bindProfileCardDragDrop(container) {
    if (!container || container.dataset.dragBound === '1') return;
    container.dataset.dragBound = '1';
    let draggedId = null;
    container.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.profile-card-drag-handle');
        if (!handle) return;
        const id = handle.getAttribute('data-profile-id');
        if (!id) return;
        draggedId = id;
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        const card = handle.closest('.profile-card');
        if (card) card.classList.add('dragging');
    });
    container.addEventListener('dragend', (e) => {
        if (e.target.closest('.profile-card-drag-handle')) {
            container.querySelectorAll('.profile-card').forEach(el => el.classList.remove('dragging', 'drag-over'));
        }
        draggedId = null;
    });
    container.addEventListener('dragover', (e) => {
        const card = e.target.closest('.profile-card');
        if (!card || !draggedId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
    });
    container.addEventListener('dragleave', (e) => {
        const card = e.target.closest('.profile-card');
        if (card && !card.contains(e.relatedTarget)) card.classList.remove('drag-over');
    });
    container.addEventListener('drop', async (e) => {
        const card = e.target.closest('.profile-card');
        if (!card || !draggedId) return;
        e.preventDefault();
        card.classList.remove('drag-over');
        const targetId = card.getAttribute('data-profile-id');
        if (!targetId || targetId === draggedId) return;
        const ids = _modelProfiles.map(p => p.id);
        const fromIdx = ids.indexOf(draggedId);
        const toIdx = ids.indexOf(targetId);
        if (fromIdx === -1 || toIdx === -1) return;
        const reordered = [..._modelProfiles];
        const [removed] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, removed);
        const order = reordered.map(p => p.id);
        try {
            const res = await apiCall('/api/model-profiles/reorder', { method: 'POST', body: { order } });
            if (!res.ok) throw new Error();
            showToast(typeof t === 'function' ? t('config.profile_order_saved') : 'Ordine salvată', 'success');
            await loadModelProfiles();
        } catch (err) {
            showToast(typeof t === 'function' ? t('config.profile_order_error') : 'Eroare la salvare ordine', 'error');
        }
    });
}

function renderModelSelector(data) {
    const listEl = document.getElementById('model-selector-profiles');
    const wrapEl = document.querySelector('.model-selector-wrap');
    if (!listEl) return;

    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (_defaultProfileId || '').toLowerCase() === 'auto';
    const activeProfile = isAuto ? null : (visibleProfiles.find(p => p.id === _defaultProfileId) || visibleProfiles[0]);

    const accentColor = (activeProfile?.color || '#38bdf8').trim();
    if (wrapEl) wrapEl.style.setProperty('--selector-accent', accentColor);

    /* The button is now a cog icon — no label text to set.
       The --selector-accent CSS variable handles the color. */

    const autoLabel = typeof t === 'function' ? t('config.model_selector_auto') : 'Auto';
    const autoButton = `
        <button type="button" class="model-selector-item${isAuto ? ' active' : ''}" onclick="activateProfile('auto');closeModelSelector()">
            <div class="model-selector-item-dot" style="background:#38bdf8"></div>
            <div class="model-selector-item-info">
                <div class="model-selector-item-name">${escapeHtml(autoLabel)}</div>
                <div class="model-selector-item-model">${escapeHtml('')}</div>
            </div>
            <i class="fas fa-check model-selector-item-check"></i>
        </button>`;

    if (!visibleProfiles.length) {
        listEl.innerHTML = autoButton + '<div class="model-selector-empty"><i class="fas fa-info-circle mr-1"></i>Setări → Profiluri Model</div>';
        updateChatAttachVisibility();
        return;
    }

    listEl.innerHTML = autoButton + visibleProfiles.map(p => {
        const isActive = p.id === _defaultProfileId;
        const reasoning = p.capability_reasoning !== false;
        const tools = p.capability_tool_calling !== false;
        const vision = p.capability_vision !== false;
        const capsHtml = [reasoning && '<i class="fas fa-brain model-selector-cap-icon" title="Reasoning"></i>', tools && '<i class="fas fa-wrench model-selector-cap-icon" title="Tool calling"></i>', vision && '<i class="fas fa-eye model-selector-cap-icon" title="Vision"></i>'].filter(Boolean).join('');
        return `
            <button type="button" class="model-selector-item${isActive ? ' active' : ''}" onclick="activateProfile('${escapeHtml(p.id)}');closeModelSelector()">
                <div class="model-selector-item-dot" style="background:${escapeHtml(p.color || '#6366f1')}"></div>
                <div class="model-selector-item-info">
                    <div class="model-selector-item-name">${escapeHtml(p.name)}</div>
                    <div class="model-selector-item-model">${escapeHtml(p.model_name || '')}</div>
                </div>
                ${capsHtml ? `<div class="model-selector-item-caps">${capsHtml}</div>` : ''}
                <i class="fas fa-check model-selector-item-check"></i>
            </button>`;
    }).join('');
    updateChatAttachVisibility();
}

function updateChatAttachVisibility() {
    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (_defaultProfileId || '').toLowerCase() === 'auto';
    const activeProfile = isAuto ? null : visibleProfiles.find(p => p.id === _defaultProfileId) || visibleProfiles[0];
    const hasVision = isAuto || (activeProfile ? (activeProfile.capability_vision !== false) : true);
    const imageItem = document.querySelector('.chat-attach-balloon-item[data-attach="image"]');
    const cameraItem = document.querySelector('.chat-attach-balloon-item[data-attach="camera"]');
    if (imageItem) imageItem.style.display = hasVision ? '' : 'none';
    if (cameraItem) cameraItem.style.display = hasVision ? '' : 'none';

    const btnAttach = document.getElementById('btn-attach');
    if (!btnAttach) return;
    const iconEl = btnAttach.querySelector('i.fas');
    if (!iconEl) return;
    if (!hasVision) {
        btnAttach.setAttribute('data-single-attach', 'document');
        iconEl.className = 'fas fa-file-alt';
        const docLabel = typeof t === 'function' ? t('chat.attach_document') : 'Încarcă document';
        btnAttach.setAttribute('aria-label', docLabel);
        btnAttach.title = docLabel;
        btnAttach.setAttribute('aria-haspopup', 'false');
    } else {
        btnAttach.removeAttribute('data-single-attach');
        iconEl.className = 'fas fa-plus';
        const attachLabel = typeof t === 'function' ? t('chat.attach_image') : 'Atașare';
        btnAttach.setAttribute('aria-label', attachLabel);
        btnAttach.title = attachLabel;
        btnAttach.setAttribute('aria-haspopup', 'true');
    }
}

window.syncVisionCapabilityCheckbox = function() {
    const visionEnabledEl = document.getElementById('profile-vision-enabled');
    const visionUrlEl = document.getElementById('profile-vision-url');
    const visionModelEl = document.getElementById('profile-vision-model');
    const capVision = document.getElementById('profile-capability-vision');
    if (!capVision) return;
    const visionConfigured = visionEnabledEl?.checked && ((visionUrlEl?.value || '').trim() || (visionModelEl?.value || '').trim());
    if (visionConfigured) {
        capVision.checked = true;
        capVision.disabled = true;
    } else {
        capVision.disabled = false;
    }
};

window.showProfileEditor = function(profileId) {
    const overlay = document.getElementById('profile-editor-overlay');
    if (!overlay) return;
    const titleEl = document.getElementById('profile-editor-title');
    const idEl = document.getElementById('profile-edit-id');
    const nameEl = document.getElementById('profile-name');
    const provEl = document.getElementById('profile-provider');
    const urlEl = document.getElementById('profile-url');
    const modelEl = document.getElementById('profile-model');
    const keyEl = document.getElementById('profile-api-key');
    const tempEl = document.getElementById('profile-temperature');
    const timeoutEl = document.getElementById('profile-timeout');
    const ctxEl = document.getElementById('profile-context');
    const colorEl = document.getElementById('profile-color');
    const auxEnabledEl = document.getElementById('profile-aux-enabled');
    const auxUrlEl = document.getElementById('profile-aux-url');
    const auxModelEl = document.getElementById('profile-aux-model');
    const auxKeyEl = document.getElementById('profile-aux-key');
    const auxFields = document.getElementById('profile-aux-fields');
    const keyRow = document.getElementById('profile-api-key-row');
    // Coder fields
    const coderEnabledEl = document.getElementById('profile-coder-enabled');
    const coderProvEl = document.getElementById('profile-coder-provider');
    const coderUrlEl = document.getElementById('profile-coder-url');
    const coderModelEl = document.getElementById('profile-coder-model');
    const coderKeyEl = document.getElementById('profile-coder-key');
    const coderTimeoutEl = document.getElementById('profile-coder-timeout');
    const coderFields = document.getElementById('profile-coder-fields');
    // Vision fields
    const visionEnabledEl = document.getElementById('profile-vision-enabled');
    const visionProvEl = document.getElementById('profile-vision-provider');
    const visionUrlEl = document.getElementById('profile-vision-url');
    const visionModelEl = document.getElementById('profile-vision-model');
    const visionKeyEl = document.getElementById('profile-vision-key');
    const visionTimeoutEl = document.getElementById('profile-vision-timeout');
    const visionRespondEl = document.getElementById('profile-vision-respond-directly');
    const visionFields = document.getElementById('profile-vision-fields');
    // Embedding fields
    const embedEnabledEl = document.getElementById('profile-embed-enabled');
    const embedModelEl = document.getElementById('profile-embed-model');
    const embedFields = document.getElementById('profile-embed-fields');

    if (profileId) {
        const p = _modelProfiles.find(x => x.id === profileId);
        if (!p) return;
        titleEl.textContent = (typeof t === 'function') ? t('config.profile_editor_title_edit') : 'Editează profil';
        idEl.value = p.id;
        nameEl.value = p.name || '';
        provEl.value = p.provider || 'local';
        urlEl.value = p.target_url || '';
        modelEl.value = p.model_name || '';
        keyEl.value = p.api_key || '';
        tempEl.value = p.temperature ?? 0.7;
        timeoutEl.value = p.timeout ?? 120;
        ctxEl.value = p.context_length ?? 24000;
        colorEl.value = p.color || '#6366f1';
        const personaOverrideEl = document.getElementById('profile-persona-override');
        if (personaOverrideEl) personaOverrideEl.value = p.persona_override || '';
        const capReason = document.getElementById('profile-capability-reasoning');
        const capTools = document.getElementById('profile-capability-tools');
        const capVision = document.getElementById('profile-capability-vision');
        if (capReason) capReason.checked = p.capability_reasoning !== false;
        if (capTools) capTools.checked = p.capability_tool_calling !== false;
        if (capVision) capVision.checked = p.capability_vision !== false;
        auxEnabledEl.checked = !!p.aux_llm_enabled;
        const aux = p.aux_llm || {};
        auxUrlEl.value = aux.target_url || '';
        auxModelEl.value = aux.model_name || '';
        auxKeyEl.value = aux.api_key || '';
        // Coder
        if (coderEnabledEl) coderEnabledEl.checked = !!p.coder_enabled;
        const coder = p.coder || {};
        if (coderProvEl) coderProvEl.value = coder.provider || 'local';
        if (coderUrlEl) coderUrlEl.value = coder.target_url || '';
        if (coderModelEl) coderModelEl.value = coder.model_name || '';
        if (coderKeyEl) coderKeyEl.value = coder.api_key || '';
        if (coderTimeoutEl) coderTimeoutEl.value = coder.timeout ?? 180;
        if (coderFields) coderFields.classList.toggle('hidden', !p.coder_enabled);
        // Vision
        if (visionEnabledEl) visionEnabledEl.checked = !!p.vision_enabled;
        const vision = p.vision_llm || {};
        if (visionProvEl) visionProvEl.value = vision.provider || 'local';
        if (visionUrlEl) visionUrlEl.value = vision.target_url || '';
        if (visionModelEl) visionModelEl.value = vision.model_name || '';
        if (visionKeyEl) visionKeyEl.value = vision.api_key || '';
        if (visionTimeoutEl) visionTimeoutEl.value = vision.timeout ?? 60;
        if (visionRespondEl) visionRespondEl.checked = !!vision.respond_directly;
        if (visionFields) visionFields.classList.toggle('hidden', !p.vision_enabled);
        // Embedding
        if (embedEnabledEl) embedEnabledEl.checked = !!p.embed_enabled;
        const embed = p.librarian || {};
        if (embedModelEl) embedModelEl.value = embed.model_name || '';
        if (embedFields) embedFields.classList.toggle('hidden', !p.embed_enabled);
        syncVisionCapabilityCheckbox();
    } else {
        titleEl.textContent = (typeof t === 'function') ? t('config.profile_editor_title_new') : 'Profil nou';
        idEl.value = '';
        nameEl.value = '';
        provEl.value = 'local';
        urlEl.value = 'http://127.0.0.1:1234/v1';
        modelEl.value = '';
        keyEl.value = '';
        tempEl.value = '0.7';
        timeoutEl.value = '120';
        ctxEl.value = '24000';
        colorEl.value = '#6366f1';
        const personaOverrideEl = document.getElementById('profile-persona-override');
        if (personaOverrideEl) personaOverrideEl.value = '';
        const capReason = document.getElementById('profile-capability-reasoning');
        const capTools = document.getElementById('profile-capability-tools');
        const capVision = document.getElementById('profile-capability-vision');
        if (capReason) capReason.checked = true;
        if (capTools) capTools.checked = true;
        if (capVision) capVision.checked = true;
        auxEnabledEl.checked = false;
        auxUrlEl.value = '';
        auxModelEl.value = '';
        auxKeyEl.value = '';
        // Coder defaults
        if (coderEnabledEl) coderEnabledEl.checked = false;
        if (coderProvEl) coderProvEl.value = 'local';
        if (coderUrlEl) coderUrlEl.value = '';
        if (coderModelEl) coderModelEl.value = '';
        if (coderKeyEl) coderKeyEl.value = '';
        if (coderTimeoutEl) coderTimeoutEl.value = '180';
        if (coderFields) coderFields.classList.add('hidden');
        // Vision defaults
        if (visionEnabledEl) visionEnabledEl.checked = false;
        if (visionProvEl) visionProvEl.value = 'local';
        if (visionUrlEl) visionUrlEl.value = '';
        if (visionModelEl) visionModelEl.value = '';
        if (visionKeyEl) visionKeyEl.value = '';
        if (visionTimeoutEl) visionTimeoutEl.value = '60';
        if (visionRespondEl) visionRespondEl.checked = false;
        if (visionFields) visionFields.classList.add('hidden');
        syncVisionCapabilityCheckbox();
        // Embedding defaults (enabled by default)
        if (embedEnabledEl) embedEnabledEl.checked = true;
        if (embedModelEl) embedModelEl.value = '';
        if (embedFields) embedFields.classList.remove('hidden');
    }
    auxFields.classList.toggle('hidden', !auxEnabledEl.checked);
    keyRow.style.display = provEl.value === 'local' ? 'none' : '';
    openSubPage('profile-editor-overlay');
};

window.closeProfileEditor = function() {
    closeSubPage('profile-editor-overlay');
};

window.onProfileProviderChange = function() {
    const prov = document.getElementById('profile-provider');
    const url = document.getElementById('profile-url');
    const model = document.getElementById('profile-model');
    const keyRow = document.getElementById('profile-api-key-row');
    if (!prov) return;
    const v = prov.value;
    if (keyRow) keyRow.style.display = v === 'local' ? 'none' : '';
    if (v === 'local') {
        if (url) url.value = 'http://localhost:11434/v1';
        if (model) model.value = '';
    } else if (v === 'z_ai') {
        if (url) url.value = 'https://api.z.ai/api/paas/v4';
        if (model) model.value = 'glm-5';
    } else if (v === 'grok') {
        if (url) url.value = 'https://api.x.ai/v1/chat/completions';
        if (model && !model.value.trim()) model.value = 'grok-4-1-fast-reasoning';
    } else if (v === 'deepseek') {
        if (url) url.value = 'https://api.deepseek.com/chat/completions';
        if (model && !model.value.trim()) model.value = 'deepseek-chat';
    } else if (v === 'openai') {
        if (url) url.value = 'https://api.openai.com/v1';
        if (model && !model.value.trim()) model.value = 'gpt-4o';
    }
};

window.onProfileSubProviderChange = function(type) {
    const prov = document.getElementById(`profile-${type}-provider`);
    const url = document.getElementById(`profile-${type}-url`);
    const model = document.getElementById(`profile-${type}-model`);
    if (!prov) return;
    const v = prov.value;
    const isCoder = type === 'coder';
    if (v === 'local') {
        if (url) url.value = isCoder ? '' : 'http://localhost:11434/v1';
        if (model) model.value = '';
    } else if (v === 'z_ai') {
        if (url) url.value = isCoder ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4';
        if (model) model.value = 'glm-5';
    } else if (v === 'grok') {
        if (url) url.value = 'https://api.x.ai/v1/chat/completions';
        if (model && !model.value.trim()) model.value = 'grok-4-1-fast-reasoning';
    } else if (v === 'deepseek') {
        if (url) url.value = 'https://api.deepseek.com/chat/completions';
        if (model && !model.value.trim()) model.value = 'deepseek-chat';
    } else if (v === 'openai') {
        if (url) url.value = 'https://api.openai.com/v1';
        if (model && !model.value.trim()) model.value = 'gpt-4o';
    }
};

window.saveProfile = async function(e) {
    if (e) e.preventDefault();
    const payload = {
        id: document.getElementById('profile-edit-id')?.value || '',
        name: document.getElementById('profile-name')?.value || '',
        provider: document.getElementById('profile-provider')?.value || 'local',
        target_url: document.getElementById('profile-url')?.value || '',
        model_name: document.getElementById('profile-model')?.value || '',
        api_key: document.getElementById('profile-api-key')?.value || '',
        temperature: parseFloat(document.getElementById('profile-temperature')?.value) || 0.7,
        timeout: parseInt(document.getElementById('profile-timeout')?.value, 10) || 120,
        context_length: parseInt(document.getElementById('profile-context')?.value, 10) || 24000,
        max_tokens: 2048,
        color: document.getElementById('profile-color')?.value || '#6366f1',
        persona_override: (document.getElementById('profile-persona-override')?.value || '').trim() || null,
        capability_reasoning: document.getElementById('profile-capability-reasoning')?.checked !== false,
        capability_tool_calling: document.getElementById('profile-capability-tools')?.checked !== false,
        capability_vision: (function() {
            const visionEnabled = document.getElementById('profile-vision-enabled')?.checked;
            const visionUrl = (document.getElementById('profile-vision-url')?.value || '').trim();
            const visionModel = (document.getElementById('profile-vision-model')?.value || '').trim();
            if (visionEnabled && (visionUrl || visionModel)) return true;
            return document.getElementById('profile-capability-vision')?.checked !== false;
        })(),
        aux_llm_enabled: document.getElementById('profile-aux-enabled')?.checked || false,
        aux_llm: {
            target_url: document.getElementById('profile-aux-url')?.value || '',
            model_name: document.getElementById('profile-aux-model')?.value || '',
            api_key: document.getElementById('profile-aux-key')?.value || '',
        },
        coder_enabled: document.getElementById('profile-coder-enabled')?.checked || false,
        coder: {
            provider: document.getElementById('profile-coder-provider')?.value || 'local',
            target_url: document.getElementById('profile-coder-url')?.value || '',
            model_name: document.getElementById('profile-coder-model')?.value || '',
            api_key: document.getElementById('profile-coder-key')?.value || '',
            timeout: parseInt(document.getElementById('profile-coder-timeout')?.value, 10) || 180,
        },
        vision_enabled: document.getElementById('profile-vision-enabled')?.checked || false,
        vision_llm: {
            provider: document.getElementById('profile-vision-provider')?.value || 'local',
            target_url: document.getElementById('profile-vision-url')?.value || '',
            model_name: document.getElementById('profile-vision-model')?.value || '',
            api_key: document.getElementById('profile-vision-key')?.value || '',
            timeout: parseInt(document.getElementById('profile-vision-timeout')?.value, 10) || 60,
            respond_directly: document.getElementById('profile-vision-respond-directly')?.checked || false,
        },
        embed_enabled: document.getElementById('profile-embed-enabled')?.checked || false,
        librarian: {
            model_name: document.getElementById('profile-embed-model')?.value || '',
        },
    };
    try {
        const res = await apiCall('/api/model-profiles', { method: 'POST', body: payload });
        if (!res.ok) throw new Error('Save failed');
        showToast((typeof t === 'function') ? t('config.profile_saved') : 'Profil salvat', 'success');
        closeProfileEditor();
        await loadModelProfiles();
    } catch (e) { showToast((typeof t === 'function') ? t('config.profile_save_error') : 'Eroare la salvare', 'error'); }
};

window.deleteProfile = async function(profileId) {
    if (!(await showConfirm('Ștergi acest profil?'))) return;
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast('Profil șters', 'success');
        closeProfileCardMenu();
        await loadModelProfiles();
    } catch (e) { showToast('Eroare', 'error'); }
};

window.openProfileCardMenu = function(profileId, ev) {
    if (ev) ev.stopPropagation();
    const modal = document.getElementById('profile-card-menu-modal');
    if (!modal) return;
    modal.dataset.profileId = profileId;
    const p = _modelProfiles.find(x => x.id === profileId);
    const visible = p && p.visible_in_selector !== false;
    const visibilityBtn = document.getElementById('profile-card-menu-visibility-btn');
    const visibilityText = document.getElementById('profile-card-menu-visibility-text');
    if (visibilityBtn) {
        visibilityBtn.dataset.visible = String(visible);
        visibilityBtn.classList.toggle('is-in-selector', visible);
        if (visibilityText) {
            visibilityText.textContent = visible ? (typeof t === 'function' ? t('config.profile_hide_from_selector') : 'Ascunde din selector') : (typeof t === 'function' ? t('config.profile_show_in_selector') : 'Afișează în selector');
        }
        const icon = visibilityBtn.querySelector('i');
        if (icon) {
            icon.className = visible ? 'fas fa-eye-slash mr-2' : 'fas fa-check-circle mr-2';
        }
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
};

window.closeProfileCardMenu = function() {
    const modal = document.getElementById('profile-card-menu-modal');
    if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
};

window.setProfileVisibility = async function(profileId, visible) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'PATCH', body: { visible_in_selector: visible } });
        if (!res.ok) throw new Error();
        showToast(visible ? (typeof t === 'function' ? t('config.profile_shown_in_selector') : 'Afișat în selector') : (typeof t === 'function' ? t('config.profile_hidden_from_selector') : 'Ascuns din selector'), 'success');
        await loadModelProfiles();
    } catch (e) { showToast(typeof t === 'function' ? t('config.profile_visibility_error') : 'Eroare', 'error'); }
};

{
    const menuModal = document.getElementById('profile-card-menu-modal');
    if (menuModal) {
        menuModal.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const profileId = menuModal.dataset.profileId;
            if (!profileId) return;
            const action = btn.getAttribute('data-action');
            closeProfileCardMenu();
            if (action === 'toggle_visibility') {
                const visible = btn.dataset.visible !== 'true';
                setProfileVisibility(profileId, visible);
            } else if (action === 'edit') showProfileEditor(profileId);
            else if (action === 'duplicate') duplicateProfile(profileId);
            else if (action === 'delete') deleteProfile(profileId);
        });
    }
}

window.duplicateProfile = async function(profileId) {
    const p = _modelProfiles.find(x => x.id === profileId);
    if (!p) return;
    const newId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36).slice(-8);
    const payload = {
        id: newId,
        name: (p.name || 'Profil').trim() ? `Copy of ${(p.name || 'Profil').trim()}` : 'Profil duplicat',
        provider: p.provider || 'local',
        target_url: p.target_url || '',
        model_name: p.model_name || '',
        api_key: p.api_key || '',
        temperature: p.temperature ?? 0.7,
        timeout: p.timeout ?? 120,
        context_length: p.context_length ?? 24000,
        max_tokens: p.max_tokens ?? 2048,
        color: p.color || '#6366f1',
        aux_llm_enabled: p.aux_llm_enabled || false,
        aux_llm: { ...(p.aux_llm || {}), target_url: (p.aux_llm?.target_url || ''), model_name: (p.aux_llm?.model_name || ''), api_key: (p.aux_llm?.api_key || '') },
        coder_enabled: p.coder_enabled || false,
        coder: { ...(p.coder || {}), provider: (p.coder?.provider || 'local'), target_url: (p.coder?.target_url || ''), model_name: (p.coder?.model_name || ''), api_key: (p.coder?.api_key || ''), timeout: (p.coder?.timeout ?? 180) },
        vision_enabled: p.vision_enabled || false,
        vision_llm: { ...(p.vision_llm || {}), provider: (p.vision_llm?.provider || 'local'), target_url: (p.vision_llm?.target_url || ''), model_name: (p.vision_llm?.model_name || ''), api_key: (p.vision_llm?.api_key || ''), timeout: (p.vision_llm?.timeout ?? 60), respond_directly: !!p.vision_llm?.respond_directly },
        embed_enabled: p.embed_enabled || false,
        librarian: { model_name: (p.librarian?.model_name || '').trim() },
        persona_override: (p.persona_override || '').trim() || null,
        capability_reasoning: p.capability_reasoning !== false,
        capability_tool_calling: p.capability_tool_calling !== false,
        capability_vision: p.capability_vision !== false,
    };
    try {
        const res = await apiCall('/api/model-profiles', { method: 'POST', body: payload });
        if (!res.ok) throw new Error('Save failed');
        showToast('Profil duplicat', 'success');
        await loadModelProfiles();
    } catch (e) { showToast('Eroare la duplicare', 'error'); }
};

/** Două flashuri în exteriorul barei la schimbarea modelului (același stil ca la streaming). */
function playChatBarGlow(profileId) {
    const bar = document.querySelector('.chat-input-inner');
    if (!bar) return;
    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (profileId || '').toLowerCase() === 'auto';
    const color = isAuto && visibleProfiles.length > 0
        ? (visibleProfiles[0].color || '#38bdf8').trim()
        : (visibleProfiles.find(p => p.id === profileId)?.color || '#38bdf8').trim();
    bar.style.setProperty('--chat-bar-flash-color', color);
    bar.classList.remove('chat-input-bar-flash');
    bar.offsetHeight;
    bar.classList.add('chat-input-bar-flash');
    bar.addEventListener('animationend', () => bar.classList.remove('chat-input-bar-flash'), { once: true });
}

window.activateProfile = async function(profileId) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}/activate`, { method: 'POST' });
        if (!res.ok) throw new Error();
        playChatBarGlow(profileId);
        await loadModelProfiles();
    } catch (e) { showToast('Eroare la activare', 'error'); }
};

window.toggleModelSelector = function() {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    if (!balloon) return;
    const isOpen = !balloon.classList.contains('hidden');
    balloon.classList.toggle('hidden');
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
    // Close other balloons
    if (!isOpen) {
        const attachBalloon = document.getElementById('chat-attach-balloon');
        if (attachBalloon) attachBalloon.classList.add('hidden');
    }
};

window.closeModelSelector = function() {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    if (balloon) balloon.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
};

// Close model selector when clicking outside
document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.model-selector-wrap');
    if (wrap && !wrap.contains(e.target)) {
        closeModelSelector();
    }
});

export async function saveConfig(eOrOptions) {
    const isEventLike = !!(eOrOptions && typeof eOrOptions.preventDefault === 'function');
    const options = (!isEventLike && eOrOptions && typeof eOrOptions === 'object') ? eOrOptions : {};
    const silent = !!options.silent;

    if (isEventLike) eOrOptions.preventDefault();
    const langEl = document.getElementById('ui_language');
    const language = langEl ? langEl.value : 'en';

    if (window.__isAdmin === false) {
        await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
        const userPersona = document.getElementById('user_persona');
        if (userPersona) {
            await apiCall('/api/users/me', { method: 'PATCH', body: { persona: userPersona.value } });
        }
        try { setLanguage(language); } catch (err) {}
        // Re-populate language dropdown to show updated labels
        const uiLangSelect = document.getElementById('ui_language');
        if (uiLangSelect) {
            const opts = getAvailableLanguages();
            uiLangSelect.innerHTML = opts.map(o => `<option value="${o.code}">${o.label}</option>`).join('');
            uiLangSelect.value = language;
        }
        if (!silent) showToast(t('config.save_success'), 'success');
        return;
    }

    const parseList = (s) => (s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
    const wsTransportRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transportMode = wsTransportRadio && wsTransportRadio.checked ? 'websocket' : 'firebase';

    const config = {
        verbose_logging: (document.getElementById('logging_mode')?.value || 'compact') === 'verbose',
        librarian: {
            retrieval_limit: Math.min(20, Math.max(1, parseInt(document.getElementById('intel_retrieval_limit')?.value, 10) || 5)),
            memory_relevance_max_distance: (() => {
                const v = document.getElementById('intel_memory_relevance_max_distance')?.value?.trim();
                if (v === '') return null;
                const n = parseFloat(v);
                if (Number.isNaN(n)) return null;
                return Math.min(2, Math.max(0, n));
            })()
        },
        security: {
            whitelist_enabled: document.getElementById('wl_numbers').value.split('\n').map(n => n.trim()).filter(n => n).length > 0,
            allowed_numbers: document.getElementById('wl_numbers').value.split('\n').map(n => n.trim()).filter(n => n),
            anti_injection: document.getElementById('security_anti_injection')?.checked !== false,
            anti_injection_prompt_template: document.getElementById('security_anti_injection_prompt')?.value || '',
            tool_guardrails: document.getElementById('security_tool_guardrails')?.checked !== false,
            restrict_mutating_tools_on_untrusted_content: document.getElementById('security_restrict_untrusted_tools')?.checked !== false
        },
        waha: {
            api_url: document.getElementById('waha_url').value,
            enabled: document.getElementById('waha_enabled').checked
        },
        pago: {
            enabled: document.getElementById('pago_enabled')?.checked || false,
            email: (document.getElementById('pago_email')?.value || '').trim(),
            password: (document.getElementById('pago_password')?.value || '').trim(),
            scan_interval: Math.max(60, parseInt(document.getElementById('pago_scan_interval')?.value, 10) || 3600)
        },
        fcm: {
            enabled: transportMode === 'firebase',
            transport_mode: transportMode,
            websocket_enabled: transportMode === 'websocket',
            send_when_ws_disconnected: true,
            project_id: (document.getElementById('fcm_project_id')?.value || '').trim(),
            service_account_path: (document.getElementById('fcm_service_account_path')?.value || '').trim(),
        },
        home_assistant: {
            url: document.getElementById('ha_url').value,
            token: document.getElementById('ha_token').value,
            enabled: true,
            device_match_priority: (document.getElementById('ha_device_match_priority')?.value || 'alias, friendly_name, entity_id').split(',').map(s => s.trim()).filter(Boolean),
            assist_default_user_id: null,
            assist_use_bridge_agent: document.getElementById('ha_assist_use_bridge_agent')?.checked !== false
        },
        prompts: (() => {
            const nlList = (s) => (s || '').split(/\n/).map(x => x.trim()).filter(Boolean);
            return {
                system_persona: document.getElementById('p_persona').value,
                agent_instructions: document.getElementById('p_agent_instructions')?.value ?? '',
                agent_instructions_fallback: (document.getElementById('p_agent_instructions_fallback')?.value ?? '').trim(),
                agent_instruction_overrides: nlList(document.getElementById('p_agent_instruction_overrides')?.value),
                agent_principles: nlList(document.getElementById('p_agent_principles')?.value),
                search_web_single_message_instruction: (document.getElementById('p_search_web_single_message_instruction')?.value ?? '').trim(),
                web_content_reply_instruction: (document.getElementById('p_web_content_reply_instruction')?.value ?? '').trim(),
                image_placeholder: (document.getElementById('p_image_placeholder')?.value ?? '').trim(),
                summarize: (document.getElementById('p_summarize')?.value ?? '').trim(),
                conversation_too_long: (document.getElementById('p_conversation_too_long')?.value ?? '').trim(),
                clear_context_message: (document.getElementById('p_clear_context_message')?.value ?? '').trim()
            };
        })(),
        memory: {
            working_window: Math.min(50, Math.max(4, parseInt(document.getElementById('intel_working_window')?.value, 10) || 12)),
            summarize_every: Math.min(30, Math.max(4, parseInt(document.getElementById('intel_summarize_every')?.value, 10) || 8)),
            fact_similarity_threshold: Math.min(0.9, Math.max(0.1, parseFloat(document.getElementById('memory_fact_similarity')?.value) || 0.45)),
            extraction_timeout: Math.min(600, Math.max(10, parseInt(document.getElementById('memory_extraction_timeout')?.value, 10) || 120)),
            extraction_input_max_chars: Math.min(4000, Math.max(300, parseInt(document.getElementById('memory_extraction_input_max_chars')?.value, 10) || 900)),
            extraction_max_tokens_full: Math.min(2400, Math.max(128, parseInt(document.getElementById('memory_extraction_max_tokens_full')?.value, 10) || 800)),
            extraction_max_lines: Math.min(10, Math.max(1, parseInt(document.getElementById('memory_extraction_max_lines')?.value, 10) || 2)),
            extraction_examples: getExtractionExamples().filter(ex => ex.input && ex.input.trim()),
        },
        intelligence: {
            max_agent_turns: Math.min(30, Math.max(1, parseInt(document.getElementById('max_agent_turns')?.value, 10) || 10)),
            post_response_concurrency: Math.min(5, Math.max(1, parseInt(document.getElementById('post_response_concurrency')?.value, 10) || 1)),
            inject_relevant_facts: document.getElementById('inject_relevant_facts')?.checked || false,
            lazy_history: document.getElementById('intel_lazy_history')?.checked !== false,
            richer_tool_results: document.getElementById('richer_tool_results')?.checked || false,
            knowledge_cutoff: (document.getElementById('intel_knowledge_cutoff')?.value || '2024-01').trim(),
            search_tendency: Math.min(5, Math.max(1, parseInt(document.getElementById('intel_search_tendency')?.value, 10) || 3)),
            search_use_conversation_context: document.getElementById('search_use_conversation_context')?.checked || false,
            search_context_similarity_threshold: Math.min(0.99, Math.max(0.2, parseFloat(document.getElementById('search_context_similarity_threshold')?.value) || 0.55)),
            shell: (() => {
                const rawAllowed = (document.getElementById('shell_allowed_commands')?.value || '').trim();
                const rawBlocked = (document.getElementById('shell_blocked_patterns')?.value || '').trim();
                const parseList = (s) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                const allowedList = parseList(rawAllowed);
                const blockedList = parseList(rawBlocked);
                return {
                    enabled: document.getElementById('shell_enabled')?.checked !== false,
                    allowed_commands: allowedList.length ? allowedList : ['curl', 'wget', 'ping', 'date', 'uname', 'cat', 'echo', 'head', 'tail', 'df', 'free', 'uptime'],
                    blocked_patterns: blockedList,
                    max_output_chars: Math.min(100000, Math.max(500, parseInt(document.getElementById('shell_max_output_chars')?.value, 10) || 8000)),
                    timeout_seconds: Math.min(120, Math.max(5, parseInt(document.getElementById('shell_timeout_seconds')?.value, 10) || 15)),
                    rate_limit_per_minute: Math.min(30, Math.max(1, parseInt(document.getElementById('shell_rate_limit')?.value, 10) || 5))
                };
            })(),
            file_read: {
                enabled: document.getElementById('file_read_enabled')?.checked !== false,
                max_bytes: Math.min(500000, Math.max(1024, parseInt(document.getElementById('file_read_max_bytes')?.value, 10) || 51200)),
                rate_limit_per_minute: Math.min(60, Math.max(1, parseInt(document.getElementById('file_read_rate_limit')?.value, 10) || 10))
            },
            run_script: {
                enabled: document.getElementById('run_script_enabled')?.checked !== false,
                timeout_seconds: Math.min(30, Math.max(5, parseInt(document.getElementById('run_script_timeout')?.value, 10) || 15)),
                max_output_chars: Math.min(100000, Math.max(1000, parseInt(document.getElementById('run_script_max_output')?.value, 10) || 20000)),
                rate_limit_per_minute: Math.min(15, Math.max(1, parseInt(document.getElementById('run_script_rate_limit')?.value, 10) || 3))
            },
            propose_patch: {
                enabled: document.getElementById('propose_patch_enabled')?.checked !== false,
                allowed_dirs: (document.getElementById('propose_patch_allowed_dirs')?.value || 'scripts, docs, ai_suggestions').split(',').map(s => s.trim()).filter(Boolean)
            },
            consolidation: {
                enabled: document.getElementById('consolidation_enabled')?.checked || false,
                time: (document.getElementById('consolidation_time')?.value || '03:00').trim().slice(0, 5),
                interval: document.getElementById('consolidation_interval')?.value || 'daily',
                similarity_threshold: Math.min(0.99, Math.max(0.8, parseFloat(document.getElementById('consolidation_threshold')?.value) || 0.92)),
                session_trigger_messages: Math.min(500, Math.max(20, parseInt(document.getElementById('consolidation_session_trigger_messages')?.value, 10) || 80)),
                compression_ratio: Math.min(0.5, Math.max(0.05, parseFloat(document.getElementById('consolidation_compression_ratio')?.value) || 0.15)),
                history_log_path: (document.getElementById('consolidation_history_log_path')?.value || 'history_log.md').trim()
            },
        },
        searxng: {
            enabled: document.getElementById('searxng_enabled')?.checked || false,
            url: (document.getElementById('searxng_url')?.value || '').trim(),
            fetch_pages: document.getElementById('searxng_fetch_pages')?.checked !== false,
            max_pages_to_fetch: Math.min(3, Math.max(0, parseInt(document.getElementById('searxng_max_pages')?.value, 10) || 2)),
            max_search_results: Math.min(20, Math.max(1, parseInt(document.getElementById('searxng_max_results')?.value, 10) || 5)),
            search_timeout: Math.min(60, Math.max(3, parseInt(document.getElementById('searxng_search_timeout')?.value, 10) || 10)),
            max_searches_per_request: Math.min(20, Math.max(1, parseInt(document.getElementById('searxng_max_searches_per_request')?.value, 10) || 5))
        },
        cctv: (() => {
            const list = document.getElementById('cctv-cameras-list');
            const cameras = [];
            if (list) {
                list.querySelectorAll('.cctv-camera-row').forEach((row, i) => {
                    const nameInp = row.querySelector('.cctv-cam-name');
                    const rtspInp = row.querySelector('.cctv-cam-rtsp');
                    const ctxInp = row.querySelector('.cctv-cam-context');
                    const name = (nameInp?.value || '').trim();
                    const rtsp = (rtspInp?.value || '').trim();
                    const context = (ctxInp?.value || '').trim();
                    if (!name && !rtsp) return;
                    const id = row.dataset.cctvId || slugForId(name) || ('cam_' + i);
                    const cam = { id, name: name || id, rtsp_url: rtsp };
                    if (context) cam.context = context;
                    cameras.push(cam);
                });
            }
            return {
                enabled: document.getElementById('cctv_enabled')?.checked || false,
                cameras
            };
        })(),
        whisper: {
            enabled: document.getElementById('whisper_enabled')?.checked || false,
            host: (document.getElementById('whisper_host')?.value || 'localhost').trim(),
            port: Math.min(65535, Math.max(1, parseInt(document.getElementById('whisper_port')?.value, 10) || 10300)),
            language: document.getElementById('whisper_language')?.value || 'ro',
            vad_silence_ms: Math.min(10000, Math.max(500, parseInt(document.getElementById('whisper_vad_silence_ms')?.value, 10) || 2500)),
            vad_sensitivity: document.getElementById('whisper_vad_sensitivity')?.value || 'medium'
        },
        piper: {
            enabled: document.getElementById('piper_enabled')?.checked || false,
            // UI checkbox removed; keep persisted runtime value.
            always_speak: !!(window.__tts && window.__tts.alwaysSpeak)
        },
        comfyui: {
            enabled: document.getElementById('comfyui_enabled')?.checked || false,
            url: (document.getElementById('comfyui_url')?.value || 'http://localhost:8188').trim(),
            default_checkpoint: (document.getElementById('comfyui_checkpoint')?.value || '').trim(),
            default_steps: Math.min(150, Math.max(1, parseInt(document.getElementById('comfyui_steps')?.value, 10) || 20)),
            default_cfg_scale: Math.min(30, Math.max(1, parseFloat(document.getElementById('comfyui_cfg')?.value) || 7)),
            default_width: Math.min(2048, Math.max(256, parseInt(document.getElementById('comfyui_width')?.value, 10) || 1024)),
            default_height: Math.min(2048, Math.max(256, parseInt(document.getElementById('comfyui_height')?.value, 10) || 1024)),
            default_sampler: document.getElementById('comfyui_sampler')?.value || 'euler',
            default_scheduler: document.getElementById('comfyui_scheduler')?.value || 'normal',
            default_negative_prompt: (document.getElementById('comfyui_negative')?.value || '').trim(),
            timeout: Math.min(600, Math.max(10, parseInt(document.getElementById('comfyui_timeout')?.value, 10) || 120)),
            workflow_file: (document.getElementById('comfyui_workflow_file')?.value || '').trim(),
        },
        timezone: (document.getElementById('config_timezone')?.value || '').trim(),

        ui: { language }
    };

    await apiCall('/api/config', { method: 'POST', body: config });

    const wsServiceShouldRun = (() => {
        const mode = String(config.fcm?.transport_mode || 'hybrid').toLowerCase();
        const wsEnabled = config.fcm?.websocket_enabled !== false;
        return wsEnabled && mode !== 'firebase';
    })();
    if (window.__MEMINI_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try { window.__setNativeWsServiceEnabled(!!wsServiceShouldRun); } catch (_) {}
    }

    const badge = document.getElementById('header-log-mode-badge');
    if (badge) {
        const verbose = !!config.verbose_logging;
        badge.textContent = verbose ? 'LOG: VERBOSE' : 'LOG: COMPACT';
        badge.classList.remove(
            'border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10',
            'border-amber-500/30', 'text-amber-300', 'bg-amber-500/10'
        );
        if (verbose) {
            badge.classList.add('border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
        } else {
            badge.classList.add('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10');
        }
    }

    try {
        setLanguage(config.ui.language);
        // Re-populate language dropdown to show updated labels
        const uiLangSelect = document.getElementById('ui_language');
        if (uiLangSelect) {
            const opts = getAvailableLanguages();
            uiLangSelect.innerHTML = opts.map(o => `<option value="${o.code}">${o.label}</option>`).join('');
            uiLangSelect.value = config.ui.language;
        }
    } catch (err) {}

    // Also save native App tab config if running in Memini Bridge
    if (typeof window.saveAppConfig === 'function') {
        window.saveAppConfig();
    }

    // Save notification preferences if on the notifications tab
    const notifTab = document.getElementById('cfg-tab-notifications');
    if (notifTab && !notifTab.classList.contains('hidden')) {
        await saveNotificationSettings({ silent: true });
        return;
    }

    if (!silent) showToast(t('config.save_success'), 'success');
}

/** Generate AI welcome greetings on demand (button click). */
/** Copy text to clipboard; works on HTTP and with password fields. Shows toast on success. */
function copyToClipboard(text, successMessage) {
    const msg = successMessage || (t('common.copied') || 'Copied!');
    if (!text || typeof text !== 'string') return false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => showToast(msg, 'success')).catch(fallback);
        } else {
            fallback();
        }
    } catch (e) {
        fallback();
    }
    function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast(msg, 'success');
        } catch (err) {
            showToast(t('common.copy_failed') || 'Copy failed', 'error');
        }
        document.body.removeChild(ta);
    }
    return true;
}

export function copyWebhook() {
    const el = document.getElementById('waha_webhook');
    if (!el || !el.value) return;
    copyToClipboard(el.value, t('config.webhook_copied') || 'Webhook URL copied!');
}

const INTEGRATION_MODAL_TITLES = { ha: 'config.ha_section', searxng: 'config.searxng_section', waha: 'config.waha_section', cctv: 'config.cctv_section', whisper: 'config.whisper_section', comfyui: 'config.comfyui_section', piper: 'config.piper_section', pago: 'config.pago_section' };
const INTEGRATION_MODAL_ICONS  = { ha: 'fa-house-signal', searxng: 'fa-magnifying-glass', waha: 'fa-brands fa-whatsapp', cctv: 'fa-video', whisper: 'fa-microphone', comfyui: 'fa-palette', piper: 'fa-volume-up', pago: 'fa-file-invoice-dollar' };

export async function openIntegrationConfigModal(integrationId) {
    const modal = document.getElementById('integration-config-modal');
    const titleEl = document.getElementById('integration-config-modal-title');
    const iconEl = document.getElementById('integration-config-modal-icon');
    if (!modal || !titleEl) return;
    document.querySelectorAll('[id^="integration-panel-"]').forEach(panel => {
        panel.classList.add('hidden');
    });
    const panel = document.getElementById(`integration-panel-${integrationId}`);
    if (panel) panel.classList.remove('hidden');
    const icon = INTEGRATION_MODAL_ICONS[integrationId] || 'fa-plug';
    titleEl.textContent = t(INTEGRATION_MODAL_TITLES[integrationId]) || integrationId;
    if (iconEl) iconEl.className = `fas ${icon}`;
    openSubPage('integration-config-modal');

    // Always re-fetch config so fields reflect stored values
    let cfg = null;
    try {
        const cfgRes = await apiCall('/api/config');
        if (cfgRes.ok) cfg = await cfgRes.json();
    } catch (_) {}

    if (integrationId === 'ha') {
        if (cfg) {
            const haCfg = cfg.home_assistant || {};
            const haUrl = document.getElementById('ha_url');
            const haToken = document.getElementById('ha_token');
            const haPriority = document.getElementById('ha_device_match_priority');
            const haAssistAgent = document.getElementById('ha_assist_use_bridge_agent');
            if (haUrl) haUrl.value = haCfg.url || '';
            if (haToken && haCfg.token) haToken.value = haCfg.token;
            if (haPriority) haPriority.value = haCfg.device_match_priority || 'alias, friendly_name, entity_id';
            if (haAssistAgent) haAssistAgent.checked = !!haCfg.assist_use_bridge_agent;
        }
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const keyEl = document.getElementById('assist_api_key');
        if (keyEl) keyEl.value = '';
        try {
            const res = await apiCall('/api/assist-key');
            if (res.ok) {
                const data = await res.json();
                if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
                const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
                if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
            }
        } catch (_) {}
        const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
        if (ollamaUserUrlEl && !ollamaUserUrlEl.value && origin) ollamaUserUrlEl.value = '';
    }
    if (integrationId === 'waha') {
        if (cfg) {
            const wahaCfg = cfg.waha || {};
            const wahaUrl = document.getElementById('waha_url');
            const wlNumbers = document.getElementById('wl_numbers');
            if (wahaUrl) wahaUrl.value = wahaCfg.url || '';
            if (wlNumbers && wahaCfg.allowed_numbers) wlNumbers.value = (wahaCfg.allowed_numbers || []).join('\n');
        }
        const wh = document.getElementById('waha_webhook');
        if (wh && typeof window !== 'undefined' && window.location?.origin) {
            wh.value = window.location.origin + '/api/webhook/waha';
        }
    }
    if (integrationId === 'searxng' && cfg) {
        const sx = cfg.searxng || {};
        const sxUrl = document.getElementById('searxng_url');
        if (sxUrl) sxUrl.value = sx.url || '';
    }
    if (integrationId === 'comfyui') {
        if (cfg) {
            const c = cfg.comfyui || {};
            const fields = {
                'comfyui_url': c.url || 'http://localhost:8188',
                'comfyui_steps': c.default_steps ?? 20,
                'comfyui_cfg': c.default_cfg_scale ?? 7,
                'comfyui_width': c.default_width ?? 1024,
                'comfyui_height': c.default_height ?? 1024,
                'comfyui_sampler': c.default_sampler || 'euler',
                'comfyui_scheduler': c.default_scheduler || 'normal',
                'comfyui_timeout': c.timeout ?? 120,
                'comfyui_negative': c.default_negative_prompt || '',
            };
            for (const [id, val] of Object.entries(fields)) {
                const el = document.getElementById(id);
                if (el) el.value = val;
            }
            // Refresh checkpoint & workflow selects, then set stored values
            const storedCheckpoint = c.default_checkpoint || '';
            const storedWorkflow = c.workflow_file || '';
            try {
                await window.refreshComfyUICheckpoints();
                const ckptEl = document.getElementById('comfyui_checkpoint');
                if (ckptEl && storedCheckpoint) ckptEl.value = storedCheckpoint;
            } catch (_) {}
            try {
                await window.refreshComfyUIWorkflows();
                const wfEl = document.getElementById('comfyui_workflow_file');
                if (wfEl && storedWorkflow) wfEl.value = storedWorkflow;
            } catch (_) {}
        }
    }
    if (integrationId === 'cctv' && cfg) {
        const cctvCfg = cfg.cctv || {};
        renderCctvCameras(cctvCfg.cameras || []);
    }
    if (integrationId === 'whisper' && cfg) {
        const w = cfg.whisper || {};
        const wHost = document.getElementById('whisper_host');
        const wPort = document.getElementById('whisper_port');
        const wLang = document.getElementById('whisper_language');
        if (wHost) wHost.value = w.host || 'localhost';
        if (wPort) wPort.value = w.port || 10300;
        if (wLang) wLang.value = w.language || 'ro';
        const wVadMs = document.getElementById('whisper_vad_silence_ms');
        const wVadSens = document.getElementById('whisper_vad_sensitivity');
        if (wVadMs) wVadMs.value = w.vad_silence_ms || 2500;
        if (wVadSens) wVadSens.value = w.vad_sensitivity || 'medium';
    }
    if (integrationId === 'piper' && cfg) {
        // Populate addon config fields from addon API
        try {
            const addonRes = await apiCall('/api/addons/piper');
            if (addonRes.ok) {
                const addon = await addonRes.json();
                const ac = addon.state?.config || {};
                const pVoice = document.getElementById('piper_voice');
                const pHost = document.getElementById('piper_host');
                const pPort = document.getElementById('piper_port');
                const pSpeakerId = document.getElementById('piper_speaker_id');
                const pLengthScale = document.getElementById('piper_length_scale');
                if (pVoice) pVoice.value = ac.voice || 'ro_RO-mihai-medium';
                if (pHost) pHost.value = ac.host || 'localhost';
                if (pPort) pPort.value = ac.port || 10200;
                if (pSpeakerId) pSpeakerId.value = ac.speaker_id ?? 0;
                if (pLengthScale) pLengthScale.value = ac.length_scale || '1.0';
            }
        } catch (_) {}
    }
    if (integrationId === 'pago' && cfg) {
        const p = cfg.pago || {};
        const pEmail = document.getElementById('pago_email');
        const pPass = document.getElementById('pago_password');
        const pInterval = document.getElementById('pago_scan_interval');
        if (pEmail) pEmail.value = p.email || '';
        if (pPass && p.password) pPass.value = p.password;
        if (pInterval) pInterval.value = p.scan_interval ?? 3600;
        loadIntegrationEntities('pago');
    }
}

export function copyAssistOllamaUserUrl() {
    const el = document.getElementById('assist_ollama_user_url');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export function copyAssistKey() {
    const el = document.getElementById('assist_api_key');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export async function regenerateAssistKey() {
    if (!(await showConfirm(t('config.assist_regenerate_confirm') || 'Regenerate key? The old key will stop working.'))) return;
    try {
        const res = await apiCall('/api/assist-key/regenerate', { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const keyEl = document.getElementById('assist_api_key');
        if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
        if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
        showToast(t('config.assist_regenerate_done') || 'New key generated.', 'success');
    } catch (e) {
        showToast(t('config.assist_regenerate_error') || 'Failed to regenerate key.', 'error');
    }
}

export function closeIntegrationConfigModal() {
    // Save addon-level config for piper if its panel is visible
    const piperPanel = document.getElementById('integration-panel-piper');
    if (piperPanel && !piperPanel.classList.contains('hidden')) {
        _savePiperAddonConfig();
    }
    closeSubPage('integration-config-modal');
    saveConfig({ silent: true });
}

async function _savePiperAddonConfig() {
    const voice = document.getElementById('piper_voice')?.value || 'ro_RO-mihai-medium';
    const host = (document.getElementById('piper_host')?.value || 'localhost').trim();
    const port = parseInt(document.getElementById('piper_port')?.value, 10) || 10200;
    const speaker_id = parseInt(document.getElementById('piper_speaker_id')?.value, 10) || 0;
    const length_scale = (document.getElementById('piper_length_scale')?.value || '1.0').trim();
    try {
        await apiCall('/api/addons/piper/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice, host, port, speaker_id, length_scale }),
        });
    } catch (_) {}
}

export async function restartServer() {
    if (!(await showConfirm(t('config.restart_confirm')))) return;
    suppressLogout(true);
    showToast(t('config.restart_started') || 'Server restarting...', 'info', 8000);
    try {
        await apiCall('/api/restart', { method: 'POST' });
    } catch (e) {
        // Server closes connection on restart; network error is expected
    }
    startReconnectPolling();
}
function startReconnectPolling() {
    const maxAttempts = 30;
    let attempts = 0;
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('memini_token') : null;
    const headers = { Accept: 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const tryReconnect = () => {
        attempts++;
        fetch('/api/config', { method: 'GET', credentials: 'same-origin', headers })
            .then(r => {
                if (r.ok) {
                    suppressLogout(false);
                    location.reload();
                }
            })
            .catch(() => {})
            .finally(() => { if (attempts < maxAttempts) setTimeout(tryReconnect, 2000); else suppressLogout(false); });
    };
    setTimeout(tryReconnect, 3000);
}
export async function syncHA() {
    try {
        await apiCall('/api/ha/sync', { method: 'POST' });
        showToast(t('ha.sync_success') || 'Devices synced', 'success');
        loadSmarthome();
    } catch (e) { showToast(t('ha.sync_error') || 'Sync failed', 'error'); }
}

// --- WHISPER / VOICE INPUT ---

window.testWhisperConnection = async function() {
    const btn = document.getElementById('whisper-test-btn');
    const resultDiv = document.getElementById('whisper-test-result');
    if (btn) btn.disabled = true;
    try {
        const host = (document.getElementById('whisper_host')?.value || 'localhost').trim();
        const port = parseInt(document.getElementById('whisper_port')?.value, 10) || 10300;
        const res = await apiCall(`/api/whisper/status?host=${encodeURIComponent(host)}&port=${port}`);
        const data = await res.json();
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-red-500/15', 'text-red-300', 'bg-emerald-500/15', 'text-emerald-300');
            if (data.connected) {
                resultDiv.classList.add('bg-emerald-500/15', 'text-emerald-300');
                resultDiv.innerHTML = '<i class="fas fa-check-circle mr-1"></i> ' + (t('config.whisper_test_success') || 'Connected successfully');
            } else {
                resultDiv.classList.add('bg-red-500/15', 'text-red-300');
                resultDiv.innerHTML = '<i class="fas fa-times-circle mr-1"></i> ' + (t('config.whisper_test_fail') || 'Connection failed');
            }
        }
    } catch (e) {
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-emerald-500/15', 'text-emerald-300', 'bg-red-500/15', 'text-red-300');
            resultDiv.classList.add('bg-red-500/15', 'text-red-300');
            resultDiv.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i> ' + (e.message || 'Error');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
};

window.testPiperConnection = async function() {
    const btn = document.getElementById('piper-test-btn');
    if (!btn) return;
    btn.disabled = true;
    const baseHtml = btn.innerHTML;
    const baseClass = btn.className;
    const setBtnState = (type, text) => {
        btn.innerHTML = `<i class="fas ${type === 'ok' ? 'fa-check-circle' : 'fa-times-circle'}"></i><span>${text}</span>`;
        btn.classList.remove('bg-cyan-500/15', 'hover:bg-cyan-500/25', 'text-cyan-300', 'border-cyan-500/25');
        if (type === 'ok') {
            btn.classList.add('bg-emerald-500/15', 'text-emerald-300', 'border-emerald-500/25');
        } else {
            btn.classList.add('bg-red-500/15', 'text-red-300', 'border-red-500/25');
        }
    };
    try {
        // Save addon config first so the health-check uses latest host/port
        await _savePiperAddonConfig();
        // Use addon health-check endpoint (reads host/port from server config)
        const res = await apiCall('/api/addons/piper/health');
        const data = await res.json();
        if (data && data.ok === true) {
            setBtnState('ok', t('config.piper_test_success') || 'Connected successfully');
        } else {
            // Fallback: if process is actually running, treat as reachable.
            let running = false;
            try {
                const sRes = await apiCall('/api/addons/piper/status');
                const s = await sRes.json();
                running = s && s.status === 'running';
            } catch (_) {}
            if (running) {
                setBtnState('ok', t('config.piper_test_success') || 'Connected successfully');
            } else {
                const detail = data?.detail ? formatHealthError(data.detail) : (t('config.piper_test_fail') || 'Connection failed');
                setBtnState('fail', detail);
            }
        }
    } catch (e) {
        setBtnState('fail', e.message || 'Error');
    } finally {
        setTimeout(() => {
            btn.className = baseClass;
            btn.innerHTML = baseHtml;
            btn.disabled = false;
        }, 3000);
    }
};

window.testPagoConnection = async function() {
    const btn = document.getElementById('pago-test-btn');
    const result = document.getElementById('pago-test-result');
    if (!btn) return;
    btn.disabled = true;
    const baseHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Se verifică…</span>';
    try {
        // Save config first so backend uses latest credentials
        await saveConfig();
        const res = await apiCall('/api/pago/status');
        const data = await res.json();
        if (result) {
            result.classList.remove('hidden', 'bg-emerald-500/15', 'text-emerald-300', 'bg-red-500/15', 'text-red-300');
            if (data && data.ok) {
                result.classList.add('bg-emerald-500/15', 'text-emerald-300');
                result.textContent = data.message || (t('config.pago_test_success') || 'Conectat cu succes');
            } else {
                result.classList.add('bg-red-500/15', 'text-red-300');
                result.textContent = data?.message || (t('config.pago_test_fail') || 'Conexiune eșuată');
            }
        }
    } catch (e) {
        if (result) {
            result.classList.remove('hidden', 'bg-emerald-500/15', 'text-emerald-300', 'bg-red-500/15', 'text-red-300');
            result.classList.add('bg-red-500/15', 'text-red-300');
            result.textContent = e.message || 'Error';
        }
    } finally {
        btn.innerHTML = baseHtml;
        btn.disabled = false;
        if (result) setTimeout(() => result.classList.add('hidden'), 5000);
    }
};

// ---------------------------------------------------------------------------
// Integration entity sync & display
// ---------------------------------------------------------------------------

const _ENTITY_LABELS = {
    profil:          { icon: 'fa-user',                label: 'Profil' },
    abonament:       { icon: 'fa-id-badge',            label: 'Abonament' },
    carduri:         { icon: 'fa-credit-card',         label: 'Carduri' },
    vehicule:        { icon: 'fa-car',                 label: 'Vehicule' },
    facturi:         { icon: 'fa-file-invoice-dollar',  label: 'Facturi' },
    conturi_facturi: { icon: 'fa-building',            label: 'Furnizori' },
    plati:           { icon: 'fa-receipt',             label: 'Plăți' },
};

// ---- detail renderers per entity key ------------------------------------

function _fmtDateStr(s) {
    // 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DD' -> '01 mar. 2026'
    if (!s || s.length < 10) return s || '—';
    const d = new Date(s.slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return s;
    return d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _fmtTs(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _daysUntil(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return null;
    const now = new Date(); now.setHours(0,0,0,0);
    return Math.floor((d - now) / 86400000);
}

function _renderDetailProfil(data) {
    if (!data || data.error) return '<span class="text-red-400 text-[10px]">eroare</span>';
    const rows = [
        { l: 'Nume',    v: `${data.nume || ''} ${data.prenume || ''}`.trim() },
        { l: 'Email',   v: data.email },
        { l: 'Telefon', v: data.telefon ? `+${data.telefon}` : null },
        { l: 'ID',      v: data.pos_user_id },
        { l: 'Membru din', v: data.creat_la ? _fmtTs(data.creat_la) : null },
    ].filter(r => r.v);
    return rows.map(r => `<div class="flex justify-between gap-2"><span class="text-slate-500">${r.l}</span><span class="text-slate-300 text-right">${r.v}</span></div>`).join('');
}

function _renderDetailAbonament(data) {
    if (!data || data.error) return '<span class="text-red-400 text-[10px]">eroare</span>';
    const active = data.activ ? '<span class="text-emerald-400">Activ</span>' : '<span class="text-red-400">Inactiv</span>';
    const rows = [
        { l: 'Status', v: active },
        { l: 'Perioadă', v: data.inceput && data.sfarsit ? `${data.inceput} → ${data.sfarsit}` : null },
        { l: 'Perioadă (zile)', v: data.perioada_zile },
        { l: 'Facturi/lună', v: data.facturi_lunare != null ? `${data.plati_folosite ?? 0} / ${data.facturi_lunare}` : null },
        { l: 'Plăți rămase', v: data.plati_ramase != null ? `<span class="${data.plati_ramase > 0 ? 'text-emerald-400' : 'text-amber-400'}">${data.plati_ramase}</span>` : null },
    ].filter(r => r.v);
    return rows.map(r => `<div class="flex justify-between gap-2"><span class="text-slate-500">${r.l}</span><span class="text-slate-300 text-right">${r.v}</span></div>`).join('');
}

function _renderDetailCarduri(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun card</span>';
    return data.map(c => {
        const last4 = c.last4 || '????';
        const type = c.tip_card || '';
        const alias = c.alias || '';
        const active = c.activ !== false;
        const isDefault = c.default;
        return `<div class="flex items-center justify-between gap-2">`
            + `<span class="text-slate-300 font-mono">****${last4}</span>`
            + `<span class="text-slate-500">${type}${alias ? ' · ' + alias : ''}${isDefault ? ' <span class="text-orange-400 text-[9px]">(Default)</span>' : ''}</span>`
            + `<span class="${active ? 'text-emerald-400' : 'text-red-400'} text-[9px]">${active ? '●' : '○'}</span>`
            + `</div>`;
    }).join('');
}

function _renderDetailVehicule(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun vehicul</span>';
    const alertLabels = {
        rca_expira: 'RCA', itp_expira: 'ITP',
        vinieta_expira: 'Rovinietă', rovinieta_expira: 'Rovinietă', casco_expira: 'CASCO',
    };
    return data.map(v => {
        const plate = v.nr_inmatriculare || '?';
        const alerte = v.alerte || {};

        // Compute status
        const rcaDays = _daysUntil(alerte.rca_expira);
        const itpDays = _daysUntil(alerte.itp_expira);
        let status = 'OK', statusCls = 'text-emerald-400';
        if (rcaDays !== null && rcaDays < 0) { status = 'RCA Expirat'; statusCls = 'text-red-400'; }
        else if (itpDays !== null && itpDays < 0) { status = 'ITP Expirat'; statusCls = 'text-red-400'; }
        else if (!alerte.rca_expira) { status = 'Fără RCA'; statusCls = 'text-amber-400'; }

        // Alert tags
        const tags = [];
        for (const [key, label] of Object.entries(alertLabels)) {
            const val = alerte[key];
            if (!val) continue;
            const days = _daysUntil(val);
            const dateStr = _fmtDateStr(val);
            let cls = 'text-emerald-400';
            let extra = '';
            if (days !== null) {
                if (days < 0) { cls = 'text-red-400'; extra = ' (expirat)'; }
                else if (days < 30) { cls = 'text-amber-400'; extra = ` (${days}z)`; }
                else { extra = ` (${days}z)`; }
            }
            tags.push(`<span class="${cls}">${label} ${dateStr}${extra}</span>`);
        }

        // Notification settings
        const notifs = [];
        if (alerte.rca_notificare_sms) notifs.push('SMS');
        if (alerte.rca_notificare_email) notifs.push('Email');
        const notifStr = notifs.length ? `<div class="text-[9px] text-slate-600">Notificări RCA: ${notifs.join(', ')}</div>` : '';

        return `<div class="space-y-0.5 pb-1.5 ${data.indexOf(v) < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="flex items-center justify-between"><span class="text-slate-300 font-mono font-bold">${plate}</span><span class="${statusCls} text-[10px] font-semibold">${status}</span></div>`
            + `<div class="text-[10px] flex flex-wrap gap-x-1.5 gap-y-0.5">${tags.join('')}</div>`
            + notifStr
            + `</div>`;
    }).join('');
}

function _renderDetailFacturi(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">nicio factură</span>';
    const total = data.reduce((s, b) => s + (b.suma_datorata || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const restante = data.filter(b => b.scadenta && b.scadenta <= today).length;
    let header = `<div class="flex justify-between gap-2 pb-1 mb-1 border-b border-white/5">`
        + `<span class="text-slate-400">Total datorat</span>`
        + `<span class="text-slate-200 font-mono font-bold">${total.toFixed(2)} RON</span></div>`;
    if (restante > 0) {
        header += `<div class="text-red-400 text-[10px] mb-1"><i class="fas fa-exclamation-triangle mr-1"></i>${restante} factur${restante === 1 ? 'ă restantă' : 'i restante'}</div>`;
    }
    return header + data.map(b => {
        const amt = b.suma_datorata != null ? `${b.suma_datorata.toFixed(2)} RON` : '—';
        const scad = b.scadenta || '—';
        const overdue = b.scadenta && b.scadenta <= today;
        const cls = overdue ? 'text-red-400' : 'text-slate-300';
        return `<div class="flex justify-between gap-2"><span class="${cls} font-mono">${amt}</span><span class="text-slate-500">scadentă ${_fmtDateStr(scad)}${overdue ? ' <i class="fas fa-exclamation-triangle text-red-400 text-[9px] ml-1"></i>' : ''}</span></div>`;
    }).join('');
}

function _renderDetailConturiFurnizori(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun furnizor</span>';
    return data.map(c => {
        const name = c.furnizor_nume || c.furnizor || '?';
        const loc = c.locatie || '';
        const suma = c.ultima_plata_suma;
        const dataPlata = c.ultima_plata_data ? _fmtDateStr(c.ultima_plata_data) : '';
        const auto = c.auto_plata ? '<span class="text-blue-400 text-[9px] ml-1">auto</span>' : '';
        return `<div class="space-y-0.5 pb-1 ${data.indexOf(c) < data.length - 1 ? 'border-b border-white/5 mb-1' : ''}">`
            + `<div class="flex items-center justify-between gap-2"><span class="text-slate-300 font-semibold">${name}</span>${auto}</div>`
            + (loc ? `<div class="text-[10px] text-slate-500"><i class="fas fa-map-marker-alt text-[8px] mr-1"></i>${loc}${c.tip_locatie ? ' · ' + c.tip_locatie : ''}</div>` : '')
            + (suma != null ? `<div class="text-[10px] text-slate-400">Ultima plată: <span class="text-slate-300 font-mono">${suma.toFixed(2)} RON</span>${dataPlata ? ' pe ' + dataPlata : ''}</div>` : '')
            + `</div>`;
    }).join('');
}

function _renderDetailPlati(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">nicio plată</span>';
    const typeLabels = { provider: 'Factură', rca: 'RCA', recharge: 'Reîncărcare', vignette: 'Rovinietă' };
    const recent = data.slice(0, 12);
    return recent.map(p => {
        const amt = p.suma != null ? `${Number(p.suma).toFixed(2)} RON` : (p.suma_platita != null ? `${Number(p.suma_platita).toFixed(2)} RON` : '—');
        const date = p.data ? _fmtDateStr(p.data) : '—';
        const type = typeLabels[p.tip] || p.tip || '';
        const furn = p.furnizor_nume || '';
        const loc = p.locatie || '';
        const ok = p.status === 'finalized';
        const label = furn || type || '?';
        return `<div class="flex items-center justify-between gap-1">`
            + `<span class="text-slate-300 font-mono text-[10px] shrink-0">${amt}</span>`
            + `<span class="text-slate-500 truncate text-[10px]">${label}${loc ? ' · ' + loc : ''}</span>`
            + `<span class="text-slate-600 text-[10px] shrink-0">${date}</span>`
            + `<span class="${ok ? 'text-emerald-400' : 'text-amber-400'} text-[9px] shrink-0">${ok ? '✓' : '…'}</span>`
            + `</div>`;
    }).join('')
        + (data.length > 12 ? `<div class="text-[10px] text-slate-600 text-center mt-1">+ ${data.length - 12} plăți mai vechi</div>` : '');
}

const _DETAIL_RENDERERS = {
    profil: _renderDetailProfil,
    abonament: _renderDetailAbonament,
    carduri: _renderDetailCarduri,
    vehicule: _renderDetailVehicule,
    facturi: _renderDetailFacturi,
    conturi_facturi: _renderDetailConturiFurnizori,
    plati: _renderDetailPlati,
};

// ---- sync & load --------------------------------------------------------

window.syncIntegrationEntities = async function(slug) {
    const btn = document.getElementById(`${slug}-sync-btn`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Sync'; }
    try {
        const res = await apiCall(`/api/integrations/sync/${slug}`, { method: 'POST' });
        const data = await res.json();
        if (data.status === 'ok') {
            await loadIntegrationEntities(slug);
        }
    } catch (e) {
        const errEl = document.getElementById(`${slug}-entities-error`);
        if (errEl) { errEl.textContent = e.message || 'Sync failed'; errEl.classList.remove('hidden'); }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i>Sync'; }
    }
};

// store current entities for toggling detail
let _currentEntities = {};

async function loadIntegrationEntities(slug) {
    const section = document.getElementById(`${slug}-entities-section`);
    const grid = document.getElementById(`${slug}-entities-grid`);
    const timeEl = document.getElementById(`${slug}-entities-time`);
    const errEl = document.getElementById(`${slug}-entities-error`);
    if (!section || !grid) return;
    try {
        const res = await apiCall(`/api/integrations/${slug}/entities`);
        if (!res.ok) { section.classList.add('hidden'); return; }
        const data = await res.json();
        section.classList.remove('hidden');
        if (errEl) {
            if (data.last_error) { errEl.textContent = data.last_error; errEl.classList.remove('hidden'); }
            else errEl.classList.add('hidden');
        }
        if (timeEl && data.updated_at) {
            const d = new Date(data.updated_at);
            timeEl.textContent = d.toLocaleString('ro-RO', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
        }

        const entities = data.entities || {};
        _currentEntities = entities;
        grid.innerHTML = '';

        // shared detail panel below the grid
        const detailPanel = document.getElementById(`${slug}-entity-detail`);
        if (detailPanel) { detailPanel.classList.add('hidden'); detailPanel.innerHTML = ''; }
        let _openKey = null;

        for (const [key, value] of Object.entries(entities)) {
            const meta = _ENTITY_LABELS[key] || { icon: 'fa-database', label: key };
            let count = '';
            if (Array.isArray(value)) count = value.length;
            else if (typeof value === 'object' && value && !value.error) count = Object.keys(value).length + ' câmpuri';
            else if (value?.error) count = '⚠ eroare';

            const card = document.createElement('div');
            card.className = 'entity-card bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center cursor-pointer hover:bg-white/[0.06] hover:border-orange-500/20 transition-all';
            card.dataset.entityKey = key;
            card.innerHTML = `<i class="fas ${meta.icon} text-orange-400/60 text-sm mb-1"></i>`
                + `<div class="text-[10px] font-bold text-slate-400">${meta.label}</div>`
                + `<div class="text-[11px] text-slate-500 mono">${count}</div>`;

            card.addEventListener('click', () => {
                if (!detailPanel) return;
                const wasOpen = _openKey === key;
                // reset all cards
                grid.querySelectorAll('.entity-card').forEach(c => {
                    c.classList.remove('border-orange-500/30', 'bg-white/[0.06]');
                    c.classList.add('border-white/5');
                });
                if (wasOpen) {
                    detailPanel.classList.add('hidden');
                    detailPanel.innerHTML = '';
                    _openKey = null;
                    return;
                }
                _openKey = key;
                card.classList.add('border-orange-500/30', 'bg-white/[0.06]');
                card.classList.remove('border-white/5');
                const renderer = _DETAIL_RENDERERS[key];
                const header = `<div class="flex items-center gap-2 mb-2 pb-1.5 border-b border-white/5"><i class="fas ${meta.icon} text-orange-400/60 text-xs"></i><span class="text-[11px] font-bold text-slate-400">${meta.label}</span></div>`;
                if (renderer) {
                    detailPanel.innerHTML = header + renderer(value);
                } else {
                    detailPanel.innerHTML = header + `<pre class="text-[9px] text-slate-500 whitespace-pre-wrap break-all">${JSON.stringify(value, null, 2).slice(0, 800)}</pre>`;
                }
                detailPanel.classList.remove('hidden');
                detailPanel.scrollTop = 0;
            });

            grid.appendChild(card);
        }
    } catch (_) {
        section.classList.add('hidden');
    }
}



let _voiceMediaRecorder = null;
let _voiceChunks = [];
let _voiceStream = null;
let _voiceAudioCtx = null;
let _voiceSilenceTimer = null;
let _VOICE_SILENCE_MS = 2500;  // stop after 2.5 s of silence (overridden by config)
let _VOICE_SILENCE_RMS = 0.015; // RMS threshold (0–1 scale) below = silence (overridden by config)

window.toggleVoiceRecording = async function(opts) {
    const _opts = opts || {};
    const btn = _opts.btn || document.getElementById('btn-voice');
    const inputId = _opts.inputId || 'user-input';
    const sendFn = _opts.sendFn || (window.sendMessage ? () => window.sendMessage() : null);
    if (!btn) return;
    console.log('[VOICE] toggleVoiceRecording called');
    console.log('[VOICE] navigator.mediaDevices:', !!navigator.mediaDevices);
    console.log('[VOICE] getUserMedia:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    console.log('[VOICE] location:', location.protocol, location.hostname);
    console.log('[VOICE] MediaRecorder:', typeof MediaRecorder);

    if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
        console.log('[VOICE] Cancelling recording (user tapped again)');
        // Discard the recording — don't transcribe
        _voiceMediaRecorder.ondataavailable = null;
        _voiceMediaRecorder.onstop = null;
        _voiceMediaRecorder.stop();
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
        if (_voiceStream) { _voiceStream.getTracks().forEach(t => t.stop()); _voiceStream = null; }
        _voiceMediaRecorder = null;
        _voiceChunks = [];
        btn.classList.remove('recording');
        btn.querySelector('i').className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        // Flash red 2 times like listening state but red
        btn.classList.add('flash-red-cancelled');
        setTimeout(() => {
            btn.classList.remove('flash-red-cancelled');
            setTimeout(() => {
                btn.classList.add('flash-red-cancelled');
                setTimeout(() => {
                    btn.classList.remove('flash-red-cancelled');
                }, 150);
            }, 150);
        }, 150);
        return;
    }

    // Start recording
    // Check if mediaDevices API is available (requires HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        console.error('[VOICE] mediaDevices not available. isSecure:', isSecure);
        if (!isSecure) {
            showToast(t('voice.requires_https') || 'Microphone requires HTTPS or localhost. Access via HTTPS to use voice input.', 'error', 6000);
        } else {
            showToast(t('voice.mic_unavailable') || 'Microphone not available on this device/browser', 'error');
        }
        return;
    }

    try {
        console.log('[VOICE] Requesting getUserMedia({audio: true})...');
        _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('[VOICE] Got stream:', _voiceStream);
        console.log('[VOICE] Audio tracks:', _voiceStream.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })));
    } catch (e) {
        console.error('[VOICE] getUserMedia error:', e.name, e.message, e);
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            showToast(t('voice.mic_denied') || 'Microphone access denied. Allow it in browser/device settings.', 'error', 5000);
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
            showToast(t('voice.mic_not_found') || 'No microphone found on this device', 'error');
        } else {
            showToast(t('voice.mic_error') || ('Microphone error: ' + e.message), 'error');
        }
        return;
    }

    _voiceChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus'
        : '';
    console.log('[VOICE] Selected mimeType:', mimeType || '(default)');
    const options = mimeType ? { mimeType } : {};
    _voiceMediaRecorder = new MediaRecorder(_voiceStream, options);
    console.log('[VOICE] MediaRecorder created, state:', _voiceMediaRecorder.state);

    _voiceMediaRecorder.ondataavailable = (e) => {
        console.log('[VOICE] ondataavailable: size=', e.data?.size, 'type=', e.data?.type);
        if (e.data && e.data.size > 0) _voiceChunks.push(e.data);
    };

    _voiceMediaRecorder.onstop = async () => {
        console.log('[VOICE] onstop: chunks=', _voiceChunks.length, 'total bytes=', _voiceChunks.reduce((s, c) => s + c.size, 0));
        // Cancel VAD loop
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }

        btn.classList.remove('recording');

        // Stop all tracks
        if (_voiceStream) {
            _voiceStream.getTracks().forEach(t => t.stop());
            _voiceStream = null;
        }

        if (_voiceChunks.length === 0) { _voiceMediaRecorder = null; return; }

        const recordedMime = _voiceMediaRecorder?.mimeType || 'audio/webm';
        _voiceMediaRecorder = null;
        const blob = new Blob(_voiceChunks, { type: recordedMime });
        _voiceChunks = [];
        console.log('[VOICE] Blob created: size=', blob.size, 'type=', blob.type);

        // Show transcribing state (keep amber look)
        btn.disabled = true;
        btn.classList.add('recording');
        btn.querySelector('i').className = 'fas fa-spinner fa-spin';

        try {
            const formData = new FormData();
            formData.append('file', blob, 'recording.webm');

            const token = localStorage.getItem('memini_token');
            const headers = {};
            if (token) headers['Authorization'] = 'Bearer ' + token;

            console.log('[VOICE] Sending to /api/whisper/transcribe... blob size:', blob.size);
            const res = await fetch('/api/whisper/transcribe', {
                method: 'POST',
                headers,
                body: formData
            });
            console.log('[VOICE] Response status:', res.status);

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || 'Transcription failed');
            }

            const data = await res.json();
            console.log('[VOICE] Transcription result:', data);
            if (data.text && data.text.trim()) {
                const input = document.getElementById(inputId);
                if (input) {
                    // Append to existing text (if any), separated by space
                    const existing = input.value.trim();
                    input.value = existing ? existing + ' ' + data.text.trim() : data.text.trim();
                    input.style.height = 'auto';
                    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
                    input.focus();
                    // Auto-send after transcription; flag for auto-speak
                    if (sendFn) {
                        window.__voiceInputPending = true;
                        setTimeout(() => sendFn(), 300);
                    }
                }
            } else {
                showToast(t('voice.no_speech') || 'No speech detected', 'info');
            }
        } catch (e) {
            console.error('[VOICE] Transcription error:', e);
            showToast(t('voice.transcribe_error') || 'Transcription error: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.classList.remove('recording');
            btn.querySelector('i').className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
    };

    _voiceMediaRecorder.onerror = (ev) => {
        console.error('[VOICE] MediaRecorder error:', ev, ev.error);
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
        btn.classList.remove('recording');
        if (_voiceStream) {
            _voiceStream.getTracks().forEach(t => t.stop());
            _voiceStream = null;
        }
        _voiceMediaRecorder = null;
        showToast(t('voice.recording_error') || 'Recording error', 'error');
    };

    btn.classList.add('recording');
    _voiceMediaRecorder.start(250);
    console.log('[VOICE] Recording started, state:', _voiceMediaRecorder.state);

    // ── Voice Activity Detection: auto-stop on silence ──────────────
    try {
        _voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = _voiceAudioCtx.createMediaStreamSource(_voiceStream);
        const analyser = _voiceAudioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let silenceStart = null;

        const checkLevel = () => {
            if (!_voiceMediaRecorder || _voiceMediaRecorder.state !== 'recording') return;
            analyser.getByteTimeDomainData(buf);
            // Compute RMS (each sample centred at 128)
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);

            if (rms < _VOICE_SILENCE_RMS) {
                if (!silenceStart) silenceStart = Date.now();
                else if (Date.now() - silenceStart >= _VOICE_SILENCE_MS) {
                    console.log('[VOICE] Silence detected — auto-stopping');
                    _voiceMediaRecorder.stop();
                    return; // exit loop
                }
            } else {
                silenceStart = null; // speech detected — reset timer
            }
            _voiceSilenceTimer = requestAnimationFrame(checkLevel);
        };
        _voiceSilenceTimer = requestAnimationFrame(checkLevel);
    } catch (err) {
        console.warn('[VOICE] VAD init failed (fallback to manual stop):', err);
    }
};

// ═══════════════════════════════════════════
//  ALWAYS-SPEAK + VOICE LOOP + KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════

/** Sync VAD settings from config DOM to runtime vars */
function _syncVadSettings() {
    const ms = parseInt(document.getElementById('whisper_vad_silence_ms')?.value, 10);
    if (ms >= 500 && ms <= 10000) _VOICE_SILENCE_MS = ms;
    const sens = document.getElementById('whisper_vad_sensitivity')?.value || 'medium';
    const rmsMap = { low: 0.025, medium: 0.015, high: 0.008 };
    _VOICE_SILENCE_RMS = rmsMap[sens] || 0.015;
}

/** Always-Speak toggle button handler */
function _initAlwaysSpeakBtn() {
    const btn = document.getElementById('btn-always-speak');
    if (!btn) return;
    if (btn.dataset.boundAlwaysSpeak === '1') return;
    btn.dataset.boundAlwaysSpeak = '1';
    // Restore state from _tts
    const tts = window.__tts;
    if (tts && tts.alwaysSpeak) {
        btn.classList.add('active');
        btn.querySelector('i').className = 'fas fa-volume-up';
    }
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tts = window.__tts;
        if (!tts) return;

        // If TTS is currently speaking, clicking this animated button should stop playback first.
        const isSpeakingNow = !!((tts.audio && !tts.audio.paused) || tts._streamPlaying);
        if (isSpeakingNow && typeof tts.stop === 'function') {
            try { tts.stop(); } catch (_) {}
            return;
        }

        tts.alwaysSpeak = !tts.alwaysSpeak;
        btn.classList.toggle('active', tts.alwaysSpeak);
        btn.querySelector('i').className = tts.alwaysSpeak ? 'fas fa-volume-up' : 'fas fa-volume-off';

        // Ensure piper_enabled checkbox matches (button is only visible when piper is on,
        // but guard against stale state from config reloads).
        const piperCb = document.getElementById('piper_enabled');
        if (tts.alwaysSpeak && piperCb && !piperCb.checked) piperCb.checked = true;

        // UX: when enabling, start speaking the latest AI bubble immediately.
        if (tts.alwaysSpeak) {
            const bubbles = document.querySelectorAll('.chat-row-ai .ai-bubble');
            const lastBubble = bubbles && bubbles.length ? bubbles[bubbles.length - 1] : null;
            if (lastBubble && typeof tts.speak === 'function') {
                try { await tts.speak(lastBubble); } catch (err) { console.warn('[TTS] speak failed:', err); }
            }
        } else if (typeof tts.stop === 'function') {
            try { tts.stop(); } catch (_) {}
        }

        // Persist: include enabled:true so backend doesn't reject synthesize calls.
        try {
            const patch = { piper: { always_speak: !!tts.alwaysSpeak } };
            if (tts.alwaysSpeak) patch.piper.enabled = true;
            await apiCall('/api/config', { method: 'PATCH', body: patch });
        } catch (_) {}
    });
}

/** Voice balloon — long-press / right-click mic opens popup with voice loop toggle */
function _initVoiceBalloon() {
    const voiceBtn = document.getElementById('btn-voice');
    const balloon = document.getElementById('voice-mode-balloon');
    const loopToggle = document.getElementById('voice-loop-toggle');
    const loopBadge = document.getElementById('voice-loop-badge');
    if (!voiceBtn || !balloon) return;

    let longPressTimer = null;
    let didLongPress = false;

    function closeBalloon() {
        balloon.classList.add('hidden');
    }
    function openBalloon() {
        balloon.classList.remove('hidden');
    }
    function _syncLoopUI() {
        const on = !!window.__voiceLoopActive;
        if (loopBadge) {
            loopBadge.textContent = on ? 'ON' : 'OFF';
            loopBadge.classList.toggle('on', on);
            loopBadge.classList.toggle('off', !on);
        }
        voiceBtn.classList.toggle('voice-loop-active', on);
        // Change mic icon to show loop mode
        const icon = voiceBtn.querySelector('i');
        if (icon && !voiceBtn.classList.contains('recording')) {
            icon.className = on ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
        // When voice loop on, force always-speak
        if (on && window.__tts) {
            window.__tts.alwaysSpeak = true;
            const asBtn = document.getElementById('btn-always-speak');
            if (asBtn) {
                asBtn.classList.add('active');
                asBtn.querySelector('i').className = 'fas fa-volume-up';
            }
            const cb = document.getElementById('piper_always_speak');
            if (cb) cb.checked = true;
        }
    }

    // Long-press on touch devices → open balloon
    voiceBtn.addEventListener('touchstart', () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
            didLongPress = true;
            if (balloon.classList.contains('hidden')) openBalloon();
            else closeBalloon();
        }, 500);
    }, { passive: true });
    voiceBtn.addEventListener('touchend', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (didLongPress) {
            e.preventDefault(); // prevent click from firing
        }
    });
    voiceBtn.addEventListener('touchcancel', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    // Right-click on desktop → open balloon
    voiceBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (balloon.classList.contains('hidden')) openBalloon();
        else closeBalloon();
    });

    // Normal click = toggle voice recording (always works — no long-press interference on desktop)
    voiceBtn.addEventListener('click', (e) => {
        if (didLongPress) { didLongPress = false; return; }
        window.toggleVoiceRecording();
    });

    // Toggle voice loop from balloon
    if (loopToggle) {
        loopToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            window.__voiceLoopActive = !window.__voiceLoopActive;
            _syncLoopUI();
            closeBalloon();
        });
    }

    // Close balloon on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.voice-btn-wrap')) closeBalloon();
    });

    // Listen for tts:ended to restart mic in voice loop mode
    window.addEventListener('tts:ended', (e) => {
        if (!window.__voiceLoopActive) return;
        if (!e.detail?.voiceLoop) return;
        setTimeout(() => {
            if (window.__voiceLoopActive) {
                window.toggleVoiceRecording();
            }
        }, 400);
    });

    _syncLoopUI();
}

/** Keyboard shortcuts: Space=push-to-talk, V=toggle recording */
function _initVoiceKeyboardShortcuts() {
    let spaceHeld = false;

    document.addEventListener('keydown', (e) => {
        // Ignore when typing in input/textarea/contenteditable
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // Space = push-to-talk (hold)
        if (e.code === 'Space' && !e.repeat) {
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && !voiceBtn.classList.contains('hidden')) {
                e.preventDefault();
                spaceHeld = true;
                // Start recording if not already
                if (!_voiceMediaRecorder || _voiceMediaRecorder.state !== 'recording') {
                    window.toggleVoiceRecording();
                }
            }
        }

        // V = toggle voice recording
        if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey) {
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && !voiceBtn.classList.contains('hidden')) {
                e.preventDefault();
                window.toggleVoiceRecording();
            }
        }

        // Escape = stop TTS
        if (e.code === 'Escape' && window.__tts) {
            window.__tts.stop();
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spaceHeld) {
            spaceHeld = false;
            // Stop recording (send for transcription)
            if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
                _voiceMediaRecorder.stop();
            }
        }
    });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        _syncVadSettings();
        _initAlwaysSpeakBtn();
        _initVoiceBalloon();
        _initVoiceKeyboardShortcuts();
    });
} else {
    _syncVadSettings();
    _initAlwaysSpeakBtn();
    _initVoiceBalloon();
    _initVoiceKeyboardShortcuts();
}

// ═══════════════════════════════════════════
//  NOTIFICATION SETTINGS
// ═══════════════════════════════════════════

let _notifWsStatusTimer = null;
let _notifSettingsHydrating = false;
let _notifAutoSaveBound = false;
let _notifAutoSaveTimer = null;

function _applyNotifRuntimeTransport(transport) {
    const wsEnabled = transport === 'websocket';
    try {
        if (window.notificationTimer && typeof window.notificationTimer.setEnabled === 'function') {
            window.notificationTimer.setEnabled(wsEnabled);
        }
    } catch (_) {}

    if (window.__MEMINI_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try { window.__setNativeWsServiceEnabled(wsEnabled); } catch (_) {}
    }
}

function _getSelectedChannel() {
    const appRadio = document.querySelector('input[name="notif_channel"][value="app"]');
    return appRadio && appRadio.checked ? 'app' : 'whatsapp';
}

function _queueNotificationSettingsAutoSave() {
    if (_notifSettingsHydrating) return;
    if (_notifAutoSaveTimer) clearTimeout(_notifAutoSaveTimer);
    _notifAutoSaveTimer = setTimeout(() => {
        _notifAutoSaveTimer = null;
        saveNotificationSettings({ silent: true });
    }, 220);
}

function _bindNotificationSettingsAutoSave() {
    if (_notifAutoSaveBound) return;
    _notifAutoSaveBound = true;

    const bindInput = (id, eventName = 'input') => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener(eventName, _queueNotificationSettingsAutoSave);
    };

    bindInput('fcm_project_id', 'input');
    bindInput('fcm_service_account_path', 'input');

    const channelRadios = document.querySelectorAll('input[name="notif_channel"]');
    channelRadios.forEach((el) => el.addEventListener('change', _queueNotificationSettingsAutoSave));

    const transportRadios = document.querySelectorAll('input[name="notif_transport"]');
    transportRadios.forEach((el) => el.addEventListener('change', _queueNotificationSettingsAutoSave));
}

/** Select notification channel: 'app' (Memini) or 'whatsapp'. */
export function selectNotifChannel(channel, opts = {}) {
    const persist = opts.persist !== false;
    const cards = { app: document.getElementById('notif-card-app'), whatsapp: document.getElementById('notif-card-whatsapp') };
    const appGroup = document.getElementById('notif-app-settings-group');
    const waSection = document.getElementById('notif-whatsapp-section');

    for (const [key, card] of Object.entries(cards)) {
        if (!card) continue;
        const radio = card.querySelector('input[type="radio"]');
        if (key === channel) {
            card.classList.remove('border-white/10', 'bg-transparent');
            card.classList.add(key === 'app' ? 'border-blue-500/40' : 'border-emerald-500/40',
                              key === 'app' ? 'bg-blue-500/5' : 'bg-emerald-500/5');
            if (radio) radio.checked = true;
        } else {
            card.classList.remove('border-blue-500/40', 'border-emerald-500/40', 'bg-blue-500/5', 'bg-emerald-500/5');
            card.classList.add('border-white/10', 'bg-transparent');
            if (radio) radio.checked = false;
        }
    }

    const appOn = channel === 'app';
    if (appGroup) appGroup.classList.toggle('hidden', !appOn);
    if (waSection) waSection.classList.toggle('hidden', appOn);

    // When switching to WhatsApp, disable WS runtime
    if (!appOn) {
        _applyNotifRuntimeTransport('off');
        _stopNotifWsStatusPolling();
    }

    if (persist) {
        _queueNotificationSettingsAutoSave();
    }
}

/** Highlight the selected transport card and show/hide settings sections. */
export function selectNotifTransport(transport, opts = {}) {
    const persist = opts.persist !== false;
    const cards = { websocket: document.getElementById('notif-card-websocket'), firebase: document.getElementById('notif-card-firebase') };
    const sections = { websocket: document.getElementById('notif-ws-settings'), firebase: document.getElementById('notif-fcm-settings') };

    for (const [key, card] of Object.entries(cards)) {
        if (!card) continue;
        const radio = card.querySelector('input[type="radio"]');
        if (key === transport) {
            card.classList.remove('border-white/10', 'bg-transparent');
            card.classList.add(key === 'websocket' ? 'border-emerald-500/40' : 'border-orange-500/40',
                              key === 'websocket' ? 'bg-emerald-500/5' : 'bg-orange-500/5');
            if (radio) radio.checked = true;
        } else {
            card.classList.remove('border-emerald-500/40', 'border-orange-500/40', 'bg-emerald-500/5', 'bg-orange-500/5');
            card.classList.add('border-white/10', 'bg-transparent');
            if (radio) radio.checked = false;
        }
    }

    for (const [key, sec] of Object.entries(sections)) {
        if (sec) sec.classList.toggle('hidden', key !== transport);
    }

    // Start/stop WS status polling
    if (transport === 'websocket') {
        _refreshNotifWsStatus();
        _startNotifWsStatusPolling();
    } else {
        _stopNotifWsStatusPolling();
    }

    _applyNotifRuntimeTransport(transport);

    // Auto-refresh native WS badge (immediate + delayed to catch async service start)
    refreshNotifWsNativeStatus();
    setTimeout(refreshNotifWsNativeStatus, 1200);

    if (persist) {
        _queueNotificationSettingsAutoSave();
    }
}

function _startNotifWsStatusPolling() {
    _stopNotifWsStatusPolling();
    _notifWsStatusTimer = setInterval(() => {
        const tab = document.getElementById('cfg-tab-notifications');
        if (!tab || tab.classList.contains('hidden')) { _stopNotifWsStatusPolling(); return; }
        _refreshNotifWsStatus();
    }, 5000);
}

function _stopNotifWsStatusPolling() {
    if (_notifWsStatusTimer) { clearInterval(_notifWsStatusTimer); _notifWsStatusTimer = null; }
}

async function _refreshNotifWsStatus() {
    const badge = document.getElementById('notif-ws-status-badge');
    const countEl = document.getElementById('notif-ws-conn-count');
    try {
        const res = await apiCall('/api/notifications/ws-status');
        if (res.ok) {
            const data = await res.json();
            if (badge) {
                badge.classList.remove('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10',
                                      'border-red-500/30', 'text-red-400', 'bg-red-500/10',
                                      'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
                if (data.connected) {
                    badge.textContent = 'Conectat';
                    badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
                } else {
                    badge.textContent = 'Deconectat';
                    badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
                }
            }
            if (countEl) countEl.textContent = String(data.connection_count || 0);
        }
    } catch (e) {
        if (badge) { badge.textContent = 'Eroare'; badge.className = 'text-[10px] font-bold px-2.5 py-1 rounded-full border border-red-500/30 text-red-400 bg-red-500/10'; }
    }
}

/** Refresh the native Android WS service status badge. */
export function refreshNotifWsNativeStatus() {
    const badge = document.getElementById('notif-ws-native-status');
    if (!badge) return;
    badge.classList.remove('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10',
                           'border-red-500/30', 'text-red-400', 'bg-red-500/10',
                           'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
    if (!window.__MEMINI_NATIVE_APP || typeof window.__getNativeWsServiceStatus !== 'function') {
        badge.textContent = 'N/A';
        badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
        return;
    }
    try {
        const running = window.__getNativeWsServiceStatus();
        if (running === true) {
            badge.textContent = 'Running';
            badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
        } else if (running === false) {
            badge.textContent = 'Stopped';
            badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
        } else {
            badge.textContent = 'Unknown';
            badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
        }
    } catch (e) {
        badge.textContent = 'Eroare';
        badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
    }
}

/** Send a test notification on the currently selected transport. */
export async function testNotification() {
    const wsRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transport = wsRadio && wsRadio.checked ? 'websocket' : 'firebase';
    const label = transport === 'websocket' ? 'WebSocket' : 'FCM';

    try {
        const res = await apiCall('/api/notifications/test-channel', {
            method: 'POST',
            body: { transport }
        });
        if (!res.ok) {
            showToast(`Eroare la testul ${label}.`, 'error');
            return;
        }
        const data = await res.json();
        if (data.delivered) {
            const extra = data.sent_count ? ` (${data.sent_count} dispozitiv${data.sent_count === 1 ? '' : 'e'})` : '';
            showToast(`Test ${label} trimis cu succes!${extra}`, 'success');
        } else if (data.detail === 'no_ws_connection') {
            showToast('Nicio conexiune WebSocket activă.', 'warning');
        } else if (data.detail === 'fcm_disabled') {
            showToast('FCM nu este activ. Verifică project ID și service account.', 'warning');
        } else if (data.detail === 'no_devices') {
            showToast('FCM activ, dar nu există dispozitive Android înregistrate.', 'warning');
        } else {
            showToast(`Test ${label}: nicio livrare.`, 'warning');
        }
    } catch (e) {
        showToast(`Eroare la testul ${label}.`, 'error');
    }
}

/** Send a test notification via WebSocket only (legacy). */
export async function testWsNotification() {
    return testNotification();
}

/** Send a test notification via Firebase FCM only (legacy). */
export async function testFcmNotification() {
    return testNotification();
}

/** Load notification settings and populate the Notifications tab. */
export async function loadNotificationPrefs() {
    try {
        _notifSettingsHydrating = true;
        const [userRes, cfgRes] = await Promise.all([
            apiCall('/api/users/me'),
            apiCall('/api/config')
        ]);

        let cfg = {};
        if (cfgRes.ok) {
            cfg = await cfgRes.json();
        }

        // Determine transport: map old hybrid/legacy to websocket
        const fcm = cfg.fcm || {};
        let transport = String(fcm.transport_mode || 'websocket').toLowerCase();
        if (transport === 'hybrid') transport = 'websocket'; // hybrid → websocket (simplified)

        // Populate FCM fields
        const fcmProject = document.getElementById('fcm_project_id');
        const fcmSaPath = document.getElementById('fcm_service_account_path');
        if (fcmProject) fcmProject.value = fcm.project_id || '';
        if (fcmSaPath) fcmSaPath.value = fcm.service_account_path || '';

        // Select transport card (this shows/hides sections)
        selectNotifTransport(transport, { persist: false });

        // User notification prefs → channel selector
        let channel = 'app';
        if (userRes.ok) {
            const user = await userRes.json();
            const prefs = user.notification_prefs || { app: true, whatsapp: false };
            channel = prefs.whatsapp && !prefs.app ? 'whatsapp' : 'app';
        }

        // If WAHA is not enabled, force app channel and hide WhatsApp card
        const wahaOn = !!(cfg.waha && cfg.waha.enabled);
        const waCard = document.getElementById('notif-card-whatsapp');
        if (!wahaOn) {
            channel = 'app';
            if (waCard) waCard.classList.add('hidden');
        } else {
            if (waCard) waCard.classList.remove('hidden');
        }

        selectNotifChannel(channel, { persist: false });
    } catch (e) {
        console.warn('Failed to load notification settings:', e);
    } finally {
        _notifSettingsHydrating = false;
        _bindNotificationSettingsAutoSave();
    }
}

/** Save notification settings from the Notifications tab. */
export async function saveNotificationSettings(options = {}) {
    const silent = options.silent === true;

    // Determine selected transport
    const wsRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transport = wsRadio && wsRadio.checked ? 'websocket' : 'firebase';

    // Save config (FCM/transport settings) — uses merge, so only fcm key is updated
    try {
        const newFcm = {
            enabled: transport === 'firebase',
            transport_mode: transport,
            websocket_enabled: transport === 'websocket',
            project_id: (document.getElementById('fcm_project_id')?.value || '').trim(),
            service_account_path: (document.getElementById('fcm_service_account_path')?.value || '').trim(),
            send_when_ws_disconnected: true,
        };

        const saveRes = await apiCall('/api/config', {
            method: 'POST',
            body: { fcm: newFcm }
        });

        if (!saveRes.ok) {
            if (!silent) showToast('Eroare la salvarea configurării.', 'error');
            return;
        }
    } catch (e) {
        if (!silent) showToast('Eroare la salvarea configurării.', 'error');
        return;
    }

    // Save user notification prefs (channel)
    const channel = _getSelectedChannel();
    const appOn = channel === 'app';
    try {
        await apiCall('/api/users/me', {
            method: 'PATCH',
            body: { notification_prefs: { app: appOn, whatsapp: !appOn } }
        });
    } catch (e) {}

    if (appOn) {
        _applyNotifRuntimeTransport(transport);
    } else {
        _applyNotifRuntimeTransport('off');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADDONS / APPS
// ═══════════════════════════════════════════════════════════════════════════

let _currentAddonSlug = null;

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

export async function loadAddons() {
    const container = document.getElementById('addons-list');
    if (!container) return;

    let addons = [];
    try {
        const res = await apiCall('/api/addons');
        if (res.ok) addons = await res.json();
    } catch (e) {
        container.innerHTML = '<p class="text-sm text-red-400 text-center py-8">Eroare la încărcarea add-on-urilor.</p>';
        return;
    }

    if (!addons.length) {
        container.innerHTML = '<p class="text-sm text-slate-500 text-center py-8">Niciun add-on disponibil.</p>';
        return;
    }

    container.innerHTML = addons.map(addon => _renderAddonCard(addon)).join('');
}

function _renderAddonCard(addon) {
    const s = addon.state || {};
    const installed = !!s.installed;
    const enabled = !!s.enabled;
    const c = _addonColorMap[addon.color] || _defaultColor;
    const slug = escapeHtml(addon.slug);
    const name = escapeHtml(addon.name);
    const desc = escapeHtml(addon.description || '');
    const version = escapeHtml(addon.version || '');

    let statusBadge = '';
    let actions = '';

    if (installed) {
        if (enabled) {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 text-emerald-400 bg-emerald-500/10">Activ</span>`;
        } else {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 bg-amber-500/10">Instalat</span>`;
        }
        actions = `
            <button type="button" onclick="openAddonConfigModal('${slug}')" class="px-4 py-2 rounded-xl text-xs font-medium bg-white/5 hover:${c.btnBg} text-slate-300 hover:${c.btnText} border border-white/10 transition-colors">
                <i class="fas fa-cog mr-1"></i> Configurare
            </button>
            ${enabled
                ? `<button type="button" onclick="toggleAddon('${slug}', false)" class="integration-toggle-btn integration-btn-disable text-red-500/70 hover:text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-red-500/20"><i class="fas fa-power-off"></i> Disable</button>`
                : `<button type="button" onclick="toggleAddon('${slug}', true)" class="integration-toggle-btn integration-btn-enable text-emerald-500/70 hover:text-emerald-500 hover:bg-emerald-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-emerald-500/20"><i class="fas fa-check"></i> Enable</button>`
            }
            <button type="button" onclick="uninstallAddon('${slug}')" class="text-red-500/50 hover:text-red-500 hover:bg-red-500/10 px-2 py-2 rounded-xl text-[10px] transition-all border border-transparent hover:border-red-500/20" title="Dezinstalare"><i class="fas fa-trash-alt"></i></button>
        `;
    } else {
        statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-500/30 text-slate-500">Disponibil</span>`;
        actions = `
            <button type="button" onclick="installAddon('${slug}')" class="${c.btnBg} ${c.btnHover} ${c.btnText} border ${c.btnBorder} px-4 py-2 rounded-xl text-xs font-medium transition-colors inline-flex items-center gap-1.5">
                <i class="fas fa-download"></i> Instalează
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

export async function installAddon(slug) {
    const card = document.getElementById(`addon-card-${slug}`);
    const btn = card?.querySelector('button');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Se instalează...'; }

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/install`, { method: 'POST' });
        if (res.ok) {
            showToast('Add-on instalat cu succes!', 'success');
            await loadAddons();
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Eroare la instalare', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Instalează'; }
        }
    } catch (e) {
        showToast('Eroare de rețea', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Instalează'; }
    }
}

export async function uninstallAddon(slug) {
    if (!(await showConfirm(`Dezinstalezi add-on-ul "${slug}"?`))) return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' });
        if (res.ok) {
            showToast('Add-on dezinstalat', 'success');
            await loadAddons();
        } else {
            showToast('Eroare la dezinstalare', 'error');
        }
    } catch (e) {
        showToast('Eroare de rețea', 'error');
    }
}

export async function toggleAddon(slug, enabled) {
    const ep = enabled ? 'enable' : 'disable';
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${ep}`, { method: 'POST' });
        if (res.ok) {
            showToast(enabled ? 'Add-on activat' : 'Add-on dezactivat', 'success');
            await loadAddons();
        } else {
            showToast('Eroare', 'error');
        }
    } catch (e) {
        showToast('Eroare de rețea', 'error');
    }
}

export async function openAddonConfigModal(slug) {
    _currentAddonSlug = slug;
    const titleEl = document.getElementById('addon-config-modal-title');
    const iconEl = document.getElementById('addon-config-modal-icon');
    const fieldsEl = document.getElementById('addon-config-fields');
    if (!fieldsEl) return;

    let addon = null;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}`);
        if (res.ok) addon = await res.json();
    } catch (e) {}

    if (!addon) { showToast('Add-on negăsit', 'error'); return; }

    if (titleEl) titleEl.textContent = addon.name || slug;
    if (iconEl) iconEl.className = `${addon.icon || 'fas fa-puzzle-piece'}`;

    const schema = addon.config_schema || [];
    const cfg = addon.state?.config || {};

    fieldsEl.innerHTML = schema.map(field => {
        const val = cfg[field.key] ?? field.default ?? '';
        const key = escapeHtml(field.key);
        const label = escapeHtml(field.label || field.key);
        const desc = field.description ? `<p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(field.description)}</p>` : '';
        const ph = escapeHtml(field.placeholder || '');

        if (field.type === 'number') {
            return `<div class="space-y-1">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                <input type="number" data-addon-key="${key}" value="${escapeHtml(String(val))}" placeholder="${ph}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-xs mono text-slate-300 focus:border-accent outline-none">
                ${desc}
            </div>`;
        }
        return `<div class="space-y-1">
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
            <input type="text" data-addon-key="${key}" value="${escapeHtml(String(val))}" placeholder="${ph}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-xs mono text-slate-300 focus:border-accent outline-none">
            ${desc}
        </div>`;
    }).join('');

    if (addon.start_command) {
        const args = (addon.start_command.args || []).map(a => {
            return a.replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? k);
        });
        const cmd = `${addon.start_command.command} ${args.join(' ')}`;
        fieldsEl.innerHTML += `
            <div class="mt-4 pt-4 border-t border-white/5 space-y-2">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Comandă de pornire</p>
                <code class="block bg-slate-900 border border-white/5 rounded-xl p-3 text-[11px] mono text-slate-400 break-all select-all">${escapeHtml(cmd)}</code>
                <p class="text-[10px] text-slate-600">${escapeHtml(addon.start_command.description || '')}</p>
            </div>
        `;
    }

    const healthResult = document.getElementById('addon-health-result');
    if (healthResult) { healthResult.classList.add('hidden'); healthResult.textContent = ''; }

    // Watchdog toggle
    const watchdogToggle = document.getElementById('addon-watchdog-toggle');
    const watchdogSection = document.getElementById('addon-watchdog-section');
    if (watchdogToggle) watchdogToggle.checked = !!(addon.state?.watchdog);
    // Only show watchdog if addon has a start_command
    if (watchdogSection) watchdogSection.classList.toggle('hidden', !addon.start_command);

    openSubPage('addon-config-modal');
}

export function closeAddonConfigModal() {
    _currentAddonSlug = null;
    closeSubPage('addon-config-modal');
}

export async function saveAddonConfig() {
    if (!_currentAddonSlug) return;
    const fields = document.querySelectorAll('#addon-config-fields [data-addon-key]');
    const config = {};
    fields.forEach(f => {
        const key = f.dataset.addonKey;
        config[key] = f.type === 'number' ? Number(f.value) : f.value;
    });

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/config`, {
            method: 'PATCH',
            body: config,
        });
        if (!res.ok) {
            showToast('Eroare la salvare config', 'error');
            return;
        }
    } catch (e) {
        showToast('Eroare de rețea', 'error');
        return;
    }

    // Save watchdog setting
    const watchdogToggle = document.getElementById('addon-watchdog-toggle');
    if (watchdogToggle && !watchdogToggle.closest('.hidden')) {
        try {
            await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/watchdog`, {
                method: 'POST',
                body: { enabled: watchdogToggle.checked },
            });
        } catch (e) {}
    }

    showToast('Configurare salvată', 'success');
}

export async function checkAddonHealth() {
    if (!_currentAddonSlug) return;
    const resultEl = document.getElementById('addon-health-result');
    const btn = document.getElementById('addon-health-btn');
    if (btn) btn.disabled = true;
    if (resultEl) { resultEl.classList.remove('hidden'); resultEl.className = 'text-xs rounded-xl p-3 bg-slate-900 border border-white/5 text-slate-400'; resultEl.textContent = 'Se verifică...'; }

    const formatHealthError = (detail) => {
        const raw = String(detail || '').trim();
        const low = raw.toLowerCase();
        if (!raw) return 'Serviciul nu răspunde.';
        if (low === 'not_running') return 'Add-on-ul nu este instalat sau nu este activat.';
        if (low === 'no_port_configured') return 'Portul nu este configurat în Add-on settings.';
        if (low.includes('connection refused') || low.includes('errno 61')) {
            return 'Serviciul nu rulează pe host/port-ul configurat. Pornește Piper și verifică host/port.';
        }
        if (low.includes('timed out') || low.includes('timeout')) {
            return 'Timeout la conectare. Verifică host/port și firewall-ul.';
        }
        return raw;
    };

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/health`);
        const data = await res.json();
        if (data.ok) {
            if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'; resultEl.textContent = `✓ Conectat — ${data.detail || 'OK'}`; }
        } else {
            if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-red-500/10 border border-red-500/20 text-red-400'; resultEl.textContent = `✗ Eroare — ${formatHealthError(data.detail)}`; }
        }
    } catch (e) {
        if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-red-500/10 border border-red-500/20 text-red-400'; resultEl.textContent = `✗ Eroare de rețea`; }
    }
    if (btn) btn.disabled = false;
}

// --- SESSIONS (Multi-chat) ---