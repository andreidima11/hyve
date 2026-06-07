import { apiCall, suppressLogout } from './api.js';
import { setLanguage, getLanguage, t, getAvailableLanguages, translateApiDetail, integrationApiMessage, loadComponentTranslations } from './lang/index.js';
import { escapeHtml, showToast, showConfirm, debounce, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, openSubPage, closeSubPage } from './utils.js';
import { renderEntityModal, getDomainIcon } from './entity_renderers.js';
import { ACTIVE_STATES, CONTROLLABLE, STATE_LABELS_RO } from './entity_constants.js';
import { showHubStartupLoadingAfterRestart } from './startup_status.js';
import { startCameraPreviewRefresh, stopCameraPreviewRefresh } from './camera_auth.js';
import { updateThinkingModeUi } from './thinking_mode.js';
import { getExtractionExamples, renderExtractionExamples } from './features_memory.js';
import { closeEntityDetailModal, filterHABySource } from './features_smarthome.js';
import { integrationSlugsMatch } from './integration_sources.js';

const _SEARCH_TENDENCY_HINTS = {
    1: 'Minimal — almost never searches. Only when you explicitly ask it to.',
    2: 'Conservative — prefers own knowledge, searches only for today\'s news/weather.',
    3: 'Balanced — searches for current events, uses knowledge for known facts.',
    4: 'Proactive — searches when not fully confident, verifies uncertain facts.',
    5: 'Aggressive — actively searches to provide the freshest information.',
};
function _updateSearchTendencyHint(val) {
    const hint = document.getElementById('search_tendency_hint');
    if (hint) hint.textContent = _SEARCH_TENDENCY_HINTS[val] || _SEARCH_TENDENCY_HINTS[3];
}

let _uiLanguageSaveSeq = 0;

function _refreshUiLanguageSelect(language) {
    const uiLangSelect = document.getElementById('ui_language');
    const dd = document.getElementById('ui_language_dropdown');
    if (!uiLangSelect) return;
    const value = language || uiLangSelect.value || getLanguage();
    const opts = getAvailableLanguages();
    uiLangSelect.value = value;
    if (!dd) return;
    const menu = dd.querySelector('.dashboard-custom-select__menu');
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    const selectedLabel = (opts.find(o => o.code === value)?.label) || (opts[0]?.label) || '—';
    if (valueEl) valueEl.textContent = selectedLabel;
    if (menu) {
        menu.innerHTML = opts.map(o => {
            const isSelected = o.code === value;
            return `<button type="button" class="dashboard-custom-select__option" data-value="${o.code}" data-selected="${isSelected ? 'true' : 'false'}">${o.label}</button>`;
        }).join('');
    }
}

if (typeof document !== 'undefined' && !window.__uiLanguageDropdownBound) {
    window.__uiLanguageDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('ui_language_dropdown');
        if (!dd) return;
        const toggleBtn = e.target.closest('[data-action="toggle-ui-language"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = e.target.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value;
            dd.dataset.open = 'false';
            const hidden = document.getElementById('ui_language');
            if (hidden && value && hidden.value !== value) {
                hidden.value = value;
                _applyAndSaveUiLanguage(value);
            }
            return;
        }
        if (!dd.contains(e.target)) dd.dataset.open = 'false';
    });
}

async function _applyAndSaveUiLanguage(language) {
    if (!language) return;
    const previousLanguage = getLanguage();
    const saveSeq = ++_uiLanguageSaveSeq;
    const dd = document.getElementById('ui_language_dropdown');

    try {
        setLanguage(language);
        await loadComponentTranslations(language);
        _refreshUiLanguageSelect(language);
        try { initGenericCustomSelects(); } catch (_) {}
        if (dd) dd.dataset.disabled = 'true';
        await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
    } catch (err) {
        if (saveSeq === _uiLanguageSaveSeq) {
            try {
                setLanguage(previousLanguage);
                _refreshUiLanguageSelect(previousLanguage);
            } catch (_) {}
            showToast(t('config.save_error') || 'Could not save settings.', 'error');
        }
    } finally {
        if (dd && saveSeq === _uiLanguageSaveSeq) dd.dataset.disabled = 'false';
    }
}

let _configAutoSaveBound = false;
let _configAutoSaveTimer = null;
let _configAutoSavePauseUntil = 0;

function _queueConfigAutoSave() {
    // Auto-save disabled — manual Save button used instead
}

function _bindConfigAutoSaveOnce() {
    // Auto-save disabled — manual Save button in settings header
}

export async function loadConfig() {
    _bindConfigAutoSaveOnce();
    _configAutoSavePauseUntil = Date.now() + 1500;

    const res = await apiCall('/api/config');
    const cfg = await res.json();

    const wsServiceShouldRunFromCfg = (() => {
        const fcm = cfg?.fcm || {};
        const mode = String(fcm.transport_mode || 'hybrid').toLowerCase();
        const wsEnabled = fcm.websocket_enabled !== false;
        return wsEnabled && mode !== 'firebase';
    })();
    if (window.__HYVE_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try { window.__setNativeWsServiceEnabled(!!wsServiceShouldRunFromCfg); } catch (_) {}
    }

    const updateLoggingModeBadge = (isVerbose) => {
        const badge = document.getElementById('header-log-mode-badge');
        if (!badge) return;
        const verbose = !!isVerbose;
        badge.textContent = verbose ? 'LOG: VERBOSE' : 'LOG: COMPACT';
        badge.classList.remove(
            'border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10',
            'border-amber-500/30', 'text-amber-300', 'bg-amber-500/10'
        );
        if (verbose) {
            badge.classList.add('border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
        } else {
            badge.classList.add('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10');
        }
    };
    updateLoggingModeBadge(!!cfg.verbose_logging);

    // Limbă UI
    const uiLangSelect = document.getElementById('ui_language');
    if (uiLangSelect) {
        _refreshUiLanguageSelect((cfg.ui && cfg.ui.language) || getLanguage());
    }

    if (cfg.security) {
        const wlNum = document.getElementById('wl_numbers');
        if (wlNum) wlNum.value = (cfg.security.allowed_numbers || []).join('\n');
        const secAntiInj = document.getElementById('security_anti_injection');
        if (secAntiInj) secAntiInj.checked = cfg.security.anti_injection !== false;
        const secAntiInjPrompt = document.getElementById('security_anti_injection_prompt');
        if (secAntiInjPrompt) secAntiInjPrompt.value = cfg.security.anti_injection_prompt_template || '';
        const secGuardrails = document.getElementById('security_tool_guardrails');
        if (secGuardrails) secGuardrails.checked = cfg.security.tool_guardrails !== false;
        const secRestrictUntrustedTools = document.getElementById('security_restrict_untrusted_tools');
        if (secRestrictUntrustedTools) secRestrictUntrustedTools.checked = cfg.security.restrict_mutating_tools_on_untrusted_content !== false;
    }

    const map = {
        'logging_mode': (cfg.verbose_logging ? 'verbose' : 'compact'),
        'target_url': cfg.llm?.target_url, 'model_name': cfg.llm?.model_name,
        'llm_api_key': cfg.llm?.api_key ?? '',
        'llm_provider': cfg.llm?.source ?? cfg.llm?.provider ?? 'local',
        'llm_temperature': cfg.llm?.temperature ?? 0.7,
        'llm_timeout': cfg.llm?.timeout ?? 120,
        'llm_context_length': cfg.llm?.context_length ?? 24000,
        'coder_target_url': cfg.coder?.target_url, 'coder_model_name': cfg.coder?.model_name,
        'coder_api_key': cfg.coder?.api_key ?? '',
        'coder_provider': cfg.coder?.source ?? cfg.coder?.provider ?? 'local',
        'coder_timeout': cfg.coder?.timeout ?? 180,
        'vision_llm_target_url': cfg.vision_llm?.target_url,
        'vision_llm_model_name': cfg.vision_llm?.model_name,
        'vision_llm_api_key': cfg.vision_llm?.api_key ?? '',
        'vision_llm_provider': cfg.vision_llm?.source ?? cfg.vision_llm?.provider ?? 'local',
        'vision_llm_timeout': cfg.vision_llm?.timeout ?? 60,
        'vision_llm_respond_directly': cfg.vision_llm?.respond_directly,
        'embed_model_name': cfg.librarian?.model_name,
        'waha_url': cfg.waha?.api_url, 'waha_enabled': cfg.waha?.enabled,
        'pago_enabled': cfg.pago?.enabled, 'pago_email': cfg.pago?.email, 'pago_password': cfg.pago?.password, 'pago_scan_interval': cfg.pago?.scan_interval ?? 3600,
        'fusion_solar_enabled': cfg.fusion_solar?.enabled, 'fusion_solar_mode': cfg.fusion_solar?.mode ?? 'auto', 'fusion_solar_host': cfg.fusion_solar?.host, 'fusion_solar_kiosk_url': cfg.fusion_solar?.kiosk_url ?? '', 'fusion_solar_username': cfg.fusion_solar?.username, 'fusion_solar_password': cfg.fusion_solar?.password, 'fusion_solar_scan_interval': cfg.fusion_solar?.scan_interval ?? 600,
        'fcm_enabled': cfg.fcm?.enabled,
        'fcm_project_id': cfg.fcm?.project_id,
        'fcm_service_account_path': cfg.fcm?.service_account_path,
        'p_persona': cfg.prompts?.system_persona ?? '',
        'p_agent_instructions': cfg.prompts?.agent_instructions ?? '',
        'p_agent_instructions_fallback': cfg.prompts?.agent_instructions_fallback ?? '',
        'p_agent_instruction_overrides': Array.isArray(cfg.prompts?.agent_instruction_overrides) ? cfg.prompts.agent_instruction_overrides.join('\n') : (cfg.prompts?.agent_instruction_overrides ?? ''),
        'p_search_web_single_message_instruction': cfg.prompts?.search_web_single_message_instruction ?? '',
        'p_web_content_reply_instruction': cfg.prompts?.web_content_reply_instruction ?? '',
        'p_image_placeholder': cfg.prompts?.image_placeholder ?? '',
        'p_summarize': cfg.prompts?.summarize ?? '',
        'config_timezone': cfg.timezone || '',
        'updates_addons_check_interval': cfg.updates?.addons?.check_interval || 'never',
        'updates_addons_auto_update': cfg.updates?.addons?.auto_update ?? false,
        'aux_llm_url': (cfg.intelligence?.aux_llm?.target_url ?? ''),
        'aux_llm_model': (cfg.intelligence?.aux_llm?.model_name ?? ''),
        'aux_llm_api_key': (cfg.intelligence?.aux_llm?.api_key ?? ''),
        'aux_llm_provider': (cfg.intelligence?.aux_llm?.source ?? cfg.intelligence?.aux_llm?.provider ?? 'local')
    };
    for (const [id, val] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = (val ?? '') + '';
    }
    if (typeof syncUpdatesIntervalDropdown === 'function') syncUpdatesIntervalDropdown();
    // Normalize old "custom" to "local" (Custom option removed)
    ['llm_provider', 'coder_provider', 'aux_llm_provider', 'vision_llm_provider'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.value === 'custom') el.value = 'local';
    });

    // Infer provider from URL when source not set
    function inferSource(url) {
        if (!url || !url.trim()) return 'local';
        const u = url.toLowerCase();
        if (u.includes('api.z.ai') && u.includes('coding')) return 'z_ai';
        if (u.includes('api.z.ai')) return 'z_ai';
        if (u.includes('api.x.ai')) return 'grok';
        if (u.includes('api.deepseek.com')) return 'deepseek';
        if (u.includes('openai.com')) return 'openai';
        return 'local';
    }
    const llmProv = document.getElementById('llm_provider');
    if (llmProv && !cfg.llm?.source && !cfg.llm?.provider) llmProv.value = inferSource(cfg.llm?.target_url);
    const coderProv = document.getElementById('coder_provider');
    if (coderProv && !cfg.coder?.source && !cfg.coder?.provider) coderProv.value = inferSource(cfg.coder?.target_url);
    const auxProv = document.getElementById('aux_llm_provider');
    if (auxProv && !(cfg.intelligence?.aux_llm?.source || cfg.intelligence?.aux_llm?.provider)) auxProv.value = inferSource(cfg.intelligence?.aux_llm?.target_url);
    const visionProv = document.getElementById('vision_llm_provider');
    if (visionProv && !(cfg.vision_llm?.source || cfg.vision_llm?.provider)) visionProv.value = inferSource(cfg.vision_llm?.target_url);

    // Prefill when dropdown changes
    function applyProvider(providerId, urlId, modelId, keyRowId, isCoder) {
        const sel = document.getElementById(providerId);
        if (!sel) return;
        const urlEl = document.getElementById(urlId);
        const modelEl = document.getElementById(modelId);
        const keyRow = keyRowId ? document.getElementById(keyRowId) : null;
        // Billing link (only for main LLM provider)
        const billingLink = (providerId === 'llm_provider') ? document.getElementById('zai_billing_link') : null;
        function syncBillingLink(v) {
            if (billingLink) billingLink.classList.toggle('hidden', v !== 'z_ai');
        }
        sel.onchange = () => {
            const v = sel.value;
            syncBillingLink(v);
            if (v === 'local') {
                if (urlEl) urlEl.value = isCoder ? '' : 'http://localhost:11434/v1';
                if (modelEl) modelEl.value = '';
                if (keyRow) keyRow.style.display = 'none';
            } else {
                if (keyRow) keyRow.style.display = '';
                if (v === 'z_ai') {
                    if (urlEl) urlEl.value = isCoder ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4';
                    if (modelEl) modelEl.value = 'glm-5';
                } else if (v === 'grok') {
                    if (urlEl) urlEl.value = 'https://api.x.ai/v1/chat/completions';
                    if (modelEl && !modelEl.value.trim()) modelEl.value = 'grok-4-1-fast-reasoning';
                } else if (v === 'deepseek') {
                    if (urlEl) urlEl.value = 'https://api.deepseek.com/chat/completions';
                    if (modelEl && !modelEl.value.trim()) modelEl.value = 'deepseek-chat';
                } else if (v === 'openai') {
                    if (urlEl) urlEl.value = 'https://api.openai.com/v1';
                    if (modelEl && !modelEl.value.trim()) modelEl.value = 'gpt-4o';
                }
            }
        };
        // Initial visibility for API key row
        if (keyRow) keyRow.style.display = (sel.value === 'local') ? 'none' : '';
        syncBillingLink(sel.value);
    }
    applyProvider('llm_provider', 'target_url', 'model_name', 'llm_api_key_row', false);
    applyProvider('coder_provider', 'coder_target_url', 'coder_model_name', 'coder_api_key_row', true);
    applyProvider('aux_llm_provider', 'aux_llm_url', 'aux_llm_model', 'aux_llm_api_key_row', false);
    applyProvider('vision_llm_provider', 'vision_llm_target_url', 'vision_llm_model_name', 'vision_llm_api_key_row', false);

    const m = cfg.memory || {};
    const parseListToText = (arr) => Array.isArray(arr) ? arr.join('\n') : '';
    const intelMw = document.getElementById('intel_working_window');
    const intelMs = document.getElementById('intel_summarize_every');
    if (intelMw) intelMw.value = m.working_window ?? 12;
    if (intelMs) intelMs.value = m.summarize_every ?? 8;
    const mFactSim = document.getElementById('memory_fact_similarity');
    if (mFactSim) mFactSim.value = m.fact_similarity_threshold ?? 0.45;
    const mExtractionTimeout = document.getElementById('memory_extraction_timeout');
    const mExtractionInputMaxChars = document.getElementById('memory_extraction_input_max_chars');
    const mExtractionMaxTokensFull = document.getElementById('memory_extraction_max_tokens_full');
    const mExtractionMaxLines = document.getElementById('memory_extraction_max_lines');
    if (mExtractionTimeout) mExtractionTimeout.value = m.extraction_timeout ?? (cfg.llm?.timeout ?? 120);
    if (mExtractionInputMaxChars) mExtractionInputMaxChars.value = m.extraction_input_max_chars ?? 900;
    if (mExtractionMaxTokensFull) mExtractionMaxTokensFull.value = m.extraction_max_tokens_full ?? 800;
    if (mExtractionMaxLines) mExtractionMaxLines.value = m.extraction_max_lines ?? 2;

    // Logging mode (live toggle)
    const loggingModeEl = document.getElementById('logging_mode');
    if (loggingModeEl && !loggingModeEl.dataset.bound) {
        loggingModeEl.dataset.bound = '1';
        loggingModeEl.addEventListener('change', async () => {
            updateLoggingModeBadge(loggingModeEl.value === 'verbose');
            try {
                await saveConfig();
            } catch (e) { /* handled in saveConfig via toast/error path */ }
        });
    }

    const mExtractionRules = document.getElementById('memory_extraction_rules');
    if (mExtractionRules) mExtractionRules.value = m.extraction_rules || '';

    // Memory: extraction examples (few-shot)
    renderExtractionExamples(m.extraction_examples || []);

    // Intelligence: consolidation
    const consolidation = (cfg.intelligence || {}).consolidation || {};
    const cEn = document.getElementById('consolidation_enabled');
    const cTime = document.getElementById('consolidation_time');
    const cInterval = document.getElementById('consolidation_interval');
    const cThr = document.getElementById('consolidation_threshold');
    if (cEn) cEn.checked = !!consolidation.enabled;
    if (cTime) cTime.value = consolidation.time || '03:00';
    if (cInterval) cInterval.value = consolidation.interval || 'daily';
    if (cThr) cThr.value = consolidation.similarity_threshold ?? 0.92;
    const cSessionTrig = document.getElementById('consolidation_session_trigger_messages');
    const cCompression = document.getElementById('consolidation_compression_ratio');
    const cHistoryPath = document.getElementById('consolidation_history_log_path');
    if (cSessionTrig) cSessionTrig.value = consolidation.session_trigger_messages ?? 80;
    if (cCompression) cCompression.value = consolidation.compression_ratio ?? 0.15;
    if (cHistoryPath) cHistoryPath.value = consolidation.history_log_path || 'history_log.md';

    // Daily news
    // Daily news config removed — now handled by skills/daily_news.py

    // Intelligence: Agent config
    const intel = cfg.intelligence || {};
    const maxAgentTurnsEl = document.getElementById('max_agent_turns');
    if (maxAgentTurnsEl) maxAgentTurnsEl.value = intel.max_agent_turns ?? 10;
    const postRespConcEl = document.getElementById('post_response_concurrency');
    if (postRespConcEl) postRespConcEl.value = intel.post_response_concurrency ?? 1;
    const injectFactsEl = document.getElementById('inject_relevant_facts');
    const richerResultsEl = document.getElementById('richer_tool_results');
    if (injectFactsEl) injectFactsEl.checked = intel.inject_relevant_facts !== false;
    if (richerResultsEl) richerResultsEl.checked = !!intel.richer_tool_results;
    const lazyHistEl = document.getElementById('intel_lazy_history');
    if (lazyHistEl) lazyHistEl.checked = intel.lazy_history !== false;  // default true

    // Intelligence: Ambient Brain (proactive)
    const amb = intel.ambient || {};
    const ambQuiet = amb.quiet_hours || {};
    const _setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const _setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    _setChk('ambient_enabled', amb.enabled);
    _setVal('ambient_mode', amb.mode || 'suggest');
    _setVal('ambient_checkin', amb.checkin || 'off');
    _setVal('ambient_quiet_start', ambQuiet.start || '23:00');
    _setVal('ambient_quiet_end', ambQuiet.end || '07:00');
    _setVal('ambient_max_per_hour', amb.max_per_hour ?? 6);
    _setVal('ambient_scan_interval', amb.scan_interval_min ?? 15);
    _setChk('ambient_learn_patterns', amb.learn_patterns !== false);
    _setChk('ambient_ignore_unavailable', !!amb.ignore_unavailable_entities);
    const ignoreSrc = amb.ignore_sources;
    _setVal('ambient_ignore_sources', Array.isArray(ignoreSrc) ? ignoreSrc.join(', ') : (ignoreSrc || ''));
    let ambPrompt = String(amb.reasoner_prompt || '').trim();
    if (!ambPrompt) {
        try { ambPrompt = await fetchDefaultAmbientReasonerPrompt(); } catch (_) { /* textarea stays empty until retry */ }
    }
    _setVal('ambient_reasoner_prompt', ambPrompt);
    // Profile picker: "active profile" + each configured model profile
    const ambProfileSel = document.getElementById('ambient_profile');
    if (ambProfileSel) {
        const profiles = Array.isArray(cfg.model_profiles) ? cfg.model_profiles : [];
        const activeLabel = t('config.ambient_profile_active') || 'Profil activ';
        ambProfileSel.innerHTML = `<option value="">${escapeHtml(activeLabel)}</option>` +
            profiles.map(p => {
                const aux = (p.aux_llm_enabled && (p.aux_llm?.model_name)) ? ' • aux' : '';
                return `<option value="${escapeHtmlAttr(p.id || '')}">${escapeHtml((p.name || p.id || '—') + aux)}</option>`;
            }).join('');
        ambProfileSel.value = amb.profile_id || '';
    }
    if (typeof initGenericCustomSelects === 'function') initGenericCustomSelects();

    // Helper: populate a model-profile <select> (mirrors ambient_profile)
    const _fillProfileSelect = (selectId, selectedId) => {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const profiles = Array.isArray(cfg.model_profiles) ? cfg.model_profiles : [];
        const activeLabel = t('config.ambient_profile_active') || 'Profil activ';
        sel.innerHTML = `<option value="">${escapeHtml(activeLabel)}</option>` +
            profiles.map(p => `<option value="${escapeHtmlAttr(p.id || '')}">${escapeHtml(p.name || p.id || '—')}</option>`).join('');
        sel.value = selectedId || '';
    };

    // Briefings
    const briefCfg = intel.briefings || {};
    _setChk('briefings_enabled', briefCfg.enabled);
    _setVal('briefings_morning_time', briefCfg.morning_time || '07:30');
    _setVal('briefings_evening_time', briefCfg.evening_time || '21:00');
    _setChk('briefings_include_weather', briefCfg.include_weather !== false);
    _setChk('briefings_include_planner', briefCfg.include_planner !== false);
    _setChk('briefings_include_home_status', briefCfg.include_home_status !== false);
    _fillProfileSelect('briefings_profile', briefCfg.profile_id);

    if (typeof initGenericCustomSelects === 'function') initGenericCustomSelects();

    // Pattern Detector
    const patternCfg = intel.pattern_detector || {};
    _setChk('pattern_detector_enabled', patternCfg.enabled);
    _setVal('pattern_min_occurrences', patternCfg.min_occurrences ?? 4);

    // Intent Router
    const routerCfg = intel.intent_router || {};
    _setChk('intent_router_enabled', routerCfg.enabled);

    // Proactive Hints
    const hintsCfg = intel.proactive_hints || {};
    _setChk('proactive_hints_enabled', hintsCfg.enabled);

    // Intelligence: Knowledge cutoff
    const iFreshCut = document.getElementById('intel_knowledge_cutoff');
    if (iFreshCut) iFreshCut.value = intel.knowledge_cutoff ?? '2024-01';

    // Intelligence: Search tendency slider
    const searchTendencyEl = document.getElementById('intel_search_tendency');
    if (searchTendencyEl) {
        searchTendencyEl.value = intel.search_tendency ?? 3;
        _updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        searchTendencyEl.addEventListener('input', () => {
            _updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        });
    }

    // Intelligence: Search context (use previous message in web search query)
    const searchUseCtx = document.getElementById('search_use_conversation_context');
    const searchCtxThreshold = document.getElementById('search_context_similarity_threshold');
    if (searchUseCtx) searchUseCtx.checked = !!intel.search_use_conversation_context;
    if (searchCtxThreshold) searchCtxThreshold.value = intel.search_context_similarity_threshold ?? 0.55;

    // Intelligence: Shell & Tool calling
    const shell = intel.shell || {};
    const shellEn = document.getElementById('shell_enabled');
    const shellAllowed = document.getElementById('shell_allowed_commands');
    const shellBlocked = document.getElementById('shell_blocked_patterns');
    const shellMaxOut = document.getElementById('shell_max_output_chars');
    const shellTimeout = document.getElementById('shell_timeout_seconds');
    const shellRate = document.getElementById('shell_rate_limit');
    if (shellEn) shellEn.checked = shell.enabled !== false;
    if (shellAllowed) shellAllowed.value = Array.isArray(shell.allowed_commands) ? shell.allowed_commands.join('\n') : '';
    if (shellBlocked) shellBlocked.value = Array.isArray(shell.blocked_patterns) ? shell.blocked_patterns.join('\n') : '';
    if (shellMaxOut) shellMaxOut.value = shell.max_output_chars ?? 8000;
    if (shellTimeout) shellTimeout.value = shell.timeout_seconds ?? 15;
    if (shellRate) shellRate.value = shell.rate_limit_per_minute ?? 5;

    const fileRead = intel.file_read || {};
    const frEn = document.getElementById('file_read_enabled');
    const frMaxBytes = document.getElementById('file_read_max_bytes');
    const frRate = document.getElementById('file_read_rate_limit');
    if (frEn) frEn.checked = fileRead.enabled !== false;
    if (frMaxBytes) frMaxBytes.value = fileRead.max_bytes ?? 51200;
    if (frRate) frRate.value = fileRead.rate_limit_per_minute ?? 10;

    const runScript = intel.run_script || {};
    const rsEn = document.getElementById('run_script_enabled');
    const rsTimeout = document.getElementById('run_script_timeout');
    const rsMaxOut = document.getElementById('run_script_max_output');
    const rsRate = document.getElementById('run_script_rate_limit');
    if (rsEn) rsEn.checked = runScript.enabled !== false;
    if (rsTimeout) rsTimeout.value = runScript.timeout_seconds ?? 15;
    if (rsMaxOut) rsMaxOut.value = runScript.max_output_chars ?? 20000;
    if (rsRate) rsRate.value = runScript.rate_limit_per_minute ?? 3;

    const proposePatch = intel.propose_patch || {};
    const ppEn = document.getElementById('propose_patch_enabled');
    const ppDirs = document.getElementById('propose_patch_allowed_dirs');
    if (ppEn) ppEn.checked = proposePatch.enabled !== false;
    if (ppDirs) ppDirs.value = Array.isArray(proposePatch.allowed_dirs) ? proposePatch.allowed_dirs.join(', ') : 'scripts, docs, ai_suggestions';

    // Librarian (memory recall) – loaded from cfg.librarian
    const lib = cfg.librarian || {};
    const iRetLimit = document.getElementById('intel_retrieval_limit');
    const iMemDist = document.getElementById('intel_memory_relevance_max_distance');
    if (iRetLimit) iRetLimit.value = lib.retrieval_limit ?? 5;
    if (iMemDist) iMemDist.value = lib.memory_relevance_max_distance != null ? lib.memory_relevance_max_distance : '';

    // SearXNG
    const searxng = cfg.searxng || {};
    const sxEn = document.getElementById('searxng_enabled');
    const sxUrl = document.getElementById('searxng_url');
    if (sxEn) sxEn.checked = !!searxng.enabled;
    if (sxUrl) sxUrl.value = searxng.url || '';
    const sxFetch = document.getElementById('searxng_fetch_pages');
    const sxMaxPages = document.getElementById('searxng_max_pages');
    const sxMaxResults = document.getElementById('searxng_max_results');
    const sxSearchTimeout = document.getElementById('searxng_search_timeout');
    const sxMaxSearchesPerRequest = document.getElementById('searxng_max_searches_per_request');
    if (sxFetch) sxFetch.checked = searxng.fetch_pages !== false;
    if (sxMaxPages) sxMaxPages.value = Math.min(3, Math.max(0, parseInt(searxng.max_pages_to_fetch, 10) || 2));
    if (sxMaxResults) sxMaxResults.value = searxng.max_search_results ?? 5;
    if (sxSearchTimeout) sxSearchTimeout.value = searxng.search_timeout ?? 10;
    if (sxMaxSearchesPerRequest) sxMaxSearchesPerRequest.value = Math.min(20, Math.max(1, parseInt(searxng.max_searches_per_request, 10) || 5));

    if (sxUrl) sxUrl.addEventListener('input', () => {}); // reserved: update freshness-related UI if needed

    // CCTV
    const cctvCfg = cfg.cctv || {};
    const cctvEnEl = document.getElementById('cctv_enabled');
    if (cctvEnEl) cctvEnEl.checked = !!cctvCfg.enabled;
    renderCctvCameras(cctvCfg.cameras || []);

    // Whisper
    const whisperCfg = cfg.whisper || {};
    const whisperEnEl = document.getElementById('whisper_enabled');
    if (whisperEnEl) whisperEnEl.checked = !!whisperCfg.enabled;
    const whisperHostEl = document.getElementById('whisper_host');
    const whisperPortEl = document.getElementById('whisper_port');
    const whisperLangEl = document.getElementById('whisper_language');
    if (whisperHostEl) whisperHostEl.value = whisperCfg.host || 'localhost';
    if (whisperPortEl) whisperPortEl.value = whisperCfg.port || 10300;
    if (whisperLangEl) whisperLangEl.value = whisperCfg.language || 'ro';
    const whisperVadMsEl = document.getElementById('whisper_vad_silence_ms');
    const whisperVadSensEl = document.getElementById('whisper_vad_sensitivity');
    if (whisperVadMsEl) whisperVadMsEl.value = whisperCfg.vad_silence_ms || 2500;
    if (whisperVadSensEl) whisperVadSensEl.value = whisperCfg.vad_sensitivity || 'medium';

    // Piper
    const piperCfg = cfg.piper || {};
    const piperEnEl = document.getElementById('piper_enabled');
    if (piperEnEl) piperEnEl.checked = !!piperCfg.enabled;
    const piperAlwaysSpeakEl = document.getElementById('piper_always_speak');
    if (piperAlwaysSpeakEl) piperAlwaysSpeakEl.checked = !!piperCfg.always_speak;
    // Sync runtime flag
    if (window.__tts) window.__tts.alwaysSpeak = !!piperCfg.always_speak;

    // ComfyUI
    const comfyuiCfg = cfg.comfyui || {};
    const comfyEnEl = document.getElementById('comfyui_enabled');
    if (comfyEnEl) comfyEnEl.checked = !!comfyuiCfg.enabled;
    const comfyFields = {
        'comfyui_url': comfyuiCfg.url || 'http://localhost:8188',
        'comfyui_checkpoint': comfyuiCfg.default_checkpoint || '',
        'comfyui_steps': comfyuiCfg.default_steps ?? 20,
        'comfyui_cfg': comfyuiCfg.default_cfg_scale ?? 7,
        'comfyui_width': comfyuiCfg.default_width ?? 1024,
        'comfyui_height': comfyuiCfg.default_height ?? 1024,
        'comfyui_sampler': comfyuiCfg.default_sampler || 'euler',
        'comfyui_scheduler': comfyuiCfg.default_scheduler || 'normal',
        'comfyui_timeout': comfyuiCfg.timeout ?? 120,
        'comfyui_negative': comfyuiCfg.default_negative_prompt || '',
        'comfyui_workflow_file': comfyuiCfg.workflow_file || '',
    };
    for (const [id, val] of Object.entries(comfyFields)) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }
    // Load workflow list on init
    if (comfyuiCfg.workflow_file) {
        refreshComfyUIWorkflows().catch(() => {});
    }
    // Webhook WAHA (nu se salvează, doar se afișează)
    const wh = document.getElementById('waha_webhook');
    if (wh && typeof window !== 'undefined') {
        wh.value = `${window.location.origin}/api/webhook/waha`;
    }



    // Integrări + restricții non-admin: whitelist per user, ascundere Models/HA/WhatsApp config/Prompts
    try {
        const meRes = await apiCall('/api/users/me');
        if (!meRes.ok) return;
        const profile = await meRes.json();
        window.__isAdmin = profile.is_admin;
        const isAdmin = profile.is_admin;

        document.querySelectorAll('.config-admin-only').forEach(el => {
            if (el.id && el.id.startsWith('cfg-tab-')) return;
            el.classList.toggle('hidden', !isAdmin);
        });
        const personaUser = document.getElementById('cfg-general-persona-user');
        const userPersona = document.getElementById('user_persona');
        if (personaUser && userPersona) {
            personaUser.classList.toggle('hidden', isAdmin);
            userPersona.value = profile.persona || '';
        }

        const adminBlock = document.getElementById('integrations-whitelist-admin');
        const userBlock = document.getElementById('integrations-whitelist-user');
        const addInput = document.getElementById('user-phone-add');
        const addBtn = document.getElementById('user-phone-add-btn');
        if (adminBlock && userBlock) {
            if (isAdmin) {
                adminBlock.classList.remove('hidden');
                userBlock.classList.add('hidden');
            } else {
                adminBlock.classList.add('hidden');
                userBlock.classList.remove('hidden');
                renderUserPhonesList(profile.phones || []);
                if (addBtn && addInput) {
                    addBtn.onclick = () => addUserPhone(addInput.value.trim(), addInput);
                }
            }
        }
        syncIntegrationToggles();
        bindIntegrationToggleButtonsOnce();
    } catch (e) {
        /* not logged in or error – still sync toggles from config values */
        syncIntegrationToggles();
        bindIntegrationToggleButtonsOnce();
    }

    // Mount integration toggles early so later saves cannot default them to disabled.
    try {
        await loadIntegrationCatalog(false);
        for (const entry of _integrationCatalog) {
            const slug = String(entry.slug || '').trim();
            if (!slug) continue;
            const cb = _findIntegrationCheckbox(slug);
            if (!cb) continue;
            const section = cfg[entry.config_key || slug];
            if (section && typeof section === 'object') {
                cb.checked = !!section.enabled;
            }
        }
        syncIntegrationToggles();
    } catch (_) {}

    _configAutoSavePauseUntil = Date.now() + 350;
}

