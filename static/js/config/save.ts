/**
 * Persist settings form to /api/config.
 */
import { apiCall } from '../api.js';
import { setLanguage, t } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { getExtractionExamples } from '../features_memory.js';
import { setIsAdmin, isExplicitNonAdmin } from '../user_context.js';
import { saveNotificationSettings } from '../features_notifications_config.js';
import type { SaveConfigOptions } from '../types/features_config.js';
import { cfgField, cfgVal, errMsg } from './utils.js';
import { refreshUiLanguageSelect } from './ui_language.js';

export async function saveConfig(eOrOptions?: Event | SaveConfigOptions) {
    const arg: Event | SaveConfigOptions = eOrOptions ?? {};
    const isEventLike = typeof (arg as Event).preventDefault === 'function';
    const options: SaveConfigOptions = isEventLike ? {} : (arg as SaveConfigOptions);
    const ev = isEventLike ? (arg as Event) : null;
    const silent = !!options.silent;

    if (ev) ev.preventDefault();

    // Find the clicked save button (if any) and put it into a loading state
    const saveBtn = ev ? ((ev.currentTarget as HTMLButtonElement | null) || (ev.target as HTMLElement | null)?.closest('button')) : null;
    let originalBtnHtml: string | null = null;
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
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        } catch (err) {
            showToast(t('updates.save_error') + (errMsg(err)), 'error');
            return;
        }
        const userPersona = cfgField('user_persona');
        if (userPersona) {
            try { await apiCall('/api/users/me', { method: 'PATCH', body: { persona: userPersona.value } }); } catch (_) {}
        }
        try { setLanguage(language); } catch (err) {}
        refreshUiLanguageSelect(language);
        if (!silent) showToast(t('config.save_success'), 'success');
        return;
    }

    const parseList = (s: string) => (s || '').split(/[\n,]+/).map((x: string) => x.trim()).filter(Boolean);
    const wsTransportRadio = document.querySelector('input[name="notif_transport"][value="websocket"]') as HTMLInputElement | null;
    const transportMode = wsTransportRadio && wsTransportRadio.checked ? 'websocket' : 'firebase';

    const config = {
        verbose_logging: (cfgField('logging_mode')?.value || 'compact') === 'verbose',
        librarian: {
            retrieval_limit: Math.min(20, Math.max(1, parseInt(cfgVal('intel_retrieval_limit'), 10) || 5)),
            memory_relevance_max_distance: (() => {
                const v = cfgField('intel_memory_relevance_max_distance')?.value?.trim();
                if (!v || v === '') return null;
                const n = parseFloat(v);
                if (Number.isNaN(n)) return null;
                return Math.min(2, Math.max(0, n));
            })()
        },
        security: {
            whitelist_enabled: (cfgField('wl_numbers')?.value || '').split('\n').map(n => n.trim()).filter(n => n).length > 0,
            allowed_numbers: (cfgField('wl_numbers')?.value || '').split('\n').map(n => n.trim()).filter(n => n),
            anti_injection: (cfgField('security_anti_injection') as HTMLInputElement | null)?.checked !== false,
            anti_injection_prompt_template: cfgField('security_anti_injection_prompt')?.value || '',
            tool_guardrails: (cfgField('security_tool_guardrails') as HTMLInputElement | null)?.checked !== false,
            restrict_mutating_tools_on_untrusted_content: (cfgField('security_restrict_untrusted_tools') as HTMLInputElement | null)?.checked !== false
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
            const nlList = (s: string) => (s || '').split(/\n/).map((x: string) => x.trim()).filter(Boolean);
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
            working_window: Math.min(50, Math.max(4, parseInt(cfgVal('intel_working_window'), 10) || 12)),
            summarize_every: Math.min(30, Math.max(4, parseInt(cfgVal('intel_summarize_every'), 10) || 8)),
            fact_similarity_threshold: Math.min(0.9, Math.max(0.1, parseFloat(cfgVal('memory_fact_similarity')) || 0.45)),
            extraction_timeout: Math.min(600, Math.max(10, parseInt(cfgVal('memory_extraction_timeout'), 10) || 120)),
            extraction_input_max_chars: Math.min(4000, Math.max(300, parseInt(cfgVal('memory_extraction_input_max_chars'), 10) || 900)),
            extraction_max_tokens_full: Math.min(2400, Math.max(128, parseInt(cfgVal('memory_extraction_max_tokens_full'), 10) || 800)),
            extraction_max_lines: Math.min(10, Math.max(1, parseInt(cfgVal('memory_extraction_max_lines'), 10) || 2)),
            extraction_rules: (cfgField('memory_extraction_rules')?.value ?? '').trim() || undefined,
            extraction_examples: getExtractionExamples().filter(ex => ex.input && ex.input.trim()),
        },
        intelligence: {
            max_agent_turns: Math.min(30, Math.max(1, parseInt(cfgVal('max_agent_turns'), 10) || 10)),
            post_response_concurrency: Math.min(5, Math.max(1, parseInt(cfgVal('post_response_concurrency'), 10) || 1)),
            inject_relevant_facts: (cfgField('inject_relevant_facts') as HTMLInputElement | null)?.checked || false,
            lazy_history: (cfgField('intel_lazy_history') as HTMLInputElement | null)?.checked !== false,
            richer_tool_results: (cfgField('richer_tool_results') as HTMLInputElement | null)?.checked || false,
            knowledge_cutoff: (cfgField('intel_knowledge_cutoff')?.value || '2024-01').trim(),
            search_tendency: Math.min(5, Math.max(1, parseInt(cfgVal('intel_search_tendency'), 10) || 3)),
            search_use_conversation_context: (cfgField('search_use_conversation_context') as HTMLInputElement | null)?.checked || false,
            search_context_similarity_threshold: Math.min(0.99, Math.max(0.2, parseFloat(cfgVal('search_context_similarity_threshold')) || 0.55)),
            intent_router: {
                enabled: (cfgField('intent_router_enabled') as HTMLInputElement | null)?.checked || false,
            },
            proactive_hints: {
                enabled: (cfgField('proactive_hints_enabled') as HTMLInputElement | null)?.checked || false,
            },
            shell: (() => {
                const rawAllowed = (cfgField('shell_allowed_commands')?.value || '').trim();
                const rawBlocked = (cfgField('shell_blocked_patterns')?.value || '').trim();
                const parseList = (s: string) => s.split(/[\n,]+/).map((x: string) => x.trim()).filter(Boolean);
                const allowedList = parseList(rawAllowed);
                const blockedList = parseList(rawBlocked);
                return {
                    enabled: (cfgField('shell_enabled') as HTMLInputElement | null)?.checked !== false,
                    allowed_commands: allowedList.length ? allowedList : ['curl', 'wget', 'ping', 'date', 'uname', 'cat', 'echo', 'head', 'tail', 'df', 'free', 'uptime'],
                    blocked_patterns: blockedList,
                    max_output_chars: Math.min(100000, Math.max(500, parseInt(cfgVal('shell_max_output_chars'), 10) || 8000)),
                    timeout_seconds: Math.min(120, Math.max(5, parseInt(cfgVal('shell_timeout_seconds'), 10) || 15)),
                    rate_limit_per_minute: Math.min(30, Math.max(1, parseInt(cfgVal('shell_rate_limit'), 10) || 5))
                };
            })(),
            file_read: {
                enabled: (cfgField('file_read_enabled') as HTMLInputElement | null)?.checked !== false,
                max_bytes: Math.min(500000, Math.max(1024, parseInt(cfgVal('file_read_max_bytes'), 10) || 51200)),
                rate_limit_per_minute: Math.min(60, Math.max(1, parseInt(cfgVal('file_read_rate_limit'), 10) || 10))
            },
            run_script: {
                enabled: (cfgField('run_script_enabled') as HTMLInputElement | null)?.checked !== false,
                timeout_seconds: Math.min(30, Math.max(5, parseInt(cfgVal('run_script_timeout'), 10) || 15)),
                max_output_chars: Math.min(100000, Math.max(1000, parseInt(cfgVal('run_script_max_output'), 10) || 20000)),
                rate_limit_per_minute: Math.min(15, Math.max(1, parseInt(cfgVal('run_script_rate_limit'), 10) || 3))
            },
            propose_patch: {
                enabled: (cfgField('propose_patch_enabled') as HTMLInputElement | null)?.checked !== false,
                allowed_dirs: (cfgField('propose_patch_allowed_dirs')?.value || 'scripts, docs, ai_suggestions').split(',').map((s: string) => s.trim()).filter(Boolean)
            },
            consolidation: {
                enabled: (cfgField('consolidation_enabled') as HTMLInputElement | null)?.checked || false,
                time: (cfgField('consolidation_time')?.value || '03:00').trim().slice(0, 5),
                interval: cfgField('consolidation_interval')?.value || 'daily',
                similarity_threshold: Math.min(0.99, Math.max(0.8, parseFloat(cfgVal('consolidation_threshold')) || 0.92)),
                session_trigger_messages: Math.min(500, Math.max(20, parseInt(cfgVal('consolidation_session_trigger_messages'), 10) || 80)),
                compression_ratio: Math.min(0.5, Math.max(0.05, parseFloat(cfgVal('consolidation_compression_ratio')) || 0.15)),
                history_log_path: (cfgField('consolidation_history_log_path')?.value || 'history_log.md').trim()
            },
        },
        timezone: (cfgField('config_timezone')?.value || '').trim(),

        updates: {
            addons: {
                check_interval: cfgField('updates_addons_check_interval')?.value || 'never',
                auto_update: !!(cfgField('updates_addons_auto_update') as HTMLInputElement | null)?.checked,
            }
        },

        ui: { language }
    };

    try {
        const resp = await apiCall('/api/config', { method: 'POST', body: config });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
        showToast((t('config.save_error')) + ' ' + (errMsg(err)), 'error');
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

    const badge = cfgField('header-log-mode-badge');
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
        refreshUiLanguageSelect(config.ui.language);
    } catch (err) {}

    // Also save native App tab config if running in the Hyve Android app
    if (typeof window.saveAppConfig === 'function') {
        try { window.saveAppConfig(); } catch (_) {}
    }

    // Save notification preferences if on the notifications tab
    const notifTab = cfgField('cfg-tab-notifications');
    if (notifTab && !notifTab.classList.contains('hidden')) {
        try { await saveNotificationSettings({ silent: true }); } catch (_) {}
    }

    if (!silent) showToast(t('config.save_success'), 'success');
    } catch (err) {
        console.error('saveConfig failed', err);
        showToast((t('config.save_error')) + ' ' + errMsg(err), 'error');
    } finally {
        restoreBtn();
    }
}
