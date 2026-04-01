/**
 * Conference — multi-AI chatroom module.
 * Design aligned with main Memini chat: glassmorphism, accent colors, bubble patterns.
 */
import { apiCall, authToken } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, showToast, toolIcon, buildSourcesHtml, formatMarkdown, debounce } from './utils.js';

if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true });
}

let _personas = null;
let _modelProfiles = [];
let _conferences = [];
let _activeConf = null;
let _streaming = false;
let _abortController = null;
let _personaMemoryCounts = {};  // pid -> count
let _artifactVisible = true;   // side-panel toggle
let _conferencePage = 1;
const _CONFERENCES_PER_PAGE = 5;
const CONF_AUTO_SCROLL_THRESHOLD = 10;
let confAutoScrollPinnedToBottom = true;
let confProgrammaticScroll = false;
let confScrollTrackedElement = null;

function finalizeStoppedConferenceUI() {
    document.querySelectorAll('#conf-messages .ai-bubble.chat-bubble-typing').forEach(bubble => {
        bubble.classList.remove('chat-bubble-typing');

        const mainContent = bubble.querySelector('.chat-bubble-content');
        if (mainContent) {
            const typingDots = mainContent.querySelector('.chat-typing-dots');
            if (typingDots && !mainContent.textContent.trim()) {
                mainContent.innerHTML = '<span class="text-slate-500"><i class="fas fa-stop-circle"></i> Stopped</span>';
            } else if (typingDots) {
                typingDots.remove();
            }
        }
    });

    const progressEl = document.querySelector('#conf-messages .conf-discussion-progress');
    if (progressEl) {
        progressEl.classList.add('conf-progress-done');
        const inner = progressEl.querySelector('.conf-progress-inner');
        if (inner) {
            inner.innerHTML = '<i class="fas fa-stop-circle"></i><span class="conf-progress-text">Discussion stopped</span>';
        }
    }
}

// Per-participant lobby state
let _selectedPersonas = new Set();
let _selectedMode = 'brainstorm';
let _artifactEnabled = false;
let _expertMemoryEnabled = true;  // default enabled
let _personaOverrides = {};  // pid -> { name, system_prompt, model_profile_id, tools_enabled }
let _availableModes = [];     // fetched from /api/conference/modes

const _LOBBY_STORAGE_KEY = 'memini_conf_lobby';

// Save lobby prefs to server (debounced so rapid changes don't flood the API)
const _serverSave = debounce(async () => {
    try {
        await apiCall('/api/conference/lobby-prefs', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selected_personas: [..._selectedPersonas],
                selected_mode: _selectedMode,
                persona_overrides: _personaOverrides,
                expert_memory_enabled: _expertMemoryEnabled,
            }),
        });
    } catch (e) { /* best-effort, don't block UI */ }
}, 600);

function _saveLobbyState() {
    // Mirror to localStorage for instant restore on same-session navigation
    try {
        localStorage.setItem(_LOBBY_STORAGE_KEY, JSON.stringify({
            selectedPersonas: [..._selectedPersonas],
            selectedMode: _selectedMode,
            personaOverrides: _personaOverrides,
            artifactEnabled: _artifactEnabled,
            expertMemoryEnabled: _expertMemoryEnabled,
            // topic intentionally NOT saved — it should not persist across refreshes
        }));
    } catch (e) { /* quota or private mode */ }
    // Persist to server (user account)
    _serverSave();
}

// _lastTopic removed — topic is not persisted

