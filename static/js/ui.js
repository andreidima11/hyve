import { loadMemory, loadSmarthome, loadConfig, loadAdminUsers, loadSkills, loadModelProfiles } from './features.js';
import { loadPlanner } from './planner.js';
import { closeAllSubPages } from './utils.js';
import { t } from './lang/index.js';

let logEventSource = null;
let _logReconnectTimer = null;

const FALLBACK_THEME_OPTIONS = [
    { id: 'obsidian', selector: 'dark', label: 'Obsidian', preview: ['#030712', '#0f172a', '#38bdf8'] },
    { id: 'midnight', selector: 'midnight', label: 'Midnight', preview: ['#111111', '#1f1f1f', '#f59e0b'] },
    { id: 'midnight-white', selector: 'midnight', label: 'Midnight White', preview: ['#111111', '#2a2a2a', '#ffffff'] },
    { id: 'moonlight', selector: 'midnight', label: 'Moonlight', preview: ['#111111', '#242938', '#ffffff'] },
    { id: 'daylight', selector: 'light', label: 'Daylight', preview: ['#f8fafc', '#e2e8f0', '#2563eb'] },
    { id: 'canvas', selector: 'canvas', label: 'Canvas', preview: ['#0a0a0a', '#171717', '#a8c7fa'] },
    { id: 'terra', selector: 'prism', label: 'Terra', preview: ['#171312', '#2c2420', '#d97757'] },
];

const THEME_REGISTRY = window.__MEMINI_THEME_REGISTRY__ || null;
const THEME_OPTIONS = Array.isArray(THEME_REGISTRY?.themeOptions) ? THEME_REGISTRY.themeOptions : FALLBACK_THEME_OPTIONS;

function resolveTheme(themeName) {
    if (typeof THEME_REGISTRY?.resolveTheme === 'function') {
        return THEME_REGISTRY.resolveTheme(themeName);
    }
    return THEME_OPTIONS.find(theme => theme.id === themeName) || THEME_OPTIONS[0];
}

export function getStoredThemeId() {
    if (typeof THEME_REGISTRY?.getStoredThemeId === 'function') {
        return THEME_REGISTRY.getStoredThemeId();
    }
    return localStorage.getItem('memini_theme') || 'obsidian';
}

