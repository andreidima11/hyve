import { loadMemory, loadSmarthome, loadConfig, loadAdminUsers, loadSkills, loadModelProfiles, disconnectSmarthomeLive, refreshIntegrationsSettingsView, loadNotificationPrefs, loadAutomations, loadUpdatesAddons, loadBackupPanel, toggleVoiceRecording } from './features.js';
import { loadUserProfilePage } from './user_profile.js';
import { loadPlanner, loadApps, loadScenes, loadAreas, populateAppTab, closeAddonWebUI } from './nav_bridge.js';
import { loadDashboard, dashboardHasRenderedContent, resetDashboardEditingState, disconnectDashboardLive, initDashboardSidebarNav } from './dashboard.js';
import { applyDashboardEditAccess } from './dashboard/edit_access.js';
import { closeAllSubPages } from './utils.js';
import { t, applyTranslations } from './lang/index.js';
import type { SidebarGestureMode, StandaloneActivePanel, SwitchTabOptions } from './types/ui.js';

let logEventSource: EventSource | null = null;
let _logReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _dashboardReturnRetryTimer: ReturnType<typeof setTimeout> | null = null;

function _tabHash(tabId: string) {
    const allowed = new Set(['dashboard', 'chat', 'config', 'memory', 'planner', 'smarthome', 'skills', 'user']);
    if (!allowed.has(tabId)) return '';
    if (tabId === 'dashboard') {
        let pid = '';
        try { pid = String(localStorage.getItem('hyve.lastDashboardPageId') || '').trim(); } catch (_) {}
        if (pid) return `#/dashboard/${encodeURIComponent(pid)}`;
    }
    return `#/${tabId}`;
}

const FALLBACK_THEME_OPTIONS = [
    { id: 'canvas', selector: 'canvas', label: 'Canvas', preview: ['#0a0a0a', '#171717', '#a8c7fa'] },
    { id: 'obsidian', selector: 'dark', label: 'Obsidian', preview: ['#030712', '#0f172a', '#38bdf8'] },
    { id: 'daylight', selector: 'light', label: 'Daylight', preview: ['#f8fafc', '#e2e8f0', '#2563eb'] },
];

const THEME_REGISTRY = window.__HYVE_THEME_REGISTRY__ || null;
const THEME_OPTIONS = Array.isArray(THEME_REGISTRY?.themeOptions) ? THEME_REGISTRY.themeOptions : FALLBACK_THEME_OPTIONS;

function resolveTheme(themeName: string) {
    if (typeof THEME_REGISTRY?.resolveTheme === 'function') {
        return THEME_REGISTRY.resolveTheme(themeName);
    }
    return THEME_OPTIONS.find(theme => theme.id === themeName) || THEME_OPTIONS[0];
}

export function getStoredThemeId() {
    if (typeof THEME_REGISTRY?.getStoredThemeId === 'function') {
        return THEME_REGISTRY.getStoredThemeId();
    }
    return localStorage.getItem('hyve_theme') || 'canvas';
}

export function getStoredThemeSelector() {
    if (typeof THEME_REGISTRY?.getStoredThemeSelector === 'function') {
        return THEME_REGISTRY.getStoredThemeSelector();
    }
    const storedSelector = localStorage.getItem('hyve_theme_selector');
    if (storedSelector) return storedSelector;
    return resolveTheme(getStoredThemeId()).selector;
}

function _sidebarElements() {
    return {
        sb: document.getElementById('sidebar'),
        backdrop: document.getElementById('sidebar-backdrop')
    };
}

export function isSidebarOpen() {
    const { sb } = _sidebarElements();
    return !!(sb && !sb.classList.contains('-translate-x-full'));
}

function _syncAddonUiSidebarState(open: boolean) {
    const viewer = document.getElementById('addon-ui-viewer');
    if (viewer) {
        viewer.classList.toggle('sidebar-open', open);
    }
    const viewerOpen = viewer?.classList.contains('open');
    document.body.classList.toggle('addon-ui-sidebar-active', open && viewerOpen);
}