function _loadLobbyState() {
    // Only used as fallback; initConference() loads from server first
    try {
        const raw = localStorage.getItem(_LOBBY_STORAGE_KEY);
        if (!raw) return;
        const state = JSON.parse(raw);
        if (Array.isArray(state.selectedPersonas)) _selectedPersonas = new Set(state.selectedPersonas);
        if (state.selectedMode) _selectedMode = state.selectedMode;
        if (state.personaOverrides && typeof state.personaOverrides === 'object') _personaOverrides = state.personaOverrides;
        if (state.artifactEnabled !== undefined) _artifactEnabled = state.artifactEnabled;
        if (state.expertMemoryEnabled !== undefined) _expertMemoryEnabled = state.expertMemoryEnabled;
        // topic NOT restored intentionally
    } catch (e) { /* corrupted, ignore */ }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function initConference() {
    // Load from server (persistent per user account), fallback to localStorage
    let loadedFromServer = false;
    try {
        const resp = await apiCall('/api/conference/lobby-prefs');
        if (resp.ok) {
            const state = await resp.json();
            if (Array.isArray(state.selected_personas)) _selectedPersonas = new Set(state.selected_personas);
            if (state.selected_mode) _selectedMode = state.selected_mode;
            if (state.persona_overrides && typeof state.persona_overrides === 'object') _personaOverrides = state.persona_overrides;
            if (state.expert_memory_enabled !== undefined) _expertMemoryEnabled = state.expert_memory_enabled;
            loadedFromServer = true;
        }
    } catch (e) { /* fall back to localStorage */ }

    if (!loadedFromServer) _loadLobbyState();

    await Promise.all([loadPersonas(), loadConferenceList(), loadModelProfiles(), loadPersonaMemoryCounts(), loadModes()]);
    // Prune selected personas that no longer exist
    if (_personas) {
        for (const pid of [..._selectedPersonas]) {
            if (!_personas[pid]) {
                _selectedPersonas.delete(pid);
                delete _personaOverrides[pid];
            }
        }
    }
    // Validate selected mode still exists
    if (_availableModes.length && !_availableModes.find(m => m.id === _selectedMode)) {
        _selectedMode = _availableModes[0].id;
    }
    renderConferenceView();
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function loadPersonas() {
    try {
        const resp = await apiCall('/api/conference/personas');
        if (resp.ok) _personas = await resp.json();
    } catch (e) { console.error('Conference: failed to load personas', e); }
}

async function loadModelProfiles() {
    try {
        const resp = await apiCall('/api/model-profiles');
        if (resp.ok) {
            const data = await resp.json();
            _modelProfiles = data.profiles || [];
        }
    } catch (e) { _modelProfiles = []; }
}

async function loadConferenceList() {
    try {
        const resp = await apiCall('/api/conference/list');
        if (resp.ok) {
            _conferences = await resp.json();
            _conferencePage = 1;
        }
    } catch (e) { _conferences = []; }
}

async function loadPersonaMemoryCounts() {
    try {
        const resp = await apiCall('/api/conference/persona-memories/counts');
        if (resp.ok) _personaMemoryCounts = await resp.json();
    } catch (e) { _personaMemoryCounts = {}; }
}

async function loadModes() {
    try {
        const resp = await apiCall('/api/conference/modes');
        if (resp.ok) _availableModes = await resp.json();
    } catch (e) {
        // Fallback to built-in defaults
        _availableModes = [
            { id: 'brainstorm', name: 'Brainstorm', icon: 'fa-lightbulb', color: '#f59e0b', builtin: true },
            { id: 'debate', name: 'Dezbatere', icon: 'fa-comments', color: '#ef4444', builtin: true },
            { id: 'review', name: 'Review', icon: 'fa-search', color: '#10b981', builtin: true },
        ];
    }
}

async function loadConference(confId) {
    try {
        const resp = await apiCall(`/api/conference/${confId}`);
        if (resp.ok) { _activeConf = await resp.json(); return true; }
    } catch (e) { console.error('Conference: load failed', e); }
    return false;
}

async function deleteConference(confId) {
    try {
        const resp = await apiCall(`/api/conference/${confId}`, { method: 'DELETE' });
        if (resp.ok) {
            _conferences = _conferences.filter(c => c.id !== confId);
            if (_activeConf && _activeConf.id === confId) _activeConf = null;
            const totalPages = Math.max(1, Math.ceil(_conferences.length / _CONFERENCES_PER_PAGE));
            _conferencePage = Math.min(_conferencePage, totalPages);
            renderConferenceView();
            showToast(t('conference.deleted') || 'Conference deleted', 'success');
        }
    } catch (e) { showToast('Error deleting conference', 'error'); }
}

function setConferencePage(page) {
    const totalPages = Math.max(1, Math.ceil(_conferences.length / _CONFERENCES_PER_PAGE));
    _conferencePage = Math.max(1, Math.min(page, totalPages));
    renderConferenceView();
}

// ---------------------------------------------------------------------------
// Main view renderer
// ---------------------------------------------------------------------------

function renderConferenceView() {
    const container = document.getElementById('conference-container');
    if (!container) return;
    updateConferenceAppHeader();
    _activeConf ? renderActiveConference(container) : renderLobby(container);
}

function updateConferenceAppHeader() {
    const titleEl = document.getElementById('current-view-title');
    const metaEl = document.getElementById('current-view-meta');
    const backBtn = document.getElementById('conference-header-back');
    const actionsEl = document.getElementById('view-header-actions');
    const menuBtn = document.getElementById('app-header-menu-btn');

    if (titleEl) {
        titleEl.innerText = _activeConf ? (_activeConf.title || t('nav.conference')) : t('nav.conference');
        titleEl.removeAttribute('data-i18n');
    }

    if (metaEl) {
        if (_activeConf?.mode) {
            metaEl.textContent = _activeConf.mode;
            metaEl.classList.remove('hidden');
            metaEl.classList.add('inline-flex');
        } else {
            metaEl.textContent = '';
            metaEl.classList.add('hidden');
            metaEl.classList.remove('inline-flex');
        }
    }

    if (backBtn) {
        backBtn.classList.toggle('hidden', !_activeConf);
        backBtn.classList.toggle('inline-flex', !!_activeConf);
    }

    if (menuBtn) {
        menuBtn.classList.toggle('hidden', !!_activeConf);
        menuBtn.classList.toggle('flex', !_activeConf);
    }

    if (!actionsEl) return;
    if (!_activeConf) {
        actionsEl.innerHTML = '';
        actionsEl.classList.add('hidden');
        actionsEl.classList.remove('flex');
        return;
    }

    const hasArtifact = _activeConf.artifact !== undefined && _activeConf.artifact !== null;
    actionsEl.innerHTML = `
        ${hasArtifact ? `<button type="button" onclick="window._confToggleArtifactPanel()" class="conf-header-btn ${_artifactVisible ? 'conf-header-btn-active' : ''}" title="Toggle artifact panel" aria-label="Toggle artifact panel"><i class="fas fa-file-lines"></i></button>` : ''}
        <button type="button" onclick="window._confEditMeta()" class="conf-header-btn" title="Edit conference" aria-label="Edit conference"><i class="fas fa-pen"></i></button>
        <button type="button" onclick="window._confFork()" class="conf-header-btn" title="Fork conference" aria-label="Fork conference"><i class="fas fa-code-branch"></i></button>
    `;
    actionsEl.classList.remove('hidden');
    actionsEl.classList.add('flex');
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function renderLobby(container) {
    const personaCards = _personas ? Object.entries(_personas).map(([id, p]) => {
        const isSelected = _selectedPersonas.has(id);
        const override = _personaOverrides[id] || {};
        const displayName = override.name || p.name;
        const displayIcon = override.icon || p.icon;
        const displayColor = override.color || p.color;
        const memCount = _personaMemoryCounts[id] || 0;
        return `
            <div class="conf-persona-card ${isSelected ? 'conf-persona-selected' : ''}"
                 data-persona="${id}" onclick="window._confTogglePersona('${id}')">
                <div class="conf-persona-avatar" style="--persona-color: ${displayColor}">
                    <i class="fas ${displayIcon}"></i>
                </div>
                <span class="conf-persona-name">${escapeHtml(displayName)}</span>
                ${memCount > 0 ? `<div class="conf-persona-memory" title="Click to view ${memCount} memories" onclick="event.stopPropagation(); window._confViewMemories('${id}')"><i class="fas fa-brain"></i>${memCount}</div>` : ''}
                ${isSelected ? '<div class="conf-persona-check"><i class="fas fa-check"></i></div>' : ''}
                ${isSelected ? `<button type="button" class="conf-persona-edit" onclick="event.stopPropagation(); window._confEditPersona('${id}')" title="Edit settings"><i class="fas fa-sliders"></i></button>` : ''}
            </div>
        `;
    }).join('') : '<p class="text-slate-500 text-sm">Loading personas...</p>';

    const totalPages = Math.max(1, Math.ceil(_conferences.length / _CONFERENCES_PER_PAGE));
    const currentPage = Math.max(1, Math.min(_conferencePage, totalPages));
    const startIndex = (currentPage - 1) * _CONFERENCES_PER_PAGE;
    const pagedConferences = _conferences.slice(startIndex, startIndex + _CONFERENCES_PER_PAGE);

    const confListHtml = _conferences.length ? pagedConferences.map(c => {
        const forkIcon = c.forked_from ? '<i class="fas fa-code-branch text-violet-400 mr-1" title="Forked"></i>' : '';
        const artifactIcon = c.has_artifact ? '<i class="fas fa-file-lines text-emerald-400 ml-1" title="Has artifact"></i>' : '';
        return `
        <div class="conf-list-item group" onclick="window._confOpen('${c.id}')">
            <div class="conf-list-icon">${c.forked_from ? '<i class="fas fa-code-branch"></i>' : '<i class="fas fa-users"></i>'}</div>
            <div class="conf-list-info">
                <div class="conf-list-title">${forkIcon}${escapeHtml(c.title)}${artifactIcon}</div>
                <div class="conf-list-meta">
                    ${c.participants.map(n => escapeHtml(n)).join(' · ')} — ${c.message_count} ${t('conference.messages_count') || 'messages'}
                </div>
            </div>
            <button onclick="event.stopPropagation(); window._confDelete('${c.id}')"
                class="conf-list-delete"><i class="fas fa-trash"></i></button>
        </div>
    `;
    }).join('') : '';

    const confPaginationHtml = _conferences.length > _CONFERENCES_PER_PAGE ? `
        <div class="flex items-center justify-between mt-2 px-1">
            <button type="button" class="conf-reset-btn" onclick="window._confSetPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled style="opacity:.45;cursor:not-allowed"' : ''}>
                <i class="fas fa-chevron-left mr-1"></i>Prev
            </button>
            <span class="text-[11px] text-slate-500">Page ${currentPage} / ${totalPages}</span>
            <button type="button" class="conf-reset-btn" onclick="window._confSetPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled style="opacity:.45;cursor:not-allowed"' : ''}>
                Next<i class="fas fa-chevron-right ml-1"></i>
            </button>
        </div>
    ` : '';

    container.innerHTML = `
        <div class="conf-lobby">
            <div class="conf-lobby-header">
                <div class="conf-header-particles">
                    <div class="conf-particle"><i class="fas fa-users"></i></div>
                    <div class="conf-particle"><i class="fas fa-comments"></i></div>
                    <div class="conf-particle"><i class="fas fa-brain"></i></div>
                    <div class="conf-particle"><i class="fas fa-lightbulb"></i></div>
                    <div class="conf-particle"><i class="fas fa-microchip"></i></div>
                </div>
                <div class="conf-header-content">
                    <div class="conf-header-icon-main">
                        <i class="fas fa-users"></i>
                        <div class="conf-header-icon-glow"></div>
                    </div>
                    <h2 class="conf-header-title">Conferință AI Colectivă</h2>
                    <p class="conf-header-subtitle">Invită mai mulți asistenți AI să colaboreze și să dezbată împreună</p>
                </div>
            </div>

            <div class="conf-create-section glass">
                <div class="conf-field">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1"><i class="fas fa-comment-dots mr-1"></i>${t('conference.topic') || 'Topic / Question'}</label>
                    <textarea id="conf-topic" rows="2" class="cfg-input w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-300 focus:border-accent outline-none resize-none"
                        placeholder="${t('conference.topic_placeholder') || 'What should the AIs discuss?'}"></textarea>
                </div>

                <div class="conf-field">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1"><i class="fas fa-layer-group mr-1"></i>${t('conference.mode_label') || 'Mode'}</label>
                    <div class="conf-mode-row">
                        ${_availableModes.map(m => `
                            <button type="button" data-mode="${m.id}" class="conf-mode-btn ${_selectedMode === m.id ? 'conf-mode-active' : ''}" onclick="window._confSetMode('${m.id}')" style="${_selectedMode === m.id ? `border-color: ${m.color}; color: ${m.color}; background: ${m.color}22; box-shadow: 0 0 20px ${m.color}22` : ''}">
                                <i class="fas ${m.icon}"></i>${escapeHtml(m.name)}
                            </button>
                        `).join('')}
                    </div>
                </div>

                <div class="conf-field">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1">
                        <i class="fas fa-user-group mr-1"></i>${t('conference.select_participants') || 'AI Participants'} <span class="text-slate-600">(2-6)</span>
                    </label>
                    <div class="conf-personas-grid">${personaCards}</div>
                </div>

                <div class="conf-field">
                    <label class="conf-toggle-row">
                        <input type="checkbox" id="conf-artifact-toggle" ${_artifactEnabled ? 'checked' : ''}
                            onchange="window._confToggleArtifact(this.checked)">
                        <div>
                            <span class="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                                <i class="fas fa-file-lines text-emerald-400"></i>Live Artifact
                            </span>
                            <span class="text-[10px] text-slate-500 block mt-0.5">AI-urile co-creeaz\u0103 un document live \u00een timpul discu\u021biei</span>
                        </div>
                    </label>
                </div>

                <div class="conf-field">
                    <label class="conf-toggle-row">
                        <input type="checkbox" id="conf-memory-toggle" ${_expertMemoryEnabled ? 'checked' : ''}
                            onchange="window._confToggleMemory(this.checked)">
                        <div>
                            <span class="text-sm font-semibold text-slate-200 flex items-center gap-1.5">
                                <i class="fas fa-brain text-violet-400"></i>Expert Memory
                            </span>
                            <span class="text-[10px] text-slate-500 block mt-0.5">Personele î\u0219i amintesc \u0219i acumuleaz\u0103 cuno\u0219tin\u021be între conferin\u021be</span>
                        </div>
                    </label>
                </div>

                <button id="conf-create-btn" type="button" onclick="window._confCreate()"
                    class="w-full py-3 rounded-xl text-sm font-bold bg-accent text-bg-main hover:bg-accent-hover transition-all shadow-lg shadow-accent/20 min-h-[44px]" ${_selectedPersonas.size < 2 ? 'disabled style="opacity:0.35;cursor:not-allowed;box-shadow:none"' : ''}>
                    <i class="fas fa-rocket mr-2"></i>${t('conference.create') || 'Start Conference'}
                </button>
            </div>

            ${(() => {
                const totalMem = Object.values(_personaMemoryCounts).reduce((s, c) => s + c, 0);
                if (totalMem > 0 && _personas) {
                    const memCards = Object.entries(_personaMemoryCounts)
                        .filter(([, c]) => c > 0)
                        .map(([pid, c]) => {
                            const p = _personas[pid];
                            if (!p) return '';
                            const ov = _personaOverrides[pid] || {};
                            const dName = ov.name || p.name;
                            const dIcon = ov.icon || p.icon;
                            const dColor = ov.color || p.color;
                            return `
                                <div class="conf-mem-card group" onclick="window._confViewMemories('${pid}')" style="cursor:pointer">
                                    <div class="conf-persona-avatar" style="--persona-color: ${dColor}; width:32px; height:32px; font-size:14px;">
                                        <i class="fas ${dIcon}"></i>
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <div class="text-sm font-semibold text-slate-200 truncate">${escapeHtml(dName)}</div>
                                        <div class="text-[10px] text-slate-500">${c} memor${c === 1 ? 'y' : 'ies'}</div>
                                    </div>
                                    <i class="fas fa-chevron-right text-[10px] text-slate-600 group-hover:text-violet-400 transition-colors"></i>
                                </div>
                            `;
                        }).join('');
                    return `
                        <div class="conf-memories-section">
                            <div class="conf-memories-header">
                                <i class="fas fa-brain"></i>
                                <span>Expert Memories</span>
                                <span style="font-weight:400; font-size:0.625rem; color:var(--text-tertiary); text-transform:none; letter-spacing:0;">— click pe un agent pentru a vedea ce a memorat</span>
                            </div>
                            <div class="conf-mem-grid">${memCards}</div>
                        </div>
                    `;
                }
                return '';
            })()}

            ${_conferences.length ? `
                <div class="conf-list-section">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2"><i class="fas fa-clock-rotate-left mr-1"></i>${t('conference.previous') || 'Previous Conferences'}</label>
                    <div class="conf-list">${confListHtml}</div>
                    ${confPaginationHtml}
                </div>
            ` : ''}
        </div>
    `;

    // Ensure persistent modal exists
    _ensurePersonaModal();
}

// ---------------------------------------------------------------------------
// Persistent persona config modal (lives outside lobby innerHTML)
// ---------------------------------------------------------------------------

function _ensurePersonaModal() {
    if (document.getElementById('conf-persona-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'conf-persona-modal';
    modal.className = 'modal-overlay app-modal fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 hidden';
    modal.style.cssText = '';
    modal.innerHTML = `
        <div class="glass app-modal-panel app-modal-content max-w-lg" style="animation: slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);">
            <div class="app-modal-header">
                <h3 class="text-sm font-bold text-accent uppercase tracking-widest flex items-center gap-2"><i class="fas fa-sliders"></i>Agent Settings</h3>
                <button onclick="window._confCloseModal()" class="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-all" aria-label="Close"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="app-modal-body space-y-5" id="conf-modal-body"></div>
            <div class="app-modal-footer justify-end">
                <button onclick="window._confCloseModal()" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-white/5 transition-colors">${t('common.cancel') || 'Cancel'}</button>
                <button onclick="window._confSavePersona()" class="px-4 py-2 rounded-xl text-sm font-bold bg-accent text-bg-main hover:bg-accent-hover transition-colors"><i class="fas fa-check mr-1"></i>${t('common.save') || 'Save'}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// ---------------------------------------------------------------------------
// Persona edit modal
// ---------------------------------------------------------------------------

let _editingPersonaId = null;

// Available icons & colors for persona customization
const _PERSONA_ICONS = [
    'fa-chart-line','fa-paintbrush','fa-gavel','fa-wrench','fa-rocket','fa-mask',
    'fa-brain','fa-lightbulb','fa-code','fa-flask','fa-shield','fa-star',
    'fa-fire','fa-bolt','fa-gem','fa-globe','fa-compass','fa-crown',
    'fa-eye','fa-dragon','fa-chess-knight','fa-scale-balanced','fa-user-secret',
    'fa-microscope','fa-book','fa-graduation-cap','fa-palette','fa-heart',
    'fa-wand-magic-sparkles','fa-hands-holding','fa-seedling','fa-feather',
];
const _PERSONA_COLORS = [
    '#3b82f6','#f59e0b','#ef4444','#10b981','#8b5cf6','#ec4899',
    '#06b6d4','#f97316','#84cc16','#14b8a6','#6366f1','#e11d48',
    '#0ea5e9','#d946ef','#a3e635','#fbbf24','#f43f5e','#22d3ee',
];

function openPersonaModal(id) {
    if (!_personas || !_personas[id]) return;
    _ensurePersonaModal();
    _editingPersonaId = id;
    const p = _personas[id];
    const override = _personaOverrides[id] || {};
    const profileOptionsHtml = _modelProfiles.map(mp =>
        `<option value="${mp.id}" ${override.model_profile_id === mp.id ? 'selected' : ''}>${escapeHtml(mp.name)} (${escapeHtml(mp.model_name || '')})</option>`
    ).join('');

    const currentIcon = override.icon || p.icon;
    const currentColor = override.color || p.color;

    const body = document.getElementById('conf-modal-body');
    if (!body) return;

    // Build icon picker grid
    const iconGridHtml = _PERSONA_ICONS.map(ic =>
        `<button type="button" class="conf-icon-pick ${ic === currentIcon ? 'conf-icon-pick-active' : ''}" data-icon="${ic}" onclick="window._confPickIcon('${ic}')" title="${ic}">
            <i class="fas ${ic}"></i>
        </button>`
    ).join('');

    // Build color picker row
    const colorRowHtml = _PERSONA_COLORS.map(c =>
        `<button type="button" class="conf-color-pick ${c === currentColor ? 'conf-color-pick-active' : ''}" data-color="${c}" onclick="window._confPickColor('${c}')" style="background:${c}"></button>`
    ).join('');

    body.innerHTML = `
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-pen mr-1"></i>Agent Name</label>
            <input type="text" id="conf-edit-name" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-300 focus:border-accent outline-none transition-colors" value="${escapeHtml(override.name || p.name)}" placeholder="${escapeHtml(p.name)}">
        </div>
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-icons mr-1"></i>Icon</label>
            <div class="conf-icon-grid" id="conf-icon-grid">${iconGridHtml}</div>
            <input type="hidden" id="conf-edit-icon" value="${currentIcon}">
        </div>
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-palette mr-1"></i>Color</label>
            <div class="conf-color-row" id="conf-color-row">${colorRowHtml}</div>
            <input type="hidden" id="conf-edit-color" value="${currentColor}">
        </div>
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-microchip mr-1"></i>Model Profile</label>
            <select id="conf-edit-model" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-300 focus:border-accent outline-none transition-colors appearance-none">
                <option value="">Global default</option>
                ${profileOptionsHtml}
            </select>
        </div>
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-scroll mr-1"></i>System Prompt</label>
            <textarea id="conf-edit-prompt" rows="8" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-300 focus:border-accent outline-none transition-colors conf-edit-prompt-ta"
                placeholder="Default prompt will be used">${escapeHtml(override.system_prompt || p.system || '')}</textarea>
            <button type="button" class="conf-reset-btn" onclick="window._confResetPrompt()">
                <i class="fas fa-undo mr-1"></i>Reset to default
            </button>
        </div>
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-wrench mr-1"></i>Tools</label>
            <label class="conf-toggle-row">
                <input type="checkbox" id="conf-edit-tools" ${override.tools_enabled !== false ? 'checked' : ''}>
                <span>Enable tools (web search, memory, etc.)</span>
            </label>
        </div>
        ${(() => {
            const memCount = _personaMemoryCounts[id] || 0;
            if (memCount > 0) {
                return `<div>
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-brain mr-1"></i>Expert Memory</label>
                    <div class="flex items-center gap-3">
                        <span class="text-xs text-slate-400"><i class="fas fa-brain text-violet-400 mr-1"></i>${memCount} memories from past discussions</span>
                        <button type="button" class="conf-reset-btn" onclick="window._confViewMemories('${id}');">
                            <i class="fas fa-eye mr-1"></i>View
                        </button>
                        <button type="button" class="conf-reset-btn" onclick="window._confClearMemories('${id}'); window._confCloseModal();">
                            <i class="fas fa-trash mr-1"></i>Clear all
                        </button>
                    </div>
                </div>`;
            }
            return '';
        })()}
    `;

    const modal = document.getElementById('conf-persona-modal');
    if (modal) modal.classList.remove('hidden');
}

function closePersonaModal() {
    const modal = document.getElementById('conf-persona-modal');
    if (modal) modal.classList.add('hidden');
    _editingPersonaId = null;
}

function resetPromptToDefault() {
    if (!_editingPersonaId || !_personas[_editingPersonaId]) return;
    const ta = document.getElementById('conf-edit-prompt');
    if (ta) ta.value = _personas[_editingPersonaId].system || '';
}

function savePersonaSettings() {
    if (!_editingPersonaId || !_personas[_editingPersonaId]) return;
    const id = _editingPersonaId;
    const p = _personas[id];

    const nameEl = document.getElementById('conf-edit-name');
    const modelEl = document.getElementById('conf-edit-model');
    const promptEl = document.getElementById('conf-edit-prompt');
    const toolsEl = document.getElementById('conf-edit-tools');

    // Guard: ensure modal form elements exist
    if (!nameEl || !modelEl || !promptEl) {
        console.warn('[Conference] savePersonaSettings: form elements not found in DOM');
        showToast('Save failed — form not found', 'error');
        return;
    }

    const savedName = nameEl.value.trim() || p.name;
    const savedModel = modelEl.value || '';
    const savedPrompt = promptEl.value.trim() || '';
    const savedTools = toolsEl?.checked ?? true;
    const savedIcon = document.getElementById('conf-edit-icon')?.value || p.icon;
    const savedColor = document.getElementById('conf-edit-color')?.value || p.color;

    _personaOverrides[id] = {
        name: savedName,
        icon: savedIcon,
        color: savedColor,
        model_profile_id: savedModel,
        system_prompt: savedPrompt,
        tools_enabled: savedTools,
    };

    // Persist BEFORE closing the modal (so conf-topic can still be read)
    _saveLobbyState();
    closePersonaModal();
    // Targeted update — just refresh the card name, no full re-render
    _updatePersonaCard(id);

    // Descriptive feedback
    const modelName = savedModel ? (_modelProfiles.find(mp => mp.id === savedModel)?.name || savedModel) : 'default';
    showToast(`${savedName}: model=${modelName}, prompt=${savedPrompt ? savedPrompt.length + ' chars' : 'default'}, tools=${savedTools ? 'on' : 'off'}`, 'success');
}

// ---------------------------------------------------------------------------
// Conference creation logic
// ---------------------------------------------------------------------------

function togglePersona(id) {
    if (_selectedPersonas.has(id)) {
        _selectedPersonas.delete(id);
        delete _personaOverrides[id];
    } else {
        if (_selectedPersonas.size >= 6) {
            showToast(t('conference.max_participants') || 'Maximum 6 participants', 'warning');
            return;
        }
        _selectedPersonas.add(id);
    }
    _saveLobbyState();

    // Targeted DOM update — don't destroy the whole lobby
    _updatePersonaCard(id);
    _updateCreateButton();
}

function _updatePersonaCard(id) {
    const card = document.querySelector(`.conf-persona-card[data-persona="${id}"]`);
    if (!card || !_personas) return;
    const p = _personas[id];
    if (!p) return;
    const isSelected = _selectedPersonas.has(id);
    const override = _personaOverrides[id] || {};
    const displayName = override.name || p.name;
    const displayIcon = override.icon || p.icon;
    const displayColor = override.color || p.color;

    // Toggle selection class
    card.classList.toggle('conf-persona-selected', isSelected);

    // Update name
    const nameEl = card.querySelector('.conf-persona-name');
    if (nameEl) nameEl.textContent = displayName;

    // Update icon & color on avatar
    const avatar = card.querySelector('.conf-persona-avatar');
    if (avatar) {
        avatar.style.setProperty('--persona-color', displayColor);
        const iconEl = avatar.querySelector('i');
        if (iconEl) iconEl.className = `fas ${displayIcon}`;
    }

    // Add/remove check badge
    let check = card.querySelector('.conf-persona-check');
    if (isSelected && !check) {
        check = document.createElement('div');
        check.className = 'conf-persona-check';
        check.innerHTML = '<i class="fas fa-check"></i>';
        card.appendChild(check);
    } else if (!isSelected && check) {
        check.remove();
    }

    // Add/remove edit button
    let editBtn = card.querySelector('.conf-persona-edit');
    if (isSelected && !editBtn) {
        editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'conf-persona-edit';
        editBtn.title = 'Edit settings';
        editBtn.innerHTML = '<i class="fas fa-sliders"></i>';
        editBtn.addEventListener('click', e => { e.stopPropagation(); openPersonaModal(id); });
        card.appendChild(editBtn);
    } else if (!isSelected && editBtn) {
        editBtn.remove();
    }
}

function _updateCreateButton() {
    const btn = document.getElementById('conf-create-btn');
    if (!btn) return;
    const enabled = _selectedPersonas.size >= 2;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '' : '0.35';
    btn.style.cursor = enabled ? '' : 'not-allowed';
    btn.style.boxShadow = enabled ? '' : 'none';
}

function setMode(mode) {
    _selectedMode = mode;
    _saveLobbyState();
    const modeData = _availableModes.find(m => m.id === mode);
    const activeColor = modeData ? modeData.color : 'var(--accent)';
    document.querySelectorAll('.conf-mode-btn').forEach(btn => {
        if (btn.dataset.mode === mode) {
            btn.classList.add('conf-mode-active');
            btn.style.borderColor = activeColor;
            btn.style.color = activeColor;
            btn.style.background = activeColor + '22';
            btn.style.boxShadow = `0 0 20px ${activeColor}22`;
        } else {
            btn.classList.remove('conf-mode-active');
            btn.style.borderColor = '';
            btn.style.color = '';
            btn.style.background = '';
            btn.style.boxShadow = '';
        }
    });
}

async function createConference() {
    const topicEl = document.getElementById('conf-topic');
    const topic = topicEl ? topicEl.value.trim() : '';
    if (_selectedPersonas.size < 2) {
        showToast(t('conference.need_participants') || 'Select at least 2 AI participants', 'warning');
        return;
    }

    const participantsConfig = [..._selectedPersonas].map(pid => {
        const p = _personas[pid];
        const ov = _personaOverrides[pid] || {};
        const defaultPrompt = p ? (p.system || '') : '';
        const cfg = { persona_id: pid };
        if (ov.name && ov.name !== (p?.name || '')) cfg.custom_name = ov.name;
        if (ov.icon && ov.icon !== (p?.icon || '')) cfg.custom_icon = ov.icon;
        if (ov.color && ov.color !== (p?.color || '')) cfg.custom_color = ov.color;
        if (ov.system_prompt && ov.system_prompt !== defaultPrompt) cfg.system_prompt = ov.system_prompt;
        if (ov.model_profile_id) cfg.model_profile_id = ov.model_profile_id;
        if (ov.tools_enabled !== undefined) cfg.tools_enabled = ov.tools_enabled;
        return cfg;
    });

    try {
        const resp = await apiCall('/api/conference/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: topic.slice(0, 60) || '',
                mode: _selectedMode,
                participants_config: participantsConfig,
                topic: topic,
                artifact_enabled: _artifactEnabled,
                expert_memory_enabled: _expertMemoryEnabled,
            }),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err.detail || 'Error creating conference', 'error');
            return;
        }

        _activeConf = await resp.json();
        _conferences.unshift({
            id: _activeConf.id,
            title: _activeConf.title,
            mode: _activeConf.mode,
            participants: _activeConf.participants.map(p => p.name),
            message_count: 0,
            created_at: _activeConf.created_at,
            updated_at: _activeConf.updated_at,
        });
        // NOTE: intentionally NOT clearing _selectedPersonas / _personaOverrides / _selectedMode
        // so lobby settings persist when user comes back (survives page reload via server-side prefs)
        renderConferenceView();

        if (topic) setTimeout(() => sendConferenceMessage(topic), 300);
    } catch (e) {
        showToast('Error creating conference', 'error');
    }
}

// ---------------------------------------------------------------------------
// Active Conference UI
// ---------------------------------------------------------------------------

function renderActiveConference(container) {
    const conf = _activeConf;
    if (!conf) return;

    const hasArtifact = conf.artifact !== undefined && conf.artifact !== null;
    const artifactContent = hasArtifact ? (conf.artifact.content || '') : '';

    const messagesHtml = renderMessages(conf.messages, conf.participants);

    container.innerHTML = `
        <div class="conf-active ${hasArtifact ? 'conf-has-artifact' : ''}">
            <div class="conf-body-split">
                <div class="conf-chat-side">
                    <div id="conf-messages" class="conf-messages-wrapper">
                        ${messagesHtml}
                    </div>

                    <div class="conf-composer-shell">
                        <div class="chat-input-wrapper conf-chat-input-wrapper">
                            <div class="chat-input-inner conf-chat-input-inner">
                                <textarea id="conf-input" rows="1" class="chat-input-field conf-chat-input-field"
                                placeholder="${t('conference.input_placeholder') || 'Ask all AIs...'}"
                                onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._confSend()}"></textarea>
                                <button id="conf-voice-btn" type="button" class="chat-voice-btn conf-voice-btn-ui hidden" aria-label="Voice input" onclick="window._confVoice()">
                                <i class="fas fa-microphone"></i>
                                <span class="voice-pulse"></span>
                                </button>
                                <button id="conf-send-btn" type="button" onclick="window._confSend()" class="chat-send-btn conf-send-btn-ui">
                                <i class="fas fa-paper-plane"></i>
                                </button>
                                <button id="conf-stop-btn" type="button" onclick="window._confStop()" class="conf-stop-btn conf-stop-btn-ui hidden">
                                <i class="fas fa-stop"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                ${hasArtifact ? `
                <div class="conf-artifact-backdrop ${_artifactVisible ? '' : 'conf-artifact-hidden'}" onclick="window._confToggleArtifactPanel()"></div>
                <div id="conf-artifact-panel" class="conf-artifact-panel ${_artifactVisible ? '' : 'conf-artifact-hidden'}">
                    <div class="conf-artifact-header">
                        <div class="conf-artifact-header-main">
                            <div class="conf-artifact-title"><i class="fas fa-file-lines"></i>Live Artifact</div>
                            <div class="conf-artifact-subtitle">Document comun actualizat pe parcursul conversației</div>
                        </div>
                        <div class="conf-artifact-meta-wrap">
                            <div class="conf-artifact-status"><i class="fas fa-circle"></i>Live</div>
                            <div class="conf-artifact-meta">v${conf.artifact.version || 0}</div>
                            <button onclick="window._confToggleArtifactPanel()" class="conf-artifact-close-btn" aria-label="Close artifact"><i class="fas fa-xmark"></i></button>
                        </div>
                    </div>
                    <div id="conf-artifact-content" class="conf-artifact-content prose prose-invert prose-sm">
                        ${artifactContent ? formatContent(artifactContent) : '<div class="conf-artifact-empty"><i class="fas fa-feather"></i><strong>Artifactul este pregătit</strong><span>Documentul se va construi pe măsură ce discuția avansează...</span></div>'}
                    </div>
                </div>
                ` : ''}
            </div>
        </div>
    `;

    const msgContainer = document.getElementById('conf-messages');
    initConferenceScrollTracking();
    scrollToBottom(msgContainer, { behavior: 'auto', force: true });

    const input = document.getElementById('conf-input');
    if (input) {
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });
    }

    // Show/hide conference voice button based on whisper config
    _checkConfVoice();
}

// ---------------------------------------------------------------------------
// Messages — uses main chat bubble pattern
// ---------------------------------------------------------------------------

function renderMessages(messages, participants) {
    if (!messages || !messages.length) {
        return `<div class="conf-empty-state">
            <i class="fas fa-comments"></i>
            <span>${t('conference.no_messages') || 'No messages yet. Start the discussion!'}</span>
        </div>`;
    }
    return messages.map(msg => renderSingleMessage(msg, participants)).join('');
}

function renderSingleMessage(msg, participants) {
    if (msg.role === 'user') {
        return `
            <div class="chat-row chat-row-user conf-msg animate-up">
                <div class="chat-msg chat-msg-user">
                    <div class="chat-bubble user-bubble">
                        <div class="chat-bubble-content">${escapeHtml(msg.content || '')}</div>
                    </div>
                </div>
            </div>
        `;
    }

    // Summary messages (rendered as special card)
    if (msg.role === 'summary') {
        return `
            <div class="chat-row conf-msg conf-summary-row animate-up">
                <div class="conf-summary-card glass">
                    <div class="conf-summary-header">
                        <i class="fas fa-clipboard-list"></i>
                        <span>Discussion Summary</span>
                    </div>
                    <div class="conf-summary-content prose prose-invert prose-sm">
                        ${formatContent(msg.content || '')}
                    </div>
                </div>
            </div>
        `;
    }

    const persona = participants.find(p => p.id === msg.participant_id) || {};
    const color = persona.color || '#38bdf8';
    const icon = persona.icon || 'fa-robot';
    const name = persona.name || msg.participant_name || 'AI';

    let thinkingHtml = '';
    if (msg.thinking) {
        thinkingHtml = `
            <div class="chat-thinking-block">
                <button type="button" class="chat-thinking-toggle" aria-expanded="false"
                    onclick="const b=this.closest('.chat-thinking-block'); const o=b.classList.toggle('chat-thinking-open'); this.setAttribute('aria-expanded', o?'true':'false')">
                    <i class="fas fa-brain"></i>
                    <span class="chat-thinking-label">${t('conference.thinking') || 'Thinking'}</span>
                    <i class="fas fa-chevron-down chat-thinking-chevron"></i>
                </button>
                <div class="chat-thinking-content">
                    <p class="chat-thinking-p">${formatContent(msg.thinking)}</p>
                </div>
            </div>
        `;
    }

    let toolsHtml = '';
    if (msg.tool_steps && msg.tool_steps.length) {
        toolsHtml = `
            <div class="chat-tools-row">
                <div class="chat-steps">
                    ${msg.tool_steps.map(s => `
                        <span class="chat-step">
                            <i class="fas ${toolIcon(s.name)} chat-step-icon"></i>
                            <span class="chat-step-label">${escapeHtml(s.label || s.name || '')}</span>
                        </span>
                    `).join('')}
                </div>
                <div class="chat-tools-summary">${msg.tool_steps.length} tool${msg.tool_steps.length > 1 ? 's' : ''}</div>
            </div>
        `;
    }

    let sourcesHtml = '';
    if (msg.search_sources && msg.search_sources.length) {
        sourcesHtml = buildSourcesHtml(msg.search_sources);
    }

    return `
        <div class="chat-row chat-row-ai conf-msg animate-up">
            <div class="chat-msg chat-msg-ai">
                <div class="chat-avatar" style="--bubble-glow-color: ${color}">
                    <i class="fas ${icon}" style="color: ${color}"></i>
                </div>
                <div class="chat-bubble ai-bubble" style="--bubble-glow-color: ${color}">
                    <div class="conf-agent-name" style="color: ${color}">${escapeHtml(name)}</div>
                    <div class="chat-bubble-part chat-bubble-steps">${toolsHtml}</div>
                    <div class="chat-bubble-part chat-bubble-thinking">${thinkingHtml}</div>
                    <div class="chat-bubble-part chat-bubble-main">
                        <div class="chat-bubble-content prose prose-invert prose-sm">${formatContent(msg.content)}</div>
                    </div>
                    <div class="chat-bubble-part chat-bubble-cards">${sourcesHtml}</div>
                </div>
            </div>
        </div>
    `;
}

// Tool icons & formatting now imported from utils.js (toolIcon, buildSourcesHtml, formatMarkdown)
const formatContent = formatMarkdown;  // alias for backward-compat within this file

// ---------------------------------------------------------------------------
// Message sending & SSE streaming — free-flowing discussion
// ---------------------------------------------------------------------------

async function sendConferenceMessage(optionalMsg) {
    const input = document.getElementById('conf-input');
    const msg = optionalMsg || (input ? input.value.trim() : '');
    if (!msg || _streaming || !_activeConf) return;

    if (input && !optionalMsg) input.value = '';
    if (input) input.style.height = 'auto';

    const msgContainer = document.getElementById('conf-messages');
    if (!msgContainer) return;

    const empty = msgContainer.querySelector('.conf-empty-state');
    if (empty) empty.remove();

    // User bubble
    const userRow = document.createElement('div');
    userRow.className = 'chat-row chat-row-user conf-msg animate-up';
    userRow.innerHTML = `
        <div class="chat-msg chat-msg-user">
            <div class="chat-bubble user-bubble">
                <div class="chat-bubble-content">${escapeHtml(msg)}</div>
            </div>
        </div>
    `;
    msgContainer.appendChild(userRow);

    // Discussion progress indicator (replaces pre-created placeholders)
    const progressEl = document.createElement('div');
    progressEl.className = 'conf-discussion-progress';
    progressEl.innerHTML = `
        <div class="conf-progress-inner">
            <span class="chat-typing-dots"><span></span><span></span><span></span></span>
            <span class="conf-progress-text">Discussion starting…</span>
        </div>
    `;
    msgContainer.appendChild(progressEl);

    scrollToBottom(msgContainer, { force: true });
    _streaming = true;
    updateSendButton();
    _abortController = new AbortController();
    const token = localStorage.getItem('memini_token') || authToken;

    // Dynamic placeholder — tracks the CURRENT speaking participant
    let activePh = null;

    // Build a map of participant info for quick lookup
    const pMap = {};
    _activeConf.participants.forEach(p => { pMap[p.id] = p; });

    function createBubble(pid, name, color, icon) {
        const row = document.createElement('div');
        row.className = 'chat-row chat-row-ai conf-msg animate-up';
        row.innerHTML = `
            <div class="chat-msg chat-msg-ai">
                <div class="chat-avatar" style="--bubble-glow-color: ${color}">
                    <i class="fas ${icon}" style="color: ${color}"></i>
                </div>
                <div class="chat-bubble ai-bubble chat-bubble-typing" style="--bubble-glow-color: ${color}">
                    <div class="conf-agent-name" style="color: ${color}">${escapeHtml(name)}</div>
                    <div class="chat-bubble-part chat-bubble-steps" data-steps></div>
                    <div class="chat-bubble-part chat-bubble-thinking" data-thinking></div>
                    <div class="chat-bubble-part chat-bubble-main">
                        <div class="chat-bubble-content">
                            <span class="chat-typing-dots"><span></span><span></span><span></span></span>
                        </div>
                    </div>
                    <div class="chat-bubble-part chat-bubble-cards" data-cards></div>
                </div>
            </div>
        `;
        // Insert before progress indicator
        msgContainer.insertBefore(row, progressEl);
        scrollToBottom(msgContainer);
        return { el: row, content: '', thinking: '', toolSteps: [], searchSources: [], pid };
    }

    function finalizeBubble(ph) {
        if (!ph) return;
        const bubble = ph.el.querySelector('.ai-bubble');
        if (bubble) bubble.classList.remove('chat-bubble-typing');
        const contentEl = ph.el.querySelector('.chat-bubble-content');
        if (contentEl && ph.content) {
            contentEl.innerHTML = `<div class="prose prose-invert prose-sm">${formatContent(ph.content)}</div>`;
        }
        if (ph.thinking) {
            const thinkingPart = ph.el.querySelector('[data-thinking]');
            if (thinkingPart) {
                thinkingPart.innerHTML = `
                    <div class="chat-thinking-block">
                        <button type="button" class="chat-thinking-toggle" aria-expanded="false"
                            onclick="const b=this.closest('.chat-thinking-block'); const o=b.classList.toggle('chat-thinking-open'); this.setAttribute('aria-expanded', o?'true':'false')">
                            <i class="fas fa-brain"></i>
                            <span class="chat-thinking-label">${t('conference.thinking') || 'Thinking'}</span>
                            <i class="fas fa-chevron-down chat-thinking-chevron"></i>
                        </button>
                        <div class="chat-thinking-content">
                            <p class="chat-thinking-p">${formatContent(ph.thinking)}</p>
                        </div>
                    </div>
                `;
            }
        }
        if (ph.toolSteps.length) {
            const stepsPart = ph.el.querySelector('[data-steps]');
            if (stepsPart) {
                stepsPart.innerHTML = `
                    <div class="chat-tools-row">
                        <div class="chat-steps">
                            ${ph.toolSteps.map(s => `
                                <span class="chat-step">
                                    <i class="fas ${toolIcon(s.name)} chat-step-icon"></i>
                                    <span class="chat-step-label">${escapeHtml(s.label || s.name || '')}</span>
                                </span>
                            `).join('')}
                        </div>
                        <div class="chat-tools-summary">${ph.toolSteps.length} tool${ph.toolSteps.length > 1 ? 's' : ''}</div>
                    </div>
                `;
            }
        }
        if (ph.searchSources.length) {
            const cardsPart = ph.el.querySelector('[data-cards]');
            if (cardsPart) cardsPart.innerHTML = buildSourcesHtml(ph.searchSources);
        }
    }

    // Incremental chunk rendering — debounced via requestAnimationFrame
    function scheduleChunkRender(ph) {
        if (ph._renderScheduled) return;
        ph._renderScheduled = true;
        requestAnimationFrame(() => {
            ph._renderScheduled = false;
            const contentEl = ph.el.querySelector('.chat-bubble-content');
            if (contentEl && ph.content) {
                contentEl.innerHTML = escapeHtml(ph.content).replace(/\n/g, '<br>');
            }
            scrollToBottom(msgContainer);
        });
    }

    function handleSSEEvent(eventType, data) {
        switch (eventType) {
            case 'discussion_start': {
                const maxT = data.max_turns || 15;
                progressEl.querySelector('.conf-progress-text').textContent =
                    `Discussion starting… (max ${maxT} turns)`;
                break;
            }
            case 'turn_info': {
                const phase = data.phase === 'initial' ? 'Round 1' : 'Free discussion';
                progressEl.querySelector('.conf-progress-text').textContent =
                    `${phase} · Turn ${data.turn}/${data.max_turns} · ${escapeHtml(data.speaker_name || '')}…`;
                break;
            }
            case 'participant_start': {
                // Finalize previous bubble if still active
                if (activePh) finalizeBubble(activePh);

                // Look up participant info
                const p = pMap[data.id] || {};
                const name = data.name || p.name || 'AI';
                const color = data.color || p.color || '#38bdf8';
                const icon = data.icon || p.icon || 'fa-robot';

                activePh = createBubble(data.id, name, color, icon);
                break;
            }
            case 'chunk': {
                if (activePh) {
                    activePh.content += data.content || '';
                    scheduleChunkRender(activePh);
                }
                break;
            }
            case 'thinking': {
                if (activePh) activePh.thinking += data.content || '';
                break;
            }
            case 'tool_use': {
                if (activePh) {
                    activePh.toolSteps.push({ name: data.tool_name || '', label: data.label || data.tool_name || '' });
                    const stepsPart = activePh.el.querySelector('[data-steps]');
                    if (stepsPart) {
                        if (!stepsPart.querySelector('.chat-steps')) {
                            stepsPart.innerHTML = '<div class="chat-tools-row"><div class="chat-steps"></div></div>';
                        }
                        const stepsContainer = stepsPart.querySelector('.chat-steps');
                        if (stepsContainer) {
                            stepsContainer.insertAdjacentHTML('beforeend', `
                                <span class="chat-step">
                                    <i class="fas ${toolIcon(data.tool_name)} chat-step-icon"></i>
                                    <span class="chat-step-label">${escapeHtml(data.label || data.tool_name || '')}</span>
                                </span>
                            `);
                        }
                    }
                }
                break;
            }
            case 'search_sources': {
                if (activePh && Array.isArray(data.sources)) {
                    for (const src of data.sources) activePh.searchSources.push(src);
                    const cardsPart = activePh.el.querySelector('[data-cards]');
                    if (cardsPart) cardsPart.innerHTML = buildSourcesHtml(activePh.searchSources);
                }
                break;
            }
            case 'participant_done': {
                if (activePh) {
                    activePh.content = data.content || activePh.content;
                    if (data.thinking) activePh.thinking = data.thinking;
                    if (data.tool_steps) activePh.toolSteps = data.tool_steps;
                    if (data.search_sources) activePh.searchSources = data.search_sources;
                    finalizeBubble(activePh);
                    activePh = null;
                }
                scrollToBottom(msgContainer);
                break;
            }
            case 'participant_error': {
                if (activePh) {
                    const bubble = activePh.el.querySelector('.ai-bubble');
                    if (bubble) bubble.classList.remove('chat-bubble-typing');
                    const contentEl = activePh.el.querySelector('.chat-bubble-content');
                    if (contentEl) {
                        contentEl.innerHTML = `<span class="text-red-400 text-xs"><i class="fas fa-exclamation-triangle mr-1"></i>${escapeHtml(data.error || 'Error')}</span>`;
                    }
                    activePh = null;
                }
                break;
            }
            case 'discussion_conclude': {
                progressEl.querySelector('.conf-progress-text').textContent =
                    `Discussion concluded after ${data.turns || '?'} turns`;
                progressEl.classList.add('conf-progress-done');
                break;
            }
            case 'synthesis_start': {
                progressEl.querySelector('.conf-progress-text').textContent = 'Generating discussion summary\u2026';
                progressEl.classList.remove('conf-progress-done');
                break;
            }
            case 'discussion_summary': {
                const summaryRow = document.createElement('div');
                summaryRow.className = 'chat-row conf-msg conf-summary-row animate-up';
                summaryRow.innerHTML = `
                    <div class="conf-summary-card glass">
                        <div class="conf-summary-header">
                            <i class="fas fa-clipboard-list"></i>
                            <span>Discussion Summary</span>
                        </div>
                        <div class="conf-summary-content prose prose-invert prose-sm">
                            ${formatContent(data.summary || '')}
                        </div>
                    </div>
                `;
                msgContainer.insertBefore(summaryRow, progressEl);
                scrollToBottom(msgContainer);
                break;
            }
            case 'done':
                scrollToBottom(msgContainer);
                break;
            case 'artifact_update': {
                const panel = document.getElementById('conf-artifact-content');
                if (panel) {
                    panel.innerHTML = formatContent(data.content || '');
                    panel.classList.add('conf-artifact-flash');
                    setTimeout(() => panel.classList.remove('conf-artifact-flash'), 600);
                }
                const metaEl = document.querySelector('.conf-artifact-meta');
                if (metaEl) metaEl.textContent = `v${data.version || 0} — ${escapeHtml(data.updated_by || '')}`;
                // Update local state
                if (_activeConf && _activeConf.artifact) {
                    _activeConf.artifact.content = data.content;
                    _activeConf.artifact.version = data.version;
                }
                break;
            }
            case 'expert_memory': {
                // Update local memory counts
                if (data.persona_id) {
                    _personaMemoryCounts[data.persona_id] = (_personaMemoryCounts[data.persona_id] || 0) + (data.count || 0);
                }
                break;
            }
        }
    }

    try {
        const response = await fetch(`/api/conference/${_activeConf.id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ message: msg }),
            signal: _abortController.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        function parseSSEEvents(chunk) {
            if (!chunk) return;
            sseBuffer += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const blocks = sseBuffer.split('\n\n');
            sseBuffer = blocks.pop() || '';
            for (const block of blocks) {
                if (!block.trim()) continue;
                let eventType = '';
                const dataParts = [];
                for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) eventType = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataParts.push(line.slice(5).replace(/^\s/, ''));
                }
                const dataStr = dataParts.join('\n');
                if (!eventType || !dataStr) continue;
                try {
                    handleSSEEvent(eventType, JSON.parse(dataStr));
                } catch (e) { /* parse error, skip */ }
            }
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parseSSEEvents(decoder.decode(value, { stream: true }));
        }
        parseSSEEvents(decoder.decode());
        if (sseBuffer.trim()) parseSSEEvents('\n\n');
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error('Conference stream error', e);
            showToast('Stream error: ' + e.message, 'error');
        }
    } finally {
        _streaming = false;
        _abortController = null;
        updateSendButton();

        // Finalize any remaining active bubble
        if (activePh) finalizeBubble(activePh);

        // Remove progress indicator or mark as done
        if (progressEl.parentNode) {
            if (progressEl.classList.contains('conf-progress-done')) {
                // Keep conclusion message briefly, then fade
                setTimeout(() => { if (progressEl.parentNode) progressEl.remove(); }, 4000);
            } else {
                progressEl.remove();
            }
        }

        if (_activeConf) await loadConference(_activeConf.id);
    }
}

