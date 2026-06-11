/**
 * Clipboard helpers for settings (webhook, assist keys, etc.).
 */
import { t } from '../lang/index.js';
import { showToast } from '../utils.js';
import { cfgField } from './utils.js';

export function copyToClipboard(text: string, successMessage?: string) {
    const msg = successMessage || (t('common.copied'));
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
            showToast(t('common.copy_failed'), 'error');
        }
        document.body.removeChild(ta);
    }
    return true;
}

export function copyWebhook() {
    const el = cfgField('waha_webhook');
    if (!el || !el.value) return;
    copyToClipboard(el.value, t('config.webhook_copied'));
}