function _integrationSlugCandidates(slug) {
    const raw = String(slug || '').trim();
    if (!raw) return [];
    const dash = raw.replace(/_/g, '-');
    const under = raw.replace(/-/g, '_');
    return Array.from(new Set([raw, dash, under]));
}

function _findIntegrationCheckbox(slug) {
    for (const candidate of _integrationSlugCandidates(slug)) {
        const ids = [`${candidate}_enabled`, `integrations-${candidate}-enabled`, `${candidate}Enabled`];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el && el.type === 'checkbox') return el;
        }
    }
    return null;
}

/** Integration enable toggles live in the dynamic catalog — omit `enabled` on save when
 *  the checkbox is not mounted yet, so unrelated saves cannot flip integrations off. */
function _integrationEnabledForSave(slug) {
    const cb = _findIntegrationCheckbox(slug);
    if (!cb) return undefined;
    return !!cb.checked;
}

function _withOptionalIntegrationEnabled(section, slug) {
    const enabled = _integrationEnabledForSave(slug);
    if (enabled !== undefined) section.enabled = enabled;
    return section;
}

function _findIntegrationButton(slug, mode) {
    for (const candidate of _integrationSlugCandidates(slug)) {
        const btn = document.getElementById(`${candidate}-btn-${mode}`);
        if (btn) return btn;
    }
    return null;
}

function syncIntegrationToggles() {
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        if (!slug) return;
        const input = _findIntegrationCheckbox(slug);
        const disableBtn = _findIntegrationButton(slug, 'disable');
        const enableBtn = _findIntegrationButton(slug, 'enable');
        if (!input || !disableBtn || !enableBtn) return;
        const on = !!input.checked;
        disableBtn.classList.toggle('hidden', !on);
        enableBtn.classList.toggle('hidden', on);
    });
    // Show/hide speak buttons depending on piper enabled
    const piperCheckbox = _findIntegrationCheckbox('piper');
    const anyTtsOn = !!(piperCheckbox && piperCheckbox.checked);
    document.querySelectorAll('.chat-speak-btn').forEach(btn => {
        btn.classList.toggle('hidden', !anyTtsOn);
    });
    // Show/hide always-speak button depending on piper enabled
    const alwaysSpeakBtn = document.getElementById('btn-always-speak');
    if (alwaysSpeakBtn) alwaysSpeakBtn.classList.toggle('hidden', !anyTtsOn);
    // Show/hide voice button depending on whisper enabled
    const voiceBtn = document.getElementById('btn-voice');
    if (voiceBtn) {
        const whisperCheckbox = _findIntegrationCheckbox('whisper');
        const whisperEnabled = !!(whisperCheckbox && whisperCheckbox.checked);
        voiceBtn.classList.toggle('hidden', !whisperEnabled);
        if (!whisperEnabled) {
            if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
                try { _voiceMediaRecorder.stop(); } catch (e) {}
            }
            if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
            if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
            if (_voiceStream) {
                _voiceStream.getTracks().forEach(t => t.stop());
                _voiceStream = null;
            }
            voiceBtn.disabled = false;
            voiceBtn.classList.remove('recording');
            const icon = voiceBtn.querySelector('i');
            if (icon) icon.className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
    }
    updateIntegrationSubtab();
}

// ---------------------------------------------------------------------------
// Integration sub-tabs: Active / Available
// ---------------------------------------------------------------------------
let _activeIntegrationSubtab = 'active';

window.switchIntegrationSubtab = function(tab) {
    _activeIntegrationSubtab = tab;
    const btnActive = document.getElementById('int-subtab-active');
    const btnAvail  = document.getElementById('int-subtab-available');
    if (btnActive) {
        btnActive.classList.toggle('bg-accent/20', tab === 'active');
        btnActive.classList.toggle('text-accent', tab === 'active');
        btnActive.classList.toggle('border-accent/40', tab === 'active');
        btnActive.classList.toggle('bg-white/5', tab !== 'active');
        btnActive.classList.toggle('text-slate-400', tab !== 'active');
        btnActive.classList.toggle('border-white/10', tab !== 'active');
    }
    if (btnAvail) {
        btnAvail.classList.toggle('bg-accent/20', tab === 'available');
        btnAvail.classList.toggle('text-accent', tab === 'available');
        btnAvail.classList.toggle('border-accent/40', tab === 'available');
        btnAvail.classList.toggle('bg-white/5', tab !== 'available');
        btnAvail.classList.toggle('text-slate-400', tab !== 'available');
        btnAvail.classList.toggle('border-white/10', tab !== 'available');
    }
    updateIntegrationSubtab();
};

function updateIntegrationSubtab() {
    const tab = _activeIntegrationSubtab;
    const enabledMap = {};
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        if (!slug) return;
        enabledMap[slug] = !!_findIntegrationCheckbox(slug)?.checked;
    });

    let visibleCount = 0;
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        const isEnabled = enabledMap[slug] ?? false;
        const show = tab === 'active' ? isEnabled : !isEnabled;
        row.classList.toggle('hidden', !show);
        if (show) visibleCount++;
    });

    const emptyEl = document.getElementById('int-subtab-empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0);

    const activeCount = Object.values(enabledMap).filter(Boolean).length;
    const availableCount = Object.keys(enabledMap).length - activeCount;
    const ac = document.getElementById('int-subtab-active-count');
    const avc = document.getElementById('int-subtab-available-count');
    if (ac) ac.textContent = activeCount > 0 ? `(${activeCount})` : '';
    if (avc) avc.textContent = availableCount > 0 ? `(${availableCount})` : '';
}

// --- ComfyUI helpers ---

window.testComfyUIConnection = async function() {
    const resultEl = document.getElementById('comfyui-test-result');
    if (!resultEl) return;
    resultEl.className = 'text-xs rounded-xl p-3 bg-slate-800 text-slate-400';
    resultEl.textContent = t('common.connecting') || 'Connecting...';
    resultEl.classList.remove('hidden');
    try {
        const urlVal = (document.getElementById('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/test${qs}`);
        const data = await res.json();
        if (data.ok) {
            const stats = data.system_stats || {};
            const gpu = stats.devices?.[0]?.name || (t('common.unknown') || 'Unknown');
            const vram = stats.devices?.[0]?.vram_total ? `${(stats.devices[0].vram_total / (1024**3)).toFixed(1)} GB VRAM` : '';
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
            resultEl.textContent = `✓ Connected! GPU: ${gpu}${vram ? ' — ' + vram : ''}`;
        } else {
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
            resultEl.textContent = `✗ ${data.error || 'Connection failed'}`;
        }
    } catch (e) {
        resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
        resultEl.textContent = `✗ ${e.message || 'Request failed'}`;
    }
};

window.refreshComfyUICheckpoints = async function() {
    const select = document.getElementById('comfyui_checkpoint');
    if (!select) return;
    const current = select.value;
    try {
        const urlVal = (document.getElementById('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/checkpoints${qs}`);
        const data = await res.json();
        const checkpoints = data.checkpoints || [];
        select.innerHTML = '<option value="">— selectează —</option>';
        for (const ckpt of checkpoints) {
            const opt = document.createElement('option');
            opt.value = ckpt;
            opt.textContent = ckpt;
            select.appendChild(opt);
        }
        if (current && checkpoints.includes(current)) select.value = current;
        if (checkpoints.length) showToast(`${checkpoints.length} checkpoints found`, 'success');
        else showToast('No checkpoints found', 'warning');
    } catch (e) {
        showToast('Failed to fetch checkpoints: ' + (e.message || e), 'error');
    }
};

window.refreshComfyUIWorkflows = async function() {
    const select = document.getElementById('comfyui_workflow_file');
    if (!select) return;
    const current = select.value;
    try {
        const res = await apiCall('/api/comfyui/workflows');
        const data = await res.json();
        const workflows = data.workflows || [];
        select.innerHTML = '<option value="">— none (auto-detect) —</option>';
        for (const wf of workflows) {
            const opt = document.createElement('option');
            opt.value = `comfyui_workflows/${wf.file}`;
            opt.textContent = wf.name;
            select.appendChild(opt);
        }
        if (current) select.value = current;
        if (workflows.length) showToast(`${workflows.length} workflow(s) found`, 'success');
        else showToast('No workflow templates found. Upload one from ComfyUI.', 'info');
    } catch (e) {
        showToast('Failed to fetch workflows: ' + (e.message || e), 'error');
    }
};

window.uploadComfyUIWorkflow = async function(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/comfyui/workflows/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${window._authToken || ''}` },
            body: formData,
        });
        const data = await res.json();
        if (data.ok) {
            showToast(`Workflow uploaded: ${data.file}`, 'success');
            await refreshComfyUIWorkflows();
            // Auto-select the uploaded workflow
            const select = document.getElementById('comfyui_workflow_file');
            if (select) select.value = `comfyui_workflows/${data.file}`;
        } else {
            showToast('Upload failed: ' + (data.error || 'unknown error'), 'error');
        }
    } catch (e) {
        showToast('Upload failed: ' + (e.message || e), 'error');
    }
    input.value = ''; // reset file input
};

let _integrationToggleButtonsBound = false;
function bindIntegrationToggleButtonsOnce() {
    if (_integrationToggleButtonsBound) return;
    _integrationToggleButtonsBound = true;

    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.integration-toggle-btn');
        if (!btn) return;
        const wrap = btn.parentElement;
        const checkbox = wrap?.querySelector('input[type="checkbox"]');
        if (!checkbox) return;

        if (btn.id.includes('-btn-enable')) checkbox.checked = true;
        if (btn.id.includes('-btn-disable')) checkbox.checked = false;

        syncIntegrationToggles();

        // Always persist the enabled flag for THIS integration directly via
        // PATCH (deep-merge) — saveConfig() only knows about explicit panels
        // (pago, whisper, …) so generic catalog integrations like mosquitto
        // would lose the toggle on refresh otherwise.
        const slug = (btn.id || '').replace(/-btn-(enable|disable)$/, '');
        if (slug) {
            const def = _integrationDefinition(slug);
            const configKey = String(def?.config_key || slug).trim() || slug;
            apiCall('/api/config', {
                method: 'PATCH',
                body: { [configKey]: { enabled: !!checkbox.checked } },
            }).catch(() => {});
        }
    });

    const addCamBtn = document.getElementById('cctv-add-camera');
    if (addCamBtn) addCamBtn.addEventListener('click', addCctvCameraRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC INTEGRATION CATALOG
// Backed by /api/integrations/catalog (see ui_catalog.json + ui_catalog.py).
// Renders the integration list rows, resolves modal title/icon/description and
// drives the shared "emitted entities" section. See docs/CARDS_AND_INTEGRATIONS.md.
// ─────────────────────────────────────────────────────────────────────────────

let _integrationCatalog = [];

function _normalizeIntegrationIcon(icon) {
    const raw = String(icon || '').trim();
    if (!raw) return 'fa-plug';
    if (raw.includes(' ')) return raw; // already a full FontAwesome class string
    if (raw.startsWith('fa-')) return raw;
    return `fa-${raw}`;
}

function _integrationCatalogSlug(integrationId) {
    const def = _integrationDefinition(integrationId);
    return String(def?.slug || integrationId || '').trim();
}

function _integrationEntitySourceSlug(integrationId) {
    return _integrationCatalogSlug(integrationId);
}

function _integrationDefinition(integrationId) {
    const target = String(integrationId || '').trim();
    if (!target) return null;
    return _integrationCatalog.find((entry) => {
        const slug = String(entry.slug || '').trim();
        const configKey = String(entry.config_key || slug).trim();
        const panelId = String(entry.config_panel_id || slug).trim();
        return slug === target
            || configKey === target
            || panelId === target;
    }) || null;
}

function _supportsIntegrationEntitySync(sourceSlug) {
    const def = _integrationDefinition(sourceSlug);
    return !!def?.supports_sync;
}

function _integrationLabel(entry) {
    if (!entry) return '';
    const titleKey = String(entry.title_key || '').trim();
    if (titleKey) {
        const translated = t(titleKey);
        if (translated && translated !== titleKey) return translated;
    }
    return entry.label || entry.slug || '';
}

window.syncConfiguredIntegration = async function(integrationId, button = null) {
    const sourceSlug = _integrationEntitySourceSlug(integrationId);
    const btn = button || document.getElementById(`${sourceSlug}-sync-btn`) || document.getElementById(`${integrationId}-sync-btn`);
    const originalHtml = btn?.innerHTML || '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Sync</span>';
    }
    try {
        if (typeof window.syncIntegrationEntities === 'function') {
            await window.syncIntegrationEntities(sourceSlug, { toast: true });
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml || '<i class="fas fa-arrows-rotate"></i><span>Sync</span>';
        }
    }
};

function _renderIntegrationCatalogRows() {
    const list = document.getElementById('integrations-list');
    if (!list) return;
    // Preserve the empty-state paragraph if it exists.
    const emptyEl = document.getElementById('int-subtab-empty');
    list.innerHTML = '';
    if (emptyEl) list.appendChild(emptyEl);

    const rowsHtml = _integrationCatalog.map((entry) => {
        const slug = escapeHtml(String(entry.slug || ''));
        const panelId = escapeHtml(String(entry.config_panel_id || entry.slug || ''));
        const toggleInputId = escapeHtml(String(entry.toggle_input_id || `${entry.slug}_enabled`));
        const toggleSlug = escapeHtml(String(entry.toggle_slug || entry.slug || ''));
        const label = escapeHtml(_integrationLabel(entry));
        const description = escapeHtml(String(entry.description || '').trim());
        const iconClass = escapeHtml(_normalizeIntegrationIcon(entry.icon || 'fa-plug'));
        const image = String(entry.image || '').trim();
        const accent = escapeHtml(String(entry.accent || '#94a3b8'));
        const iconBackground = escapeHtml(String(entry.icon_background || 'rgba(148,163,184,0.18)'));
        const textColor = escapeHtml(String(entry.text_color || entry.accent || '#cbd5e1'));
        const adminOnly = entry.admin_only ? 'config-admin-only' : '';
        const syncButton = entry.supports_sync
            ? `<button type="button" id="${slug}-sync-btn" onclick="syncConfiguredIntegration('${slug}', this)" class="px-3 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition-colors inline-flex items-center gap-1.5"><i class="fas fa-arrows-rotate"></i><span>Sync</span></button>`
            : '';
        // Toggle is rendered for every integration — Home Assistant is just
        // another source and can be disabled like any other.
        const toggle = `
                    <div class="flex items-center gap-2 ${adminOnly}">
                        <input type="checkbox" id="${toggleInputId}" class="sr-only" aria-hidden="true">
                        <button type="button" id="${toggleSlug}-btn-disable" class="integration-toggle-btn integration-btn-disable text-red-500/70 hover:text-red-500 hover:bg-red-500/10 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 sm:gap-2 min-h-[36px] sm:min-h-[44px] border border-transparent hover:border-red-500/20 touch-manipulation hidden"><i class="fas fa-power-off"></i> <span>Disable</span></button>
                        <button type="button" id="${toggleSlug}-btn-enable" class="integration-toggle-btn integration-btn-enable text-emerald-500/70 hover:text-emerald-500 hover:bg-emerald-500/10 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 sm:gap-2 min-h-[36px] sm:min-h-[44px] border border-transparent hover:border-emerald-500/20 touch-manipulation"><i class="fas fa-check"></i> <span>Enable</span></button>
                    </div>`;
        return `
            <div data-integration-row="${slug}" class="cfg-section flex flex-wrap items-center justify-between gap-3 min-w-0 ${adminOnly}" style="border-left: 4px solid ${accent};">
                <div class="flex items-center gap-3 min-w-0">
                    ${image ? `<img src="${escapeHtml(image)}" alt="" class="w-10 h-10 shrink-0" loading="lazy">` : `<span class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style="background:${iconBackground}; color:${textColor};"><i class="fas ${iconClass} text-xl"></i></span>`}
                    <div class="min-w-0">
                        <div class="text-sm font-bold truncate" style="color:${textColor};">${label}</div>
                        ${description ? `<div class="text-[11px] text-slate-500 truncate">${description}</div>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" onclick="openIntegrationConfigModal('${slug}')" class="px-4 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition-colors">Settings</button>
                    ${syncButton}
                    ${toggle}
                </div>
            </div>`;
    }).join('');

    list.insertAdjacentHTML('beforeend', rowsHtml);
}

async function loadIntegrationCatalog(force = false) {
    if (_integrationCatalog.length && !force) return _integrationCatalog;
    try {
        const res = await apiCall('/api/integrations/catalog');
        const data = await res.json().catch(() => ({}));
        _integrationCatalog = Array.isArray(data.integrations) ? data.integrations : [];
    } catch (_) {
        _integrationCatalog = [];
    }
    _renderIntegrationCatalogRows();
    return _integrationCatalog;
}

let _activeIntegrationSubtabPreferred = 'auto';
export async function refreshIntegrationsSettingsView(preferredTab = 'auto') {
    _activeIntegrationSubtabPreferred = preferredTab;
    await loadIntegrationCatalog(true);
    // The catalog renderer creates fresh checkbox/inputs for each integration,
    // so we must re-apply the saved config values; otherwise toggling is lost
    // on every refresh because the new <input> nodes start unchecked.
    try { await loadConfig(); } catch (_) {}
    // Apply per-integration "enabled" flags for generic catalog integrations
    // (mosquitto, etc.) — loadConfig() only sets a hardcoded set of fields.
    try {
        const r2 = await apiCall('/api/config');
        const cfg2 = await r2.json().catch(() => ({}));
        for (const entry of _integrationCatalog) {
            const slug = String(entry.slug || '');
            if (!slug) continue;
            const inputId = String(entry.toggle_input_id || `${slug}_enabled`);
            const cb = document.getElementById(inputId);
            if (!cb) continue;
            const section = cfg2[entry.config_key || slug];
            if (section && typeof section === 'object') {
                cb.checked = !!section.enabled;
            }
        }
    } catch (_) {}
    syncIntegrationToggles();
    bindIntegrationToggleButtonsOnce();

    let nextTab = preferredTab;
    if (preferredTab === 'auto') {
        const hasActive = Array.from(document.querySelectorAll('[data-integration-row]'))
            .some((row) => !!_findIntegrationCheckbox(row.dataset.integrationRow)?.checked);
        nextTab = hasActive ? 'active' : 'available';
    }
    if (nextTab !== 'active' && nextTab !== 'available') nextTab = 'active';
    if (typeof window.switchIntegrationSubtab === 'function') {
        window.switchIntegrationSubtab(nextTab);
    } else {
        _activeIntegrationSubtab = nextTab;
        updateIntegrationSubtab();
    }
}

// Shared "emitted devices" section — populated when the integration modal
// is opened. Groups exposed entities by device and renders clickable device
// cards; clicking a card opens a modal with controls + rename, à la
// Home Assistant.
let _exposedDevicesState = { slug: null, devices: [] };
// Page index per slug for the device grid.
const _DEVICE_PAGE_SIZE = 6;
const _devicePageState = new Map();

function _renderDevicesSection(section, group, slug, baseOffset, opts) {
    const pageSize = _DEVICE_PAGE_SIZE;
    const showEntryLabel = !!(opts && opts.showEntryLabel);
    const pages = Math.max(1, Math.ceil(group.devices.length / pageSize));
    const stateKey = `${slug}::${group.key}`;
    let page = _devicePageState.get(stateKey) || 0;
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    _devicePageState.set(stateKey, page);

    const start = page * pageSize;
    const slice = group.devices.slice(start, start + pageSize);
    const cardsHtml = slice
        .map((d, j) => _devCardHtml(d, baseOffset + start + j, slug, showEntryLabel))
        .join('');

    const pagerHtml = pages > 1
        ? `<div class="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-white/5" data-device-pager>
            <button type="button" data-device-page-prev ${page === 0 ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                <i class="fas fa-chevron-left mr-1"></i>Înapoi
            </button>
            <span class="text-[11px] text-slate-500 mono">${page + 1} / ${pages} <span class="opacity-60">·</span> ${group.devices.length} disp.</span>
            <button type="button" data-device-page-next ${page >= pages - 1 ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                Înainte<i class="fas fa-chevron-right ml-1"></i>
            </button>
        </div>`
        : '';

    section.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2" style="column-gap:1.5rem;row-gap:1.25rem;">${cardsHtml}</div>
        ${pagerHtml}`;

    const prev = section.querySelector('[data-device-page-prev]');
    const next = section.querySelector('[data-device-page-next]');
    if (prev) prev.onclick = () => {
        _devicePageState.set(stateKey, Math.max(0, (_devicePageState.get(stateKey) || 0) - 1));
        _renderDevicesSection(section, group, slug, baseOffset, opts);
    };
    if (next) next.onclick = () => {
        _devicePageState.set(stateKey, Math.min(pages - 1, (_devicePageState.get(stateKey) || 0) + 1));
        _renderDevicesSection(section, group, slug, baseOffset, opts);
    };
}

function _devCardHtml(d, idx, slug, showEntryLabel) {
    const name = escapeHtml(d.name || d.device_id || 'Dispozitiv');
    const ents = Array.isArray(d.entities) ? d.entities : [];
    const total = ents.length;
    const sub = [d.model, d.manufacturer].filter(Boolean).join(' · ');
    // Domain tally chips
    const tally = {};
    const _domOf = (e) => String(e.domain || String(e.entity_id || '').split('.')[0] || 'other').toLowerCase();
    for (const e of ents) {
        const dom = _domOf(e) || 'other';
        tally[dom] = (tally[dom] || 0) + 1;
    }
    const chips = Object.entries(tally).slice(0, 4).map(([dom, n]) => {
        const ic = getDomainIcon(dom);
        return `<span class="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-white/[0.04] border border-white/5 text-slate-400 uppercase tracking-wider"><i class="fas ${ic} text-[9px]"></i>${escapeHtml(dom)}<span class="text-slate-300">${n}</span></span>`;
    }).join('');
    // Primary readout: battery / state count (no on-count badge)
    let primary = `<span class="text-[10px] text-slate-500">${total} entit.</span>`;
    const sslug = String(slug || '').replace(/'/g, "\\'");
    const entryTitle = (showEntryLabel && d.entry_title) ? escapeHtml(d.entry_title) : '';
    const entryHeader = entryTitle
        ? `<div class="flex items-center gap-1.5 mb-2 px-1 text-[10px] uppercase tracking-widest text-slate-500">
            <i class="fas fa-plug text-[9px] opacity-70"></i>
            <span class="truncate">${entryTitle}</span>
        </div>`
        : '';
    return `
    <div class="flex flex-col min-w-0">
        ${entryHeader}
        <div class="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:bg-white/[0.06] hover:border-accent/20 transition-all cursor-pointer overflow-hidden"
             onclick="window.__openIntegrationDeviceModal(${idx}, '${sslug}')">
            <div class="flex items-start justify-between gap-3 min-w-0">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                        <i class="fas fa-microchip text-accent/70 text-sm shrink-0"></i>
                        <div class="text-[13px] font-semibold text-slate-100 fade-edge-r min-w-0 flex-1">${name}</div>
                    </div>
                    ${sub ? `<div class="text-[11px] text-slate-500 truncate mt-1">${escapeHtml(sub)}</div>` : ''}
                </div>
                <div class="shrink-0">${primary}</div>
            </div>
            ${chips ? `<div class="flex items-center gap-1.5 mt-3 flex-wrap min-w-0">${chips}</div>` : ''}
        </div>
    </div>`;
}

async function loadIntegrationExposedEntities(integrationId) {
    const section = document.getElementById('integration-exposed-entities-section');
    const caption = document.getElementById('integration-exposed-entities-caption');
    const grid    = document.getElementById('integration-exposed-entities-grid');
    const empty   = document.getElementById('integration-exposed-entities-empty');
    const error   = document.getElementById('integration-exposed-entities-error');
    const openBtn = document.getElementById('integration-exposed-entities-open');
    const syncBtn = document.getElementById('integration-exposed-entities-sync');
    if (!section || !grid || !empty || !openBtn) return null;

    const sourceSlug = _integrationEntitySourceSlug(integrationId);
    if (!_supportsIntegrationEntitySync(sourceSlug)) {
        section.classList.add('hidden');
        return null;
    }
    section.classList.remove('hidden');
    grid.innerHTML = '';
    grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
    empty.classList.add('hidden');
    error.classList.add('hidden');
    if (caption) caption.textContent = t('common.loading_devices') || 'Loading devices...';

    openBtn.onclick = () => {
        if (typeof window.navigateToSmartHomeSource === 'function') {
            window.navigateToSmartHomeSource(sourceSlug);
        } else if (typeof window.switchTab === 'function') {
            window.switchTab('smarthome');
        }
    };
    if (syncBtn) {
        const supportsSync = _supportsIntegrationEntitySync(sourceSlug);
        syncBtn.classList.toggle('hidden', !supportsSync);
        syncBtn.classList.toggle('inline-flex', supportsSync);
        syncBtn.onclick = supportsSync ? async () => {
            await window.syncConfiguredIntegration(integrationId, syncBtn);
            await loadIntegrationExposedEntities(integrationId);
        } : null;
    }

    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(sourceSlug)}/devices`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || translateApiDetail(data.message) || t('integrations.devices_load_error'));
        const devices = Array.isArray(data.devices) ? data.devices : [];
        const totalEnts = devices.reduce((s, d) => s + ((d.entities && d.entities.length) || 0), 0);
        const meta = _integrationDefinition(integrationId);
        const label = _integrationLabel(meta) || integrationId;
        if (caption) caption.textContent = t('integrations.devices_caption', { label, devices: devices.length, entities: totalEnts });

        if (!devices.length) {
            _exposedDevicesState = { slug: sourceSlug, devices: [] };
            empty.classList.remove('hidden');
            return 0;
        }
        // Single continuous grid: cards flow one after another regardless of
        // entry. When more than one entry is in play, each card shows its
        // own entry title as a small caption below it. Sort so devices from
        // the same entry stay adjacent.
        const entryKeys = new Set(devices.map(d => d.entry_id || ''));
        const showEntryLabel = entryKeys.size > 1;
        const sorted = devices.slice().sort((a, b) => {
            const ta = String(a.entry_title || '');
            const tb = String(b.entry_title || '');
            if (ta !== tb) return ta.localeCompare(tb);
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        _exposedDevicesState = { slug: sourceSlug, devices: sorted };
        grid.className = 'flex flex-col gap-3';
        grid.innerHTML = '';
        const section = document.createElement('div');
        section.className = 'space-y-3';
        section.dataset.entryKey = '__all__';
        section.dataset.baseOffset = '0';
        grid.appendChild(section);
        _renderDevicesSection(
            section,
            { key: '__all__', title: '', devices: sorted },
            sourceSlug,
            0,
            { showEntryLabel },
        );
        return devices.length;
    } catch (err) {
        if (caption) caption.textContent = '';
        error.textContent = err.message || t('integrations.devices_load_error');
        error.classList.remove('hidden');
        return null;
    }
}

// ── HA-style config entries (multi-instance, declarative) ──────────────
let _entriesCurrent = { slug: null, schema: [], entries: [], supportsMultiple: false, label: '' };
const _syncingEntryIds = new Set();

function _integrationHasConfigSchema(integrationId) {
    const def = _integrationDefinition(integrationId);
    return !!def?.has_config_schema;
}

function _showIntegrationSchemaLoadError(slug, message) {
    const generic = document.getElementById('integration-panel-generic');
    const desc = document.getElementById('integration-generic-description');
    if (generic) generic.classList.remove('hidden');
    if (desc) {
        desc.textContent = message;
        desc.classList.remove('hidden');
    }
    if (typeof showToast === 'function') {
        showToast(message, 'error', 4500);
    }
    console.warn(`[integrations] schema load failed for ${slug}:`, message);
}

async function loadIntegrationConfigEntries(slug) {
    const section = document.getElementById('integration-entries-section');
    if (!section) return;
    if (!_integrationHasConfigSchema(slug)) {
        section.classList.add('hidden');
        return;
    }
    const desc = document.getElementById('integration-generic-description');
    if (desc) { desc.textContent = ''; desc.classList.add('hidden'); }
    let payload = null;
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/schema`);
        if (!res.ok) {
            const o = await res.json().catch(() => ({}));
            const detail = o.detail || o.message || `HTTP ${res.status}`;
            section.classList.add('hidden');
            if (res.status === 404) {
                _showIntegrationSchemaLoadError(
                    slug,
                    t('integrations.config_provider_missing', { slug })
                        || `Providerul „${slug}” nu e disponibil pe server. Repornește Hyve după update.`,
                );
            } else {
                _showIntegrationSchemaLoadError(slug, t('integrations.config_load_failed', { detail }));
            }
            return;
        }
        payload = await res.json();
    } catch (err) {
        section.classList.add('hidden');
        _showIntegrationSchemaLoadError(slug, err?.message || t('integrations.schema_load_network'));
        return;
    }
    if (!payload || !Array.isArray(payload.schema) || payload.schema.length === 0) {
        // Provider has no declarative schema → keep legacy/custom panel only.
        section.classList.add('hidden');
        return;
    }
    _entriesCurrent = {
        slug,
        schema: payload.schema,
        entries: payload.entries || [],
        supportsMultiple: !!payload.supports_multiple,
        label: payload.label || slug,
    };
    section.classList.remove('hidden');
    // Hide the legacy generic panel entirely — the entries section + the
    // shared Dispozitive section now cover everything.
    const generic = document.getElementById('integration-panel-generic');
    if (generic) generic.classList.add('hidden');
    // Also hide any hand-authored legacy panel for this slug — once an
    // integration declares CONFIG_SCHEMA, the entries flow IS the UI.
    // Keeps every integration looking identical (HA-style).
    document.querySelectorAll('[id^="integration-panel-"]').forEach(p => {
        if (p.id !== 'integration-panel-generic') p.classList.add('hidden');
    });
    const addBtn = document.getElementById('integration-entries-add-btn');
    if (addBtn) {
        const disable = !_entriesCurrent.supportsMultiple && _entriesCurrent.entries.length > 0;
        addBtn.disabled = disable;
        addBtn.classList.toggle('opacity-40', disable);
        addBtn.title = disable ? 'Această integrare permite o singură intrare.' : '';
        addBtn.onclick = () => openEntryEditor(null);
    }
    // Hide the generic "no settings" hint — the entries section IS the settings UI.
    const hint = document.getElementById('integration-generic-empty-hint');
    if (hint) hint.classList.add('hidden');
    _renderEntriesList();
}

function _renderEntriesList() {
    const list = document.getElementById('integration-entries-list');
    const empty = document.getElementById('integration-entries-empty');
    if (!list) return;
    list.innerHTML = '';
    if (!_entriesCurrent.entries.length) {
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');
    _entriesCurrent.entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 bg-white/[0.03] border border-white/5 rounded-lg p-2.5';
        row.dataset.entryId = entry.entry_id;
        const enabled = entry.enabled !== false;
        const isSyncing = _syncingEntryIds.has(entry.entry_id);
        const syncBadge = isSyncing
            ? `<span class="inline-flex items-center gap-1 text-[10px] text-amber-400/80 animate-pulse"><i class="fas fa-spinner fa-spin text-[8px]"></i> se sincronizează…</span>`
            : '';
        const statusText = enabled ? '' : '· dezactivat';
        row.innerHTML = `
            <div class="min-w-0 flex-1">
                <div class="text-[12px] font-semibold text-slate-100 truncate">${escapeHtml(entry.title || _entriesCurrent.label)}</div>
                <div class="text-[10px] text-slate-500 mono truncate flex items-center gap-2">${escapeHtml(entry.entry_id.slice(0,8))} ${statusText} ${syncBadge}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-act="edit" class="px-2 py-1 rounded text-[10px] bg-white/5 hover:bg-white/10 text-slate-300" title="Editează"><i class="fas fa-pen"></i></button>
                <button type="button" data-act="delete" class="px-2 py-1 rounded text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-300" title="Șterge"><i class="fas fa-trash"></i></button>
            </div>`;
        row.querySelector('[data-act="edit"]').onclick = () => openEntryEditor(entry);
        row.querySelector('[data-act="delete"]').onclick = async () => {
            if (!await showConfirm(`Ștergi configurarea "${entry.title}"?`)) return;
            try {
                const slug = _entriesCurrent.slug;
                const r = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/entries/${encodeURIComponent(entry.entry_id)}`, { method: 'DELETE' });
                if (!r.ok) { const o = await r.json().catch(() => ({})); throw new Error(translateApiDetail(o.detail) || t('integrations.delete_error')); }
                await loadIntegrationConfigEntries(slug);
                try { await loadIntegrationExposedEntities(slug); } catch (_) {}
                if (typeof showToast === 'function') showToast(t('hy.deleted'), 'success', 1800);
            } catch (e) {
                if (typeof showToast === 'function') showToast(e.message || t('common.error'), 'error', 2500);
            }
        };
        list.appendChild(row);
    });
}

