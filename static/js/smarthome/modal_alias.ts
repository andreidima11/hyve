/**
 * Smart home — entity alias modal.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import * as dev from './devices.js';
import { smarthomeDeviceState, smarthomeModalState } from './device_state.js';

export function openAliasModal(eid: string) {
    const modal = document.getElementById('hy-alias-modal');
    const container = document.getElementById('hy-alias-inputs');
    const titleEl = document.getElementById('hy-alias-modal-title');
    const entityEl = document.getElementById('hy-alias-modal-entity');
    if (!modal || !container) return;
    const d = smarthomeDeviceState.integrationEntitiesCache?.find(x => x.entity_id === eid);
    smarthomeModalState.haAliasModalEntityId = eid;
    if (titleEl) titleEl.textContent = t('hy.alias_modal_title');
    if (entityEl) entityEl.textContent = eid;
    container.innerHTML = '';
    const list = d?.aliases?.length ? [...d.aliases] : [''];
    list.forEach(alias => _appendAliasInput(container, alias));
    if (modal.parentNode !== document.body) {
        smarthomeModalState.haAliasModalOriginalParent = modal.parentNode;
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function _appendAliasInput(container: HTMLElement, value = '') {
    const wrap = document.createElement('div');
    wrap.className = 'flex gap-2 items-center';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'flex-1 bg-slate-900 border border-theme-subtle rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-accent outline-none';
    input.placeholder = t('hy.alias_placeholder');
    input.value = value;
    input.dataset.haAlias = '1';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'w-9 h-9 rounded-lg bg-white/5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 flex items-center justify-center flex-shrink-0';
    rm.innerHTML = '<i class="fas fa-minus text-xs"></i>';
    rm.setAttribute('aria-label', 'Remove alias');
    rm.setAttribute('data-smarthome-action', 'removeAliasRow');
    wrap.appendChild(input);
    wrap.appendChild(rm);
    container.appendChild(wrap);
}

export function addAliasInput() {
    const container = document.getElementById('hy-alias-inputs');
    if (!container) return;
    _appendAliasInput(container, '');
}

export function closeAliasModal() {
    const modal = document.getElementById('hy-alias-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (smarthomeModalState.haAliasModalOriginalParent && modal.parentNode === document.body) {
            smarthomeModalState.haAliasModalOriginalParent.appendChild(modal);
            smarthomeModalState.haAliasModalOriginalParent = null;
        }
    }
    smarthomeModalState.haAliasModalEntityId = null;
}
export async function saveAliasesFromModal() {
    if (!smarthomeModalState.haAliasModalEntityId) return;
    const container = document.getElementById('hy-alias-inputs');
    if (!container) return;
    const inputs = container.querySelectorAll('input[data-ha-alias="1"]');
    const aliases = Array.from(inputs).map(inp => (inp as HTMLInputElement).value.trim()).filter(s => s);
    const d = smarthomeDeviceState.integrationEntitiesCache?.find(x => x.entity_id === smarthomeModalState.haAliasModalEntityId);
    await apiCall('/api/integrations/entity/rename', { method: 'POST', body: { entity_id: smarthomeModalState.haAliasModalEntityId, aliases } });
    if (d) d.aliases = aliases;
    closeAliasModal();
    dev.renderDeviceCards();
}
