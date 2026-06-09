/**
 * First-run browser onboarding — admin account, language, timezone.
 */
import { setAuthToken, setRefreshToken } from './api.js';
import { t, setLanguage, applyTranslations } from './lang/index.js';

const COMMON_TIMEZONES = [
    'Europe/Bucharest',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Paris',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Athens',
    'Europe/Helsinki',
    'Europe/Warsaw',
    'Europe/Chisinau',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Toronto',
    'Asia/Dubai',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
    'UTC',
];

let _step = 1;
let _status = null;

function _detectTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (_) {
        return '';
    }
}

function _populateTimezones(preferred) {
    const select = document.getElementById('setup-timezone');
    if (!select) return;
    const detected = _detectTimezone();
    const values = new Set(COMMON_TIMEZONES);
    if (detected) values.add(detected);
    if (preferred) values.add(preferred);
    select.innerHTML = '';
    for (const tz of [...values].sort()) {
        const opt = document.createElement('option');
        opt.value = tz;
        opt.textContent = tz;
        select.appendChild(opt);
    }
    const pick = preferred || detected || 'Europe/Bucharest';
    if ([...select.options].some(o => o.value === pick)) {
        select.value = pick;
    }
}

function _showError(message) {
    const el = document.getElementById('setup-error');
    if (!el) return;
    if (!message) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
}

function _updateStepUi() {
    const account = document.getElementById('setup-step-account');
    const prefs = document.getElementById('setup-step-preferences');
    const back = document.getElementById('setup-back-btn');
    const next = document.getElementById('setup-next-btn');
    const label = document.getElementById('setup-step-label');
    if (account) account.classList.toggle('hidden', _step !== 1);
    if (prefs) prefs.classList.toggle('hidden', _step !== 2);
    if (back) back.classList.toggle('hidden', _step === 1);
    if (next) next.textContent = _step === 1 ? t('setup.next') : t('setup.finish');
    if (label) {
        label.textContent = _step === 1 ? t('setup.step_account') : t('setup.step_preferences');
    }
}

function _validateStep1() {
    const username = (document.getElementById('setup-username')?.value || '').trim();
    const password = document.getElementById('setup-password')?.value || '';
    const confirm = document.getElementById('setup-password-confirm')?.value || '';
    if (username.length < 3) return t('setup.username_too_short');
    if (password.length < 8) return t('setup.password_too_short');
    if (password !== confirm) return t('setup.password_mismatch');
    return '';
}

async function _submitSetup() {
    const btn = document.getElementById('setup-next-btn');
    if (btn) btn.disabled = true;
    _showError('');
    const payload = {
        username: (document.getElementById('setup-username')?.value || '').trim(),
        password: document.getElementById('setup-password')?.value || '',
        password_confirm: document.getElementById('setup-password-confirm')?.value || '',
        full_name: (document.getElementById('setup-fullname')?.value || '').trim(),
        language: document.getElementById('setup-language')?.value || 'en',
        timezone: document.getElementById('setup-timezone')?.value || '',
        server_name: (document.getElementById('setup-server-name')?.value || '').trim() || 'Hyve',
    };
    try {
        const res = await fetch('/api/setup/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const key = data?.detail?.key || data?.key;
            const params = data?.detail?.params || data?.params || {};
            if (key && typeof t === 'function') {
                const msg = t(key, params);
                _showError(msg !== key ? msg : t('setup.failed'));
            } else {
                _showError(t('setup.failed'));
            }
            if (btn) btn.disabled = false;
            return;
        }
        if (data.access_token) setAuthToken(data.access_token);
        if (data.refresh_token) setRefreshToken(data.refresh_token);
        const lang = payload.language;
        if (lang === 'ro' || lang === 'en') setLanguage(lang);
        hideSetupWizard();
        if (typeof window.bootHyve === 'function') {
            await window.bootHyve();
        } else {
            location.reload();
        }
    } catch (_) {
        _showError(t('setup.failed'));
        if (btn) btn.disabled = false;
    }
}

async function _handleSetupSubmit(e) {
    e.preventDefault();
    _showError('');
    if (_step === 1) {
        const err = _validateStep1();
        if (err) {
            _showError(err);
            return;
        }
        _step = 2;
        const langSel = document.getElementById('setup-language');
        if (langSel) {
            const browserLang = (navigator.language || '').toLowerCase();
            langSel.value = browserLang.startsWith('ro') ? 'ro' : 'en';
            setLanguage(langSel.value);
            applyTranslations();
        }
        _updateStepUi();
        return;
    }
    await _submitSetup();
}

export function hideSetupWizard() {
    const overlay = document.getElementById('setup-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
}

export function showSetupWizard(status) {
    _status = status || {};
    _step = 1;
    const overlay = document.getElementById('setup-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
    }
    const serverName = document.getElementById('setup-server-name');
    if (serverName) serverName.value = _status.server_name || 'Hyve';
    const langSel = document.getElementById('setup-language');
    if (langSel) langSel.value = _status.default_language || 'en';
    _populateTimezones(_status.default_timezone || '');
    _updateStepUi();
    applyTranslations();
}

export async function fetchSetupStatus() {
    const res = await fetch('/api/setup/status');
    if (!res.ok) throw new Error('setup status failed');
    return res.json();
}

export function initSetupWizard() {
    const form = document.getElementById('setup-form');
    if (form) form.addEventListener('submit', _handleSetupSubmit);
    const back = document.getElementById('setup-back-btn');
    if (back) {
        back.addEventListener('click', () => {
            if (_step <= 1) return;
            _step = 1;
            _showError('');
            _updateStepUi();
        });
    }
    const langSel = document.getElementById('setup-language');
    if (langSel) {
        langSel.addEventListener('change', () => {
            const v = langSel.value;
            if (v === 'ro' || v === 'en') {
                setLanguage(v);
                applyTranslations();
                _updateStepUi();
            }
        });
    }
}
