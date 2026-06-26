/** Boot state machine — setup, auth, dashboard first paint. */

import { clearAuthToken, initProactiveSessionRefresh, refreshSession, suppressLogout, fetchWithTimeout } from '../api.js';
import { loadUserProfile, restoreRememberedCredentials, tryAutoLogin } from '../auth.js';
import { fetchSetupStatus, showSetupWizard } from '../setup.js';
import { switchTab } from '../ui.js';
import { setLanguage, t, loadComponentTranslations } from '../lang/index.js';
import { applyDashboardEditAccess } from '../dashboard/edit_access.js';
import { initNotifications } from '../notifications.js';
import { startStartupStatusPolling } from '../startup_status.js';
import { completeBootProgress, refreshBootProgress, resetBootProgress, setBootProgress } from '../boot_progress.js';
import { setIsAdmin, setNotificationTimer } from '../user_context.js';
import { setUserProfileContext } from '../user_profile.js';
import { startLogStream } from '../ui.js';
import { loadSessionsList } from '../features.js';
import { loadModelProfiles } from '../features.js';
import { initDashboardSidebarNav, loadDashboard, withDashboardTimeout } from '../dashboard.js';
import type { HyveSetupStatus } from '../types/app.js';
import type { UserProfileResponse } from '../types/dashboard.js';

function hideBootOverlay() {
    const overlay = document.getElementById('boot-overlay');
    if (!overlay) return;
    overlay.classList.add('is-hidden');
    overlay.setAttribute('aria-busy', 'false');
    try {
        window.dispatchEvent(new CustomEvent('hyve:boot-complete'));
    } catch {
        /* ignore */
    }
}

function setBootMessage(message: string) {
    if (typeof message !== 'string' || !message.trim()) return;
    const text = document.getElementById('boot-overlay-text');
    if (text) text.textContent = message.trim();
}

function showLoginScreen() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
    }
    try { restoreRememberedCredentials(); } catch (e) {}
    hideBootOverlay();
}

function hideLoginScreen() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
}

async function loadAuthenticatedSession() {
    const profile = await loadUserProfile();
    if (!profile || !profile.username) {
        return null;
    }
    return profile;
}

async function syncUiLanguageFromConfig() {
    try {
        const res = await fetchWithTimeout('/api/config', {
            headers: { Authorization: 'Bearer ' + (localStorage.getItem('hyve_token') || '') },
        }, 10_000);
        if (!res.ok) return;
        const cfg = await res.json();
        const lang = cfg?.ui?.language;
        if (lang === 'ro' || lang === 'en') setLanguage(lang);
        await loadComponentTranslations(lang === 'ro' || lang === 'en' ? lang : undefined);
    } catch (_) {}
}

function applyProfileFlags(profile: UserProfileResponse & { id?: string | number }) {
    setIsAdmin(!!profile.is_admin);
    window.dispatchEvent(new CustomEvent('hyve:admin-context-ready', { detail: { isAdmin: !!profile.is_admin } }));
    setUserProfileContext(profile);
    try { applyDashboardEditAccess(); } catch (_) {}
    if (profile.is_admin) {
        const navAdmin = document.getElementById('nav-admin');
        if (navAdmin) navAdmin.classList.remove('hidden');
    }
}

function startBackgroundLoaders(profile: UserProfileResponse & { id?: string | number }) {
    // Fire-and-forget secondary loaders. They must NOT block the boot.
    Promise.resolve().then(() => {
        loadSessionsList().catch(e => console.warn('Sessions list load failed', e));
        if (profile.is_admin) { try { startLogStream(); } catch (e) { console.warn('Log stream failed', e); } }
        try {
            setNotificationTimer(initNotifications());
        } catch (e) { console.warn('Notifications init failed', e); }
        loadModelProfiles().catch(e => console.warn('Model profiles load failed', e));
        try { startStartupStatusPolling(); } catch (e) { console.warn('Startup status polling failed', e); }
        // Voice button visibility (cheap config probe)
        fetch('/api/integrations/catalog', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('hyve_token') }
        }).then(r => r.ok ? r.json() : null).then(data => {
            if (!data?.integrations) return;
            const whisper = data.integrations.find((i: { slug?: string }) => i.slug === 'whisper');
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && whisper) voiceBtn.classList.toggle('hidden', !whisper.enabled);
        }).catch(e => console.warn('Whisper status check failed', e));
    });
}

const BOOT_WATCHDOG_MS = 30_000;

function hasStoredCredentials(): boolean {
    try {
        const token = localStorage.getItem('hyve_token');
        const refresh = localStorage.getItem('hyve_refresh_token');
        const remember = localStorage.getItem('hyve_remember');
        return !!(
            (token && token !== 'null' && token !== 'undefined')
            || (refresh && refresh !== 'null' && refresh !== 'undefined')
            || remember
        );
    } catch {
        return false;
    }
}

