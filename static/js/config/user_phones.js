/**
 * User WhatsApp phone linking (non-admin settings).
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm } from '../utils.js';
import { cfgField } from './utils.js';
export function renderUserPhonesList(phones) {
    const listEl = cfgField('user-phones-list');
    if (!listEl)
        return;
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
            <button type="button" data-config-action="unlinkUserPhone" data-config-phone="${escNum}" class="text-[10px] text-red-400 hover:bg-red-500/20 px-2 py-0.5 rounded">${t('common.delete')}</button>
        </div>`;
    }).join('');
}
export async function addUserPhone(phone, inputEl) {
    if (!phone)
        return;
    try {
        const res = await apiCall('/api/users/link-whatsapp', { method: 'POST', body: { phone_number: phone } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || t('common.error'), 'error');
            return;
        }
        if (inputEl)
            inputEl.value = '';
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    }
    catch (e) {
        showToast(t('common.error'), 'error');
    }
}
export async function unlinkUserPhone(number) {
    if (!number || !(await showConfirm(t('config.unlink_phone_confirm'))))
        return;
    try {
        const res = await apiCall('/api/users/me/phones/unlink', { method: 'POST', body: { number } });
        if (!res.ok)
            throw new Error();
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    }
    catch (e) {
        showToast(t('common.error'), 'error');
    }
}