function _pollForEntities(slug, attempts = 0, syncingEntryId = null) {
    const maxAttempts = 8;
    const delays = [1500, 2500, 3000, 4000, 5000, 7000, 10000, 15000];
    const grid = document.getElementById('integration-exposed-entities-grid');
    if (grid && attempts === 0) {
        grid.innerHTML = `<div class="flex items-center gap-2 text-slate-400 text-xs py-4 px-2">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Se sincronizează dispozitivele…</span>
        </div>`;
    }
    loadIntegrationExposedEntities(slug).then(count => {
        if (count > 0) {
            _clearSyncingState(syncingEntryId);
            return;
        }
        if (attempts < maxAttempts) {
            const delay = delays[Math.min(attempts, delays.length - 1)];
            setTimeout(() => _pollForEntities(slug, attempts + 1, syncingEntryId), delay);
        } else {
            _clearSyncingState(syncingEntryId);
            if (grid) grid.innerHTML = `<div class="text-slate-500 text-xs py-4 px-2">${escapeHtml(t('integrations.no_devices_yet'))}</div>`;
        }
    }).catch(() => {
        if (attempts < maxAttempts) {
            const delay = delays[Math.min(attempts, delays.length - 1)];
            setTimeout(() => _pollForEntities(slug, attempts + 1, syncingEntryId), delay);
        } else {
            _clearSyncingState(syncingEntryId);
        }
    });
}

function _clearSyncingState(entryId) {
    if (!entryId) return;
    _syncingEntryIds.delete(entryId);
    const row = document.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`);
    if (row) {
        const badge = row.querySelector('.animate-pulse');
        if (badge) badge.remove();
    }
}

function openEntryEditor(entry) {
    const modal = document.getElementById('integration-entry-modal');
    const titleEl = document.getElementById('integration-entry-modal-title');
    const fieldsEl = document.getElementById('integration-entry-fields');
    const errEl = document.getElementById('integration-entry-error');
    const titleInput = document.querySelector('#integration-entry-form input[name="__title__"]');
    if (!modal || !fieldsEl || !titleInput) return;
    errEl.classList.add('hidden'); errEl.textContent = '';
    titleEl.textContent = entry ? `Editează: ${entry.title}` : `Adaugă intrare — ${_entriesCurrent.label}`;
    titleInput.value = entry?.title || '';
    fieldsEl.innerHTML = '';
    const data = entry?.data || {};
    _entriesCurrent.schema.forEach(field => {
        const wrap = document.createElement('div');
        const id = `entry_field_${field.key}`;
        const required = field.required ? '<span class="text-red-400">*</span>' : '';
        const help = field.help ? `<div class="text-[10px] text-slate-500 mt-1">${escapeHtml(field.help)}</div>` : '';
        let input = '';
        const value = data[field.key] !== undefined ? data[field.key] : (field.default !== undefined ? field.default : '');
        const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
        if (field.type === 'link') {
            const href = escapeHtmlAttr(field.url || '#');
            input = `<a href="${href}" target="_blank" rel="noopener noreferrer"
                class="w-full flex items-center justify-center gap-2 bg-accent/15 border border-accent/40 text-accent rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 transition-colors no-underline">
                <i class="fas fa-arrow-up-right-from-square"></i> <span>Deschide pagina Xiaomi</span>
            </a>`;
        } else if (field.type === 'select' && Array.isArray(field.options)) {
            const opts = field.options.map(o => `<option value="${escapeHtml(o.value)}" ${String(o.value)===String(value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('');
            input = `<select id="${id}" name="${field.key}" class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-accent outline-none">${opts}</select>`;
        } else if (field.type === 'bool') {
            input = `<label class="flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" id="${id}" name="${field.key}" ${value?'checked':''} class="accent-accent"> <span>${escapeHtml(field.label || field.key)}</span></label>`;
        } else {
            const t = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : (field.type === 'url' ? 'url' : 'text'));
            const minAttr = field.min != null ? ` min="${escapeHtmlAttr(field.min)}"` : '';
            const maxAttr = field.max != null ? ` max="${escapeHtmlAttr(field.max)}"` : '';
            input = `<input type="${t}" id="${id}" name="${field.key}"${minAttr}${maxAttr} ${placeholder} value="${escapeHtml(value)}" class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-accent outline-none">`;
        }
        if (field.type === 'bool') {
            wrap.innerHTML = input;
        } else {
            wrap.innerHTML = `<label class="block text-[10px] font-semibold text-slate-400 uppercase mb-1">${escapeHtml(field.label || field.key)} ${required}</label>${input}${help}`;
        }
        fieldsEl.appendChild(wrap);
    });
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const close = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
    document.getElementById('integration-entry-modal-close').onclick = close;
    document.getElementById('integration-entry-cancel').onclick = close;
    // Helper: collect form data, skipping masked secrets when editing.
    const collectData = () => {
        const out = {};
        for (const field of _entriesCurrent.schema) {
            if (field.type === 'oauth' || field.type === 'link') continue;
            const el = document.getElementById(`entry_field_${field.key}`);
            if (!el) continue;
            let v;
            if (field.type === 'bool') v = !!el.checked;
            else if (field.type === 'number') v = el.value === '' ? null : Number(el.value);
            else v = el.value;
            if (entry && field.secret && typeof v === 'string' && /^[•*]+$/.test(v)) continue;
            out[field.key] = v;
        }
        return out;
    };

    // Test connection — runs the provider's ``async_test_connection`` against
    // the unsaved form data. Does NOT persist the entry.
    const testBtn = document.getElementById('integration-entry-test');
    if (testBtn) {
        testBtn.onclick = async () => {
            errEl.classList.add('hidden'); errEl.textContent = '';
            const orig = testBtn.innerHTML;
            testBtn.disabled = true;
            testBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('integrations.test_connecting'))}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000);
            try {
                const r = await apiCall(`/api/integrations/${encodeURIComponent(_entriesCurrent.slug)}/entries/test`, {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ data: collectData(), entry_id: entry?.entry_id || null }),
                    signal: controller.signal,
                });
                const o = await r.json().catch(() => ({}));
                if (r.ok && o.ok) {
                    if (typeof showToast === 'function') showToast(integrationApiMessage(o) || t('integrations.connection_ok'), 'success', 2200);
                } else {
                    errEl.textContent = integrationApiMessage(o) || t('integrations.test_failed');
                    errEl.classList.remove('hidden');
                }
            } catch (e) {
                errEl.textContent = e.name === 'AbortError'
                    ? t('integrations.test_timeout')
                    : (e.message || t('common.error'));
                errEl.classList.remove('hidden');
            } finally {
                clearTimeout(timeoutId);
                testBtn.disabled = false;
                testBtn.innerHTML = orig;
            }
        };
    }

    document.getElementById('integration-entry-save').onclick = async () => {
        const saveBtn = document.getElementById('integration-entry-save');
        const payload = { title: (titleInput.value || '').trim() || _entriesCurrent.label, data: collectData() };
        const isCreate = !entry;
        const slug = _entriesCurrent.slug;
        // Disable save button to prevent double-clicks
        if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add('opacity-50'); }
        try {
            const url = entry
                ? `/api/integrations/${encodeURIComponent(slug)}/entries/${encodeURIComponent(entry.entry_id)}`
                : `/api/integrations/${encodeURIComponent(slug)}/entries`;
            const r = await apiCall(url, { method: entry ? 'PATCH' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
            const o = await r.json().catch(() => ({}));
            if (!r.ok) {
                errEl.textContent = translateApiDetail(o.detail) || translateApiDetail(o.errors) || t('integrations.save_error');
                errEl.classList.remove('hidden');
                return;
            }
            // Close modal immediately — entry is saved, sync runs in background
            close();
            if (typeof showToast === 'function') showToast(t('hy.saved'), 'success', 1800);
            // Mark entry as syncing so the row shows a loading indicator
            const savedEntryId = o.entry?.entry_id;
            if (savedEntryId) _syncingEntryIds.add(savedEntryId);
            // Refresh the entries list right away (entry already persisted, shows syncing badge)
            await loadIntegrationConfigEntries(slug);
            // Poll for entities — clears syncing state when done
            _pollForEntities(slug, 0, savedEntryId);
        } catch (e) {
            errEl.textContent = e.message || t('common.error'); errEl.classList.remove('hidden');
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('opacity-50'); }
        }
    };
}

// ── OAuth connect flow (Xiaomi Home & future OAuth providers) ──────────
// Opens the provider's auth page in a popup, then polls the provider's status
// endpoint until the server-side redirect callback has captured the code and
// created the config entry. No copy/paste, no homeassistant.local.
async function _runOAuthConnect(field, btn, errEl, closeModal) {
    const slug = _entriesCurrent.slug;
    const labelEl = btn.querySelector('[data-oauth-label]');
    const statusEl = btn.parentElement.querySelector('[data-oauth-status]');
    const origLabel = labelEl ? labelEl.textContent : '';
    const setBusy = (txt) => { if (labelEl) labelEl.textContent = txt; btn.disabled = true; };
    const reset = () => { if (labelEl) labelEl.textContent = origLabel; btn.disabled = false; };
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }

    // Build the start URL with declared form params (e.g. cloud_server).
    const qs = new URLSearchParams();
    (field.params || []).forEach(key => {
        const el = document.getElementById(`entry_field_${key}`);
        if (el && el.value !== undefined) qs.set(key, el.value);
    });
    setBusy('Se deschide Xiaomi…');
    let state;
    let popup;
    try {
        // Open the popup synchronously (inside the click) to avoid blockers.
        popup = window.open('about:blank', 'xiaomi_oauth', 'width=480,height=720');
        const r = await apiCall(`${field.start}?${qs.toString()}`);
        const o = await r.json().catch(() => ({}));
        if (!r.ok || !o.auth_url) {
            if (popup) popup.close();
            throw new Error(o.detail || 'Nu am putut porni autentificarea.');
        }
        state = o.state;
        if (popup) popup.location.href = o.auth_url;
        else window.open(o.auth_url, '_blank');
    } catch (e) {
        reset();
        if (errEl) { errEl.textContent = e.message || 'Eroare'; errEl.classList.remove('hidden'); }
        return;
    }

    setBusy('Aștept autentificarea…');
    const deadline = Date.now() + 5 * 60 * 1000;
    const poll = async () => {
        if (Date.now() > deadline) {
            reset();
            if (errEl) { errEl.textContent = 'Autentificarea a expirat. Încearcă din nou.'; errEl.classList.remove('hidden'); }
            return;
        }
        try {
            const r = await apiCall(`${field.status}?state=${encodeURIComponent(state)}`);
            const o = await r.json().catch(() => ({}));
            if (o.status === 'completed') {
                if (statusEl) statusEl.innerHTML = '<span class="text-[11px] text-emerald-400 font-semibold"><i class="fas fa-check-circle mr-1"></i>Conectat</span>';
                if (typeof showToast === 'function') showToast(t('hy.xiaomi_connected'), 'success', 2200);
                try { if (popup && !popup.closed) popup.close(); } catch (_) {}
                if (typeof closeModal === 'function') closeModal();
                if (o.entry_id) _syncingEntryIds.add(o.entry_id);
                await loadIntegrationConfigEntries(slug);
                _pollForEntities(slug, 0, o.entry_id);
                return;
            }
            if (o.status === 'error' || o.status === 'expired') {
                reset();
                if (errEl) { errEl.textContent = o.error || 'Autentificare eșuată.'; errEl.classList.remove('hidden'); }
                return;
            }
        } catch (_) { /* keep polling */ }
        setTimeout(poll, 2000);
    };
    setTimeout(poll, 2500);
}

// ── Device modal (shared across integrations) ──────────────────────────
function _entityIcon(eid, domain) {
    const dom = String(domain || String(eid || '').split('.')[0] || '').toLowerCase();
    return getDomainIcon(dom);
}

function _renderEntityControlRow(ent, slug) {
    const eid = ent.entity_id || '';
    const name = escapeHtml(ent.name || ent.friendly_name || eid);
    const dom = String(ent.domain || String(eid).split('.')[0] || '').toLowerCase();
    const state = ent.state == null || ent.state === '' ? 'unknown' : String(ent.state);
    const unit = ent.unit ? ` ${escapeHtml(String(ent.unit))}` : '';
    const lower = state.toLowerCase();
    const isOn = ACTIVE_STATES.includes(lower);
    const isOff = ['off', 'closed', 'locked', 'idle', 'docked', 'paused'].includes(lower);
    const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');
    const icon = _entityIcon(eid, dom);
    const eidA = escapeHtmlAttr(eid);
    const sA = escapeHtmlAttr(slug);

    let control = '';
    const caps = ((ent.attributes || {}).capabilities) || {};
    const controllable = ent.controllable !== false && CONTROLLABLE.includes(dom);
    if (controllable && (dom === 'switch' || dom === 'light' || dom === 'input_boolean' || dom === 'fan' || dom === 'humidifier' || dom === 'water_heater' || dom === 'climate')) {
        const action = isOn ? 'turn_off' : 'turn_on';
        control = `<button type="button" role="switch" aria-checked="${isOn}"
            class="px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${isOn ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}"
            onclick="event.stopPropagation(); window.controlIntegrationEntity('${sA}','${eidA}','${action}', this)">
            ${isOn ? 'ON' : 'OFF'}
        </button>`;
    } else if (controllable && (dom === 'cover' || dom === 'lock')) {
        const action = isOn ? (dom === 'lock' ? 'lock' : 'close_cover') : (dom === 'lock' ? 'unlock' : 'open_cover');
        control = `<button type="button"
            class="px-3 py-1.5 rounded-full text-[11px] font-bold border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 shrink-0"
            onclick="event.stopPropagation(); window.controlIntegrationEntity('${sA}','${eidA}','${action}', this)">
            ${escapeHtml(action.replace('_', ' '))}
        </button>`;
    } else if (controllable && dom === 'vacuum') {
        const stateLbl = STATE_LABELS_RO[lower] || state;
        const vBtn = (action, ic, title) => `<button type="button" title="${title}" aria-label="${title}"
            class="w-8 h-8 rounded-full border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-accent shrink-0 flex items-center justify-center transition-colors"
            onclick="event.stopPropagation(); window.controlIntegrationEntity('${sA}','${eidA}','${action}', this)">
            <i class="fas ${ic} text-[11px]"></i>
        </button>`;
        control = `<div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] mono ${tone} mr-0.5">${escapeHtml(stateLbl)}</span>
            ${vBtn('start', 'fa-play', 'Pornește')}
            ${vBtn('stop', 'fa-stop', 'Oprește')}
            ${vBtn('return_to_base', 'fa-house', 'Andocare')}
        </div>`;
    } else if (dom === 'number' && Number.isFinite(Number(ent.state))) {
        const min = caps.min ?? 0, max = caps.max ?? 100, step = caps.step ?? 1;
        const val = Number(ent.state);
        control = `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}"
            class="w-24 md:w-32 shrink-0 accent-accent"
            onclick="event.stopPropagation()"
            onchange="event.stopPropagation(); window.controlIntegrationEntity('${sA}','${eidA}','set', this, { value: parseFloat(this.value) })">`;
    } else if (dom === 'select' && Array.isArray(caps.options) && caps.options.length) {
        control = `<select class="bg-white/5 border border-white/10 rounded-lg text-[11px] text-slate-200 px-2 py-1.5 shrink-0"
            onclick="event.stopPropagation()"
            onchange="event.stopPropagation(); window.controlIntegrationEntity('${sA}','${eidA}','set', this, { value: this.value })">
            ${caps.options.map(o => {
                const v = (o && typeof o === 'object') ? String(o.value ?? o.label ?? '') : String(o);
                const lbl = (o && typeof o === 'object') ? String(o.label ?? o.value ?? '') : String(o);
                return `<option value="${escapeHtmlAttr(v)}" ${v.toLowerCase() === lower ? 'selected' : ''}>${escapeHtml(lbl)}</option>`;
            }).join('')}
        </select>`;
    }

    const encoded = encodeURIComponent(JSON.stringify(ent)).replace(/'/g, '%27');
    return `<div class="flex items-center gap-3 px-3 py-3 bg-white/[0.03] border border-white/5 rounded-xl cursor-pointer hover:bg-white/[0.06] hover:border-accent/20 transition-colors"
        onclick="window.__openIntegrationEntityCard('${encoded}')">
        <i class="fas ${icon} text-accent/70 text-sm w-4 text-center shrink-0"></i>
        <div class="min-w-0 flex-1">
            <div class="text-[12px] font-semibold text-slate-100 fade-edge-r">${name}</div>
            <div class="text-[10px] text-slate-500 mono fade-edge-r">${escapeHtml(eid)}</div>
        </div>
        ${control
            ? ''
            : `<span class="text-[11px] mono ${tone} truncate max-w-[9rem] text-right shrink-0" data-entity-state="${eidA}">${escapeHtml(state)}${unit}</span>`}
        ${control}
    </div>`;
}

// Pagination for the entity list inside the device-detail modal.
const _ENTITY_PAGE_SIZE = 5;
const _entityPageState = new Map(); // key: `${slug}::${deviceId}` -> page index (0-based)

function _entityPageKey(slug, deviceId) { return `${slug}::${deviceId}`; }

function _renderPaginatedEntityList(ents, slug, deviceId) {
    const total = ents.length;
    const pageSize = _ENTITY_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const key = _entityPageKey(slug, deviceId);
    let page = _entityPageState.get(key) || 0;
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    _entityPageState.set(key, page);

    const start = page * pageSize;
    const slice = ents.slice(start, start + pageSize);
    const rows = `<div class="space-y-2" data-entity-list>${slice.map(e => _renderEntityControlRow(e, slug)).join('')}</div>`;

    if (pages <= 1) return rows;

    const sA = escapeHtmlAttr(slug);
    const dA = escapeHtmlAttr(deviceId);
    const prevDisabled = page === 0;
    const nextDisabled = page >= pages - 1;
    const pager = `
    <div class="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/5" data-entity-pager>
        <button type="button" data-entity-page-prev
            ${prevDisabled ? 'disabled' : ''}
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            <i class="fas fa-chevron-left mr-1"></i>Înapoi
        </button>
        <span class="text-[11px] text-slate-500 mono">${page + 1} / ${pages} <span class="opacity-60">·</span> ${total} entit.</span>
        <button type="button" data-entity-page-next
            ${nextDisabled ? 'disabled' : ''}
            data-slug="${sA}" data-device="${dA}"
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            Înainte<i class="fas fa-chevron-right ml-1"></i>
        </button>
    </div>`;
    return rows + pager;
}

function _wireEntityListPagination(body, ents, slug, deviceId) {
    const key = _entityPageKey(slug, deviceId);
    const pages = Math.max(1, Math.ceil(ents.length / _ENTITY_PAGE_SIZE));
    const rerender = () => {
        const list = _renderPaginatedEntityList(ents, slug, deviceId);
        const oldList = body.querySelector('[data-entity-list]');
        const oldPager = body.querySelector('[data-entity-pager]');
        if (oldPager) oldPager.remove();
        if (oldList) {
            const wrap = document.createElement('div');
            wrap.innerHTML = list;
            oldList.replaceWith(...wrap.childNodes);
        }
        _wireEntityListPagination(body, ents, slug, deviceId);
    };
    const prev = body.querySelector('[data-entity-page-prev]');
    const next = body.querySelector('[data-entity-page-next]');
    if (prev) prev.onclick = () => {
        const p = (_entityPageState.get(key) || 0) - 1;
        _entityPageState.set(key, Math.max(0, p));
        rerender();
    };
    if (next) next.onclick = () => {
        const p = (_entityPageState.get(key) || 0) + 1;
        _entityPageState.set(key, Math.min(pages - 1, p));
        rerender();
    };
}

function _openIntegrationEntityDetailModal(entity, slug) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body || !entity) return;

    stopCameraPreviewRefresh();
    modal.querySelectorAll('hyve-camera-live-player').forEach(el => {
        try { el.pauseStream?.(); } catch (_) {}
    });

    const dom = String(entity.domain || String(entity.entity_id || '').split('.')[0] || '').toLowerCase();
    const dc = ((entity.attributes || {}).capabilities || {}).device_class || (entity.attributes || {}).device_class || '';
    const icon = getDomainIcon(dom, dc);
    if (iconEl) iconEl.className = `fas ${icon}`;
    if (labelEl) labelEl.textContent = entity.name || entity.entity_id || 'Entity';

    body.innerHTML = renderEntityModal(entity, slug || _exposedDevicesState?.slug || entity.source || '');
    if (modal.parentNode !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    startCameraPreviewRefresh();
}

window.__openIntegrationEntityCard = function(encoded) {
    let entity;
    try {
        entity = JSON.parse(decodeURIComponent(encoded));
    } catch (_) {
        return;
    }
    if (!entity || !entity.entity_id) return;
    _openIntegrationEntityDetailModal(entity, _exposedDevicesState?.slug || entity.source || '');
};

window.__openIntegrationDeviceModal = function(idx, slug) {
    const state = _exposedDevicesState;
    if (!state || !integrationSlugsMatch(state.slug, slug)) return;
    const dev = state.devices[idx];
    if (!dev) return;
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body) return;
    if (iconEl) iconEl.className = 'fas fa-microchip';
    if (labelEl) labelEl.textContent = t('common.device') || 'Device';

    const name = escapeHtml(dev.name || dev.device_id || (t('common.device') || 'Device'));
    const sub = [dev.model, dev.manufacturer].filter(Boolean).join(' · ');
    const ents = (dev.entities || []).slice().sort((a, b) => {
        const order = { switch: 0, light: 1, cover: 2, lock: 3, climate: 4, number: 5, select: 6, button: 7, binary_sensor: 8, sensor: 9 };
        const da = String(a.entity_id || '').split('.')[0];
        const db = String(b.entity_id || '').split('.')[0];
        const oa = order[da] ?? 99, ob = order[db] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const sA = escapeHtmlAttr(slug);
    const didA = escapeHtmlAttr(dev.device_id || '');
    const curA = escapeHtmlAttr(dev.name || dev.device_id || '');

    const hero = `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-3 mb-3 flex items-start gap-3">
        <div class="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
            <i class="fas fa-microchip text-accent text-base"></i>
        </div>
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-[9px] uppercase tracking-widest text-slate-500">
                <span>Dispozitiv</span>
                <button type="button" id="entity-detail-rename-btn" class="hover:text-accent transition-colors" title="Redenumește dispozitivul">
                    <i class="fas fa-pen text-[10px]"></i>
                </button>
            </div>
            <div id="entity-detail-name-view" class="text-sm font-semibold text-slate-100 mt-0.5 break-words leading-snug">${name}</div>
            <div id="entity-detail-name-edit" class="hidden mt-1 flex items-center gap-2">
                <input type="text" id="entity-detail-name-input" value="${curA}"
                    class="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-accent/40">
                <button type="button" id="entity-detail-name-save" class="px-2 py-1 rounded-lg bg-accent/20 border border-accent/40 text-accent text-[11px] font-semibold hover:bg-accent/30 shrink-0">
                    <i class="fas fa-check"></i>
                </button>
                <button type="button" id="entity-detail-name-cancel" class="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-[11px] hover:bg-white/10 shrink-0">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            ${sub ? `<div class="text-[10px] text-slate-500 break-words mt-0.5">${escapeHtml(sub)}</div>` : ''}
            <div class="text-[9px] text-slate-500 mono break-all mt-1 leading-snug">${escapeHtml(dev.device_id || '')}</div>
        </div>
        <div class="text-right shrink-0">
            <div class="text-lg font-semibold text-slate-200 mono leading-none">${ents.length}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500 mt-0.5">entit.</div>
        </div>
    </div>`;
    const list = ents.length
        ? _renderPaginatedEntityList(ents, slug, dev.device_id || '')
        : `<div class="text-[11px] text-slate-500 text-center py-6">Niciun control disponibil.</div>`;
    body.innerHTML = hero + list;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    _wireEntityListPagination(body, ents, slug, dev.device_id || '');

    // Wire inline rename UI
    const view = body.querySelector('#entity-detail-name-view');
    const edit = body.querySelector('#entity-detail-name-edit');
    const input = body.querySelector('#entity-detail-name-input');
    const renameBtn = body.querySelector('#entity-detail-rename-btn');
    const saveBtn = body.querySelector('#entity-detail-name-save');
    const cancelBtn = body.querySelector('#entity-detail-name-cancel');
    const showEdit = () => { view?.classList.add('hidden'); edit?.classList.remove('hidden'); input?.focus(); input?.select(); };
    const hideEdit = () => { edit?.classList.add('hidden'); view?.classList.remove('hidden'); };
    if (renameBtn) renameBtn.onclick = showEdit;
    if (cancelBtn) cancelBtn.onclick = hideEdit;
    const submit = () => window.__renameIntegrationDevice(slug, dev.device_id || '', dev.name || dev.device_id || '', input?.value || '');
    if (saveBtn) saveBtn.onclick = submit;
    if (input) input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); hideEdit(); }
    };
};

window.controlIntegrationEntity = async function(slug, entityId, action, btn, data) {
    if (btn) { btn.disabled = true; btn.dataset._prev = btn.innerHTML || ''; }
    // Optimistic local update so the UI reacts instantly without waiting for
    // the server to round-trip a full re-fetch.
    let prevState = null;
    let touchedEnt = null;
    let touchedIdx = -1;
    if (_exposedDevicesState.slug && integrationSlugsMatch(_exposedDevicesState.slug, slug)) {
        for (let i = 0; i < _exposedDevicesState.devices.length; i++) {
            const found = (_exposedDevicesState.devices[i].entities || []).find(e => e.entity_id === entityId);
            if (found) { touchedEnt = found; touchedIdx = i; break; }
        }
        if (touchedEnt) {
            prevState = touchedEnt.state;
            if (action === 'turn_on' || action === 'open_cover' || action === 'unlock') touchedEnt.state = 'on';
            else if (action === 'turn_off' || action === 'close_cover' || action === 'lock') touchedEnt.state = 'off';
            else if (action === 'set' && data && data.value !== undefined) touchedEnt.state = String(data.value);
            const modal = document.getElementById('entity-detail-modal');
            if (modal && !modal.classList.contains('hidden') && touchedIdx >= 0) {
                window.__openIntegrationDeviceModal(touchedIdx, slug);
            }
        }
    }
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, action, data: data || {} }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.detail || out.message || 'Acțiunea a eșuat.');
    } catch (err) {
        // Rollback optimistic update
        if (touchedEnt) {
            touchedEnt.state = prevState;
            const modal = document.getElementById('entity-detail-modal');
            if (modal && !modal.classList.contains('hidden') && touchedIdx >= 0) {
                window.__openIntegrationDeviceModal(touchedIdx, slug);
            }
        }
        if (typeof showToast === 'function') showToast(err.message || 'Eroare', 'error', 2500);
    } finally {
        if (btn) { btn.disabled = false; }
    }
};

