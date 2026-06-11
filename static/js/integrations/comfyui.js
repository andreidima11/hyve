import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { intEl, errMsg } from './utils.js';
export async function testComfyUIConnection() {
    const resultEl = document.getElementById('comfyui-test-result');
    if (!resultEl)
        return;
    resultEl.className = 'text-xs rounded-xl p-3 bg-slate-800 text-slate-400';
    resultEl.textContent = t('common.connecting');
    resultEl.classList.remove('hidden');
    try {
        const urlVal = (intEl('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/test${qs}`);
        const data = await res.json();
        if (data.ok) {
            const stats = data.system_stats || {};
            const gpu = stats.devices?.[0]?.name || (t('common.unknown'));
            const vram = stats.devices?.[0]?.vram_total ? `${(stats.devices[0].vram_total / (1024 ** 3)).toFixed(1)} GB VRAM` : '';
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
            resultEl.textContent = `✓ ${t('config.comfyui_connected', { gpu, vram: vram ? ` — ${vram}` : '' })}`;
        }
        else {
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
            resultEl.textContent = `✗ ${data.error || t('config.comfyui_connection_failed')}`;
        }
    }
    catch (e) {
        resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
        resultEl.textContent = `✗ ${errMsg(e) || t('config.comfyui_request_failed')}`;
    }
}
;
export async function refreshComfyUICheckpoints() {
    const select = document.getElementById('comfyui_checkpoint');
    if (!select)
        return;
    const current = select.value;
    try {
        const urlVal = (intEl('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/checkpoints${qs}`);
        const data = await res.json();
        const checkpoints = data.checkpoints || [];
        select.innerHTML = `<option value="">${escapeHtml(t('config.comfyui_select_checkpoint'))}</option>`;
        for (const ckpt of checkpoints) {
            const opt = document.createElement('option');
            opt.value = ckpt;
            opt.textContent = ckpt;
            select.appendChild(opt);
        }
        if (current && checkpoints.includes(current))
            select.value = current;
        if (checkpoints.length)
            showToast(t('config.comfyui_checkpoints_found', { count: checkpoints.length }), 'success');
        else
            showToast(t('config.comfyui_no_checkpoints'), 'warning');
    }
    catch (e) {
        showToast(t('config.comfyui_checkpoints_fetch_failed', { detail: errMsg(e) || e }), 'error');
    }
}
;
export async function refreshComfyUIWorkflows() {
    const select = document.getElementById('comfyui_workflow_file');
    if (!select)
        return;
    const current = select.value;
    try {
        const res = await apiCall('/api/comfyui/workflows');
        const data = await res.json();
        const workflows = data.workflows || [];
        select.innerHTML = `<option value="">${escapeHtml(t('config.comfyui_workflow_none'))}</option>`;
        for (const wf of workflows) {
            const opt = document.createElement('option');
            opt.value = `comfyui_workflows/${wf.file}`;
            opt.textContent = wf.name;
            select.appendChild(opt);
        }
        if (current)
            select.value = current;
        if (workflows.length)
            showToast(t('config.comfyui_workflows_found', { count: workflows.length }), 'success');
        else
            showToast(t('config.comfyui_no_workflows'), 'info');
    }
    catch (e) {
        showToast(t('config.comfyui_workflows_fetch_failed', { detail: errMsg(e) || e }), 'error');
    }
}
;
export async function uploadComfyUIWorkflow(input) {
    if (!input)
        return;
    const file = input.files?.[0];
    if (!file)
        return;
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
            showToast(t('config.comfyui_workflow_uploaded', { file: data.file }), 'success');
            await refreshComfyUIWorkflows();
            // Auto-select the uploaded workflow
            const select = document.getElementById('comfyui_workflow_file');
            if (select)
                select.value = `comfyui_workflows/${data.file}`;
        }
        else {
            showToast(t('config.comfyui_upload_failed', { detail: data.error || t('common.unknown') }), 'error');
        }
    }
    catch (e) {
        showToast(t('config.comfyui_upload_failed', { detail: errMsg(e) || e }), 'error');
    }
    input.value = ''; // reset file input
}
;
