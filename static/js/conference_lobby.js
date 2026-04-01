import { apiCall } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, showToast } from './utils.js';

const PERSONA_ICONS = [
    'fa-chart-line','fa-paintbrush','fa-gavel','fa-wrench','fa-rocket','fa-mask',
    'fa-brain','fa-lightbulb','fa-code','fa-flask','fa-shield','fa-star',
    'fa-fire','fa-bolt','fa-gem','fa-globe','fa-compass','fa-crown',
    'fa-eye','fa-dragon','fa-chess-knight','fa-scale-balanced','fa-user-secret',
    'fa-microscope','fa-book','fa-graduation-cap','fa-palette','fa-heart',
    'fa-wand-magic-sparkles','fa-hands-holding','fa-seedling','fa-feather',
];

const PERSONA_COLORS = [
    '#3b82f6','#f59e0b','#ef4444','#10b981','#8b5cf6','#ec4899',
    '#06b6d4','#f97316','#84cc16','#14b8a6','#6366f1','#e11d48',
    '#0ea5e9','#d946ef','#a3e635','#fbbf24','#f43f5e','#22d3ee',
];

export function ensureConferencePersonaModal() {
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

export function openConferencePersonaModal({
    id,
    personas,
    personaOverrides,
    modelProfiles,
    personaMemoryCounts,
}) {
    if (!personas || !personas[id]) return false;
    ensureConferencePersonaModal();
    const p = personas[id];
    const override = personaOverrides[id] || {};
    const profileOptionsHtml = modelProfiles.map(mp =>
        `<option value="${mp.id}" ${override.model_profile_id === mp.id ? 'selected' : ''}>${escapeHtml(mp.name)} (${escapeHtml(mp.model_name || '')})</option>`
    ).join('');

    const currentIcon = override.icon || p.icon;
    const currentColor = override.color || p.color;
    const body = document.getElementById('conf-modal-body');
    if (!body) return false;

    const iconGridHtml = PERSONA_ICONS.map(ic =>
        `<button type="button" class="conf-icon-pick ${ic === currentIcon ? 'conf-icon-pick-active' : ''}" data-icon="${ic}" onclick="window._confPickIcon('${ic}')" title="${ic}">
            <i class="fas ${ic}"></i>
        </button>`
    ).join('');

    const colorRowHtml = PERSONA_COLORS.map(c =>
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
            const memCount = personaMemoryCounts[id] || 0;
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
    return true;
}

export function closeConferencePersonaModal() {
    const modal = document.getElementById('conf-persona-modal');
    if (modal) modal.classList.add('hidden');
}

export function resetConferencePromptToDefault(editingPersonaId, personas) {
    if (!editingPersonaId || !personas[editingPersonaId]) return;
    const ta = document.getElementById('conf-edit-prompt');
    if (ta) ta.value = personas[editingPersonaId].system || '';
}

export function saveConferencePersonaSettings({
    editingPersonaId,
    personas,
    personaOverrides,
    modelProfiles,
    saveLobbyState,
    updatePersonaCard,
    closePersonaModal,
}) {
    if (!editingPersonaId || !personas[editingPersonaId]) return false;
    const id = editingPersonaId;
    const p = personas[id];

    const nameEl = document.getElementById('conf-edit-name');
    const modelEl = document.getElementById('conf-edit-model');
    const promptEl = document.getElementById('conf-edit-prompt');
    const toolsEl = document.getElementById('conf-edit-tools');

    if (!nameEl || !modelEl || !promptEl) {
        console.warn('[Conference] savePersonaSettings: form elements not found in DOM');
        showToast('Save failed — form not found', 'error');
        return false;
    }

    const savedName = nameEl.value.trim() || p.name;
    const savedModel = modelEl.value || '';
    const savedPrompt = promptEl.value.trim() || '';
    const savedTools = toolsEl?.checked ?? true;
    const savedIcon = document.getElementById('conf-edit-icon')?.value || p.icon;
    const savedColor = document.getElementById('conf-edit-color')?.value || p.color;

    personaOverrides[id] = {
        name: savedName,
        icon: savedIcon,
        color: savedColor,
        model_profile_id: savedModel,
        system_prompt: savedPrompt,
        tools_enabled: savedTools,
    };

    saveLobbyState();
    closePersonaModal();
    updatePersonaCard(id);

    const modelName = savedModel ? (modelProfiles.find(mp => mp.id === savedModel)?.name || savedModel) : 'default';
    showToast(`${savedName}: model=${modelName}, prompt=${savedPrompt ? savedPrompt.length + ' chars' : 'default'}, tools=${savedTools ? 'on' : 'off'}`, 'success');
    return true;
}

export function toggleConferencePersona({
    id,
    selectedPersonas,
    personaOverrides,
    saveLobbyState,
    updatePersonaCard,
    updateCreateButton,
}) {
    if (selectedPersonas.has(id)) {
        selectedPersonas.delete(id);
        delete personaOverrides[id];
    } else {
        if (selectedPersonas.size >= 6) {
            showToast(t('conference.max_participants') || 'Maximum 6 participants', 'warning');
            return false;
        }
        selectedPersonas.add(id);
    }
    saveLobbyState();
    updatePersonaCard(id);
    updateCreateButton();
    return true;
}

export function updateConferencePersonaCard({
    id,
    personas,
    selectedPersonas,
    personaOverrides,
    onEdit,
}) {
    const card = document.querySelector(`.conf-persona-card[data-persona="${id}"]`);
    if (!card || !personas) return;
    const p = personas[id];
    if (!p) return;
    const isSelected = selectedPersonas.has(id);
    const override = personaOverrides[id] || {};
    const displayName = override.name || p.name;
    const displayIcon = override.icon || p.icon;
    const displayColor = override.color || p.color;

    card.classList.toggle('conf-persona-selected', isSelected);

    const nameEl = card.querySelector('.conf-persona-name');
    if (nameEl) nameEl.textContent = displayName;

    const avatar = card.querySelector('.conf-persona-avatar');
    if (avatar) {
        avatar.style.setProperty('--persona-color', displayColor);
        const iconEl = avatar.querySelector('i');
        if (iconEl) iconEl.className = `fas ${displayIcon}`;
    }

    let check = card.querySelector('.conf-persona-check');
    if (isSelected && !check) {
        check = document.createElement('div');
        check.className = 'conf-persona-check';
        check.innerHTML = '<i class="fas fa-check"></i>';
        card.appendChild(check);
    } else if (!isSelected && check) {
        check.remove();
    }

    let editBtn = card.querySelector('.conf-persona-edit');
    if (isSelected && !editBtn) {
        editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'conf-persona-edit';
        editBtn.title = 'Edit settings';
        editBtn.innerHTML = '<i class="fas fa-sliders"></i>';
        editBtn.addEventListener('click', e => { e.stopPropagation(); onEdit(id); });
        card.appendChild(editBtn);
    } else if (!isSelected && editBtn) {
        editBtn.remove();
    }
}

export function updateConferenceCreateButton(selectedCount) {
    const btn = document.getElementById('conf-create-btn');
    if (!btn) return;
    const enabled = selectedCount >= 2;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '' : '0.35';
    btn.style.cursor = enabled ? '' : 'not-allowed';
    btn.style.boxShadow = enabled ? '' : 'none';
}

export function setConferenceMode({ mode, availableModes, saveLobbyState }) {
    saveLobbyState();
    const modeData = availableModes.find(m => m.id === mode);
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

export async function createConferenceFromLobby({
    selectedPersonas,
    personas,
    personaOverrides,
    selectedMode,
    artifactEnabled,
    expertMemoryEnabled,
    setActiveConf,
    conferences,
    renderConferenceView,
    sendConferenceMessage,
}) {
    const topicEl = document.getElementById('conf-topic');
    const topic = topicEl ? topicEl.value.trim() : '';
    if (selectedPersonas.size < 2) {
        showToast(t('conference.need_participants') || 'Select at least 2 AI participants', 'warning');
        return false;
    }

    const participantsConfig = [...selectedPersonas].map(pid => {
        const p = personas[pid];
        const ov = personaOverrides[pid] || {};
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
                mode: selectedMode,
                participants_config: participantsConfig,
                topic,
                artifact_enabled: artifactEnabled,
                expert_memory_enabled: expertMemoryEnabled,
            }),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            showToast(err.detail || 'Error creating conference', 'error');
            return false;
        }

        const activeConf = await resp.json();
        setActiveConf(activeConf);
        conferences.unshift({
            id: activeConf.id,
            title: activeConf.title,
            mode: activeConf.mode,
            participants: activeConf.participants.map(p => p.name),
            message_count: 0,
            created_at: activeConf.created_at,
            updated_at: activeConf.updated_at,
        });
        renderConferenceView();
        if (topic) setTimeout(() => sendConferenceMessage(topic), 300);
        return true;
    } catch (e) {
        showToast('Error creating conference', 'error');
        return false;
    }
}