window.__renameIntegrationDevice = async function(slug, deviceId, currentName, providedName) {
    let next = providedName;
    if (next == null) {
        next = window.prompt('Nume nou pentru dispozitiv:', currentName || '');
        if (next == null) return;
    }
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === currentName) return;
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/device/${encodeURIComponent(deviceId)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed, current_name: currentName || deviceId }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.detail || out.message || 'Rename a eșuat.');
        // Optimistic local update — no full re-fetch needed since the alias
        // is the source of truth and lives in our YAML.
        if (_exposedDevicesState.slug && integrationSlugsMatch(_exposedDevicesState.slug, slug)) {
            const idx = _exposedDevicesState.devices.findIndex(d => (d.device_id || '') === deviceId);
            if (idx >= 0) {
                _exposedDevicesState.devices[idx].name = trimmed;
                const grid = document.getElementById('integration-exposed-entities-grid');
                if (grid) grid.innerHTML = _exposedDevicesState.devices.map((d, i) => _devCardHtml(d, i, slug)).join('');
                const modal = document.getElementById('entity-detail-modal');
                if (modal && !modal.classList.contains('hidden')) {
                    window.__openIntegrationDeviceModal(idx, slug);
                }
            }
        }
    } catch (err) {
        if (typeof showToast === 'function') showToast(err.message || 'Eroare', 'error', 3000);
    }
};

function slugForId(s) {
    if (!s || typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || '';
}

function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function addCctvCameraRow(camera) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    const name = (camera && camera.name) || '';
    const rtsp = (camera && camera.rtsp_url) || '';
    const context = (camera && camera.context) || '';
    const id = (camera && camera.id) || '';
    const ctxPlaceholder = t('config.cctv_camera_context') || 'e.g. 2 cars, one green one white';
    const row = document.createElement('div');
    row.className = 'cctv-camera-row flex flex-wrap gap-2 p-3 rounded-xl bg-slate-900/50 border border-white/5';
    row.innerHTML = `
        <input type="text" class="cctv-cam-name flex-1 min-w-[100px] bg-slate-900 border border-white/5 rounded-lg p-2 text-xs text-slate-300 focus:border-violet-400 outline-none" placeholder="${escapeHtmlAttr(t('config.cctv_camera_name') || 'Name')}" value="${escapeHtmlAttr(name)}">
        <input type="text" class="cctv-cam-rtsp flex-1 min-w-[120px] bg-slate-900 border border-white/5 rounded-lg p-2 text-xs mono text-slate-400 focus:border-violet-400 outline-none" placeholder="rtsp://..." value="${escapeHtmlAttr(rtsp)}">
        <input type="text" class="cctv-cam-context w-full min-w-0 bg-slate-900 border border-white/5 rounded-lg p-2 text-xs text-slate-400 focus:border-violet-400 outline-none" placeholder="${escapeHtmlAttr(ctxPlaceholder)}" value="${escapeHtmlAttr(context)}" title="${escapeHtmlAttr(t('config.cctv_camera_context_hint') || 'Expected scene; model will flag if something does not match')}">
        <button type="button" class="cctv-cam-remove px-2 py-1.5 rounded-lg text-[10px] text-red-400 hover:bg-red-500/20 border border-red-500/20 shrink-0" data-i18n="common.delete">Delete</button>
    `;
    if (id) row.dataset.cctvId = id;
    list.appendChild(row);
    const removeBtn = row.querySelector('.cctv-cam-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => row.remove());
}

function renderCctvCameras(cameras) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    list.innerHTML = '';
    (cameras || []).forEach(cam => addCctvCameraRow(cam));
}

function renderUserPhonesList(phones) {
    const listEl = document.getElementById('user-phones-list');
    if (!listEl) return;
    if (!phones.length) {
        listEl.innerHTML = `<span class="text-slate-500 text-[11px]">—</span>`;
        return;
    }
    listEl.innerHTML = phones.map(num => {
        const safeNum = escapeHtml(num);
        const escNum = num.replace(/'/g, "\\'");
        return `
        <div class="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg bg-white/[0.02] border border-white/5">
            <span class="mono text-slate-300">${safeNum}</span>
            <button type="button" onclick="unlinkUserPhone('${escNum}')" class="text-[10px] text-red-400 hover:bg-red-500/20 px-2 py-0.5 rounded">${t('common.delete')}</button>
        </div>`;
    }).join('');
}

export async function addUserPhone(phone, inputEl) {
    if (!phone) return;
    try {
        const res = await apiCall('/api/users/link-whatsapp', { method: 'POST', body: { phone_number: phone } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Error', 'error');
            return;
        }
        if (inputEl) inputEl.value = '';
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    } catch (e) { showToast(t('common.error'), 'error'); }
}

export async function unlinkUserPhone(number) {
    if (!number || !(await showConfirm(t('config.unlink_phone_confirm')))) return;
    try {
        const res = await apiCall('/api/users/me/phones/unlink', { method: 'POST', body: { number } });
        if (!res.ok) throw new Error();
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    } catch (e) { showToast(t('common.error'), 'error'); }
}

// ─── MODEL PROFILES ─────────────────────────────────────────────────
let _modelProfiles = [];
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
    } catch (e) { console.warn('loadModelProfiles error', e); }
}

function renderAutoRouterStats(stats) {
    const el = document.getElementById('auto-router-stats');
    if (!el) return;
    if (!stats || typeof stats.local !== 'number' || typeof stats.api !== 'number') {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    const label = typeof t === 'function' ? t('config.auto_router_stats_label') : 'Auto (this session):';
    el.innerHTML = `${label} <span class="text-slate-400">${stats.local} local</span>, <span class="text-slate-400">${stats.api} API</span>`;
}

function renderProfilesList() {
    const container = document.getElementById('model-profiles-list');
    if (!container) return;
    if (!_modelProfiles.length) {
        container.innerHTML = '<p class="text-[10px] text-slate-600 col-span-2 text-center py-4">Niciun profil salvat. Creează un profil pentru comutare rapidă.</p>';
        return;
    }
    container.innerHTML = _modelProfiles.map((p, index) => {
        const visible = p.visible_in_selector !== false;
        const providerLabel = { local: 'Local', z_ai: 'Z.AI', openai: 'OpenAI', grok: 'Grok', deepseek: 'DeepSeek' }[p.provider] || p.provider;
        const auxBadge = p.aux_llm_enabled ? '<span class="inline-flex items-center text-[9px] bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded-full ml-1">AUX</span>' : '';
        const coderBadge = p.coder_enabled ? '<span class="inline-flex items-center text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded-full ml-0.5">COD</span>' : '';
        const visionBadge = p.vision_enabled ? '<span class="inline-flex items-center text-[9px] bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded-full ml-0.5">VIS</span>' : '';
        const embedBadge = p.embed_enabled ? '<span class="inline-flex items-center text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded-full ml-0.5">EMB</span>' : '';
        const personaOverrideBadge = (p.persona_override || '').trim() ? '<span class="inline-flex items-center gap-0.5 text-[9px] bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded-full ml-0.5" title="' + (typeof t === 'function' ? t('config.profile_persona_override_badge_title') : 'Override prompt activ') + '"><i class="fas fa-file-alt text-[8px]"></i><span>' + (typeof t === 'function' ? t('config.profile_prompt_override_pill') : 'Prompt') + '</span></span>' : '';
        const inSelectorClass = visible ? ' profile-card-in-selector' : '';
        const reasoning = p.capability_reasoning !== false;
        const tools = p.capability_tool_calling !== false;
        const vision = p.capability_vision !== false;
        const capIcons = [reasoning && '<i class="fas fa-brain profile-cap-icon" title="Reasoning"></i>', tools && '<i class="fas fa-wrench profile-cap-icon" title="Tool calling"></i>', vision && '<i class="fas fa-eye profile-cap-icon" title="Vision"></i>'].filter(Boolean).join('');
        const canMoveUp = index > 0;
        const canMoveDown = index < _modelProfiles.length - 1;
        const moveUpTitle = typeof t === 'function' ? t('config.profile_move_up') : 'Sus';
        const moveDownTitle = typeof t === 'function' ? t('config.profile_move_down') : 'Jos';
        const orderBtns = `<span class="profile-card-order-btns">
            ${canMoveUp ? `<button type="button" class="profile-card-order-btn" onclick="moveProfileOrder('${escapeHtml(p.id)}', 'up'); event.stopPropagation();" title="${moveUpTitle}" aria-label="${moveUpTitle}"><i class="fas fa-chevron-up"></i></button>` : '<span class="profile-card-order-btn profile-card-order-btn-disabled" aria-hidden="true"><i class="fas fa-chevron-up"></i></span>'}
            ${canMoveDown ? `<button type="button" class="profile-card-order-btn" onclick="moveProfileOrder('${escapeHtml(p.id)}', 'down'); event.stopPropagation();" title="${moveDownTitle}" aria-label="${moveDownTitle}"><i class="fas fa-chevron-down"></i></button>` : '<span class="profile-card-order-btn profile-card-order-btn-disabled" aria-hidden="true"><i class="fas fa-chevron-down"></i></span>'}
        </span>`;
        return `
            <div class="profile-card${inSelectorClass}" data-profile-id="${escapeHtml(p.id)}">
                <span class="profile-card-drag-handle" draggable="true" data-profile-id="${escapeHtml(p.id)}" title="${typeof t === 'function' ? t('config.profile_drag_reorder') : 'Mută pentru a reordona'}"><i class="fas fa-grip-vertical"></i></span>
                ${orderBtns}
                <div class="profile-card-dot" style="background:${escapeHtml(p.color || '#6366f1')}"></div>
                <div class="profile-card-info">
                    <div class="profile-card-name">${escapeHtml(p.name)}${auxBadge}${coderBadge}${visionBadge}${embedBadge}${personaOverrideBadge}</div>
                    <div class="profile-card-meta"><span class="profile-card-meta-text">${escapeHtml(providerLabel)} · ${escapeHtml(p.model_name || '?')}</span>${capIcons ? `<span class="profile-card-caps">${capIcons}</span>` : ''}</div>
                </div>
                <button type="button" class="profile-card-activate" onclick="openProfileCardMenu('${escapeHtml(p.id)}', event)">${typeof t === 'function' ? t('config.profile_options_btn') : 'Opțiuni'}</button>
            </div>`;
    }).join('');
    bindProfileCardDragDrop(container);
}

window.moveProfileOrder = async function(profileId, direction) {
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
        showToast(typeof t === 'function' ? t('config.profile_order_saved') : 'Ordine salvată', 'success');
        await loadModelProfiles();
    } catch (err) {
        showToast(typeof t === 'function' ? t('config.profile_order_error') : 'Eroare la salvare ordine', 'error');
    }
};

function bindProfileCardDragDrop(container) {
    if (!container || container.dataset.dragBound === '1') return;
    container.dataset.dragBound = '1';
    let draggedId = null;
    container.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.profile-card-drag-handle');
        if (!handle) return;
        const id = handle.getAttribute('data-profile-id');
        if (!id) return;
        draggedId = id;
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        const card = handle.closest('.profile-card');
        if (card) card.classList.add('dragging');
    });
    container.addEventListener('dragend', (e) => {
        if (e.target.closest('.profile-card-drag-handle')) {
            container.querySelectorAll('.profile-card').forEach(el => el.classList.remove('dragging', 'drag-over'));
        }
        draggedId = null;
    });
    container.addEventListener('dragover', (e) => {
        const card = e.target.closest('.profile-card');
        if (!card || !draggedId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
    });
    container.addEventListener('dragleave', (e) => {
        const card = e.target.closest('.profile-card');
        if (card && !card.contains(e.relatedTarget)) card.classList.remove('drag-over');
    });
    container.addEventListener('drop', async (e) => {
        const card = e.target.closest('.profile-card');
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
            showToast(typeof t === 'function' ? t('config.profile_order_saved') : 'Ordine salvată', 'success');
            await loadModelProfiles();
        } catch (err) {
            showToast(typeof t === 'function' ? t('config.profile_order_error') : 'Eroare la salvare ordine', 'error');
        }
    });
}

function renderModelSelector(data) {
    const listEl = document.getElementById('model-selector-profiles');
    const wrapEl = document.querySelector('.model-selector-wrap');
    if (!listEl) return;

    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (_defaultProfileId || '').toLowerCase() === 'auto';
    const activeProfile = isAuto ? null : (visibleProfiles.find(p => p.id === _defaultProfileId) || visibleProfiles[0]);

    const accentColor = (activeProfile?.color || '#38bdf8').trim();
    if (wrapEl) wrapEl.style.setProperty('--selector-accent', accentColor);

    /* The button is now a cog icon — no label text to set.
       The --selector-accent CSS variable handles the color. */

    const autoLabel = typeof t === 'function' ? t('config.model_selector_auto') : 'Auto';
    const autoButton = `
        <button type="button" class="model-selector-item${isAuto ? ' active' : ''}" onclick="activateProfile('auto');closeModelSelector()">
            <div class="model-selector-item-dot" style="background:#38bdf8"></div>
            <div class="model-selector-item-info">
                <div class="model-selector-item-name">${escapeHtml(autoLabel)}</div>
                <div class="model-selector-item-model">${escapeHtml('')}</div>
            </div>
            <i class="fas fa-check model-selector-item-check"></i>
        </button>`;

    if (!visibleProfiles.length) {
        listEl.innerHTML = autoButton + '<div class="model-selector-empty"><i class="fas fa-info-circle mr-1"></i>Setări → Profiluri Model</div>';
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
            <button type="button" class="model-selector-item${isActive ? ' active' : ''}" onclick="activateProfile('${escapeHtml(p.id)}');closeModelSelector()">
                <div class="model-selector-item-dot" style="background:${escapeHtml(p.color || '#6366f1')}"></div>
                <div class="model-selector-item-info">
                    <div class="model-selector-item-name">${escapeHtml(p.name)}</div>
                    <div class="model-selector-item-model">${escapeHtml(p.model_name || '')}</div>
                </div>
                ${capsHtml ? `<div class="model-selector-item-caps">${capsHtml}</div>` : ''}
                <i class="fas fa-check model-selector-item-check"></i>
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
    const imageItem = document.querySelector('.chat-attach-balloon-item[data-attach="image"]');
    const cameraItem = document.querySelector('.chat-attach-balloon-item[data-attach="camera"]');
    if (imageItem) imageItem.style.display = hasVision ? '' : 'none';
    if (cameraItem) cameraItem.style.display = hasVision ? '' : 'none';

    const btnAttach = document.getElementById('btn-attach');
    if (!btnAttach) return;
    const iconEl = btnAttach.querySelector('i.fas');
    if (!iconEl) return;
    if (!hasVision) {
        btnAttach.setAttribute('data-single-attach', 'document');
        iconEl.className = 'fas fa-file-alt';
        const docLabel = typeof t === 'function' ? t('chat.attach_document') : 'Încarcă document';
        btnAttach.setAttribute('aria-label', docLabel);
        btnAttach.title = docLabel;
        btnAttach.setAttribute('aria-haspopup', 'false');
    } else {
        btnAttach.removeAttribute('data-single-attach');
        iconEl.className = 'fas fa-plus';
        const attachLabel = typeof t === 'function' ? t('chat.attach_image') : 'Atașare';
        btnAttach.setAttribute('aria-label', attachLabel);
        btnAttach.title = attachLabel;
        btnAttach.setAttribute('aria-haspopup', 'true');
    }
}

window.syncVisionCapabilityCheckbox = function() {
    const visionEnabledEl = document.getElementById('profile-vision-enabled');
    const visionUrlEl = document.getElementById('profile-vision-url');
    const visionModelEl = document.getElementById('profile-vision-model');
    const capVision = document.getElementById('profile-capability-vision');
    if (!capVision) return;
    const visionConfigured = visionEnabledEl?.checked && ((visionUrlEl?.value || '').trim() || (visionModelEl?.value || '').trim());
    if (visionConfigured) {
        capVision.checked = true;
        capVision.disabled = true;
    } else {
        capVision.disabled = false;
    }
};

window.showProfileEditor = function(profileId) {
    const overlay = document.getElementById('profile-editor-overlay');
    if (!overlay) return;
    const titleEl = document.getElementById('profile-editor-title');
    const idEl = document.getElementById('profile-edit-id');
    const nameEl = document.getElementById('profile-name');
    const provEl = document.getElementById('profile-provider');
    const urlEl = document.getElementById('profile-url');
    const modelEl = document.getElementById('profile-model');
    const keyEl = document.getElementById('profile-api-key');
    const tempEl = document.getElementById('profile-temperature');
    const timeoutEl = document.getElementById('profile-timeout');
    const ctxEl = document.getElementById('profile-context');
    const colorEl = document.getElementById('profile-color');
    const _colorSwatches = document.getElementById('profile-color-swatches');
    const _colorHex = document.getElementById('profile-color-hex');
    const _colorPreview = document.getElementById('profile-color-preview');
    function _syncColor(hex) {
        if (!_colorSwatches) return;
        const norm = (hex || '').toLowerCase();
        colorEl.value = norm;
        _colorSwatches.querySelectorAll('.color-swatch').forEach(s => {
            s.classList.toggle('active', s.dataset.color === norm);
        });
        if (_colorPreview) _colorPreview.style.background = norm;
        if (_colorHex && document.activeElement !== _colorHex) _colorHex.value = norm;
    }
    if (_colorSwatches) {
        _colorSwatches.addEventListener('click', e => {
            const sw = e.target.closest('.color-swatch');
            if (sw) { _syncColor(sw.dataset.color); }
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
    const auxEnabledEl = document.getElementById('profile-aux-enabled');
    const auxUrlEl = document.getElementById('profile-aux-url');
    const auxModelEl = document.getElementById('profile-aux-model');
    const auxKeyEl = document.getElementById('profile-aux-key');
    const auxFields = document.getElementById('profile-aux-fields');
    const keyRow = document.getElementById('profile-api-key-row');
    // Coder fields
    const coderEnabledEl = document.getElementById('profile-coder-enabled');
    const coderProvEl = document.getElementById('profile-coder-provider');
    const coderUrlEl = document.getElementById('profile-coder-url');
    const coderModelEl = document.getElementById('profile-coder-model');
    const coderKeyEl = document.getElementById('profile-coder-key');
    const coderTimeoutEl = document.getElementById('profile-coder-timeout');
    const coderFields = document.getElementById('profile-coder-fields');
    // Vision fields
    const visionEnabledEl = document.getElementById('profile-vision-enabled');
    const visionProvEl = document.getElementById('profile-vision-provider');
    const visionUrlEl = document.getElementById('profile-vision-url');
    const visionModelEl = document.getElementById('profile-vision-model');
    const visionKeyEl = document.getElementById('profile-vision-key');
    const visionTimeoutEl = document.getElementById('profile-vision-timeout');
    const visionRespondEl = document.getElementById('profile-vision-respond-directly');
    const visionFields = document.getElementById('profile-vision-fields');
    // Embedding fields
    const embedEnabledEl = document.getElementById('profile-embed-enabled');
    const embedModelEl = document.getElementById('profile-embed-model');
    const embedFields = document.getElementById('profile-embed-fields');

    if (profileId) {
        const p = _modelProfiles.find(x => x.id === profileId);
        if (!p) return;
        titleEl.textContent = (typeof t === 'function') ? t('config.profile_editor_title_edit') : 'Editează profil';
        idEl.value = p.id;
        nameEl.value = p.name || '';
        provEl.value = p.provider || 'local';
        urlEl.value = p.target_url || '';
        modelEl.value = p.model_name || '';
        keyEl.value = p.api_key || '';
        tempEl.value = p.temperature ?? 0.7;
        timeoutEl.value = p.timeout ?? 120;
        ctxEl.value = p.context_length ?? 24000;
        colorEl.value = p.color || '#6366f1';
        _syncColor(colorEl.value);
        const personaOverrideEl = document.getElementById('profile-persona-override');
        if (personaOverrideEl) personaOverrideEl.value = p.persona_override || '';
        const capReason = document.getElementById('profile-capability-reasoning');
        const capTools = document.getElementById('profile-capability-tools');
        const capVision = document.getElementById('profile-capability-vision');
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
        if (coderTimeoutEl) coderTimeoutEl.value = coder.timeout ?? 180;
        if (coderFields) coderFields.classList.toggle('hidden', !p.coder_enabled);
        // Vision
        if (visionEnabledEl) visionEnabledEl.checked = !!p.vision_enabled;
        const vision = p.vision_llm || {};
        if (visionProvEl) visionProvEl.value = vision.provider || 'local';
        if (visionUrlEl) visionUrlEl.value = vision.target_url || '';
        if (visionModelEl) visionModelEl.value = vision.model_name || '';
        if (visionKeyEl) visionKeyEl.value = vision.api_key || '';
        if (visionTimeoutEl) visionTimeoutEl.value = vision.timeout ?? 60;
        if (visionRespondEl) visionRespondEl.checked = !!vision.respond_directly;
        if (visionFields) visionFields.classList.toggle('hidden', !p.vision_enabled);
        // Embedding
        if (embedEnabledEl) embedEnabledEl.checked = !!p.embed_enabled;
        const embed = p.librarian || {};
        if (embedModelEl) embedModelEl.value = embed.model_name || '';
        if (embedFields) embedFields.classList.toggle('hidden', !p.embed_enabled);
        syncVisionCapabilityCheckbox();
    } else {
        titleEl.textContent = (typeof t === 'function') ? t('config.profile_editor_title_new') : 'Profil nou';
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
        const personaOverrideEl = document.getElementById('profile-persona-override');
        if (personaOverrideEl) personaOverrideEl.value = '';
        const capReason = document.getElementById('profile-capability-reasoning');
        const capTools = document.getElementById('profile-capability-tools');
        const capVision = document.getElementById('profile-capability-vision');
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

window.closeProfileEditor = function() {
    closeSubPage('profile-editor-overlay');
};

window.onProfileProviderChange = function() {
    const prov = document.getElementById('profile-provider');
    const url = document.getElementById('profile-url');
    const model = document.getElementById('profile-model');
    const keyRow = document.getElementById('profile-api-key-row');
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

window.onProfileSubProviderChange = function(type) {
    const prov = document.getElementById(`profile-${type}-provider`);
    const url = document.getElementById(`profile-${type}-url`);
    const model = document.getElementById(`profile-${type}-model`);
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

window.saveProfile = async function(e) {
    if (e) e.preventDefault();
    const payload = {
        id: document.getElementById('profile-edit-id')?.value || '',
        name: document.getElementById('profile-name')?.value || '',
        provider: document.getElementById('profile-provider')?.value || 'local',
        target_url: document.getElementById('profile-url')?.value || '',
        model_name: document.getElementById('profile-model')?.value || '',
        api_key: document.getElementById('profile-api-key')?.value || '',
        temperature: parseFloat(document.getElementById('profile-temperature')?.value) || 0.7,
        timeout: parseInt(document.getElementById('profile-timeout')?.value, 10) || 120,
        context_length: parseInt(document.getElementById('profile-context')?.value, 10) || 24000,
        max_tokens: 2048,
        color: document.getElementById('profile-color')?.value || '#6366f1',
        persona_override: (document.getElementById('profile-persona-override')?.value || '').trim() || null,
        capability_reasoning: document.getElementById('profile-capability-reasoning')?.checked !== false,
        capability_tool_calling: document.getElementById('profile-capability-tools')?.checked !== false,
        capability_vision: (function() {
            const visionEnabled = document.getElementById('profile-vision-enabled')?.checked;
            const visionUrl = (document.getElementById('profile-vision-url')?.value || '').trim();
            const visionModel = (document.getElementById('profile-vision-model')?.value || '').trim();
            if (visionEnabled && (visionUrl || visionModel)) return true;
            return document.getElementById('profile-capability-vision')?.checked !== false;
        })(),
        aux_llm_enabled: document.getElementById('profile-aux-enabled')?.checked || false,
        aux_llm: {
            target_url: document.getElementById('profile-aux-url')?.value || '',
            model_name: document.getElementById('profile-aux-model')?.value || '',
            api_key: document.getElementById('profile-aux-key')?.value || '',
        },
        coder_enabled: document.getElementById('profile-coder-enabled')?.checked || false,
        coder: {
            provider: document.getElementById('profile-coder-provider')?.value || 'local',
            target_url: document.getElementById('profile-coder-url')?.value || '',
            model_name: document.getElementById('profile-coder-model')?.value || '',
            api_key: document.getElementById('profile-coder-key')?.value || '',
            timeout: parseInt(document.getElementById('profile-coder-timeout')?.value, 10) || 180,
        },
        vision_enabled: document.getElementById('profile-vision-enabled')?.checked || false,
        vision_llm: {
            provider: document.getElementById('profile-vision-provider')?.value || 'local',
            target_url: document.getElementById('profile-vision-url')?.value || '',
            model_name: document.getElementById('profile-vision-model')?.value || '',
            api_key: document.getElementById('profile-vision-key')?.value || '',
            timeout: parseInt(document.getElementById('profile-vision-timeout')?.value, 10) || 60,
            respond_directly: document.getElementById('profile-vision-respond-directly')?.checked || false,
        },
        embed_enabled: document.getElementById('profile-embed-enabled')?.checked || false,
        librarian: {
            model_name: document.getElementById('profile-embed-model')?.value || '',
        },
    };
    try {
        const res = await apiCall('/api/model-profiles', { method: 'POST', body: payload });
        if (!res.ok) throw new Error('Save failed');
        showToast((typeof t === 'function') ? t('config.profile_saved') : 'Profil salvat', 'success');
        closeProfileEditor();
        await loadModelProfiles();
    } catch (e) { showToast((typeof t === 'function') ? t('config.profile_save_error') : 'Eroare la salvare', 'error'); }
};

window.deleteProfile = async function(profileId) {
    if (!(await showConfirm((typeof t === 'function' ? t('config.profile_delete_confirm') : 'Delete this profile?')))) return;
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        showToast((typeof t === 'function') ? t('config.profile_deleted') : 'Profile deleted', 'success');
        closeProfileCardMenu();
        await loadModelProfiles();
    } catch (e) { showToast((typeof t === 'function' ? t('common.error') : 'Error'), 'error'); }
};

window.openProfileCardMenu = function(profileId, ev) {
    if (ev) ev.stopPropagation();
    const modal = document.getElementById('profile-card-menu-modal');
    if (!modal) return;
    modal.dataset.profileId = profileId;
    const p = _modelProfiles.find(x => x.id === profileId);
    const visible = p && p.visible_in_selector !== false;
    const visibilityBtn = document.getElementById('profile-card-menu-visibility-btn');
    const visibilityText = document.getElementById('profile-card-menu-visibility-text');
    if (visibilityBtn) {
        visibilityBtn.dataset.visible = String(visible);
        visibilityBtn.classList.toggle('is-in-selector', visible);
        if (visibilityText) {
            visibilityText.textContent = visible ? (typeof t === 'function' ? t('config.profile_hide_from_selector') : 'Ascunde din selector') : (typeof t === 'function' ? t('config.profile_show_in_selector') : 'Afișează în selector');
        }
        const icon = visibilityBtn.querySelector('i');
        if (icon) {
            icon.className = visible ? 'fas fa-eye-slash mr-2' : 'fas fa-check-circle mr-2';
        }
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
};

window.closeProfileCardMenu = function() {
    const modal = document.getElementById('profile-card-menu-modal');
    if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); }
};

window.setProfileVisibility = async function(profileId, visible) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'PATCH', body: { visible_in_selector: visible } });
        if (!res.ok) throw new Error();
        showToast(visible ? (typeof t === 'function' ? t('config.profile_shown_in_selector') : 'Afișat în selector') : (typeof t === 'function' ? t('config.profile_hidden_from_selector') : 'Ascuns din selector'), 'success');
        await loadModelProfiles();
    } catch (e) { showToast(typeof t === 'function' ? t('config.profile_visibility_error') : 'Eroare', 'error'); }
};

{
    const menuModal = document.getElementById('profile-card-menu-modal');
    if (menuModal) {
        menuModal.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
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

window.duplicateProfile = async function(profileId) {
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
        if (!res.ok) throw new Error('Save failed');
        showToast(t('hy.profile_duplicated'), 'success');
        await loadModelProfiles();
    } catch (e) { showToast(t('hy.duplicate_error'), 'error'); }
};

/** Două flashuri în exteriorul barei la schimbarea modelului (același stil ca la streaming). */
function playChatBarGlow(profileId) {
    const bar = document.querySelector('.chat-input-inner');
    if (!bar) return;
    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (profileId || '').toLowerCase() === 'auto';
    const color = isAuto && visibleProfiles.length > 0
        ? (visibleProfiles[0].color || '#38bdf8').trim()
        : (visibleProfiles.find(p => p.id === profileId)?.color || '#38bdf8').trim();
    bar.style.setProperty('--chat-bar-flash-color', color);
    bar.classList.remove('chat-input-bar-flash');
    bar.offsetHeight;
    bar.classList.add('chat-input-bar-flash');
    bar.addEventListener('animationend', () => bar.classList.remove('chat-input-bar-flash'), { once: true });
}

window.activateProfile = async function(profileId) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}/activate`, { method: 'POST' });
        if (!res.ok) throw new Error();
        playChatBarGlow(profileId);
        await loadModelProfiles();
    } catch (e) { showToast(t('hy.activation_error'), 'error'); }
};

window.toggleModelSelector = function() {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    if (!balloon) return;
    const isOpen = !balloon.classList.contains('hidden');
    balloon.classList.toggle('hidden');
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
    // Close other balloons
    if (!isOpen) {
        const attachBalloon = document.getElementById('chat-attach-balloon');
        if (attachBalloon) attachBalloon.classList.add('hidden');
    }
};

window.closeModelSelector = function() {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    if (balloon) balloon.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
};

// Close model selector when clicking outside
document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.model-selector-wrap');
    if (wrap && !wrap.contains(e.target)) {
        closeModelSelector();
    }
});

export async function saveConfig(eOrOptions) {
    const isEventLike = !!(eOrOptions && typeof eOrOptions.preventDefault === 'function');
    const options = (!isEventLike && eOrOptions && typeof eOrOptions === 'object') ? eOrOptions : {};
    const silent = !!options.silent;

    if (isEventLike) eOrOptions.preventDefault();

    // Find the clicked save button (if any) and put it into a loading state
    const saveBtn = isEventLike ? (eOrOptions.currentTarget || eOrOptions.target?.closest('button')) : null;
    let originalBtnHtml = null;
    if (saveBtn) {
        originalBtnHtml = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.dataset.saving = 'true';
        saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.saving'))}</span>`;
    }
    const restoreBtn = () => {
        if (saveBtn && originalBtnHtml !== null) {
            saveBtn.disabled = false;
            delete saveBtn.dataset.saving;
            saveBtn.innerHTML = originalBtnHtml;
            originalBtnHtml = null;
        }
    };

    try {
    const langEl = document.getElementById('ui_language');
    const language = langEl ? langEl.value : 'en';

    if (window.__isAdmin === false) {
        try {
            const resp = await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        } catch (err) {
            showToast(t('updates.save_error') + (err.message || err), 'error');
            return;
        }
        const userPersona = document.getElementById('user_persona');
        if (userPersona) {
            try { await apiCall('/api/users/me', { method: 'PATCH', body: { persona: userPersona.value } }); } catch (_) {}
        }
        try { setLanguage(language); } catch (err) {}
        _refreshUiLanguageSelect(language);
        if (!silent) showToast(t('config.save_success'), 'success');
        return;
    }

    const parseList = (s) => (s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
    const wsTransportRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transportMode = wsTransportRadio && wsTransportRadio.checked ? 'websocket' : 'firebase';

    const config = {
        verbose_logging: (document.getElementById('logging_mode')?.value || 'compact') === 'verbose',
        librarian: {
            retrieval_limit: Math.min(20, Math.max(1, parseInt(document.getElementById('intel_retrieval_limit')?.value, 10) || 5)),
            memory_relevance_max_distance: (() => {
                const v = document.getElementById('intel_memory_relevance_max_distance')?.value?.trim();
                if (v === '') return null;
                const n = parseFloat(v);
                if (Number.isNaN(n)) return null;
                return Math.min(2, Math.max(0, n));
            })()
        },
        security: {
            whitelist_enabled: (document.getElementById('wl_numbers')?.value || '').split('\n').map(n => n.trim()).filter(n => n).length > 0,
            allowed_numbers: (document.getElementById('wl_numbers')?.value || '').split('\n').map(n => n.trim()).filter(n => n),
            anti_injection: document.getElementById('security_anti_injection')?.checked !== false,
            anti_injection_prompt_template: document.getElementById('security_anti_injection_prompt')?.value || '',
            tool_guardrails: document.getElementById('security_tool_guardrails')?.checked !== false,
            restrict_mutating_tools_on_untrusted_content: document.getElementById('security_restrict_untrusted_tools')?.checked !== false
        },
        waha: _withOptionalIntegrationEnabled({
            api_url: document.getElementById('waha_url')?.value || '',
        }, 'waha'),
        pago: _withOptionalIntegrationEnabled({
            email: (document.getElementById('pago_email')?.value || '').trim(),
            password: (document.getElementById('pago_password')?.value || '').trim(),
            scan_interval: Math.max(60, parseInt(document.getElementById('pago_scan_interval')?.value, 10) || 3600)
        }, 'pago'),
        fusion_solar: _withOptionalIntegrationEnabled({
            mode: (document.getElementById('fusion_solar_mode')?.value || 'auto').trim(),
            host: (document.getElementById('fusion_solar_host')?.value || '').trim(),
            kiosk_url: (document.getElementById('fusion_solar_kiosk_url')?.value || '').trim(),
            username: (document.getElementById('fusion_solar_username')?.value || '').trim(),
            password: (document.getElementById('fusion_solar_password')?.value || '').trim(),
            scan_interval: Math.max(600, parseInt(document.getElementById('fusion_solar_scan_interval')?.value, 10) || 600)
        }, 'fusion_solar'),
        fcm: {
            enabled: transportMode === 'firebase',
            transport_mode: transportMode,
            websocket_enabled: transportMode === 'websocket',
            send_when_ws_disconnected: true,
            project_id: (document.getElementById('fcm_project_id')?.value || '').trim(),
            service_account_path: (document.getElementById('fcm_service_account_path')?.value || '').trim(),
        },
        prompts: (() => {
            const nlList = (s) => (s || '').split(/\n/).map(x => x.trim()).filter(Boolean);
            return {
                system_persona: document.getElementById('p_persona')?.value ?? '',
                agent_instructions: document.getElementById('p_agent_instructions')?.value ?? '',
                agent_instructions_fallback: (document.getElementById('p_agent_instructions_fallback')?.value ?? '').trim(),
                agent_instruction_overrides: nlList(document.getElementById('p_agent_instruction_overrides')?.value),
                search_web_single_message_instruction: (document.getElementById('p_search_web_single_message_instruction')?.value ?? '').trim(),
                web_content_reply_instruction: (document.getElementById('p_web_content_reply_instruction')?.value ?? '').trim(),
                image_placeholder: (document.getElementById('p_image_placeholder')?.value ?? '').trim(),
                summarize: (document.getElementById('p_summarize')?.value ?? '').trim()
            };
        })(),
        memory: {
            working_window: Math.min(50, Math.max(4, parseInt(document.getElementById('intel_working_window')?.value, 10) || 12)),
            summarize_every: Math.min(30, Math.max(4, parseInt(document.getElementById('intel_summarize_every')?.value, 10) || 8)),
            fact_similarity_threshold: Math.min(0.9, Math.max(0.1, parseFloat(document.getElementById('memory_fact_similarity')?.value) || 0.45)),
            extraction_timeout: Math.min(600, Math.max(10, parseInt(document.getElementById('memory_extraction_timeout')?.value, 10) || 120)),
            extraction_input_max_chars: Math.min(4000, Math.max(300, parseInt(document.getElementById('memory_extraction_input_max_chars')?.value, 10) || 900)),
            extraction_max_tokens_full: Math.min(2400, Math.max(128, parseInt(document.getElementById('memory_extraction_max_tokens_full')?.value, 10) || 800)),
            extraction_max_lines: Math.min(10, Math.max(1, parseInt(document.getElementById('memory_extraction_max_lines')?.value, 10) || 2)),
            extraction_rules: (document.getElementById('memory_extraction_rules')?.value ?? '').trim() || undefined,
            extraction_examples: getExtractionExamples().filter(ex => ex.input && ex.input.trim()),
        },
        intelligence: {
            max_agent_turns: Math.min(30, Math.max(1, parseInt(document.getElementById('max_agent_turns')?.value, 10) || 10)),
            post_response_concurrency: Math.min(5, Math.max(1, parseInt(document.getElementById('post_response_concurrency')?.value, 10) || 1)),
            inject_relevant_facts: document.getElementById('inject_relevant_facts')?.checked || false,
            lazy_history: document.getElementById('intel_lazy_history')?.checked !== false,
            richer_tool_results: document.getElementById('richer_tool_results')?.checked || false,
            knowledge_cutoff: (document.getElementById('intel_knowledge_cutoff')?.value || '2024-01').trim(),
            search_tendency: Math.min(5, Math.max(1, parseInt(document.getElementById('intel_search_tendency')?.value, 10) || 3)),
            search_use_conversation_context: document.getElementById('search_use_conversation_context')?.checked || false,
            search_context_similarity_threshold: Math.min(0.99, Math.max(0.2, parseFloat(document.getElementById('search_context_similarity_threshold')?.value) || 0.55)),
            ambient: {
                enabled: document.getElementById('ambient_enabled')?.checked || false,
                mode: document.getElementById('ambient_mode')?.value || 'suggest',
                checkin: document.getElementById('ambient_checkin')?.value || 'off',
                profile_id: (document.getElementById('ambient_profile')?.value || '').trim(),
                quiet_hours: {
                    start: (document.getElementById('ambient_quiet_start')?.value || '23:00').trim(),
                    end: (document.getElementById('ambient_quiet_end')?.value || '07:00').trim(),
                },
                max_per_hour: Math.min(30, Math.max(1, parseInt(document.getElementById('ambient_max_per_hour')?.value, 10) || 6)),
                scan_interval_min: Math.min(180, Math.max(2, parseInt(document.getElementById('ambient_scan_interval')?.value, 10) || 15)),
                learn_patterns: document.getElementById('ambient_learn_patterns')?.checked !== false,
                ignore_unavailable_entities: !!document.getElementById('ambient_ignore_unavailable')?.checked,
                ignore_sources: (document.getElementById('ambient_ignore_sources')?.value || '')
                    .split(/[,;\s]+/).map(s => s.trim()).filter(Boolean),
                integration_alert_cooldown_hours: 24,
                reasoner_prompt: (document.getElementById('ambient_reasoner_prompt')?.value || '').trim(),
            },
            briefings: {
                enabled: document.getElementById('briefings_enabled')?.checked || false,
                profile_id: (document.getElementById('briefings_profile')?.value || '').trim(),
                morning_time: (document.getElementById('briefings_morning_time')?.value || '07:30').trim(),
                evening_time: (document.getElementById('briefings_evening_time')?.value || '21:00').trim(),
                include_weather: document.getElementById('briefings_include_weather')?.checked !== false,
                include_planner: document.getElementById('briefings_include_planner')?.checked !== false,
                include_home_status: document.getElementById('briefings_include_home_status')?.checked !== false,
            },
            pattern_detector: {
                enabled: document.getElementById('pattern_detector_enabled')?.checked || false,
                min_occurrences: Math.min(20, Math.max(2, parseInt(document.getElementById('pattern_min_occurrences')?.value, 10) || 4)),
            },
            intent_router: {
                enabled: document.getElementById('intent_router_enabled')?.checked || false,
            },
            proactive_hints: {
                enabled: document.getElementById('proactive_hints_enabled')?.checked || false,
            },
            shell: (() => {
                const rawAllowed = (document.getElementById('shell_allowed_commands')?.value || '').trim();
                const rawBlocked = (document.getElementById('shell_blocked_patterns')?.value || '').trim();
                const parseList = (s) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                const allowedList = parseList(rawAllowed);
                const blockedList = parseList(rawBlocked);
                return {
                    enabled: document.getElementById('shell_enabled')?.checked !== false,
                    allowed_commands: allowedList.length ? allowedList : ['curl', 'wget', 'ping', 'date', 'uname', 'cat', 'echo', 'head', 'tail', 'df', 'free', 'uptime'],
                    blocked_patterns: blockedList,
                    max_output_chars: Math.min(100000, Math.max(500, parseInt(document.getElementById('shell_max_output_chars')?.value, 10) || 8000)),
                    timeout_seconds: Math.min(120, Math.max(5, parseInt(document.getElementById('shell_timeout_seconds')?.value, 10) || 15)),
                    rate_limit_per_minute: Math.min(30, Math.max(1, parseInt(document.getElementById('shell_rate_limit')?.value, 10) || 5))
                };
            })(),
            file_read: {
                enabled: document.getElementById('file_read_enabled')?.checked !== false,
                max_bytes: Math.min(500000, Math.max(1024, parseInt(document.getElementById('file_read_max_bytes')?.value, 10) || 51200)),
                rate_limit_per_minute: Math.min(60, Math.max(1, parseInt(document.getElementById('file_read_rate_limit')?.value, 10) || 10))
            },
            run_script: {
                enabled: document.getElementById('run_script_enabled')?.checked !== false,
                timeout_seconds: Math.min(30, Math.max(5, parseInt(document.getElementById('run_script_timeout')?.value, 10) || 15)),
                max_output_chars: Math.min(100000, Math.max(1000, parseInt(document.getElementById('run_script_max_output')?.value, 10) || 20000)),
                rate_limit_per_minute: Math.min(15, Math.max(1, parseInt(document.getElementById('run_script_rate_limit')?.value, 10) || 3))
            },
            propose_patch: {
                enabled: document.getElementById('propose_patch_enabled')?.checked !== false,
                allowed_dirs: (document.getElementById('propose_patch_allowed_dirs')?.value || 'scripts, docs, ai_suggestions').split(',').map(s => s.trim()).filter(Boolean)
            },
            consolidation: {
                enabled: document.getElementById('consolidation_enabled')?.checked || false,
                time: (document.getElementById('consolidation_time')?.value || '03:00').trim().slice(0, 5),
                interval: document.getElementById('consolidation_interval')?.value || 'daily',
                similarity_threshold: Math.min(0.99, Math.max(0.8, parseFloat(document.getElementById('consolidation_threshold')?.value) || 0.92)),
                session_trigger_messages: Math.min(500, Math.max(20, parseInt(document.getElementById('consolidation_session_trigger_messages')?.value, 10) || 80)),
                compression_ratio: Math.min(0.5, Math.max(0.05, parseFloat(document.getElementById('consolidation_compression_ratio')?.value) || 0.15)),
                history_log_path: (document.getElementById('consolidation_history_log_path')?.value || 'history_log.md').trim()
            },
        },
        searxng: _withOptionalIntegrationEnabled({
            url: (document.getElementById('searxng_url')?.value || '').trim(),
            fetch_pages: document.getElementById('searxng_fetch_pages')?.checked !== false,
            max_pages_to_fetch: Math.min(3, Math.max(0, parseInt(document.getElementById('searxng_max_pages')?.value, 10) || 2)),
            max_search_results: Math.min(20, Math.max(1, parseInt(document.getElementById('searxng_max_results')?.value, 10) || 5)),
            search_timeout: Math.min(60, Math.max(3, parseInt(document.getElementById('searxng_search_timeout')?.value, 10) || 10)),
            max_searches_per_request: Math.min(20, Math.max(1, parseInt(document.getElementById('searxng_max_searches_per_request')?.value, 10) || 5))
        }, 'searxng'),
        cctv: (() => {
            const list = document.getElementById('cctv-cameras-list');
            const cameras = [];
            if (list) {
                list.querySelectorAll('.cctv-camera-row').forEach((row, i) => {
                    const nameInp = row.querySelector('.cctv-cam-name');
                    const rtspInp = row.querySelector('.cctv-cam-rtsp');
                    const ctxInp = row.querySelector('.cctv-cam-context');
                    const name = (nameInp?.value || '').trim();
                    const rtsp = (rtspInp?.value || '').trim();
                    const context = (ctxInp?.value || '').trim();
                    if (!name && !rtsp) return;
                    const id = row.dataset.cctvId || slugForId(name) || ('cam_' + i);
                    const cam = { id, name: name || id, rtsp_url: rtsp };
                    if (context) cam.context = context;
                    cameras.push(cam);
                });
            }
            return _withOptionalIntegrationEnabled({ cameras }, 'cctv');
        })(),
        whisper: _withOptionalIntegrationEnabled({
            host: (document.getElementById('whisper_host')?.value || 'localhost').trim(),
            port: Math.min(65535, Math.max(1, parseInt(document.getElementById('whisper_port')?.value, 10) || 10300)),
            language: document.getElementById('whisper_language')?.value || 'ro',
            vad_silence_ms: Math.min(10000, Math.max(500, parseInt(document.getElementById('whisper_vad_silence_ms')?.value, 10) || 2500)),
            vad_sensitivity: document.getElementById('whisper_vad_sensitivity')?.value || 'medium'
        }, 'whisper'),
        piper: _withOptionalIntegrationEnabled({
            // UI checkbox removed; keep persisted runtime value.
            always_speak: !!(window.__tts && window.__tts.alwaysSpeak)
        }, 'piper'),
        comfyui: _withOptionalIntegrationEnabled({
            url: (document.getElementById('comfyui_url')?.value || 'http://localhost:8188').trim(),
            default_checkpoint: (document.getElementById('comfyui_checkpoint')?.value || '').trim(),
            default_steps: Math.min(150, Math.max(1, parseInt(document.getElementById('comfyui_steps')?.value, 10) || 20)),
            default_cfg_scale: Math.min(30, Math.max(1, parseFloat(document.getElementById('comfyui_cfg')?.value) || 7)),
            default_width: Math.min(2048, Math.max(256, parseInt(document.getElementById('comfyui_width')?.value, 10) || 1024)),
            default_height: Math.min(2048, Math.max(256, parseInt(document.getElementById('comfyui_height')?.value, 10) || 1024)),
            default_sampler: document.getElementById('comfyui_sampler')?.value || 'euler',
            default_scheduler: document.getElementById('comfyui_scheduler')?.value || 'normal',
            default_negative_prompt: (document.getElementById('comfyui_negative')?.value || '').trim(),
            timeout: Math.min(600, Math.max(10, parseInt(document.getElementById('comfyui_timeout')?.value, 10) || 120)),
            workflow_file: (document.getElementById('comfyui_workflow_file')?.value || '').trim(),
        }, 'comfyui'),
        timezone: (document.getElementById('config_timezone')?.value || '').trim(),

        updates: {
            addons: {
                check_interval: document.getElementById('updates_addons_check_interval')?.value || 'never',
                auto_update: !!document.getElementById('updates_addons_auto_update')?.checked,
            }
        },

        ui: { language }
    };

    const _saveConfigHandledKeys = new Set([
        'waha', 'pago', 'fusion_solar', 'searxng', 'cctv', 'whisper', 'piper', 'comfyui',
    ]);
    for (const entry of _integrationCatalog) {
        const slug = String(entry.slug || '').trim();
        if (!slug) continue;
        const configKey = String(entry.config_key || slug).trim();
        if (_saveConfigHandledKeys.has(configKey)) continue;
        const enabled = _integrationEnabledForSave(slug);
        if (enabled === undefined) continue;
        config[configKey] = { ...(config[configKey] || {}), enabled };
    }

    try {
        const resp = await apiCall('/api/config', { method: 'POST', body: config });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
        showToast((t('config.save_error') || 'Save error') + ' ' + (err.message || err), 'error');
        return;
    }

    const wsServiceShouldRun = (() => {
        const mode = String(config.fcm?.transport_mode || 'hybrid').toLowerCase();
        const wsEnabled = config.fcm?.websocket_enabled !== false;
        return wsEnabled && mode !== 'firebase';
    })();
    if (window.__HYVE_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try { window.__setNativeWsServiceEnabled(!!wsServiceShouldRun); } catch (_) {}
    }

    const badge = document.getElementById('header-log-mode-badge');
    if (badge) {
        const verbose = !!config.verbose_logging;
        badge.textContent = verbose ? 'LOG: VERBOSE' : 'LOG: COMPACT';
        badge.classList.remove(
            'border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10',
            'border-amber-500/30', 'text-amber-300', 'bg-amber-500/10'
        );
        if (verbose) {
            badge.classList.add('border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
        } else {
            badge.classList.add('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10');
        }
    }

    try {
        setLanguage(config.ui.language);
        _refreshUiLanguageSelect(config.ui.language);
    } catch (err) {}

    // Also save native App tab config if running in the Hyve Android app
    if (typeof window.saveAppConfig === 'function') {
        try { window.saveAppConfig(); } catch (_) {}
    }

    // Save notification preferences if on the notifications tab
    const notifTab = document.getElementById('cfg-tab-notifications');
    if (notifTab && !notifTab.classList.contains('hidden')) {
        try { await saveNotificationSettings({ silent: true }); } catch (_) {}
    }

    if (!silent) showToast(t('config.save_success') || 'Salvat', 'success');
    } catch (err) {
        console.error('saveConfig failed', err);
        showToast((t('config.save_error') || 'Save error') + ' ' + (err?.message || err), 'error');
    } finally {
        restoreBtn();
    }
}

/** Generate AI welcome greetings on demand (button click). */
/** Copy text to clipboard; works on HTTP and with password fields. Shows toast on success. */
function copyToClipboard(text, successMessage) {
    const msg = successMessage || (t('common.copied') || 'Copied!');
    if (!text || typeof text !== 'string') return false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => showToast(msg, 'success')).catch(fallback);
        } else {
            fallback();
        }
    } catch (e) {
        fallback();
    }
    function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast(msg, 'success');
        } catch (err) {
            showToast(t('common.copy_failed') || 'Copy failed', 'error');
        }
        document.body.removeChild(ta);
    }
    return true;
}