export function openSidebar() {
    const { sb, backdrop } = _sidebarElements();
    if (!sb) return;
    sb.classList.add('transitioning');
    sb.classList.remove('-translate-x-full');
    if (backdrop) backdrop.classList.add('visible');
    _syncAddonUiSidebarState(true);
    
    // Remove transitioning class after animation completes
    setTimeout(() => {
        sb.classList.remove('transitioning');
    }, 250);
}

export function closeSidebar() {
    const { sb, backdrop } = _sidebarElements();
    if (!sb) return;
    sb.classList.add('transitioning');
    sb.classList.add('-translate-x-full');
    if (backdrop) backdrop.classList.remove('visible');
    _syncAddonUiSidebarState(false);
    
    // Remove transitioning class after animation completes
    setTimeout(() => {
        sb.classList.remove('transitioning');
    }, 250);
}

export function setTheme(themeName: string) {
    const theme = resolveTheme(themeName);
    document.documentElement.setAttribute('data-theme', theme.selector);
    localStorage.setItem('hyve_theme', theme.id);
    localStorage.setItem('hyve_theme_selector', theme.selector);

    document.querySelectorAll('.theme-option').forEach(option => {
        (option as HTMLElement).classList.toggle('theme-option-active', (option as HTMLElement).dataset.themeId === theme.id);
    });
    
    // Update Android system bar + background color to match active theme.
    // Use rAF so the browser recalculates styles after data-theme change.
    if (window.__setNativeSystemBarColor) {
        requestAnimationFrame(() => {
            const metaColor = getComputedStyle(document.documentElement)
                .getPropertyValue('--meta-theme-color').trim();
            const color = metaColor || '#030712';
            window.__setNativeSystemBarColor?.(color);
            try { localStorage.setItem('hyve_theme_color', color); } catch(_) {}
        });
    }
}

export function loadThemeSelector() {
    const grid = document.getElementById('theme-selector-grid');
    if (!grid) return;

    const currentThemeId = getStoredThemeId();
    grid.innerHTML = THEME_OPTIONS.map(theme => `
        <button
            type="button"
            class="theme-option ${theme.id === currentThemeId ? 'theme-option-active' : ''}"
            data-theme-id="${theme.id}"
            data-config-action="setTheme" data-config-theme-id="${theme.id}"
            aria-label="${theme.label} theme"
        >
            <div class="theme-option-preview" aria-hidden="true">
                ${theme.preview.map(color => `<span class="theme-preview-swatch" style="background:${color}"></span>`).join('')}
            </div>
            <span class="theme-option-name">${theme.label}</span>
        </button>
    `).join('');
}

export function toggleSidebar() {
    if (isSidebarOpen()) closeSidebar();
    else openSidebar();
}

let _sidebarGesturesInitialized = false;

export function initSidebarGestures() {
    if (_sidebarGesturesInitialized) return;
    _sidebarGesturesInitialized = true;

    let startX = 0;
    let startY = 0;
    let mode: SidebarGestureMode = null;

    const EDGE_OPEN_ZONE = 28;
    const MIN_X_DISTANCE = 70;

    document.addEventListener('touchstart', (event) => {
        if (window.innerWidth >= 1024) {
            mode = null;
            return;
        }
        const touch = event.touches?.[0];
        if (!touch) return;

        startX = touch.clientX;
        startY = touch.clientY;
        mode = null;

        const { sb } = _sidebarElements();
        const sidebarOpen = isSidebarOpen();

        if (!sidebarOpen && startX <= EDGE_OPEN_ZONE) {
            mode = 'open';
            return;
        }

        if (sidebarOpen && sb) {
            const rect = sb.getBoundingClientRect();
            const insideSidebar = startX >= rect.left && startX <= rect.right && startY >= rect.top && startY <= rect.bottom;
            if (insideSidebar) mode = 'close';
        }
    }, { passive: true });

    document.addEventListener('touchend', (event) => {
        if (!mode || window.innerWidth >= 1024) {
            mode = null;
            return;
        }
        const touch = event.changedTouches?.[0];
        if (!touch) {
            mode = null;
            return;
        }

        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        const mostlyHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;

        if (mode === 'open' && mostlyHorizontal && dx > MIN_X_DISTANCE) {
            openSidebar();
        } else if (mode === 'close' && mostlyHorizontal && dx < -MIN_X_DISTANCE) {
            closeSidebar();
        }

        mode = null;
    }, { passive: true });
}

