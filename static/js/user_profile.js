import { showToast } from './utils.js';
import { t, translateApiDetail } from './lang/index.js';
import { apiCall, setAuthToken, setRefreshToken } from './api.js';
import { loadUserNotifications } from './notifications.js';
let _currentProfile = null;
function _storageKey() {
    const id = _currentProfile?.id ?? _currentProfile?.username ?? 'guest';
    return `hyve_user_profile_draft:${id}`;
}
function _readDraft() {
    try {
        return JSON.parse(localStorage.getItem(_storageKey()) || '{}');
    }
    catch (_) {
        return {};
    }
}
function _writeDraft(data) {
    try {
        localStorage.setItem(_storageKey(), JSON.stringify(data || {}));
    }
    catch (_) {
        // ignore localStorage quota/security issues
    }
}
function _titleCaseName(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return t('common.unknown');
    return raw
        .split(/([\s._-]+)/)
        .map((part) => /^[A-Za-zÀ-ž]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part)
        .join('');
}
function _splitName(fullName) {
    const raw = String(fullName || '').trim();
    if (!raw)
        return { firstName: '', lastName: '' };
    const parts = raw.split(/\s+/);
    if (parts.length === 1)
        return { firstName: parts[0], lastName: '' };
    return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}
function _inputValue(id) {
    const el = document.getElementById(id);
    return el?.value ?? '';
}
function _setValue(id, value) {
    const el = document.getElementById(id);
    if (!el)
        return;
    el.value = value ?? '';
}
function _setText(id, value) {
    const el = document.getElementById(id);
    if (!el)
        return;
    el.textContent = value ?? '';
}
function _displayName() {
    const username = String(_currentProfile?.username || '').trim();
    return _titleCaseName(username);
}
function _applyUserIdentityLabels() {
    const name = _displayName();
    _setText('nav-user-label', name);
    _setText('user-page-title', name);
}
function _populateFromProfileAndDraft() {
    const draft = _readDraft();
    const generalDraft = draft.general || {};
    const fromProfile = _splitName(_currentProfile?.full_name || _currentProfile?.fullName || '');
    _setValue('user-profile-first-name', generalDraft.firstName ?? fromProfile.firstName ?? '');
    _setValue('user-profile-last-name', generalDraft.lastName ?? fromProfile.lastName ?? '');
    _setValue('user-profile-location', generalDraft.location ?? _currentProfile?.location ?? '');
    _setValue('user-profile-about', generalDraft.about ?? _currentProfile?.about_me ?? '');
    _setValue('user-security-username', draft.security?.username ?? _currentProfile?.username ?? '');
    _setValue('user-security-email', draft.security?.email ?? _currentProfile?.email ?? '');
    _setValue('user-security-current-password', '');
    _setValue('user-security-password', '');
    _setValue('user-security-password-confirm', '');
}
async function _readApiError(res) {
    try {
        const data = await res.json();
        return translateApiDetail(data?.detail) || data?.message || t('common.unknown_error');
    }
    catch (_) {
        return t('common.unknown_error');
    }
}
function _applyUpdatedProfile(profile) {
    _currentProfile = { ...(_currentProfile || {}), ...(profile || {}) };
    _applyUserIdentityLabels();
    _populateFromProfileAndDraft();
}
export function switchUserProfileTab(tab = 'notifications') {
    const tabs = ['notifications', 'general', 'security'];
    tabs.forEach((name) => {
        const panel = document.getElementById(`user-tab-panel-${name}`);
        const btn = document.getElementById(`user-tab-btn-${name}`);
        const isActive = name === tab;
        if (panel)
            panel.classList.toggle('hidden', !isActive);
        if (btn) {
            btn.classList.toggle('config-tab-btn--active', isActive);
            btn.classList.toggle('border-accent', isActive);
            btn.classList.toggle('text-accent', isActive);
            btn.classList.toggle('border-transparent', !isActive);
            btn.classList.toggle('text-slate-500', !isActive);
        }
    });
    if (tab === 'notifications') {
        loadUserNotifications('all');
    }
}
export function setUserProfileContext(profile) {
    _currentProfile = profile || null;
    _applyUserIdentityLabels();
    _populateFromProfileAndDraft();
}
export function loadUserProfilePage() {
    _applyUserIdentityLabels();
    _populateFromProfileAndDraft();
    switchUserProfileTab('notifications');
}
export async function saveUserProfileGeneral() {
    const payload = {
        firstName: _inputValue('user-profile-first-name').trim(),
        lastName: _inputValue('user-profile-last-name').trim(),
        location: _inputValue('user-profile-location').trim(),
        about: _inputValue('user-profile-about').trim(),
    };
    try {
        const res = await apiCall('/api/users/me', {
            method: 'PATCH',
            body: {
                first_name: payload.firstName,
                last_name: payload.lastName,
                location: payload.location,
                about_me: payload.about,
            },
        });
        if (!res.ok)
            throw new Error(await _readApiError(res));
        const profile = await res.json();
        _writeDraft({});
        _applyUpdatedProfile(profile);
        showToast(t('user.general_saved'), 'success');
    }
    catch (err) {
        const draft = _readDraft();
        draft.general = payload;
        _writeDraft(draft);
        showToast(err instanceof Error ? err.message : 'Datele generale nu au putut fi salvate.', 'error');
    }
}
export async function saveUserProfileSecurity() {
    const currentPassword = _inputValue('user-security-current-password');
    const username = _inputValue('user-security-username').trim();
    const email = _inputValue('user-security-email').trim();
    const password = _inputValue('user-security-password');
    const passwordConfirm = _inputValue('user-security-password-confirm');
    if (!currentPassword) {
        showToast(t('user.current_password_required'), 'error');
        return;
    }
    if (password && password !== passwordConfirm) {
        showToast(t('user.password_mismatch'), 'error');
        return;
    }
    try {
        const res = await apiCall('/api/users/me/security', {
            method: 'PATCH',
            body: {
                current_password: currentPassword,
                username,
                email,
                new_password: password || null,
            },
        });
        if (!res.ok)
            throw new Error(await _readApiError(res));
        const profile = await res.json();
        if (profile.access_token)
            setAuthToken(profile.access_token);
        if (profile.refresh_token)
            setRefreshToken(profile.refresh_token);
        try {
            const remembered = localStorage.getItem('hyve_remember');
            if (remembered) {
                const data = JSON.parse(remembered);
                data.u = profile.username || username;
                if (profile.access_token)
                    data.t = profile.access_token;
                if (profile.refresh_token)
                    data.rt = profile.refresh_token;
                localStorage.setItem('hyve_remember', JSON.stringify(data));
            }
        }
        catch (_) { }
        _writeDraft({});
        _applyUpdatedProfile(profile);
        showToast(t('user.security_saved'), 'success');
    }
    catch (err) {
        showToast(err instanceof Error ? err.message : 'Setările de securitate nu au putut fi salvate.', 'error');
    }
}