export function copyWebhook() {
    const el = document.getElementById('waha_webhook');
    if (!el || !el.value) return;
    copyToClipboard(el.value, t('config.webhook_copied') || 'Webhook URL copied!');
}

const INTEGRATION_MODAL_TITLES = { ha: 'config.ha_section', searxng: 'config.searxng_section', waha: 'config.waha_section', cctv: 'config.cctv_section', whisper: 'config.whisper_section', comfyui: 'config.comfyui_section', piper: 'config.piper_section', pago: 'config.pago_section', fusion_solar: 'Fusion Solar' };
const INTEGRATION_MODAL_ICONS  = { ha: 'fa-house-signal', searxng: 'fa-magnifying-glass', waha: 'fa-brands fa-whatsapp', cctv: 'fa-video', whisper: 'fa-microphone', comfyui: 'fa-palette', piper: 'fa-volume-up', pago: 'fa-file-invoice-dollar', fusion_solar: 'fa-solar-panel' };
const INTEGRATION_MODAL_IMAGES = {
    waha: '/static/icons/integrations/waha.png',
    searxng: '/static/icons/integrations/searxng.png',
    comfyui: '/static/icons/integrations/comfyui.avif',
    whisper: '/static/icons/integrations/whisper.png',
    piper: '/static/icons/integrations/piper.webp',
    fusion_solar: '/static/icons/integrations/fusion_solar.png',
    open_meteo: '/static/icons/integrations/open_meteo.png',
    pago: '/static/icons/integrations/pago.png',
    eon_romania: '/static/icons/integrations/eon_romania.png',
    reteleelectrice: '/static/icons/integrations/reteleelectrice.jpg',
    reolink: '/static/icons/integrations/reolink.jpg',
    tapo: '/static/icons/integrations/tapo.png',
    midea_ac: '/static/icons/integrations/midea_ac.png',
    ariston_net: '/static/icons/integrations/ariston_net.svg',
    mosquitto: '/static/icons/integrations/mosquitto.png',
};

export async function openIntegrationConfigModal(integrationId) {
    const modal = document.getElementById('integration-config-modal');
    const titleEl = document.getElementById('integration-config-modal-title');
    const iconEl = document.getElementById('integration-config-modal-icon');
    const logoEl = document.getElementById('integration-config-modal-logo');
    if (!modal || !titleEl) return;
    document.querySelectorAll('[id^="integration-panel-"]').forEach(panel => {
        panel.classList.add('hidden');
    });
    // Hide the shared "emitted entities" section between opens; it is
    // re-shown at the end of this function for any integration that exposes
    // entities through the catalog.
    const exposedSection = document.getElementById('integration-exposed-entities-section');
    if (exposedSection) exposedSection.classList.add('hidden');
    const entriesSection = document.getElementById('integration-entries-section');
    if (entriesSection) entriesSection.classList.add('hidden');

    // Make sure catalog metadata is available so we can resolve the panel id,
    // title, icon and fall back to the generic panel for new integrations.
    try { await loadIntegrationCatalog(false); } catch (_) {}
    const meta = _integrationDefinition(integrationId) || null;
    const catalogSlug = _integrationCatalogSlug(integrationId);
    const resolvedPanelId = meta?.config_panel_id || catalogSlug;
    const panel = document.getElementById(`integration-panel-${resolvedPanelId}`)
        || document.getElementById(`integration-panel-${integrationId}`);
    if (panel) {
        panel.classList.remove('hidden');
    } else {
        // Generic fallback — shown when an integration has no hand-authored
        // config block. Keeps new integrations self-serve per
        // docs/CARDS_AND_INTEGRATIONS.md.
        const generic = document.getElementById('integration-panel-generic');
        if (generic) {
            generic.classList.remove('hidden');
            const descEl = document.getElementById('integration-generic-description');
            if (descEl) {
                const desc = String(meta?.description || '').trim();
                descEl.textContent = desc;
                descEl.classList.toggle('hidden', !desc);
            }
            const syncBtn = document.getElementById('integration-generic-sync-btn');
            if (syncBtn) {
                const supportsSync = !!meta?.supports_sync;
                syncBtn.classList.toggle('hidden', !supportsSync);
                if (supportsSync) {
                    syncBtn.classList.add('flex');
                    syncBtn.onclick = async () => {
                        await window.syncConfiguredIntegration(catalogSlug, syncBtn);
                        try { await loadIntegrationExposedEntities(catalogSlug); } catch (_) {}
                    };
                } else {
                    syncBtn.classList.remove('flex');
                    syncBtn.onclick = null;
                }
            }
        }
    }
    const titleKey = INTEGRATION_MODAL_TITLES[integrationId];
    const resolvedTitle = (titleKey ? t(titleKey) : '') || _integrationLabel(meta) || integrationId;
    const icon = INTEGRATION_MODAL_ICONS[integrationId]
        || _normalizeIntegrationIcon(meta?.icon || 'fa-plug');
    const logo = String(meta?.image || INTEGRATION_MODAL_IMAGES[integrationId] || '').trim();
    titleEl.textContent = resolvedTitle;
    if (logoEl) {
        logoEl.classList.toggle('hidden', !logo);
        logoEl.style.display = logo ? '' : 'none';
        logoEl.src = logo || '';
        logoEl.alt = logo ? resolvedTitle : '';
        logoEl.onerror = () => {
            logoEl.classList.add('hidden');
            logoEl.style.display = 'none';
            if (iconEl) iconEl.classList.remove('hidden');
            if (iconEl) iconEl.style.display = '';
        };
    }
    if (iconEl) {
        iconEl.className = `fas ${icon}`;
        iconEl.classList.toggle('hidden', !!logo);
        iconEl.style.display = logo ? 'none' : '';
    }
    openSubPage('integration-config-modal');

    // Always re-fetch config so fields reflect stored values
    let cfg = null;
    try {
        const cfgRes = await apiCall('/api/config');
        if (cfgRes.ok) cfg = await cfgRes.json();
    } catch (_) {}

    if (integrationId === 'ha') {
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const keyEl = document.getElementById('assist_api_key');
        if (keyEl) keyEl.value = '';
        try {
            const res = await apiCall('/api/assist-key');
            if (res.ok) {
                const data = await res.json();
                if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
                const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
                if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
            }
        } catch (_) {}
        const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
        if (ollamaUserUrlEl && !ollamaUserUrlEl.value && origin) ollamaUserUrlEl.value = '';
        // Load exposed entities summary
        _loadExposedEntitiesSummary();
    }
    if (integrationId === 'waha') {
        if (cfg) {
            const wahaCfg = cfg.waha || {};
            const wahaUrl = document.getElementById('waha_url');
            const wlNumbers = document.getElementById('wl_numbers');
            if (wahaUrl) wahaUrl.value = wahaCfg.url || '';
            if (wlNumbers && wahaCfg.allowed_numbers) wlNumbers.value = (wahaCfg.allowed_numbers || []).join('\n');
        }
        const wh = document.getElementById('waha_webhook');
        if (wh && typeof window !== 'undefined' && window.location?.origin) {
            wh.value = window.location.origin + '/api/webhook/waha';
        }
    }
    if (integrationId === 'searxng' && cfg) {
        const sx = cfg.searxng || {};
        const sxUrl = document.getElementById('searxng_url');
        if (sxUrl) sxUrl.value = sx.url || '';
    }
    if (integrationId === 'comfyui') {
        if (cfg) {
            const c = cfg.comfyui || {};
            const fields = {
                'comfyui_url': c.url || 'http://localhost:8188',
                'comfyui_steps': c.default_steps ?? 20,
                'comfyui_cfg': c.default_cfg_scale ?? 7,
                'comfyui_width': c.default_width ?? 1024,
                'comfyui_height': c.default_height ?? 1024,
                'comfyui_sampler': c.default_sampler || 'euler',
                'comfyui_scheduler': c.default_scheduler || 'normal',
                'comfyui_timeout': c.timeout ?? 120,
                'comfyui_negative': c.default_negative_prompt || '',
            };
            for (const [id, val] of Object.entries(fields)) {
                const el = document.getElementById(id);
                if (el) el.value = val;
            }
            // Refresh checkpoint & workflow selects, then set stored values
            const storedCheckpoint = c.default_checkpoint || '';
            const storedWorkflow = c.workflow_file || '';
            try {
                await window.refreshComfyUICheckpoints();
                const ckptEl = document.getElementById('comfyui_checkpoint');
                if (ckptEl && storedCheckpoint) ckptEl.value = storedCheckpoint;
            } catch (_) {}
            try {
                await window.refreshComfyUIWorkflows();
                const wfEl = document.getElementById('comfyui_workflow_file');
                if (wfEl && storedWorkflow) wfEl.value = storedWorkflow;
            } catch (_) {}
        }
    }
    if (integrationId === 'cctv' && cfg) {
        const cctvCfg = cfg.cctv || {};
        renderCctvCameras(cctvCfg.cameras || []);
    }
    if (integrationId === 'whisper' && cfg) {
        const w = cfg.whisper || {};
        const wHost = document.getElementById('whisper_host');
        const wPort = document.getElementById('whisper_port');
        const wLang = document.getElementById('whisper_language');
        if (wHost) wHost.value = w.host || 'localhost';
        if (wPort) wPort.value = w.port || 10300;
        if (wLang) wLang.value = w.language || 'ro';
        const wVadMs = document.getElementById('whisper_vad_silence_ms');
        const wVadSens = document.getElementById('whisper_vad_sensitivity');
        if (wVadMs) wVadMs.value = w.vad_silence_ms || 2500;
        if (wVadSens) wVadSens.value = w.vad_sensitivity || 'medium';
    }
    if (integrationId === 'piper' && cfg) {
        // Populate addon config fields from addon API
        try {
            const addonRes = await apiCall('/api/addons/piper');
            if (addonRes.ok) {
                const addon = await addonRes.json();
                const ac = addon.state?.config || {};
                const pVoice = document.getElementById('piper_voice');
                const pHost = document.getElementById('piper_host');
                const pPort = document.getElementById('piper_port');
                const pSpeakerId = document.getElementById('piper_speaker_id');
                const pLengthScale = document.getElementById('piper_length_scale');
                if (pVoice) pVoice.value = ac.voice || 'ro_RO-mihai-medium';
                if (pHost) pHost.value = ac.host || 'localhost';
                if (pPort) pPort.value = ac.port || 10200;
                if (pSpeakerId) pSpeakerId.value = ac.speaker_id ?? 0;
                if (pLengthScale) pLengthScale.value = ac.length_scale || '1.0';
            }
        } catch (_) {}
    }
    if (integrationId === 'pago' && cfg) {
        const p = cfg.pago || {};
        const pEmail = document.getElementById('pago_email');
        const pPass = document.getElementById('pago_password');
        const pInterval = document.getElementById('pago_scan_interval');
        if (pEmail) pEmail.value = p.email || '';
        if (pPass && p.password) pPass.value = p.password;
        if (pInterval) pInterval.value = p.scan_interval ?? 3600;
    }
    if (integrationId === 'fusion_solar' && cfg) {
        const f = cfg.fusion_solar || {};
        const mode = document.getElementById('fusion_solar_mode');
        const host = document.getElementById('fusion_solar_host');
        const kiosk = document.getElementById('fusion_solar_kiosk_url');
        const user = document.getElementById('fusion_solar_username');
        const pass = document.getElementById('fusion_solar_password');
        const interval = document.getElementById('fusion_solar_scan_interval');
        if (mode) mode.value = f.mode || 'auto';
        if (host) host.value = f.host || 'https://eu5.fusionsolar.huawei.com';
        if (kiosk) kiosk.value = f.kiosk_url || '';
        if (user) user.value = f.username || '';
        if (pass && f.password) pass.value = f.password;
        if (interval) interval.value = f.scan_interval ?? 600;
    }

    // Shared "emitted entities" section (only integrations with supports_sync).
    if (_supportsIntegrationEntitySync(catalogSlug)) {
        try { await loadIntegrationExposedEntities(catalogSlug); } catch (_) {}
    }
    // HA-style config entries — only for component providers with CONFIG_SCHEMA.
    if (_integrationHasConfigSchema(catalogSlug)) {
        try { await loadIntegrationConfigEntries(catalogSlug); } catch (_) {}
    }
}