// ---------------------------------------------------------------------------
// Conference voice input
// ---------------------------------------------------------------------------

async function _checkConfVoice() {
    try {
        const token = localStorage.getItem('memini_token');
        const res = await fetch('/api/config', { headers: { 'Authorization': 'Bearer ' + token } });
        if (res.ok) {
            const cfg = await res.json();
            const voiceBtn = document.getElementById('conf-voice-btn');
            if (voiceBtn) voiceBtn.classList.toggle('hidden', !(cfg.whisper && cfg.whisper.enabled));
        }
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Mid-discussion interjection
// ---------------------------------------------------------------------------

async function sendInterjection() {
    const input = document.getElementById('conf-input');
    const msg = input ? input.value.trim() : '';
    if (!msg || !_activeConf) return;

    input.value = '';
    input.style.height = 'auto';

    // Instantly display user message in chat
    const msgContainer = document.getElementById('conf-messages');
    if (msgContainer) {
        const userRow = document.createElement('div');
        userRow.className = 'chat-row chat-row-user conf-msg animate-up';
        userRow.innerHTML = `
            <div class="chat-msg chat-msg-user">
                <div class="chat-bubble user-bubble">
                    <div class="chat-bubble-content">${escapeHtml(msg)}</div>
                </div>
            </div>
        `;
        msgContainer.appendChild(userRow);
        scrollToBottom(msgContainer, { force: true });
    }

    try {
        const resp = await apiCall(`/api/conference/${_activeConf.id}/interject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg }),
        });
        if (!resp.ok) {
            showToast('Interjection not delivered to server — displayed locally only', 'warning');
            // Mark the bubble as undelivered
            if (msgContainer) {
                const lastRow = msgContainer.querySelector('.chat-row-user:last-of-type .user-bubble');
                if (lastRow) lastRow.style.opacity = '0.5';
            }
        }
    } catch (e) {
        showToast('Interjection failed to send — displayed locally only', 'warning');
        if (msgContainer) {
            const lastRow = msgContainer.querySelector('.chat-row-user:last-of-type .user-bubble');
            if (lastRow) lastRow.style.opacity = '0.5';
        }
    }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function isConferenceNearBottom(el, threshold = CONF_AUTO_SCROLL_THRESHOLD) {
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function initConferenceScrollTracking() {
    const wrapper = document.getElementById('conf-messages');
    if (!wrapper || wrapper === confScrollTrackedElement) return;

    confScrollTrackedElement = wrapper;
    confAutoScrollPinnedToBottom = isConferenceNearBottom(wrapper);
    wrapper.addEventListener('scroll', () => {
        if (confProgrammaticScroll) return;
        confAutoScrollPinnedToBottom = isConferenceNearBottom(wrapper);
    }, { passive: true });
}

function scrollToBottom(el, { behavior = 'smooth', force = false } = {}) {
    if (!el) return;
    initConferenceScrollTracking();
    if (!force && !confAutoScrollPinnedToBottom) return;

    confProgrammaticScroll = true;
    if (force) confAutoScrollPinnedToBottom = true;
    requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior });
        // Clear flag after smooth scroll has time to finish
        setTimeout(() => { confProgrammaticScroll = false; }, 400);
    });
}

function stopConferenceStream() {
    finalizeStoppedConferenceUI();
    if (_abortController) { _abortController.abort(); _abortController = null; }
    if (_activeConf) {
        apiCall(`/api/conference/${_activeConf.id}/abort`, { method: 'POST' }).catch(() => {});
    }
    _streaming = false;
    updateSendButton();
}

function updateSendButton() {
    const sendBtn = document.getElementById('conf-send-btn');
    const stopBtn = document.getElementById('conf-stop-btn');
    if (_streaming) {
        // Show both: send (as interject) + stop
        if (sendBtn) {
            sendBtn.classList.remove('hidden');
            const icon = sendBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-comment-medical';
            sendBtn.title = 'Send interjection';
        }
        if (stopBtn) stopBtn.classList.remove('hidden');
    } else {
        if (sendBtn) {
            sendBtn.classList.remove('hidden');
            const icon = sendBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-paper-plane';
            sendBtn.title = '';
        }
        if (stopBtn) stopBtn.classList.add('hidden');
    }
}

function goBack() {
    _activeConf = null;
    renderConferenceView();
}

// ---------------------------------------------------------------------------
// Edit conference title/topic
// ---------------------------------------------------------------------------
async function editConferenceMeta() {
    if (!_activeConf) return;
    _ensurePersonaModal();
    _editingPersonaId = null;  // not editing a persona

    const body = document.getElementById('conf-modal-body');
    if (!body) return;

    const modalTitle = document.querySelector('#conf-persona-modal .text-accent');
    if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-pen mr-2"></i>Edit Conference';

    body.innerHTML = `
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-heading mr-1"></i>Title</label>
            <input type="text" id="conf-edit-meta-title" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-300 focus:border-accent outline-none transition-colors" value="${escapeHtml(_activeConf.title || '')}">
        </div>
        <div>
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-1.5"><i class="fas fa-comment-dots mr-1"></i>Topic</label>
            <textarea id="conf-edit-meta-topic" rows="3" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-300 focus:border-accent outline-none transition-colors">${escapeHtml(_activeConf.topic || '')}</textarea>
        </div>
    `;

    // Override Save button to call our patch logic
    const saveBtn = document.querySelector('#conf-persona-modal [onclick*="_confSavePersona"]');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            const title = document.getElementById('conf-edit-meta-title')?.value?.trim();
            const topic = document.getElementById('conf-edit-meta-topic')?.value?.trim();
            try {
                const resp = await apiCall(`/api/conference/${_activeConf.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: title || undefined, topic: topic !== undefined ? topic : undefined }),
                });
                if (resp.ok) {
                    const updated = await resp.json();
                    _activeConf.title = updated.title;
                    _activeConf.topic = updated.topic;
                    renderConferenceView();
                    showToast('Conference updated', 'success');
                } else {
                    showToast('Failed to update', 'error');
                }
            } catch (e) {
                showToast('Error updating conference', 'error');
            }
            closePersonaModal();
            // Restore save button handler
            if (saveBtn) saveBtn.onclick = () => window._confSavePersona();
        };
    }

    const modal = document.getElementById('conf-persona-modal');
    if (modal) modal.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Fork — create a what-if branch
