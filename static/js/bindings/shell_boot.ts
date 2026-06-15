/** Shell boot — i18n, theme, login, bootHyve (before/after delegated handlers). */

import { clearAuthToken } from '../api.js';
import { showToast } from '../utils.js';
import { handleLogin } from '../auth.js';
import { initSetupWizard } from '../setup.js';
import { setTheme, loadThemeSelector, initSidebarGestures, getStoredThemeId } from '../ui.js';
import { initI18n, t } from '../lang/index.js';
import { applyInitialGreeting } from '../chat.js';
import { initThinkingModeSelector } from '../thinking_mode.js';
import { initDashboardSidebarNav } from '../dashboard.js';
import { initHyColorPickerBindings } from '../light_controls.js';
import { bootHyve, initNativeAppBridge, routeHashToView, showLoginScreen } from '../boot/index.js';
import { completeBootProgress } from '../boot/state.js';

export function initShellPreBindings(): void {
// 0. Inițializăm limba UI

initI18n();

try {

    const expired = new URLSearchParams(window.location.search).has('_expired');
    if (expired) {
        showToast(t('login.session_expired'), 'warning');

        const clean = new URL(window.location.href);
        clean.searchParams.delete('_expired');

        window.history.replaceState(null, '', clean.pathname + clean.hash);
    }

} catch (_) {}

initThinkingModeSelector();
}

export function initShellPostBindings(): void {
initHyColorPickerBindings();
try { initDashboardSidebarNav(); } catch (_) {}
applyInitialGreeting();

// 0.1 Sidebar gestures (mobile): swipe right from edge to open,

// swipe left on sidebar to close.

initSidebarGestures();

// 1. Aplicăm tema salvată
setTheme(getStoredThemeId());
loadThemeSelector();

// 1.1 Reveal native-app-only elements if running inside the Hyve Android app

initNativeAppBridge();

// 2. Bind la formularele principale (FastAPI form-data format)

const loginForm = document.getElementById('login-form');
if (loginForm) loginForm.onsubmit = handleLogin;

initSetupWizard();

// 3. Auth + app boot — single deterministic state machine.
bootHyve().catch(err => {
    console.error('bootHyve failed', err);

    try { clearAuthToken(); } catch (_) {}
    completeBootProgress();
    showLoginScreen();
});

window.addEventListener('hashchange', routeHashToView);
}
