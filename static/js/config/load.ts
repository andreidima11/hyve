/**
 * Load /api/config into settings form fields.
 */
import { apiCall } from '../api.js';
import { getLanguage, t } from '../lang/index.js';
import { renderExtractionExamples } from '../features_memory.js';
import {
    syncIntegrationToggles,
    bindIntegrationToggleButtonsOnce,
    loadIntegrationCatalog,
    getIntegrationCatalog,
} from '../features_integrations_settings.js';
import { getTts } from '../chat.js';
import { setIsAdmin } from '../user_context.js';
import { syncUpdatesIntervalDropdown } from '../features_addons_settings.js';
import { initGenericCustomSelects, upgradeNativeSelects } from '../features_custom_selects.js';
import { cfgField, findIntegrationCheckbox } from './utils.js';
import { refreshUiLanguageSelect, updateSearchTendencyHint } from './ui_language.js';
import { renderUserPhonesList, addUserPhone } from './user_phones.js';
import { saveConfig } from './save.js';

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

    const updateLoggingModeBadge = (isVerbose: boolean) => {
        const badge = cfgField('header-log-mode-badge');
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
    const uiLangSelect = cfgField('ui_language');
    if (uiLangSelect) {
        refreshUiLanguageSelect((cfg.ui && cfg.ui.language) || getLanguage());
    }

    if (cfg.security) {
        const wlNum = cfgField('wl_numbers');
        if (wlNum) wlNum.value = (cfg.security.allowed_numbers || []).join('\n');
        const secAntiInj = cfgField('security_anti_injection');
        if (secAntiInj) secAntiInj.checked = cfg.security.anti_injection !== false;
        const secAntiInjPrompt = cfgField('security_anti_injection_prompt');
        if (secAntiInjPrompt) secAntiInjPrompt.value = cfg.security.anti_injection_prompt_template || '';
        const secGuardrails = cfgField('security_tool_guardrails');
        if (secGuardrails) secGuardrails.checked = cfg.security.tool_guardrails !== false;
        const secRestrictUntrustedTools = cfgField('security_restrict_untrusted_tools');
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
        'updates_hyve_check_interval': cfg.updates?.hyve?.check_interval || 'never',
        'updates_hyve_auto_update': cfg.updates?.hyve?.auto_update ?? false,
        'aux_llm_url': (cfg.intelligence?.aux_llm?.target_url ?? ''),
        'aux_llm_model': (cfg.intelligence?.aux_llm?.model_name ?? ''),
        'aux_llm_api_key': (cfg.intelligence?.aux_llm?.api_key ?? ''),
        'aux_llm_provider': (cfg.intelligence?.aux_llm?.source ?? cfg.intelligence?.aux_llm?.provider ?? 'local')
    };
    for (const [id, val] of Object.entries(map)) {
        const el = cfgField(id);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = (val ?? '') + '';
    }
    if (typeof syncUpdatesIntervalDropdown === 'function') syncUpdatesIntervalDropdown();
    // Normalize old "custom" to "local" (Custom option removed)
    ['llm_provider', 'coder_provider', 'aux_llm_provider', 'vision_llm_provider'].forEach(id => {
        const el = cfgField(id);
        if (el && el.value === 'custom') el.value = 'local';
    });

    // Infer provider from URL when source not set
    function inferSource(url: string | undefined) {
        if (!url || !url.trim()) return 'local';
        const u = url.toLowerCase();
        if (u.includes('api.z.ai') && u.includes('coding')) return 'z_ai';
        if (u.includes('api.z.ai')) return 'z_ai';
        if (u.includes('api.x.ai')) return 'grok';
        if (u.includes('api.deepseek.com')) return 'deepseek';
        if (u.includes('openai.com')) return 'openai';
        return 'local';
    }
    const llmProv = cfgField('llm_provider');
    if (llmProv && !cfg.llm?.source && !cfg.llm?.provider) llmProv.value = inferSource(cfg.llm?.target_url);
    const coderProv = cfgField('coder_provider');
    if (coderProv && !cfg.coder?.source && !cfg.coder?.provider) coderProv.value = inferSource(cfg.coder?.target_url);
    const auxProv = cfgField('aux_llm_provider');
    if (auxProv && !(cfg.intelligence?.aux_llm?.source || cfg.intelligence?.aux_llm?.provider)) auxProv.value = inferSource(cfg.intelligence?.aux_llm?.target_url);
    const visionProv = cfgField('vision_llm_provider');
    if (visionProv && !(cfg.vision_llm?.source || cfg.vision_llm?.provider)) visionProv.value = inferSource(cfg.vision_llm?.target_url);

    // Prefill when dropdown changes
    function applyProvider(providerId: string, urlId: string, modelId: string, keyRowId: string | null, isCoder: boolean) {
        const sel = cfgField(providerId);
        if (!sel) return;
        const urlEl = cfgField(urlId);
        const modelEl = cfgField(modelId);
        const keyRow = keyRowId ? cfgField(keyRowId) : null;
        // Billing link (only for main LLM provider)
        const billingLink = (providerId === 'llm_provider') ? cfgField('zai_billing_link') : null;
        function syncBillingLink(v: string) {
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
    const parseListToText = (arr: unknown) => Array.isArray(arr) ? arr.join('\n') : '';
    const intelMw = cfgField('intel_working_window');
    const intelMs = cfgField('intel_summarize_every');
    if (intelMw) intelMw.value = m.working_window ?? 12;
    if (intelMs) intelMs.value = m.summarize_every ?? 8;
    const mFactSim = cfgField('memory_fact_similarity');
    if (mFactSim) mFactSim.value = m.fact_similarity_threshold ?? 0.45;
    const mExtractionTimeout = cfgField('memory_extraction_timeout');
    const mExtractionInputMaxChars = cfgField('memory_extraction_input_max_chars');
    const mExtractionMaxTokensFull = cfgField('memory_extraction_max_tokens_full');
    const mExtractionMaxLines = cfgField('memory_extraction_max_lines');
    if (mExtractionTimeout) mExtractionTimeout.value = m.extraction_timeout ?? (cfg.llm?.timeout ?? 120);
    if (mExtractionInputMaxChars) mExtractionInputMaxChars.value = m.extraction_input_max_chars ?? 900;
    if (mExtractionMaxTokensFull) mExtractionMaxTokensFull.value = m.extraction_max_tokens_full ?? 800;
    if (mExtractionMaxLines) mExtractionMaxLines.value = m.extraction_max_lines ?? 2;

    // Logging mode (live toggle)
    const loggingModeEl = cfgField('logging_mode');
    if (loggingModeEl && !loggingModeEl.dataset.bound) {
        loggingModeEl.dataset.bound = '1';
        loggingModeEl.addEventListener('change', async () => {
            updateLoggingModeBadge(loggingModeEl.value === 'verbose');
            try {
                await saveConfig({});
            } catch (e) { /* handled in saveConfig via toast/error path */ }
        });
    }

    const mExtractionRules = cfgField('memory_extraction_rules');
    if (mExtractionRules) mExtractionRules.value = m.extraction_rules || '';

    // Memory: extraction examples (few-shot)
    renderExtractionExamples(m.extraction_examples || []);

    // Intelligence: consolidation
    const consolidation = (cfg.intelligence || {}).consolidation || {};
    const cEn = cfgField('consolidation_enabled');
    const cTime = cfgField('consolidation_time');
    const cInterval = cfgField('consolidation_interval');
    const cThr = cfgField('consolidation_threshold');
    if (cEn) cEn.checked = !!consolidation.enabled;
    if (cTime) cTime.value = consolidation.time || '03:00';
    if (cInterval) cInterval.value = consolidation.interval || 'daily';
    if (cThr) cThr.value = consolidation.similarity_threshold ?? 0.92;
    const cSessionTrig = cfgField('consolidation_session_trigger_messages');
    const cCompression = cfgField('consolidation_compression_ratio');
    const cHistoryPath = cfgField('consolidation_history_log_path');
    if (cSessionTrig) cSessionTrig.value = consolidation.session_trigger_messages ?? 80;
    if (cCompression) cCompression.value = consolidation.compression_ratio ?? 0.15;
    if (cHistoryPath) cHistoryPath.value = consolidation.history_log_path || 'history_log.md';

    // Daily news
    // Daily news config removed — now handled by skills/daily_news.py

    // Intelligence: Agent config
    const intel = cfg.intelligence || {};
    const maxAgentTurnsEl = cfgField('max_agent_turns');
    if (maxAgentTurnsEl) maxAgentTurnsEl.value = intel.max_agent_turns ?? 10;
    const postRespConcEl = cfgField('post_response_concurrency');
    if (postRespConcEl) postRespConcEl.value = intel.post_response_concurrency ?? 1;
    const injectFactsEl = cfgField('inject_relevant_facts');
    const richerResultsEl = cfgField('richer_tool_results');
    if (injectFactsEl) injectFactsEl.checked = intel.inject_relevant_facts !== false;
    if (richerResultsEl) richerResultsEl.checked = !!intel.richer_tool_results;
    const lazyHistEl = cfgField('intel_lazy_history');
    if (lazyHistEl) lazyHistEl.checked = intel.lazy_history !== false;  // default true

    // Intent Router
    const _setChk = (id: string, val: unknown) => { const el = cfgField(id); if (el) el.checked = !!val; };
    const routerCfg = intel.intent_router || {};
    _setChk('intent_router_enabled', routerCfg.enabled);

    // Proactive Hints
    const hintsCfg = intel.proactive_hints || {};
    _setChk('proactive_hints_enabled', hintsCfg.enabled);

    // Intelligence: Knowledge cutoff
    const iFreshCut = cfgField('intel_knowledge_cutoff');
    if (iFreshCut) iFreshCut.value = intel.knowledge_cutoff ?? '2024-01';

    // Intelligence: Search tendency slider
    const searchTendencyEl = cfgField('intel_search_tendency');
    if (searchTendencyEl) {
        searchTendencyEl.value = intel.search_tendency ?? 3;
        updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        searchTendencyEl.addEventListener('input', () => {
            updateSearchTendencyHint(parseInt(searchTendencyEl.value, 10));
        });
    }

    // Intelligence: Search context (use previous message in web search query)
    const searchUseCtx = cfgField('search_use_conversation_context');
    const searchCtxThreshold = cfgField('search_context_similarity_threshold');
    if (searchUseCtx) searchUseCtx.checked = !!intel.search_use_conversation_context;
    if (searchCtxThreshold) searchCtxThreshold.value = intel.search_context_similarity_threshold ?? 0.55;

    // Intelligence: Shell & Tool calling
    const shell = intel.shell || {};
    const shellEn = cfgField('shell_enabled');
    const shellAllowed = cfgField('shell_allowed_commands');
    const shellBlocked = cfgField('shell_blocked_patterns');
    const shellMaxOut = cfgField('shell_max_output_chars');
    const shellTimeout = cfgField('shell_timeout_seconds');
    const shellRate = cfgField('shell_rate_limit');
    if (shellEn) shellEn.checked = shell.enabled !== false;
    if (shellAllowed) shellAllowed.value = Array.isArray(shell.allowed_commands) ? shell.allowed_commands.join('\n') : '';
    if (shellBlocked) shellBlocked.value = Array.isArray(shell.blocked_patterns) ? shell.blocked_patterns.join('\n') : '';
    if (shellMaxOut) shellMaxOut.value = shell.max_output_chars ?? 8000;
    if (shellTimeout) shellTimeout.value = shell.timeout_seconds ?? 15;
    if (shellRate) shellRate.value = shell.rate_limit_per_minute ?? 5;

    const fileRead = intel.file_read || {};
    const frEn = cfgField('file_read_enabled');
    const frMaxBytes = cfgField('file_read_max_bytes');
    const frRate = cfgField('file_read_rate_limit');
    if (frEn) frEn.checked = fileRead.enabled !== false;
    if (frMaxBytes) frMaxBytes.value = fileRead.max_bytes ?? 51200;
    if (frRate) frRate.value = fileRead.rate_limit_per_minute ?? 10;

    const runScript = intel.run_script || {};
    const rsEn = cfgField('run_script_enabled');
    const rsTimeout = cfgField('run_script_timeout');
    const rsMaxOut = cfgField('run_script_max_output');
    const rsRate = cfgField('run_script_rate_limit');
    if (rsEn) rsEn.checked = runScript.enabled !== false;
    if (rsTimeout) rsTimeout.value = runScript.timeout_seconds ?? 15;
    if (rsMaxOut) rsMaxOut.value = runScript.max_output_chars ?? 20000;
    if (rsRate) rsRate.value = runScript.rate_limit_per_minute ?? 3;

    const proposePatch = intel.propose_patch || {};
    const ppEn = cfgField('propose_patch_enabled');
    const ppDirs = cfgField('propose_patch_allowed_dirs');
    if (ppEn) ppEn.checked = proposePatch.enabled !== false;
    if (ppDirs) ppDirs.value = Array.isArray(proposePatch.allowed_dirs) ? proposePatch.allowed_dirs.join(', ') : 'scripts, docs, ai_suggestions';

    // Librarian (memory recall) – loaded from cfg.librarian
    const lib = cfg.librarian || {};
    const iRetLimit = cfgField('intel_retrieval_limit');
    const iMemDist = cfgField('intel_memory_relevance_max_distance');
    if (iRetLimit) iRetLimit.value = lib.retrieval_limit ?? 5;
    if (iMemDist) iMemDist.value = lib.memory_relevance_max_distance != null ? lib.memory_relevance_max_distance : '';

    const tts = getTts();
    if (tts) {
        try {
            const stored = localStorage.getItem('hyve_tts_always_speak');
            if (stored !== null) tts.alwaysSpeak = stored === '1';
        } catch (_) {}
    }

    // Integrări + restricții non-admin: whitelist per user, ascundere Models/HA/WhatsApp config/Prompts
    try {
        const meRes = await apiCall('/api/users/me');
        if (!meRes.ok) return;
        const profile = await meRes.json();
        setIsAdmin(profile.is_admin);
        window.dispatchEvent(new CustomEvent('hyve:admin-context-ready', { detail: { isAdmin: profile.is_admin } }));
        const isAdmin = profile.is_admin;

        document.querySelectorAll('.config-admin-only').forEach(el => {
            if (el.id && el.id.startsWith('cfg-tab-')) return;
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
        for (const entry of getIntegrationCatalog()) {
            const slug = String(entry.slug || '').trim();
            if (!slug) continue;
            const cb = findIntegrationCheckbox(slug);
            if (!cb) continue;
            if (Object.prototype.hasOwnProperty.call(entry, 'enabled')) {
                cb.checked = !!entry.enabled;
            }
        }
        syncIntegrationToggles();
    } catch (_) {}

    try {
        const configRoot = document.getElementById('view-config') || document;
        upgradeNativeSelects(configRoot);
        initGenericCustomSelects(configRoot);
    } catch (_) {}

    _configAutoSavePauseUntil = Date.now() + 350;
}