export function copyAssistOllamaUserUrl() {
    const el = document.getElementById('assist_ollama_user_url');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export function copyAssistKey() {
    const el = document.getElementById('assist_api_key');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export async function regenerateAssistKey() {
    if (!(await showConfirm(t('config.assist_regenerate_confirm') || 'Regenerate key? The old key will stop working.'))) return;
    try {
        const res = await apiCall('/api/assist-key/regenerate', { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const keyEl = document.getElementById('assist_api_key');
        if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
        if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
        showToast(t('config.assist_regenerate_done') || 'New key generated.', 'success');
    } catch (e) {
        showToast(t('config.assist_regenerate_error') || 'Failed to regenerate key.', 'error');
    }
}

export function closeIntegrationConfigModal() {
    // Save addon-level config for piper if its panel is visible
    const piperPanel = document.getElementById('integration-panel-piper');
    if (piperPanel && !piperPanel.classList.contains('hidden')) {
        _savePiperAddonConfig();
    }
    closeSubPage('integration-config-modal');
    saveConfig({ silent: true });
}

async function _savePiperAddonConfig() {
    const voice = document.getElementById('piper_voice')?.value || 'ro_RO-mihai-medium';
    const host = (document.getElementById('piper_host')?.value || 'localhost').trim();
    const port = parseInt(document.getElementById('piper_port')?.value, 10) || 10200;
    const speaker_id = parseInt(document.getElementById('piper_speaker_id')?.value, 10) || 0;
    const length_scale = (document.getElementById('piper_length_scale')?.value || '1.0').trim();
    try {
        await apiCall('/api/addons/piper/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice, host, port, speaker_id, length_scale }),
        });
    } catch (_) {}
}

export async function restartServer() {
    if (!(await showConfirm(t('config.restart_confirm')))) return;
    suppressLogout(true);
    showHubStartupLoadingAfterRestart();
    showToast(t('config.restart_started') || 'Server restarting...', 'info', 8000);
    try {
        const resp = await apiCall('/api/restart', { method: 'POST' });
        if (!resp.ok) {
            suppressLogout(false);
            let detail = `HTTP ${resp.status}`;
            try {
                const data = await resp.json();
                detail = data.detail || data.message || detail;
                if (typeof detail === 'object') detail = JSON.stringify(detail);
            } catch (_) {}
            showToast(String(detail), 'error');
            return;
        }
    } catch (e) {
        // Network error after restart starts is expected; keep polling
        if (e?.message === 'Session expired.') {
            suppressLogout(false);
            return;
        }
    }
    startReconnectPolling();
}
function startReconnectPolling() {
    const maxAttempts = 30;
    let attempts = 0;
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('hyve_token') : null;
    const headers = { Accept: 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const tryReconnect = () => {
        attempts++;
        fetch('/api/config', { method: 'GET', credentials: 'same-origin', headers })
            .then(r => {
                if (r.ok) {
                    suppressLogout(false);
                    location.reload();
                }
            })
            .catch(() => {})
            .finally(() => { if (attempts < maxAttempts) setTimeout(tryReconnect, 2000); else suppressLogout(false); });
    };
    setTimeout(tryReconnect, 3000);
}
// --- WHISPER / VOICE INPUT ---

window.testWhisperConnection = async function() {
    const btn = document.getElementById('whisper-test-btn');
    const resultDiv = document.getElementById('whisper-test-result');
    if (btn) btn.disabled = true;
    try {
        const host = (document.getElementById('whisper_host')?.value || 'localhost').trim();
        const port = parseInt(document.getElementById('whisper_port')?.value, 10) || 10300;
        const res = await apiCall(`/api/whisper/status?host=${encodeURIComponent(host)}&port=${port}`);
        const data = await res.json();
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-red-500/15', 'text-red-300', 'bg-emerald-500/15', 'text-emerald-300');
            if (data.connected) {
                resultDiv.classList.add('bg-emerald-500/15', 'text-emerald-300');
                resultDiv.innerHTML = '<i class="fas fa-check-circle mr-1"></i> ' + (t('config.whisper_test_success') || 'Connected successfully');
            } else {
                resultDiv.classList.add('bg-red-500/15', 'text-red-300');
                resultDiv.innerHTML = '<i class="fas fa-times-circle mr-1"></i> ' + (t('config.whisper_test_fail') || 'Connection failed');
            }
        }
    } catch (e) {
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-emerald-500/15', 'text-emerald-300', 'bg-red-500/15', 'text-red-300');
            resultDiv.classList.add('bg-red-500/15', 'text-red-300');
            resultDiv.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i> ' + (e.message || 'Error');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
};

window.testPiperConnection = async function() {
    const btn = document.getElementById('piper-test-btn');
    if (!btn) return;
    btn.disabled = true;
    const baseHtml = btn.innerHTML;
    const baseClass = btn.className;
    const setBtnState = (type, text) => {
        btn.innerHTML = `<i class="fas ${type === 'ok' ? 'fa-check-circle' : 'fa-times-circle'}"></i><span>${text}</span>`;
        btn.classList.remove('bg-cyan-500/15', 'hover:bg-cyan-500/25', 'text-cyan-300', 'border-cyan-500/25');
        if (type === 'ok') {
            btn.classList.add('bg-emerald-500/15', 'text-emerald-300', 'border-emerald-500/25');
        } else {
            btn.classList.add('bg-red-500/15', 'text-red-300', 'border-red-500/25');
        }
    };
    try {
        // Save addon config first so the health-check uses latest host/port
        await _savePiperAddonConfig();
        // Use addon health-check endpoint (reads host/port from server config)
        const res = await apiCall('/api/addons/piper/health');
        const data = await res.json();
        if (data && data.ok === true) {
            setBtnState('ok', t('config.piper_test_success') || 'Connected successfully');
        } else {
            // Fallback: if process is actually running, treat as reachable.
            let running = false;
            try {
                const sRes = await apiCall('/api/addons/piper/status');
                const s = await sRes.json();
                running = s && s.status === 'running';
            } catch (_) {}
            if (running) {
                setBtnState('ok', t('config.piper_test_success') || 'Connected successfully');
            } else {
                const detail = data?.detail ? formatHealthError(data.detail) : (t('config.piper_test_fail') || 'Connection failed');
                setBtnState('fail', detail);
            }
        }
    } catch (e) {
        setBtnState('fail', e.message || 'Error');
    } finally {
        setTimeout(() => {
            btn.className = baseClass;
            btn.innerHTML = baseHtml;
            btn.disabled = false;
        }, 3000);
    }
};

// Legacy fusion/pago test helpers removed — use Settings → Integrations → Test connection.

// ---------------------------------------------------------------------------
// Integration entity sync & display
// ---------------------------------------------------------------------------

const _ENTITY_LABELS = {
    profil:          { icon: 'fa-user',                label: 'Profil' },
    abonament:       { icon: 'fa-id-badge',            label: 'Abonament' },
    carduri:         { icon: 'fa-credit-card',         label: 'Carduri' },
    vehicule:        { icon: 'fa-car',                 label: 'Vehicule' },
    facturi:         { icon: 'fa-file-invoice-dollar',  label: 'Facturi' },
    conturi_facturi: { icon: 'fa-building',            label: 'Furnizori' },
    plati:           { icon: 'fa-receipt',             label: 'Plăți' },
    summary:         { icon: 'fa-solar-panel',         label: 'Sumar solar' },
    stations:        { icon: 'fa-industry',            label: 'Stații' },
    realtime:        { icon: 'fa-bolt',                label: 'Date live' },
    yearly:          { icon: 'fa-chart-line',          label: 'KPI anual (brut)' },
    yearly_current:  { icon: 'fa-calendar-check',      label: 'KPI an curent' },
    yearly_lifetime: { icon: 'fa-infinity',            label: 'KPI total (lifetime)' },
    devices:         { icon: 'fa-microchip',           label: 'Dispozitive' },
};

// ---- detail renderers per entity key ------------------------------------

function _fmtDateStr(s) {
    // 'YYYY-MM-DD HH:MM' or 'YYYY-MM-DD' -> '01 mar. 2026'
    if (!s || s.length < 10) return s || '—';
    const d = new Date(s.slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return s;
    return d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _fmtTs(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _daysUntil(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return null;
    const now = new Date(); now.setHours(0,0,0,0);
    return Math.floor((d - now) / 86400000);
}

function _renderDetailProfil(data) {
    if (!data || data.error) return '<span class="text-red-400 text-[10px]">eroare</span>';
    const rows = [
        { l: 'Nume',    v: `${data.nume || ''} ${data.prenume || ''}`.trim() },
        { l: 'Email',   v: data.email },
        { l: 'Telefon', v: data.telefon ? `+${data.telefon}` : null },
        { l: 'ID',      v: data.pos_user_id },
        { l: 'Membru din', v: data.creat_la ? _fmtTs(data.creat_la) : null },
    ].filter(r => r.v);
    return rows.map(r => `<div class="flex justify-between gap-2"><span class="text-slate-500">${r.l}</span><span class="text-slate-300 text-right">${r.v}</span></div>`).join('');
}

function _renderDetailAbonament(data) {
    if (!data || data.error) return '<span class="text-red-400 text-[10px]">eroare</span>';
    const active = data.activ ? '<span class="text-emerald-400">Activ</span>' : '<span class="text-red-400">Inactiv</span>';
    const rows = [
        { l: 'Status', v: active },
        { l: 'Perioadă', v: data.inceput && data.sfarsit ? `${data.inceput} → ${data.sfarsit}` : null },
        { l: 'Perioadă (zile)', v: data.perioada_zile },
        { l: 'Facturi/lună', v: data.facturi_lunare != null ? `${data.plati_folosite ?? 0} / ${data.facturi_lunare}` : null },
        { l: 'Plăți rămase', v: data.plati_ramase != null ? `<span class="${data.plati_ramase > 0 ? 'text-emerald-400' : 'text-amber-400'}">${data.plati_ramase}</span>` : null },
    ].filter(r => r.v);
    return rows.map(r => `<div class="flex justify-between gap-2"><span class="text-slate-500">${r.l}</span><span class="text-slate-300 text-right">${r.v}</span></div>`).join('');
}

function _renderDetailCarduri(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun card</span>';
    return data.map(c => {
        const last4 = c.last4 || '????';
        const type = c.tip_card || '';
        const alias = c.alias || '';
        const active = c.activ !== false;
        const isDefault = c.default;
        return `<div class="flex items-center justify-between gap-2">`
            + `<span class="text-slate-300 font-mono">****${last4}</span>`
            + `<span class="text-slate-500">${type}${alias ? ' · ' + alias : ''}${isDefault ? ' <span class="text-orange-400 text-[9px]">(Default)</span>' : ''}</span>`
            + `<span class="${active ? 'text-emerald-400' : 'text-red-400'} text-[9px]">${active ? '●' : '○'}</span>`
            + `</div>`;
    }).join('');
}

function _renderDetailVehicule(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun vehicul</span>';
    const alertLabels = {
        rca_expira: 'RCA', itp_expira: 'ITP',
        vinieta_expira: 'Rovinietă', rovinieta_expira: 'Rovinietă', casco_expira: 'CASCO',
    };
    return data.map(v => {
        const plate = v.nr_inmatriculare || '?';
        const alerte = v.alerte || {};

        // Compute status
        const rcaDays = _daysUntil(alerte.rca_expira);
        const itpDays = _daysUntil(alerte.itp_expira);
        let status = 'OK', statusCls = 'text-emerald-400';
        if (rcaDays !== null && rcaDays < 0) { status = 'RCA Expirat'; statusCls = 'text-red-400'; }
        else if (itpDays !== null && itpDays < 0) { status = 'ITP Expirat'; statusCls = 'text-red-400'; }
        else if (!alerte.rca_expira) { status = 'Fără RCA'; statusCls = 'text-amber-400'; }

        // Alert tags
        const tags = [];
        for (const [key, label] of Object.entries(alertLabels)) {
            const val = alerte[key];
            if (!val) continue;
            const days = _daysUntil(val);
            const dateStr = _fmtDateStr(val);
            let cls = 'text-emerald-400';
            let extra = '';
            if (days !== null) {
                if (days < 0) { cls = 'text-red-400'; extra = ' (expirat)'; }
                else if (days < 30) { cls = 'text-amber-400'; extra = ` (${days}z)`; }
                else { extra = ` (${days}z)`; }
            }
            tags.push(`<span class="${cls}">${label} ${dateStr}${extra}</span>`);
        }

        // Notification settings
        const notifs = [];
        if (alerte.rca_notificare_sms) notifs.push('SMS');
        if (alerte.rca_notificare_email) notifs.push('Email');
        const notifStr = notifs.length ? `<div class="text-[9px] text-slate-600">Notificări RCA: ${notifs.join(', ')}</div>` : '';

        return `<div class="space-y-0.5 pb-1.5 ${data.indexOf(v) < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="flex items-center justify-between"><span class="text-slate-300 font-mono font-bold">${plate}</span><span class="${statusCls} text-[10px] font-semibold">${status}</span></div>`
            + `<div class="text-[10px] flex flex-wrap gap-x-1.5 gap-y-0.5">${tags.join('')}</div>`
            + notifStr
            + `</div>`;
    }).join('');
}

function _renderDetailFacturi(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">nicio factură</span>';
    const total = data.reduce((s, b) => s + (b.suma_datorata || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const restante = data.filter(b => b.scadenta && b.scadenta <= today).length;
    let header = `<div class="flex justify-between gap-2 pb-1 mb-1 border-b border-white/5">`
        + `<span class="text-slate-400">Total datorat</span>`
        + `<span class="text-slate-200 font-mono font-bold">${total.toFixed(2)} RON</span></div>`;
    if (restante > 0) {
        header += `<div class="text-red-400 text-[10px] mb-1"><i class="fas fa-exclamation-triangle mr-1"></i>${restante} factur${restante === 1 ? 'ă restantă' : 'i restante'}</div>`;
    }
    return header + data.map(b => {
        const amt = b.suma_datorata != null ? `${b.suma_datorata.toFixed(2)} RON` : '—';
        const scad = b.scadenta || '—';
        const overdue = b.scadenta && b.scadenta <= today;
        const cls = overdue ? 'text-red-400' : 'text-slate-300';
        return `<div class="flex justify-between gap-2"><span class="${cls} font-mono">${amt}</span><span class="text-slate-500">scadentă ${_fmtDateStr(scad)}${overdue ? ' <i class="fas fa-exclamation-triangle text-red-400 text-[9px] ml-1"></i>' : ''}</span></div>`;
    }).join('');
}

function _renderDetailConturiFurnizori(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun furnizor</span>';
    return data.map(c => {
        const name = c.furnizor_nume || c.furnizor || '?';
        const loc = c.locatie || '';
        const suma = c.ultima_plata_suma;
        const dataPlata = c.ultima_plata_data ? _fmtDateStr(c.ultima_plata_data) : '';
        const auto = c.auto_plata ? '<span class="text-blue-400 text-[9px] ml-1">auto</span>' : '';
        return `<div class="space-y-0.5 pb-1 ${data.indexOf(c) < data.length - 1 ? 'border-b border-white/5 mb-1' : ''}">`
            + `<div class="flex items-center justify-between gap-2"><span class="text-slate-300 font-semibold">${name}</span>${auto}</div>`
            + (loc ? `<div class="text-[10px] text-slate-500"><i class="fas fa-map-marker-alt text-[8px] mr-1"></i>${loc}${c.tip_locatie ? ' · ' + c.tip_locatie : ''}</div>` : '')
            + (suma != null ? `<div class="text-[10px] text-slate-400">Ultima plată: <span class="text-slate-300 font-mono">${suma.toFixed(2)} RON</span>${dataPlata ? ' pe ' + dataPlata : ''}</div>` : '')
            + `</div>`;
    }).join('');
}

function _renderDetailPlati(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">nicio plată</span>';
    const typeLabels = { provider: 'Factură', rca: 'RCA', recharge: 'Reîncărcare', vignette: 'Rovinietă' };
    const recent = data.slice(0, 12);
    return recent.map(p => {
        const amt = p.suma != null ? `${Number(p.suma).toFixed(2)} RON` : (p.suma_platita != null ? `${Number(p.suma_platita).toFixed(2)} RON` : '—');
        const date = p.data ? _fmtDateStr(p.data) : '—';
        const type = typeLabels[p.tip] || p.tip || '';
        const furn = p.furnizor_nume || '';
        const loc = p.locatie || '';
        const ok = p.status === 'finalized';
        const label = furn || type || '?';
        return `<div class="flex items-center justify-between gap-1">`
            + `<span class="text-slate-300 font-mono text-[10px] shrink-0">${amt}</span>`
            + `<span class="text-slate-500 truncate text-[10px]">${label}${loc ? ' · ' + loc : ''}</span>`
            + `<span class="text-slate-600 text-[10px] shrink-0">${date}</span>`
            + `<span class="${ok ? 'text-emerald-400' : 'text-amber-400'} text-[9px] shrink-0">${ok ? '✓' : '…'}</span>`
            + `</div>`;
    }).join('')
        + (data.length > 12 ? `<div class="text-[10px] text-slate-600 text-center mt-1">+ ${data.length - 12} plăți mai vechi</div>` : '');
}

function _renderDetailFusionSummary(data) {
    if (!data || typeof data !== 'object') return '<span class="text-slate-500 text-[10px]">fără date</span>';
    const rows = [
        ['Stații', data.station_count],
        ['Putere live', data.realtime_power_kw != null ? `${Number(data.realtime_power_kw).toFixed(2)} kW` : null],
        ['Producție azi', data.daily_energy_kwh != null ? `${Number(data.daily_energy_kwh).toFixed(2)} kWh` : null],
        ['Producție lună', data.month_energy_kwh != null ? `${Number(data.month_energy_kwh).toFixed(2)} kWh` : null],
        ['Producție totală', data.lifetime_energy_kwh != null ? `${Number(data.lifetime_energy_kwh).toFixed(2)} kWh` : null],
        ['Status', data.status || null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    return rows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('');
}

function _renderDetailFusionStations(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">nicio stație</span>';
    return data.map((item, i) => {
        const rows = [
            item.station_address ? ['Adresă', item.station_address] : null,
            item.capacity_kw != null ? ['Capacitate', `${Number(item.capacity_kw).toFixed(2)} kW`] : null,
            item.realtime_power_kw != null ? ['Putere live', `${Number(item.realtime_power_kw).toFixed(2)} kW`] : null,
            item.daily_energy_kwh != null ? ['Producție azi', `${Number(item.daily_energy_kwh).toFixed(2)} kWh`] : null,
            item.month_energy_kwh != null ? ['Producție lună', `${Number(item.month_energy_kwh).toFixed(2)} kWh`] : null,
            item.yearly_energy_kwh != null ? ['Producție an', `${Number(item.yearly_energy_kwh).toFixed(2)} kWh`] : null,
            item.lifetime_energy_kwh != null ? ['Producție totală', `${Number(item.lifetime_energy_kwh).toFixed(2)} kWh`] : null,
            item.feed_in_energy_kwh != null ? ['Energie injectată', `${Number(item.feed_in_energy_kwh).toFixed(2)} kWh`] : null,
            item.consumption_kwh != null ? ['Consum', `${Number(item.consumption_kwh).toFixed(2)} kWh`] : null,
            item.revenue != null ? ['Venit', `${Number(item.revenue).toFixed(2)} RON`] : null,
        ].filter(Boolean);
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${item.station_name || item.station_code || 'Stație'}</div>`
            + rows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('')
            + `</div>`;
    }).join('');
}

function _renderDetailFusionRealtime(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">fără date live</span>';
    return data.map((item, i) => {
        const rows = [
            ['Putere', `${Number(item.realtime_power_kw || 0).toFixed(2)} kW`],
            ['Azi', `${Number(item.daily_energy_kwh || 0).toFixed(2)} kWh`],
            item.month_energy_kwh != null ? ['Lună', `${Number(item.month_energy_kwh).toFixed(2)} kWh`] : null,
            item.lifetime_energy_kwh != null ? ['Total', `${Number(item.lifetime_energy_kwh).toFixed(2)} kWh`] : null,
        ].filter(Boolean);
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${item.station_name || item.station_code || 'Stație'}</div>`
            + rows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('')
            + `</div>`;
    }).join('');
}

function _renderDetailFusionYearly(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">fără date anuale</span>';
    return data.map((item, i) => {
        if (!item || typeof item !== 'object') return '';
        const code = item.stationCode || '?';
        const kpi = item.dataItemMap || {};
        const ct = item.collectTime;
        const yearLabel = ct ? new Date(ct).getFullYear() : '?';
        const rows = [
            kpi.installed_capacity != null ? ['Capacitate instalată', `${Number(kpi.installed_capacity).toFixed(2)} kW`] : null,
            kpi.radiation_intensity != null ? ['Radiație globală', `${(Number(kpi.radiation_intensity) * 1000).toFixed(1)} Wh/m²`] : null,
            kpi.theory_power != null ? ['Producție teoretică', `${Number(kpi.theory_power).toFixed(2)} kWh`] : null,
            kpi.performance_ratio != null ? ['Raport performanță', `${Number(kpi.performance_ratio).toFixed(3)}`] : null,
            kpi.inverter_power != null ? ['Producție invertor', `${Number(kpi.inverter_power).toFixed(2)} kWh`] : null,
            kpi.ongrid_power != null ? ['Energie injectată', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
            kpi.use_power != null ? ['Consum', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
            kpi.power_profit != null ? ['Venit', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
            kpi.perpower_ratio != null ? ['Energie specifică', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
            kpi.reduction_total_co2 != null ? ['Reducere CO₂', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_coal != null ? ['Cărbune economisit', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_tree != null ? ['Copaci echivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
        ].filter(Boolean);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${code} <span class="text-amber-400 text-xs ml-1">an ${yearLabel}</span></div>`
            + rows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('')
            + `</div>`;
    }).filter(Boolean).join('') || '<span class="text-slate-500 text-[10px]">fără date</span>';
}

function _renderDetailFusionYearlyCurrent(data) {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return '<span class="text-slate-500 text-[10px]">fără date an curent</span>';
    return Object.entries(data).map(([code, kpi], i, arr) => {
        if (!kpi || typeof kpi !== 'object') return '';
        const ct = kpi.collect_time;
        const yearLabel = ct ? new Date(ct).getFullYear() : new Date().getFullYear();
        const rows = [
            kpi.installed_capacity != null ? ['Capacitate instalată', `${Number(kpi.installed_capacity).toFixed(2)} kW`] : null,
            kpi.radiation_intensity != null ? ['Radiație globală', `${(Number(kpi.radiation_intensity) * 1000).toFixed(1)} Wh/m²`] : null,
            kpi.theory_power != null ? ['Producție teoretică', `${Number(kpi.theory_power).toFixed(2)} kWh`] : null,
            kpi.performance_ratio != null ? ['Raport performanță', `${Number(kpi.performance_ratio).toFixed(3)}`] : null,
            kpi.inverter_power != null ? ['Producție invertor', `${Number(kpi.inverter_power).toFixed(2)} kWh`] : null,
            kpi.ongrid_power != null ? ['Energie injectată', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
            kpi.use_power != null ? ['Consum', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
            kpi.power_profit != null ? ['Venit', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
            kpi.perpower_ratio != null ? ['Energie specifică', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
            kpi.reduction_total_co2 != null ? ['Reducere CO₂', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_coal != null ? ['Cărbune economisit', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_tree != null ? ['Copaci echivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
        ].filter(Boolean);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < arr.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${code} <span class="text-amber-400 text-xs ml-1">an ${yearLabel}</span></div>`
            + rows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('')
            + `</div>`;
    }).filter(Boolean).join('') || '<span class="text-slate-500 text-[10px]">fără date</span>';
}

function _renderDetailFusionYearlyLifetime(data) {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return '<span class="text-slate-500 text-[10px]">fără date lifetime</span>';
    return Object.entries(data).map(([code, kpi], i, arr) => {
        if (!kpi || typeof kpi !== 'object') return '';
        const rows = [
            kpi.inverter_power != null ? ['Producție invertor', `${Number(kpi.inverter_power).toFixed(2)} kWh`] : null,
            kpi.ongrid_power != null ? ['Energie injectată', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
            kpi.use_power != null ? ['Consum', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
            kpi.power_profit != null ? ['Venit', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
            kpi.perpower_ratio != null ? ['Energie specifică', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
            kpi.reduction_total_co2 != null ? ['Reducere CO₂', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_coal != null ? ['Cărbune economisit', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_tree != null ? ['Copaci echivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
        ].filter(Boolean);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < arr.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${code} <span class="text-purple-400 text-xs ml-1">total (lifetime)</span></div>`
            + rows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('')
            + `</div>`;
    }).filter(Boolean).join('') || '<span class="text-slate-500 text-[10px]">fără date</span>';
}

function _renderDetailFusionDevices(data) {
    if (!Array.isArray(data) || !data.length) return '<span class="text-slate-500 text-[10px]">niciun dispozitiv</span>';
    return data.map((dev, i) => {
        if (!dev || typeof dev !== 'object') return '';
        const kpi = dev.realtime_kpi || {};
        const infoRows = [
            dev.device_type ? ['Tip', dev.device_type] : null,
            dev.esn_code ? ['Serie', dev.esn_code] : null,
            dev.inverter_type ? ['Model invertor', dev.inverter_type] : null,
            dev.software_version ? ['Software', dev.software_version] : null,
            dev.station_code ? ['Stație', dev.station_code] : null,
        ].filter(Boolean);
        const _KPI_LABELS = {
            active_power: ['Putere activă', 'kW'], day_cap: ['Producție azi', 'kWh'],
            total_cap: ['Producție totală', 'kWh'], efficiency: ['Eficiență', '%'],
            temperature: ['Temperatură', '°C'], elec_freq: ['Frecvență rețea', 'Hz'],
            power_factor: ['Factor putere', ''], reactive_power: ['Putere reactivă', 'kVar'],
            mppt_power: ['Putere MPPT', 'kW'], battery_soc: ['SOC baterie', '%'],
            battery_soh: ['SOH baterie', '%'], ch_discharge_power: ['Putere înc/desc', 'W'],
            charge_cap: ['Cap. încărcare', 'kWh'], discharge_cap: ['Cap. descărcare', 'kWh'],
            meter_u: ['Tensiune', 'V'], meter_i: ['Curent', 'A'],
            grid_frequency: ['Frecvență', 'Hz'], active_cap: ['Energie activă', 'kWh'],
            reverse_active_cap: ['Energie inversă', 'kWh'], inverter_state: ['Stare', ''],
            run_state: ['Status', ''],
        };
        const kpiRows = Object.entries(kpi).map(([k, v]) => {
            if (v == null) return null;
            const [lbl, unit] = _KPI_LABELS[k] || [k, ''];
            return [lbl, unit ? `${Number(v).toFixed(2)} ${unit}` : String(v)];
        }).filter(Boolean);
        const allRows = [...infoRows, ...kpiRows];
        if (!allRows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${dev.device_name || dev.device_id || 'Dispozitiv'} <span class="text-sky-400 text-xs ml-1">${dev.device_type || ''}</span></div>`
            + allRows.map(([l, v]) => `<div class="flex justify-between gap-2"><span class="text-slate-500">${l}</span><span class="text-slate-300 text-right">${v}</span></div>`).join('')
            + `</div>`;
    }).filter(Boolean).join('') || '<span class="text-slate-500 text-[10px]">fără date</span>';
}

const _DETAIL_RENDERERS = {
    profil: _renderDetailProfil,
    abonament: _renderDetailAbonament,
    carduri: _renderDetailCarduri,
    vehicule: _renderDetailVehicule,
    facturi: _renderDetailFacturi,
    conturi_facturi: _renderDetailConturiFurnizori,
    plati: _renderDetailPlati,
    summary: _renderDetailFusionSummary,
    stations: _renderDetailFusionStations,
    realtime: _renderDetailFusionRealtime,
    yearly: _renderDetailFusionYearly,
    yearly_current: _renderDetailFusionYearlyCurrent,
    yearly_lifetime: _renderDetailFusionYearlyLifetime,
    devices: _renderDetailFusionDevices,
};

// ---- sync & load --------------------------------------------------------

window.navigateToSmartHomeSource = function(slug) {
    if (typeof switchTab === 'function') switchTab('smarthome');
    const catalogSlug = _integrationCatalogSlug(slug);
    setTimeout(() => filterHABySource(catalogSlug), 200);
};

window.syncIntegrationEntities = async function(slug, options = {}) {
    const catalogSlug = _integrationCatalogSlug(slug);
    const showUserToast = options.toast !== false;
    const btn = document.getElementById(`${catalogSlug}-sync-btn`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Sync'; }
    try {
        const res = await apiCall(`/api/integrations/sync/${encodeURIComponent(catalogSlug)}`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === 'ok') {
            await loadIntegrationEntities(catalogSlug);
            if (showUserToast && typeof showToast === 'function') {
                const count = Number(data.entity_count);
                const msg = Number.isFinite(count) && count >= 0
                    ? (t('integrations.sync_ok_count', { count }) || `Sincronizat (${count} entități).`)
                    : (t('integrations.sync_ok') || 'Sincronizare reușită.');
                showToast(msg, 'success', 2200);
            }
        } else {
            const msg = translateApiDetail(data.detail) || integrationApiMessage(data) || t('integrations.sync_failed');
            const errEl = document.getElementById(`${catalogSlug}-entities-error`);
            if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
            if (showUserToast && typeof showToast === 'function') showToast(msg, 'error', 3500);
        }
    } catch (e) {
        const msg = e.message || t('integrations.sync_failed');
        const errEl = document.getElementById(`${catalogSlug}-entities-error`);
        if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
        if (showUserToast && typeof showToast === 'function') showToast(msg, 'error', 3500);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i>Sync'; }
    }
};

// store current entities for toggling detail
let _currentEntities = {};

async function _loadExposedEntitiesSummary() {
    const grid = document.getElementById('ha-exposed-entities-grid');
    const empty = document.getElementById('ha-exposed-entities-empty');
    if (!grid) return;
    try {
        const res = await apiCall('/api/integrations/all-entities');
        if (!res.ok) { if (empty) empty.classList.remove('hidden'); return; }
        const data = await res.json();
        const sources = data.sources || [];
        if (!sources.length) { grid.innerHTML = ''; if (empty) empty.classList.remove('hidden'); return; }
        if (empty) empty.classList.add('hidden');
        grid.innerHTML = sources.map(src => {
            return `<div class="bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center cursor-pointer hover:bg-white/[0.06] hover:border-orange-500/20 transition-all" onclick="window.switchTab && window.switchTab('smarthome')">
                <i class="fas ${escapeHtml(src.icon)} ${escapeHtml(src.color)} text-sm mb-1"></i>
                <div class="text-[10px] font-bold text-slate-400">${escapeHtml(src.label)}</div>
                <div class="text-[11px] text-slate-500 mono">${src.count} entități</div>
            </div>`;
        }).join('') + `<div class="bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center">
            <i class="fas fa-layer-group text-accent/60 text-sm mb-1"></i>
            <div class="text-[10px] font-bold text-accent/80">Total</div>
            <div class="text-[11px] text-slate-500 mono">${data.total} entități</div>
        </div>`;
    } catch (_) {
        if (empty) empty.classList.remove('hidden');
    }
}

function _ensureEntitySection(slug) {
    if (document.getElementById(`${slug}-entities-section`)) return;
    // Try built-in integration panel first, then addon container
    const panel = document.getElementById(`integration-panel-${slug}`) || document.getElementById('addon-entities-container');
    if (!panel) return;
    const html = `<div id="${slug}-entities-section" class="mt-4 border-t border-white/5 pt-4 hidden">
        <div class="flex items-center justify-between mb-2">
            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Entități sincronizate</span>
            <div class="flex items-center gap-2">
                <button type="button" onclick="navigateToSmartHomeSource('${slug}')" class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 transition-colors">
                    <i class="fas fa-pen mr-1"></i>Redenumește
                </button>
                <span id="${slug}-entities-time" class="text-[10px] text-slate-600"></span>
                <button type="button" id="${slug}-sync-btn" onclick="syncIntegrationEntities('${slug}')" class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 transition-colors">
                    <i class="fas fa-sync-alt mr-1"></i>Sync
                </button>
            </div>
        </div>
        <div id="${slug}-entities-error" class="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2 mb-2 hidden"></div>
        <div id="${slug}-entities-grid" class="grid grid-cols-2 sm:grid-cols-3 gap-2"></div>
    </div>`;
    panel.insertAdjacentHTML('beforeend', html);
}

async function loadIntegrationEntities(slug) {
    _ensureEntitySection(slug);
    const section = document.getElementById(`${slug}-entities-section`);
    const grid = document.getElementById(`${slug}-entities-grid`);
    const timeEl = document.getElementById(`${slug}-entities-time`);
    const errEl = document.getElementById(`${slug}-entities-error`);
    if (!section || !grid) return;
    try {
        const res = await apiCall(`/api/integrations/${slug}/entities`);
        if (!res.ok) { section.classList.add('hidden'); return; }
        const data = await res.json();
        section.classList.remove('hidden');
        if (errEl) {
            if (data.last_error) { errEl.textContent = data.last_error; errEl.classList.remove('hidden'); }
            else errEl.classList.add('hidden');
        }
        if (timeEl && data.updated_at) {
            const d = new Date(data.updated_at);
            const age = Date.now() - d.getTime();
            const isStale = age > 2 * 3600_000; // older than 2h
            timeEl.textContent = d.toLocaleString('ro-RO', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
            if (isStale) timeEl.textContent += ' ⏳';
        }

        const entities = data.entities || {};
        _currentEntities = entities;
        grid.innerHTML = '';

        // Check if all entities are empty or errored
        const hasErrors = Object.values(entities).some(v => (typeof v === 'object' && !Array.isArray(v) && v?.error));
        const allEmpty = Object.values(entities).every(v => {
            if (Array.isArray(v)) return v.length === 0;
            if (typeof v === 'object' && v) return !!v.error || Object.keys(v).length === 0;
            return true;
        });
        if (allEmpty && errEl) {
            errEl.textContent = hasErrors ? 'Datele nu au putut fi încărcate. Apasă Sync pentru a reîncerca.' : 'Nicio entitate încă. Apasă Sync pentru a sincroniza.';
            errEl.classList.remove('hidden');
        }

        for (const [key, value] of Object.entries(entities)) {
            const meta = _ENTITY_LABELS[key] || { icon: 'fa-database', label: key };
            let count = '';
            if (Array.isArray(value)) count = value.length;
            else if (typeof value === 'object' && value && !value.error) count = Object.keys(value).length + ' câmpuri';
            else if (value?.error) count = '⚠ eroare';

            const card = document.createElement('div');
            card.className = 'entity-card bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center cursor-pointer hover:bg-white/[0.06] hover:border-orange-500/20 transition-all';
            card.dataset.entityKey = key;
            card.innerHTML = `<i class="fas ${meta.icon} text-orange-400/60 text-sm mb-1"></i>`
                + `<div class="text-[10px] font-bold text-slate-400">${meta.label}</div>`
                + `<div class="text-[11px] text-slate-500 mono">${count}</div>`;

            card.addEventListener('click', () => {
                _openEntityDetailModal(key, value, meta);
            });

            grid.appendChild(card);
        }
    } catch (_) {
        section.classList.add('hidden');
    }
}

function _openEntityDetailModal(key, value, meta) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body) return;
    if (iconEl) iconEl.className = `fas ${meta.icon}`;
    if (labelEl) labelEl.textContent = meta.label;
    const renderer = _DETAIL_RENDERERS[key];
    if (renderer) {
        body.innerHTML = renderer(value);
    } else {
        body.innerHTML = `<pre class="text-[9px] text-slate-500 whitespace-pre-wrap break-all">${JSON.stringify(value, null, 2).slice(0, 2000)}</pre>`;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

window.closeEntityDetailModal = closeEntityDetailModal;


let _voiceMediaRecorder = null;
let _voiceChunks = [];
let _voiceStream = null;
let _voiceAudioCtx = null;
let _voiceSilenceTimer = null;
let _VOICE_SILENCE_MS = 2500;  // stop after 2.5 s of silence (overridden by config)
let _VOICE_SILENCE_RMS = 0.015; // RMS threshold (0–1 scale) below = silence (overridden by config)

window.toggleVoiceRecording = async function(opts) {
    const _opts = opts || {};
    const btn = _opts.btn || document.getElementById('btn-voice');
    const inputId = _opts.inputId || 'user-input';
    const sendFn = _opts.sendFn || (window.sendMessage ? () => window.sendMessage() : null);
    if (!btn) return;
    console.log('[VOICE] toggleVoiceRecording called');
    console.log('[VOICE] navigator.mediaDevices:', !!navigator.mediaDevices);
    console.log('[VOICE] getUserMedia:', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    console.log('[VOICE] location:', location.protocol, location.hostname);
    console.log('[VOICE] MediaRecorder:', typeof MediaRecorder);

    if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
        console.log('[VOICE] Cancelling recording (user tapped again)');
        // Discard the recording — don't transcribe
        _voiceMediaRecorder.ondataavailable = null;
        _voiceMediaRecorder.onstop = null;
        _voiceMediaRecorder.stop();
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
        if (_voiceStream) { _voiceStream.getTracks().forEach(t => t.stop()); _voiceStream = null; }
        _voiceMediaRecorder = null;
        _voiceChunks = [];
        btn.classList.remove('recording');
        btn.querySelector('i').className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        // Flash red 2 times like listening state but red
        btn.classList.add('flash-red-cancelled');
        setTimeout(() => {
            btn.classList.remove('flash-red-cancelled');
            setTimeout(() => {
                btn.classList.add('flash-red-cancelled');
                setTimeout(() => {
                    btn.classList.remove('flash-red-cancelled');
                }, 150);
            }, 150);
        }, 150);
        return;
    }

    // Start recording
    // Check if mediaDevices API is available (requires HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        console.error('[VOICE] mediaDevices not available. isSecure:', isSecure);
        if (!isSecure) {
            showToast(t('voice.requires_https') || 'Microphone requires HTTPS or localhost. Access via HTTPS to use voice input.', 'error', 6000);
        } else {
            showToast(t('voice.mic_unavailable') || 'Microphone not available on this device/browser', 'error');
        }
        return;
    }

    try {
        console.log('[VOICE] Requesting getUserMedia({audio: true})...');
        _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('[VOICE] Got stream:', _voiceStream);
        console.log('[VOICE] Audio tracks:', _voiceStream.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })));
    } catch (e) {
        console.error('[VOICE] getUserMedia error:', e.name, e.message, e);
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
            showToast(t('voice.mic_denied') || 'Microphone access denied. Allow it in browser/device settings.', 'error', 5000);
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
            showToast(t('voice.mic_not_found') || 'No microphone found on this device', 'error');
        } else {
            showToast(t('voice.mic_error') || ('Microphone error: ' + e.message), 'error');
        }
        return;
    }

    _voiceChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus'
        : '';
    console.log('[VOICE] Selected mimeType:', mimeType || '(default)');
    const options = mimeType ? { mimeType } : {};
    _voiceMediaRecorder = new MediaRecorder(_voiceStream, options);
    console.log('[VOICE] MediaRecorder created, state:', _voiceMediaRecorder.state);

    _voiceMediaRecorder.ondataavailable = (e) => {
        console.log('[VOICE] ondataavailable: size=', e.data?.size, 'type=', e.data?.type);
        if (e.data && e.data.size > 0) _voiceChunks.push(e.data);
    };

    _voiceMediaRecorder.onstop = async () => {
        console.log('[VOICE] onstop: chunks=', _voiceChunks.length, 'total bytes=', _voiceChunks.reduce((s, c) => s + c.size, 0));
        // Cancel VAD loop
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }

        btn.classList.remove('recording');

        // Stop all tracks
        if (_voiceStream) {
            _voiceStream.getTracks().forEach(t => t.stop());
            _voiceStream = null;
        }

        if (_voiceChunks.length === 0) { _voiceMediaRecorder = null; return; }

        const recordedMime = _voiceMediaRecorder?.mimeType || 'audio/webm';
        _voiceMediaRecorder = null;
        const blob = new Blob(_voiceChunks, { type: recordedMime });
        _voiceChunks = [];
        console.log('[VOICE] Blob created: size=', blob.size, 'type=', blob.type);

        // Show transcribing state (keep amber look)
        btn.disabled = true;
        btn.classList.add('recording');
        btn.querySelector('i').className = 'fas fa-spinner fa-spin';

        try {
            const formData = new FormData();
            formData.append('file', blob, 'recording.webm');

            const token = localStorage.getItem('hyve_token');
            const headers = {};
            if (token) headers['Authorization'] = 'Bearer ' + token;

            console.log('[VOICE] Sending to /api/whisper/transcribe... blob size:', blob.size);
            const res = await fetch('/api/whisper/transcribe', {
                method: 'POST',
                headers,
                body: formData
            });
            console.log('[VOICE] Response status:', res.status);

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || 'Transcription failed');
            }

            const data = await res.json();
            console.log('[VOICE] Transcription result:', data);
            if (data.text && data.text.trim()) {
                const input = document.getElementById(inputId);
                if (input) {
                    // Append to existing text (if any), separated by space
                    const existing = input.value.trim();
                    input.value = existing ? existing + ' ' + data.text.trim() : data.text.trim();
                    input.style.height = 'auto';
                    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
                    input.focus();
                    // Auto-send after transcription; flag for auto-speak
                    if (sendFn) {
                        window.__voiceInputPending = true;
                        setTimeout(() => sendFn(), 300);
                    }
                }
            } else {
                showToast(t('voice.no_speech') || 'No speech detected', 'info');
            }
        } catch (e) {
            console.error('[VOICE] Transcription error:', e);
            showToast(t('voice.transcribe_error') || 'Transcription error: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.classList.remove('recording');
            btn.querySelector('i').className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
    };

    _voiceMediaRecorder.onerror = (ev) => {
        console.error('[VOICE] MediaRecorder error:', ev, ev.error);
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
        btn.classList.remove('recording');
        if (_voiceStream) {
            _voiceStream.getTracks().forEach(t => t.stop());
            _voiceStream = null;
        }
        _voiceMediaRecorder = null;
        showToast(t('voice.recording_error') || 'Recording error', 'error');
    };

    btn.classList.add('recording');
    _voiceMediaRecorder.start(250);
    console.log('[VOICE] Recording started, state:', _voiceMediaRecorder.state);

    // ── Voice Activity Detection: auto-stop on silence ──────────────
    try {
        _voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = _voiceAudioCtx.createMediaStreamSource(_voiceStream);
        const analyser = _voiceAudioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let silenceStart = null;

        const checkLevel = () => {
            if (!_voiceMediaRecorder || _voiceMediaRecorder.state !== 'recording') return;
            analyser.getByteTimeDomainData(buf);
            // Compute RMS (each sample centred at 128)
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);

            if (rms < _VOICE_SILENCE_RMS) {
                if (!silenceStart) silenceStart = Date.now();
                else if (Date.now() - silenceStart >= _VOICE_SILENCE_MS) {
                    console.log('[VOICE] Silence detected — auto-stopping');
                    _voiceMediaRecorder.stop();
                    return; // exit loop
                }
            } else {
                silenceStart = null; // speech detected — reset timer
            }
            _voiceSilenceTimer = requestAnimationFrame(checkLevel);
        };
        _voiceSilenceTimer = requestAnimationFrame(checkLevel);
    } catch (err) {
        console.warn('[VOICE] VAD init failed (fallback to manual stop):', err);
    }
};

// ═══════════════════════════════════════════
//  ALWAYS-SPEAK + VOICE LOOP + KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════

/** Sync VAD settings from config DOM to runtime vars */
function _syncVadSettings() {
    const ms = parseInt(document.getElementById('whisper_vad_silence_ms')?.value, 10);
    if (ms >= 500 && ms <= 10000) _VOICE_SILENCE_MS = ms;
    const sens = document.getElementById('whisper_vad_sensitivity')?.value || 'medium';
    const rmsMap = { low: 0.025, medium: 0.015, high: 0.008 };
    _VOICE_SILENCE_RMS = rmsMap[sens] || 0.015;
}

/** Always-Speak toggle button handler */
function _initAlwaysSpeakBtn() {
    const btn = document.getElementById('btn-always-speak');
    if (!btn) return;
    if (btn.dataset.boundAlwaysSpeak === '1') return;
    btn.dataset.boundAlwaysSpeak = '1';
    // Restore state from _tts
    const tts = window.__tts;
    if (tts && tts.alwaysSpeak) {
        btn.classList.add('active');
        btn.querySelector('i').className = 'fas fa-volume-up';
    }
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tts = window.__tts;
        if (!tts) return;

        // If TTS is currently speaking, clicking this animated button should stop playback first.
        const isSpeakingNow = !!((tts.audio && !tts.audio.paused) || tts._streamPlaying);
        if (isSpeakingNow && typeof tts.stop === 'function') {
            try { tts.stop(); } catch (_) {}
            return;
        }

        tts.alwaysSpeak = !tts.alwaysSpeak;
        btn.classList.toggle('active', tts.alwaysSpeak);
        btn.querySelector('i').className = tts.alwaysSpeak ? 'fas fa-volume-up' : 'fas fa-volume-off';

        // Ensure piper_enabled checkbox matches (button is only visible when piper is on,
        // but guard against stale state from config reloads).
        const piperCb = document.getElementById('piper_enabled');
        if (tts.alwaysSpeak && piperCb && !piperCb.checked) piperCb.checked = true;

        // UX: when enabling, start speaking the latest AI bubble immediately.
        if (tts.alwaysSpeak) {
            const bubbles = document.querySelectorAll('.chat-row-ai .ai-bubble');
            const lastBubble = bubbles && bubbles.length ? bubbles[bubbles.length - 1] : null;
            if (lastBubble && typeof tts.speak === 'function') {
                try { await tts.speak(lastBubble); } catch (err) { console.warn('[TTS] speak failed:', err); }
            }
        } else if (typeof tts.stop === 'function') {
            try { tts.stop(); } catch (_) {}
        }

        // Persist: include enabled:true so backend doesn't reject synthesize calls.
        try {
            const patch = { piper: { always_speak: !!tts.alwaysSpeak } };
            if (tts.alwaysSpeak) patch.piper.enabled = true;
            await apiCall('/api/config', { method: 'PATCH', body: patch });
        } catch (_) {}
    });
}

/** Voice balloon — long-press / right-click mic opens popup with voice loop toggle */
function _initVoiceBalloon() {
    const voiceBtn = document.getElementById('btn-voice');
    const balloon = document.getElementById('voice-mode-balloon');
    const loopToggle = document.getElementById('voice-loop-toggle');
    const loopBadge = document.getElementById('voice-loop-badge');
    if (!voiceBtn || !balloon) return;

    let longPressTimer = null;
    let didLongPress = false;

    function closeBalloon() {
        balloon.classList.add('hidden');
    }
    function openBalloon() {
        balloon.classList.remove('hidden');
    }
    function _syncLoopUI() {
        const on = !!window.__voiceLoopActive;
        if (loopBadge) {
            loopBadge.textContent = on ? 'ON' : 'OFF';
            loopBadge.classList.toggle('on', on);
            loopBadge.classList.toggle('off', !on);
        }
        voiceBtn.classList.toggle('voice-loop-active', on);
        // Change mic icon to show loop mode
        const icon = voiceBtn.querySelector('i');
        if (icon && !voiceBtn.classList.contains('recording')) {
            icon.className = on ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
        // When voice loop on, force always-speak
        if (on && window.__tts) {
            window.__tts.alwaysSpeak = true;
            const asBtn = document.getElementById('btn-always-speak');
            if (asBtn) {
                asBtn.classList.add('active');
                asBtn.querySelector('i').className = 'fas fa-volume-up';
            }
            const cb = document.getElementById('piper_always_speak');
            if (cb) cb.checked = true;
        }
    }

    // Long-press on touch devices → open balloon
    voiceBtn.addEventListener('touchstart', () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
            didLongPress = true;
            if (balloon.classList.contains('hidden')) openBalloon();
            else closeBalloon();
        }, 500);
    }, { passive: true });
    voiceBtn.addEventListener('touchend', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (didLongPress) {
            e.preventDefault(); // prevent click from firing
        }
    });
    voiceBtn.addEventListener('touchcancel', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    // Right-click on desktop → open balloon
    voiceBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (balloon.classList.contains('hidden')) openBalloon();
        else closeBalloon();
    });

    // Normal click = toggle voice recording (always works — no long-press interference on desktop)
    voiceBtn.addEventListener('click', (e) => {
        if (didLongPress) { didLongPress = false; return; }
        window.toggleVoiceRecording();
    });

    // Toggle voice loop from balloon
    if (loopToggle) {
        loopToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            window.__voiceLoopActive = !window.__voiceLoopActive;
            _syncLoopUI();
            closeBalloon();
        });
    }

    // Close balloon on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.voice-btn-wrap')) closeBalloon();
    });

    // Listen for tts:ended to restart mic in voice loop mode
    window.addEventListener('tts:ended', (e) => {
        if (!window.__voiceLoopActive) return;
        if (!e.detail?.voiceLoop) return;
        setTimeout(() => {
            if (window.__voiceLoopActive) {
                window.toggleVoiceRecording();
            }
        }, 400);
    });

    _syncLoopUI();
}

/** Keyboard shortcuts: Space=push-to-talk, V=toggle recording */
function _initVoiceKeyboardShortcuts() {
    let spaceHeld = false;

    document.addEventListener('keydown', (e) => {
        // Ignore when typing in input/textarea/contenteditable
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        // Space = push-to-talk (hold)
        if (e.code === 'Space' && !e.repeat) {
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && !voiceBtn.classList.contains('hidden')) {
                e.preventDefault();
                spaceHeld = true;
                // Start recording if not already
                if (!_voiceMediaRecorder || _voiceMediaRecorder.state !== 'recording') {
                    window.toggleVoiceRecording();
                }
            }
        }

        // V = toggle voice recording
        if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey) {
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && !voiceBtn.classList.contains('hidden')) {
                e.preventDefault();
                window.toggleVoiceRecording();
            }
        }

        // Escape = stop TTS
        if (e.code === 'Escape' && window.__tts) {
            window.__tts.stop();
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spaceHeld) {
            spaceHeld = false;
            // Stop recording (send for transcription)
            if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
                _voiceMediaRecorder.stop();
            }
        }
    });
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        _syncVadSettings();
        _initAlwaysSpeakBtn();
        _initVoiceBalloon();
        _initVoiceKeyboardShortcuts();
    });
} else {
    _syncVadSettings();
    _initAlwaysSpeakBtn();
    _initVoiceBalloon();
    _initVoiceKeyboardShortcuts();
}

// ═══════════════════════════════════════════
//  NOTIFICATION SETTINGS
// ═══════════════════════════════════════════

let _notifWsStatusTimer = null;
let _notifSettingsHydrating = false;
let _notifAutoSaveBound = false;
let _notifAutoSaveTimer = null;

function _applyNotifRuntimeTransport(transport) {
    const wsEnabled = transport === 'websocket';
    try {
        if (window.notificationTimer && typeof window.notificationTimer.setEnabled === 'function') {
            window.notificationTimer.setEnabled(wsEnabled);
        }
    } catch (_) {}

    if (window.__HYVE_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try { window.__setNativeWsServiceEnabled(wsEnabled); } catch (_) {}
    }
}

function _getSelectedChannel() {
    const appRadio = document.querySelector('input[name="notif_channel"][value="app"]');
    return appRadio && appRadio.checked ? 'app' : 'whatsapp';
}

function _queueNotificationSettingsAutoSave() {
    if (_notifSettingsHydrating) return;
    if (_notifAutoSaveTimer) clearTimeout(_notifAutoSaveTimer);
    _notifAutoSaveTimer = setTimeout(() => {
        _notifAutoSaveTimer = null;
        saveNotificationSettings({ silent: true });
    }, 220);
}

function _bindNotificationSettingsAutoSave() {
    if (_notifAutoSaveBound) return;
    _notifAutoSaveBound = true;

    const bindInput = (id, eventName = 'input') => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener(eventName, _queueNotificationSettingsAutoSave);
    };

    bindInput('fcm_project_id', 'input');
    bindInput('fcm_service_account_path', 'input');

    const channelRadios = document.querySelectorAll('input[name="notif_channel"]');
    channelRadios.forEach((el) => el.addEventListener('change', _queueNotificationSettingsAutoSave));

    const transportRadios = document.querySelectorAll('input[name="notif_transport"]');
    transportRadios.forEach((el) => el.addEventListener('change', _queueNotificationSettingsAutoSave));
}

/** Select notification channel: 'app' (Hyve) or 'whatsapp'. */
export function selectNotifChannel(channel, opts = {}) {
    const persist = opts.persist !== false;
    const cards = { app: document.getElementById('notif-card-app'), whatsapp: document.getElementById('notif-card-whatsapp') };
    const appGroup = document.getElementById('notif-app-settings-group');
    const waSection = document.getElementById('notif-whatsapp-section');

    for (const [key, card] of Object.entries(cards)) {
        if (!card) continue;
        const radio = card.querySelector('input[type="radio"]');
        if (key === channel) {
            card.classList.remove('border-white/10', 'bg-transparent');
            card.classList.add(key === 'app' ? 'border-blue-500/40' : 'border-emerald-500/40',
                              key === 'app' ? 'bg-blue-500/5' : 'bg-emerald-500/5');
            if (radio) radio.checked = true;
        } else {
            card.classList.remove('border-blue-500/40', 'border-emerald-500/40', 'bg-blue-500/5', 'bg-emerald-500/5');
            card.classList.add('border-white/10', 'bg-transparent');
            if (radio) radio.checked = false;
        }
    }

    const appOn = channel === 'app';
    if (appGroup) appGroup.classList.toggle('hidden', !appOn);
    if (waSection) waSection.classList.toggle('hidden', appOn);

    // When switching to WhatsApp, disable WS runtime
    if (!appOn) {
        _applyNotifRuntimeTransport('off');
        _stopNotifWsStatusPolling();
    }

    if (persist) {
        _queueNotificationSettingsAutoSave();
    }
}

/** Highlight the selected transport card and show/hide settings sections. */
export function selectNotifTransport(transport, opts = {}) {
    const persist = opts.persist !== false;
    const cards = { websocket: document.getElementById('notif-card-websocket'), firebase: document.getElementById('notif-card-firebase') };
    const sections = { websocket: document.getElementById('notif-ws-settings'), firebase: document.getElementById('notif-fcm-settings') };

    for (const [key, card] of Object.entries(cards)) {
        if (!card) continue;
        const radio = card.querySelector('input[type="radio"]');
        if (key === transport) {
            card.classList.remove('border-white/10', 'bg-transparent');
            card.classList.add(key === 'websocket' ? 'border-emerald-500/40' : 'border-orange-500/40',
                              key === 'websocket' ? 'bg-emerald-500/5' : 'bg-orange-500/5');
            if (radio) radio.checked = true;
        } else {
            card.classList.remove('border-emerald-500/40', 'border-orange-500/40', 'bg-emerald-500/5', 'bg-orange-500/5');
            card.classList.add('border-white/10', 'bg-transparent');
            if (radio) radio.checked = false;
        }
    }

    for (const [key, sec] of Object.entries(sections)) {
        if (sec) sec.classList.toggle('hidden', key !== transport);
    }

    // Start/stop WS status polling
    if (transport === 'websocket') {
        _refreshNotifWsStatus();
        _startNotifWsStatusPolling();
    } else {
        _stopNotifWsStatusPolling();
    }

    _applyNotifRuntimeTransport(transport);

    // Auto-refresh native WS badge (immediate + delayed to catch async service start)
    refreshNotifWsNativeStatus();
    setTimeout(refreshNotifWsNativeStatus, 1200);

    if (persist) {
        _queueNotificationSettingsAutoSave();
    }
}

function _startNotifWsStatusPolling() {
    _stopNotifWsStatusPolling();
    _notifWsStatusTimer = setInterval(() => {
        const tab = document.getElementById('cfg-tab-notifications');
        if (!tab || tab.classList.contains('hidden')) { _stopNotifWsStatusPolling(); return; }
        _refreshNotifWsStatus();
    }, 5000);
}

function _stopNotifWsStatusPolling() {
    if (_notifWsStatusTimer) { clearInterval(_notifWsStatusTimer); _notifWsStatusTimer = null; }
}

async function _refreshNotifWsStatus() {
    const badge = document.getElementById('notif-ws-status-badge');
    const countEl = document.getElementById('notif-ws-conn-count');
    try {
        const res = await apiCall('/api/notifications/ws-status');
        if (res.ok) {
            const data = await res.json();
            if (badge) {
                badge.classList.remove('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10',
                                      'border-red-500/30', 'text-red-400', 'bg-red-500/10',
                                      'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
                if (data.connected) {
                    badge.textContent = t('common.connected') || 'Connected';
                    badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
                } else {
                    badge.textContent = t('common.disconnected') || 'Disconnected';
                    badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
                }
            }
            if (countEl) countEl.textContent = String(data.connection_count || 0);
        }
    } catch (e) {
        if (badge) { badge.textContent = t('common.error') || 'Error'; badge.className = 'text-[10px] font-bold px-2.5 py-1 rounded-full border border-red-500/30 text-red-400 bg-red-500/10'; }
    }
}

/** Refresh the native Android WS service status badge. */
export function refreshNotifWsNativeStatus() {
    const badge = document.getElementById('notif-ws-native-status');
    if (!badge) return;
    badge.classList.remove('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10',
                           'border-red-500/30', 'text-red-400', 'bg-red-500/10',
                           'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
    if (!window.__HYVE_NATIVE_APP || typeof window.__getNativeWsServiceStatus !== 'function') {
        badge.textContent = t('common.na') || 'N/A';
        badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
        return;
    }
    try {
        const running = window.__getNativeWsServiceStatus();
        if (running === true) {
            badge.textContent = t('common.running') || 'Running';
            badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
        } else if (running === false) {
            badge.textContent = t('common.stopped') || 'Stopped';
            badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
        } else {
            badge.textContent = t('common.unknown') || 'Unknown';
            badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
        }
    } catch (e) {
        badge.textContent = t('common.error') || 'Error';
        badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
    }
}

/** Send a test notification on the currently selected transport. */
export async function testNotification() {
    const wsRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transport = wsRadio && wsRadio.checked ? 'websocket' : 'firebase';
    const label = transport === 'websocket' ? 'WebSocket' : 'FCM';

    try {
        const res = await apiCall('/api/notifications/test-channel', {
            method: 'POST',
            body: { transport }
        });
        if (!res.ok) {
            showToast(`Eroare la testul ${label}.`, 'error');
            return;
        }
        const data = await res.json();
        if (data.delivered) {
            const extra = data.sent_count ? ` (${data.sent_count} dispozitiv${data.sent_count === 1 ? '' : 'e'})` : '';
            showToast(`Test ${label} trimis cu succes!${extra}`, 'success');
        } else if (data.detail === 'no_ws_connection') {
            showToast(t('hy.no_ws_connection'), 'warning');
        } else if (data.detail === 'fcm_disabled') {
            showToast(t('hy.fcm_inactive'), 'warning');
        } else if (data.detail === 'no_devices') {
            showToast(t('hy.fcm_no_devices'), 'warning');
        } else {
            showToast(`Test ${label}: nicio livrare.`, 'warning');
        }
    } catch (e) {
        showToast(`Eroare la testul ${label}.`, 'error');
    }
}

/** Send a test notification via WebSocket only (legacy). */
export async function testWsNotification() {
    return testNotification();
}

/** Send a test notification via Firebase FCM only (legacy). */
export async function testFcmNotification() {
    return testNotification();
}

/** Load notification settings and populate the Notifications tab. */
export async function loadNotificationPrefs() {
    try {
        _notifSettingsHydrating = true;
        const [userRes, cfgRes] = await Promise.all([
            apiCall('/api/users/me'),
            apiCall('/api/config')
        ]);

        let cfg = {};
        if (cfgRes.ok) {
            cfg = await cfgRes.json();
        }

        // Determine transport: map old hybrid/legacy to websocket
        const fcm = cfg.fcm || {};
        let transport = String(fcm.transport_mode || 'websocket').toLowerCase();
        if (transport === 'hybrid') transport = 'websocket'; // hybrid → websocket (simplified)

        // Populate FCM fields
        const fcmProject = document.getElementById('fcm_project_id');
        const fcmSaPath = document.getElementById('fcm_service_account_path');
        if (fcmProject) fcmProject.value = fcm.project_id || '';
        if (fcmSaPath) fcmSaPath.value = fcm.service_account_path || '';

        // Select transport card (this shows/hides sections)
        selectNotifTransport(transport, { persist: false });

        // User notification prefs → channel selector
        let channel = 'app';
        if (userRes.ok) {
            const user = await userRes.json();
            const prefs = user.notification_prefs || { app: true, whatsapp: false };
            channel = prefs.whatsapp && !prefs.app ? 'whatsapp' : 'app';
        }

        // If WAHA is not enabled, force app channel and hide WhatsApp card
        const wahaOn = !!(cfg.waha && cfg.waha.enabled);
        const waCard = document.getElementById('notif-card-whatsapp');
        if (!wahaOn) {
            channel = 'app';
            if (waCard) waCard.classList.add('hidden');
        } else {
            if (waCard) waCard.classList.remove('hidden');
        }

        selectNotifChannel(channel, { persist: false });
    } catch (e) {
        console.warn('Failed to load notification settings:', e);
    } finally {
        _notifSettingsHydrating = false;
        _bindNotificationSettingsAutoSave();
    }
}

/** Save notification settings from the Notifications tab. */
export async function saveNotificationSettings(options = {}) {
    const silent = options.silent === true;

    // Determine selected transport
    const wsRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transport = wsRadio && wsRadio.checked ? 'websocket' : 'firebase';

    // Save config (FCM/transport settings) — uses merge, so only fcm key is updated
    try {
        const newFcm = {
            enabled: transport === 'firebase',
            transport_mode: transport,
            websocket_enabled: transport === 'websocket',
            project_id: (document.getElementById('fcm_project_id')?.value || '').trim(),
            service_account_path: (document.getElementById('fcm_service_account_path')?.value || '').trim(),
            send_when_ws_disconnected: true,
        };

        const saveRes = await apiCall('/api/config', {
            method: 'POST',
            body: { fcm: newFcm }
        });

        if (!saveRes.ok) {
            if (!silent) showToast(t('hy.config_save_error'), 'error');
            return;
        }
    } catch (e) {
        if (!silent) showToast(t('hy.config_save_error'), 'error');
        return;
    }

    // Save user notification prefs (channel)
    const channel = _getSelectedChannel();
    const appOn = channel === 'app';
    try {
        await apiCall('/api/users/me', {
            method: 'PATCH',
            body: { notification_prefs: { app: appOn, whatsapp: !appOn } }
        });
    } catch (e) {}

    if (appOn) {
        _applyNotifRuntimeTransport(transport);
    } else {
        _applyNotifRuntimeTransport('off');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADDONS / APPS
// ═══════════════════════════════════════════════════════════════════════════

let _currentAddonSlug = null;

const _addonColorMap = {
    cyan: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: '#22d3ee', btnBg: 'bg-cyan-500/15', btnHover: 'hover:bg-cyan-500/25', btnText: 'text-cyan-300', btnBorder: 'border-cyan-500/25' },
    blue: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: '#3b82f6', btnBg: 'bg-blue-500/15', btnHover: 'hover:bg-blue-500/25', btnText: 'text-blue-300', btnBorder: 'border-blue-500/25' },
    emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: '#10b981', btnBg: 'bg-emerald-500/15', btnHover: 'hover:bg-emerald-500/25', btnText: 'text-emerald-300', btnBorder: 'border-emerald-500/25' },
    amber: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: '#f59e0b', btnBg: 'bg-amber-500/15', btnHover: 'hover:bg-amber-500/25', btnText: 'text-amber-300', btnBorder: 'border-amber-500/25' },
    violet: { bg: 'bg-violet-500/20', text: 'text-violet-400', border: '#8b5cf6', btnBg: 'bg-violet-500/15', btnHover: 'hover:bg-violet-500/25', btnText: 'text-violet-300', btnBorder: 'border-violet-500/25' },
    rose: { bg: 'bg-rose-500/20', text: 'text-rose-400', border: '#f43f5e', btnBg: 'bg-rose-500/15', btnHover: 'hover:bg-rose-500/25', btnText: 'text-rose-300', btnBorder: 'border-rose-500/25' },
    indigo: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', border: '#6366f1', btnBg: 'bg-indigo-500/15', btnHover: 'hover:bg-indigo-500/25', btnText: 'text-indigo-300', btnBorder: 'border-indigo-500/25' },
};
const _defaultColor = { bg: 'bg-slate-500/20', text: 'text-slate-400', border: '#64748b', btnBg: 'bg-slate-500/15', btnHover: 'hover:bg-slate-500/25', btnText: 'text-slate-300', btnBorder: 'border-slate-500/25' };

export async function loadAddons() {
    const container = document.getElementById('addons-list');
    if (!container) return;

    let addons = [];
    try {
        const res = await apiCall('/api/addons');
        if (res.ok) addons = await res.json();
    } catch (e) {
        container.innerHTML = '<p class="text-sm text-red-400 text-center py-8">Eroare la încărcarea add-on-urilor.</p>';
        return;
    }

    if (!addons.length) {
        container.innerHTML = '<p class="text-sm text-slate-500 text-center py-8">Niciun add-on disponibil.</p>';
        return;
    }

    container.innerHTML = addons.map(addon => _renderAddonCard(addon)).join('');
}

function _renderAddonCard(addon) {
    const s = addon.state || {};
    const installed = !!s.installed;
    const enabled = !!s.enabled;
    const c = _addonColorMap[addon.color] || _defaultColor;
    const slug = escapeHtml(addon.slug);
    const name = escapeHtml(addon.name);
    const desc = escapeHtml(addon.description || '');
    const version = escapeHtml(addon.version || '');

    let statusBadge = '';
    let actions = '';

    if (installed) {
        if (enabled) {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 text-emerald-400 bg-emerald-500/10">Activ</span>`;
        } else {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 bg-amber-500/10">Instalat</span>`;
        }
        actions = `
            <button type="button" onclick="openAddonConfigModal('${slug}')" class="px-4 py-2 rounded-xl text-xs font-medium bg-white/5 hover:${c.btnBg} text-slate-300 hover:${c.btnText} border border-white/10 transition-colors">
                <i class="fas fa-cog mr-1"></i> Configurare
            </button>
            ${enabled
                ? `<button type="button" onclick="toggleAddon('${slug}', false)" class="integration-toggle-btn integration-btn-disable text-red-500/70 hover:text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-red-500/20"><i class="fas fa-power-off"></i> Disable</button>`
                : `<button type="button" onclick="toggleAddon('${slug}', true)" class="integration-toggle-btn integration-btn-enable text-emerald-500/70 hover:text-emerald-500 hover:bg-emerald-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-emerald-500/20"><i class="fas fa-check"></i> Enable</button>`
            }
            <button type="button" onclick="uninstallAddon('${slug}')" class="text-red-500/50 hover:text-red-500 hover:bg-red-500/10 px-2 py-2 rounded-xl text-[10px] transition-all border border-transparent hover:border-red-500/20" title="Dezinstalare"><i class="fas fa-trash-alt"></i></button>
        `;
    } else {
        statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-500/30 text-slate-500">Disponibil</span>`;
        actions = `
            <button type="button" onclick="installAddon('${slug}')" class="${c.btnBg} ${c.btnHover} ${c.btnText} border ${c.btnBorder} px-4 py-2 rounded-xl text-xs font-medium transition-colors inline-flex items-center gap-1.5">
                <i class="fas fa-download"></i> Instalează
            </button>
        `;
    }

    return `
        <div class="cfg-section flex flex-wrap items-center justify-between gap-3" style="border-left: 4px solid ${c.border};" id="addon-card-${slug}">
            <div class="flex items-center gap-3 flex-wrap min-w-0">
                <span class="w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0"><i class="${escapeHtml(addon.icon || 'fas fa-puzzle-piece')} ${c.text} text-xl"></i></span>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-bold ${c.text}">${name}</span>
                        ${statusBadge}
                        ${version ? `<span class="text-[10px] text-slate-600">v${version}</span>` : ''}
                    </div>
                    <p class="text-[10px] text-slate-500 mt-0.5 leading-relaxed">${desc}</p>
                </div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
                ${actions}
            </div>
        </div>
    `;
}

export async function installAddon(slug) {
    const card = document.getElementById(`addon-card-${slug}`);
    const btn = card?.querySelector('button');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Se instalează...'; }

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/install`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_installed'), 'success');
            await loadAddons();
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Eroare la instalare', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Instalează'; }
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Instalează'; }
    }
}

export async function uninstallAddon(slug) {
    if (!(await showConfirm(`Dezinstalezi add-on-ul "${slug}"?`))) return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_uninstalled'), 'success');
            await loadAddons();
        } else {
            showToast(t('hy.addon_uninstall_error'), 'error');
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function toggleAddon(slug, enabled) {
    const ep = enabled ? 'enable' : 'disable';
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${ep}`, { method: 'POST' });
        if (res.ok) {
            showToast(enabled ? 'Add-on activat' : 'Add-on dezactivat', 'success');
            await loadAddons();
        } else {
            showToast(t('common.error'), 'error');
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function openAddonConfigModal(slug) {
    _currentAddonSlug = slug;
    const titleEl = document.getElementById('addon-config-modal-title');
    const iconEl = document.getElementById('addon-config-modal-icon');
    const fieldsEl = document.getElementById('addon-config-fields');
    if (!fieldsEl) return;

    let addon = null;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}`);
        if (res.ok) addon = await res.json();
    } catch (e) {}

    if (!addon) { showToast(t('hy.addon_not_found'), 'error'); return; }

    if (titleEl) titleEl.textContent = addon.name || slug;
    if (iconEl) iconEl.className = `${addon.icon || 'fas fa-puzzle-piece'}`;

    const schema = addon.config_schema || [];
    const cfg = addon.state?.config || {};

    fieldsEl.innerHTML = schema.map(field => {
        const val = cfg[field.key] ?? field.default ?? '';
        const key = escapeHtml(field.key);
        const label = escapeHtml(field.label || field.key);
        const desc = field.description ? `<p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(field.description)}</p>` : '';
        const ph = escapeHtml(field.placeholder || '');

        if (field.type === 'number') {
            return `<div class="space-y-1">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                <input type="number" data-addon-key="${key}" value="${escapeHtml(String(val))}" placeholder="${ph}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-xs mono text-slate-300 focus:border-accent outline-none">
                ${desc}
            </div>`;
        }
        return `<div class="space-y-1">
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
            <input type="text" data-addon-key="${key}" value="${escapeHtml(String(val))}" placeholder="${ph}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-xs mono text-slate-300 focus:border-accent outline-none">
            ${desc}
        </div>`;
    }).join('');

    if (addon.start_command) {
        const args = (addon.start_command.args || []).map(a => {
            return a.replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? k);
        });
        const cmd = `${addon.start_command.command} ${args.join(' ')}`;
        fieldsEl.innerHTML += `
            <div class="mt-4 pt-4 border-t border-white/5 space-y-2">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Comandă de pornire</p>
                <code class="block bg-slate-900 border border-white/5 rounded-xl p-3 text-[11px] mono text-slate-400 break-all select-all">${escapeHtml(cmd)}</code>
                <p class="text-[10px] text-slate-600">${escapeHtml(addon.start_command.description || '')}</p>
            </div>
        `;
    }

    const healthResult = document.getElementById('addon-health-result');
    if (healthResult) { healthResult.classList.add('hidden'); healthResult.textContent = ''; }

    // Watchdog toggle
    const watchdogToggle = document.getElementById('addon-watchdog-toggle');
    const watchdogSection = document.getElementById('addon-watchdog-section');
    if (watchdogToggle) watchdogToggle.checked = !!(addon.state?.watchdog);
    // Only show watchdog if addon has a start_command
    if (watchdogSection) watchdogSection.classList.toggle('hidden', !addon.start_command);

    // Clear previous addon entity section and load entities
    const addonEntContainer = document.getElementById('addon-entities-container');
    if (addonEntContainer) addonEntContainer.innerHTML = '';
    const entitySlug = addon.integration_key || slug;
    loadIntegrationEntities(entitySlug);

    openSubPage('addon-config-modal');
}

export function closeAddonConfigModal() {
    _currentAddonSlug = null;
    closeSubPage('addon-config-modal');
}

export async function saveAddonConfig() {
    if (!_currentAddonSlug) return;
    const fields = document.querySelectorAll('#addon-config-fields [data-addon-key]');
    const config = {};
    fields.forEach(f => {
        const key = f.dataset.addonKey;
        config[key] = f.type === 'number' ? Number(f.value) : f.value;
    });

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/config`, {
            method: 'PATCH',
            body: config,
        });
        if (!res.ok) {
            showToast(t('hy.addon_config_save_error'), 'error');
            return;
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
        return;
    }

    // Save watchdog setting
    const watchdogToggle = document.getElementById('addon-watchdog-toggle');
    if (watchdogToggle && !watchdogToggle.closest('.hidden')) {
        try {
            await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/watchdog`, {
                method: 'POST',
                body: { enabled: watchdogToggle.checked },
            });
        } catch (e) {}
    }

    showToast(t('hy.addon_config_saved'), 'success');
}

export async function checkAddonHealth() {
    if (!_currentAddonSlug) return;
    const resultEl = document.getElementById('addon-health-result');
    const btn = document.getElementById('addon-health-btn');
    if (btn) btn.disabled = true;
    if (resultEl) { resultEl.classList.remove('hidden'); resultEl.className = 'text-xs rounded-xl p-3 bg-slate-900 border border-white/5 text-slate-400'; resultEl.textContent = t('common.checking') || 'Checking...'; }

    const formatHealthError = (detail) => {
        const raw = String(detail || '').trim();
        const low = raw.toLowerCase();
        if (!raw) return 'Serviciul nu răspunde.';
        if (low === 'not_running') return 'Add-on-ul nu este instalat sau nu este activat.';
        if (low === 'no_port_configured') return 'Portul nu este configurat în Add-on settings.';
        if (low.includes('connection refused') || low.includes('errno 61')) {
            return 'Serviciul nu rulează pe host/port-ul configurat. Pornește Piper și verifică host/port.';
        }
        if (low.includes('timed out') || low.includes('timeout')) {
            return 'Timeout la conectare. Verifică host/port și firewall-ul.';
        }
        return raw;
    };

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/health`);
        const data = await res.json();
        if (data.ok) {
            if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'; resultEl.textContent = `✓ Conectat — ${data.detail || 'OK'}`; }
        } else {
            if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-red-500/10 border border-red-500/20 text-red-400'; resultEl.textContent = `✗ Eroare — ${formatHealthError(data.detail)}`; }
        }
    } catch (e) {
        if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-red-500/10 border border-red-500/20 text-red-400'; resultEl.textContent = `✗ Eroare de rețea`; }
    }
    if (btn) btn.disabled = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATES — Add-on update management
// ─────────────────────────────────────────────────────────────────────────────

let _addonUpdatesCache = [];

/** Update the iOS-style badge on the Updates hub card with the number of available updates. */
export function updateHeaderUpdatesBadge(count) {
    const badge = document.getElementById('hub-updates-badge-count');
    if (!badge) return;
    const n = Math.max(0, parseInt(count, 10) || 0);
    if (n <= 0) {
        badge.classList.add('hidden');
        return;
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.remove('hidden');
    // Replay animation
    badge.style.animation = 'none';
    void badge.offsetWidth;
    badge.style.animation = '';
}

/** Background poll for available add-on updates and refresh the header badge. */
export async function refreshUpdatesHeaderBadge() {
    if (window.__isAdmin === false) return;
    try {
        const res = await apiCall('/api/updates/addons');
        if (!res.ok) return;
        const data = await res.json();
        updateHeaderUpdatesBadge(data?.total_updates || 0);
    } catch (_) {}
}

export async function loadUpdatesAddons() {
    const list = document.getElementById('updates-addons-list');
    if (!list) return;
    list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('updates.loading'))}</div>`;
    _setUpdatesStatus('', 'hidden');
    try {
        const res = await apiCall('/api/updates/addons');
        const data = await res.json();
        _addonUpdatesCache = data.addons || [];
        updateHeaderUpdatesBadge(data.total_updates || 0);
        _renderAddonUpdateRows();
    } catch (e) {
        list.innerHTML = `<div class="text-center py-8 text-red-400 text-xs"><i class="fas fa-triangle-exclamation mr-2"></i>${escapeHtml(e.message || String(e))}</div>`;
    }
}

export async function checkAddonUpdates() {
    const btn = document.getElementById('updates-addons-check-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`; }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.checking'))}`, 'info');
    try {
        await apiCall('/api/updates/addons/check', { method: 'POST' });
        // Reload the full list so badges/state reflect the recomputed result.
        await loadUpdatesAddons();
        const count = _addonUpdatesCache.filter(a => a.update_available).length;
        if (count > 0) {
            _setUpdatesStatus(`<i class="fas fa-arrow-up mr-1.5"></i>${escapeHtml(t('updates.n_updates_available', { count }))}`, 'warning');
        } else {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.all_up_to_date'))}`, 'success');
        }
    } catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e.message || String(e))}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-rotate"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`; }
    }
}

