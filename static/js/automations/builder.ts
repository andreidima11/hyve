import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor } from '../utils.js';
import { getIntegrationEntities } from '../features_smarthome.js';
import { initGenericCustomSelects, upgradeNativeSelects } from '../features_custom_selects.js';
import type {
    AutomationBuilderRow,
    AutomationBuilderState,
    AutomationCapabilityEntity,
    AutomationEditorMode,
    SyncAutomationOptions,
} from '../types/features_automations.js';
import type { HyveEntity } from '../types/entity.js';
import { autoEl, inputVal } from './utils.js';
import {
    formatAutomationHistoryAt,
    automationRunStatusBadge,
} from './format.js';
import {
    automationState,
    automationIdString,
    editorAutomationId,
    AUTO_HISTORY_PAGE_SIZE,
} from './state.js';
import type { AutomationHistoryItem } from '../types/features_automations.js';

interface AutoAcInput extends HTMLInputElement { _acSelecting?: boolean; _acBound?: boolean }

async function _automationLoadCapabilities({ force = false }: { force?: boolean } = {}) {
    if (!force && automationState.capabilities) return automationState.capabilities;
    if (!force && automationState.capabilitiesPromise) return automationState.capabilitiesPromise;
    automationState.capabilitiesPromise = (async () => {
        try {
            const res = await apiCall('/api/automations/capabilities');
            const data = await res.json();
            automationState.capabilities = {
                schema: data?.schema || null,
                entities: Array.isArray(data?.entities) ? data.entities : [],
                areas: Array.isArray(data?.areas) ? data.areas : [],
            };
        } catch (_) {
            automationState.capabilities = { schema: null, entities: [], areas: [] };
        } finally {
            automationState.capabilitiesPromise = null;
        }
        return automationState.capabilities;
    })();
    return automationState.capabilitiesPromise;
}

function _automationCapabilityEntities(): AutomationCapabilityEntity[] {
    return Array.isArray(automationState.capabilities?.entities) ? automationState.capabilities.entities : [];
}