async function bootHyveInternal() {
    // Always start with overlay visible. CSS transition handles the fade.
    const overlay = document.getElementById('boot-overlay');
    if (overlay) overlay.classList.remove('is-hidden');
    resetBootProgress();
    await refreshBootProgress(0, t('app.boot_loading'));

    suppressLogout(true);
    await refreshBootProgress(8, t('app.boot_step_setup'));
    let setupStatus: HyveSetupStatus | null = null;
    try {
        setupStatus = await withDashboardTimeout(
            fetchSetupStatus() as Promise<HyveSetupStatus>,
            10000,
            'Setup status timeout',
        );
    } catch (e) {
        console.warn('setup status check failed', e);
        setupStatus = { complete: false } as HyveSetupStatus;
    }
    if (!setupStatus?.complete) {
        clearAuthToken();
        try { localStorage.removeItem('hyve_remember'); } catch { /* ignore */ }
        suppressLogout(false);
        hideLoginScreen();
        showSetupWizard(setupStatus);
        completeBootProgress();
        hideBootOverlay();
        return;
    }
    suppressLogout(false);

    if (!hasStoredCredentials()) {
        setBootProgress(22, t('app.boot_step_auth'));
        completeBootProgress();
        showLoginScreen();
        return;
    }

    // Step 1: ensure we have a valid token (existing → autologin → fail)
    setBootProgress(22, t('app.boot_step_auth'));
    let stored: string | null = null;
    try { stored = localStorage.getItem('hyve_token'); } catch { stored = null; }
    let hasToken = stored && stored !== 'null' && stored !== 'undefined';
    let profile: (UserProfileResponse & { id?: string | number }) | null = null;

    if (hasToken) {
        try {
            profile = await withDashboardTimeout(loadAuthenticatedSession(), 12_000, 'Profile timeout');
        } catch (e) {
            profile = null;
        }
    }

    if (!profile) {
        // Access token expired — refresh before wiping credentials or showing login.
        try {
            if (await withDashboardTimeout(refreshSession(), 12_000, 'Refresh timeout')) {
                profile = await withDashboardTimeout(loadAuthenticatedSession(), 12_000, 'Profile timeout');
            }
        } catch {
            profile = null;
        }
    }

    if (!profile) {
        let recovered = false;
        try { recovered = await withDashboardTimeout(tryAutoLogin(), 15_000, 'Auto-login timeout'); } catch { recovered = false; }
        if (recovered) {
            try {
                profile = await withDashboardTimeout(loadAuthenticatedSession(), 12_000, 'Profile timeout');
            } catch {
                profile = null;
            }
        }
    }

    if (!profile) {
        completeBootProgress();
        showLoginScreen();
        return;
    }

    // Step 2: profile loaded. Respect deep links before the dashboard default.
    applyProfileFlags(profile);
    await refreshBootProgress(42, t('app.boot_step_config'));
    await syncUiLanguageFromConfig();
    try { initDashboardSidebarNav(); } catch (_) {}
    hideLoginScreen();
    if (routeHashToView()) {
        completeBootProgress(t('app.boot_step_ready'));
        hideBootOverlay();
        initProactiveSessionRefresh();
        startBackgroundLoaders(profile);
        return;
    }

    // No deep link: switch to dashboard FIRST (cheap), then reveal.
    await refreshBootProgress(58, t('app.boot_step_dashboard'));
    try { switchTab('dashboard'); } catch (e) { console.warn('switchTab failed', e); }

    // Step 2b: wait for the dashboard's first paint (entities + render).
    // switchTab() already kicked off loadDashboard(); the in-flight dedup
    // means this just awaits the same promise instead of double-fetching.
    await refreshBootProgress(72, t('app.boot_step_dashboard'));
    try {
        await withDashboardTimeout(loadDashboard(), 20000, 'Dashboard boot timeout');
    } catch (e) {
        console.warn('Dashboard initial load failed', e);
    }

    // Step 3: reveal app — dashboard is already populated. Heavy loaders run in background.
    completeBootProgress(t('app.boot_step_ready'));
    hideBootOverlay();
    initProactiveSessionRefresh();
    startBackgroundLoaders(profile);
}

async function bootHyve() {
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const watchdogPromise = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('Boot watchdog timeout')), BOOT_WATCHDOG_MS);
    });
    try {
        await Promise.race([bootHyveInternal(), watchdogPromise]);
    } finally {
        if (watchdog) clearTimeout(watchdog);
    }
}

window.bootHyve = bootHyve;

function routeHashToView() {
    const raw = String(window.location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0].trim().toLowerCase();
    if (!raw) return false;
    const currentTab = ['dashboard', 'chat', 'config', 'memory', 'planner', 'smarthome', 'skills', 'user']
        .find(tab => {
            const view = document.getElementById(`view-${tab}`);
            return !!view && !view.classList.contains('hidden');
        }) || '';

    if (raw === 'devices' || raw === 'smarthome') {
        if (currentTab !== 'smarthome') switchTab('smarthome', { syncHash: false });
        return true;
    }
    if (raw === 'dashboard' || raw === 'home') {
        if (currentTab !== 'dashboard') switchTab('dashboard', { syncHash: false });
        return true;
    }
    if (raw === 'chat' || raw === 'planner' || raw === 'config' || raw === 'memory' || raw === 'skills' || raw === 'user') {
        if (currentTab !== raw) switchTab(raw, { syncHash: false });
        return true;
    }
    return false;
}

export {
    bootHyve,
    routeHashToView,
    hideBootOverlay,
    showLoginScreen,
    hideLoginScreen,
    completeBootProgress,
};
