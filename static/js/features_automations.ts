// @ts-nocheck — tighten types in a follow-up pass.
import { apiCall, suppressLogout } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast, showConfirm, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from './utils.js';
import { getIntegrationEntities } from './features_smarthome.js';
import { initGenericCustomSelects, upgradeNativeSelects } from './features_custom_selects.js';

// --- CONȘTIINȚĂ (tabs Memorii | Automatizări) ---
export function switchIntelligenceTab(tabId) {
    document.querySelectorAll('.intelligence-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.intelligence-tab-btn').forEach(b => {
        b.classList.remove('border-accent', 'text-accent');
        b.classList.add('border-transparent', 'text-slate-500');
    });
    const panel = document.getElementById(`intelligence-panel-${tabId}`);
    const btn = document.getElementById(`intelligence-tab-${tabId}`);
    if (panel) panel.classList.remove('hidden');
    if (btn) {
        btn.classList.remove('border-transparent', 'text-slate-500');
        btn.classList.add('border-b-2', 'border-accent', 'text-accent');
    }
    if (tabId === 'automations') { _startAutoStatusPoll(); } else { _stopAutoStatusPoll(); }
}

// --- Automatizări (tab Conștiință) ---
let _automationEditorRevision = null;
let _automationEditorId = null;

function _automationIdString(id) {
    if (typeof id !== 'string') return null;
    const s = id.trim();
    return s || null;
}

function _editorAutomationId() {
    return _automationIdString(_automationEditorId);
}
let _automationEditorMode = 'builder';
let _automationBuilderTriggers = [];
let _automationBuilderConditions = [];
let _automationBuilderActions = [];

// Cached snapshot of /api/automations/capabilities. Loaded lazily on first
// editor open and refreshed when the editor opens again. Single source of
// truth for the editor's pickers (entities, areas, schema constraints).
let _automationCapabilities = null;
let _automationCapabilitiesPromise = null;

async function _automationLoadCapabilities({ force = false } = {}) {
    if (!force && _automationCapabilities) return _automationCapabilities;
    if (!force && _automationCapabilitiesPromise) return _automationCapabilitiesPromise;
    _automationCapabilitiesPromise = (async () => {
        try {
            const res = await apiCall('/api/automations/capabilities');
            const data = await res.json();
            _automationCapabilities = {
                schema: data?.schema || null,
                entities: Array.isArray(data?.entities) ? data.entities : [],
                areas: Array.isArray(data?.areas) ? data.areas : [],
            };
        } catch (_) {
            _automationCapabilities = { schema: null, entities: [], areas: [] };
        } finally {
            _automationCapabilitiesPromise = null;
        }
        return _automationCapabilities;
    })();
    return _automationCapabilitiesPromise;
}

function _automationCapabilityEntities() {
    return Array.isArray(_automationCapabilities?.entities) ? _automationCapabilities.entities : [];
}

const _AUTOMATION_SERVICE_PRESETS = {
    light: ['light.turn_on', 'light.turn_off', 'light.toggle'],
    switch: ['switch.turn_on', 'switch.turn_off', 'switch.toggle'],
    input_boolean: ['input_boolean.turn_on', 'input_boolean.turn_off', 'input_boolean.toggle'],
    cover: ['cover.open_cover', 'cover.close_cover', 'cover.stop_cover', 'cover.toggle', 'cover.set_cover_position'],
    lock: ['lock.lock', 'lock.unlock', 'lock.open'],
    climate: ['climate.turn_on', 'climate.turn_off', 'climate.set_temperature', 'climate.set_hvac_mode'],
    media_player: ['media_player.turn_on', 'media_player.turn_off', 'media_player.toggle', 'media_player.volume_set', 'media_player.media_play_pause'],
    vacuum: ['vacuum.start', 'vacuum.pause', 'vacuum.return_to_base', 'vacuum.stop'],
    script: ['script.turn_on', 'script.turn_off'],
    notify: ['notify.notify'],
    scene: ['scene.turn_on'],
    automation: ['automation.trigger', 'automation.turn_on', 'automation.turn_off'],
};