// ---------------------------------------------------------------------------
async function forkConference() {
    if (!_activeConf) return;
    try {
        const resp = await apiCall(`/api/conference/${_activeConf.id}/fork`, { method: 'POST' });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err.detail || 'Fork failed', 'error');
            return;
        }
        const forked = await resp.json();
        _conferences.unshift({
            id: forked.id,
            title: forked.title,
            mode: forked.mode,
            participants: forked.participants.map(p => p.name),
            message_count: forked.messages?.length || 0,
            created_at: forked.created_at,
            updated_at: forked.updated_at,
            forked_from: forked.forked_from,
            has_artifact: forked.artifact !== undefined && forked.artifact !== null,
        });
        _activeConf = forked;
        renderConferenceView();
        showToast('Conference forked — you are now on the new branch', 'success');
    } catch (e) {
        showToast('Error forking conference', 'error');
    }
}

// ---------------------------------------------------------------------------
// Artifact panel toggle
// ---------------------------------------------------------------------------
function toggleArtifactPanel() {
    _artifactVisible = !_artifactVisible;
    const panel = document.getElementById('conf-artifact-panel');
    if (panel) panel.classList.toggle('conf-artifact-hidden', !_artifactVisible);
    const backdrop = document.querySelector('.conf-artifact-backdrop');
    if (backdrop) backdrop.classList.toggle('conf-artifact-hidden', !_artifactVisible);
    const actionsEl = document.getElementById('view-header-actions');
    if (actionsEl) {
        const btn = actionsEl.querySelector('.conf-header-btn[title*="artifact"]');
        if (btn) btn.classList.toggle('conf-header-btn-active', _artifactVisible);
    }
    const btn = document.querySelector('.conf-header-btn[title*="artifact"]');
    if (btn) btn.classList.toggle('conf-header-btn-active', _artifactVisible);
}

