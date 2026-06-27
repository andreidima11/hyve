/**
 * First-run browser onboarding — admin account, language, timezone.
 */
import { setAuthToken, setRefreshToken, fetchWithTimeout } from './api.js';
import { t, setLanguage, applyTranslations } from './lang/index.js';
import { populateTimezoneSelect } from './timezones.js';
function _populateTimezones(preferred) {
    populateTimezoneSelect(document.getElementById('setup-timezone'), preferred);
}
let _step = 1;
let _status = {};
let _setupToken = '';
function _inputValue(id) {
    const el = document.getElementById(id);
    return el?.value || '';
}
function _showError(message) {
    const el = document.getElementById('setup-error');
    if (!el)
        return;
    if (!message) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
}
function _configureSetupTokenUi() {
    const tokenInput = document.getElementById('setup-token');
    const tokenHint = document.getElementById('setup-token-hint');
    const autoToken = String(_status.setup_token || '').trim();
    const needsManual = !!_status.requires_setup_token && !autoToken;
    _setupToken = autoToken || _setupToken;
    if (tokenInput) {
        tokenInput.classList.toggle('hidden', !needsManual);
        tokenInput.required = needsManual;
        if (autoToken)
            tokenInput.value = autoToken;
        else if (needsManual && !tokenInput.value && _setupToken)
            tokenInput.value = _setupToken;
    }
    if (tokenHint)
        tokenHint.classList.toggle('hidden', !needsManual);
}
function _updateStepUi() {
    const account = document.getElementById('setup-step-account');
    const prefs = document.getElementById('setup-step-preferences');
    const back = document.getElementById('setup-back-btn');
    const next = document.getElementById('setup-next-btn');
    const label = document.getElementById('setup-step-label');
    if (account)
        account.classList.toggle('hidden', _step !== 1);
    if (prefs)
        prefs.classList.toggle('hidden', _step !== 2);
    if (back)
        back.classList.toggle('hidden', _step === 1);
    if (next)
        next.textContent = _step === 1 ? t('setup.next') : t('setup.finish');
    if (label) {
        label.textContent = _step === 1 ? t('setup.step_account') : t('setup.step_preferences');
    }
}
function _validateStep1() {
    const token = (_status.setup_token || _inputValue('setup-token') || _setupToken).trim();
    const username = _inputValue('setup-username').trim();
    const password = _inputValue('setup-password');
    const confirm = _inputValue('setup-password-confirm');
    if (_status.requires_setup_token && !token)
        return t('setup.token_required');
    if (username.length < 3)
        return t('setup.username_too_short');
    if (password.length < 8)
        return t('setup.password_too_short');
    if (password !== confirm)
        return t('setup.password_mismatch');
    _setupToken = token;
    return '';
}
async function _submitSetup() {
    const btn = document.getElementById('setup-next-btn');
    if (btn)
        btn.disabled = true;
    _showError('');
    const payload = {
        setup_token: (_status.setup_token || _inputValue('setup-token') || _setupToken).trim(),
        username: _inputValue('setup-username').trim(),
        password: _inputValue('setup-password'),
        password_confirm: _inputValue('setup-password-confirm'),
        full_name: _inputValue('setup-fullname').trim(),
        language: _inputValue('setup-language') || 'en',
        timezone: _inputValue('setup-timezone'),
        server_name: _inputValue('setup-server-name').trim() || 'Hyve',
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
            if (key) {
                const msg = t(key, params);
                _showError(msg !== key ? msg : t('setup.failed'));
            }
            else {
                _showError(t('setup.failed'));
            }
            if (btn)
                btn.disabled = false;
            return;
        }
        if (data.access_token)
            setAuthToken(data.access_token);
        if (data.refresh_token)
            setRefreshToken(data.refresh_token);
        const lang = payload.language;
        if (lang === 'ro' || lang === 'en')
            setLanguage(lang);
        hideSetupWizard();
        if (typeof window.bootHyve === 'function') {
            await window.bootHyve();
        }
        else {
            location.reload();
        }
    }
    catch (_) {
        _showError(t('setup.failed'));
        if (btn)
            btn.disabled = false;
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
    if (!overlay)
        return;
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
    if (serverName)
        serverName.value = _status.server_name || 'Hyve';
    const langSel = document.getElementById('setup-language');
    if (langSel)
        langSel.value = _status.default_language || 'en';
    _populateTimezones(_status.default_timezone || '');
    _configureSetupTokenUi();
    _updateStepUi();
    applyTranslations();
}
export async function fetchSetupStatus() {
    const res = await fetchWithTimeout('/api/setup/status', {}, 10000);
    if (!res.ok)
        throw new Error('setup status failed');
    return res.json();
}
export function initSetupWizard() {
    const form = document.getElementById('setup-form');
    if (form)
        form.addEventListener('submit', _handleSetupSubmit);
    const back = document.getElementById('setup-back-btn');
    if (back) {
        back.addEventListener('click', () => {
            if (_step <= 1)
                return;
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