export function getStoredThemeSelector() {
    if (typeof THEME_REGISTRY?.getStoredThemeSelector === 'function') {
        return THEME_REGISTRY.getStoredThemeSelector();
    }
    const storedSelector = localStorage.getItem('memini_theme_selector');
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

export function openSidebar() {
    const { sb, backdrop } = _sidebarElements();
    if (!sb) return;
    sb.classList.add('transitioning');
    sb.classList.remove('-translate-x-full');
    if (backdrop) backdrop.classList.add('visible');
    
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
    
    // Remove transitioning class after animation completes
    setTimeout(() => {
        sb.classList.remove('transitioning');
    }, 250);
}

export function setTheme(themeName) {
    const theme = resolveTheme(themeName);
    document.documentElement.setAttribute('data-theme', theme.selector);
    localStorage.setItem('memini_theme', theme.id);
    localStorage.setItem('memini_theme_selector', theme.selector);

    document.querySelectorAll('.theme-option').forEach(option => {
        option.classList.toggle('theme-option-active', option.dataset.themeId === theme.id);
    });
    
    // Update Android system bar + background color to match active theme.
    // Use rAF so the browser recalculates styles after data-theme change.
    if (window.__setNativeSystemBarColor) {
        requestAnimationFrame(() => {
            const metaColor = getComputedStyle(document.documentElement)
                .getPropertyValue('--meta-theme-color').trim();
            const color = metaColor || '#030712';
            window.__setNativeSystemBarColor(color);
            try { localStorage.setItem('memini_theme_color', color); } catch(_) {}
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
            onclick="window.setTheme('${theme.id}')"
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

export function initSidebarGestures() {
    if (window.__meminiSidebarGesturesInitialized) return;
    window.__meminiSidebarGesturesInitialized = true;

    let startX = 0;
    let startY = 0;
    let mode = null;

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

export function switchTab(tabId) {
    closeAllSubPages();
    ['chat', 'conference', 'config', 'memory', 'planner', 'smarthome', 'skills'].forEach(tab => {
        const view = document.getElementById(`view-${tab}`);
        const btn = document.getElementById(`nav-${tab}`);
        if (view) view.classList.add('hidden');
        if (btn) btn.classList.remove('bg-white/10', 'text-accent', 'border-accent/10');
    });

    const targetView = document.getElementById(`view-${tabId}`);
    const targetBtn = document.getElementById(`nav-${tabId}`);
    if (targetView) targetView.classList.remove('hidden');
    if (targetBtn) targetBtn.classList.add('bg-white/10', 'text-accent', 'border-accent/10');

    // Update mobile nav active state
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    const titleEl = document.getElementById('current-view-title');
    const titleKeys = { chat: 'nav.chat', conference: 'nav.conference', memory: 'nav.intelligence', smarthome: 'nav.smarthome', skills: 'nav.skills', config: 'nav.config' };
    const plainTitles = { planner: 'Planner' };
    if (titleEl) titleEl.innerText = plainTitles[tabId] || (titleKeys[tabId] ? t(titleKeys[tabId]) : tabId);

    const metaEl = document.getElementById('current-view-meta');
    if (metaEl && tabId !== 'conference') {
        metaEl.textContent = '';
        metaEl.classList.add('hidden');
        metaEl.classList.remove('inline-flex');
    }

    const backBtn = document.getElementById('conference-header-back');
    if (backBtn && tabId !== 'conference') {
        backBtn.classList.add('hidden');
        backBtn.classList.remove('inline-flex');
    }

    const menuBtn = document.getElementById('app-header-menu-btn');
    if (menuBtn && tabId !== 'conference') {
        menuBtn.classList.remove('hidden');
        menuBtn.classList.add('flex');
    }

    const actionsEl = document.getElementById('view-header-actions');
    if (actionsEl && tabId !== 'conference') {
        actionsEl.innerHTML = '';
        actionsEl.classList.add('hidden');
        actionsEl.classList.remove('flex');
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
    if (tabId === 'skills') loadSkills();
    if (tabId === 'conference') {
        if (window._confInit) window._confInit();
    }

    // Stop voice recording when navigating away from chat
    if (tabId !== 'chat' && typeof window.toggleVoiceRecording === 'function') {
        const voiceBtn = document.getElementById('btn-voice');
        if (voiceBtn && voiceBtn.classList.contains('recording')) {
            window.toggleVoiceRecording({ btn: voiceBtn });
        }
    }

    // Close sidebar on mobile/tablet
    if (window.innerWidth < 1024) {
        if (isSidebarOpen()) closeSidebar();
    }
}

export function switchConfigTab(tabName) {
    // Auto-detect: ascundem TOATE panourile și dezactivăm TOATE butoanele
    document.querySelectorAll('.cfg-tab-panel').forEach(panel => {
        panel.classList.add('hidden');
    });
    document.querySelectorAll('[id^="tab-btn-"]').forEach(btn => {
        btn.classList.remove('border-accent', 'text-accent', 'config-tab-btn--active');
        btn.classList.add('border-transparent', 'text-slate-500');
    });

    // Afișăm tab-ul selectat
    const targetContent = document.getElementById(`cfg-tab-${tabName}`);
    const targetBtn = document.getElementById(`tab-btn-${tabName}`);
    if (targetContent) targetContent.classList.remove('hidden');
    if (targetBtn) {
        targetBtn.classList.remove('border-transparent', 'text-slate-500');
        targetBtn.classList.add('border-accent', 'text-accent', 'config-tab-btn--active');
    }

    if (tabName === 'users') loadAdminUsers();
    if (tabName === 'app' && typeof window.populateAppTab === 'function') window.populateAppTab();
    if (tabName === 'notifications' && typeof window.loadNotificationPrefs === 'function') window.loadNotificationPrefs();
    if (tabName === 'conference' && typeof window.loadConferenceSettings === 'function') window.loadConferenceSettings();
    if (tabName === 'integrations' && typeof window.switchIntegrationSubtab === 'function') window.switchIntegrationSubtab('active');
}

const _configSectionTabs = {
    settings: ['general', 'prompts', 'intelligence', 'memory', 'notifications', 'conference', 'security'],
};

const _configSectionTitles = {
    settings: 'Setări',
    integrations: 'Integrări',
    automations: 'Automatizări',
    memories: 'Memorii',
    appearance: 'Aspect',
    users: 'Utilizatori',
    logs: 'Logs',
    app: 'App',
    addons: 'Addons',
};

const _configSectionSubtitles = {
    settings: 'Limbă, modele, inteligență și integrări.',
    integrations: 'Home Assistant, WhatsApp, SearXNG, CCTV, Whisper, Piper, ComfyUI.',
    automations: 'Reguli și automatizări YAML declarative.',
    memories: 'Fapte învățate, log memorie și consolidare.',
    appearance: 'Tema și personalizare vizuală.',
    users: 'Conturi și permisiuni.',
    logs: 'Jurnal server în timp real.',
    app: 'Configurare aplicație Android.',
    addons: 'Extensii și servicii adiționale.',
};

const _standaloneSections = ['integrations', 'automations', 'memories', 'appearance', 'users', 'logs', 'app', 'addons'];

// Map config sections to their DOM panel IDs (for panels that live outside config)
const _sectionPanelIds = {
    automations: 'intelligence-panel-automations',
    memories: 'intelligence-panel-memories',
};

// Track where we moved the panel from so we can return it
let _standaloneActivePanel = null;

export function openConfigSection(section) {
    // External views — navigate away from config
    if (section === 'smarthome') { switchTab('smarthome'); return; }
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
        const actionsEl = document.getElementById('config-standalone-actions');
        if (titleEl) titleEl.textContent = _configSectionTitles[section] || section;
        if (subtitleEl) subtitleEl.textContent = _configSectionSubtitles[section] || '';

        // Save button for sections that need it
        if (actionsEl) {
            if (['integrations', 'appearance', 'app'].includes(section)) {
                actionsEl.innerHTML = `<button onclick="saveConfig(event)" class="bg-accent text-bg-main px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold hover:bg-accent-hover transition-all shadow-lg shadow-accent/20 min-h-[36px] sm:min-h-[44px] touch-manipulation" data-i18n="config.save_button">Save</button>`;
            } else {
                actionsEl.innerHTML = '';
            }
        }

        // Move the cfg-tab panel into standalone body
        const panelId = _sectionPanelIds[section] || `cfg-tab-${section}`;
        const panel = document.getElementById(panelId);
        const body = document.getElementById('config-standalone-body');
        if (panel && body) {
            _standaloneActivePanel = { panel, parent: panel.parentElement };
            body.appendChild(panel);
            panel.classList.remove('hidden');
        }

        // Trigger section-specific loaders
        if (section === 'users') loadAdminUsers();
        if (section === 'app' && typeof window.populateAppTab === 'function') window.populateAppTab();
        if (section === 'notifications' && typeof window.loadNotificationPrefs === 'function') window.loadNotificationPrefs();
        if (section === 'logs') startLogStream();
        if (section === 'memories' && typeof window.loadMemory === 'function') window.loadMemory();
        if (section === 'automations' && typeof window.loadAutomations === 'function') window.loadAutomations();
        if (section === 'addons' && typeof window.loadApps === 'function') window.loadApps();

    } else {
        // --- Settings with tabs ---
        if (standalone) standalone.classList.add('hidden');
        if (detail) detail.classList.remove('hidden');
        switchConfigTab('general');
    }
}

export function closeConfigSection() {
    // Return any standalone panel to its original parent
    if (_standaloneActivePanel) {
        const { panel, parent } = _standaloneActivePanel;
        if (parent && panel) {
            parent.appendChild(panel);
            panel.classList.add('hidden');
        }
        _standaloneActivePanel = null;
    }

    const hub = document.getElementById('config-hub');
    const detail = document.getElementById('config-detail');
    const standalone = document.getElementById('config-standalone');
    if (hub) hub.classList.remove('hidden');
    if (detail) detail.classList.add('hidden');
    if (standalone) standalone.classList.add('hidden');
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
        token = localStorage.getItem('memini_token') || '';
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
                container.removeChild(container.firstChild);
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