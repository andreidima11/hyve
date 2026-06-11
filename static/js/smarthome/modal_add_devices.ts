/**
 * Smart home — legacy add-devices picker modal.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr } from '../utils.js';
import * as dev from './devices.js';
import { smarthomeModalState } from './device_state.js';

export async function openAddDevicesModal() {
    // No-op: legacy Home Assistant "add devices" picker.
}

export function closeAddDevicesModal() {
    const modal = document.getElementById('add-devices-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    smarthomeModalState.availableDevices = [];
}

function _renderAvailableDevices() {
    const list = document.getElementById('add-devices-list');
    if (!list) return;
    const search = ((document.getElementById('add-devices-search') as HTMLInputElement | null)?.value || '').toLowerCase();
    const filtered = search ? smarthomeModalState.availableDevices.filter(d => `${d.name} ${d.entity_id}`.toLowerCase().includes(search)) : smarthomeModalState.availableDevices;

    if (!filtered.length) {
        list.innerHTML = `<div class="text-center text-slate-500 text-sm py-8">${search ? t('hy.no_devices_found') : t('hy.all_synced')}</div>`;
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
        const icon = dev.DOMAIN_ICONS[domain] || 'fa-microchip';
        const color = dev.DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400';
        const isActive = dev._isActiveState(String(d.state).toLowerCase());
        html += `<div class="add-device-item" data-smarthome-action="toggleAvailableDevice" data-smarthome-entity-id="${escapeHtmlAttr(d.entity_id)}">
            <input type="checkbox" class="add-device-check accent-accent cursor-pointer w-3.5 h-3.5 flex-shrink-0" value="${d.entity_id}" data-smarthome-action="toggleAvailableDevice" data-smarthome-entity-id="${escapeHtmlAttr(d.entity_id)}" data-smarthome-stop-propagation="true">
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

export function toggleAvailableDevice(el: HTMLElement, eid: string) {
    const cb = el.querySelector('.add-device-check') as HTMLInputElement | null;
    if (cb && document.activeElement !== cb) cb.checked = !cb.checked;
    el.classList.toggle('selected', cb?.checked);
    _updateAddCount();
}

export function toggleAllAvailableDevices() {
    const checks = document.querySelectorAll('.add-device-check');
    const allChecked = Array.from(checks).every(c => (c as HTMLInputElement).checked);
    checks.forEach(c => { (c as HTMLInputElement).checked = !allChecked; c.closest('.add-device-item')?.classList.toggle('selected', !allChecked); });
    _updateAddCount();
}

function _updateAddCount() {
    const count = document.querySelectorAll('.add-device-check:checked').length;
    const el = document.getElementById('add-devices-count');
    if (el) el.innerText = t('hy.bulk_selected', { count });
}

export function filterAvailableDevices() {
    _renderAvailableDevices();
}

export async function confirmAddDevices() {
    // No-op: legacy Home Assistant "add devices" picker.
    closeAddDevicesModal();
}
