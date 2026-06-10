import { apiCall, suppressLogout } from './api.js';
import { setLanguage, getLanguage, t, getAvailableLanguages, loadComponentTranslations } from './lang/index.js';
import { escapeHtml, showToast, showConfirm, openSubPage, closeSubPage } from './utils.js';
import { showHubStartupLoadingAfterRestart } from './startup_status.js';
import { updateThinkingModeUi } from './thinking_mode.js';
import { getExtractionExamples, renderExtractionExamples } from './features_memory.js';
import { initGenericCustomSelects } from './features_custom_selects.js';
import { syncIntegrationToggles, bindIntegrationToggleButtonsOnce, loadIntegrationCatalog, getIntegrationCatalog, } from './features_integrations_settings.js';
import { getTts } from './chat.js';
import { setIsAdmin, isExplicitNonAdmin } from './user_context.js';
import { saveNotificationSettings } from './features_notifications_config.js';
import { syncUpdatesIntervalDropdown } from './features_addons_settings.js';
/** Most config DOM ids are form controls; keeps load/save terse. */
function cfgField(id) {
    return document.getElementById(id);
}
function cfgNode(id) {
    return document.getElementById(id);
}
function _cfgVal(id) {
    return cfgField(id)?.value ?? '';
}
function _errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function _integrationSlugCandidates(slug) {
    const raw = String(slug || '').trim();
    if (!raw)
        return [];
    const dash = raw.replace(/_/g, '-');
    const under = raw.replace(/-/g, '_');
    return Array.from(new Set([raw, dash, under]));
}
function _findIntegrationCheckbox(slug) {
    for (const candidate of _integrationSlugCandidates(slug)) {
        const ids = [`${candidate}_enabled`, `integrations-${candidate}-enabled`, `${candidate}Enabled`];
        for (const id of ids) {
            const el = cfgField(id);
            if (el && el.type === 'checkbox')
                return el;
        }
    }
    return null;
}
function formatHealthError(detail) {
    const raw = String(detail || '').trim();
    const low = raw.toLowerCase();
    if (!raw)
        return t('hy.addon_health_no_response');
    if (low === 'not_running')
        return t('hy.addon_health_not_running');
    if (low === 'no_port_configured')
        return t('hy.addon_health_no_port');
    if (low.includes('connection refused') || low.includes('errno 61'))
        return t('hy.addon_health_connection_refused');
    if (low.includes('timed out') || low.includes('timeout'))
        return t('hy.addon_health_timeout');
    return raw;
}
async function _savePiperAddonConfig() {
    const body = {};
    const host = cfgField('piper_host')?.value?.trim();
    const portRaw = cfgField('piper_port')?.value?.trim();
    if (host)
        body.host = host;
    if (portRaw)
        body.port = parseInt(portRaw, 10) || undefined;
    if (!Object.keys(body).length)
        return;
    await apiCall('/api/addons/piper/config', { method: 'PATCH', body });
}
const _SEARCH_TENDENCY_HINTS = {
    1: 'Minimal — almost never searches. Only when you explicitly ask it to.',
    2: 'Conservative — prefers own knowledge, searches only for today\'s news/weather.',
    3: 'Balanced — searches for current events, uses knowledge for known facts.',
    4: 'Proactive — searches when not fully confident, verifies uncertain facts.',
    5: 'Aggressive — actively searches to provide the freshest information.',
};
function _updateSearchTendencyHint(val) {
    const hint = cfgField('search_tendency_hint');
    if (hint)
        hint.textContent = _SEARCH_TENDENCY_HINTS[val] || _SEARCH_TENDENCY_HINTS[3];
}
let _uiLanguageSaveSeq = 0;
function _refreshUiLanguageSelect(language) {
    const uiLangSelect = cfgField('ui_language');
    const dd = cfgField('ui_language_dropdown');
    if (!uiLangSelect)
        return;
    const value = language || uiLangSelect.value || getLanguage();
    const opts = getAvailableLanguages();
    uiLangSelect.value = value;
    if (!dd)
        return;
    const menu = dd.querySelector('.dashboard-custom-select__menu');
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    const selectedLabel = (opts.find(o => o.code === value)?.label) || (opts[0]?.label) || '—';
    if (valueEl)
        valueEl.textContent = selectedLabel;
    if (menu) {
        menu.innerHTML = opts.map(o => {
            const isSelected = o.code === value;
            return `<button type="button" class="dashboard-custom-select__option" data-value="${o.code}" data-selected="${isSelected ? 'true' : 'false'}">${o.label}</button>`;
        }).join('');
    }
}
let _uiLanguageDropdownBound = false;
if (typeof document !== 'undefined' && !_uiLanguageDropdownBound) {
    _uiLanguageDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = cfgField('ui_language_dropdown');
        if (!dd)
            return;
        const tgt = e.target;
        if (!tgt)
            return;
        const toggleBtn = tgt.closest('[data-action="toggle-ui-language"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = tgt.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value;
            dd.dataset.open = 'false';
            const hidden = cfgField('ui_language');
            if (hidden && value && hidden.value !== value) {
                hidden.value = value;
                _applyAndSaveUiLanguage(value);
            }
            return;
        }
        if (!dd.contains(tgt))
            dd.dataset.open = 'false';
    });
}
async function _applyAndSaveUiLanguage(language) {
    if (!language)
        return;
    const previousLanguage = getLanguage();
    const saveSeq = ++_uiLanguageSaveSeq;
    const dd = cfgField('ui_language_dropdown');
    try {
        setLanguage(language);
        await loadComponentTranslations(language);
        _refreshUiLanguageSelect(language);
        try {
            initGenericCustomSelects();
        }
        catch (_) { }
        if (dd)
            dd.dataset.disabled = 'true';
        await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
    }
    catch (err) {
        if (saveSeq === _uiLanguageSaveSeq) {
            try {
                setLanguage(previousLanguage);
                _refreshUiLanguageSelect(previousLanguage);
            }
            catch (_) { }
            showToast(t('config.save_error'), 'error');
        }
    }
    finally {
        if (dd && saveSeq === _uiLanguageSaveSeq)
            dd.dataset.disabled = 'false';
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
        try {
            window.__setNativeWsServiceEnabled(!!wsServiceShouldRunFromCfg);
        }
        catch (_) { }
    }
    const updateLoggingModeBadge = (isVerbose) => {
        const badge = cfgField('header-log-mode-badge');
        if (!badge)
            return;
        const verbose = !!isVerbose;
        badge.textContent = verbose ? 'LOG: VERBOSE' : 'LOG: COMPACT';
        badge.classList.remove('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10', 'border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
        if (verbose) {
            badge.classList.add('border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
        }
        else {
            badge.classList.add('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10');
        }
    };
    updateLoggingModeBadge(!!cfg.verbose_logging);
    // Limbă UI
    const uiLangSelect = cfgField('ui_language');
    if (uiLangSelect) {
        _refreshUiLanguageSelect((cfg.ui && cfg.ui.language) || getLanguage());
    }
    if (cfg.security) {
        const wlNum = cfgField('wl_numbers');
        if (wlNum)
            wlNum.value = (cfg.security.allowed_numbers || []).join('\n');
        const secAntiInj = cfgField('security_anti_injection');
        if (secAntiInj)
            secAntiInj.checked = cfg.security.anti_injection !== false;
        const secAntiInjPrompt = cfgField('security_anti_injection_prompt');
        if (secAntiInjPrompt)
            secAntiInjPrompt.value = cfg.security.anti_injection_prompt_template || '';
        const secGuardrails = cfgField('security_tool_guardrails');
        if (secGuardrails)
            secGuardrails.checked = cfg.security.tool_guardrails !== false;
        const secRestrictUntrustedTools = cfgField('security_restrict_untrusted_tools');
        if (secRestrictUntrustedTools)
            secRestrictUntrustedTools.checked = cfg.security.restrict_mutating_tools_on_untrusted_content !== false;
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
        'fusion_solar_enabled': cfg.fusion_solar?.enabled, 'fusion_solar_mode': cfg.fusion_solar?.mode ?? 'auto', 'fusion_solar_host': cfg.fusion_solar?.host, 'fusion_solar_kiosk_url': cfg.fusion_solar?.kiosk_url ?? '', 'fusion_solar_username': cfg.fusion_solar?.username, 'fusion_solar_password': cfg.fusion_solar?.password, 'fusion_solar_scan_interval': cfg.fusion_solar?.scan_interval ?? 90,
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
        const el = cfgField(id);
        if (!el)
            continue;
        if (el.type === 'checkbox')
            el.checked = !!val;
        else
            el.value = (val ?? '') + '';
    }
    if (typeof syncUpdatesIntervalDropdown === 'function')
        syncUpdatesIntervalDropdown();
    // Normalize old "custom" to "local" (Custom option removed)
    ['llm_provider', 'coder_provider', 'aux_llm_provider', 'vision_llm_provider'].forEach(id => {
        const el = cfgField(id);
        if (el && el.value === 'custom')
            el.value = 'local';
    });
    // Infer provider from URL when source not set
    function inferSource(url) {
        if (!url || !url.trim())
            return 'local';
        const u = url.toLowerCase();
        if (u.includes('api.z.ai') && u.includes('coding'))
            return 'z_ai';
        if (u.includes('api.z.ai'))
            return 'z_ai';
        if (u.includes('api.x.ai'))
            return 'grok';
        if (u.includes('api.deepseek.com'))
            return 'deepseek';
        if (u.includes('openai.com'))
            return 'openai';
        return 'local';
    }
    const llmProv = cfgField('llm_provider');
    if (llmProv && !cfg.llm?.source && !cfg.llm?.provider)
        llmProv.value = inferSource(cfg.llm?.target_url);
    const coderProv = cfgField('coder_provider');
    if (coderProv && !cfg.coder?.source && !cfg.coder?.provider)
        coderProv.value = inferSource(cfg.coder?.target_url);
    const auxProv = cfgField('aux_llm_provider');
    if (auxProv && !(cfg.intelligence?.aux_llm?.source || cfg.intelligence?.aux_llm?.provider))
        auxProv.value = inferSource(cfg.intelligence?.aux_llm?.target_url);
    const visionProv = cfgField('vision_llm_provider');
    if (visionProv && !(cfg.vision_llm?.source || cfg.vision_llm?.provider))
        visionProv.value = inferSource(cfg.vision_llm?.target_url);
    // Prefill when dropdown changes
    function applyProvider(providerId, urlId, modelId, keyRowId, isCoder) {
        const sel = cfgField(providerId);
        if (!sel)
            return;
        const urlEl = cfgField(urlId);
        const modelEl = cfgField(modelId);
        const keyRow = keyRowId ? cfgField(keyRowId) : null;
        // Billing link (only for main LLM provider)
        const billingLink = (providerId === 'llm_provider') ? cfgField('zai_billing_link') : null;
        function syncBillingLink(v) {
            if (billingLink)
                billingLink.classList.toggle('hidden', v !== 'z_ai');
        }
        sel.onchange = () => {
            const v = sel.value;
            syncBillingLink(v);
            if (v === 'local') {
                if (urlEl)
                    urlEl.value = isCoder ? '' : 'http://localhost:11434/v1';
                if (modelEl)
                    modelEl.value = '';
                if (keyRow)
                    keyRow.style.display = 'none';
            }
            else {
                if (keyRow)
                    keyRow.style.display = '';
                if (v === 'z_ai') {
                    if (urlEl)
                        urlEl.value = isCoder ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4';
                    if (modelEl)
                        modelEl.value = 'glm-5';
                }
                else if (v === 'grok') {
                    if (urlEl)
                        urlEl.value = 'https://api.x.ai/v1/chat/completions';
                    if (modelEl && !modelEl.value.trim())
                        modelEl.value = 'grok-4-1-fast-reasoning';
                }
                else if (v === 'deepseek') {
                    if (urlEl)
                        urlEl.value = 'https://api.deepseek.com/chat/completions';
                    if (modelEl && !modelEl.value.trim())
                        modelEl.value = 'deepseek-chat';
                }
                else if (v === 'openai') {
                    if (urlEl)
                        urlEl.value = 'https://api.openai.com/v1';
                    if (modelEl && !modelEl.value.trim())
                        modelEl.value = 'gpt-4o';
                }
            }
        };
        // Initial visibility for API key row
        if (keyRow)
            keyRow.style.display = (sel.value === 'local') ? 'none' : '';
        syncBillingLink(sel.value);
    }
    applyProvider('llm_provider', 'target_url', 'model_name', 'llm_api_key_row', false);
    applyProvider('coder_provider', 'coder_target_url', 'coder_model_name', 'coder_api_key_row', true);
    applyProvider('aux_llm_provider', 'aux_llm_url', 'aux_llm_model', 'aux_llm_api_key_row', false);
    applyProvider('vision_llm_provider', 'vision_llm_target_url', 'vision_llm_model_name', 'vision_llm_api_key_row', false);
    const m = cfg.memory || {};
    const parseListToText = (arr) => Array.isArray(arr) ? arr.join('\n') : '';
    const intelMw = cfgField('intel_working_window');
    const intelMs = cfgField('intel_summarize_every');
    if (intelMw)
        intelMw.value = m.working_window ?? 12;
    if (intelMs)
        intelMs.value = m.summarize_every ?? 8;
    const mFactSim = cfgField('memory_fact_similarity');
    if (mFactSim)
        mFactSim.value = m.fact_similarity_threshold ?? 0.45;
    const mExtractionTimeout = cfgField('memory_extraction_timeout');
    const mExtractionInputMaxChars = cfgField('memory_extraction_input_max_chars');
    const mExtractionMaxTokensFull = cfgField('memory_extraction_max_tokens_full');
    const mExtractionMaxLines = cfgField('memory_extraction_max_lines');
    if (mExtractionTimeout)
        mExtractionTimeout.value = m.extraction_timeout ?? (cfg.llm?.timeout ?? 120);
    if (mExtractionInputMaxChars)
        mExtractionInputMaxChars.value = m.extraction_input_max_chars ?? 900;
    if (mExtractionMaxTokensFull)
        mExtractionMaxTokensFull.value = m.extraction_max_tokens_full ?? 800;
    if (mExtractionMaxLines)
        mExtractionMaxLines.value = m.extraction_max_lines ?? 2;
    // Logging mode (live toggle)
    const loggingModeEl = cfgField('logging_mode');
    if (loggingModeEl && !loggingModeEl.dataset.bound) {
        loggingModeEl.dataset.bound = '1';
        loggingModeEl.addEventListener('change', async () => {
            updateLoggingModeBadge(loggingModeEl.value === 'verbose');
            try {
                await saveConfig({});
            }
            catch (e) { /* handled in saveConfig via toast/error path */ }
        });
    }
    const mExtractionRules = cfgField('memory_extraction_rules');
    if (mExtractionRules)
        mExtractionRules.value = m.extraction_rules || '';
    // Memory: extraction examples (few-shot)
    renderExtractionExamples(m.extraction_examples || []);
    // Intelligence: consolidation
    const consolidation = (cfg.intelligence || {}).consolidation || {};
    const cEn = cfgField('consolidation_enabled');
    const cTime = cfgField('consolidation_time');
    const cInterval = cfgField('consolidation_interval');
    const cThr = cfgField('consolidation_threshold');
    if (cEn)
        cEn.checked = !!consolidation.enabled;
    if (cTime)
        cTime.value = consolidation.time || '03:00';
    if (cInterval)
        cInterval.value = consolidation.interval || 'daily';
    if (cThr)
        cThr.value = consolidation.similarity_threshold ?? 0.92;
    const cSessionTrig = cfgField('consolidation_session_trigger_messages');
    const cCompression = cfgField('consolidation_compression_ratio');
    const cHistoryPath = cfgField('consolidation_history_log_path');
    if (cSessionTrig)
        cSessionTrig.value = consolidation.session_trigger_messages ?? 80;
    if (cCompression)
        cCompression.value = consolidation.compression_ratio ?? 0.15;
    if (cHistoryPath)
        cHistoryPath.value = consolidation.history_log_path || 'history_log.md';
    // Daily news
    // Daily news config removed — now handled by skills/daily_news.py
    // Intelligence: Agent config
    const intel = cfg.intelligence || {};
    const maxAgentTurnsEl = cfgField('max_agent_turns');
    if (maxAgentTurnsEl)
        maxAgentTurnsEl.value = intel.max_agent_turns ?? 10;
    const postRespConcEl = cfgField('post_response_concurrency');
    if (postRespConcEl)
        postRespConcEl.value = intel.post_response_concurrency ?? 1;
    const injectFactsEl = cfgField('inject_relevant_facts');
    const richerResultsEl = cfgField('richer_tool_results');
    if (injectFactsEl)
        injectFactsEl.checked = intel.inject_relevant_facts !== false;
    if (richerResultsEl)
        richerResultsEl.checked = !!intel.richer_tool_results;
    const lazyHistEl = cfgField('intel_lazy_history');
    if (lazyHistEl)
        lazyHistEl.checked = intel.lazy_history !== false; // default true
    // Intent Router
    const _setChk = (id, val) => { const el = cfgField(id); if (el)
        el.checked = !!val; };
    const routerCfg = intel.intent_router || {};
    _setChk('intent_router_enabled', routerCfg.enabled);
    // Proactive Hints
    const hintsCfg = intel.proactive_hints || {};
    _setChk('proactive_hints_enabled', hintsCfg.enabled);
    // Intelligence: Knowledge cutoff
    const iFreshCut = cfgField('intel_knowledge_cutoff');
    if (iFreshCut)
        iFreshCut.value = intel.knowledge_cutoff ?? '2024-01';
    // Intelligence: Search tendency slider
    const searchTendencyEl = cfgField('intel_search_tendency');
    if (searchTendencyEl) {
        searchTendencyEl.value = intel.search_tendency ?? 3;
        _updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        searchTendencyEl.addEventListener('input', () => {
            _updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        });
    }
    // Intelligence: Search context (use previous message in web search query)
    const searchUseCtx = cfgField('search_use_conversation_context');
    const searchCtxThreshold = cfgField('search_context_similarity_threshold');
    if (searchUseCtx)
        searchUseCtx.checked = !!intel.search_use_conversation_context;
    if (searchCtxThreshold)
        searchCtxThreshold.value = intel.search_context_similarity_threshold ?? 0.55;
    // Intelligence: Shell & Tool calling
    const shell = intel.shell || {};
    const shellEn = cfgField('shell_enabled');
    const shellAllowed = cfgField('shell_allowed_commands');
    const shellBlocked = cfgField('shell_blocked_patterns');
    const shellMaxOut = cfgField('shell_max_output_chars');
    const shellTimeout = cfgField('shell_timeout_seconds');
    const shellRate = cfgField('shell_rate_limit');
    if (shellEn)
        shellEn.checked = shell.enabled !== false;
    if (shellAllowed)
        shellAllowed.value = Array.isArray(shell.allowed_commands) ? shell.allowed_commands.join('\n') : '';
    if (shellBlocked)
        shellBlocked.value = Array.isArray(shell.blocked_patterns) ? shell.blocked_patterns.join('\n') : '';
    if (shellMaxOut)
        shellMaxOut.value = shell.max_output_chars ?? 8000;
    if (shellTimeout)
        shellTimeout.value = shell.timeout_seconds ?? 15;
    if (shellRate)
        shellRate.value = shell.rate_limit_per_minute ?? 5;
    const fileRead = intel.file_read || {};
    const frEn = cfgField('file_read_enabled');
    const frMaxBytes = cfgField('file_read_max_bytes');
    const frRate = cfgField('file_read_rate_limit');
    if (frEn)
        frEn.checked = fileRead.enabled !== false;
    if (frMaxBytes)
        frMaxBytes.value = fileRead.max_bytes ?? 51200;
    if (frRate)
        frRate.value = fileRead.rate_limit_per_minute ?? 10;
    const runScript = intel.run_script || {};
    const rsEn = cfgField('run_script_enabled');
    const rsTimeout = cfgField('run_script_timeout');
    const rsMaxOut = cfgField('run_script_max_output');
    const rsRate = cfgField('run_script_rate_limit');
    if (rsEn)
        rsEn.checked = runScript.enabled !== false;
    if (rsTimeout)
        rsTimeout.value = runScript.timeout_seconds ?? 15;
    if (rsMaxOut)
        rsMaxOut.value = runScript.max_output_chars ?? 20000;
    if (rsRate)
        rsRate.value = runScript.rate_limit_per_minute ?? 3;
    const proposePatch = intel.propose_patch || {};
    const ppEn = cfgField('propose_patch_enabled');
    const ppDirs = cfgField('propose_patch_allowed_dirs');
    if (ppEn)
        ppEn.checked = proposePatch.enabled !== false;
    if (ppDirs)
        ppDirs.value = Array.isArray(proposePatch.allowed_dirs) ? proposePatch.allowed_dirs.join(', ') : 'scripts, docs, ai_suggestions';
    // Librarian (memory recall) – loaded from cfg.librarian
    const lib = cfg.librarian || {};
    const iRetLimit = cfgField('intel_retrieval_limit');
    const iMemDist = cfgField('intel_memory_relevance_max_distance');
    if (iRetLimit)
        iRetLimit.value = lib.retrieval_limit ?? 5;
    if (iMemDist)
        iMemDist.value = lib.memory_relevance_max_distance != null ? lib.memory_relevance_max_distance : '';
    const tts = getTts();
    if (tts) {
        try {
            const stored = localStorage.getItem('hyve_tts_always_speak');
            if (stored !== null)
                tts.alwaysSpeak = stored === '1';
        }
        catch (_) { }
    }
    // Integrări + restricții non-admin: whitelist per user, ascundere Models/HA/WhatsApp config/Prompts
    try {
        const meRes = await apiCall('/api/users/me');
        if (!meRes.ok)
            return;
        const profile = await meRes.json();
        setIsAdmin(profile.is_admin);
        const isAdmin = profile.is_admin;
        document.querySelectorAll('.config-admin-only').forEach(el => {
            if (el.id && el.id.startsWith('cfg-tab-'))
                return;
            el.classList.toggle('hidden', !isAdmin);
        });
        const personaUser = cfgField('cfg-general-persona-user');
        const userPersona = cfgField('user_persona');
        if (personaUser && userPersona) {
            personaUser.classList.toggle('hidden', isAdmin);
            userPersona.value = profile.persona || '';
        }
        const adminBlock = cfgField('integrations-whitelist-admin');
        const userBlock = cfgField('integrations-whitelist-user');
        const addInput = cfgField('user-phone-add');
        const addBtn = cfgField('user-phone-add-btn');
        if (adminBlock && userBlock) {
            if (isAdmin) {
                adminBlock.classList.remove('hidden');
                userBlock.classList.add('hidden');
            }
            else {
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
    }
    catch (e) {
        /* not logged in or error – still sync toggles from config values */
        syncIntegrationToggles();
        bindIntegrationToggleButtonsOnce();
    }
    // Mount integration toggles early so later saves cannot default them to disabled.
    try {
        await loadIntegrationCatalog(false);
        for (const entry of getIntegrationCatalog()) {
            const slug = String(entry.slug || '').trim();
            if (!slug)
                continue;
            const cb = _findIntegrationCheckbox(slug);
            if (!cb)
                continue;
            if (Object.prototype.hasOwnProperty.call(entry, 'enabled')) {
                cb.checked = !!entry.enabled;
            }
        }
        syncIntegrationToggles();
    }
    catch (_) { }
    _configAutoSavePauseUntil = Date.now() + 350;
}
function renderUserPhonesList(phones) {
    const listEl = cfgField('user-phones-list');
    if (!listEl)
        return;
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
            <button type="button" data-config-action="unlinkUserPhone" data-config-phone="${escNum}" class="text-[10px] text-red-400 hover:bg-red-500/20 px-2 py-0.5 rounded">${t('common.delete')}</button>
        </div>`;
    }).join('');
}
export async function addUserPhone(phone, inputEl) {
    if (!phone)
        return;
    try {
        const res = await apiCall('/api/users/link-whatsapp', { method: 'POST', body: { phone_number: phone } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || t('common.error'), 'error');
            return;
        }
        if (inputEl)
            inputEl.value = '';
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    }
    catch (e) {
        showToast(t('common.error'), 'error');
    }
}
export async function unlinkUserPhone(number) {
    if (!number || !(await showConfirm(t('config.unlink_phone_confirm'))))
        return;
    try {
        const res = await apiCall('/api/users/me/phones/unlink', { method: 'POST', body: { number } });
        if (!res.ok)
            throw new Error();
        const meRes = await apiCall('/api/users/me');
        if (meRes.ok) {
            const profile = await meRes.json();
            renderUserPhonesList(profile.phones || []);
        }
    }
    catch (e) {
        showToast(t('common.error'), 'error');
    }
}
// ─── MODEL PROFILES ─────────────────────────────────────────────────
let _modelProfiles = [];
let _activeProfileId = '';
let _defaultProfileId = ''; // per-user default (selector); active_id is global for admin
export async function loadModelProfiles() {
    try {
        const res = await apiCall('/api/model-profiles');
        if (!res.ok)
            return;
        const data = await res.json();
        _modelProfiles = data.profiles || [];
        _activeProfileId = data.active_id || '';
        _defaultProfileId = data.default_profile_id || '';
        renderProfilesList();
        renderModelSelector(data);
        renderAutoRouterStats(data.auto_router_stats);
    }
    catch (e) {
        console.warn('loadModelProfiles error', e);
    }
}
function renderAutoRouterStats(stats) {
    const el = cfgField('auto-router-stats');
    if (!el)
        return;
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
    if (!container)
        return;
    if (!_modelProfiles.length) {
        container.innerHTML = `<p class="text-[10px] text-slate-600 col-span-2 text-center py-4">${escapeHtml(t('config.profiles_empty'))}</p>`;
        return;
    }
    container.innerHTML = _modelProfiles.map((p, index) => {
        const visible = p.visible_in_selector !== false;
        const providerLabels = { local: 'Local', z_ai: 'Z.AI', openai: 'OpenAI', grok: 'Grok', deepseek: 'DeepSeek' };
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
export async function moveProfileOrder(profileId, direction) {
    const ids = _modelProfiles.map(p => p.id);
    const idx = ids.indexOf(profileId);
    if (idx === -1)
        return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ids.length)
        return;
    const reordered = [...ids];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    try {
        const res = await apiCall('/api/model-profiles/reorder', { method: 'POST', body: { order: reordered } });
        if (!res.ok)
            throw new Error();
        showToast(t('config.profile_order_saved'), 'success');
        await loadModelProfiles();
    }
    catch (err) {
        showToast(t('config.profile_order_error'), 'error');
    }
}
;
function bindProfileCardDragDrop(container) {
    if (!container || container.dataset.dragBound === '1')
        return;
    container.dataset.dragBound = '1';
    let draggedId = null;
    container.addEventListener('dragstart', (e) => {
        const tgt = e.target;
        if (!tgt)
            return;
        const handle = tgt.closest('.profile-card-drag-handle');
        if (!handle)
            return;
        const id = handle.getAttribute('data-profile-id');
        if (!id)
            return;
        draggedId = id;
        e.dataTransfer?.setData('text/plain', id);
        if (e.dataTransfer)
            e.dataTransfer.effectAllowed = 'move';
        const card = handle.closest('.profile-card');
        if (card)
            card.classList.add('dragging');
    });
    container.addEventListener('dragend', (e) => {
        const tgt = e.target;
        if (tgt?.closest('.profile-card-drag-handle')) {
            container.querySelectorAll('.profile-card').forEach(el => el.classList.remove('dragging', 'drag-over'));
        }
        draggedId = null;
    });
    container.addEventListener('dragover', (e) => {
        const tgt = e.target;
        if (!tgt)
            return;
        const card = tgt.closest('.profile-card');
        if (!card || !draggedId)
            return;
        e.preventDefault();
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
    });
    container.addEventListener('dragleave', (e) => {
        const tgt = e.target;
        if (!tgt)
            return;
        const card = tgt.closest('.profile-card');
        if (card && !card.contains(e.relatedTarget))
            card.classList.remove('drag-over');
    });
    container.addEventListener('drop', async (e) => {
        const tgt = e.target;
        if (!tgt)
            return;
        const card = tgt.closest('.profile-card');
        if (!card || !draggedId)
            return;
        e.preventDefault();
        card.classList.remove('drag-over');
        const targetId = card.getAttribute('data-profile-id');
        if (!targetId || targetId === draggedId)
            return;
        const ids = _modelProfiles.map(p => p.id);
        const fromIdx = ids.indexOf(draggedId);
        const toIdx = ids.indexOf(targetId);
        if (fromIdx === -1 || toIdx === -1)
            return;
        const reordered = [..._modelProfiles];
        const [removed] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, removed);
        const order = reordered.map(p => p.id);
        try {
            const res = await apiCall('/api/model-profiles/reorder', { method: 'POST', body: { order } });
            if (!res.ok)
                throw new Error();
            showToast(t('config.profile_order_saved'), 'success');
            await loadModelProfiles();
        }
        catch (err) {
            showToast(t('config.profile_order_error'), 'error');
        }
    });
}
function renderModelSelector(_data) {
    const listEl = cfgField('model-selector-profiles');
    const wrapEl = document.querySelector('.model-selector-wrap');
    if (!listEl)
        return;
    const visibleProfiles = _modelProfiles.filter(p => p.visible_in_selector !== false);
    const isAuto = (_defaultProfileId || '').toLowerCase() === 'auto';
    const activeProfile = isAuto ? null : (visibleProfiles.find(p => p.id === _defaultProfileId) || visibleProfiles[0]);
    const accentColor = (activeProfile?.color || '#38bdf8').trim();
    if (wrapEl)
        wrapEl.style.setProperty('--selector-accent', accentColor);
    /* The button is now a cog icon — no label text to set.
       The --selector-accent CSS variable handles the color. */
    const autoLabel = t('config.model_selector_auto');
    const autoButton = `
        <button type="button" class="model-selector-item${isAuto ? ' active' : ''}" data-chat-action="activateProfile" data-chat-profile-id="auto">
            <div class="model-selector-item-dot" style="background:#38bdf8"></div>
            <div class="model-selector-item-info">
                <div class="model-selector-item-name">${escapeHtml(autoLabel)}</div>
                <div class="model-selector-item-model">${escapeHtml('')}</div>
            </div>
            <i class="fas fa-check model-selector-item-check"></i>
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
            <button type="button" class="model-selector-item${isActive ? ' active' : ''}" data-chat-action="activateProfile" data-chat-profile-id="${escapeHtml(p.id)}">
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
    if (imageItem)
        imageItem.style.display = hasVision ? '' : 'none';
    if (cameraItem)
        cameraItem.style.display = hasVision ? '' : 'none';
    const btnAttach = cfgField('btn-attach');
    if (!btnAttach)
        return;
    const iconEl = btnAttach.querySelector('i.fas');
    if (!iconEl)
        return;
    if (!hasVision) {
        btnAttach.setAttribute('data-single-attach', 'document');
        iconEl.className = 'fas fa-file-alt';
        const docLabel = t('chat.attach_document');
        btnAttach.setAttribute('aria-label', docLabel);
        btnAttach.title = docLabel;
        btnAttach.setAttribute('aria-haspopup', 'false');
    }
    else {
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
    if (!capVision)
        return;
    const visionConfigured = visionEnabledEl?.checked && ((visionUrlEl?.value || '').trim() || (visionModelEl?.value || '').trim());
    if (visionConfigured) {
        capVision.checked = true;
        capVision.disabled = true;
    }
    else {
        capVision.disabled = false;
    }
}
;
export function showProfileEditor(profileId) {
    const overlay = cfgField('profile-editor-overlay');
    if (!overlay)
        return;
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
    if (!titleEl || !idEl || !nameEl || !provEl || !urlEl || !modelEl || !keyEl || !tempEl || !timeoutEl || !ctxEl || !colorEl)
        return;
    if (!auxEnabledEl || !auxUrlEl || !auxModelEl || !auxKeyEl || !auxFields || !keyRow)
        return;
    const colorInput = colorEl;
    function _syncColor(hex) {
        if (!_colorSwatches)
            return;
        const norm = (hex || '').toLowerCase();
        colorInput.value = norm;
        _colorSwatches.querySelectorAll('.color-swatch').forEach(s => {
            s.classList.toggle('active', s.dataset.color === norm);
        });
        if (_colorPreview)
            _colorPreview.style.background = norm;
        if (_colorHex && document.activeElement !== _colorHex)
            _colorHex.value = norm;
    }
    if (_colorSwatches) {
        _colorSwatches.addEventListener('click', (e) => {
            const tgt = e.target;
            const sw = tgt?.closest('.color-swatch');
            if (sw) {
                _syncColor(sw.dataset.color || '');
            }
        });
    }
    if (_colorHex) {
        _colorHex.addEventListener('input', () => {
            let v = _colorHex.value.trim();
            if (v && !v.startsWith('#'))
                v = '#' + v;
            if (/^#[0-9a-f]{6}$/i.test(v))
                _syncColor(v);
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
        if (!p)
            return;
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
        if (personaOverrideEl)
            personaOverrideEl.value = p.persona_override || '';
        const capReason = cfgField('profile-capability-reasoning');
        const capTools = cfgField('profile-capability-tools');
        const capVision = cfgField('profile-capability-vision');
        if (capReason)
            capReason.checked = p.capability_reasoning !== false;
        if (capTools)
            capTools.checked = p.capability_tool_calling !== false;
        if (capVision)
            capVision.checked = p.capability_vision !== false;
        auxEnabledEl.checked = !!p.aux_llm_enabled;
        const aux = p.aux_llm || {};
        auxUrlEl.value = aux.target_url || '';
        auxModelEl.value = aux.model_name || '';
        auxKeyEl.value = aux.api_key || '';
        // Coder
        if (coderEnabledEl)
            coderEnabledEl.checked = !!p.coder_enabled;
        const coder = p.coder || {};
        if (coderProvEl)
            coderProvEl.value = coder.provider || 'local';
        if (coderUrlEl)
            coderUrlEl.value = coder.target_url || '';
        if (coderModelEl)
            coderModelEl.value = coder.model_name || '';
        if (coderKeyEl)
            coderKeyEl.value = coder.api_key || '';
        if (coderTimeoutEl)
            coderTimeoutEl.value = String(coder.timeout ?? 180);
        if (coderFields)
            coderFields.classList.toggle('hidden', !p.coder_enabled);
        // Vision
        if (visionEnabledEl)
            visionEnabledEl.checked = !!p.vision_enabled;
        const vision = p.vision_llm || {};
        if (visionProvEl)
            visionProvEl.value = vision.provider || 'local';
        if (visionUrlEl)
            visionUrlEl.value = vision.target_url || '';
        if (visionModelEl)
            visionModelEl.value = vision.model_name || '';
        if (visionKeyEl)
            visionKeyEl.value = vision.api_key || '';
        if (visionTimeoutEl)
            visionTimeoutEl.value = String(vision.timeout ?? 60);
        if (visionRespondEl)
            visionRespondEl.checked = !!vision.respond_directly;
        if (visionFields)
            visionFields.classList.toggle('hidden', !p.vision_enabled);
        // Embedding
        if (embedEnabledEl)
            embedEnabledEl.checked = !!p.embed_enabled;
        const embed = p.librarian || {};
        if (embedModelEl)
            embedModelEl.value = embed.model_name || '';
        if (embedFields)
            embedFields.classList.toggle('hidden', !p.embed_enabled);
        syncVisionCapabilityCheckbox();
    }
    else {
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
        if (personaOverrideEl)
            personaOverrideEl.value = '';
        const capReason = cfgField('profile-capability-reasoning');
        const capTools = cfgField('profile-capability-tools');
        const capVision = cfgField('profile-capability-vision');
        if (capReason)
            capReason.checked = true;
        if (capTools)
            capTools.checked = true;
        if (capVision)
            capVision.checked = true;
        auxEnabledEl.checked = false;
        auxUrlEl.value = '';
        auxModelEl.value = '';
        auxKeyEl.value = '';
        // Coder defaults
        if (coderEnabledEl)
            coderEnabledEl.checked = false;
        if (coderProvEl)
            coderProvEl.value = 'local';
        if (coderUrlEl)
            coderUrlEl.value = '';
        if (coderModelEl)
            coderModelEl.value = '';
        if (coderKeyEl)
            coderKeyEl.value = '';
        if (coderTimeoutEl)
            coderTimeoutEl.value = '180';
        if (coderFields)
            coderFields.classList.add('hidden');
        // Vision defaults
        if (visionEnabledEl)
            visionEnabledEl.checked = false;
        if (visionProvEl)
            visionProvEl.value = 'local';
        if (visionUrlEl)
            visionUrlEl.value = '';
        if (visionModelEl)
            visionModelEl.value = '';
        if (visionKeyEl)
            visionKeyEl.value = '';
        if (visionTimeoutEl)
            visionTimeoutEl.value = '60';
        if (visionRespondEl)
            visionRespondEl.checked = false;
        if (visionFields)
            visionFields.classList.add('hidden');
        syncVisionCapabilityCheckbox();
        // Embedding defaults (enabled by default)
        if (embedEnabledEl)
            embedEnabledEl.checked = true;
        if (embedModelEl)
            embedModelEl.value = '';
        if (embedFields)
            embedFields.classList.remove('hidden');
    }
    auxFields.classList.toggle('hidden', !auxEnabledEl.checked);
    keyRow.style.display = provEl.value === 'local' ? 'none' : '';
    openSubPage('profile-editor-overlay');
}
;
export function closeProfileEditor() {
    closeSubPage('profile-editor-overlay');
}
;
export function onProfileProviderChange() {
    const prov = cfgField('profile-provider');
    const url = cfgField('profile-url');
    const model = cfgField('profile-model');
    const keyRow = cfgField('profile-api-key-row');
    if (!prov)
        return;
    const v = prov.value;
    if (keyRow)
        keyRow.style.display = v === 'local' ? 'none' : '';
    if (v === 'local') {
        if (url)
            url.value = 'http://localhost:11434/v1';
        if (model)
            model.value = '';
    }
    else if (v === 'z_ai') {
        if (url)
            url.value = 'https://api.z.ai/api/paas/v4';
        if (model)
            model.value = 'glm-5';
    }
    else if (v === 'grok') {
        if (url)
            url.value = 'https://api.x.ai/v1/chat/completions';
        if (model && !model.value.trim())
            model.value = 'grok-4-1-fast-reasoning';
    }
    else if (v === 'deepseek') {
        if (url)
            url.value = 'https://api.deepseek.com/chat/completions';
        if (model && !model.value.trim())
            model.value = 'deepseek-chat';
    }
    else if (v === 'openai') {
        if (url)
            url.value = 'https://api.openai.com/v1';
        if (model && !model.value.trim())
            model.value = 'gpt-4o';
    }
}
;
export function onProfileSubProviderChange(type) {
    const prov = cfgField(`profile-${type}-provider`);
    const url = cfgField(`profile-${type}-url`);
    const model = cfgField(`profile-${type}-model`);
    if (!prov)
        return;
    const v = prov.value;
    const isCoder = type === 'coder';
    if (v === 'local') {
        if (url)
            url.value = isCoder ? '' : 'http://localhost:11434/v1';
        if (model)
            model.value = '';
    }
    else if (v === 'z_ai') {
        if (url)
            url.value = isCoder ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4';
        if (model)
            model.value = 'glm-5';
    }
    else if (v === 'grok') {
        if (url)
            url.value = 'https://api.x.ai/v1/chat/completions';
        if (model && !model.value.trim())
            model.value = 'grok-4-1-fast-reasoning';
    }
    else if (v === 'deepseek') {
        if (url)
            url.value = 'https://api.deepseek.com/chat/completions';
        if (model && !model.value.trim())
            model.value = 'deepseek-chat';
    }
    else if (v === 'openai') {
        if (url)
            url.value = 'https://api.openai.com/v1';
        if (model && !model.value.trim())
            model.value = 'gpt-4o';
    }
}
;
export async function saveProfile(e) {
    if (e)
        e.preventDefault();
    const payload = {
        id: cfgField('profile-edit-id')?.value || '',
        name: cfgField('profile-name')?.value || '',
        provider: cfgField('profile-provider')?.value || 'local',
        target_url: cfgField('profile-url')?.value || '',
        model_name: cfgField('profile-model')?.value || '',
        api_key: cfgField('profile-api-key')?.value || '',
        temperature: parseFloat(_cfgVal('profile-temperature')) || 0.7,
        timeout: parseInt(_cfgVal('profile-timeout'), 10) || 120,
        context_length: parseInt(_cfgVal('profile-context'), 10) || 24000,
        max_tokens: 2048,
        color: cfgField('profile-color')?.value || '#6366f1',
        persona_override: (cfgField('profile-persona-override')?.value || '').trim() || null,
        capability_reasoning: cfgField('profile-capability-reasoning')?.checked !== false,
        capability_tool_calling: cfgField('profile-capability-tools')?.checked !== false,
        capability_vision: (function () {
            const visionEnabled = cfgField('profile-vision-enabled')?.checked;
            const visionUrl = (cfgField('profile-vision-url')?.value || '').trim();
            const visionModel = (cfgField('profile-vision-model')?.value || '').trim();
            if (visionEnabled && (visionUrl || visionModel))
                return true;
            return cfgField('profile-capability-vision')?.checked !== false;
        })(),
        aux_llm_enabled: cfgField('profile-aux-enabled')?.checked || false,
        aux_llm: {
            target_url: cfgField('profile-aux-url')?.value || '',
            model_name: cfgField('profile-aux-model')?.value || '',
            api_key: cfgField('profile-aux-key')?.value || '',
        },
        coder_enabled: cfgField('profile-coder-enabled')?.checked || false,
        coder: {
            provider: cfgField('profile-coder-provider')?.value || 'local',
            target_url: cfgField('profile-coder-url')?.value || '',
            model_name: cfgField('profile-coder-model')?.value || '',
            api_key: cfgField('profile-coder-key')?.value || '',
            timeout: parseInt(_cfgVal('profile-coder-timeout'), 10) || 180,
        },
        vision_enabled: cfgField('profile-vision-enabled')?.checked || false,
        vision_llm: {
            provider: cfgField('profile-vision-provider')?.value || 'local',
            target_url: cfgField('profile-vision-url')?.value || '',
            model_name: cfgField('profile-vision-model')?.value || '',
            api_key: cfgField('profile-vision-key')?.value || '',
            timeout: parseInt(_cfgVal('profile-vision-timeout'), 10) || 60,
            respond_directly: cfgField('profile-vision-respond-directly')?.checked || false,
        },
        embed_enabled: cfgField('profile-embed-enabled')?.checked || false,
        librarian: {
            model_name: cfgField('profile-embed-model')?.value || '',
        },
    };
    try {
        const res = await apiCall('/api/model-profiles', { method: 'POST', body: payload });
        if (!res.ok)
            throw new Error(t('config.profile_save_error'));
        showToast(t('config.profile_saved'), 'success');
        closeProfileEditor();
        await loadModelProfiles();
    }
    catch (e) {
        showToast(t('config.profile_save_error'), 'error');
    }
}
;
export async function deleteProfile(profileId) {
    if (!(await showConfirm(t('config.profile_delete_confirm'))))
        return;
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'DELETE' });
        if (!res.ok)
            throw new Error();
        showToast(t('config.profile_deleted'), 'success');
        closeProfileCardMenu();
        await loadModelProfiles();
    }
    catch (e) {
        showToast(t('common.error'), 'error');
    }
}
;
export function openProfileCardMenu(profileId, ev) {
    if (ev)
        ev.stopPropagation();
    const modal = cfgField('profile-card-menu-modal');
    if (!modal)
        return;
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
}
;
export function closeProfileCardMenu() {
    const modal = cfgField('profile-card-menu-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
}
;
export async function setProfileVisibility(profileId, visible) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}`, { method: 'PATCH', body: { visible_in_selector: visible } });
        if (!res.ok)
            throw new Error();
        showToast(visible ? t('config.profile_shown_in_selector') : t('config.profile_hidden_from_selector'), 'success');
        await loadModelProfiles();
    }
    catch (e) {
        showToast(t('config.profile_visibility_error'), 'error');
    }
}
;
{
    const menuModal = cfgField('profile-card-menu-modal');
    if (menuModal) {
        menuModal.addEventListener('click', (e) => {
            const tgt = e.target;
            const btn = tgt?.closest('button[data-action]');
            if (!btn)
                return;
            const profileId = menuModal.dataset.profileId;
            if (!profileId)
                return;
            const action = btn.getAttribute('data-action');
            closeProfileCardMenu();
            if (action === 'toggle_visibility') {
                const visible = btn.dataset.visible !== 'true';
                setProfileVisibility(profileId, visible);
            }
            else if (action === 'edit')
                showProfileEditor(profileId);
            else if (action === 'duplicate')
                duplicateProfile(profileId);
            else if (action === 'delete')
                deleteProfile(profileId);
        });
    }
}
export async function duplicateProfile(profileId) {
    const p = _modelProfiles.find(x => x.id === profileId);
    if (!p)
        return;
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
        if (!res.ok)
            throw new Error(t('config.profile_save_error'));
        showToast(t('hy.profile_duplicated'), 'success');
        await loadModelProfiles();
    }
    catch (e) {
        showToast(t('hy.duplicate_error'), 'error');
    }
}
;
/** Două flashuri în exteriorul barei la schimbarea modelului (același stil ca la streaming). */
function playChatBarGlow(profileId) {
    const bar = document.querySelector('.chat-input-inner');
    if (!bar)
        return;
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
export async function activateProfile(profileId) {
    try {
        const res = await apiCall(`/api/model-profiles/${profileId}/activate`, { method: 'POST' });
        if (!res.ok)
            throw new Error();
        playChatBarGlow(profileId);
        await loadModelProfiles();
    }
    catch (e) {
        showToast(t('hy.activation_error'), 'error');
    }
}
;
export async function saveConfig(eOrOptions) {
    const arg = eOrOptions ?? {};
    const isEventLike = typeof arg.preventDefault === 'function';
    const options = isEventLike ? {} : arg;
    const ev = isEventLike ? arg : null;
    const silent = !!options.silent;
    if (ev)
        ev.preventDefault();
    // Find the clicked save button (if any) and put it into a loading state
    const saveBtn = ev ? (ev.currentTarget || ev.target?.closest('button')) : null;
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
        const langEl = cfgField('ui_language');
        const language = langEl ? langEl.value : 'en';
        if (isExplicitNonAdmin()) {
            try {
                const resp = await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
                if (!resp.ok)
                    throw new Error(`HTTP ${resp.status}`);
            }
            catch (err) {
                showToast(t('updates.save_error') + (_errMsg(err)), 'error');
                return;
            }
            const userPersona = cfgField('user_persona');
            if (userPersona) {
                try {
                    await apiCall('/api/users/me', { method: 'PATCH', body: { persona: userPersona.value } });
                }
                catch (_) { }
            }
            try {
                setLanguage(language);
            }
            catch (err) { }
            _refreshUiLanguageSelect(language);
            if (!silent)
                showToast(t('config.save_success'), 'success');
            return;
        }
        const parseList = (s) => (s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
        const wsTransportRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
        const transportMode = wsTransportRadio && wsTransportRadio.checked ? 'websocket' : 'firebase';
        const config = {
            verbose_logging: (cfgField('logging_mode')?.value || 'compact') === 'verbose',
            librarian: {
                retrieval_limit: Math.min(20, Math.max(1, parseInt(_cfgVal('intel_retrieval_limit'), 10) || 5)),
                memory_relevance_max_distance: (() => {
                    const v = cfgField('intel_memory_relevance_max_distance')?.value?.trim();
                    if (!v || v === '')
                        return null;
                    const n = parseFloat(v);
                    if (Number.isNaN(n))
                        return null;
                    return Math.min(2, Math.max(0, n));
                })()
            },
            security: {
                whitelist_enabled: (cfgField('wl_numbers')?.value || '').split('\n').map(n => n.trim()).filter(n => n).length > 0,
                allowed_numbers: (cfgField('wl_numbers')?.value || '').split('\n').map(n => n.trim()).filter(n => n),
                anti_injection: cfgField('security_anti_injection')?.checked !== false,
                anti_injection_prompt_template: cfgField('security_anti_injection_prompt')?.value || '',
                tool_guardrails: cfgField('security_tool_guardrails')?.checked !== false,
                restrict_mutating_tools_on_untrusted_content: cfgField('security_restrict_untrusted_tools')?.checked !== false
            },
            fcm: {
                enabled: transportMode === 'firebase',
                transport_mode: transportMode,
                websocket_enabled: transportMode === 'websocket',
                send_when_ws_disconnected: true,
                project_id: (cfgField('fcm_project_id')?.value || '').trim(),
                service_account_path: (cfgField('fcm_service_account_path')?.value || '').trim(),
            },
            prompts: (() => {
                const nlList = (s) => (s || '').split(/\n/).map((x) => x.trim()).filter(Boolean);
                return {
                    system_persona: cfgField('p_persona')?.value ?? '',
                    agent_instructions: cfgField('p_agent_instructions')?.value ?? '',
                    agent_instructions_fallback: (cfgField('p_agent_instructions_fallback')?.value ?? '').trim(),
                    agent_instruction_overrides: nlList(cfgField('p_agent_instruction_overrides')?.value ?? ''),
                    search_web_single_message_instruction: (cfgField('p_search_web_single_message_instruction')?.value ?? '').trim(),
                    web_content_reply_instruction: (cfgField('p_web_content_reply_instruction')?.value ?? '').trim(),
                    image_placeholder: (cfgField('p_image_placeholder')?.value ?? '').trim(),
                    summarize: (cfgField('p_summarize')?.value ?? '').trim()
                };
            })(),
            memory: {
                working_window: Math.min(50, Math.max(4, parseInt(_cfgVal('intel_working_window'), 10) || 12)),
                summarize_every: Math.min(30, Math.max(4, parseInt(_cfgVal('intel_summarize_every'), 10) || 8)),
                fact_similarity_threshold: Math.min(0.9, Math.max(0.1, parseFloat(_cfgVal('memory_fact_similarity')) || 0.45)),
                extraction_timeout: Math.min(600, Math.max(10, parseInt(_cfgVal('memory_extraction_timeout'), 10) || 120)),
                extraction_input_max_chars: Math.min(4000, Math.max(300, parseInt(_cfgVal('memory_extraction_input_max_chars'), 10) || 900)),
                extraction_max_tokens_full: Math.min(2400, Math.max(128, parseInt(_cfgVal('memory_extraction_max_tokens_full'), 10) || 800)),
                extraction_max_lines: Math.min(10, Math.max(1, parseInt(_cfgVal('memory_extraction_max_lines'), 10) || 2)),
                extraction_rules: (cfgField('memory_extraction_rules')?.value ?? '').trim() || undefined,
                extraction_examples: getExtractionExamples().filter(ex => ex.input && ex.input.trim()),
            },
            intelligence: {
                max_agent_turns: Math.min(30, Math.max(1, parseInt(_cfgVal('max_agent_turns'), 10) || 10)),
                post_response_concurrency: Math.min(5, Math.max(1, parseInt(_cfgVal('post_response_concurrency'), 10) || 1)),
                inject_relevant_facts: cfgField('inject_relevant_facts')?.checked || false,
                lazy_history: cfgField('intel_lazy_history')?.checked !== false,
                richer_tool_results: cfgField('richer_tool_results')?.checked || false,
                knowledge_cutoff: (cfgField('intel_knowledge_cutoff')?.value || '2024-01').trim(),
                search_tendency: Math.min(5, Math.max(1, parseInt(_cfgVal('intel_search_tendency'), 10) || 3)),
                search_use_conversation_context: cfgField('search_use_conversation_context')?.checked || false,
                search_context_similarity_threshold: Math.min(0.99, Math.max(0.2, parseFloat(_cfgVal('search_context_similarity_threshold')) || 0.55)),
                intent_router: {
                    enabled: cfgField('intent_router_enabled')?.checked || false,
                },
                proactive_hints: {
                    enabled: cfgField('proactive_hints_enabled')?.checked || false,
                },
                shell: (() => {
                    const rawAllowed = (cfgField('shell_allowed_commands')?.value || '').trim();
                    const rawBlocked = (cfgField('shell_blocked_patterns')?.value || '').trim();
                    const parseList = (s) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
                    const allowedList = parseList(rawAllowed);
                    const blockedList = parseList(rawBlocked);
                    return {
                        enabled: cfgField('shell_enabled')?.checked !== false,
                        allowed_commands: allowedList.length ? allowedList : ['curl', 'wget', 'ping', 'date', 'uname', 'cat', 'echo', 'head', 'tail', 'df', 'free', 'uptime'],
                        blocked_patterns: blockedList,
                        max_output_chars: Math.min(100000, Math.max(500, parseInt(_cfgVal('shell_max_output_chars'), 10) || 8000)),
                        timeout_seconds: Math.min(120, Math.max(5, parseInt(_cfgVal('shell_timeout_seconds'), 10) || 15)),
                        rate_limit_per_minute: Math.min(30, Math.max(1, parseInt(_cfgVal('shell_rate_limit'), 10) || 5))
                    };
                })(),
                file_read: {
                    enabled: cfgField('file_read_enabled')?.checked !== false,
                    max_bytes: Math.min(500000, Math.max(1024, parseInt(_cfgVal('file_read_max_bytes'), 10) || 51200)),
                    rate_limit_per_minute: Math.min(60, Math.max(1, parseInt(_cfgVal('file_read_rate_limit'), 10) || 10))
                },
                run_script: {
                    enabled: cfgField('run_script_enabled')?.checked !== false,
                    timeout_seconds: Math.min(30, Math.max(5, parseInt(_cfgVal('run_script_timeout'), 10) || 15)),
                    max_output_chars: Math.min(100000, Math.max(1000, parseInt(_cfgVal('run_script_max_output'), 10) || 20000)),
                    rate_limit_per_minute: Math.min(15, Math.max(1, parseInt(_cfgVal('run_script_rate_limit'), 10) || 3))
                },
                propose_patch: {
                    enabled: cfgField('propose_patch_enabled')?.checked !== false,
                    allowed_dirs: (cfgField('propose_patch_allowed_dirs')?.value || 'scripts, docs, ai_suggestions').split(',').map((s) => s.trim()).filter(Boolean)
                },
                consolidation: {
                    enabled: cfgField('consolidation_enabled')?.checked || false,
                    time: (cfgField('consolidation_time')?.value || '03:00').trim().slice(0, 5),
                    interval: cfgField('consolidation_interval')?.value || 'daily',
                    similarity_threshold: Math.min(0.99, Math.max(0.8, parseFloat(_cfgVal('consolidation_threshold')) || 0.92)),
                    session_trigger_messages: Math.min(500, Math.max(20, parseInt(_cfgVal('consolidation_session_trigger_messages'), 10) || 80)),
                    compression_ratio: Math.min(0.5, Math.max(0.05, parseFloat(_cfgVal('consolidation_compression_ratio')) || 0.15)),
                    history_log_path: (cfgField('consolidation_history_log_path')?.value || 'history_log.md').trim()
                },
            },
            timezone: (cfgField('config_timezone')?.value || '').trim(),
            updates: {
                addons: {
                    check_interval: cfgField('updates_addons_check_interval')?.value || 'never',
                    auto_update: !!cfgField('updates_addons_auto_update')?.checked,
                }
            },
            ui: { language }
        };
        try {
            const resp = await apiCall('/api/config', { method: 'POST', body: config });
            if (!resp.ok)
                throw new Error(`HTTP ${resp.status}`);
        }
        catch (err) {
            showToast((t('config.save_error')) + ' ' + (_errMsg(err)), 'error');
            return;
        }
        const wsServiceShouldRun = (() => {
            const mode = String(config.fcm?.transport_mode || 'hybrid').toLowerCase();
            const wsEnabled = config.fcm?.websocket_enabled !== false;
            return wsEnabled && mode !== 'firebase';
        })();
        if (window.__HYVE_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
            try {
                window.__setNativeWsServiceEnabled(!!wsServiceShouldRun);
            }
            catch (_) { }
        }
        const badge = cfgField('header-log-mode-badge');
        if (badge) {
            const verbose = !!config.verbose_logging;
            badge.textContent = verbose ? 'LOG: VERBOSE' : 'LOG: COMPACT';
            badge.classList.remove('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10', 'border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
            if (verbose) {
                badge.classList.add('border-amber-500/30', 'text-amber-300', 'bg-amber-500/10');
            }
            else {
                badge.classList.add('border-emerald-500/30', 'text-emerald-300', 'bg-emerald-500/10');
            }
        }
        try {
            setLanguage(config.ui.language);
            _refreshUiLanguageSelect(config.ui.language);
        }
        catch (err) { }
        // Also save native App tab config if running in the Hyve Android app
        if (typeof window.saveAppConfig === 'function') {
            try {
                window.saveAppConfig();
            }
            catch (_) { }
        }
        // Save notification preferences if on the notifications tab
        const notifTab = cfgField('cfg-tab-notifications');
        if (notifTab && !notifTab.classList.contains('hidden')) {
            try {
                await saveNotificationSettings({ silent: true });
            }
            catch (_) { }
        }
        if (!silent)
            showToast(t('config.save_success'), 'success');
    }
    catch (err) {
        console.error('saveConfig failed', err);
        showToast((t('config.save_error')) + ' ' + _errMsg(err), 'error');
    }
    finally {
        restoreBtn();
    }
}
/** Generate AI welcome greetings on demand (button click). */
/** Copy text to clipboard; works on HTTP and with password fields. Shows toast on success. */
export function copyToClipboard(text, successMessage) {
    const msg = successMessage || (t('common.copied'));
    if (!text || typeof text !== 'string')
        return false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => showToast(msg, 'success')).catch(fallback);
        }
        else {
            fallback();
        }
    }
    catch (e) {
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
        }
        catch (err) {
            showToast(t('common.copy_failed'), 'error');
        }
        document.body.removeChild(ta);
    }
    return true;
}
export function copyWebhook() {
    const el = cfgField('waha_webhook');
    if (!el || !el.value)
        return;
    copyToClipboard(el.value, t('config.webhook_copied'));
}
export async function restartServer() {
    if (!(await showConfirm(t('config.restart_confirm'))))
        return;
    suppressLogout(true);
    showHubStartupLoadingAfterRestart();
    showToast(t('config.restart_started'), 'info', 8000);
    try {
        const resp = await apiCall('/api/restart', { method: 'POST' });
        if (!resp.ok) {
            suppressLogout(false);
            let detail = `HTTP ${resp.status}`;
            try {
                const data = await resp.json();
                detail = data.detail || data.message || detail;
                if (typeof detail === 'object')
                    detail = JSON.stringify(detail);
            }
            catch (_) { }
            showToast(String(detail), 'error');
            return;
        }
    }
    catch (e) {
        // Network error after restart starts is expected; keep polling
        if (_errMsg(e) === 'Session expired.') {
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
    if (token)
        headers['Authorization'] = 'Bearer ' + token;
    const tryReconnect = () => {
        attempts++;
        fetch('/api/config', { method: 'GET', credentials: 'same-origin', headers })
            .then(r => {
            if (r.ok) {
                suppressLogout(false);
                location.reload();
            }
        })
            .catch(() => { })
            .finally(() => { if (attempts < maxAttempts)
            setTimeout(tryReconnect, 2000);
        else
            suppressLogout(false); });
    };
    setTimeout(tryReconnect, 3000);
}
// --- WHISPER / VOICE INPUT ---
export async function testWhisperConnection() {
    const btn = cfgField('whisper-test-btn');
    const resultDiv = cfgField('whisper-test-result');
    if (btn)
        btn.disabled = true;
    try {
        const host = (cfgField('whisper_host')?.value || 'localhost').trim();
        const port = parseInt(_cfgVal('whisper_port'), 10) || 10300;
        const res = await apiCall(`/api/whisper/status?host=${encodeURIComponent(host)}&port=${port}`);
        const data = await res.json();
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-red-500/15', 'text-red-300', 'bg-emerald-500/15', 'text-emerald-300');
            if (data.connected) {
                resultDiv.classList.add('bg-emerald-500/15', 'text-emerald-300');
                resultDiv.innerHTML = '<i class="fas fa-check-circle mr-1"></i> ' + (t('config.whisper_test_success'));
            }
            else {
                resultDiv.classList.add('bg-red-500/15', 'text-red-300');
                resultDiv.innerHTML = '<i class="fas fa-times-circle mr-1"></i> ' + (t('config.whisper_test_fail'));
            }
        }
    }
    catch (e) {
        if (resultDiv) {
            resultDiv.classList.remove('hidden', 'bg-emerald-500/15', 'text-emerald-300', 'bg-red-500/15', 'text-red-300');
            resultDiv.classList.add('bg-red-500/15', 'text-red-300');
            resultDiv.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i> ' + (_errMsg(e) || t('common.error'));
        }
    }
    finally {
        if (btn)
            btn.disabled = false;
    }
}
;
export async function testPiperConnection() {
    const btn = cfgField('piper-test-btn');
    if (!btn)
        return;
    btn.disabled = true;
    const baseHtml = btn.innerHTML;
    const baseClass = btn.className;
    const setBtnState = (type, text) => {
        btn.innerHTML = `<i class="fas ${type === 'ok' ? 'fa-check-circle' : 'fa-times-circle'}"></i><span>${text}</span>`;
        btn.classList.remove('bg-cyan-500/15', 'hover:bg-cyan-500/25', 'text-cyan-300', 'border-cyan-500/25');
        if (type === 'ok') {
            btn.classList.add('bg-emerald-500/15', 'text-emerald-300', 'border-emerald-500/25');
        }
        else {
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
            setBtnState('ok', t('config.piper_test_success'));
        }
        else {
            // Fallback: if process is actually running, treat as reachable.
            let running = false;
            try {
                const sRes = await apiCall('/api/addons/piper/status');
                const s = await sRes.json();
                running = s && s.status === 'running';
            }
            catch (_) { }
            if (running) {
                setBtnState('ok', t('config.piper_test_success'));
            }
            else {
                const detail = data?.detail ? formatHealthError(data.detail) : (t('config.piper_test_fail'));
                setBtnState('fail', detail);
            }
        }
    }
    catch (e) {
        setBtnState('fail', _errMsg(e) || t('common.error'));
    }
    finally {
        setTimeout(() => {
            btn.className = baseClass;
            btn.innerHTML = baseHtml;
            btn.disabled = false;
        }, 3000);
    }
}
;
// Legacy fusion/pago test helpers removed — use Settings → Integrations → Test connection.
export { refreshIntegrationsSettingsView, switchIntegrationSubtab, openIntegrationConfigModal, closeIntegrationConfigModal, copyAssistOllamaUserUrl, copyAssistKey, regenerateAssistKey, } from './features_integrations_settings.js';
export { selectNotifChannel, selectNotifTransport, refreshNotifWsNativeStatus, testNotification, testWsNotification, testFcmNotification, loadNotificationPrefs, saveNotificationSettings, } from './features_notifications_config.js';
export { loadAddons, installAddon, uninstallAddon, toggleAddon, openAddonConfigModal, closeAddonConfigModal, saveAddonConfig, checkAddonHealth, updateHeaderUpdatesBadge, refreshUpdatesHeaderBadge, loadUpdatesAddons, checkAddonUpdates, updateAllAddons, updateSingleAddon, toggleUpdatesIntervalDropdown, setUpdatesInterval, syncUpdatesIntervalDropdown, } from './features_addons_settings.js';
export { initGenericCustomSelects, upgradeNativeSelects, } from './features_custom_selects.js';