export function switchTab(tabId: string, options: SwitchTabOptions = {}) {
    try { initDashboardSidebarNav(); } catch (_) {}
    const shouldSyncHash = options.syncHash !== false;

    if (_dashboardReturnRetryTimer) {
        clearTimeout(_dashboardReturnRetryTimer);
        _dashboardReturnRetryTimer = null;
    }

    closeAddonWebUI();
    closeAllSubPages();
    if (tabId !== 'dashboard') {
        try { disconnectDashboardLive(); } catch (_) {}
        resetDashboardEditingState();
        // Hide the dashboard-only header controls (3-dots menu, density
        // toggle, etc.) when leaving the dashboard tab.
        const dashMenuWrap = document.getElementById('dashboard-header-menu-wrap');
        if (dashMenuWrap) {
            dashMenuWrap.classList.add('hidden');
            dashMenuWrap.classList.remove('flex');
        }
    }
    ['dashboard', 'chat', 'config', 'memory', 'planner', 'smarthome', 'skills', 'user'].forEach(tab => {
        const view = document.getElementById(`view-${tab}`);
        const btn = document.getElementById(`nav-${tab}`);
        if (view) view.classList.add('hidden');
        if (btn) btn.classList.remove('bg-white/10', 'text-accent', 'border-accent/10');
    });

    // Clear active state on dashboard page nav buttons when leaving the dashboard tab.
    if (tabId !== 'dashboard') {
        document.querySelectorAll('.dashboard-page-nav-btn').forEach(btn => {
            btn.classList.remove('bg-white/10', 'text-accent', 'border-accent/10');
        });
    }

    const targetView = document.getElementById(`view-${tabId}`);
    const targetBtn = document.getElementById(`nav-${tabId}`);
    if (targetView) targetView.classList.remove('hidden');
    if (targetBtn) targetBtn.classList.add('bg-white/10', 'text-accent', 'border-accent/10');

    const sidebarConversations = document.getElementById('sidebar-conversations');
    if (sidebarConversations) {
        sidebarConversations.classList.toggle('hidden', tabId !== 'chat');
    }

    // Update mobile nav active state
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    const titleEl = document.getElementById('current-view-title');
    const titleKeys: Record<string, string> = { chat: 'nav.chat', memory: 'nav.intelligence', smarthome: 'nav.smarthome', skills: 'nav.skills', config: 'nav.config' };
    const userLabel = document.getElementById('nav-user-label')?.textContent?.trim() || 'Utilizator';
    const plainTitles: Record<string, string> = { planner: t('nav.planner'), user: userLabel };
    if (titleEl) {
        if (tabId === 'dashboard') {
            // For the dashboard tab, the title is the *active page* name (not
            // the literal word "Dashboard"). Use the cached last-known title
            // for an instant render; loadDashboard() will refresh it from
            // the real page config as soon as it resolves.
            titleEl.removeAttribute('data-i18n');
            let cachedTitle = '';
            try { cachedTitle = localStorage.getItem('hyve.lastDashboardTitle') || ''; } catch (_) {}
            titleEl.innerText = cachedTitle || '…';
        } else if (titleKeys[tabId]) {
            titleEl.setAttribute('data-i18n', titleKeys[tabId]);
            titleEl.innerText = t(titleKeys[tabId]);
        } else {
            titleEl.removeAttribute('data-i18n');
            titleEl.innerText = plainTitles[tabId] || tabId;
        }
    }

    const metaEl = document.getElementById('current-view-meta');
    if (metaEl) {
        metaEl.textContent = '';
        metaEl.classList.add('hidden');
        metaEl.classList.remove('inline-flex');
    }

    const menuBtn = document.getElementById('app-header-menu-btn');
    if (menuBtn) {
        menuBtn.classList.remove('hidden');
        menuBtn.classList.add('flex');
    }

    const actionsEl = document.getElementById('view-header-actions');
    if (actionsEl) {
        actionsEl.innerHTML = '';
        actionsEl.classList.add('hidden');
        actionsEl.classList.remove('flex');
    }

    if (tabId === 'dashboard') {
        try { applyDashboardEditAccess(); } catch (_) {}
        const hasContent = dashboardHasRenderedContent();
        loadDashboard(hasContent ? { soft: true } : { force: true });
        // Single safety retry: if 2.5s later the grid still shows only a
        // placeholder/error (meaning the fetch failed or never started),
        // force one more refresh. Dashboard cache should render instantly
        // from _loadDashboardImpl, so we don't need aggressive retries.
        _dashboardReturnRetryTimer = window.setTimeout(() => {
            _dashboardReturnRetryTimer = null;
            const view = document.getElementById('view-dashboard');
            if (!view || view.classList.contains('hidden')) return;
            const grid = document.getElementById('dashboard-grid');
            const text = String(grid?.textContent || '');
            const stuck = !grid || !grid.firstElementChild
                || text.includes('Se încarcă dashboard-ul')
                || text.includes('Se încarcă pagina')
                || text.includes('Încărcarea paginii a expirat')
                || text.includes('Refresh-ul dashboardului a expirat')
                || text.includes('Nu am putut încărca')
                || text.includes('Eroare la încărcare');
            if (stuck) loadDashboard({ force: true });
        }, 2500);
    }
    if (tabId === 'memory') loadMemory();
    if (tabId === 'planner') loadPlanner();
    if (tabId === 'config') {
        // Show hub, hide detail + standalone; return any borrowed panel
        closeConfigSection();
        // Defer data loading so tab switch renders immediately
        requestAnimationFrame(() => {
            loadConfig();
            loadModelProfiles();
        });
    }
    if (tabId === 'smarthome') loadSmarthome();
    else { try { disconnectSmarthomeLive(); } catch (_) {} }
    if (tabId === 'skills') loadSkills();
    if (tabId === 'user') loadUserProfilePage();

    // Stop voice recording when navigating away from chat
    if (tabId !== 'chat') {
        const voiceBtn = document.getElementById('btn-voice');
        if (voiceBtn && voiceBtn.classList.contains('recording')) {
            toggleVoiceRecording({ btn: voiceBtn });
        }
    }

    // Close sidebar on mobile/tablet
    if (window.innerWidth < 1024) {
        if (isSidebarOpen()) closeSidebar();
    }

    // Keep the main tab in the URL so refresh restores the same view.
    if (shouldSyncHash) {
        const nextHash = _tabHash(tabId);
        if (nextHash) {
            const current = String(window.location.hash || '');
            const keepDashboardSubroute = tabId === 'dashboard' && /^#\/?dashboard\//i.test(current);
            if (!keepDashboardSubroute && current !== nextHash) {
                window.location.hash = nextHash;
            }
        }
        try { localStorage.setItem('hyve.lastMainTab', tabId); } catch (_) {}
    }
}

