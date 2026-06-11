/**
 * Whisper / Piper connection test buttons in settings.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { cfgField, cfgVal, errMsg, formatHealthError } from './utils.js';
async function savePiperAddonConfig() {
    const body = {};
    const host = cfgField('piper_host')?.value?.trim();
    const portRaw = cfgField('piper_port')?.value?.trim();
    if (host)
        body.host = host;
    if (portRaw)
        body.port = parseInt(portRaw, 10) || undefined;
    if (!Object.keys(body).length)
        return;
    await apiCall('/api/addons/piper/config', { method: 'PATCH', body });
}
export async function testWhisperConnection() {
    const btn = cfgField('whisper-test-btn');
    const resultDiv = cfgField('whisper-test-result');
    if (btn)
        btn.disabled = true;
    try {
        const host = (cfgField('whisper_host')?.value || 'localhost').trim();
        const port = parseInt(cfgVal('whisper_port'), 10) || 10300;
        const res = await apiCall(`/api/whisper/status?host=${encodeURIComponent(host)}&port=${port}`);
        const data = await res.json();
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-red-500/15', 'text-red-300', 'bg-emerald-500/15', 'text-emerald-300');
            if (data.connected) {
                resultDiv.classList.add('bg-emerald-500/15', 'text-emerald-300');
                resultDiv.innerHTML = '<i class="fas fa-check-circle mr-1"></i> ' + (t('config.whisper_test_success'));
            }
            else {
                resultDiv.classList.add('bg-red-500/15', 'text-red-300');
                resultDiv.innerHTML = '<i class="fas fa-times-circle mr-1"></i> ' + (t('config.whisper_test_fail'));
            }
        }
    }
    catch (e) {
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-emerald-500/15', 'text-emerald-300', 'bg-red-500/15', 'text-red-300');
            resultDiv.classList.add('bg-red-500/15', 'text-red-300');
            resultDiv.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i> ' + (errMsg(e) || t('common.error'));
        }
    }
    finally {
        if (btn)
            btn.disabled = false;
    }
}
;
export async function testPiperConnection() {
    const btn = cfgField('piper-test-btn');
    if (!btn)
        return;
    btn.disabled = true;
    const baseHtml = btn.innerHTML;
    const baseClass = btn.className;
    const setBtnState = (type, text) => {
        btn.innerHTML = `<i class="fas ${type === 'ok' ? 'fa-check-circle' : 'fa-times-circle'}"></i><span>${text}</span>`;
        btn.classList.remove('bg-cyan-500/15', 'hover:bg-cyan-500/25', 'text-cyan-300', 'border-cyan-500/25');
        if (type === 'ok') {
            btn.classList.add('bg-emerald-500/15', 'text-emerald-300', 'border-emerald-500/25');
        }
        else {
            btn.classList.add('bg-red-500/15', 'text-red-300', 'border-red-500/25');
        }
    };
    try {
        // Save addon config first so the health-check uses latest host/port
        await savePiperAddonConfig();
        // Use addon health-check endpoint (reads host/port from server config)
        const res = await apiCall('/api/addons/piper/health');
        const data = await res.json();
        if (data && data.ok === true) {
            setBtnState('ok', t('config.piper_test_success'));
        }
        else {
            // Fallback: if process is actually running, treat as reachable.
            let running = false;
            try {
                const sRes = await apiCall('/api/addons/piper/status');
                const s = await sRes.json();
                running = s && s.status === 'running';
            }
            catch (_) { }
            if (running) {
                setBtnState('ok', t('config.piper_test_success'));
            }
            else {
                const detail = data?.detail ? formatHealthError(data.detail) : (t('config.piper_test_fail'));
                setBtnState('fail', detail);
            }
        }
    }
    catch (e) {
        setBtnState('fail', errMsg(e) || t('common.error'));
    }
    finally {
        setTimeout(() => {
            btn.className = baseClass;
            btn.innerHTML = baseHtml;
            btn.disabled = false;
        }, 3000);
    }
}
;