function toggleArtifactLobby(checked) {
    _artifactEnabled = checked;
    _saveLobbyState();
}

function toggleMemoryLobby(checked) {
    _expertMemoryEnabled = checked;
    _saveLobbyState();
}

// ---------------------------------------------------------------------------
// Persona memory management
// ---------------------------------------------------------------------------
async function clearPersonaMemories(personaId) {
    if (!confirm('Are you sure you want to clear all memories for this persona? This cannot be undone.')) return;
    try {
        const resp = await apiCall(`/api/conference/persona-memories/${personaId}`, { method: 'DELETE' });
        if (resp.ok) {
            _personaMemoryCounts[personaId] = 0;
            showToast('Memories cleared', 'success');
            renderConferenceView();
        }
    } catch (e) { showToast('Error clearing memories', 'error'); }
}

// ---------------------------------------------------------------------------
// Persona memory viewer — view stored memories for a persona
// ---------------------------------------------------------------------------

function _ensureMemoryViewerModal() {
    if (document.getElementById('conf-memory-viewer-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'conf-memory-viewer-modal';
    modal.className = 'modal-overlay app-modal fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4 hidden';
    modal.style.cssText = '';
    modal.innerHTML = `
        <div class="glass app-modal-panel app-modal-content max-w-xl" style="animation: slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);">
            <div class="app-modal-header">
                <h3 class="text-sm font-bold text-violet-400 uppercase tracking-widest flex items-center gap-2" id="conf-memory-viewer-title"><i class="fas fa-brain"></i>Expert Memory</h3>
                <button onclick="window._confCloseMemoryViewer()" class="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white flex items-center justify-center transition-all" aria-label="Close"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="app-modal-body" id="conf-memory-viewer-body">
                <div class="flex items-center justify-center py-8 text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</div>
            </div>
            <div class="app-modal-footer justify-end">
                <button onclick="window._confCloseMemoryViewer()" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-white/5 transition-colors">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

async function viewPersonaMemories(personaId) {
    if (!_personas || !_personas[personaId]) return;
    const persona = _personas[personaId];
    _ensureMemoryViewerModal();

    // Close the settings modal and open the viewer
    closePersonaModal();
    const modal = document.getElementById('conf-memory-viewer-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const titleEl = document.getElementById('conf-memory-viewer-title');
    const ov = _personaOverrides[personaId] || {};
    const memDisplayName = ov.name || persona.name;
    if (titleEl) titleEl.innerHTML = `<i class="fas fa-brain"></i>${escapeHtml(memDisplayName)} — Memories`;

    const body = document.getElementById('conf-memory-viewer-body');
    if (body) body.innerHTML = '<div class="flex items-center justify-center py-8 text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</div>';

    try {
        const resp = await apiCall(`/api/conference/persona-memories/${personaId}`);
        if (!resp.ok) throw new Error('Failed to load');
        const result = await resp.json();
        const memories = result.memories || [];

        if (memories.length === 0) {
            body.innerHTML = '<div class="text-center py-8 text-slate-500"><i class="fas fa-brain mr-2 opacity-50"></i>No memories stored yet</div>';
            return;
        }

        body.innerHTML = `
            <div class="space-y-2">
                ${memories.map((mem, i) => `
                    <div class="conf-memory-item group flex items-start gap-3 p-3 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 transition-colors">
                        <div class="w-6 h-6 rounded-full bg-violet-500/20 text-violet-400 flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">${i + 1}</div>
                        <div class="text-sm text-slate-300 flex-1 leading-relaxed">${escapeHtml(mem)}</div>
                        <button type="button" title="Delete this memory"
                            onclick="window._confDeleteSingleMemory('${personaId}', ${i})"
                            class="w-7 h-7 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-400/10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                            <i class="fas fa-trash-can text-xs"></i>
                        </button>
                    </div>
                `).join('')}
            </div>
            <div class="mt-4 flex items-center justify-between">
                <span class="text-xs text-slate-500">${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} stored</span>
                <button type="button" class="conf-reset-btn text-red-400 hover:text-red-300" onclick="window._confClearMemories('${personaId}'); window._confCloseMemoryViewer();">
                    <i class="fas fa-trash mr-1"></i>Clear all
                </button>
            </div>
        `;
    } catch (e) {
        body.innerHTML = `<div class="text-center py-8 text-red-400"><i class="fas fa-exclamation-triangle mr-2"></i>Failed to load memories</div>`;
    }
}

function closeMemoryViewer() {
    const modal = document.getElementById('conf-memory-viewer-modal');
    if (modal) modal.classList.add('hidden');
}

async function deleteSingleMemory(personaId, index) {
    try {
        const resp = await apiCall(`/api/conference/persona-memories/${personaId}`);
        if (!resp.ok) throw new Error('Failed to load');
        const result = await resp.json();
        const memories = result.memories || [];
        if (index < 0 || index >= memories.length) return;

        // Capture the memory content to delete (avoids index-shift race)
        const targetContent = memories[index];

        // Re-fetch fresh list and remove by content match
        const freshResp = await apiCall(`/api/conference/persona-memories/${personaId}`);
        if (!freshResp.ok) throw new Error('Failed to re-fetch');
        const freshResult = await freshResp.json();
        const freshMemories = freshResult.memories || [];
        const targetIdx = freshMemories.indexOf(targetContent);
        if (targetIdx === -1) {
            showToast('Memory already removed', 'info');
            viewPersonaMemories(personaId);
            return;
        }
        freshMemories.splice(targetIdx, 1);

        // Save updated list (use PUT endpoint)
        const saveResp = await apiCall(`/api/conference/persona-memories/${personaId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memories: freshMemories }),
        });
        if (!saveResp.ok) throw new Error('Failed to save');

        _personaMemoryCounts[personaId] = freshMemories.length;
        showToast('Memory deleted', 'success');

        // Re-render the viewer
        if (freshMemories.length === 0) {
            closeMemoryViewer();
            renderConferenceView();
        } else {
            viewPersonaMemories(personaId);
        }
    } catch (e) {
        showToast('Error deleting memory', 'error');
    }
}

