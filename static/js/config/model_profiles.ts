/**
 * Model profiles list, editor, and chat model selector.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm, openSubPage, closeSubPage } from '../utils.js';
import { updateThinkingModeUi } from '../thinking_mode.js';
import { syncChatVoiceControls } from '../chat/voice_controls.js';
import type { ModelProfile, ModelProfilesResponse } from '../types/features_config.js';
import { cfgField, cfgVal } from './utils.js';

let _modelProfiles: ModelProfile[] = [];
let _activeProfileId = '';
let _defaultProfileId = '';  // per-user default (selector); active_id is global for admin

export async function loadModelProfiles() {
    try {
        const res = await apiCall('/api/model-profiles');
        if (!res.ok) return;
        const data = await res.json();
        _modelProfiles = data.profiles || [];
        _activeProfileId = data.active_id || '';
        _defaultProfileId = data.default_profile_id || '';
        renderProfilesList();
        renderModelSelector(data);
        renderAutoRouterStats(data.auto_router_stats);
        syncChatVoiceControls();
    } catch (e) { console.warn('loadModelProfiles error', e); }
}

function renderAutoRouterStats(stats: ModelProfilesResponse['auto_router_stats']) {
    const el = cfgField('auto-router-stats');
    if (!el) return;
    if (!stats || typeof stats.local !== 'number' || typeof stats.api !== 'number') {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    const label = t('config.auto_router_stats_label');
    el.innerHTML = `${label} <span class="text-slate-400">${stats.local} local</span>, <span class="text-slate-400">${stats.api} API</span>`;
}

function renderProfilesList() {
    const container = cfgField('model-profiles-list');
    if (!container) return;
    if (!_modelProfiles.length) {
        container.innerHTML = `<p class="text-[10px] text-slate-600 col-span-2 text-center py-4">${escapeHtml(t('config.profiles_empty'))}</p>`;
        return;
    }
    container.innerHTML = _modelProfiles.map((p, index) => {
        const visible = p.visible_in_selector !== false;
        const providerLabels: Record<string, string> = { local: 'Local', z_ai: 'Z.AI', openai: 'OpenAI', grok: 'Grok', deepseek: 'DeepSeek' };
        const providerLabel = providerLabels[p.provider || ''] || p.provider || '';
        const auxBadge = p.aux_llm_enabled ? '<span class="inline-flex items-center text-[9px] bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded-full ml-1">AUX</span>' : '';
        const coderBadge = p.coder_enabled ? '<span class="inline-flex items-center text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded-full ml-0.5">COD</span>' : '';
        const visionBadge = p.vision_enabled ? '<span class="inline-flex items-center text-[9px] bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded-full ml-0.5">VIS</span>' : '';
        const embedBadge = p.embed_enabled ? '<span class="inline-flex items-center text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded-full ml-0.5">EMB</span>' : '';
        const personaOverrideBadge = (p.persona_override || '').trim() ? '<span class="inline-flex items-center gap-0.5 text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded-full ml-0.5" title="' + t('config.profile_persona_override_badge_title') + '"><i class="fas fa-file-alt text-[8px]"></i><span>' + t('config.profile_prompt_override_pill') + '</span></span>' : '';
        const inSelectorClass = visible ? ' profile-card-in-selector' : '';
        const reasoning = p.capability_reasoning !== false;
        const tools = p.capability_tool_calling !== false;
        const vision = p.capability_vision !== false;
        const capIcons = [reasoning && '<i class="fas fa-brain profile-cap-icon" title="Reasoning"></i>', tools && '<i class="fas fa-wrench profile-cap-icon" title="Tool calling"></i>', vision && '<i class="fas fa-eye profile-cap-icon" title="Vision"></i>'].filter(Boolean).join('');
        const canMoveUp = index > 0;
        const canMoveDown = index < _modelProfiles.length - 1;
        const moveUpTitle = t('config.profile_move_up');
        const moveDownTitle = t('config.profile_move_down');
        const orderBtns = `<span class="profile-card-order-btns">
            ${canMoveUp ? `<button type="button" class="profile-card-order-btn" data-config-action="moveProfileOrder" data-config-profile-id="${escapeHtml(p.id)}" data-config-direction="up" title="${moveUpTitle}" aria-label="${moveUpTitle}"><i class="fas fa-chevron-up"></i></button>` : '<span class="profile-card-order-btn profile-card-order-btn-disabled" aria-hidden="true"><i class="fas fa-chevron-up"></i></span>'}
            ${canMoveDown ? `<button type="button" class="profile-card-order-btn" data-config-action="moveProfileOrder" data-config-profile-id="${escapeHtml(p.id)}" data-config-direction="down" title="${moveDownTitle}" aria-label="${moveDownTitle}"><i class="fas fa-chevron-down"></i></button>` : '<span class="profile-card-order-btn profile-card-order-btn-disabled" aria-hidden="true"><i class="fas fa-chevron-down"></i></span>'}
        </span>`;
        return `
            <div class="profile-card${inSelectorClass}" data-profile-id="${escapeHtml(p.id)}">
                <span class="profile-card-drag-handle" draggable="true" data-profile-id="${escapeHtml(p.id)}" title="${escapeHtml(t('config.profile_drag_reorder'))}"><i class="fas fa-grip-vertical"></i></span>
                ${orderBtns}
                <div class="profile-card-dot" style="background:${escapeHtml(p.color || '#6366f1')}"></div>
                <div class="profile-card-info">
                    <div class="profile-card-name">${escapeHtml(p.name)}${auxBadge}${coderBadge}${visionBadge}${embedBadge}${personaOverrideBadge}</div>
                    <div class="profile-card-meta"><span class="profile-card-meta-text">${escapeHtml(providerLabel)} · ${escapeHtml(p.model_name || '?')}</span>${capIcons ? `<span class="profile-card-caps">${capIcons}</span>` : ''}</div>
                </div>
                <button type="button" class="profile-card-activate" data-config-action="openProfileCardMenu" data-config-profile-id="${escapeHtml(p.id)}">${escapeHtml(t('config.profile_options_btn'))}</button>
            </div>`;
    }).join('');
    bindProfileCardDragDrop(container);
}

export async function moveProfileOrder(profileId: string, direction: 'up' | 'down') {
    const ids = _modelProfiles.map(p => p.id);
    const idx = ids.indexOf(profileId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ids.length) return;
    const reordered = [...ids];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    try {
        const res = await apiCall('/api/model-profiles/reorder', { method: 'POST', body: { order: reordered } });
        if (!res.ok) throw new Error();
        showToast(t('config.profile_order_saved'), 'success');
        await loadModelProfiles();
    } catch (err) {
        showToast(t('config.profile_order_error'), 'error');
    }
};

function bindProfileCardDragDrop(container: HTMLElement) {
    if (!container || container.dataset.dragBound === '1') return;
    container.dataset.dragBound = '1';
    let draggedId: string | null = null;
    container.addEventListener('dragstart', (e: DragEvent) => {
        const tgt = e.target as HTMLElement | null;
        if (!tgt) return;
        const handle = tgt.closest('.profile-card-drag-handle');
        if (!handle) return;
        const id = handle.getAttribute('data-profile-id');
        if (!id) return;
        draggedId = id;
        e.dataTransfer?.setData('text/plain', id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        const card = handle.closest('.profile-card');
        if (card) card.classList.add('dragging');
    });
    container.addEventListener('dragend', (e: DragEvent) => {
        const tgt = e.target as HTMLElement | null;
        if (tgt?.closest('.profile-card-drag-handle')) {
            container.querySelectorAll('.profile-card').forEach(el => el.classList.remove('dragging', 'drag-over'));
        }
        draggedId = null;
    });
    container.addEventListener('dragover', (e: DragEvent) => {
        const tgt = e.target as HTMLElement | null;
        if (!tgt) return;
        const card = tgt.closest('.profile-card');
        if (!card || !draggedId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
    });
    container.addEventListener('dragleave', (e: DragEvent) => {
        const tgt = e.target as HTMLElement | null;
        if (!tgt) return;
        const card = tgt.closest('.profile-card');
        if (card && !card.contains(e.relatedTarget as Node | null)) card.classList.remove('drag-over');
    });
    container.addEventListener('drop', async (e: DragEvent) => {
        const tgt = e.target as HTMLElement | null;
        if (!tgt) return;
        const card = tgt.closest('.profile-card');
        if (!card || !draggedId) return;
        e.preventDefault();
        card.classList.remove('drag-over');
        const targetId = card.getAttribute('data-profile-id');
        if (!targetId || targetId === draggedId) return;
        const ids = _modelProfiles.map(p => p.id);
        const fromIdx = ids.indexOf(draggedId);
        const toIdx = ids.indexOf(targetId);
        if (fromIdx === -1 || toIdx === -1) return;
        const reordered = [..._modelProfiles];
        const [removed] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, removed);
        const order = reordered.map(p => p.id);
        try {
            const res = await apiCall('/api/model-profiles/reorder', { method: 'POST', body: { order } });
            if (!res.ok) throw new Error();
            showToast(t('config.profile_order_saved'), 'success');
            await loadModelProfiles();
        } catch (err) {
            showToast(t('config.profile_order_error'), 'error');
        }
    });
}

function _profileGlowColor(profileId: string): string {
    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (profileId || '').toLowerCase() === 'auto';
    if (isAuto) return '#38bdf8';
    return (visibleProfiles.find(p => p.id === profileId)?.color || '#38bdf8').trim();
}

function _syncChatBarProfileGlow(profileId: string): void {
    const bar = document.querySelector('.chat-input-inner') as HTMLElement | null;
    if (!bar) return;
    bar.style.setProperty('--profile-glow-color', _profileGlowColor(profileId));
}

function renderModelSelector(_data: ModelProfilesResponse) {
    const listEl = cfgField('model-selector-profiles');
    if (!listEl) return;

    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (_defaultProfileId || '').toLowerCase() === 'auto';
    const activeProfile = isAuto ? null : (visibleProfiles.find(p => p.id === _defaultProfileId) || visibleProfiles[0]);
    const activeId = isAuto ? 'auto' : (activeProfile?.id || _defaultProfileId || 'auto');

    const autoLabel = t('config.model_selector_auto');
    _syncChatBarProfileGlow(activeId);
    const autoButton = `
        <button type="button" class="model-selector-item hyd-entity-row hyd-entity-row--nested hyd-entity-row--static w-full text-left${isAuto ? ' is-active' : ''}" data-chat-action="activateProfile" data-chat-profile-id="auto">
            <span class="model-selector-item-dot" style="background:#38bdf8"></span>
            <div class="hyd-entity-row__body min-w-0">
                <div class="hyd-entity-row__name">${escapeHtml(autoLabel)}</div>
            </div>
            <i class="fas fa-check model-selector-item-check" aria-hidden="true"></i>
        </button>`;

    if (!visibleProfiles.length) {
        listEl.innerHTML = autoButton + `<div class="model-selector-empty"><i class="fas fa-info-circle mr-1"></i>${escapeHtml(t('config.model_selector_empty'))}</div>`;
        updateChatAttachVisibility();
        return;
    }

    listEl.innerHTML = autoButton + visibleProfiles.map(p => {
        const isActive = p.id === _defaultProfileId;
        const reasoning = p.capability_reasoning !== false;
        const tools = p.capability_tool_calling !== false;
        const vision = p.capability_vision !== false;
        const capsHtml = [reasoning && '<i class="fas fa-brain model-selector-cap-icon" title="Reasoning"></i>', tools && '<i class="fas fa-wrench model-selector-cap-icon" title="Tool calling"></i>', vision && '<i class="fas fa-eye model-selector-cap-icon" title="Vision"></i>'].filter(Boolean).join('');
        return `
            <button type="button" class="model-selector-item hyd-entity-row hyd-entity-row--nested hyd-entity-row--static w-full text-left${isActive ? ' is-active' : ''}" data-chat-action="activateProfile" data-chat-profile-id="${escapeHtml(p.id)}">
                <span class="model-selector-item-dot" style="background:${escapeHtml(p.color || '#6366f1')}"></span>
                <div class="hyd-entity-row__body min-w-0">
                    <div class="hyd-entity-row__name">${escapeHtml(p.name)}</div>
                    <div class="hyd-entity-row__sub mono">${escapeHtml(p.model_name || '')}</div>
                </div>
                ${capsHtml ? `<div class="model-selector-item-caps">${capsHtml}</div>` : ''}
                <i class="fas fa-check model-selector-item-check" aria-hidden="true"></i>
            </button>`;
    }).join('');
    updateChatAttachVisibility();
    updateThinkingModeUi();
}

function updateChatAttachVisibility() {
    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (_defaultProfileId || '').toLowerCase() === 'auto';
    const activeProfile = isAuto ? null : visibleProfiles.find(p => p.id === _defaultProfileId) || visibleProfiles[0];
    const hasVision = isAuto || (activeProfile ? (activeProfile.capability_vision !== false) : true);
    const imageItem = document.querySelector('.chat-attach-balloon-item[data-attach="image"]') as HTMLElement | null;
    const cameraItem = document.querySelector('.chat-attach-balloon-item[data-attach="camera"]') as HTMLElement | null;
    if (imageItem) imageItem.style.display = hasVision ? '' : 'none';
    if (cameraItem) cameraItem.style.display = hasVision ? '' : 'none';

    const btnAttach = cfgField('btn-attach');
    if (!btnAttach) return;
    const iconEl = btnAttach.querySelector('i.fas');
    if (!iconEl) return;
    if (!hasVision) {
        btnAttach.setAttribute('data-single-attach', 'document');
        iconEl.className = 'fas fa-file-alt';
        const docLabel = t('chat.attach_document');
        btnAttach.setAttribute('aria-label', docLabel);
        btnAttach.title = docLabel;
        btnAttach.setAttribute('aria-haspopup', 'false');
    } else {
        btnAttach.removeAttribute('data-single-attach');
        iconEl.className = 'fas fa-plus';
        const attachLabel = t('chat.attach_image');
        btnAttach.setAttribute('aria-label', attachLabel);
        btnAttach.title = attachLabel;
        btnAttach.setAttribute('aria-haspopup', 'true');
    }
}

export function syncVisionCapabilityCheckbox() {
    const visionEnabledEl = cfgField('profile-vision-enabled');
    const visionUrlEl = cfgField('profile-vision-url');
    const visionModelEl = cfgField('profile-vision-model');
    const capVision = cfgField('profile-capability-vision');
    if (!capVision) return;
    const visionConfigured = visionEnabledEl?.checked && ((visionUrlEl?.value || '').trim() || (visionModelEl?.value || '').trim());
    if (visionConfigured) {
        capVision.checked = true;
        capVision.disabled = true;
    } else {
        capVision.disabled = false;
    }
};

export function showProfileEditor(profileId?: string | null) {
    const overlay = cfgField('profile-editor-overlay');
    if (!overlay) return;
    const titleEl = cfgField('profile-editor-title');
    const idEl = cfgField('profile-edit-id');
    const nameEl = cfgField('profile-name');
    const provEl = cfgField('profile-provider');
    const urlEl = cfgField('profile-url');
    const modelEl = cfgField('profile-model');
    const keyEl = cfgField('profile-api-key');
    const tempEl = cfgField('profile-temperature');
    const timeoutEl = cfgField('profile-timeout');
    const ctxEl = cfgField('profile-context');
    const colorEl = cfgField('profile-color');
    const _colorSwatches = cfgField('profile-color-swatches');
    const _colorHex = cfgField('profile-color-hex');
    const _colorPreview = cfgField('profile-color-preview');
    const auxEnabledEl = cfgField('profile-aux-enabled');
    const auxUrlEl = cfgField('profile-aux-url');
    const auxModelEl = cfgField('profile-aux-model');
    const auxKeyEl = cfgField('profile-aux-key');
    const auxFields = cfgField('profile-aux-fields');
    const keyRow = cfgField('profile-api-key-row');
    if (!titleEl || !idEl || !nameEl || !provEl || !urlEl || !modelEl || !keyEl || !tempEl || !timeoutEl || !ctxEl || !colorEl) return;
    if (!auxEnabledEl || !auxUrlEl || !auxModelEl || !auxKeyEl || !auxFields || !keyRow) return;
    const colorInput = colorEl;
    function _syncColor(hex: string) {
        if (!_colorSwatches) return;
        const norm = (hex || '').toLowerCase();
        colorInput.value = norm;
        _colorSwatches.querySelectorAll('.color-swatch').forEach(s => {
            s.classList.toggle('active', (s as HTMLElement).dataset.color === norm);
        });
        if (_colorPreview) _colorPreview.style.background = norm;
        if (_colorHex && document.activeElement !== _colorHex) _colorHex.value = norm;
    }
    if (_colorSwatches) {
        _colorSwatches.addEventListener('click', (e: MouseEvent) => {
            const tgt = e.target as HTMLElement | null;
            const sw = tgt?.closest('.color-swatch') as HTMLElement | null;
            if (sw) { _syncColor(sw.dataset.color || ''); }
        });
    }
    if (_colorHex) {
        _colorHex.addEventListener('input', () => {
            let v = _colorHex.value.trim();
            if (v && !v.startsWith('#')) v = '#' + v;
            if (/^#[0-9a-f]{6}$/i.test(v)) _syncColor(v);
        });
        _colorHex.addEventListener('blur', () => {
            _colorHex.value = colorEl.value;
        });
    }
    // Coder fields
    const coderEnabledEl = cfgField('profile-coder-enabled');
    const coderProvEl = cfgField('profile-coder-provider');
    const coderUrlEl = cfgField('profile-coder-url');
    const coderModelEl = cfgField('profile-coder-model');
    const coderKeyEl = cfgField('profile-coder-key');
    const coderTimeoutEl = cfgField('profile-coder-timeout');
    const coderFields = cfgField('profile-coder-fields');
    // Vision fields
    const visionEnabledEl = cfgField('profile-vision-enabled');
    const visionProvEl = cfgField('profile-vision-provider');
    const visionUrlEl = cfgField('profile-vision-url');
    const visionModelEl = cfgField('profile-vision-model');
    const visionKeyEl = cfgField('profile-vision-key');
    const visionTimeoutEl = cfgField('profile-vision-timeout');
    const visionRespondEl = cfgField('profile-vision-respond-directly');
    const visionFields = cfgField('profile-vision-fields');
    // Embedding fields
    const embedEnabledEl = cfgField('profile-embed-enabled');
    const embedModelEl = cfgField('profile-embed-model');
    const embedFields = cfgField('profile-embed-fields');

    if (profileId) {
        const p = _modelProfiles.find(x => x.id === profileId);
        if (!p) return;
        titleEl.textContent = t('config.profile_editor_title_edit');
        idEl.value = p.id;
        nameEl.value = p.name || '';
        provEl.value = p.provider || 'local';
        urlEl.value = p.target_url || '';
        modelEl.value = p.model_name || '';
        keyEl.value = p.api_key || '';
        tempEl.value = String(p.temperature ?? 0.7);
        timeoutEl.value = String(p.timeout ?? 120);
        ctxEl.value = String(p.context_length ?? 24000);
        colorEl.value = p.color || '#6366f1';
        _syncColor(colorEl.value);
        const personaOverrideEl = cfgField('profile-persona-override');
        if (personaOverrideEl) personaOverrideEl.value = p.persona_override || '';
        const capReason = cfgField('profile-capability-reasoning');
        const capTools = cfgField('profile-capability-tools');
        const capVision = cfgField('profile-capability-vision');
        if (capReason) capReason.checked = p.capability_reasoning !== false;
        if (capTools) capTools.checked = p.capability_tool_calling !== false;
        if (capVision) capVision.checked = p.capability_vision !== false;
        auxEnabledEl.checked = !!p.aux_llm_enabled;
        const aux = p.aux_llm || {};
        auxUrlEl.value = aux.target_url || '';
        auxModelEl.value = aux.model_name || '';
        auxKeyEl.value = aux.api_key || '';
        // Coder
        if (coderEnabledEl) coderEnabledEl.checked = !!p.coder_enabled;
        const coder = p.coder || {};
        if (coderProvEl) coderProvEl.value = coder.provider || 'local';
        if (coderUrlEl) coderUrlEl.value = coder.target_url || '';
        if (coderModelEl) coderModelEl.value = coder.model_name || '';
        if (coderKeyEl) coderKeyEl.value = coder.api_key || '';
        if (coderTimeoutEl) coderTimeoutEl.value = String(coder.timeout ?? 180);
        if (coderFields) coderFields.classList.toggle('hidden', !p.coder_enabled);
        // Vision
        if (visionEnabledEl) visionEnabledEl.checked = !!p.vision_enabled;
        const vision = p.vision_llm || {};
        if (visionProvEl) visionProvEl.value = vision.provider || 'local';
        if (visionUrlEl) visionUrlEl.value = vision.target_url || '';
        if (visionModelEl) visionModelEl.value = vision.model_name || '';
        if (visionKeyEl) visionKeyEl.value = vision.api_key || '';
        if (visionTimeoutEl) visionTimeoutEl.value = String(vision.timeout ?? 60);
        if (visionRespondEl) visionRespondEl.checked = !!vision.respond_directly;
        if (visionFields) visionFields.classList.toggle('hidden', !p.vision_enabled);
        // Embedding
        if (embedEnabledEl) embedEnabledEl.checked = !!p.embed_enabled;
        const embed = p.librarian || {};
        if (embedModelEl) embedModelEl.value = embed.model_name || '';
        if (embedFields) embedFields.classList.toggle('hidden', !p.embed_enabled);
        syncVisionCapabilityCheckbox();
    } else {
        titleEl.textContent = t('config.profile_editor_title_new');
        idEl.value = '';
        nameEl.value = '';
        provEl.value = 'local';
        urlEl.value = 'http://127.0.0.1:1234/v1';
        modelEl.value = '';
        keyEl.value = '';
        tempEl.value = '0.7';
        timeoutEl.value = '120';
        ctxEl.value = '24000';
        colorEl.value = '#6366f1';
        _syncColor('#6366f1');
        const personaOverrideEl = cfgField('profile-persona-override');
        if (personaOverrideEl) personaOverrideEl.value = '';
        const capReason = cfgField('profile-capability-reasoning');
        const capTools = cfgField('profile-capability-tools');
        const capVision = cfgField('profile-capability-vision');
        if (capReason) capReason.checked = true;
        if (capTools) capTools.checked = true;
        if (capVision) capVision.checked = true;
        auxEnabledEl.checked = false;
        auxUrlEl.value = '';
        auxModelEl.value = '';
        auxKeyEl.value = '';
        // Coder defaults
        if (coderEnabledEl) coderEnabledEl.checked = false;
        if (coderProvEl) coderProvEl.value = 'local';
        if (coderUrlEl) coderUrlEl.value = '';
        if (coderModelEl) coderModelEl.value = '';
        if (coderKeyEl) coderKeyEl.value = '';
        if (coderTimeoutEl) coderTimeoutEl.value = '180';
        if (coderFields) coderFields.classList.add('hidden');
        // Vision defaults
        if (visionEnabledEl) visionEnabledEl.checked = false;
        if (visionProvEl) visionProvEl.value = 'local';
        if (visionUrlEl) visionUrlEl.value = '';
        if (visionModelEl) visionModelEl.value = '';
        if (visionKeyEl) visionKeyEl.value = '';
        if (visionTimeoutEl) visionTimeoutEl.value = '60';
        if (visionRespondEl) visionRespondEl.checked = false;
        if (visionFields) visionFields.classList.add('hidden');
        syncVisionCapabilityCheckbox();
        // Embedding defaults (enabled by default)
        if (embedEnabledEl) embedEnabledEl.checked = true;
        if (embedModelEl) embedModelEl.value = '';
        if (embedFields) embedFields.classList.remove('hidden');
    }
    auxFields.classList.toggle('hidden', !auxEnabledEl.checked);
    keyRow.style.display = provEl.value === 'local' ? 'none' : '';
    openSubPage('profile-editor-overlay');
};

export function closeProfileEditor() {
    closeSubPage('profile-editor-overlay');
};

export function onProfileProviderChange() {
    const prov = cfgField('profile-provider');
    const url = cfgField('profile-url');
    const model = cfgField('profile-model');
    const keyRow = cfgField('profile-api-key-row');
    if (!prov) return;
    const v = prov.value;
    if (keyRow) keyRow.style.display = v === 'local' ? 'none' : '';
    if (v === 'local') {
        if (url) url.value = 'http://localhost:11434/v1';
        if (model) model.value = '';
    } else if (v === 'z_ai') {
        if (url) url.value = 'https://api.z.ai/api/paas/v4';
        if (model) model.value = 'glm-5';
    } else if (v === 'grok') {
        if (url) url.value = 'https://api.x.ai/v1/chat/completions';
        if (model && !model.value.trim()) model.value = 'grok-4-1-fast-reasoning';
    } else if (v === 'deepseek') {
        if (url) url.value = 'https://api.deepseek.com/chat/completions';
        if (model && !model.value.trim()) model.value = 'deepseek-chat';
    } else if (v === 'openai') {
        if (url) url.value = 'https://api.openai.com/v1';
        if (model && !model.value.trim()) model.value = 'gpt-4o';
    }
};

export function onProfileSubProviderChange(type: string) {
    const prov = cfgField(`profile-${type}-provider`);
    const url = cfgField(`profile-${type}-url`);
    const model = cfgField(`profile-${type}-model`);
    if (!prov) return;
    const v = prov.value;
    const isCoder = type === 'coder';
    if (v === 'local') {
        if (url) url.value = isCoder ? '' : 'http://localhost:11434/v1';
        if (model) model.value = '';
    } else if (v === 'z_ai') {
        if (url) url.value = isCoder ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4';
        if (model) model.value = 'glm-5';
    } else if (v === 'grok') {
        if (url) url.value = 'https://api.x.ai/v1/chat/completions';
        if (model && !model.value.trim()) model.value = 'grok-4-1-fast-reasoning';
    } else if (v === 'deepseek') {
        if (url) url.value = 'https://api.deepseek.com/chat/completions';
        if (model && !model.value.trim()) model.value = 'deepseek-chat';
    } else if (v === 'openai') {
        if (url) url.value = 'https://api.openai.com/v1';
        if (model && !model.value.trim()) model.value = 'gpt-4o';
    }
};

export async function saveProfile(e?: Event) {
    if (e) e.preventDefault();
    const payload = {
        id: cfgField('profile-edit-id')?.value || '',
        name: cfgField('profile-name')?.value || '',
        provider: cfgField('profile-provider')?.value || 'local',
        target_url: cfgField('profile-url')?.value || '',
        model_name: cfgField('profile-model')?.value || '',
        api_key: cfgField('profile-api-key')?.value || '',
        temperature: parseFloat(cfgVal('profile-temperature')) || 0.7,
        timeout: parseInt(cfgVal('profile-timeout'), 10) || 120,
        context_length: parseInt(cfgVal('profile-context'), 10) || 24000,
        max_tokens: 2048,
        color: cfgField('profile-color')?.value || '#6366f1',
        persona_override: (cfgField('profile-persona-override')?.value || '').trim() || null,
        capability_reasoning: (cfgField('profile-capability-reasoning') as HTMLInputElement | null)?.checked !== false,
        capability_tool_calling: (cfgField('profile-capability-tools') as HTMLInputElement | null)?.checked !== false,
        capability_vision: (function() {
            const visionEnabled = (cfgField('profile-vision-enabled') as HTMLInputElement | null)?.checked;
            const visionUrl = (cfgField('profile-vision-url')?.value || '').trim();
            const visionModel = (cfgField('profile-vision-model')?.value || '').trim();
            if (visionEnabled && (visionUrl || visionModel)) return true;
            return (cfgField('profile-capability-vision') as HTMLInputElement | null)?.checked !== false;
        })(),
        aux_llm_enabled: (cfgField('profile-aux-enabled') as HTMLInputElement | null)?.checked || false,
        aux_llm: {
            target_url: cfgField('profile-aux-url')?.value || '',
            model_name: cfgField('profile-aux-model')?.value || '',
            api_key: cfgField('profile-aux-key')?.value || '',
        },
        coder_enabled: (cfgField('profile-coder-enabled') as HTMLInputElement | null)?.checked || false,
        coder: {
            provider: cfgField('profile-coder-provider')?.value || 'local',
            target_url: cfgField('profile-coder-url')?.value || '',
            model_name: cfgField('profile-coder-model')?.value || '',
            api_key: cfgField('profile-coder-key')?.value || '',
            timeout: parseInt(cfgVal('profile-coder-timeout'), 10) || 180,
        },
        vision_enabled: (cfgField('profile-vision-enabled') as HTMLInputElement | null)?.checked || false,
        vision_llm: {
            provider: cfgField('profile-vision-provider')?.value || 'local',
            target_url: cfgField('profile-vision-url')?.value || '',
            model_name: cfgField('profile-vision-model')?.value || '',
            api_key: cfgField('profile-vision-key')?.value || '',
            timeout: parseInt(cfgVal('profile-vision-timeout'), 10) || 60,
            respond_directly: (cfgField('profile-vision-respond-directly') as HTMLInputElement | null)?.checked || false,
        },
        embed_enabled: (cfgField('profile-embed-enabled') as HTMLInputElement | null)?.checked || false,
        librarian: {
            model_name: cfgField('profile-embed-model')?.value || '',
        },
    };
    try {
        const res = await apiCall('/api/model-profiles', { method: 'POST', body: payload });
        if (!res.ok) throw new Error(t('config.profile_save_error'));
        showToast(t('config.profile_saved'), 'success');
        closeProfileEditor();
        await loadModelProfiles();
    } catch (e) { showToast(t('config.profile_save_error'), 'error'); }
};

export async function deleteProfile(profileId: string) {
    if (!(await showConfirm(t('config.profile_delete_confirm')))) return;
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast(t('config.profile_deleted'), 'success');
        closeProfileCardMenu();
        await loadModelProfiles();
    } catch (e) { showToast(t('common.error'), 'error'); }
};

export function openProfileCardMenu(profileId: string, ev: MouseEvent) {
    if (ev) ev.stopPropagation();
    const modal = cfgField('profile-card-menu-modal');
    if (!modal) return;
    modal.dataset.profileId = profileId;
    const p = _modelProfiles.find(x => x.id === profileId);
    const visible = p && p.visible_in_selector !== false;
    const visibilityBtn = cfgField('profile-card-menu-visibility-btn');
    const visibilityText = cfgField('profile-card-menu-visibility-text');
    if (visibilityBtn) {
        visibilityBtn.dataset.visible = String(visible);
        visibilityBtn.classList.toggle('is-in-selector', visible);
        if (visibilityText) {
            visibilityText.textContent = visible ? t('config.profile_hide_from_selector') : t('config.profile_show_in_selector');
        }
        const icon = visibilityBtn.querySelector('i');
        if (icon) {
            icon.className = visible ? 'fas fa-eye-slash mr-2' : 'fas fa-check-circle mr-2';
        }
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
};

export function closeProfileCardMenu() {
    const modal = cfgField('profile-card-menu-modal');
    if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
};

export async function setProfileVisibility(profileId: string, visible: boolean) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'PATCH', body: { visible_in_selector: visible } });
        if (!res.ok) throw new Error();
        showToast(visible ? t('config.profile_shown_in_selector') : t('config.profile_hidden_from_selector'), 'success');
        await loadModelProfiles();
    } catch (e) { showToast(t('config.profile_visibility_error'), 'error'); }
};

{
    const menuModal = cfgField('profile-card-menu-modal');
    if (menuModal) {
        menuModal.addEventListener('click', (e: MouseEvent) => {
            const tgt = e.target as HTMLElement | null;
            const btn = tgt?.closest('button[data-action]') as HTMLElement | null;
            if (!btn) return;
            const profileId = menuModal.dataset.profileId;
            if (!profileId) return;
            const action = btn.getAttribute('data-action');
            closeProfileCardMenu();
            if (action === 'toggle_visibility') {
                const visible = btn.dataset.visible !== 'true';
                setProfileVisibility(profileId, visible);
            } else if (action === 'edit') showProfileEditor(profileId);
            else if (action === 'duplicate') duplicateProfile(profileId);
            else if (action === 'delete') deleteProfile(profileId);
        });
    }
}

export async function duplicateProfile(profileId: string) {
    const p = _modelProfiles.find(x => x.id === profileId);
    if (!p) return;
    const newId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36).slice(-8);
    const payload = {
        id: newId,
        name: (p.name || 'Profil').trim() ? `Copy of ${(p.name || 'Profil').trim()}` : 'Profil duplicat',
        provider: p.provider || 'local',
        target_url: p.target_url || '',
        model_name: p.model_name || '',
        api_key: p.api_key || '',
        temperature: p.temperature ?? 0.7,
        timeout: p.timeout ?? 120,
        context_length: p.context_length ?? 24000,
        max_tokens: p.max_tokens ?? 2048,
        color: p.color || '#6366f1',
        aux_llm_enabled: p.aux_llm_enabled || false,
        aux_llm: { ...(p.aux_llm || {}), target_url: (p.aux_llm?.target_url || ''), model_name: (p.aux_llm?.model_name || ''), api_key: (p.aux_llm?.api_key || '') },
        coder_enabled: p.coder_enabled || false,
        coder: { ...(p.coder || {}), provider: (p.coder?.provider || 'local'), target_url: (p.coder?.target_url || ''), model_name: (p.coder?.model_name || ''), api_key: (p.coder?.api_key || ''), timeout: (p.coder?.timeout ?? 180) },
        vision_enabled: p.vision_enabled || false,
        vision_llm: { ...(p.vision_llm || {}), provider: (p.vision_llm?.provider || 'local'), target_url: (p.vision_llm?.target_url || ''), model_name: (p.vision_llm?.model_name || ''), api_key: (p.vision_llm?.api_key || ''), timeout: (p.vision_llm?.timeout ?? 60), respond_directly: !!p.vision_llm?.respond_directly },
        embed_enabled: p.embed_enabled || false,
        librarian: { model_name: (p.librarian?.model_name || '').trim() },
        persona_override: (p.persona_override || '').trim() || null,
        capability_reasoning: p.capability_reasoning !== false,
        capability_tool_calling: p.capability_tool_calling !== false,
        capability_vision: p.capability_vision !== false,
    };
    try {
        const res = await apiCall('/api/model-profiles', { method: 'POST', body: payload });
        if (!res.ok) throw new Error(t('config.profile_save_error'));
        showToast(t('hy.profile_duplicated'), 'success');
        await loadModelProfiles();
    } catch (e) { showToast(t('hy.duplicate_error'), 'error'); }
};

/** Două flashuri în exteriorul barei la schimbarea modelului (același stil ca la streaming). */
function playChatBarGlow(profileId: string) {
    const bar = document.querySelector('.chat-input-inner') as HTMLElement | null;
    if (!bar) return;
    const color = _profileGlowColor(profileId);
    bar.style.setProperty('--chat-bar-flash-color', color);
    bar.style.setProperty('--profile-glow-color', color);
    bar.classList.remove('chat-input-bar-flash');
    bar.offsetHeight;
    bar.classList.add('chat-input-bar-flash');
    bar.addEventListener('animationend', () => bar.classList.remove('chat-input-bar-flash'), { once: true });
}

export async function activateProfile(profileId: string) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}/activate`, { method: 'POST' });
        if (!res.ok) throw new Error();
        playChatBarGlow(profileId);
        await loadModelProfiles();
    } catch (e) { showToast(t('hy.activation_error'), 'error'); }
};