function _restoreStandalonePanel() {
    if (!_standaloneActivePanel) return;
    const { panel, parent } = _standaloneActivePanel;
    if (parent && panel) {
        parent.appendChild(panel);
        panel.classList.add('hidden');
    }
    _standaloneActivePanel = null;
}

export function switchConfigTab(tabName: string) {
    document.querySelectorAll('#config-panels > .cfg-tab-panel').forEach(panel => {
        panel.classList.add('hidden');
    });
    document.querySelectorAll('[id^="tab-btn-"]').forEach(btn => {
        btn.classList.remove('is-active', 'config-tab-btn--active', 'border-accent', 'text-accent', 'border-transparent', 'text-slate-500');
        btn.setAttribute('aria-selected', 'false');
    });

    const targetContent = document.getElementById(`cfg-tab-${tabName}`);
    const targetBtn = document.getElementById(`tab-btn-${tabName}`);
    if (targetContent) targetContent.classList.remove('hidden');
    if (targetBtn) {
        targetBtn.classList.add('is-active', 'config-tab-btn--active');
        targetBtn.setAttribute('aria-selected', 'true');
    }

    if (tabName === 'users') loadAdminUsers();
    if (tabName === 'app') populateAppTab();
    if (tabName === 'scenes') loadScenes();
    if (tabName === 'areas') loadAreas();
    if (tabName === 'notifications') loadNotificationPrefs();
    if (tabName === 'integrations') {
        refreshIntegrationsSettingsView('auto');
    }
}