const _AUTOMATION_SERVICE_PRESETS: Record<string, string[]> = {
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

const _AUTOMATION_SERVICE_DATA_FIELDS: Record<string, Array<Record<string, unknown>>> = {
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

function _automationDefaultBuilderState(): AutomationBuilderState {
    return {
        id: 'new_automation',
        title: 'New automation',
        description: '',
        enabled: true,
        mode: 'single',
    };
}

function _automationSetBuilderState(state: Partial<AutomationBuilderState> | null | undefined) {
    const next = { ..._automationDefaultBuilderState(), ...(state || {}) };
    const fields = {
        id: 'automation-builder-id',
        title: 'automation-builder-title',
        description: 'automation-builder-description',
        mode: 'automation-builder-mode',
    };
    Object.entries(fields).forEach(([key, elementId]) => {
        const element = autoEl(elementId);
        if (element) element.value = String((next as Record<string, unknown>)[key] ?? '');
    });
    const enabledEl = autoEl('automation-builder-enabled');
    if (enabledEl) enabledEl.checked = !!next.enabled;
    initGenericCustomSelects(document.getElementById('automation-editor-modal') || document);
}

function _automationGetBuilderState(): AutomationBuilderState {
    return {
        id: autoEl('automation-builder-id')?.value?.trim() || 'new_automation',
        title: autoEl('automation-builder-title')?.value?.trim() || 'New automation',
        description: autoEl('automation-builder-description')?.value?.trim() || '',
        enabled: !!autoEl('automation-builder-enabled')?.checked,
        mode: autoEl('automation-builder-mode')?.value || 'single',
    };
}

function _automationYamlScalar(value: unknown) {
    const text = String(value ?? '');
    return JSON.stringify(text);
}

function _automationYamlBoolean(value: unknown) {
    return value ? 'true' : 'false';
}

function _automationSortHaEntities(items: Array<AutomationCapabilityEntity | HyveEntity | Record<string, unknown>> | null | undefined) {
    return [...(items || [])].sort((left, right) => {
        const leftName = String(left?.name || left?.entity_id || '').toLowerCase();
        const rightName = String(right?.name || right?.entity_id || '').toLowerCase();
        return leftName.localeCompare(rightName) || String(left?.entity_id || '').localeCompare(String(right?.entity_id || ''));
    });
}

function _automationInferServiceDomain(target: HTMLElement | null | undefined) {
    const current = inputVal(target ?? null);
    if (current.includes('.')) return current.split('.')[0];
    const card = target?.closest('.automation-builder-action-card');
    const entityInput = card?.querySelector('[data-action-field="entity_id"]');
    const entityId = inputVal(entityInput);
    if (entityId.includes('.')) return entityId.split('.')[0];
    return '';
}

/* Infer the desired entity domain for the entity picker from sibling fields
   in the same builder card. For service actions: derive from the `service`
   field (e.g. `switch.turn_on` → `switch`). For state triggers: an explicit
   `data-entity-domain` attribute can be set on the input. */
function _automationInferEntityDomain(target: HTMLElement | null | undefined) {
    const explicit = String(target?.getAttribute('data-entity-domain') || '').trim();
    if (explicit) return explicit;
    const card = target?.closest('.automation-builder-action-card');
    if (!card) return '';
    const serviceInput = card.querySelector('[data-action-field="service"]');
    const service = inputVal(serviceInput);
    if (service.includes('.')) return service.split('.')[0];
    return '';
}

function _automationServicePresetList(domain: string = '') {
    const normalized = String(domain || '').trim().toLowerCase();
    if (normalized && _AUTOMATION_SERVICE_PRESETS[normalized]) {
        return [..._AUTOMATION_SERVICE_PRESETS[normalized]];
    }
    const flat = Object.values(_AUTOMATION_SERVICE_PRESETS).flat();
    return [...new Set(flat)].sort();
}

function _automationRenderHaEntityOptions(items: AutomationCapabilityEntity[]) {
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
let _activeAutocomplete: HTMLElement | null = null;   // current open dropdown element
let _acHighlightIndex = -1;       // keyboard-highlighted item index

function _acClose(): void {
    if (_activeAutocomplete) {
        _activeAutocomplete.classList.remove('open');
        _activeAutocomplete = null;
    }
    _acHighlightIndex = -1;
}

function _acEntityItems(search: string, domain: string) {
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

function _acServiceItems(search: string, domain: string) {
    const items = _automationServicePresetList(domain);
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(s => s.toLowerCase().includes(q));
}

function _acRenderEntity(dropdown: HTMLElement, search: string, domain: string) {
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

function _acRenderService(dropdown: HTMLElement, search: string, domain: string) {
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

function _acOpen(input: AutoAcInput, type: string, domain: string) {
    const wrapper = input.closest('.automation-inline-ac');
    if (!wrapper) return;
    const dropdown = wrapper.querySelector('.automation-inline-ac-dropdown') as HTMLElement | null;
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

function _acSelect(input: AutoAcInput, value: string, type: string) {
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

function _acKeydown(e: KeyboardEvent, input: AutoAcInput, type: string, domain: string) {
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
            _acSelect(input, items[_acHighlightIndex].getAttribute('data-ac-value') || '', type);
        }
    } else if (e.key === 'Escape') {
        e.preventDefault();
        _acClose();
        input.blur();
    }
}

function _acUpdateHighlight(items: NodeListOf<Element> | Element[]) {
    items.forEach((el, i) => {
        el.classList.toggle('ac-highlighted', i === _acHighlightIndex);
    });
    if (_acHighlightIndex >= 0 && items[_acHighlightIndex]) {
        items[_acHighlightIndex].scrollIntoView({ block: 'nearest' });
    }
}

// Global click handler to close autocomplete when clicking outside
document.addEventListener('mousedown', (e) => {
    if (_activeAutocomplete && !(e.target as HTMLElement | null)?.closest('.automation-inline-ac')) {
        _acClose();
    }
});

// Delegated click handler for autocomplete items
document.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement | null)?.closest('.ac-item[data-ac-value]');
    if (!item) return;
    const dropdown = item.closest('.automation-inline-ac-dropdown');
    const wrapper = dropdown?.closest('.automation-inline-ac');
    const input = wrapper?.querySelector('input');
    if (!input) return;
    const type = input.hasAttribute('data-automation-entity-input') ? 'entity' : 'service';
    _acSelect(input as AutoAcInput, item.getAttribute('data-ac-value') ?? '', type);
});

/* Helper: builds inline-ac wrapper HTML around an entity input */
function _acEntityInputHtml(attrs: string) {
    return `<div class="automation-inline-ac">
        <input type="text" ${attrs}
            class="w-full"
            autocomplete="off">
        <div class="automation-inline-ac-dropdown"></div>
    </div>`;
}

/* Helper: builds inline-ac wrapper HTML around a service input */
function _acServiceInputHtml(attrs: string) {
    return `<div class="automation-inline-ac">
        <input type="text" ${attrs}
            class="w-full"
            autocomplete="off">
        <div class="automation-inline-ac-dropdown"></div>
    </div>`;
}

/* Attach inline-ac event listeners to dynamically rendered inputs */
function _acBindInputs(host: HTMLElement | null) {
    if (!host) return;
    host.querySelectorAll('[data-automation-entity-input]').forEach((node) => {
        const input = node as AutoAcInput;
        if (input._acBound) return;
        input._acBound = true;
        const getEntityDomain = () => _automationInferEntityDomain(input);
        input.addEventListener('focus', () => { if (!input._acSelecting) _acOpen(input, 'entity', getEntityDomain()); });
        input.addEventListener('input', () => { if (!input._acSelecting) { _acHighlightIndex = -1; _acOpen(input, 'entity', getEntityDomain()); } });
        input.addEventListener('keydown', (e) => _acKeydown(e as KeyboardEvent, input, 'entity', getEntityDomain()));
    });
    host.querySelectorAll('[data-automation-service-input]').forEach((node) => {
        const input = node as AutoAcInput;
        if (input._acBound) return;
        input._acBound = true;
        const getDomain = () => _automationInferServiceDomain(input);
        input.addEventListener('focus', () => { if (!input._acSelecting) _acOpen(input, 'service', getDomain()); });
        input.addEventListener('input', () => { if (!input._acSelecting) { _acHighlightIndex = -1; _acOpen(input, 'service', getDomain()); } });
        input.addEventListener('keydown', (e) => _acKeydown(e as KeyboardEvent, input, 'service', getDomain()));
    });
}

/* Upgrade native builder <select>s into the app's custom dropdown so they match
   the rest of the UI instead of rendering as raw OS selects. Delegates to the
   global upgrader; the native select stays in the DOM (hidden) so value/onchange
   and DOM readers keep working. */
function _upgradeAutoBuilderSelects(host: ParentNode | null) {
    if (!host) return;
    upgradeNativeSelects(host);
}

function _automationBuilderActionTemplate(kind: string = 'notify') {
    if (kind === 'service') {
        return { kind: 'service', service: 'light.turn_on', entity_id: '', data: '{}' };
    }
    if (kind === 'skill') {
        return { kind: 'skill', name: '', input: '{}' };
    }
    return { kind: 'notify', text: 'Automation created.' };
}

function _automationParseJsonObject(text: string) {
    try {
        const value = text ? JSON.parse(text) : {};
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

function _automationServiceDataFieldDefs(serviceName: string) {
    return _AUTOMATION_SERVICE_DATA_FIELDS[String(serviceName || '').trim()] || [];
}

function _automationRenderServiceStructuredFields(action: AutomationBuilderRow, index: number) {
    const fields = _automationServiceDataFieldDefs(String(action?.service || ''));
    if (!fields.length) return '';
    const data = _automationParseJsonObject(String(action?.data || '{}')) as Record<string, unknown>;
    const body = fields.map((field) => {
        const label = t(String(field.labelKey || '')) || String(field.fallback || '');
        const key = String(field.key || '');
        const rawValue = data[key];
        if (field.type === 'select') {
            const options = Array.isArray(field.options) ? field.options as string[] : [];
            return `
                <div class="space-y-1">
                    <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                    <select data-service-data-field="${key}" data-action-index="${index}" data-memory-input="updateAutomationServiceData" data-memory-index="${index}" class="auto-builder-select w-full">
                        <option value=""></option>
                        ${options.map((option: string) => `<option value="${escapeHtml(option)}" ${rawValue === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
                    </select>
                </div>`;
        }
        return `
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                <input type="number" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} ${field.step != null ? `step="${field.step}"` : ''} data-service-data-field="${field.key}" data-action-index="${index}" value="${rawValue ?? ''}" data-memory-input="updateAutomationServiceData" data-memory-index="${index}" class="w-full">
            </div>`;
    }).join('');
    return `
        <div class="space-y-3 sm:col-span-2 rounded-xl border border-theme-subtle bg-slate-950/50 p-3">
            <div>
                <div class="text-[10px] font-bold uppercase tracking-widest text-slate-400">${t('automations.service_data_assist_title')}</div>
                <p class="text-[10px] text-slate-500 mt-1">${t('automations.service_data_assist_hint')}</p>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${body}</div>
        </div>`;
}

function _automationBuilderTriggerTemplate(platform: string = 'time') {
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

function _automationBuilderConditionTemplate(kind: string = 'time_window') {
    return { kind: 'time_window', after: '', before: '' };
}

function _automationNormalizeTrigger(trigger: AutomationBuilderRow) {
    const platform = String(trigger?.platform || 'time');
    return { ..._automationBuilderTriggerTemplate(platform), ...trigger, platform };
}

function _automationStateOptions(currentValue: string, includeEmpty = false) {
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

function _automationNormalizeCondition(condition: AutomationBuilderRow) {
    const kind = condition?.kind || 'time_window';
    return { ..._automationBuilderConditionTemplate(String(kind)), ...condition, kind: String(kind) };
}

function _automationRenderBuilderTriggers(): void {
    const host = document.getElementById('automation-builder-triggers');
    if (!host) return;
    host.innerHTML = automationState.builderTriggers.map((trigger, index) => {
        const platform = trigger?.platform || 'time';
        return `
            <div class="hyd-app-card hyd-app-card--nested space-y-3 automation-builder-action-card" data-action-card-index="${index}">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${t('automations.builder_trigger_item')}</div>
                    <button type="button" data-memory-action="removeAutomationBuilderTrigger" data-memory-index="${index}" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete')}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_platform')}</label>
                        <select data-trigger-field="platform" data-trigger-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="triggers" class="auto-builder-select w-full">
                            <option value="time" ${platform === 'time' ? 'selected' : ''}>time</option>
                            <option value="datetime" ${platform === 'datetime' ? 'selected' : ''}>datetime</option>
                            <option value="interval" ${platform === 'interval' ? 'selected' : ''}>interval</option>
                            <option value="state" ${platform === 'state' ? 'selected' : ''}>state</option>
                            <option value="numeric_state" ${platform === 'numeric_state' ? 'selected' : ''}>numeric_state</option>
                        </select>
                    </div>
                    <div data-trigger-kind-wrap="time" class="space-y-1 ${platform === 'time' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_at')}</label>
                        <input type="text" data-trigger-field="at" data-trigger-index="${index}" value="${escapeHtml(trigger?.at || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="time" class="space-y-1 sm:col-span-2 ${platform === 'time' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_weekdays')}</label>
                        <input type="text" data-trigger-field="weekdays" data-trigger-index="${index}" value="${escapeHtml(trigger?.weekdays || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="datetime" class="space-y-1 sm:col-span-2 ${platform === 'datetime' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_datetime')}</label>
                        <input type="text" data-trigger-field="at" data-trigger-index="${index}" value="${escapeHtml(trigger?.at || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="interval" class="space-y-1 ${platform === 'interval' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_every_minutes')}</label>
                        <input type="number" min="1" max="10080" data-trigger-field="every_minutes" data-trigger-index="${index}" value="${escapeHtml(trigger?.every_minutes || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="interval" class="space-y-1 ${platform === 'interval' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_start_at')}</label>
                        <input type="text" data-trigger-field="start_at" data-trigger-index="${index}" value="${escapeHtml(trigger?.start_at || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="state" class="space-y-1 sm:col-span-2 ${platform === 'state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_entity')}</label>
                        <div class="automation-inline-ac">
                            <input type="text" data-automation-entity-input="1" data-trigger-field="entity_id" data-trigger-index="${index}" value="${escapeHtml(trigger?.entity_id || '')}" data-memory-input="syncAutomationYamlFromBuilder" autocomplete="off" placeholder="${t('automations.entity_search_placeholder')}" class="w-full">
                            <div class="automation-inline-ac-dropdown"></div>
                        </div>
                    </div>
                    <div data-trigger-kind-wrap="state" class="space-y-1 ${platform === 'state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_from')}</label>
                        <input type="text" data-trigger-field="from" data-trigger-index="${index}" value="${escapeHtml(trigger?.from || '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. off" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="state" class="space-y-1 ${platform === 'state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_to')}</label>
                        <input type="text" data-trigger-field="to" data-trigger-index="${index}" value="${escapeHtml(trigger?.to || '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. on" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 sm:col-span-2 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_entity')}</label>
                        <div class="automation-inline-ac">
                            <input type="text" data-automation-entity-input="1" data-trigger-field="entity_id" data-trigger-index="${index}" value="${escapeHtml(trigger?.entity_id || '')}" data-memory-input="syncAutomationYamlFromBuilder" autocomplete="off" placeholder="${t('automations.entity_search_placeholder')}" class="w-full">
                            <div class="automation-inline-ac-dropdown"></div>
                        </div>
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_above')}</label>
                        <input type="text" data-trigger-field="above" data-trigger-index="${index}" value="${escapeHtml(trigger?.above != null ? trigger.above : '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. 25" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_below')}</label>
                        <input type="text" data-trigger-field="below" data-trigger-index="${index}" value="${escapeHtml(trigger?.below != null ? trigger.below : '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. 10" class="w-full">
                    </div>
                    <div data-trigger-kind-wrap="numeric_state" class="space-y-1 sm:col-span-2 ${platform === 'numeric_state' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_trigger_attribute')}</label>
                        <input type="text" data-trigger-field="attribute" data-trigger-index="${index}" value="${escapeHtml(trigger?.attribute || '')}" data-memory-input="syncAutomationYamlFromBuilder" placeholder="e.g. temperature" class="w-full">
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
    _upgradeAutoBuilderSelects(host);
}

function _automationRenderBuilderConditions(): void {
    const host = document.getElementById('automation-builder-conditions');
    if (!host) return;
    if (!automationState.builderConditions.length) {
        host.innerHTML = `<div class="rounded-xl border border-dashed border-theme-subtle bg-white/[0.015] p-4 text-[11px] text-slate-500">${t('automations.builder_condition_empty')}</div>`;
        return;
    }
    host.innerHTML = automationState.builderConditions.map((condition, index) => {
        const kind = condition?.kind || 'time_window';
        return `
            <div class="hyd-app-card hyd-app-card--nested space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${t('automations.builder_condition_item')}</div>
                    <button type="button" data-memory-action="removeAutomationBuilderCondition" data-memory-index="${index}" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete')}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div class="space-y-1 sm:col-span-2">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_kind')}</label>
                        <select data-condition-field="kind" data-condition-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="conditions" class="auto-builder-select w-full">
                            <option value="time_window" ${kind === 'time_window' ? 'selected' : ''}>time_window</option>
                        </select>
                    </div>
                    <div data-condition-kind-wrap="time_window" class="space-y-1 ${kind === 'time_window' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_after')}</label>
                        <input type="text" data-condition-field="after" data-condition-index="${index}" value="${escapeHtml(condition?.after || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                    <div data-condition-kind-wrap="time_window" class="space-y-1 ${kind === 'time_window' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_condition_before')}</label>
                        <input type="text" data-condition-field="before" data-condition-index="${index}" value="${escapeHtml(condition?.before || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
    _upgradeAutoBuilderSelects(host);
}

function _automationRenderBuilderActions(): void {
    const host = document.getElementById('automation-builder-actions');
    if (!host) return;
    host.innerHTML = automationState.builderActions.map((action, index) => {
        const type = String(action?.kind || 'notify');
        const labelMap: Record<string, string> = {
            notify: t('automations.builder_action_notify'),
            service: t('automations.builder_action_service'),
            skill: t('automations.builder_action_skill'),
        };
        return `
            <div class="hyd-app-card hyd-app-card--nested space-y-3 automation-builder-action-card" data-action-card-index="${index}">
                <div class="flex items-center justify-between gap-3">
                    <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${labelMap[type] || type}</div>
                    <button type="button" data-memory-action="removeAutomationBuilderAction" data-memory-index="${index}" class="px-2 py-1 rounded-lg text-[11px] font-bold text-red-300 hover:bg-red-500/10">${t('common.delete')}</button>
                </div>
                <div class="space-y-3">
                    <div class="space-y-1">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_action_type')}</label>
                        <select data-action-field="kind" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="actions" class="auto-builder-select w-full">
                            <option value="notify" ${type === 'notify' ? 'selected' : ''}>${t('automations.builder_action_notify')}</option>
                            <option value="service" ${type === 'service' ? 'selected' : ''}>${t('automations.builder_action_service')}</option>
                            <option value="skill" ${type === 'skill' ? 'selected' : ''}>${t('automations.builder_action_skill')}</option>
                        </select>
                    </div>
                    <div data-action-kind-wrap="notify" class="space-y-1 ${type === 'notify' ? '' : 'hidden'}">
                        <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_notify_text')}</label>
                        <textarea data-action-field="text" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full min-h-[88px] resize-y">${escapeHtml(action?.text || '')}</textarea>
                    </div>
                    <div data-action-kind-wrap="service" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${type === 'service' ? '' : 'hidden'}">
                        <div class="space-y-1 sm:col-span-2">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_name')}</label>
                            <div class="automation-inline-ac">
                                <input type="text" data-automation-service-input="1" data-action-field="service" data-action-index="${index}" value="${escapeHtml(action?.service || '')}" autocomplete="off" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="actions" class="w-full" placeholder="${t('automations.service_search_placeholder')}">
                                <div class="automation-inline-ac-dropdown"></div>
                            </div>
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_entity_id')}</label>
                            <div class="automation-inline-ac">
                                <input type="text" data-automation-entity-input="1" data-action-field="entity_id" data-action-index="${index}" value="${escapeHtml(action?.entity_id || '')}" autocomplete="off" data-memory-input="syncAutomationYamlFromBuilder" class="w-full" placeholder="${t('automations.entity_search_placeholder')}">
                                <div class="automation-inline-ac-dropdown"></div>
                            </div>
                        </div>
                        ${_automationRenderServiceStructuredFields(action, index)}
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_service_data')}</label>
                            <textarea data-action-field="data" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" data-memory-rerender="actions" class="w-full min-h-[88px] mono resize-y">${escapeHtml(action?.data || '{}')}</textarea>
                        </div>
                    </div>
                    <div data-action-kind-wrap="skill" class="grid grid-cols-1 sm:grid-cols-2 gap-3 ${type === 'skill' ? '' : 'hidden'}">
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_skill_name')}</label>
                            <input type="text" data-action-field="name" data-action-index="${index}" value="${escapeHtml(action?.name || '')}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full">
                        </div>
                        <div class="space-y-1">
                            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${t('automations.builder_skill_input')}</label>
                            <textarea data-action-field="input" data-action-index="${index}" data-memory-input="syncAutomationYamlFromBuilder" class="w-full min-h-[88px] mono resize-y">${escapeHtml(action?.input || '{}')}</textarea>
                        </div>
                    </div>
                </div>
            </div>`;
    }).join('');
    _acBindInputs(host);
    _upgradeAutoBuilderSelects(host);
}

function _automationReadBuilderActionsFromDom(): AutomationBuilderRow[] {
    const next = automationState.builderActions.map(action => ({ ...action }));
    document.querySelectorAll('[data-action-index][data-action-field]').forEach(element => {
        const index = Number(element.getAttribute('data-action-index'));
        const field = element.getAttribute('data-action-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderActionTemplate();
        next[index][field] = inputVal(element);
    });
    automationState.builderActions = next.map(action => {
        const kind = String(action?.kind || 'notify');
        return { ..._automationBuilderActionTemplate(String(kind)), ...action, kind: String(kind) };
    });
    return automationState.builderActions;
}

function _automationReadBuilderTriggersFromDom(): AutomationBuilderRow[] {
    const next = automationState.builderTriggers.map(trigger => ({ ...trigger }));
    const elements = Array.from(document.querySelectorAll('[data-trigger-index][data-trigger-field]'));

    elements.forEach(element => {
        const index = Number(element.getAttribute('data-trigger-index'));
        const field = element.getAttribute('data-trigger-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderTriggerTemplate();
        if (field === 'platform') next[index][field] = inputVal(element);
    });

    elements.forEach(element => {
        const index = Number(element.getAttribute('data-trigger-index'));
        const field = element.getAttribute('data-trigger-field');
        if (!Number.isFinite(index) || !field || field === 'platform') return;
        if (!next[index]) next[index] = _automationBuilderTriggerTemplate();
        const platform = String(next[index]?.platform || 'time');
        const platformWrap = element.closest('[data-trigger-kind-wrap]');
        if (platformWrap && platformWrap.getAttribute('data-trigger-kind-wrap') !== platform) return;
        next[index][field] = inputVal(element);
    });
    automationState.builderTriggers = next.map(_automationNormalizeTrigger);
    return automationState.builderTriggers;
}

function _automationReadBuilderConditionsFromDom(): AutomationBuilderRow[] {
    const next = automationState.builderConditions.map(condition => ({ ...condition }));
    document.querySelectorAll('[data-condition-index][data-condition-field]').forEach(element => {
        const index = Number(element.getAttribute('data-condition-index'));
        const field = element.getAttribute('data-condition-field');
        if (!Number.isFinite(index) || !field) return;
        if (!next[index]) next[index] = _automationBuilderConditionTemplate();
        next[index][field] = inputVal(element);
    });
    automationState.builderConditions = next.map(_automationNormalizeCondition);
    return automationState.builderConditions;
}

function _automationBuilderWeekdaysList(raw: unknown) {
    return String(raw || '')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function _automationBuildYamlFromBuilder(): string {
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
    (automationState.builderTriggers.length ? automationState.builderTriggers : [_automationBuilderTriggerTemplate('time')]).forEach(trigger => {
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
    if (automationState.builderConditions.length) {
        lines.push('condition:');
        automationState.builderConditions.forEach(condition => {
            if (condition.kind === 'time_window') {
                lines.push('  - kind: time_window');
                if (condition.after) lines.push(`    after: ${_automationYamlScalar(condition.after)}`);
                if (condition.before) lines.push(`    before: ${_automationYamlScalar(condition.before)}`);
            }
        });
    }
    lines.push('action:');
    (automationState.builderActions.length ? automationState.builderActions : [_automationBuilderActionTemplate('notify')]).forEach(action => {
        const kind = String(action?.kind || 'notify');
        if (kind === 'service') {
            lines.push(`  - service: ${action.service || ''}`);
            if (action.entity_id) {
                lines.push('    target:');
                lines.push(`      entity_id: ${_automationYamlScalar(action.entity_id)}`);
            } else {
                lines.push('    target: {}');
            }
            let parsedData = {};
            try { parsedData = action.data ? JSON.parse(String(action.data)) : {}; } catch (_) { parsedData = {}; }
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
            try { parsedInput = action.input ? JSON.parse(String(action.input)) : {}; } catch (_) { parsedInput = {}; }
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

function _automationSetBuilderWarning(message: string = '') {
    const element = document.getElementById('automation-builder-warning');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('hidden', !message);
}

async function _automationHydrateBuilderFromNormalized(normalized: Record<string, unknown>, warningMessage = '') {
    const triggers = Array.isArray(normalized?.trigger) ? normalized.trigger : [];
    const conditions = Array.isArray(normalized?.condition) ? normalized.condition : [];
    const actions = Array.isArray(normalized?.action) ? normalized.action : [];
    if (!triggers.length || !actions.length) {
        _automationSetBuilderWarning(t('automations.builder_sync_error'));
        return false;
    }
    const nextState: Partial<AutomationBuilderState> = {
        id: String(normalized.id || 'new_automation'),
        title: String(normalized.title || 'New automation'),
        description: String(normalized.description || ''),
        enabled: normalized.enabled !== false,
        mode: String(normalized.mode || 'single'),
    };
    automationState.builderTriggers = triggers.map(trigger => _automationNormalizeTrigger({
        ...trigger,
        weekdays: Array.isArray(trigger?.weekdays) ? trigger.weekdays.join(', ') : (trigger?.weekdays || ''),
        every_minutes: trigger?.every_minutes != null ? String(trigger.every_minutes) : '60',
        from: trigger?.from != null ? String(trigger.from) : '',
        to: trigger?.to != null ? String(trigger.to) : '',
        above: trigger?.above != null ? String(trigger.above) : '',
        below: trigger?.below != null ? String(trigger.below) : '',
    }));
    automationState.builderConditions = conditions.map(condition => _automationNormalizeCondition(condition));
    automationState.builderActions = actions.map(action => {
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

function _automationResetBuilder(): void {
    automationState.builderTriggers = [_automationBuilderTriggerTemplate('time')];
    automationState.builderConditions = [];
    automationState.builderActions = [_automationBuilderActionTemplate('notify')];
    _acClose();
    _automationSetBuilderState(_automationDefaultBuilderState());
    _automationRenderBuilderTriggers();
    _automationRenderBuilderConditions();
    _automationRenderBuilderActions();
    _automationSetBuilderWarning('');
}

function _automationSetEditorMode(mode: AutomationEditorMode) {
    automationState.editorMode = ['builder', 'yaml', 'history'].includes(mode) ? mode : 'builder';
    document.querySelectorAll('[data-automation-editor-mode]').forEach(element => {
        const active = element.getAttribute('data-automation-editor-mode') === automationState.editorMode;
        element.classList.toggle('is-active', active);
        element.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-automation-editor-panel]').forEach(element => {
        element.classList.toggle('hidden', element.getAttribute('data-automation-editor-panel') !== automationState.editorMode);
    });
}


function _buildAutomationTemplate(): string {
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

export async function loadAutomationEditorHistory(targetId?: string | null) {
    const listEl = document.getElementById('automation-editor-history-list');
    const emptyEl = document.getElementById('automation-editor-history-empty');
    if (!listEl || !emptyEl) return;
    const id = automationIdString(targetId) || editorAutomationId();
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
        automationState.historyItems = Array.isArray(data.items) ? data.items : [];
        automationState.historyPage = 1;
        if (!automationState.historyItems.length) {
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

function _renderAutoHistoryPage(): void {
    const listEl = document.getElementById('automation-editor-history-list');
    if (!listEl) return;
    const total = automationState.historyItems.length;
    const totalPages = Math.max(1, Math.ceil(total / AUTO_HISTORY_PAGE_SIZE));
    if (automationState.historyPage > totalPages) automationState.historyPage = totalPages;
    if (automationState.historyPage < 1) automationState.historyPage = 1;
    const start = (automationState.historyPage - 1) * AUTO_HISTORY_PAGE_SIZE;
    const slice = automationState.historyItems.slice(start, start + AUTO_HISTORY_PAGE_SIZE);
    const from = start + 1;
    const to = Math.min(start + slice.length, total);

    const rows = slice.map((item, i) => {
        const idx = start + i;
        const details = item?.details && typeof item.details === 'object' ? item.details as Record<string, unknown> : null;
        const trace = details && details.trace && typeof details.trace === 'object' ? details.trace as Record<string, unknown> : null;
        const runId = String((details && details.run_id) || (trace && trace.run_id) || '');
        const runIdShort = runId ? String(runId).slice(0, 8) : '';
        const traceHtml = trace ? _automationRenderTraceBlock(trace, `auto-trace-${idx}`) : '';
        const runIdBadge = runIdShort
            ? `<span class="text-[10px] font-mono text-slate-500" title="${escapeHtml(runId)}">${escapeHtml(t('automations.trace_run_id'))} ${escapeHtml(runIdShort)}</span>`
            : '';
        return `
            <div class="hyd-app-card hyd-app-card--nested space-y-2">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                        <div class="text-[11px] text-slate-300">${escapeHtml(formatAutomationHistoryAt(item.started_at))}</div>
                        ${runIdBadge}
                    </div>
                    ${automationRunStatusBadge(String(item.status || ''))}
                </div>
                <div class="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
                    <span><span class="text-slate-400">${t('automations.history_trigger')}:</span> ${escapeHtml(item.trigger_source || '—')}</span>
                    <span><span class="text-slate-400">${t('automations.history_finished')}:</span> ${escapeHtml(formatAutomationHistoryAt(item.finished_at))}</span>
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
                <button type="button" class="hy-pager-btn" data-auto-hist-page="${automationState.historyPage - 1}" ${automationState.historyPage <= 1 ? 'disabled' : ''} aria-label="${escapeHtml(t('common.pager_prev'))}"><i class="fas fa-chevron-left"></i></button>
                <span class="hy-page-index">${automationState.historyPage} / ${totalPages}</span>
                <button type="button" class="hy-pager-btn" data-auto-hist-page="${automationState.historyPage + 1}" ${automationState.historyPage >= totalPages ? 'disabled' : ''} aria-label="${escapeHtml(t('common.pager_next'))}"><i class="fas fa-chevron-right"></i></button>
            </div>
        </div>` : '';

    listEl.innerHTML = rows + pager;
    listEl.querySelectorAll('[data-auto-hist-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            automationState.historyPage = Number((btn as HTMLElement).dataset.autoHistPage) || 1;
            _renderAutoHistoryPage();
        });
    });
}

function _automationRenderTraceBlock(trace: unknown, id: string) {
    const tr = trace as Record<string, unknown>;
    const steps = Array.isArray(tr?.steps) ? tr.steps as Record<string, unknown>[] : [];
    if (!steps.length) return '';
    const truncated = !!tr.truncated;
    const showLabel = escapeHtml(t('automations.trace_show'));
    const hideLabel = escapeHtml(t('automations.trace_hide'));
    const stepRows = steps.map((step: Record<string, unknown>) => {
        const status = String(step?.status || 'ok');
        const dot = status === 'error'
            ? 'bg-rose-400'
            : status === 'skipped' ? 'bg-amber-400' : 'bg-emerald-400';
        const offset = Number.isFinite(Number(step?.ts_offset_ms)) ? `+${Math.round(Number(step.ts_offset_ms))}ms` : '';
        const dur = Number.isFinite(Number(step?.duration_ms)) ? `${Math.round(Number(step.duration_ms))}ms` : '';
        const detail = step?.error || step?.message || '';
        const params = step?.params && typeof step.params === 'object' && !Array.isArray(step.params)
            ? Object.entries(step.params)
                .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
                .join(' ')
            : '';
        return `
            <div class="flex items-start gap-2 py-1 border-b border-theme-subtle last:border-b-0">
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
            <div class="mt-2 rounded-lg border border-theme-subtle bg-bg-main/40 p-2 space-y-0.5">
                ${stepRows}
                ${truncWarn}
            </div>
        </details>`;
}

export function switchAutomationEditorMode(mode: AutomationEditorMode) {
    _automationSetEditorMode(mode);
    if (mode === 'yaml') {
        refreshCodeEditor('automation-editor-yaml');
    } else if (mode === 'history' && editorAutomationId()) {
        loadAutomationEditorHistory();
    }
}

function _slugify(text: string) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 64);
}

export function autoSyncAutomationId(): void {
    if (automationState.idManuallyEdited) return;
    const titleEl = autoEl('automation-builder-title');
    const idEl = autoEl('automation-builder-id');
    if (!titleEl || !idEl) return;
    idEl.value = _slugify(titleEl.value);
}

export function markAutomationIdManual(): void {
    automationState.idManuallyEdited = true;
}

export async function syncAutomationYamlFromBuilder(options: SyncAutomationOptions = {}) {
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

export async function syncAutomationBuilderFromYaml(options: SyncAutomationOptions = {}) {
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



export function addAutomationBuilderTrigger(platform: string) {
    automationState.builderTriggers.push(_automationBuilderTriggerTemplate(platform || 'time'));
    _automationRenderBuilderTriggers();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderTrigger(idx: number) {
    automationState.builderTriggers.splice(Number(idx), 1);
    if (!automationState.builderTriggers.length) automationState.builderTriggers.push(_automationBuilderTriggerTemplate('time'));
    _automationRenderBuilderTriggers();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function addAutomationBuilderCondition(kind: string) {
    automationState.builderConditions.push(_automationBuilderConditionTemplate(kind || 'time_range'));
    _automationRenderBuilderConditions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderCondition(idx: number) {
    automationState.builderConditions.splice(Number(idx), 1);
    _automationRenderBuilderConditions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function addAutomationBuilderAction(kind: string) {
    automationState.builderActions.push(_automationBuilderActionTemplate(kind || 'notify'));
    _automationRenderBuilderActions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function removeAutomationBuilderAction(idx: number) {
    automationState.builderActions.splice(Number(idx), 1);
    if (!automationState.builderActions.length) automationState.builderActions.push(_automationBuilderActionTemplate('notify'));
    _automationRenderBuilderActions();
    syncAutomationYamlFromBuilder({ silent: true });
}

export function updateAutomationStructuredServiceData(index: number) {
    _automationReadBuilderActionsFromDom();
    syncAutomationYamlFromBuilder({ silent: true });
}

export {
    _automationLoadCapabilities,
    _automationResetBuilder,
    _automationSetEditorMode,
    _automationHydrateBuilderFromNormalized,
    _buildAutomationTemplate,
    _upgradeAutoBuilderSelects,
    _automationReadBuilderActionsFromDom,
    _automationRenderBuilderTriggers,
    _automationRenderBuilderConditions,
    _automationRenderBuilderActions,
    _automationBuilderTriggerTemplate,
    _automationBuilderConditionTemplate,
    _automationBuilderActionTemplate,
};