const _AUTOMATION_SERVICE_DATA_FIELDS = {
    'light.turn_on': [
        { key: 'brightness', labelKey: 'automations.service_field_brightness', fallback: 'Brightness', type: 'number', min: 0, max: 255, step: 1 },
        { key: 'color_temp', labelKey: 'automations.service_field_color_temp', fallback: 'Color temp', type: 'number', min: 153, max: 500, step: 1 },
        { key: 'transition', labelKey: 'automations.service_field_transition', fallback: 'Transition', type: 'number', min: 0, max: 300, step: 0.1 },
    ],
    'climate.set_temperature': [
        { key: 'temperature', labelKey: 'automations.service_field_temperature', fallback: 'Temperature', type: 'number', min: 5, max: 35, step: 0.5 },
    ],
    'climate.set_hvac_mode': [
        { key: 'hvac_mode', labelKey: 'automations.service_field_hvac_mode', fallback: 'HVAC mode', type: 'select', options: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only', 'heat_cool'] },
    ],
    'media_player.volume_set': [
        { key: 'volume_level', labelKey: 'automations.service_field_volume_level', fallback: 'Volume level', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
    'cover.set_cover_position': [
        { key: 'position', labelKey: 'automations.service_field_position', fallback: 'Position', type: 'number', min: 0, max: 100, step: 1 },
    ],
};

function _automationDefaultBuilderState() {
    return {
        id: 'new_automation',
        title: 'New automation',
        description: '',
        enabled: true,
        mode: 'single',
    };
}

function _automationSetBuilderState(state) {
    const next = { ..._automationDefaultBuilderState(), ...(state || {}) };
    const fields = {
        id: 'automation-builder-id',
        title: 'automation-builder-title',
        description: 'automation-builder-description',
        mode: 'automation-builder-mode',
    };
    Object.entries(fields).forEach(([key, elementId]) => {
        const element = document.getElementById(elementId);
        if (element) element.value = next[key] ?? '';
    });
    const enabledEl = document.getElementById('automation-builder-enabled');
    if (enabledEl) enabledEl.checked = !!next.enabled;
    initGenericCustomSelects(document.getElementById('automation-editor-modal') || document);
}

function _automationGetBuilderState() {
    return {
        id: document.getElementById('automation-builder-id')?.value?.trim() || 'new_automation',
        title: document.getElementById('automation-builder-title')?.value?.trim() || 'New automation',
        description: document.getElementById('automation-builder-description')?.value?.trim() || '',
        enabled: !!document.getElementById('automation-builder-enabled')?.checked,
        mode: document.getElementById('automation-builder-mode')?.value || 'single',
    };
}

function _automationYamlScalar(value) {
    const text = String(value ?? '');
    return JSON.stringify(text);
}

function _automationYamlBoolean(value) {
    return value ? 'true' : 'false';
}

function _automationSortHaEntities(items) {
    return [...(items || [])].sort((left, right) => {
        const leftName = String(left?.name || left?.entity_id || '').toLowerCase();
        const rightName = String(right?.name || right?.entity_id || '').toLowerCase();
        return leftName.localeCompare(rightName) || String(left?.entity_id || '').localeCompare(String(right?.entity_id || ''));
    });
}

function _automationInferServiceDomain(target) {
    const current = String(target?.value || '').trim();
    if (current.includes('.')) return current.split('.')[0];
    const card = target?.closest('.automation-builder-action-card');
    const entityInput = card?.querySelector('[data-action-field="entity_id"]');
    const entityId = String(entityInput?.value || '').trim();
    if (entityId.includes('.')) return entityId.split('.')[0];
    return '';
}

/* Infer the desired entity domain for the entity picker from sibling fields
   in the same builder card. For service actions: derive from the `service`
   field (e.g. `switch.turn_on` → `switch`). For state triggers: an explicit
   `data-entity-domain` attribute can be set on the input. */
function _automationInferEntityDomain(target) {
    const explicit = String(target?.getAttribute('data-entity-domain') || '').trim();
    if (explicit) return explicit;
    const card = target?.closest('.automation-builder-action-card');
    if (!card) return '';
    const serviceInput = card.querySelector('[data-action-field="service"]');
    const service = String(serviceInput?.value || '').trim();
    if (service.includes('.')) return service.split('.')[0];
    return '';
}

function _automationServicePresetList(domain = '') {
    const normalized = String(domain || '').trim().toLowerCase();
    if (normalized && _AUTOMATION_SERVICE_PRESETS[normalized]) {
        return [..._AUTOMATION_SERVICE_PRESETS[normalized]];
    }
    const flat = Object.values(_AUTOMATION_SERVICE_PRESETS).flat();
    return [...new Set(flat)].sort();
}

function _automationRenderHaEntityOptions(items) {
    const listEl = document.getElementById('automation-ha-entity-options');
    if (!listEl) return;
    listEl.innerHTML = _automationSortHaEntities(items).map(item => {
        const entityId = escapeHtml(item?.entity_id || '');
        const name = escapeHtml(item?.name || item?.entity_id || '');
        const domain = escapeHtml(item?.domain || String(item?.entity_id || '').split('.')[0] || '');
        const aliases = Array.isArray(item?.aliases) && item.aliases.length ? ` [${escapeHtml(item.aliases.join(', '))}]` : '';
        return `<option value="${entityId}" label="${name} (${domain})${aliases}"></option>`;
    }).join('');
}

/* ═══════════════════════════════════════════════════════
   INLINE AUTOCOMPLETE — replaces standalone picker panels
   ═══════════════════════════════════════════════════════ */
let _activeAutocomplete = null;   // current open dropdown element
let _acHighlightIndex = -1;       // keyboard-highlighted item index

function _acClose() {
    if (_activeAutocomplete) {
        _activeAutocomplete.classList.remove('open');
        _activeAutocomplete = null;
    }
    _acHighlightIndex = -1;
}

function _acEntityItems(search, domain) {
    // Prefer the dedicated automations capabilities snapshot when loaded —
    // it's owner-scoped, already filtered to valid HA-style entity_ids, and
    // doesn't drift with the device-list view. Fall back to the integration
    // cache so the picker still works before capabilities arrive.
    const capEntities = _automationCapabilityEntities();
    const source = capEntities.length
        ? capEntities
        : getIntegrationEntities();
    const sorted = _automationSortHaEntities(source);
    const wantDomain = String(domain || '').trim().toLowerCase();
    const byDomain = wantDomain
        ? sorted.filter(item => {
            const d = String(item?.domain || String(item?.entity_id || '').split('.')[0] || '').toLowerCase();
            return d === wantDomain;
        })
        : sorted;
    if (!search) return byDomain.slice(0, 60);
    const q = search.toLowerCase();
    return byDomain.filter(item => {
        const haystack = [
            item?.name || '',
            item?.entity_id || '',
            item?.domain || '',
            item?.area || '',
            ...(Array.isArray(item?.aliases) ? item.aliases : []),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
    }).slice(0, 60);
}

function _acServiceItems(search, domain) {
    const items = _automationServicePresetList(domain);
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(s => s.toLowerCase().includes(q));
}

function _acRenderEntity(dropdown, search, domain) {
    const items = _acEntityItems(search, domain);
    if (!items.length) {
        dropdown.innerHTML = `<div class="ac-empty">${t('automations.entity_empty_filtered')}</div>`;
        return;
    }
    dropdown.innerHTML = items.map((item, i) => {
        const entityId = escapeHtml(item?.entity_id || '');
        const name = escapeHtml(item?.name || item?.entity_id || '');
        const domain = escapeHtml(item?.domain || String(item?.entity_id || '').split('.')[0] || '');
        return `<div class="ac-item${i === _acHighlightIndex ? ' ac-highlighted' : ''}" data-ac-value="${entityId}" data-ac-index="${i}">
            <div class="min-w-0" style="overflow:hidden">
                <div class="ac-item-name">${name}</div>
                <div class="ac-item-id">${entityId}</div>
            </div>
            <span class="ac-item-badge">${domain}</span>
        </div>`;
    }).join('');
}

function _acRenderService(dropdown, search, domain) {
    const items = _acServiceItems(search, domain);
    if (!items.length) {
        dropdown.innerHTML = `<div class="ac-empty">${t('automations.service_empty')}</div>`;
        return;
    }
    dropdown.innerHTML = items.map((item, i) => {
        return `<div class="ac-item${i === _acHighlightIndex ? ' ac-highlighted' : ''}" data-ac-value="${escapeHtml(item)}" data-ac-index="${i}">
            <div class="ac-item-name" style="font-family:var(--font-mono,monospace)">${escapeHtml(item)}</div>
        </div>`;
    }).join('');
}

function _acOpen(input, type, domain) {
    const wrapper = input.closest('.automation-inline-ac');
    if (!wrapper) return;
    const dropdown = wrapper.querySelector('.automation-inline-ac-dropdown');
    if (!dropdown) return;
    if (_activeAutocomplete && _activeAutocomplete !== dropdown) _acClose();
    _activeAutocomplete = dropdown;
    _acHighlightIndex = -1;
    const search = input.value.trim();
    if (type === 'entity') {
        _acRenderEntity(dropdown, search, domain || '');
    } else {
        _acRenderService(dropdown, search, domain || '');
    }
    dropdown.classList.add('open');
}

function _acSelect(input, value, type) {
    input._acSelecting = true;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    _acClose();
    input.blur();
    requestAnimationFrame(() => { input._acSelecting = false; });
    if (type === 'service') {
        syncAutomationYamlFromBuilder({ rerenderActions: true });
    } else {
        syncAutomationYamlFromBuilder();
    }
}

function _acKeydown(e, input, type, domain) {
    const wrapper = input.closest('.automation-inline-ac');
    const dropdown = wrapper?.querySelector('.automation-inline-ac-dropdown');
    if (!dropdown || !dropdown.classList.contains('open')) return;
    const items = dropdown.querySelectorAll('.ac-item[data-ac-value]');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _acHighlightIndex = Math.min(_acHighlightIndex + 1, items.length - 1);
        _acUpdateHighlight(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _acHighlightIndex = Math.max(_acHighlightIndex - 1, 0);
        _acUpdateHighlight(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_acHighlightIndex >= 0 && items[_acHighlightIndex]) {
            _acSelect(input, items[_acHighlightIndex].getAttribute('data-ac-value'), type);
        }
    } else if (e.key === 'Escape') {
        e.preventDefault();
        _acClose();
        input.blur();
    }
}

function _acUpdateHighlight(items) {
    items.forEach((el, i) => {
        el.classList.toggle('ac-highlighted', i === _acHighlightIndex);
    });
    if (_acHighlightIndex >= 0 && items[_acHighlightIndex]) {
        items[_acHighlightIndex].scrollIntoView({ block: 'nearest' });
    }
}

// Global click handler to close autocomplete when clicking outside
document.addEventListener('mousedown', (e) => {
    if (_activeAutocomplete && !e.target.closest('.automation-inline-ac')) {
        _acClose();
    }
});

// Delegated click handler for autocomplete items
document.addEventListener('click', (e) => {
    const item = e.target.closest('.ac-item[data-ac-value]');
    if (!item) return;
    const dropdown = item.closest('.automation-inline-ac-dropdown');
    const wrapper = dropdown?.closest('.automation-inline-ac');
    const input = wrapper?.querySelector('input');
    if (!input) return;
    const type = input.hasAttribute('data-automation-entity-input') ? 'entity' : 'service';
    _acSelect(input, item.getAttribute('data-ac-value'), type);
});

/* Helper: builds inline-ac wrapper HTML around an entity input */
function _acEntityInputHtml(attrs) {
    return `<div class="automation-inline-ac">
        <input type="text" ${attrs}
            class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none"
            autocomplete="off">
        <div class="automation-inline-ac-dropdown"></div>
    </div>`;
}

/* Helper: builds inline-ac wrapper HTML around a service input */
function _acServiceInputHtml(attrs) {
    return `<div class="automation-inline-ac">
        <input type="text" ${attrs}
            class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none"
            autocomplete="off">
        <div class="automation-inline-ac-dropdown"></div>
    </div>`;
}

/* Attach inline-ac event listeners to dynamically rendered inputs */
function _acBindInputs(host) {
    host.querySelectorAll('[data-automation-entity-input]').forEach(input => {
        if (input._acBound) return;
        input._acBound = true;
        const getEntityDomain = () => _automationInferEntityDomain(input);
        input.addEventListener('focus', () => { if (!input._acSelecting) _acOpen(input, 'entity', getEntityDomain()); });
        input.addEventListener('input', () => { if (!input._acSelecting) { _acHighlightIndex = -1; _acOpen(input, 'entity', getEntityDomain()); } });
        input.addEventListener('keydown', (e) => _acKeydown(e, input, 'entity', getEntityDomain()));
    });
    host.querySelectorAll('[data-automation-service-input]').forEach(input => {
        if (input._acBound) return;
        input._acBound = true;
        const getDomain = () => _automationInferServiceDomain(input);
        input.addEventListener('focus', () => { if (!input._acSelecting) _acOpen(input, 'service', getDomain()); });
        input.addEventListener('input', () => { if (!input._acSelecting) { _acHighlightIndex = -1; _acOpen(input, 'service', getDomain()); } });
        input.addEventListener('keydown', (e) => _acKeydown(e, input, 'service', getDomain()));
    });
}

/* Upgrade native builder <select>s into the app's custom dropdown so they match
   the rest of the UI instead of rendering as raw OS selects. Delegates to the
   global upgrader; the native select stays in the DOM (hidden) so value/onchange
   and DOM readers keep working. */
function _upgradeAutoBuilderSelects(host) {
    if (!host) return;
    upgradeNativeSelects(host);
}

// Legacy no-ops: older features.js facades still re-export these names.
export function setAutomationEntityPickerTarget() {}
export function pickAutomationEntity() {}
export function filterAutomationEntityPicker() {}
export function setAutomationServicePickerTarget() {}
export function pickAutomationService() {}
export function filterAutomationServicePicker() {}

function _automationBuilderActionTemplate(kind = 'notify') {
    if (kind === 'service') {
        return { kind: 'service', service: 'light.turn_on', entity_id: '', data: '{}' };
    }
    if (kind === 'skill') {
        return { kind: 'skill', name: '', input: '{}' };
    }
    return { kind: 'notify', text: 'Automation created.' };
}

function _automationParseJsonObject(text) {
    try {
        const value = text ? JSON.parse(text) : {};
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

function _automationServiceDataFieldDefs(serviceName) {
    return _AUTOMATION_SERVICE_DATA_FIELDS[String(serviceName || '').trim()] || [];
}

function _automationRenderServiceStructuredFields(action, index) {
    const fields = _automationServiceDataFieldDefs(action?.service);
    if (!fields.length) return '';
    const data = _automationParseJsonObject(action?.data || '{}');
    const body = fields.map(field => {
        const label = t(field.labelKey) || field.fallback;
        const rawValue = data[field.key];
        if (field.type === 'select') {
            return `
                <div class="space-y-1">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                    <select data-service-data-field="${field.key}" data-action-index="${index}" data-memory-input="updateAutomationServiceData" data-memory-index="${index}" class="auto-builder-select w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                        <option value=""></option>
                        ${field.options.map(option => `<option value="${escapeHtml(option)}" ${rawValue === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
                    </select>
                </div>`;
        }
        return `
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                <input type="number" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} ${field.step != null ? `step="${field.step}"` : ''} data-service-data-field="${field.key}" data-action-index="${index}" value="${rawValue ?? ''}" data-memory-input="updateAutomationServiceData" data-memory-index="${index}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
            </div>`;
    }).join('');
    return `
        <div class="space-y-3 sm:col-span-2 rounded-xl border border-white/5 bg-slate-950/50 p-3">
            <div>
                <div class="text-[10px] font-bold uppercase tracking-widest text-slate-400">${t('automations.service_data_assist_title')}</div>
                <p class="text-[10px] text-slate-500 mt-1">${t('automations.service_data_assist_hint')}</p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${body}</div>
        </div>`;
}

function _automationBuilderTriggerTemplate(platform = 'time') {
    if (platform === 'datetime') {
        return { platform: 'datetime', at: '' };
    }
    if (platform === 'interval') {
        return { platform: 'interval', every_minutes: '60', start_at: '' };
    }
    if (platform === 'state') {
        return { platform: 'state', entity_id: '', from: '', to: '' };
    }
    if (platform === 'numeric_state') {
        return { platform: 'numeric_state', entity_id: '', above: '', below: '', attribute: '' };
    }
    return { platform: 'time', at: '09:00', weekdays: '' };
}

function _automationBuilderConditionTemplate(kind = 'time_window') {
    return { kind: 'time_window', after: '', before: '' };
}

function _automationNormalizeTrigger(trigger) {
    const platform = trigger?.platform || 'time';
    return { ..._automationBuilderTriggerTemplate(platform), ...trigger, platform };
}

function _automationStateOptions(currentValue, includeEmpty = false) {
    const common = ['on', 'off', 'open', 'closed', 'home', 'not_home', 'unavailable', 'unknown'];
    const current = String(currentValue || '').trim();
    const values = includeEmpty ? [''].concat(common) : [...common];
    if (current && !values.includes(current)) values.push(current);
    return values.map((value) => {
        const selected = value === current ? 'selected' : '';
        const label = value || '—';
        return `<option value="${escapeHtml(value)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

function _automationNormalizeCondition(condition) {
    const kind = condition?.kind || 'time_window';
    return { ..._automationBuilderConditionTemplate(kind), ...condition, kind };
}

function _automationRenderBuilderTriggers() {
    const host = document.getElementById('automation-builder-triggers');
    if (!host) return;
    host.innerHTML = _automationBuilderTriggers.map((trigger, index) => {
        const platform = trigger?.platform || 'time';
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-3 automation-builder-action-card" data-action-card-index="${index}">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${t('automations.builder_trigger_item')}</div>
                    <button type="button" data-memory-action="removeAutomationBuilderTrigger" data-memory-index="${index}" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete')}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_platform')}</label>
                        <select data-trigger-field="platform" data-trigger-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="triggers" class="auto-builder-select w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                            <option value="time" ${platform === 'time' ? 'selected' : ''}>time</option>
                            <option value="datetime" ${platform === 'datetime' ? 'selected' : ''}>datetime</option>
                            <option value="interval" ${platform === 'interval' ? 'selected' : ''}>interval</option>
                            <option value="state" ${platform === 'state' ? 'selected' : ''}>state</option>
                            <option value="numeric_state" ${platform === 'numeric_state' ? 'selected' : ''}>numeric_state</option>
                        </select>
                    </div>
                    <div data-trigger-kind-wrap="time" class="space-y-1 ${platform === 'time' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_at')}</label>
                        <input type="text" data-trigger-field="at" data-trigger-index="${index}" value="${escapeHtml(trigger?.at || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="time" class="space-y-1 sm:col-span-2 ${platform === 'time' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_weekdays')}</label>
                        <input type="text" data-trigger-field="weekdays" data-trigger-index="${index}" value="${escapeHtml(trigger?.weekdays || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="datetime" class="space-y-1 sm:col-span-2 ${platform === 'datetime' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_datetime')}</label>
                        <input type="text" data-trigger-field="at" data-trigger-index="${index}" value="${escapeHtml(trigger?.at || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="interval" class="space-y-1 ${platform === 'interval' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_every_minutes')}</label>
                        <input type="number" min="1" max="10080" data-trigger-field="every_minutes" data-trigger-index="${index}" value="${escapeHtml(trigger?.every_minutes || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="interval" class="space-y-1 ${platform === 'interval' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_start_at')}</label>
                        <input type="text" data-trigger-field="start_at" data-trigger-index="${index}" value="${escapeHtml(trigger?.start_at || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="state" class="space-y-1 sm:col-span-2 ${platform === 'state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_entity')}</label>
                        <div class="automation-inline-ac">
                            <input type="text" data-automation-entity-input="1" data-trigger-field="entity_id" data-trigger-index="${index}" value="${escapeHtml(trigger?.entity_id || '')}" data-memory-input="syncAutomationYamlFromBuilder" autocomplete="off" placeholder="${t('automations.entity_search_placeholder')}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                            <div class="automation-inline-ac-dropdown"></div>
                        </div>
                    </div>
                    <div data-trigger-kind-wrap="state" class="space-y-1 ${platform === 'state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_from')}</label>
                        <input type="text" data-trigger-field="from" data-trigger-index="${index}" value="${escapeHtml(trigger?.from || '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. off" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="state" class="space-y-1 ${platform === 'state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_to')}</label>
                        <input type="text" data-trigger-field="to" data-trigger-index="${index}" value="${escapeHtml(trigger?.to || '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. on" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 sm:col-span-2 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_entity')}</label>
                        <div class="automation-inline-ac">
                            <input type="text" data-automation-entity-input="1" data-trigger-field="entity_id" data-trigger-index="${index}" value="${escapeHtml(trigger?.entity_id || '')}" data-memory-input="syncAutomationYamlFromBuilder" autocomplete="off" placeholder="${t('automations.entity_search_placeholder')}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                            <div class="automation-inline-ac-dropdown"></div>
                        </div>
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_above')}</label>
                        <input type="text" data-trigger-field="above" data-trigger-index="${index}" value="${escapeHtml(trigger?.above != null ? trigger.above : '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. 25" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_below')}</label>
                        <input type="text" data-trigger-field="below" data-trigger-index="${index}" value="${escapeHtml(trigger?.below != null ? trigger.below : '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. 10" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 sm:col-span-2 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_attribute')}</label>
                        <input type="text" data-trigger-field="attribute" data-trigger-index="${index}" value="${escapeHtml(trigger?.attribute || '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. temperature" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
    _upgradeAutoBuilderSelects(host);
}

function _automationRenderBuilderConditions() {
    const host = document.getElementById('automation-builder-conditions');
    if (!host) return;
    if (!_automationBuilderConditions.length) {
        host.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.015] p-4 text-[11px] text-slate-500">${t('automations.builder_condition_empty')}</div>`;
        return;
    }
    host.innerHTML = _automationBuilderConditions.map((condition, index) => {
        const kind = condition?.kind || 'time_window';
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${t('automations.builder_condition_item')}</div>
                    <button type="button" data-memory-action="removeAutomationBuilderCondition" data-memory-index="${index}" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete')}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="space-y-1 sm:col-span-2">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_kind')}</label>
                        <select data-condition-field="kind" data-condition-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="conditions" class="auto-builder-select w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                            <option value="time_window" ${kind === 'time_window' ? 'selected' : ''}>time_window</option>
                        </select>
                    </div>
                    <div data-condition-kind-wrap="time_window" class="space-y-1 ${kind === 'time_window' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_after')}</label>
                        <input type="text" data-condition-field="after" data-condition-index="${index}" value="${escapeHtml(condition?.after || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div data-condition-kind-wrap="time_window" class="space-y-1 ${kind === 'time_window' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_before')}</label>
                        <input type="text" data-condition-field="before" data-condition-index="${index}" value="${escapeHtml(condition?.before || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
    _upgradeAutoBuilderSelects(host);
}

function _automationRenderBuilderActions() {
    const host = document.getElementById('automation-builder-actions');
    if (!host) return;
    host.innerHTML = _automationBuilderActions.map((action, index) => {
        const type = action?.kind || 'notify';
        const labelMap = {
            notify: t('automations.builder_action_notify'),
            service: t('automations.builder_action_service'),
            skill: t('automations.builder_action_skill'),
        };
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-3 automation-builder-action-card" data-action-card-index="${index}">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${labelMap[type] || type}</div>
                    <button type="button" data-memory-action="removeAutomationBuilderAction" data-memory-index="${index}" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete')}</button>
                </div>
                <div class="space-y-3">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_action_type')}</label>
                        <select data-action-field="kind" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="actions" class="auto-builder-select w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none">
                            <option value="notify" ${type === 'notify' ? 'selected' : ''}>${t('automations.builder_action_notify')}</option>
                            <option value="service" ${type === 'service' ? 'selected' : ''}>${t('automations.builder_action_service')}</option>
                            <option value="skill" ${type === 'skill' ? 'selected' : ''}>${t('automations.builder_action_skill')}</option>
                        </select>
                    </div>
                    <div data-action-kind-wrap="notify" class="space-y-1 ${type === 'notify' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_notify_text')}</label>
                        <textarea data-action-field="text" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full min-h-[88px] bg-slate-900 border border-white/5 rounded-xl p-3 text-sm text-slate-200 focus:border-accent outline-none resize-y">${escapeHtml(action?.text || '')}</textarea>
                    </div>
                    <div data-action-kind-wrap="service" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${type === 'service' ? '' : 'hidden'}">
                        <div class="space-y-1 sm:col-span-2">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_name')}</label>
                            <div class="automation-inline-ac">
                                <input type="text" data-automation-service-input="1" data-action-field="service" data-action-index="${index}" value="${escapeHtml(action?.service || '')}" autocomplete="off" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="actions" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" placeholder="${t('automations.service_search_placeholder')}">
                                <div class="automation-inline-ac-dropdown"></div>
                            </div>
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_entity_id')}</label>
                            <div class="automation-inline-ac">
                                <input type="text" data-automation-entity-input="1" data-action-field="entity_id" data-action-index="${index}" value="${escapeHtml(action?.entity_id || '')}" autocomplete="off" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none" placeholder="${t('automations.entity_search_placeholder')}">
                                <div class="automation-inline-ac-dropdown"></div>
                            </div>
                        </div>
                        ${_automationRenderServiceStructuredFields(action, index)}
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_data')}</label>
                            <textarea data-action-field="data" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="actions" class="w-full min-h-[88px] bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none resize-y">${escapeHtml(action?.data || '{}')}</textarea>
                        </div>
                    </div>
                    <div data-action-kind-wrap="skill" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${type === 'skill' ? '' : 'hidden'}">
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_skill_name')}</label>
                            <input type="text" data-action-field="name" data-action-index="${index}" value="${escapeHtml(action?.name || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none">
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_skill_input')}</label>
                            <textarea data-action-field="input" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full min-h-[88px] bg-slate-900 border border-white/5 rounded-xl p-3 text-sm mono text-slate-200 focus:border-accent outline-none resize-y">${escapeHtml(action?.input || '{}')}</textarea>
                        </div>
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
    _upgradeAutoBuilderSelects(host);
}

function _automationReadBuilderActionsFromDom() {
    const next = _automationBuilderActions.map(action => ({ ...action }));
    document.querySelectorAll('[data-action-index][data-action-field]').forEach(element => {
        const index = Number(element.getAttribute('data-action-index'));
        const field = element.getAttribute('data-action-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderActionTemplate();
        next[index][field] = element.value;
    });
    _automationBuilderActions = next.map(action => {
        const kind = action?.kind || 'notify';
        return { ..._automationBuilderActionTemplate(kind), ...action, kind };
    });
}

function _automationReadBuilderTriggersFromDom() {
    const next = _automationBuilderTriggers.map(trigger => ({ ...trigger }));
    const elements = Array.from(document.querySelectorAll('[data-trigger-index][data-trigger-field]'));

    elements.forEach(element => {
        const index = Number(element.getAttribute('data-trigger-index'));
        const field = element.getAttribute('data-trigger-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderTriggerTemplate();
        if (field === 'platform') next[index][field] = element.value;
    });

    elements.forEach(element => {
        const index = Number(element.getAttribute('data-trigger-index'));
        const field = element.getAttribute('data-trigger-field');
        if (!Number.isFinite(index) || !field || field === 'platform') return;
        if (!next[index]) next[index] = _automationBuilderTriggerTemplate();
        const platform = next[index]?.platform || 'time';
        const platformWrap = element.closest('[data-trigger-kind-wrap]');
        if (platformWrap && platformWrap.getAttribute('data-trigger-kind-wrap') !== platform) return;
        next[index][field] = element.value;
    });
    _automationBuilderTriggers = next.map(_automationNormalizeTrigger);
}

function _automationReadBuilderConditionsFromDom() {
    const next = _automationBuilderConditions.map(condition => ({ ...condition }));
    document.querySelectorAll('[data-condition-index][data-condition-field]').forEach(element => {
        const index = Number(element.getAttribute('data-condition-index'));
        const field = element.getAttribute('data-condition-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderConditionTemplate();
        next[index][field] = element.value;
    });
    _automationBuilderConditions = next.map(_automationNormalizeCondition);
}

function _automationBuilderWeekdaysList(raw) {
    return String(raw || '')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function _automationBuildYamlFromBuilder() {
    _automationReadBuilderTriggersFromDom();
    _automationReadBuilderConditionsFromDom();
    _automationReadBuilderActionsFromDom();
    const state = _automationGetBuilderState();
    const lines = [
        'version: 1',
        `id: ${state.id || 'new_automation'}`,
        `title: ${_automationYamlScalar(state.title || 'New automation')}`,
        `enabled: ${_automationYamlBoolean(state.enabled)}`,
        `mode: ${state.mode || 'single'}`,
    ];
    if (state.description) lines.push(`description: ${_automationYamlScalar(state.description)}`);
    lines.push('trigger:');
    (_automationBuilderTriggers.length ? _automationBuilderTriggers : [_automationBuilderTriggerTemplate('time')]).forEach(trigger => {
        const platform = trigger?.platform || 'time';
        if (platform === 'datetime') {
            lines.push('  - platform: datetime');
            lines.push(`    at: ${_automationYamlScalar(trigger.at || '')}`);
        } else if (platform === 'interval') {
            lines.push('  - platform: interval');
            lines.push(`    every_minutes: ${Number(trigger.every_minutes || 0) || 0}`);
            if (trigger.start_at) lines.push(`    start_at: ${_automationYamlScalar(trigger.start_at)}`);
        } else if (platform === 'state') {
            lines.push('  - platform: state');
            lines.push(`    entity_id: ${_automationYamlScalar(trigger.entity_id || '')}`);
            if (trigger.from) lines.push(`    from: ${_automationYamlScalar(String(trigger.from))}`);
            if (trigger.to) lines.push(`    to: ${_automationYamlScalar(String(trigger.to))}`);
        } else if (platform === 'numeric_state') {
            lines.push('  - platform: numeric_state');
            lines.push(`    entity_id: ${_automationYamlScalar(trigger.entity_id || '')}`);
            const above = String(trigger.above ?? '').trim();
            const below = String(trigger.below ?? '').trim();
            if (above !== '' && !Number.isNaN(Number(above))) lines.push(`    above: ${Number(above)}`);
            if (below !== '' && !Number.isNaN(Number(below))) lines.push(`    below: ${Number(below)}`);
            if (trigger.attribute) lines.push(`    attribute: ${_automationYamlScalar(trigger.attribute)}`);
        } else {
            lines.push('  - platform: time');
            lines.push(`    at: ${_automationYamlScalar(trigger.at || '')}`);
            const weekdays = _automationBuilderWeekdaysList(trigger.weekdays);
            if (weekdays.length) {
                lines.push('    weekdays:');
                weekdays.forEach(day => lines.push(`      - ${day}`));
            }
        }
    });
    if (_automationBuilderConditions.length) {
        lines.push('condition:');
        _automationBuilderConditions.forEach(condition => {
            if (condition.kind === 'time_window') {
                lines.push('  - kind: time_window');
                if (condition.after) lines.push(`    after: ${_automationYamlScalar(condition.after)}`);
                if (condition.before) lines.push(`    before: ${_automationYamlScalar(condition.before)}`);
            }
        });
    }
    lines.push('action:');
    (_automationBuilderActions.length ? _automationBuilderActions : [_automationBuilderActionTemplate('notify')]).forEach(action => {
        const kind = action?.kind || 'notify';
        if (kind === 'service') {
            lines.push(`  - service: ${action.service || ''}`);
            if (action.entity_id) {
                lines.push('    target:');
                lines.push(`      entity_id: ${_automationYamlScalar(action.entity_id)}`);
            } else {
                lines.push('    target: {}');
            }
            let parsedData = {};
            try { parsedData = action.data ? JSON.parse(action.data) : {}; } catch (_) { parsedData = {}; }
            const entries = Object.entries(parsedData || {});
            if (!entries.length) {
                lines.push('    data: {}');
            } else {
                lines.push('    data:');
                entries.forEach(([key, value]) => lines.push(`      ${key}: ${typeof value === 'string' ? _automationYamlScalar(value) : JSON.stringify(value)}`));
            }
        } else if (kind === 'skill') {
            lines.push('  - skill:');
            lines.push(`      name: ${_automationYamlScalar(action.name || '')}`);
            let parsedInput = {};
            try { parsedInput = action.input ? JSON.parse(action.input) : {}; } catch (_) { parsedInput = {}; }
            const entries = Object.entries(parsedInput || {});
            if (!entries.length) {
                lines.push('      input: {}');
            } else {
                lines.push('      input:');
                entries.forEach(([key, value]) => lines.push(`        ${key}: ${typeof value === 'string' ? _automationYamlScalar(value) : JSON.stringify(value)}`));
            }
        } else {
            lines.push('  - notify:');
            lines.push(`      text: ${_automationYamlScalar(action.text || '')}`);
        }
    });
    return lines.join('\n') + '\n';
}

function _automationSetBuilderWarning(message = '') {
    const element = document.getElementById('automation-builder-warning');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('hidden', !message);
}

async function _automationHydrateBuilderFromNormalized(normalized, warningMessage = '') {
    const triggers = Array.isArray(normalized?.trigger) ? normalized.trigger : [];
    const conditions = Array.isArray(normalized?.condition) ? normalized.condition : [];
    const actions = Array.isArray(normalized?.action) ? normalized.action : [];
    if (!triggers.length || !actions.length) {
        _automationSetBuilderWarning(t('automations.builder_sync_error'));
        return false;
    }
    const nextState = {
        id: normalized.id || 'new_automation',
        title: normalized.title || 'New automation',
        description: normalized.description || '',
        enabled: normalized.enabled !== false,
        mode: normalized.mode || 'single',
    };
    _automationBuilderTriggers = triggers.map(trigger => _automationNormalizeTrigger({
        ...trigger,
        weekdays: Array.isArray(trigger?.weekdays) ? trigger.weekdays.join(', ') : (trigger?.weekdays || ''),
        every_minutes: trigger?.every_minutes != null ? String(trigger.every_minutes) : '60',
        from: trigger?.from != null ? String(trigger.from) : '',
        to: trigger?.to != null ? String(trigger.to) : '',
        above: trigger?.above != null ? String(trigger.above) : '',
        below: trigger?.below != null ? String(trigger.below) : '',
    }));
    _automationBuilderConditions = conditions.map(condition => _automationNormalizeCondition(condition));
    _automationBuilderActions = actions.map(action => {
        if (action?.kind === 'service') {
            // Backend normalized form stores entity_id at top level (no `target`
            // wrapper) and the bare verb. Reconstruct HA-style `domain.verb`
            // for the editor UX so it round-trips cleanly.
            const entityId = action?.entity_id || action?.target?.entity_id || '';
            const verb = String(action?.service || '').trim();
            const domain = entityId.includes('.') ? entityId.split('.')[0] : '';
            const service = verb && domain && !verb.includes('.')
                ? `${domain}.${verb}`
                : verb;
            return {
                kind: 'service',
                service,
                entity_id: entityId,
                data: JSON.stringify(action.data || {}, null, 2),
            };
        }
        if (action?.kind === 'skill') {
            return {
                kind: 'skill',
                name: action.name || '',
                input: JSON.stringify(action.input || {}, null, 2),
            };
        }
        return {
            kind: 'notify',
            text: action.text || '',
        };
    });
    _automationSetBuilderState(nextState);
    _automationRenderBuilderTriggers();
    _automationRenderBuilderConditions();
    _automationRenderBuilderActions();
    _automationSetBuilderWarning(warningMessage);
    return true;
}

function _automationResetBuilder() {
    _automationBuilderTriggers = [_automationBuilderTriggerTemplate('time')];
    _automationBuilderConditions = [];
    _automationBuilderActions = [_automationBuilderActionTemplate('notify')];
    _acClose();
    _automationSetBuilderState(_automationDefaultBuilderState());
    _automationRenderBuilderTriggers();
    _automationRenderBuilderConditions();
    _automationRenderBuilderActions();
    _automationSetBuilderWarning('');
}

function _automationSetEditorMode(mode) {
    _automationEditorMode = ['builder', 'yaml', 'history'].includes(mode) ? mode : 'builder';
    document.querySelectorAll('[data-automation-editor-mode]').forEach(element => {
        const active = element.getAttribute('data-automation-editor-mode') === _automationEditorMode;
        element.classList.toggle('bg-accent', active);
        element.classList.toggle('text-bg-main', active);
        element.classList.toggle('text-slate-300', !active);
        element.classList.toggle('bg-white/5', !active);
    });
    document.querySelectorAll('[data-automation-editor-panel]').forEach(element => {
        element.classList.toggle('hidden', element.getAttribute('data-automation-editor-panel') !== _automationEditorMode);
    });
}

function _formatAutomationNextRun(item) {
    const nextRuns = Array.isArray(item?.next_runs) ? item.next_runs : [];
    const nextRunAt = nextRuns[0]?.next_run_at;
    if (!nextRunAt) return '—';
    try {
        return new Date(nextRunAt.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return nextRunAt;
    }
}

function _formatAutomationUpdatedAt(item) {
    if (!item?.updated_at) return '—';
    try {
        return new Date(item.updated_at.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return item.updated_at;
    }
}

function _formatAutomationHistoryAt(value) {
    if (!value) return '—';
    try {
        return new Date(value.replace('Z', '+00:00')).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (_) {
        return value;
    }
}

function _automationDot(item) {
    const defId = item?.id || '';
    const enabled = !!item?.enabled;
    const lastStatus = (item?.last_run_status || '').trim().toLowerCase();
    let color, label;
    if (!enabled) {
        color = 'auto-dot--yellow';
        label = t('automations.disabled_badge');
    } else if (lastStatus === 'error') {
        color = 'auto-dot--red';
        label = (t('automations.last_run_error_detail')) + (item?.last_error ? ': ' + item.last_error : '');
    } else {
        color = 'auto-dot--green';
        label = t('automations.enabled_badge');
    }
    return `<span class="auto-dot ${color} shrink-0" data-auto-dot="${escapeHtmlAttr(defId)}" data-auto-dot-label="${escapeHtmlAttr(label)}" data-memory-action="showAutoDotTooltip" data-memory-hover="showAutoDotTooltip"></span>`;
}

function _formatAutoTimestamp(isoStr) {
    if (!isoStr) return '';
    try {
        const d = new Date(isoStr);
        const now = new Date();
        const diffMs = now - d;
        if (diffMs < 60000) return 'acum';
        if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)} min`;
        if (diffMs < 86400000) {
            return d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
}

function _automationRunStatusBadge(status) {
    const normalized = String(status || '').trim().toLowerCase();
    const map = {
        ok: 'text-emerald-400/90 bg-emerald-500/15',
        skipped: 'text-amber-400/90 bg-amber-500/15',
        error: 'text-red-400/90 bg-red-500/15',
    };
    const labelMap = {
        ok: t('automations.history_status_ok'),
        skipped: t('automations.history_status_skipped'),
        error: t('automations.history_status_error'),
    };
    return `<span class="text-[9px] font-bold uppercase tracking-wider ${map[normalized] || 'text-slate-400 bg-slate-500/10'} px-2 py-0.5 rounded">${labelMap[normalized] || escapeHtml(normalized || '—')}</span>`;
}

function _buildAutomationTemplate() {
    return [
        'version: 1',
        'id: new_automation',
        'title: New automation',
        'enabled: true',
        'trigger:',
        '  - platform: time',
        '    at: "09:00"',
        'action:',
        '  - notify:',
        '      text: Automation created.',
        '',
    ].join('\n');
}

let _autoHistoryItems = [];
let _autoHistoryPage = 1;
const _AUTO_HISTORY_PAGE_SIZE = 10;

export async function loadAutomationEditorHistory(targetId) {
    const listEl = document.getElementById('automation-editor-history-list');
    const emptyEl = document.getElementById('automation-editor-history-empty');
    if (!listEl || !emptyEl) return;
    const id = _automationIdString(targetId) || _editorAutomationId();
    if (!id) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = t('automations.history_unavailable');
        return;
    }
    listEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    listEl.innerHTML = `<p class="text-[11px] text-slate-500">${t('automations.loading')}</p>`;
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(id)}/history`);
        const data = await res.json();
        _autoHistoryItems = Array.isArray(data.items) ? data.items : [];
        _autoHistoryPage = 1;
        if (!_autoHistoryItems.length) {
            listEl.innerHTML = '';
            listEl.classList.add('hidden');
            emptyEl.classList.remove('hidden');
            emptyEl.textContent = t('automations.history_empty');
            return;
        }
        _renderAutoHistoryPage();
    } catch (_) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = t('automations.history_error');
    }
}

function _renderAutoHistoryPage() {
    const listEl = document.getElementById('automation-editor-history-list');
    if (!listEl) return;
    const total = _autoHistoryItems.length;
    const totalPages = Math.max(1, Math.ceil(total / _AUTO_HISTORY_PAGE_SIZE));
    if (_autoHistoryPage > totalPages) _autoHistoryPage = totalPages;
    if (_autoHistoryPage < 1) _autoHistoryPage = 1;
    const start = (_autoHistoryPage - 1) * _AUTO_HISTORY_PAGE_SIZE;
    const slice = _autoHistoryItems.slice(start, start + _AUTO_HISTORY_PAGE_SIZE);
    const from = start + 1;
    const to = Math.min(start + slice.length, total);

    const rows = slice.map((item, i) => {
        const idx = start + i;
        const details = item?.details && typeof item.details === 'object' ? item.details : null;
        const trace = details && details.trace && typeof details.trace === 'object' ? details.trace : null;
        const runId = (details && details.run_id) || (trace && trace.run_id) || '';
        const runIdShort = runId ? String(runId).slice(0, 8) : '';
        const traceHtml = trace ? _automationRenderTraceBlock(trace, `auto-trace-${idx}`) : '';
        const runIdBadge = runIdShort
            ? `<span class="text-[10px] font-mono text-slate-500" title="${escapeHtml(runId)}">${escapeHtml(t('automations.trace_run_id'))} ${escapeHtml(runIdShort)}</span>`
            : '';
        return `
            <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-2">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                        <div class="text-[11px] text-slate-300">${escapeHtml(_formatAutomationHistoryAt(item.started_at))}</div>
                        ${runIdBadge}
                    </div>
                    ${_automationRunStatusBadge(item.status)}
                </div>
                <div class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
                    <span><span class="text-slate-400">${t('automations.history_trigger')}:</span> ${escapeHtml(item.trigger_source || '—')}</span>
                    <span><span class="text-slate-400">${t('automations.history_finished')}:</span> ${escapeHtml(_formatAutomationHistoryAt(item.finished_at))}</span>
                </div>
                ${item.message ? `<p class="text-[11px] text-slate-300 break-words">${escapeHtml(item.message)}</p>` : ''}
                ${traceHtml}
            </div>`;
    }).join('');

    const pager = totalPages > 1 ? `
        <div class="hy-devices-pagination" style="padding-top:0.5rem">
            <div class="hy-devices-pager-info">
                <span>${from}–${to}</span>
                <span>${t('hy.pager_of')}</span>
                <strong>${total}</strong>
            </div>
            <div class="hy-devices-pager-actions">
                <button type="button" class="hy-pager-btn" data-auto-hist-page="${_autoHistoryPage - 1}" ${_autoHistoryPage <= 1 ? 'disabled' : ''} aria-label="${escapeHtml(t('common.pager_prev'))}"><i class="fas fa-chevron-left"></i></button>
                <span class="hy-page-index">${_autoHistoryPage} / ${totalPages}</span>
                <button type="button" class="hy-pager-btn" data-auto-hist-page="${_autoHistoryPage + 1}" ${_autoHistoryPage >= totalPages ? 'disabled' : ''} aria-label="${escapeHtml(t('common.pager_next'))}"><i class="fas fa-chevron-right"></i></button>
            </div>
        </div>` : '';

    listEl.innerHTML = rows + pager;
    listEl.querySelectorAll('[data-auto-hist-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            _autoHistoryPage = Number(btn.dataset.autoHistPage) || 1;
            _renderAutoHistoryPage();
        });
    });
}

function _automationRenderTraceBlock(trace, id) {
    const steps = Array.isArray(trace?.steps) ? trace.steps : [];
    if (!steps.length) return '';
    const truncated = !!trace.truncated;
    const showLabel = escapeHtml(t('automations.trace_show'));
    const hideLabel = escapeHtml(t('automations.trace_hide'));
    const stepRows = steps.map(step => {
        const status = String(step?.status || 'ok');
        const dot = status === 'error'
            ? 'bg-rose-400'
            : status === 'skipped' ? 'bg-amber-400' : 'bg-emerald-400';
        const offset = Number.isFinite(step?.ts_offset_ms) ? `+${Math.round(step.ts_offset_ms)}ms` : '';
        const dur = Number.isFinite(step?.duration_ms) ? `${Math.round(step.duration_ms)}ms` : '';
        const detail = step?.error || step?.message || '';
        const params = step?.params && typeof step.params === 'object' && !Array.isArray(step.params)
            ? Object.entries(step.params)
                .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
                .join(' ')
            : '';
        return `
            <div class="flex items-start gap-2 py-1 border-b border-white/5 last:border-b-0">
                <span class="mt-1 inline-block w-1.5 h-1.5 rounded-full ${dot} flex-shrink-0"></span>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2 text-[10px] font-mono text-slate-300">
                        <span class="truncate">${escapeHtml(step?.path || '')}</span>
                        <span class="text-slate-500 flex-shrink-0">${escapeHtml(offset)}${dur ? ' · ' + escapeHtml(dur) : ''}</span>
                    </div>
                    ${detail ? `<div class="text-[10px] ${status === 'error' ? 'text-rose-300' : 'text-slate-400'} break-words">${escapeHtml(detail)}</div>` : ''}
                    ${params ? `<div class="text-[10px] text-slate-500 font-mono break-words">${params}</div>` : ''}
                </div>
            </div>`;
    }).join('');
    const truncWarn = truncated
        ? `<div class="text-[10px] text-amber-400">${escapeHtml(t('automations.trace_truncated'))}</div>`
        : '';
    return `
        <details class="mt-1" id="${id}">
            <summary class="cursor-pointer text-[10px] text-accent hover:text-white">${showLabel}</summary>
            <div class="mt-2 rounded-lg border border-white/5 bg-bg-main/40 p-2 space-y-0.5">
                ${stepRows}
                ${truncWarn}
            </div>
        </details>`;
}

export function switchAutomationEditorMode(mode) {
    _automationSetEditorMode(mode);
    if (mode === 'yaml') {
        refreshCodeEditor('automation-editor-yaml');
    } else if (mode === 'history' && _editorAutomationId()) {
        loadAutomationEditorHistory();
    }
}

let _automationIdManuallyEdited = false;

function _slugify(text) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 64);
}

export function autoSyncAutomationId() {
    if (_automationIdManuallyEdited) return;
    const titleEl = document.getElementById('automation-builder-title');
    const idEl = document.getElementById('automation-builder-id');
    if (!titleEl || !idEl) return;
    idEl.value = _slugify(titleEl.value);
}

export function markAutomationIdManual() {
    _automationIdManuallyEdited = true;
}

export async function syncAutomationYamlFromBuilder(options = {}) {
    if (options.rerenderTriggers) {
        _automationReadBuilderTriggersFromDom();
        _automationRenderBuilderTriggers();
    }
    if (options.rerenderConditions) {
        _automationReadBuilderConditionsFromDom();
        _automationRenderBuilderConditions();
    }
    if (options.rerenderActions) {
        _automationReadBuilderActionsFromDom();
        _automationRenderBuilderActions();
    }
    const yamlEl = document.getElementById('automation-editor-yaml');
    if (!yamlEl) return;
    setCodeEditorValue('automation-editor-yaml', _automationBuildYamlFromBuilder());
    if (!options.silent) {
        const validateEl = document.getElementById('automation-editor-validation');
        if (validateEl) validateEl.classList.add('hidden');
    }
}

export async function syncAutomationBuilderFromYaml(options = {}) {
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) return false;
    try {
        const res = await apiCall('/api/automations/definitions/validate', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const normalized = data.normalized || {};
        return await _automationHydrateBuilderFromNormalized(normalized, '');
    } catch (e) {
        _automationSetBuilderWarning(options.silent ? '' : (t('automations.builder_sync_error')));
        return false;
    }
}

let _autoStatusTimer = null;

function _startAutoStatusPoll() {
    _stopAutoStatusPoll();
    _autoStatusTimer = setInterval(_pollAutoStatuses, 3000);
}

function _stopAutoStatusPoll() {
    if (_autoStatusTimer) { clearInterval(_autoStatusTimer); _autoStatusTimer = null; }
}

let _autoMenuPortal = null;

export function toggleAutoMenu(e, defId, btnEl) {
    e?.stopPropagation?.();
    const wasOpen = _autoMenuPortal?.dataset.defId === defId;
    closeAutoMenu();
    if (wasOpen) return;

    const src = document.getElementById(`auto-menu-${defId}`);
    if (!src) return;

    const btn = btnEl || e?.target?.closest?.('[data-memory-action="toggleAutoMenu"]');
    if (!btn?.getBoundingClientRect) return;
    const r = btn.getBoundingClientRect();
    const portal = src.cloneNode(true);
    portal.id = 'auto-menu-portal';
    portal.dataset.defId = defId;
    portal.classList.remove('hidden');
    Object.assign(portal.style, { position: 'fixed', zIndex: '9999', top: (r.bottom + 4) + 'px', left: 'auto', right: 'auto' });
    document.body.appendChild(portal);
    _autoMenuPortal = portal;

    requestAnimationFrame(() => {
        const mw = portal.offsetWidth;
        let left = r.right - mw;
        if (left < 8) left = 8;
        if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw;
        portal.style.left = left + 'px';
    });
}

export function closeAutoMenu() {
    if (_autoMenuPortal) { _autoMenuPortal.remove(); _autoMenuPortal = null; }
}

let _autoDotTip = null;
export function showAutoDotTooltip(e, dotEl) {
    e?.stopPropagation?.();
    const dot = dotEl || e?.target?.closest?.('[data-memory-hover="showAutoDotTooltip"], [data-memory-action="showAutoDotTooltip"]');
    if (!dot) return;
    const label = dot.dataset.autoDotLabel || '';
    if (!label) return;
    hideAutoDotTooltip();
    const tip = document.createElement('div');
    tip.className = 'auto-dot-tooltip';
    tip.textContent = label;
    document.body.appendChild(tip);
    _autoDotTip = tip;
    const rect = dot.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2 - tip.offsetWidth / 2}px`;
    tip.style.top = `${rect.top - tip.offsetHeight - 6}px`;
    requestAnimationFrame(() => tip.classList.add('is-visible'));
}

export function hideAutoDotTooltip() {
    if (_autoDotTip) { _autoDotTip.remove(); _autoDotTip = null; }
}

document.addEventListener('click', () => { closeAutoMenu(); hideAutoDotTooltip(); });

async function _pollAutoStatuses() {
    const panel = document.getElementById('intelligence-panel-automations');
    if (!panel || panel.classList.contains('hidden')) { _stopAutoStatusPoll(); return; }
    try {
        const res = await apiCall('/api/automations/definitions/statuses');
        if (!res.ok) return;
        const data = await res.json();
        for (const item of (data.items || [])) {
            const dot = document.querySelector(`[data-auto-dot="${CSS.escape(item.id)}"]`);
            const timeEl = document.querySelector(`[data-auto-last-time="${CSS.escape(item.id)}"]`);
            if (dot && typeof item.enabled === 'boolean') {
                const lastStatus = (item.last_run_status || '').trim().toLowerCase();
                let cls, label;
                if (!item.enabled) {
                    cls = 'auto-dot--yellow';
                    label = t('automations.disabled_badge');
                } else if (lastStatus === 'error') {
                    cls = 'auto-dot--red';
                    label = (t('automations.last_run_error_detail')) + (item.last_error ? ': ' + item.last_error : '');
                } else {
                    cls = 'auto-dot--green';
                    label = t('automations.enabled_badge');
                }
                dot.className = `auto-dot ${cls} shrink-0`;
                dot.dataset.autoDotLabel = label;
            }
            const ts = item.last_run_at ? _formatAutoTimestamp(item.last_run_at) : '—';
            if (timeEl) timeEl.textContent = ts;
        }
    } catch (_) {}
}

export async function loadAutomations() {
    const listEl = document.getElementById('automations-list');
    const emptyEl = document.getElementById('automations-empty');
    if (!listEl) return;
    listEl.innerHTML = `<p class="text-[11px] text-slate-500">${t('automations.loading')}</p>`;
    try {
        const res = await apiCall('/api/automations/definitions');
        const data = await res.json();
        const automations = Array.isArray(data.items) ? data.items : [];
        if (!automations.length) {
            listEl.classList.add('hidden');
            if (emptyEl) emptyEl.classList.remove('hidden');
        } else {
            listEl.classList.remove('hidden');
            if (emptyEl) emptyEl.classList.add('hidden');
            listEl.innerHTML = automations.map(a => {
                const defId = escapeHtml(a.id).replace(/"/g, '&quot;');
                const desc = escapeHtml(a.description || '');
                const lastTime = a.last_run_at ? _formatAutoTimestamp(a.last_run_at) : '—';
                const nextTime = escapeHtml(_formatAutomationNextRun(a));
                const toggleLabel = a.enabled ? (t('automations.disable')) : (t('automations.enable'));
                const toggleIcon = a.enabled ? 'fa-pause' : 'fa-play-circle';
                return `
                <div class="py-2 px-3 rounded-lg bg-white/[0.02] border border-white/5 automation-card" data-automation-card="${escapeHtmlAttr(a.id)}">
                    <div class="flex items-center justify-between gap-2">
                        <div class="min-w-0 flex-1 flex items-center gap-2">
                            ${_automationDot(a)}
                            <span class="text-[13px] text-slate-200 font-medium truncate">${escapeHtml(a.title || a.id || '—')}</span>
                        </div>
                        <div class="relative shrink-0">
                            <button type="button" data-memory-action="toggleAutoMenu" data-memory-def-id="${defId}" class="dashboard-kebab-btn" style="width:28px;height:28px"><i class="fas fa-ellipsis-vertical"></i></button>
                            <div id="auto-menu-${defId}" class="dashboard-more-menu hidden" style="width:200px">
                                <button type="button" data-memory-action="runAutomationDefinition" data-memory-def-id="${defId}" data-memory-close-menu="true" class="dashboard-more-menu__item"><i class="fas fa-play text-emerald-400"></i><span>${t('automations.run')}</span></button>
                                <button type="button" data-memory-action="openAutomationEditorFromList" data-memory-def-id="${defId}" data-memory-close-menu="true" class="dashboard-more-menu__item"><i class="fas fa-pen"></i><span>${t('automations.edit')}</span></button>
                                <button type="button" data-memory-action="toggleAutomationDefinition" data-memory-def-id="${defId}" data-memory-enabled="${!!a.enabled}" data-memory-revision="${a.revision || 1}" data-memory-close-menu="true" class="dashboard-more-menu__item"><i class="fas ${toggleIcon} text-amber-400"></i><span>${toggleLabel}</span></button>
                                <div class="dashboard-more-menu__sep"></div>
                                <button type="button" data-memory-action="deleteAutomation" data-memory-def-id="${defId}" data-memory-close-menu="true" class="dashboard-more-menu__item" style="color:var(--red-400,#f87171)"><i class="fas fa-trash-alt" style="color:inherit"></i><span>${t('automations.delete')}</span></button>
                            </div>
                        </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-0 text-[10px] text-slate-500 mt-0.5 pl-4">
                        ${desc ? `<span class="text-slate-400">${desc}</span><span class="text-slate-600">·</span>` : ''}
                        <span>${t('automations.last_run_label')}: <span data-auto-last-time="${escapeHtmlAttr(a.id)}">${lastTime}</span></span>
                        <span class="text-slate-600">·</span>
                        <span>${t('automations.next_run')}: ${nextTime}</span>
                    </div>
                </div>`;
            }).join('');
        }
    } catch (e) {
        listEl.innerHTML = '<p class="text-red-400 text-sm">' + (t('automations.error')) + '</p>';
        if (emptyEl) emptyEl.classList.add('hidden');
    }
    const panel = document.getElementById('intelligence-panel-automations');
    if (panel && !panel.classList.contains('hidden')) _startAutoStatusPoll();
}

export async function loadAutomationEventLog() {
    const logEl = document.getElementById('automation-event-log');
    if (!logEl) return;
    try {
        const res = await apiCall('/api/automations/definitions/events?limit=30');
        if (!res.ok) throw new Error();
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            logEl.innerHTML = `<p class="text-[11px] text-slate-500">${t('automations.event_log_empty')}</p>`;
            return;
        }
        logEl.innerHTML = items.map(r => {
            const statusColor = r.status === 'ok' ? 'text-emerald-400' : r.status === 'error' ? 'text-red-400' : 'text-amber-400';
            const statusIcon = r.status === 'ok' ? 'fa-check' : r.status === 'error' ? 'fa-xmark' : 'fa-forward';
            const triggerLabel = _formatTriggerSource(r.trigger_source);
            const timeStr = r.started_at ? _formatAutoTimestamp(r.started_at) : '—';
            return `<div class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-white/[0.02] transition-colors">
                <i class="fas ${statusIcon} ${statusColor} text-[9px] w-3 text-center shrink-0"></i>
                <span class="text-[12px] text-slate-200 font-medium truncate">${escapeHtml(r.title || r.automation_id)}</span>
                <span class="text-[10px] text-slate-500 shrink-0">${triggerLabel}</span>
                <span class="text-[10px] text-slate-500 ml-auto shrink-0">${timeStr}</span>
            </div>`;
        }).join('');
    } catch (_) {
        logEl.innerHTML = `<p class="text-[11px] text-red-400">${t('automations.event_log_error')}</p>`;
    }
}

function _formatTriggerSource(src) {
    if (!src) return '';
    if (src === 'manual') return t('automations.trigger_manual');
    if (src.startsWith('trigger:')) return t('automations.trigger_auto');
    return escapeHtml(src);
}

export async function deleteAutomation(jobId) {
    if (!(await showConfirm(t('automations.delete_confirm')))) return;
    try {
        const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(jobId), { method: 'DELETE' });
        if (!res.ok) throw new Error();
        if (_automationEditorId === jobId) closeAutomationEditor();
        showToast(t('automations.deleted'), 'success');
        await loadAutomations();
    } catch (e) {
        showToast(t('automations.delete_error'), 'error');
    }
}

export async function openAutomationEditor(automationId) {
    automationId = _automationIdString(automationId) || undefined;
    const validateEl = document.getElementById('automation-editor-validation');
    const infoEl = document.getElementById('automation-editor-info');
    const pathEl = document.getElementById('automation-editor-path');
    const idEl = document.getElementById('automation-editor-id');
    const revEl = document.getElementById('automation-editor-revision');
    const idDisplayEl = document.getElementById('automation-editor-id-display');
    const titleEl = document.getElementById('automation-editor-title');
    _automationEditorId = automationId || null;
    _automationEditorRevision = null;
    if (validateEl) validateEl.classList.add('hidden');
    if (infoEl) infoEl.textContent = '';
    if (pathEl) pathEl.textContent = '—';
    if (idEl) idEl.value = automationId || '';
    if (revEl) revEl.value = '';
    if (idDisplayEl) idDisplayEl.textContent = automationId || 'YAML';
    _automationResetBuilder();
    _automationIdManuallyEdited = !!automationId;
    // Prefetch capabilities (entities/areas/schema) so the inline pickers
    // have fresh data before the user starts typing. Fire-and-forget — the
    // editor still works on stale cache (or empty) if the call is slow.
    _automationLoadCapabilities({ force: true });
    if (!automationId) {
        if (titleEl) titleEl.textContent = t('automations.editor_new_title');
        setCodeEditorValue('automation-editor-yaml', _buildAutomationTemplate());
        await refreshAutomationEntityOptions();
        openSubPage('automation-editor-modal');
        _upgradeAutoBuilderSelects(document.getElementById('automation-editor-modal'));
        refreshCodeEditor('automation-editor-yaml');
        return;
    }
    if (titleEl) titleEl.textContent = t('automations.editor_edit_title');
    setCodeEditorValue('automation-editor-yaml', '');
    if (infoEl) infoEl.textContent = t('automations.loading');
    openSubPage('automation-editor-modal');
    _upgradeAutoBuilderSelects(document.getElementById('automation-editor-modal'));
    refreshCodeEditor('automation-editor-yaml');
    try {
        const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(automationId));
        const data = await res.json();
        const item = data.item || {};
        _automationEditorId = item.id || automationId;
        _automationEditorRevision = item.revision || 1;
        if (idEl) idEl.value = item.id || automationId;
        if (idDisplayEl) idDisplayEl.textContent = item.id || automationId;
        if (revEl) revEl.value = String(item.revision || 1);
        if (pathEl) pathEl.textContent = item.yaml_path || '—';
        setCodeEditorValue('automation-editor-yaml', item.source_yaml || _buildAutomationTemplate());
        if (infoEl) infoEl.textContent = `${t('automations.revision')} ${item.revision || 1} • ${item.enabled ? (t('automations.enabled_badge')) : (t('automations.disabled_badge'))}`;
        await _automationHydrateBuilderFromNormalized(item.normalized || {}, '');
        await refreshAutomationEntityOptions();
        refreshCodeEditor('automation-editor-yaml');
        await loadAutomationEditorHistory(automationId);
    } catch (e) {
        showToast(t('automations.load_error'), 'error');
    }
}

export function closeAutomationEditor() {
    const historyList = document.getElementById('automation-history-list');
    const historyEmpty = document.getElementById('automation-history-empty');
    if (historyList) historyList.innerHTML = '';
    if (historyEmpty) {
        historyEmpty.classList.remove('hidden');
        historyEmpty.textContent = t('automations.history_unavailable');
    }
    closeSubPage('automation-editor-modal');
}

export async function validateAutomationEditor() {
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) return;
    try {
        const res = await apiCall('/api/automations/definitions/validate', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        await _automationHydrateBuilderFromNormalized(data.normalized || {}, '');
        const name = data.normalized?.title || data.normalized?.id || '';
        const msg = t('automations.validation_ok', { name });
        showToast(msg, 'success');
        _renderAutomationLintWarnings(data.warnings || []);
    } catch (e) {
        let detail = t('automations.validation_error');
        try {
            const payload = JSON.parse(e?.message || '{}');
            if (payload?.detail) detail = payload.detail;
        } catch (_) {}
        if (e?.message && !e.message.startsWith('{')) detail = e.message;
        showToast(detail, 'error');
    }
}

export async function saveAutomationEditor() {
    const revisionEl = document.getElementById('automation-editor-revision');
    const sourceYaml = getCodeEditorValue('automation-editor-yaml')?.trim();
    if (!sourceYaml) {
        showToast(t('automations.validation_error'), 'error');
        return;
    }
    try {
        const editorId = _editorAutomationId();
        if (editorId) {
            const expectedRevision = Number(revisionEl?.value || _automationEditorRevision || 1);
            const res = await apiCall('/api/automations/definitions/' + encodeURIComponent(editorId), {
                method: 'PUT',
                body: { source_yaml: sourceYaml, expected_revision: expectedRevision },
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
                throw new Error(String(detail));
            }
            showToast(t('automations.saved'), 'success');
        } else {
            const res = await apiCall('/api/automations/definitions', {
                method: 'POST',
                body: { source_yaml: sourceYaml },
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const detail = payload?.detail || payload?.error || `HTTP ${res.status}`;
                throw new Error(String(detail));
            }
            showToast(t('automations.created'), 'success');
        }
        await loadAutomations();
    } catch (e) {
        const msg = (e && e.message) ? e.message : (t('automations.save_error'));
        showToast(msg, 'error');
    }
}

export async function toggleAutomationDefinition(automationId, enabled, revision) {
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(automationId)}/${enabled ? 'disable' : 'enable'}`, {
            method: 'POST',
            body: { expected_revision: Number(revision || 1) },
        });
        if (!res.ok) throw new Error();
        showToast(enabled ? (t('automations.disabled')) : (t('automations.enabled')), 'success');
        if (_automationEditorId === automationId) {
            const infoEl = document.getElementById('automation-editor-info');
            if (infoEl) infoEl.textContent = enabled ? (t('automations.disabled_badge')) : (t('automations.enabled_badge'));
        }
        await loadAutomations();
    } catch (e) {
        showToast(t('automations.toggle_error'), 'error');
    }
}

export async function runAutomationDefinition(automationId) {
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(automationId)}/run`, { method: 'POST' });
        if (!res.ok) throw new Error();
        showToast(t('automations.ran'), 'success');
        if (_automationEditorId === automationId) await loadAutomationEditorHistory(automationId);
        _pollAutoStatuses();
    } catch (e) {
        showToast(t('automations.run_error'), 'error');
    }
}

export async function testAutomationEditor() {
    // Dry-run the currently-open automation. Requires the automation to
    // already be saved (we need an id on the server to walk).
    const editorId = _editorAutomationId();
    if (!editorId) {
        showToast(t('automations.test_save_first'), 'warning');
        return;
    }
    try {
        const res = await apiCall(`/api/automations/definitions/${encodeURIComponent(editorId)}/test`, { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const result = data.result || {};
        _renderAutomationDryRunTrace(result);
        const status = result.status || 'unknown';
        const tone = status === 'ok' ? 'success' : status === 'skipped' ? 'warning' : 'error';
        showToast(`${t('automations.test_done')}: ${status}`, tone);
    } catch (e) {
        showToast(t('automations.test_error'), 'error');
    }
}

function _pathDepth(path) {
    // Path depth = number of `[` chars (each array index = one nesting level).
    // E.g. "action[2]" = 1, "action[2].choices[0].actions[1]" = 3.
    if (!path) return 0;
    return (path.match(/\[/g) || []).length;
}

function _pathLeaf(path) {
    // Last segment, e.g. "action[2].choices[0].actions[1]" -> "actions[1]".
    if (!path) return '';
    const parts = path.split('.');
    return parts[parts.length - 1] || path;
}

function _renderAutomationDryRunTrace(result) {
    // Render the trace as an indented tree so branching `choose` actions
    // (and nested `repeat` blocks) are visually obvious. Nesting is
    // derived from the step's `path` (each `[...]` segment adds a level).
    const listEl = document.getElementById('automation-editor-history-list');
    const emptyEl = document.getElementById('automation-editor-history-empty');
    if (!listEl) return;
    const trace = result.trace || { steps: [] };
    const steps = Array.isArray(trace.steps) ? trace.steps : [];
    const headerLabel = t('automations.test_header');
    const statusLabel = (result.status || 'unknown').toUpperCase();
    const statusColor = result.status === 'ok' ? 'text-emerald-300'
        : result.status === 'skipped' ? 'text-amber-300' : 'text-red-300';
    const stepsHtml = steps.length === 0
        ? `<p class="text-[11px] text-slate-500">${escapeHtml(t('automations.test_no_steps'))}</p>`
        : steps.map(s => {
            const tone = s.status === 'ok' ? 'text-emerald-300'
                : s.status === 'dry_run' ? 'text-sky-300'
                : s.status === 'skipped' ? 'text-amber-300'
                : s.status === 'error' ? 'text-red-300' : 'text-slate-400';
            const dotTone = s.status === 'ok' ? 'bg-emerald-400'
                : s.status === 'dry_run' ? 'bg-sky-400'
                : s.status === 'skipped' ? 'bg-amber-400'
                : s.status === 'error' ? 'bg-red-400' : 'bg-slate-500';
            const depth = _pathDepth(s.path);
            const leaf = _pathLeaf(s.path);
            const ms = (s.ts_offset_ms != null) ? `+${Math.round(s.ts_offset_ms)}ms` : '';
            const dur = (s.duration_ms != null) ? ` · ${Math.round(s.duration_ms)}ms` : '';
            const indentStyle = `padding-left: ${depth * 14}px;`;
            const branchHint = depth > 0
                ? `<span class="text-slate-700 font-mono mr-1">${'│ '.repeat(Math.max(0, depth - 1))}└─</span>`
                : '';
            return `<div class="text-[11px] flex gap-2 items-baseline border-l border-white/5" style="${indentStyle}">
                <span class="inline-block w-1.5 h-1.5 rounded-full ${dotTone} flex-none mt-1"></span>
                <span class="text-slate-600 font-mono text-[10px] flex-none">${escapeHtml(ms)}${escapeHtml(dur)}</span>
                <span class="${tone} font-bold uppercase text-[10px] flex-none">${escapeHtml(s.status || '?')}</span>
                <span class="text-slate-400 font-mono text-[10px] flex-none">${branchHint}${escapeHtml(leaf)}</span>
                <span class="text-slate-300 flex-1">${escapeHtml(s.message || s.error || '')}</span>
            </div>`;
        }).join('');
    listEl.innerHTML = `
        <div class="rounded-lg bg-white/5 border border-white/10 p-3 space-y-2">
            <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-200"><i class="fas fa-flask text-emerald-400 mr-1"></i>${escapeHtml(headerLabel)}</span>
                <span class="text-[10px] font-bold ${statusColor}">${escapeHtml(statusLabel)}</span>
            </div>
            <div class="space-y-0.5">${stepsHtml}</div>
        </div>`;
    listEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
}

function _renderAutomationLintWarnings(warnings) {
    // Render non-fatal lint warnings into the validation panel as a sub-list.
    // Each warning has {code, severity, message, path}. severity ∈ info|warning.
    const validateEl = document.getElementById('automation-editor-validation');
    if (!validateEl) return;
    let panel = document.getElementById('automation-editor-warnings');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'automation-editor-warnings';
        panel.className = 'mt-2 space-y-1';
        validateEl.insertAdjacentElement('afterend', panel);
    }
    if (!warnings || warnings.length === 0) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = warnings.map(w => {
        const tone = w.severity === 'warning'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'border-sky-500/30 bg-sky-500/10 text-sky-200';
        const icon = w.severity === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info';
        return `<div class="rounded-lg border ${tone} px-3 py-2 text-[11px] flex items-start gap-2">
            <i class="fas ${icon} mt-0.5"></i>
            <div class="flex-1">
                <div>${escapeHtml(w.message || '')}</div>
                <div class="text-[10px] opacity-70 mt-0.5"><span class="font-mono">${escapeHtml(w.path || '')}</span> · <span class="uppercase">${escapeHtml(w.code || '')}</span></div>
            </div>
        </div>`;
    }).join('');
}

export function exportAutomationYaml() {
    // Download the current editor YAML as a .yaml file. Filename is derived
    // from the automation id (or "automation" if unsaved).
    const yaml = getCodeEditorValue('automation-editor-yaml') || '';
    if (!yaml.trim()) {
        showToast(t('automations.export_empty'), 'warning');
        return;
    }
    const baseName = (_automationEditorId || 'automation').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.yaml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('automations.export_done'), 'success');
}

export function importAutomationYaml() {
    // Open the hidden <input type="file"> and load its contents into the
    // editor. Does NOT save — the user still has to hit Save.
    const input = document.getElementById('automation-yaml-import-input');
    if (!input) return;
    input.value = '';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            if (!text.trim()) {
                showToast(t('automations.import_empty'), 'warning');
                return;
            }
            setCodeEditorValue('automation-editor-yaml', text);
            refreshCodeEditor('automation-editor-yaml');
            showToast(t('automations.import_done', { name: file.name }), 'success');
        } catch (e) {
            showToast(t('automations.import_error'), 'error');
        }
    };
    input.click();
}

// --------------------------------------------------------------------------- //
// Blueprint picker — Sprint 5 slice 3                                         //
// --------------------------------------------------------------------------- //

let _blueprints = [];
let _activeBlueprint = null;
let _pickerEntityCache = null;
let _pickerAreaCache = null;
let _blueprintCreatorInputs = [];

function _prepareBlueprintPickerModal() {
    const modal = document.getElementById('blueprint-picker-modal');
    if (!modal) return null;
    const host = document.getElementById('view-config') || document.querySelector('main') || document.body;
    if (modal.parentElement !== host) {
        host.appendChild(modal);
    }
    modal.style.position = '';
    modal.style.inset = '';
    modal.style.zIndex = '';
    return modal;
}

async function _blueprintApiCall(url, options = {}) {
    suppressLogout(true);
    try {
        return await apiCall(url, options);
    } finally {
        suppressLogout(false);
    }
}

export async function openBlueprintPicker() {
    _prepareBlueprintPickerModal();
    openSubPage('blueprint-picker-modal');
    backToBlueprintList();
    loadBlueprints();
}

export function closeBlueprintPicker() {
    closeSubPage('blueprint-picker-modal');
    _activeBlueprint = null;
}

export function backToBlueprintList() {
    _activeBlueprint = null;
    document.getElementById('blueprint-picker-list-pane')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-form-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.add('flex');
    document.getElementById('blueprint-picker-form-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-actions')?.classList.remove('flex');
    document.getElementById('blueprint-picker-creator-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-actions')?.classList.remove('flex');
    document.getElementById('blueprint-picker-create-btn')?.classList.add('hidden');
    document.getElementById('blueprint-picker-delete-btn')?.classList.add('hidden');
    const errEl = document.getElementById('blueprint-picker-form-error');
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
    const creatorErrEl = document.getElementById('blueprint-creator-error');
    if (creatorErrEl) { creatorErrEl.classList.add('hidden'); creatorErrEl.textContent = ''; }
}

function _defaultBlueprintTemplate() {
    return `id: morning_notice
title: "Morning notice"
mode: single
trigger:
  - platform: time
    at: "08:00"
action:
  - notify:
      text: "${t('blueprints.default_notify_text')}"`;
}

function _readBlueprintCreatorInputsFromDom() {
    const rows = Array.from(document.querySelectorAll('#blueprint-creator-inputs [data-bp-creator-input-row]'));
    return rows.map((row, idx) => {
        const read = selector => row.querySelector(selector)?.value || '';
        return {
            id: read('[data-bp-creator-field="id"]').trim() || `input_${idx + 1}`,
            label: read('[data-bp-creator-field="label"]').trim(),
            type: read('[data-bp-creator-field="type"]').trim() || 'string',
            required: !!row.querySelector('[data-bp-creator-field="required"]')?.checked,
            default: read('[data-bp-creator-field="default"]'),
            choices: read('[data-bp-creator-field="choices"]'),
        };
    });
}

function _yamlScalar(value) {
    return JSON.stringify(String(value ?? ''));
}

function _indentBlock(text) {
    return String(text || '').replace(/\s+$/g, '').split('\n').map(line => `  ${line}`).join('\n');
}

function _validateBlueprintCreatorDraft(draft) {
    const title = String(draft.title || '').trim();
    if (!title) return t('blueprints.title_required');
    if (!String(draft.template || '').trim()) return t('blueprints.template_required');
    const seen = new Set();
    for (const input of draft.inputs) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.id)) return t('blueprints.invalid_input_id', { id: input.id });
        if (seen.has(input.id)) return t('blueprints.duplicate_input', { id: input.id });
        seen.add(input.id);
        if (input.type === 'select' && !String(input.choices || '').split(',').map(v => v.trim()).filter(Boolean).length) {
            return t('blueprints.select_needs_options', { id: input.id });
        }
    }
    const refs = new Set();
    String(draft.template || '').replace(/\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, key) => {
        refs.add(key);
        return _m;
    });
    for (const key of refs) {
        if (!seen.has(key)) return t('blueprints.unknown_input_ref', { key });
    }
    return '';
}

function _composeBlueprintSourceYaml(draft) {
    const lines = [
        `title: ${_yamlScalar(draft.title)}`,
        `description: ${_yamlScalar(draft.description)}`,
    ];
    if (!draft.inputs.length) {
        lines.push('inputs: []');
    } else {
        lines.push('inputs:');
        for (const input of draft.inputs) {
            lines.push(`  - id: ${input.id}`);
            lines.push(`    label: ${_yamlScalar(input.label || input.id)}`);
            lines.push(`    type: ${input.type}`);
            if (input.required) lines.push('    required: true');
            if (String(input.default || '').trim()) lines.push(`    default: ${_yamlScalar(input.default)}`);
            if (input.type === 'select') {
                const choices = String(input.choices || '').split(',').map(v => v.trim()).filter(Boolean);
                lines.push('    choices:');
                for (const choice of choices) lines.push(`      - ${_yamlScalar(choice)}`);
            }
        }
    }
    lines.push('template: |');
    lines.push(_indentBlock(draft.template));
    return `${lines.join('\n')}\n`;
}

function _currentBlueprintCreatorDraft() {
    return {
        title: document.getElementById('blueprint-creator-title')?.value || '',
        description: document.getElementById('blueprint-creator-description')?.value || '',
        inputs: _readBlueprintCreatorInputsFromDom(),
        template: document.getElementById('blueprint-creator-template')?.value || '',
    };
}

function _renderBlueprintCreatorInputs() {
    const host = document.getElementById('blueprint-creator-inputs');
    if (!host) return;
    host.innerHTML = _blueprintCreatorInputs.map((input, idx) => {
        const choicesVisible = input.type === 'select' ? '' : 'hidden';
        return `
            <div data-bp-creator-input-row="${idx}" class="rounded-xl border border-white/5 bg-slate-950/60 p-3 space-y-3">
                <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_140px_auto] gap-2 items-end">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">ID</label>
                        <input type="text" data-bp-creator-field="id" value="${escapeHtml(input.id)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs mono text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Label</label>
                        <input type="text" data-bp-creator-field="label" value="${escapeHtml(input.label)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                    </div>
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Tip</label>
                        <select data-bp-creator-field="type" data-memory-input="changeBlueprintCreatorInputType" data-memory-index="${idx}" class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                            ${['string', 'number', 'boolean', 'entity', 'area', 'select', 'duration'].map(type => `<option value="${type}" ${input.type === type ? 'selected' : ''}>${type}</option>`).join('')}
                        </select>
                    </div>
                    <button type="button" data-memory-action="removeBlueprintCreatorInput" data-memory-index="${idx}" class="w-9 h-9 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 flex items-center justify-center transition-colors" title="${escapeHtml(t('blueprints.remove_input_title'))}"><i class="fas fa-trash text-xs"></i></button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">Default</label>
                        <input type="text" data-bp-creator-field="default" value="${escapeHtml(input.default)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                    </div>
                    <label class="inline-flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-slate-300">
                        <input type="checkbox" data-bp-creator-field="required" ${input.required ? 'checked' : ''} data-memory-input="updateBlueprintCreatorYaml" class="w-4 h-4 rounded accent-blue-500 bg-slate-900 border-white/10">
                        Obligatoriu
                    </label>
                </div>
                <div class="space-y-1 ${choicesVisible}">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${escapeHtml(t('blueprints.options_label'))}</label>
                    <input type="text" data-bp-creator-field="choices" value="${escapeHtml(input.choices)}" data-memory-input="updateBlueprintCreatorYaml" class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-accent outline-none">
                </div>
            </div>
        `;
    }).join('');
    _renderBlueprintCreatorPlaceholders();
}

function _renderBlueprintCreatorPlaceholders() {
    const host = document.getElementById('blueprint-creator-placeholders');
    if (!host) return;
    const inputs = _readBlueprintCreatorInputsFromDom().filter(input => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.id));
    if (!inputs.length) {
        host.classList.add('hidden');
        host.innerHTML = '';
        return;
    }
    host.classList.remove('hidden');
    host.innerHTML = inputs.flatMap(input => [
        `<button type="button" data-memory-action="insertBlueprintCreatorPlaceholder" data-memory-input-id="${escapeHtml(input.id)}" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] mono text-slate-300 transition-colors">{{ inputs.${escapeHtml(input.id)} }}</button>`,
        `<button type="button" data-memory-action="insertBlueprintCreatorPlaceholder" data-memory-input-id="${escapeHtml(input.id)}" data-memory-slugify="true" class="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] mono text-violet-300 transition-colors">{{ inputs.${escapeHtml(input.id)} | slug }}</button>`,
    ]).join('');
}

export function openBlueprintCreator() {
    _prepareBlueprintPickerModal();
    openSubPage('blueprint-picker-modal');
    _activeBlueprint = null;
    document.getElementById('blueprint-picker-list-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-pane')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.remove('flex');
    document.getElementById('blueprint-picker-form-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-actions')?.classList.remove('flex');
    document.getElementById('blueprint-picker-creator-actions')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-creator-actions')?.classList.add('flex');
    document.getElementById('blueprint-creator-title').value = '';
    document.getElementById('blueprint-creator-description').value = '';
    document.getElementById('blueprint-creator-template').value = _defaultBlueprintTemplate();
    _blueprintCreatorInputs = [];
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function addBlueprintCreatorInput() {
    _blueprintCreatorInputs = _readBlueprintCreatorInputsFromDom();
    const next = _blueprintCreatorInputs.length + 1;
    _blueprintCreatorInputs.push({
        id: next === 1 ? 'entity_id' : `input_${next}`,
        label: next === 1 ? 'Entity' : `Input ${next}`,
        type: next === 1 ? 'entity' : 'string',
        required: true,
        default: '',
        choices: '',
    });
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function removeBlueprintCreatorInput(index) {
    _blueprintCreatorInputs = _readBlueprintCreatorInputsFromDom();
    _blueprintCreatorInputs.splice(Number(index), 1);
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function changeBlueprintCreatorInputType(index, type) {
    _blueprintCreatorInputs = _readBlueprintCreatorInputsFromDom();
    if (_blueprintCreatorInputs[index]) _blueprintCreatorInputs[index].type = type;
    _renderBlueprintCreatorInputs();
    updateBlueprintCreatorYaml();
}

export function insertBlueprintCreatorPlaceholder(inputId, slug = false) {
    const textarea = document.getElementById('blueprint-creator-template');
    if (!textarea) return;
    const placeholder = `{{ inputs.${inputId}${slug ? ' | slug' : ''} }}`;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = `${textarea.value.slice(0, start)}${placeholder}${textarea.value.slice(end)}`;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;
    updateBlueprintCreatorYaml();
}

export function updateBlueprintCreatorYaml() {
    const draft = _currentBlueprintCreatorDraft();
    const source = _composeBlueprintSourceYaml(draft);
    const preview = document.getElementById('blueprint-creator-source-yaml');
    if (preview) preview.value = source;
    const errEl = document.getElementById('blueprint-creator-error');
    if (errEl) {
        const err = _validateBlueprintCreatorDraft(draft);
        if (err && draft.title.trim()) {
            errEl.classList.remove('hidden');
            errEl.textContent = err;
        } else {
            errEl.classList.add('hidden');
            errEl.textContent = '';
        }
    }
    _renderBlueprintCreatorPlaceholders();
    return source;
}

export async function saveCreatedBlueprint() {
    const draft = _currentBlueprintCreatorDraft();
    const err = _validateBlueprintCreatorDraft(draft);
    const errEl = document.getElementById('blueprint-creator-error');
    if (err) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = err;
        }
        return;
    }
    const saveBtn = document.getElementById('blueprint-creator-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
        const sourceYaml = _composeBlueprintSourceYaml(draft);
        const res = await apiCall('/api/automations/blueprints', {
            method: 'POST',
            body: { source_yaml: sourceYaml },
        });
        if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.detail || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        showToast(t('hy.blueprint_saved'), 'success');
        backToBlueprintList();
        await loadBlueprints();
        if (payload.item?.id) await selectBlueprint(payload.item.id);
    } catch (e) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = e.message || t('blueprints.save_failed');
        }
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

export async function loadBlueprints() {
    const listEl = document.getElementById('blueprint-picker-list');
    const emptyEl = document.getElementById('blueprint-picker-empty');
    if (!listEl) return;
    emptyEl?.classList.add('hidden');
    listEl.innerHTML = `<p class="text-[11px] text-slate-500">${escapeHtml(t('common.loading'))}</p>`;
    try {
        const res = await _blueprintApiCall('/api/automations/blueprints');
        if (!res.ok) throw new Error(res.status === 401 ? t('login.session_expired') : t('blueprints.load_failed'));
        const data = await res.json();
        _blueprints = data.items || [];
    } catch (e) {
        _blueprints = [];
        emptyEl?.classList.add('hidden');
        listEl.innerHTML = `<p class="text-[11px] text-red-300">${escapeHtml(e.message || t('blueprints.load_error'))}</p>`;
        return;
    }
    if (_blueprints.length === 0) {
        listEl.innerHTML = '';
        emptyEl?.classList.remove('hidden');
        return;
    }
    emptyEl?.classList.add('hidden');
    listEl.innerHTML = _blueprints.map(bp => `
        <button type="button" data-bp-id="${escapeHtml(bp.id)}" class="bp-pick-row w-full text-left flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 hover:bg-white/[0.04] transition-colors">
            <div class="flex items-center gap-3 min-w-0 flex-1">
                <span class="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0"><i class="fas fa-cube text-sm"></i></span>
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-semibold text-white truncate">${escapeHtml(bp.title)}</span>
                        <span class="inline-flex items-center gap-1 text-[10px] text-slate-400"><i class="fas fa-sliders text-[9px]"></i>${escapeHtml(t('blueprints.inputs_count', { count: (bp.inputs || []).length }))}</span>
                        <span class="text-[10px] text-slate-500">v${escapeHtml(bp.version || '1')}</span>
                    </div>
                    <div class="text-[11px] text-slate-500 truncate mt-0.5">${escapeHtml(bp.description || t('blueprints.no_description'))}</div>
                </div>
            </div>
            <i class="fas fa-chevron-right text-[10px] text-slate-600 shrink-0"></i>
        </button>
    `).join('');
    listEl.querySelectorAll('.bp-pick-row').forEach(btn => {
        btn.addEventListener('click', () => selectBlueprint(btn.dataset.bpId));
    });
}

export function importBlueprintYaml() {
    const input = document.getElementById('blueprint-yaml-import-input');
    if (!input) return;
    input.value = '';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const res = await apiCall('/api/automations/blueprints', {
                method: 'POST',
                body: { source_yaml: text },
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            showToast(t('blueprints.import_done', { name: file.name }), 'success');
            await loadBlueprints();
        } catch (e) {
            showToast(t('blueprints.import_failed', { detail: e.message || t('common.unknown') }), 'error');
        }
    };
    input.click();
}

async function _loadPickerCaches() {
    if (_pickerEntityCache && _pickerAreaCache) return;
    try {
        const [entRes, areaRes] = await Promise.all([
            apiCall('/api/integrations/picker/entities?limit=1000'),
            apiCall('/api/integrations/picker/areas'),
        ]);
        _pickerEntityCache = entRes.ok ? (await entRes.json()).items || [] : [];
        _pickerAreaCache = areaRes.ok ? (await areaRes.json()).items || [] : [];
    } catch (e) {
        _pickerEntityCache = _pickerEntityCache || [];
        _pickerAreaCache = _pickerAreaCache || [];
    }
}

async function selectBlueprint(blueprintId) {
    const bp = _blueprints.find(b => b.id === blueprintId);
    if (!bp) return;
    _activeBlueprint = bp;
    document.getElementById('blueprint-picker-list-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-form-pane')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-creator-pane')?.classList.add('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-list-actions')?.classList.remove('flex');
    document.getElementById('blueprint-picker-creator-actions')?.classList.add('hidden');
    document.getElementById('blueprint-picker-creator-actions')?.classList.remove('flex');
    document.getElementById('blueprint-picker-form-actions')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-form-actions')?.classList.add('flex');
    document.getElementById('blueprint-picker-create-btn')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-delete-btn')?.classList.remove('hidden');
    document.getElementById('blueprint-picker-form-title').textContent = bp.title;
    document.getElementById('blueprint-picker-form-description').textContent = bp.description || '';
    await _loadPickerCaches();
    const formEl = document.getElementById('blueprint-picker-form-inputs');
    formEl.innerHTML = (bp.inputs || []).map(spec => _renderBlueprintInputField(spec)).join('');
}

function _renderBlueprintInputField(spec) {
    const id = `bp-input-${spec.id}`;
    const labelHtml = `<label for="${id}" class="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1">${escapeHtml(spec.label || spec.id)}${spec.required ? ' <span class="text-red-400">*</span>' : ''}</label>`;
    const baseCls = 'w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 focus:border-accent outline-none';
    let field = '';
    const defaultVal = spec.default == null ? '' : String(spec.default);
    if (spec.type === 'entity') {
        const opts = (_pickerEntityCache || []).map(e =>
            `<option value="${escapeHtml(e.id)}" ${e.id === defaultVal ? 'selected' : ''}>${escapeHtml(e.label)} (${escapeHtml(e.domain)})</option>`
        ).join('');
        field = `<select id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="entity" class="${baseCls}"><option value="">${escapeHtml(t('blueprints.choose'))}</option>${opts}</select>`;
    } else if (spec.type === 'area') {
        const opts = (_pickerAreaCache || []).map(a =>
            `<option value="${escapeHtml(a.id)}" ${a.id === defaultVal ? 'selected' : ''}>${escapeHtml(a.label)}</option>`
        ).join('');
        field = `<select id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="area" class="${baseCls}"><option value="">${escapeHtml(t('blueprints.choose'))}</option>${opts}</select>`;
    } else if (spec.type === 'select') {
        const opts = (spec.choices || []).map(c =>
            `<option value="${escapeHtml(c)}" ${c === defaultVal ? 'selected' : ''}>${escapeHtml(c)}</option>`
        ).join('');
        field = `<select id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="select" class="${baseCls}">${opts}</select>`;
    } else if (spec.type === 'boolean') {
        field = `<label class="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="boolean" ${defaultVal === 'true' || defaultVal === '1' ? 'checked' : ''} class="w-4 h-4">${escapeHtml(t('common.enable'))}</label>`;
    } else if (spec.type === 'number' || spec.type === 'duration') {
        field = `<input type="number" id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="${spec.type}" value="${escapeHtml(defaultVal)}" class="${baseCls}" />`;
        if (spec.type === 'duration') field = field.replace('class="', 'placeholder="seconds" class="');
    } else {
        field = `<input type="text" id="${id}" data-bp-input="${escapeHtml(spec.id)}" data-bp-type="string" value="${escapeHtml(defaultVal)}" class="${baseCls}" />`;
    }
    return `<div>${labelHtml}${field}</div>`;
}

function _collectBlueprintInputs() {
    const out = {};
    document.querySelectorAll('#blueprint-picker-form-inputs [data-bp-input]').forEach(el => {
        const key = el.dataset.bpInput;
        const type = el.dataset.bpType;
        let val;
        if (type === 'boolean') val = el.checked;
        else val = el.value;
        out[key] = val;
    });
    return out;
}

export async function instantiateCurrentBlueprint() {
    if (!_activeBlueprint) return;
    const errEl = document.getElementById('blueprint-picker-form-error');
    errEl?.classList.add('hidden');
    const inputs = _collectBlueprintInputs();
    try {
        const res = await apiCall(`/api/automations/blueprints/${encodeURIComponent(_activeBlueprint.id)}/instantiate`, {
            method: 'POST',
            body: { inputs },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        showToast(t('blueprints.automation_created', { id: data.item?.id || '' }), 'success');
        closeBlueprintPicker();
        await loadAutomations();
        if (data.item?.id) {
            await openAutomationEditor(data.item.id);
        }
    } catch (e) {
        if (errEl) {
            errEl.classList.remove('hidden');
            errEl.textContent = e.message || t('blueprints.instantiate_error');
        }
    }
}

export async function deleteCurrentBlueprint() {
    if (!_activeBlueprint) return;
    const ok = await showConfirm(t('blueprints.delete_confirm', { title: _activeBlueprint.title }));
    if (!ok) return;
    try {
        const res = await apiCall(`/api/automations/blueprints/${encodeURIComponent(_activeBlueprint.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast(t('hy.blueprint_deleted'), 'success');
        backToBlueprintList();
        await loadBlueprints();
    } catch (e) {
        showToast(t('hy.delete_failed'), 'error');
    }
}

export async function refreshAutomationEntityOptions() {
    const selects = document.querySelectorAll('[data-automation-entity-select]');
    if (!selects.length) return;
    try {
        const res = await apiCall('/api/integrations/all-entities');
        const data = await res.json();
        const entities = Array.isArray(data.entities) ? data.entities : [];
        selects.forEach(sel => {
            const current = sel.value;
            sel.innerHTML = `<option value="">${t('automations.entity_placeholder')}</option>` +
                entities.map(e => `<option value="${escapeHtml(e.entity_id)}"${e.entity_id === current ? ' selected' : ''}>${escapeHtml(e.entity_id)}${e.friendly_name ? ' — ' + escapeHtml(e.friendly_name) : ''}</option>`).join('');
        });
    } catch (_) {}
}

export function addAutomationBuilderTrigger(platform) {
    _automationBuilderTriggers.push(_automationBuilderTriggerTemplate(platform || 'time'));
    _automationRenderBuilderTriggers();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderTrigger(idx) {
    _automationBuilderTriggers.splice(Number(idx), 1);
    if (!_automationBuilderTriggers.length) _automationBuilderTriggers.push(_automationBuilderTriggerTemplate('time'));
    _automationRenderBuilderTriggers();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function addAutomationBuilderCondition(kind) {
    _automationBuilderConditions.push(_automationBuilderConditionTemplate(kind || 'time_range'));
    _automationRenderBuilderConditions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderCondition(idx) {
    _automationBuilderConditions.splice(Number(idx), 1);
    _automationRenderBuilderConditions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function addAutomationBuilderAction(kind) {
    _automationBuilderActions.push(_automationBuilderActionTemplate(kind || 'notify'));
    _automationRenderBuilderActions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderAction(idx) {
    _automationBuilderActions.splice(Number(idx), 1);
    if (!_automationBuilderActions.length) _automationBuilderActions.push(_automationBuilderActionTemplate('notify'));
    _automationRenderBuilderActions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function updateAutomationStructuredServiceData(index) {
    _automationReadBuilderActionsFromDom();
    syncAutomationYamlFromBuilder({ silent: true });
}