const _configSectionTabs = {
    settings: ['general', 'prompts', 'intelligence', 'memory', 'notifications', 'security'],
};

const _configSectionTitles: Record<string, string> = {
    settings: 'config.hub_settings_title',
    integrations: 'config.hub_integrations_title',
    automations: 'config.hub_automations_title',
    memories: 'config.hub_memories_title',
    appearance: 'config.hub_appearance_title',
    users: 'config.hub_users_title',
    logs: 'config.hub_logs_title',
    app: 'config.hub_app_title',
    addons: 'config.hub_addons_title',
    scenes: 'config.hub_scenes_title',
    areas: 'config.hub_areas_title',
    updates: 'config.hub_updates_title',
    backup: 'config.hub_backup_title',
};

const _configSectionSubtitles: Record<string, string> = {
    settings: 'config.subtitle',
    integrations: 'config.section_integrations_subtitle',
    automations: 'config.section_automations_subtitle',
    memories: 'config.section_memories_subtitle',
    appearance: 'config.section_appearance_subtitle',
    users: 'config.section_users_subtitle',
    logs: 'config.section_logs_subtitle',
    app: 'config.section_app_subtitle',
    addons: 'config.section_addons_subtitle',
    scenes: 'config.section_scenes_subtitle',
    areas: 'config.section_areas_subtitle',
    updates: 'config.hub_updates_desc',
    backup: 'config.hub_backup_desc',
};

const _standaloneSections = ['integrations', 'automations', 'memories', 'appearance', 'users', 'logs', 'app', 'addons', 'scenes', 'areas', 'updates', 'backup'];

// Map config sections to their DOM panel IDs (for panels that live outside config)
const _sectionPanelIds: Record<string, string> = {
    automations: 'intelligence-panel-automations',
    memories: 'intelligence-panel-memories',
};

// Track where we moved the panel from so we can return it
let _standaloneActivePanel: StandaloneActivePanel | null = null;

function _setStandaloneActions(section: string) {
    document.querySelectorAll('[data-standalone-actions]').forEach((el) => {
        const group = el as HTMLElement;
        group.classList.toggle('hidden', group.dataset.standaloneActions !== section);
    });
}

export function openConfigSection(section: string) {
    // External views — navigate away from config
    if (section === 'smarthome') { switchTab('smarthome'); return; }
    if (section === 'devices') { switchTab('smarthome'); return; }
    if (section === 'skills') { switchTab('skills'); return; }

    const hub = document.getElementById('config-hub');
    const detail = document.getElementById('config-detail');
    const standalone = document.getElementById('config-standalone');
    if (hub) hub.classList.add('hidden');

    if (_standaloneSections.includes(section)) {
        // --- Standalone page ---
        if (detail) detail.classList.add('hidden');
        if (standalone) standalone.classList.remove('hidden');

        const titleEl = document.getElementById('config-standalone-title');
        const subtitleEl = document.getElementById('config-standalone-subtitle');
        if (titleEl) titleEl.textContent = t(_configSectionTitles[section] || section);
        if (subtitleEl) {
            const subtitle = _configSectionSubtitles[section] ? t(_configSectionSubtitles[section]) : '';
            subtitleEl.textContent = subtitle;
            subtitleEl.classList.toggle('hidden', !subtitle);
        }

        _setStandaloneActions(section);
        applyTranslations();
        const panelId = _sectionPanelIds[section] || `cfg-tab-${section}`;
        const panel = document.getElementById(panelId);
        const body = document.getElementById('config-standalone-body');
        if (_standaloneActivePanel?.panel?.id !== panelId) {
            _restoreStandalonePanel();
        }
        if (panel && body) {
            _standaloneActivePanel = { panel, parent: panel.parentElement };
            body.appendChild(panel);
            panel.classList.remove('hidden');
        }

        // Trigger section-specific loaders
        if (section === 'integrations') refreshIntegrationsSettingsView('auto');
        if (section === 'users') loadAdminUsers();
        if (section === 'app') populateAppTab();
        if (section === 'notifications') loadNotificationPrefs();
        if (section === 'logs') startLogStream();
        if (section === 'memories') loadMemory();
        if (section === 'automations') loadAutomations();
        if (section === 'addons') loadApps();
        if (section === 'scenes') loadScenes();
        if (section === 'areas') loadAreas();
        if (section === 'updates') loadUpdatesAddons();
        if (section === 'backup') loadBackupPanel();

    } else {
        // --- Settings with tabs ---
        _restoreStandalonePanel();
        if (standalone) standalone.classList.add('hidden');
        _setStandaloneActions('');
        if (detail) detail.classList.remove('hidden');
        switchConfigTab('general');
    }
}