export async function updateAllAddons() {
    const pending = _addonUpdatesCache.filter(a => a.update_available);
    if (!pending.length) return;
    if (!(await showConfirm(t('updates.confirm_update_addons', { count: pending.length })))) return;
    await _runAddonUpdate({ all: true });
}

export async function updateSingleAddon(slug) {
    const addon = _addonUpdatesCache.find(a => a.slug === slug);
    const name = addon ? addon.name : slug;
    if (!(await showConfirm(t('updates.confirm_update_addon', { name })))) return;
    await _runAddonUpdate({ slugs: [slug] });
}

async function _runAddonUpdate(body) {
    const upgradeBtn = document.getElementById('updates-addons-upgrade-btn');
    if (upgradeBtn) { upgradeBtn.disabled = true; upgradeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.upgrade_btn_loading'))}</span>`; }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.installing'))}`, 'info');
    try {
        const res = await apiCall('/api/updates/addons/update', { method: 'POST', body });
        const data = await res.json();
        if (data.status === 'ok') {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.addons_updated', { count: (data.updated || []).length }))}`, 'success');
        } else if (data.status === 'partial') {
            _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(data.message || '')}`, 'warning');
        } else {
            let html = `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(data.message || t('updates.save_error'))}`;
            if (data.failed && data.failed.length) {
                html += `<ul class="mt-2 ml-4 list-disc text-[10px] space-y-0.5">`;
                for (const f of data.failed) html += `<li><strong>${escapeHtml(f.slug)}</strong> — ${escapeHtml(f.error || '')}</li>`;
                html += `</ul>`;
            }
            _setUpdatesStatus(html, 'error');
        }
        await loadUpdatesAddons();
    } catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e.message || String(e))}`, 'error');
    } finally {
        if (upgradeBtn) { upgradeBtn.disabled = false; upgradeBtn.innerHTML = `<i class="fas fa-arrow-up"></i><span>${escapeHtml(t('updates.upgrade_all_btn'))}</span>`; }
    }
}