// ---------------------------------------------------------------------------
// Window-exposed functions
// ---------------------------------------------------------------------------
window._confTogglePersona = togglePersona;
window._confSetMode = setMode;
window._confCreate = createConference;
window._confEditPersona = openPersonaModal;
window._confCloseModal = closePersonaModal;
window._confSavePersona = savePersonaSettings;
window._confResetPrompt = resetPromptToDefault;
window._confOpen = async (id) => { if (await loadConference(id)) renderConferenceView(); };
window._confDelete = deleteConference;
window._confSend = () => { _streaming ? sendInterjection() : sendConferenceMessage(); };
window._confStop = () => stopConferenceStream();
window._confBack = goBack;
window._confFork = forkConference;
window._confEditMeta = editConferenceMeta;
window._confToggleArtifactPanel = toggleArtifactPanel;
window._confToggleArtifact = toggleArtifactLobby;
window._confToggleMemory = toggleMemoryLobby;
window._confClearMemories = clearPersonaMemories;
window._confSetPage = setConferencePage;
window._confViewMemories = viewPersonaMemories;
window._confCloseMemoryViewer = closeMemoryViewer;
window._confDeleteSingleMemory = deleteSingleMemory;

// Icon & color picker helpers
window._confPickIcon = (icon) => {
    document.getElementById('conf-edit-icon').value = icon;
    document.querySelectorAll('#conf-icon-grid .conf-icon-pick').forEach(b => {
        b.classList.toggle('conf-icon-pick-active', b.dataset.icon === icon);
    });
};
window._confPickColor = (color) => {
    document.getElementById('conf-edit-color').value = color;
    document.querySelectorAll('#conf-color-row .conf-color-pick').forEach(b => {
        b.classList.toggle('conf-color-pick-active', b.dataset.color === color);
    });
};

window._confVoice = () => {
    if (typeof window.toggleVoiceRecording === 'function') {
        const btn = document.getElementById('conf-voice-btn');
        window.toggleVoiceRecording({ btn, inputId: 'conf-input', sendFn: () => sendConferenceMessage() });
    }
};