export function closeConfigSection() {
    closeAddonWebUI();
    // Stop log SSE stream when leaving the config section
    stopLogStream();

    _restoreStandalonePanel();

    const hub = document.getElementById('config-hub');
    const detail = document.getElementById('config-detail');
    const standalone = document.getElementById('config-standalone');
    if (hub) hub.classList.remove('hidden');
    if (detail) detail.classList.add('hidden');
    if (standalone) standalone.classList.add('hidden');
    _setStandaloneActions('');
}

export async function startLogStream() {
    if (logEventSource) return;

    const container = document.getElementById('log-content');
    const wrapper = document.getElementById('log-terminal');
    
    // Get short-lived exchange token for SSE (avoids passing long-lived JWT in URL)
    let token;
    try {
        const { getSSEToken } = await import('./api.js');
        token = await getSSEToken();
    } catch (_) {
        token = '';
    }
    logEventSource = new EventSource(`/api/logs?token=${encodeURIComponent(token)}`);

    logEventSource.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            const div = document.createElement('div');
            div.className = "mb-1 font-mono text-[10px] whitespace-pre-wrap py-0.5 border-l border-transparent hover:bg-white/[0.02] transition-colors pl-2";
            
            // Colorare mesaje ca în terminal
            if (msg.includes("ERROR") || msg.includes("❌")) {
                div.classList.add("text-red-500", "bg-red-500/5", "border-red-500/30");
            } else if (msg.includes("SUCCESS") || msg.includes("✅")) {
                div.classList.add("text-accent");
            } else if (msg.includes("⏰") || msg.includes("WARNING")) {
                div.classList.add("text-yellow-500");
            } else if (msg.includes("🌐")) {
                div.classList.add("text-blue-400");
            } else {
                div.classList.add("text-slate-400");
            }

            div.textContent = msg;
            container?.appendChild(div);

            // Scroll la final automat
            if (wrapper) {
                wrapper.scrollTop = wrapper.scrollHeight;
            }

            // Păstrăm ultimele 200 de linii ca să nu omorâm browserul
            if (container && container.childElementCount > 200) {
                const first = container.firstChild;
                if (first) container.removeChild(first);
            }
        } catch (err) {
            console.error("Log parse error", err);
        }
    };

    logEventSource.onerror = () => {
        stopLogStream();
        // Reconnect after 3s — tracked so we don't duplicate
        if (_logReconnectTimer) clearTimeout(_logReconnectTimer);
        _logReconnectTimer = setTimeout(() => {
            _logReconnectTimer = null;
            startLogStream();
        }, 3000);
    };
}

export function stopLogStream() {
    if (_logReconnectTimer) { clearTimeout(_logReconnectTimer); _logReconnectTimer = null; }
    if (logEventSource) {
        logEventSource.close();
        logEventSource = null;
    }
}