const _ADDON_COLOR_MAP = {
    cyan: 'text-cyan-400', blue: 'text-blue-400', purple: 'text-purple-400',
    fuchsia: 'text-fuchsia-400', amber: 'text-amber-400', red: 'text-red-400',
    green: 'text-green-400', emerald: 'text-emerald-400', slate: 'text-slate-400',
    indigo: 'text-indigo-400', rose: 'text-rose-400',
};

function _renderAddonUpdateRows() {
    const list = document.getElementById('updates-addons-list');
    if (!list) return;

    const sorted = [..._addonUpdatesCache].sort((a, b) => {
        if (!!a.update_available !== !!b.update_available) return a.update_available ? -1 : 1;
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
    const total = sorted.length;
    const pending = sorted.filter(a => a.update_available).length;

    const countEl = document.getElementById('updates-addons-count');
    if (countEl) countEl.textContent = t('updates.addons_count', { count: total });

    const upgradeBtn = document.getElementById('updates-addons-upgrade-btn');
    if (upgradeBtn) upgradeBtn.classList.toggle('hidden', pending === 0);

    if (!total) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">${escapeHtml(t('updates.no_addons'))}</div>`;
        return;
    }

    list.innerHTML = sorted.map(a => {
        const iconColor = _ADDON_COLOR_MAP[a.color] || _ADDON_COLOR_MAP.slate;
        const iconHtml = a.image
            ? `<img src="${escapeHtml(a.image)}" alt="" class="w-4 h-4 rounded object-contain" loading="lazy">`
            : `<i class="${escapeHtml(a.icon || 'fas fa-puzzle-piece')} ${iconColor}"></i>`;

        let versionHtml, badge, actionHtml;
        if (a.update_available) {
            versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(a.current || '?')}</span><i class="fas fa-arrow-right text-[8px] text-amber-400 mx-1"></i><span class="font-mono text-amber-400 font-semibold">${escapeHtml(a.latest || '?')}</span>`;
            badge = `<span class="upd-badge upd-badge--update"><i class="fas fa-arrow-up"></i>${escapeHtml(t('updates.badge_update'))}</span>`;
            actionHtml = `<button type="button" onclick="updateSingleAddon('${escapeHtml(a.slug)}')" class="upd-row-btn"><i class="fas fa-arrow-up"></i></button>`;
        } else {
            versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(a.current || a.latest || '?')}</span>`;
            badge = `<span class="upd-badge upd-badge--ok"><i class="fas fa-check"></i>${escapeHtml(t('updates.badge_up_to_date'))}</span>`;
            actionHtml = '';
        }

        return `<div class="upd-row${a.update_available ? ' upd-row--outdated' : ''}">
            <div class="upd-row-main">
                <span class="upd-row-icon inline-flex items-center justify-center flex-shrink-0">${iconHtml}</span>
                <span class="upd-row-name">${escapeHtml(a.name)}</span>
            </div>
            <div class="upd-row-version">${versionHtml}</div>
            <div class="upd-row-status">${badge}${actionHtml}</div>
        </div>`;
    }).join('');
}

function _setUpdatesStatus(html, type) {
    const el = document.getElementById('updates-addons-status');
    if (!el) return;
    if (type === 'hidden') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const colors = {
        info: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
        success: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
        warning: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
        error: 'bg-red-500/10 border-red-500/20 text-red-400',
    };
    el.className = `mb-3 text-[11px] rounded-xl p-3 border ${colors[type] || colors.info}`;
    el.innerHTML = html;
}

// --- Updates interval custom dropdown ---

function _intervalLabel(val) {
    const key = { never: 'updates.interval_never', daily: 'updates.interval_daily', weekly: 'updates.interval_weekly', monthly: 'updates.interval_monthly' }[val];
    return key ? t(key) : val;
}

// Bind once at module load — works even before loadConfig has run
if (typeof document !== 'undefined' && !window.__updatesDropdownBound) {
    window.__updatesDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('updates_interval_dropdown');
        if (!dd) return;
        const toggleBtn = e.target.closest('[data-action="toggle-updates-interval"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = e.target.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value;
            const labelKey = opt.dataset.labelKey;
            const label = labelKey ? t(labelKey) : (opt.textContent.trim());
            setUpdatesInterval(value, label);
            return;
        }
        if (!dd.contains(e.target)) dd.dataset.open = 'false';
    });
}

function _bindUpdatesIntervalDropdownOnce() { /* legacy stub — bind happens at module load */ }

export function toggleUpdatesIntervalDropdown() {
    const dd = document.getElementById('updates_interval_dropdown');
    if (!dd) return;
    dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
}

export function setUpdatesInterval(value, label) {
    const dd = document.getElementById('updates_interval_dropdown');
    const hidden = document.getElementById('updates_addons_check_interval');
    const lbl = label || _intervalLabel(value);
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl) valueEl.textContent = lbl;
        dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
            o.dataset.selected = o.dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden) {
        hidden.value = value;
        try { hidden.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }
}

export function syncUpdatesIntervalDropdown() {
    _bindUpdatesIntervalDropdownOnce();
    const hidden = document.getElementById('updates_addons_check_interval');
    const dd = document.getElementById('updates_interval_dropdown');
    if (!hidden || !dd) return;
    const val = hidden.value || 'never';
    dd.querySelector('.dashboard-custom-select__value').textContent = _intervalLabel(val);
    dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
        o.dataset.selected = o.dataset.value === val ? 'true' : 'false';
    });
}

// --- Generic custom dropdown ---------------------------------------------
// Any `.dashboard-custom-select.js-generic-select[data-target]` paired with a
// hidden native <select id="<target>"> is upgraded to the app's custom dropdown.
// Reads options + value from the native select, writes back + dispatches change.

function _rebuildGenericSelect(dd) {
    const target = document.getElementById(dd.dataset.target);
    if (!target) return;
    const menu = dd.querySelector('.dashboard-custom-select__menu') || dd.__portaledMenu;
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (!menu || !valueEl) return;
    const current = target.value;
    const opts = Array.from(target.options || []);
    menu.innerHTML = opts.map(o => {
        const sel = o.value === current;
        return `<button type="button" class="dashboard-custom-select__option" data-value="${escapeHtmlAttr(o.value)}" data-selected="${sel ? 'true' : 'false'}">${escapeHtml((o.textContent || '').trim())}</button>`;
    }).join('');
    const selOpt = opts.find(o => o.value === current) || opts[0];
    valueEl.textContent = selOpt ? (selOpt.textContent || '').trim() : '—';
}

export function initGenericCustomSelects(root) {
    const scope = root || document;
    scope.querySelectorAll('.dashboard-custom-select.js-generic-select[data-target]').forEach(dd => _rebuildGenericSelect(dd));
}

if (typeof window !== 'undefined') window.initGenericCustomSelects = initGenericCustomSelects;

// The open menu must escape any ancestor `overflow` clipping and `transform`
// stacking context (e.g. scroll panes / animated views), otherwise it gets cut
// off or rendered BEHIND sibling panels (like the live-logs view). We "portal"
// the menu to <body> with fixed positioning while it is open.
const GENERIC_MENU_Z = 9999;
function _positionGenericMenu(dd) {
    const menu = dd.__portaledMenu;
    if (!menu) return;
    const btn = dd.querySelector('.dashboard-custom-select__button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    menu.style.right = 'auto';
    menu.style.width = Math.round(r.width) + 'px';
    menu.style.minWidth = Math.round(r.width) + 'px';
    menu.style.zIndex = String(GENERIC_MENU_Z);
    // Flip above the button if it would overflow the viewport bottom.
    const mh = menu.offsetHeight;
    if (r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0) {
        menu.style.top = Math.round(r.top - 6 - mh) + 'px';
    }
}
function _openGenericSelect(dd) {
    // Rebuild while the menu is still inside the wrapper so querySelector works.
    _rebuildGenericSelect(dd);
    dd.dataset.open = 'true';
    const menu = dd.querySelector('.dashboard-custom-select__menu');
    if (menu && menu.parentElement !== document.body) {
        const ph = document.createComment('cselect-menu');
        menu.__placeholder = ph;
        menu.__ownerDd = dd;
        menu.parentElement.insertBefore(ph, menu);
        document.body.appendChild(menu);
        dd.__portaledMenu = menu;
        // Portaled menus aren't matched by the `[data-open] .menu` descendant
        // rule anymore, so apply the open display inline.
        menu.style.display = 'grid';
        menu.style.gap = '3px';
    }
    _positionGenericMenu(dd);
}
function _closeGenericSelect(dd) {
    dd.dataset.open = 'false';
    const menu = dd.__portaledMenu;
    if (menu) {
        menu.style.display = '';
        menu.style.position = '';
        menu.style.left = '';
        menu.style.top = '';
        menu.style.right = '';
        menu.style.width = '';
        menu.style.minWidth = '';
        menu.style.zIndex = '';
        menu.style.gap = '';
        if (menu.__placeholder && menu.__placeholder.parentElement) {
            menu.__placeholder.parentElement.insertBefore(menu, menu.__placeholder);
            menu.__placeholder.remove();
        }
        menu.__placeholder = null;
        dd.__portaledMenu = null;
    }
}
function _closeAllGenericSelects(except) {
    document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(o => { if (o !== except) _closeGenericSelect(o); });
}

if (typeof document !== 'undefined' && !window.__genericSelectBound) {
    window.__genericSelectBound = true;
    // NOTE: capture phase. Many converted selects live inside rows/cards that
    // carry their own inline `onclick` (e.g. open entity card, navigate). In the
    // bubble phase those ancestor handlers fire BEFORE a document-level listener,
    // stealing the click so the dropdown never opens. Handling in capture lets us
    // intercept first and stopPropagation() to block the ancestor handler.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.dashboard-custom-select.js-generic-select .dashboard-custom-select__button');
        if (btn) {
            const dd = btn.closest('.dashboard-custom-select.js-generic-select');
            e.preventDefault();
            e.stopPropagation();
            const willOpen = dd.dataset.open !== 'true';
            _closeAllGenericSelects(dd);
            if (willOpen) _openGenericSelect(dd); else _closeGenericSelect(dd);
            return;
        }
        const opt = e.target.closest('.dashboard-custom-select.js-generic-select .dashboard-custom-select__option, .dashboard-custom-select__menu .dashboard-custom-select__option');
        if (opt) {
            const menuEl = opt.closest('.dashboard-custom-select__menu');
            const dd = (menuEl && menuEl.__ownerDd) || opt.closest('.dashboard-custom-select.js-generic-select');
            if (!dd) return;
            e.preventDefault();
            e.stopPropagation();
            const target = document.getElementById(dd.dataset.target);
            const value = opt.dataset.value;
            if (target && target.value !== value) {
                target.value = value;
                try { target.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
            }
            const menuRoot = dd.__portaledMenu || dd;
            menuRoot.querySelectorAll('.dashboard-custom-select__option').forEach(o => { o.dataset.selected = o.dataset.value === value ? 'true' : 'false'; });
            const valueEl = dd.querySelector('.dashboard-custom-select__value');
            if (valueEl) valueEl.textContent = (opt.textContent || '').trim();
            _closeGenericSelect(dd);
            return;
        }
        document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(o => {
            const m = o.__portaledMenu;
            if (!o.contains(e.target) && !(m && m.contains(e.target))) _closeGenericSelect(o);
        });
    }, true);

    // Keep the portaled menu glued to its button while the page scrolls/resizes.
    const _repositionOpenGenericMenus = () => {
        document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(_positionGenericMenu);
    };
    window.addEventListener('resize', _repositionOpenGenericMenus);
    document.addEventListener('scroll', _repositionOpenGenericMenus, true);
}

// --- Global auto-upgrade of native <select> ------------------------------
// Any native <select> rendered anywhere is automatically converted into the
// app's custom dropdown, so new UI gets consistent styling for free. To keep a
// raw OS <select>, add `data-no-custom-select` (or class `native-select`).
let _genericSelectSeq = 0;
function _isUpgradableSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT') return false;
    if (sel.multiple || sel.size > 1) return false;
    if (sel.classList.contains('dashboard-custom-select-native')) return false; // already paired
    if (sel.classList.contains('native-select')) return false;
    if (sel.hasAttribute('data-no-custom-select')) return false;
    return true;
}
function upgradeNativeSelect(sel) {
    if (!_isUpgradableSelect(sel)) return;
    if (!sel.id) sel.id = `cselect-${++_genericSelectSeq}`;
    // Already upgraded? (overlay immediately after, pointing at this select)
    const nextEl = sel.nextElementSibling;
    if (nextEl && nextEl.classList.contains('js-generic-select') && nextEl.getAttribute('data-target') === sel.id) {
        _rebuildGenericSelect(nextEl);
        return;
    }
    sel.classList.add('dashboard-custom-select-native');
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-custom-select js-generic-select';
    wrap.setAttribute('data-target', sel.id);
    wrap.setAttribute('data-open', 'false');
    wrap.innerHTML = '<button type="button" class="dashboard-custom-select__button"><span class="dashboard-custom-select__value">—</span><i class="fas fa-chevron-down"></i></button><div class="dashboard-custom-select__menu"></div>';
    sel.insertAdjacentElement('afterend', wrap);
    _rebuildGenericSelect(wrap);
    // Keep the overlay in sync when options are populated/changed later.
    if (!sel._optObserver && typeof MutationObserver !== 'undefined') {
        sel._optObserver = new MutationObserver(() => {
            const ov = sel.nextElementSibling;
            if (ov && ov.classList.contains('js-generic-select')) _rebuildGenericSelect(ov);
        });
        sel._optObserver.observe(sel, { childList: true });
    }
}
export function upgradeNativeSelects(root) {
    const scope = root || document;
    if (scope.tagName === 'SELECT') { upgradeNativeSelect(scope); return; }
    scope.querySelectorAll && scope.querySelectorAll('select').forEach(upgradeNativeSelect);
}
if (typeof window !== 'undefined') window.upgradeNativeSelects = upgradeNativeSelects;

if (typeof document !== 'undefined' && !window.__nativeSelectAutoUpgrade) {
    window.__nativeSelectAutoUpgrade = true;
    const runAll = () => upgradeNativeSelects(document);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runAll, { once: true });
    } else {
        runAll();
    }
    // Keep paired dropdown labels in sync when a native select changes value
    // (programmatically or via our own option clicks).
    document.addEventListener('change', (e) => {
        const sel = e.target;
        if (sel && sel.tagName === 'SELECT' && sel.classList.contains('dashboard-custom-select-native')) {
            const overlay = sel.nextElementSibling;
            if (overlay && overlay.classList.contains('js-generic-select')) _rebuildGenericSelect(overlay);
        }
    }, true);
    // Upgrade selects added to the DOM later (batched via rAF).
    let _pending = false;
    const observer = new MutationObserver((mutations) => {
        let found = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'SELECT' || (node.querySelector && node.querySelector('select'))) { found = true; break; }
            }
            if (found) break;
        }
        if (found && !_pending) {
            _pending = true;
            requestAnimationFrame(() => { _pending = false; upgradeNativeSelects(document); });
        }
    });
    const startObserver = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
}
