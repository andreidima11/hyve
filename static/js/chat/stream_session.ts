/**
 * Live chat stream session — SSE reader, bubble renderer, and finalization.
 */

import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, buildSourcesHtml, refreshSourceFavicons } from '../utils.js';
import { loadSessionsList } from '../nav_bridge.js';
import { isVoiceInputPending, setVoiceInputPending } from '../voice_state.js';
import {
    appendConsciousnessFeedbackBar,
    buildForgePreviewHtml,
    decorateCodeBlocks,
    decorateImages,
    enhanceForgePreview,
} from './render.js';
import { scrollChatToBottom } from './scroll.js';
import { currentSessionId, setSessionDisplay } from './session_state.js';
import {
    buildAgentTimelineHtml,
    buildPendingStateHtml,
    buildTimelineStructureKey,
} from './timeline.js';
import {
    contentAfterThink,
    splitThinkingFromReply,
    stripThinkFromContent,
} from './stream_thinking.js';
import { getTts, speakBubble } from './tts.js';
import type {
    ChatStreamSessionOpts,
    ForgePreviewState,
    ProposalCard,
    ShellCard,
    SseQueueItem,
    StreamMetrics,
} from '../types/chat.js';

type PendingPhase = 'vision' | 'preparing' | 'thinking' | 'generating' | 'done';

interface StatusLineEntry {
    type: string;
    label: string;
}

export async function runChatStreamSession(opts: ChatStreamSessionOpts, response: Response) {
    const {
        aiBubbleId,
        newSessionId,
        hasImage,
        applyBubbleGlow,
        onResendMessage,
    } = opts;

    let fullText = "";
    let sseBuffer = "";
    const statusLines: StatusLineEntry[] = [];
    let streamMetrics: StreamMetrics = { completion_tokens: null, prompt_tokens: null, total_tokens: null };
    let thinkingContent = "";
    let finalMessageContent: string | null = null;
    let finalModelName = "";
    let finalModelId = "";
    let thinkingStartTime: number | null = null;
    let pendingPhase: PendingPhase = hasImage ? 'vision' : 'preparing';
    let pendingPhaseLabel = hasImage ? 'Analizez imaginea' : 'Se gândește';
    const responseStartTime = Date.now();
    let firstChunkTime: number | null = null;
    const shellCards: ShellCard[] = [];
    const searchSources: unknown[] = [];
    const bubbleMaybe = document.getElementById(aiBubbleId);
    if (!bubbleMaybe) {
        throw new Error(`Chat bubble #${aiBubbleId} not found`);
    }
    const streamBubble: HTMLElement = bubbleMaybe;
    if (!response.body) {
        throw new Error('Chat response has no body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let isStreaming = true;
    let scheduledRenderRAF = 0;
    let chunkThrottleTimer = 0;
    let lastChunkRenderTime = 0;
    const CHUNK_RENDER_THROTTLE_MS = 72;

    const proposalCards: ProposalCard[] = [];
    const forgePreview: ForgePreviewState = { content: '', language: 'python', done: false };

    // Streaming TTS: accumulate text and push complete sentences
    let _ttsAccum = '';
    getTts().streamReset(streamBubble);
    function scheduleRender() {
        if (scheduledRenderRAF) return;
        scheduledRenderRAF = requestAnimationFrame(() => {
            scheduledRenderRAF = 0;
            renderBubble(isStreaming);
        });
    }
    function scheduleRenderThrottled() {
        const now = Date.now();
        if (now - lastChunkRenderTime >= CHUNK_RENDER_THROTTLE_MS) {
            lastChunkRenderTime = now;
            scheduleRender();
        } else if (!chunkThrottleTimer) {
            const delay = CHUNK_RENDER_THROTTLE_MS - (now - lastChunkRenderTime);
            chunkThrottleTimer = setTimeout(() => {
                chunkThrottleTimer = 0;
                lastChunkRenderTime = Date.now();
                if (scheduledRenderRAF) cancelAnimationFrame(scheduledRenderRAF);
                scheduledRenderRAF = 0;
                renderBubble(isStreaming);
            }, Math.max(16, delay));
        }
    }

    function attachBubbleListeners(root: HTMLElement) {
        const thinkingBlock = root.querySelector(".chat-thinking-block");
        const thinkingToggle = root.querySelector(".chat-thinking-toggle");
        if (thinkingBlock && thinkingToggle) {
            thinkingToggle.addEventListener("click", () => {
                const open = thinkingBlock.classList.toggle("chat-thinking-open");
                thinkingToggle.setAttribute("aria-expanded", open ? 'true' : 'false');
                if (open) {
                    const contentBox = thinkingBlock.querySelector(".chat-thinking-content");
                    if (contentBox) contentBox.scrollTop = contentBox.scrollHeight;
                }
            });
        }
        const timelineWrap = root.querySelector(".chat-agent-timeline-collapsible");
        const timelineSummary = timelineWrap?.querySelector(".chat-agent-timeline-summary") as HTMLElement | null;
        if (timelineWrap && timelineSummary && !timelineSummary.dataset.bound) {
            timelineSummary.dataset.bound = "1";
            timelineSummary.addEventListener("click", () => {
                const open = timelineWrap.classList.toggle("chat-agent-timeline-open");
                timelineSummary.setAttribute("aria-expanded", open ? "true" : "false");
            });
        }
        root.querySelectorAll(".chat-shell-allow-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                try {
                    const res = await fetch("/api/shell/allow", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("hyve_token") || ""}` } });
                    if (res.ok) {
                        (btn as HTMLButtonElement).textContent = t("chat.shell_allowed") || "Permisiune acordată";
                        (btn as HTMLButtonElement).disabled = true;
                        onResendMessage("da");
                    }
                } catch (e) { console.warn("Shell allow failed", e); }
            });
        });
        root.querySelectorAll(".chat-shell-run-btn").forEach(btn => {
            const card = btn.closest(".chat-shell-suggest");
            if (!card) return;
            btn.addEventListener("click", async () => {
                const command = card.getAttribute("data-command") || "";
                if (!command) return;
                (btn as HTMLButtonElement).disabled = true;
                try {
                    const res = await fetch("/api/shell/run", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("hyve_token") || ""}` },
                        body: JSON.stringify({ command })
                    });
                    const data = await res.json().catch(() => ({})) as { result?: string; error?: string };
                    if (res.ok && data.result) {
                        const idx = shellCards.findIndex(c => 'suggest' in c && c.command === command);
                        if (idx !== -1) {
                            const exitCode = (data.result.match(/Exit code:\s*(-?\d+)/) || [])[1];
                            const outputMatch = data.result.match(/(?:Output|Stdout):\s*([\s\S]*)/);
                            shellCards[idx] = { command, exit_code: parseInt(exitCode || '0', 10) || 0, output_preview: (outputMatch && outputMatch[1]) ? outputMatch[1].trim() : data.result };
                            renderBubble(isStreaming);
                        }
                    } else {
                        shellCards.push({ command, exit_code: 1, output_preview: data.error || "Error" });
                        renderBubble(isStreaming);
                    }
                } catch (e) {
                    shellCards.push({ command, exit_code: 1, output_preview: (e instanceof Error ? e.message : 'Error') });
                    renderBubble(isStreaming);
                }
            });
        });
        root.querySelectorAll(".chat-shell-cancel-btn").forEach(btn => {
            const card = btn.closest(".chat-shell-suggest");
            if (!card) return;
            btn.addEventListener("click", () => {
                const command = card.getAttribute("data-command") || "";
                const idx = shellCards.findIndex(c => 'suggest' in c && c.command === command);
                if (idx !== -1) shellCards.splice(idx, 1);
                renderBubble(isStreaming);
            });
        });
        root.querySelectorAll('.chat-forge-preview-copy').forEach(btn => {
            btn.addEventListener('click', () => {
                const pre = btn.closest('.chat-forge-preview')?.querySelector('pre');
                const text = pre?.textContent || '';
                navigator.clipboard.writeText(text).then(() => {
                    (btn as HTMLButtonElement).textContent = t('chat.copied');
                    btn.classList.add('copied');
                    setTimeout(() => {
                        (btn as HTMLButtonElement).textContent = t('common.copy');
                        btn.classList.remove('copied');
                    }, 2000);
                }).catch(() => {});
            });
        });
        root.querySelectorAll('.chat-forge-preview-select').forEach(btn => {
            btn.addEventListener('click', () => {
                const pre = btn.closest('.chat-forge-preview')?.querySelector('pre');
                if (!pre) return;
                const range = document.createRange();
                range.selectNodeContents(pre);
                const sel = window.getSelection();
                if (!sel) return;
                sel.removeAllRanges();
                sel.addRange(range);
            });
        });
        root.querySelectorAll(".chat-proposal-apply-btn").forEach(btn => {
            const card = btn.closest(".chat-proposal-card");
            if (!card) return;
            btn.addEventListener("click", async () => {
                const raw = card.getAttribute("data-proposal");
                if (!raw) return;
                try {
                    const proposal = JSON.parse(raw.replace(/&quot;/g, '"')) as ProposalCard;
                    const res = await fetch("/api/proposal/apply", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("hyve_token") || ""}` }, body: JSON.stringify(proposal) });
                    const data = await res.json().catch(() => ({})) as { detail?: string; error?: string };
                    if (res.ok) { (btn as HTMLButtonElement).textContent = t("chat.proposal_applied") || "Aplicat"; (btn as HTMLButtonElement).disabled = true; card.querySelector(".chat-proposal-refuse-btn")?.remove(); }
                    else { showToast(data.detail || data.error || "Error", 'error'); }
                } catch (e) { showToast(e instanceof Error ? e.message : "Error", 'error'); }
            });
        });
        root.querySelectorAll(".chat-proposal-refuse-btn").forEach(btn => {
            const card = btn.closest(".chat-proposal-card");
            if (!card) return;
            btn.addEventListener("click", () => {
                const idx = parseInt(card.getAttribute("data-proposal-index") || '', 10);
                if (!Number.isNaN(idx) && idx >= 0 && idx < proposalCards.length) proposalCards.splice(idx, 1);
                renderBubble(isStreaming);
            });
        });
        decorateCodeBlocks(root);
        enhanceForgePreview(root, !!root.querySelector('.chat-forge-preview')?.classList.contains('chat-forge-preview-streaming'));
        decorateImages(root);
        void refreshSourceFavicons(root as unknown as Document);
    }

    function renderBubble(streaming: boolean) {
        const showFinalStructure = !streaming;
        const hasThinking = thinkingContent.length > 0;
        let displayContent;
        if (streaming && (hasThinking || /<think>|<thinking>/i.test(fullText))) {
            const afterThink = contentAfterThink(fullText);
            // If thinking is streamed separately, fullText may not contain think tags.
            // In that case, keep streaming normal content instead of hiding it.
            displayContent = afterThink ? stripThinkFromContent(afterThink) : stripThinkFromContent(fullText);
        } else {
            displayContent = stripThinkFromContent(fullText);
        }
        const thinkingDurationSec: number | null = (thinkingStartTime && (firstChunkTime || !streaming))
            ? Number((((firstChunkTime || Date.now()) - thinkingStartTime) / 1000).toFixed(1))
            : null;
        let displayThinking = showFinalStructure ? thinkingContent : "";
        if (showFinalStructure && !displayThinking && fullText) {
            const split = splitThinkingFromReply(fullText);
            if (split) {
                displayThinking = split.thinking;
                displayContent = stripThinkFromContent(split.reply);
            }
        }
        if (!displayContent && showFinalStructure) {
            const thinkFallback = (displayThinking || thinkingContent || '').trim();
            if (thinkFallback) {
                displayContent = stripThinkFromContent(thinkFallback);
            }
        }

        const thinkingWasOpen = !!streamBubble.querySelector(".chat-thinking-block.chat-thinking-open");
        const stepsCount = statusLines.length;
        // Thinking is now integrated into the unified timeline (no separate dropdown).
        const thinkingHtml = "";
        const agentActivityHtml = "";
        const thinkingStartedForTimeline = !!thinkingStartTime || hasThinking || !!thinkingContent;
        const timelineThinkingContent = displayThinking || thinkingContent || "";
        const stepsHtml = buildAgentTimelineHtml({
            statusLines,
            thinkingStarted: thinkingStartedForTimeline,
            thinkingContent: timelineThinkingContent,
            thinkingDurationSec,
            generating: streaming && (pendingPhase === 'generating' || !!firstChunkTime),
            preparing: streaming && (pendingPhase === 'preparing' || pendingPhase === 'vision'),
            streaming,
        });
        const timelineStructureKey = buildTimelineStructureKey({
            statusLines,
            thinkingStarted: thinkingStartedForTimeline,
            thinkingDurationSec,
            generating: streaming && (pendingPhase === 'generating' || !!firstChunkTime),
            preparing: streaming && (pendingPhase === 'preparing' || pendingPhase === 'vision'),
            streaming,
            hasThinkingContent: !!timelineThinkingContent.trim(),
        });

        const forgePreviewHtml = forgePreview.content
            ? buildForgePreviewHtml(forgePreview.content, forgePreview.language || 'python', streaming && !forgePreview.done)
            : '';

        const streamCursor = streaming ? '<span class="chat-stream-cursor" aria-hidden="true"></span>' : '';
        const pendingLabel = pendingPhaseLabel || (pendingPhase === 'vision'
            ? 'Analizez imaginea'
            : pendingPhase === 'generating'
                ? 'Generez răspunsul'
                : 'Se gândește');
        const pendingIcon = pendingPhase === 'vision' ? 'fa-image' : '';
        // The unified timeline already shows a "Se gândește"/activity step, so only
        // fall back to the inline pending state while streaming (never "Gata" at end).
        const showPendingState = streaming && !displayContent && !thinkingHtml && !stepsHtml;
        const contentHtml = displayContent
            ? (() => {
                // During streaming: hide incomplete markdown images, show placeholder for complete ones
                let renderContent = displayContent;
                if (streaming) {
                    // Replace complete ![alt](url) with a loading placeholder card
                    const imgLoadingLabel = t("chat.image_loading") || "Se încarcă imaginea...";
                    renderContent = renderContent.replace(
                        /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
                        (_m, _alt, _url) => `\n\n<div class="chat-image-placeholder"><i class="fas fa-image"></i> ${imgLoadingLabel}</div>\n\n`
                    );
                    // Hide incomplete image markdown that's still being streamed (e.g. "![alt text" or "![alt](partial...")
                    renderContent = renderContent.replace(/!\[[^\]]*(?:\](?:\([^)]*)?)?$/g, '');
                }
                const backticks = (renderContent.match(/```/g) || []).length;
                if (backticks % 2 === 1) {
                    const lastOpen = renderContent.lastIndexOf("```");
                    const after = renderContent.slice(lastOpen);
                    const nl = after.indexOf("\n");
                    const streamCode = nl >= 0 ? after.slice(nl + 1) : "";
                    const firstLine = nl >= 0 ? after.slice(0, nl) : after;
                    const lang = (firstLine.replace(/^`+/, "").trim() || t("chat.code_label") || "code").slice(0, 20);
                    const before = renderContent.slice(0, lastOpen);
                    let markedPart = '';
                    try {
                        markedPart = DOMPurify.sanitize(marked?.parse(before) || before);
                    } catch (_e) {
                        markedPart = escapeHtml(before);
                    }
                    const streamBlock = `<div class="chat-code-block chat-code-streaming"><div class="chat-code-header"><span class="chat-code-lang">${escapeHtml(lang)}</span></div><pre><code>${escapeHtml(streamCode)}</code></pre></div>`;
                    return `<div class="chat-bubble-content prose prose-invert prose-sm">${markedPart}${streamBlock}${streamCursor}</div>`;
                }
                let parsedHtml = '';
                try {
                    parsedHtml = DOMPurify.sanitize(marked?.parse(renderContent) || renderContent);
                } catch (_e) {
                    parsedHtml = escapeHtml(renderContent).replace(/\n/g, '<br>');
                }
                return `<div class="chat-bubble-content prose prose-invert prose-sm">${parsedHtml}${streamCursor}</div>`;
            })()
            : showPendingState
                ? `<div class="chat-bubble-content">${buildPendingStateHtml(pendingLabel, pendingIcon)}</div>`
                : `<div class="chat-bubble-content"></div>`;
        const shellCardsHtml = shellCards.map(c => {
            if ('suggest' in c && c.suggest) {
                return `<div class="chat-shell-card chat-shell-suggest" data-command="${escapeHtml(c.command || '').replace(/"/g, '&quot;')}">
                    <div class="chat-shell-card-header"><i class="fas fa-lightbulb"></i> <span>${escapeHtml(t('chat.shell_suggest_title') || 'Comandă sugerată')}</span></div>
                    ${c.reason ? `<p class="chat-shell-reason text-slate-400 text-xs">${escapeHtml(c.reason)}</p>` : ''}
                    <pre class="chat-shell-command">${escapeHtml(c.command || '')}</pre>
                    <div class="chat-shell-actions">
                        <button type="button" class="chat-shell-run-btn">${escapeHtml(t('chat.shell_run') || 'Rulează')}</button>
                        <button type="button" class="chat-shell-cancel-btn text-slate-400">${escapeHtml(t('common.cancel') || 'Anulează')}</button>
                    </div>
                </div>`;
            }
            if ('requested_but_denied' in c && c.requested_but_denied) {
                return `<div class="chat-shell-card chat-shell-request" data-command="${escapeHtml(c.command || '').replace(/"/g, '&quot;')}">
                    <div class="chat-shell-card-header"><i class="fas fa-terminal"></i> <span>${escapeHtml(t('chat.shell_request_title') || 'AI vrea să ruleze o comandă')}</span></div>
                    <pre class="chat-shell-command">${escapeHtml(c.command || '')}</pre>
                    <div class="chat-shell-actions">
                        <button type="button" class="chat-shell-allow-btn">${escapeHtml(t('chat.shell_allow') || 'Permite')}</button>
                        <span class="chat-shell-hint">${escapeHtml(t('chat.shell_allow_hint') || 'Apasă Permite apoi trimite "da" pentru a rula.')}</span>
                    </div>
                </div>`;
            }
            const exitOk = 'exit_code' in c && c.exit_code === 0;
            return `<div class="chat-shell-card chat-shell-done">
                <div class="chat-shell-card-header"><i class="fas fa-check-circle ${exitOk ? 'text-emerald-400' : 'text-amber-400'}"></i> <span>${escapeHtml(t('chat.shell_done_title') || 'Comandă rulată')}</span> <span class="chat-shell-exit">exit ${'exit_code' in c ? c.exit_code : '?'}</span></div>
                <pre class="chat-shell-command">${escapeHtml(c.command || '')}</pre>
                <details class="chat-shell-output"><summary>${escapeHtml(t('chat.shell_output') || 'Output')}</summary><pre>${escapeHtml(('output_preview' in c ? c.output_preview : '') || '')}</pre></details>
            </div>`;
        }).join('');
        const proposalCardsHtml = proposalCards.map((p, idx) => {
            const isPatch = p.type === 'patch';
            const title = isPatch ? (t('chat.proposal_patch_title') || 'Modificare propusă') : (t('chat.proposal_file_title') || 'Fișier nou propus');
            const fullContent = isPatch ? (p.diff_preview || p.content || '') : (p.content || p.preview || '');
            return `<div class="chat-shell-card chat-proposal-card" data-proposal="${escapeHtml(JSON.stringify(p).replace(/"/g, '&quot;'))}" data-proposal-index="${idx}">
                <div class="chat-shell-card-header"><i class="fas fa-pencil"></i> <span>${escapeHtml(title)}</span> <span class="text-slate-500 text-xs">${escapeHtml(p.path || '')}</span></div>
                <pre class="chat-proposal-code">${escapeHtml(fullContent)}</pre>
                <div class="chat-shell-actions">
                    <button type="button" class="chat-proposal-apply-btn">${escapeHtml(t('chat.proposal_apply') || 'Aplică')}</button>
                    <button type="button" class="chat-proposal-refuse-btn text-slate-400">${escapeHtml(t('chat.proposal_refuse') || 'Refuz')}</button>
                </div>
            </div>`;
        }).join('');
        // Search sources cards (citation cards)
        const sourcesHtml = streaming ? '' : buildSourcesHtml(searchSources, '');
        const cardsHtml = (shellCardsHtml ? `<div class="chat-shell-cards">${shellCardsHtml}</div>` : "") + (proposalCardsHtml ? `<div class="chat-proposal-cards">${proposalCardsHtml}</div>` : "") + sourcesHtml;

        streamBubble.classList.remove("chat-bubble-typing");

        const existingThinkingBlock = streamBubble.querySelector(".chat-thinking-block");
        const streamBubbleAlreadyBuilt = !!streamBubble.querySelector(".chat-bubble-part.chat-bubble-main");
        const doPartialUpdate = streaming && (existingThinkingBlock || streamBubbleAlreadyBuilt);

        if (doPartialUpdate) {
            const agentPart = streamBubble.querySelector('.chat-bubble-part.chat-bubble-agent');
            const stepsPart = streamBubble.querySelector(".chat-bubble-part.chat-bubble-steps");
            const thinkingPart = streamBubble.querySelector(".chat-bubble-part.chat-bubble-thinking");
            const previewPart = streamBubble.querySelector(".chat-bubble-part.chat-bubble-preview");
            const mainPart = streamBubble.querySelector(".chat-bubble-part.chat-bubble-main");
            const cardsPart = streamBubble.querySelector(".chat-bubble-part.chat-bubble-cards");
            if (agentPart) agentPart.innerHTML = agentActivityHtml;
            // Rewrite timeline only when step structure changes; reasoning text
            // is patched incrementally so spinners don't restart every token.
            if (stepsPart) {
                const stepsEl = stepsPart as HTMLElement;
                if (stepsEl.dataset.timelineStructure !== timelineStructureKey) {
                    stepsPart.innerHTML = stepsHtml;
                    stepsEl.dataset.timelineStructure = timelineStructureKey;
                } else if (timelineThinkingContent) {
                    const streamEl = stepsPart.querySelector('.chat-agent-timeline__detail-stream');
                    if (streamEl) {
                        streamEl.innerHTML = escapeHtml(timelineThinkingContent).replace(/\n/g, '<br>');
                        const detailBox = streamEl.closest('.chat-agent-timeline__detail');
                        if (detailBox) detailBox.scrollTop = detailBox.scrollHeight;
                    }
                }
            }
            if (thinkingPart) thinkingPart.innerHTML = thinkingHtml;
            if (previewPart) previewPart.innerHTML = forgePreviewHtml;
            if (mainPart) mainPart.innerHTML = contentHtml;
            if (cardsPart) cardsPart.innerHTML = cardsHtml;
            attachBubbleListeners(streamBubble);
            if (thinkingWasOpen) {
                const thinkingContentBox = streamBubble.querySelector(".chat-thinking-block.chat-thinking-open .chat-thinking-content");
                if (thinkingContentBox) thinkingContentBox.scrollTop = thinkingContentBox.scrollHeight;
            }
        } else {
            streamBubble.innerHTML =
                '<div class="chat-bubble-part chat-bubble-agent">' + agentActivityHtml + '</div>' +
                '<div class="chat-bubble-part chat-bubble-steps">' + stepsHtml + '</div>' +
                '<div class="chat-bubble-part chat-bubble-thinking">' + thinkingHtml + '</div>' +
                '<div class="chat-bubble-part chat-bubble-preview">' + forgePreviewHtml + '</div>' +
                '<div class="chat-bubble-part chat-bubble-main">' + contentHtml + '</div>' +
                '<div class="chat-bubble-part chat-bubble-cards">' + cardsHtml + '</div>';
            const stepsPartInit = streamBubble.querySelector(".chat-bubble-part.chat-bubble-steps") as HTMLElement | null;
            if (stepsPartInit) stepsPartInit.dataset.timelineStructure = timelineStructureKey;
            attachBubbleListeners(streamBubble);
            if (thinkingWasOpen) {
                const thinkingContentBox = streamBubble.querySelector(".chat-thinking-block.chat-thinking-open .chat-thinking-content");
                if (thinkingContentBox) thinkingContentBox.scrollTop = thinkingContentBox.scrollHeight;
            }
        }

        scrollChatToBottom({ behavior: 'auto' });
    }

    function processOneSSEEvent(eventType: string, data: string) {
        if (!data && eventType !== 'clear_content') return;
        if (eventType === "thinking") {
            try {
                const p = JSON.parse(data);
                if (!thinkingStartTime) thinkingStartTime = Date.now();
                pendingPhase = 'thinking';
                pendingPhaseLabel = 'Se gândește';
                thinkingContent += p.content || "";
                const streamEl = streamBubble.querySelector(".chat-agent-timeline__detail-stream")
                    || streamBubble.querySelector(".chat-thinking-stream");
                if (streamEl) {
                    streamEl.innerHTML = escapeHtml(thinkingContent).replace(/\n/g, "<br>");
                    const detailBox = streamEl.closest(".chat-agent-timeline__detail, .chat-thinking-content");
                    if (detailBox) detailBox.scrollTop = detailBox.scrollHeight;
                } else {
                    scheduleRender();
                }
            } catch (e) { /* ignore */ }
        } else if (eventType === "status") {
            try {
                const p = JSON.parse(data);
                const label = p.labelKey ? t(p.labelKey, p.params || {}) : (p.label || "");
                statusLines.push({ type: p.type || "", label });
                if (!firstChunkTime && label) {
                    pendingPhase = (p.type === 'search_web_images' || p.type === 'cctv_describe') ? 'vision' : 'thinking';
                    pendingPhaseLabel = label;
                }
            } catch (e) { /* ignore */ }
            scheduleRender();
        } else if (eventType === "forge_preview") {
            try {
                const p = JSON.parse(data);
                forgePreview.content = p.content || '';
                forgePreview.language = p.language || 'python';
                forgePreview.done = !!p.done;
            } catch (e) { /* ignore */ }
            scheduleRenderThrottled();
        } else if (eventType === "clear_content") {
            fullText = "";
            scheduleRender();
        } else if (eventType === "chunk") {
            try {
                const chunkText = JSON.parse(data);
                if (typeof chunkText !== 'string') return;
                fullText += chunkText;
                if (!firstChunkTime) firstChunkTime = Date.now();
                pendingPhase = 'generating';
                pendingPhaseLabel = 'Generez răspunsul';
                // Streaming TTS: accumulate text, push large chunks
                _ttsAccum += chunkText;
                // Find the last sentence-ending punctuation in the buffer
                const lastPunct = Math.max(
                    _ttsAccum.lastIndexOf('.'),
                    _ttsAccum.lastIndexOf('!'),
                    _ttsAccum.lastIndexOf('?'),
                    _ttsAccum.lastIndexOf('\n')
                );
                // Only push when we have a complete sentence AND enough text
                if (lastPunct >= 0) {
                    const ready = _ttsAccum.slice(0, lastPunct + 1).trim();
                    // Wait until we have a substantial chunk for natural speech
                    if (ready.length > 80) {
                        _ttsAccum = _ttsAccum.slice(lastPunct + 1);
                        getTts().streamPush(ready);
                    }
                }
            } catch (e) { /* ignore */ }
            scheduleRenderThrottled();
        } else if (eventType === "shell_request") {
            try {
                const p = JSON.parse(data);
                shellCards.push({ requested_but_denied: true, command: p.command || '' });
            } catch (e) { /* ignore */ }
            scheduleRender();
        } else if (eventType === "shell_done") {
            try {
                const p = JSON.parse(data);
                shellCards.push({ command: p.command || '', exit_code: p.exit_code, output_preview: p.output_preview || '' });
            } catch (e) { /* ignore */ }
            scheduleRender();
        } else if (eventType === "shell_suggest") {
            try {
                const p = JSON.parse(data);
                shellCards.push({ suggest: true, command: p.command || '', reason: p.reason || '' });
            } catch (e) { /* ignore */ }
            scheduleRender();
        } else if (eventType === "proposal") {
            try {
                const p = JSON.parse(data);
                proposalCards.push(p);
            } catch (e) { /* ignore */ }
            scheduleRender();
        } else if (eventType === "search_sources") {
            try {
                const p = JSON.parse(data);
                if (Array.isArray(p.sources)) {
                    for (const src of p.sources) searchSources.push(src);
                }
            } catch (e) { /* ignore */ }
            // Avoid re-rendering the whole root mid-stream just because
            // sources arrived; this caused visible "blinking" near the end
            // of streaming due to repeated autoscroll/layout changes.
        } else if (eventType === "metrics") {
            try {
                const p = JSON.parse(data);
                streamMetrics = {
                    completion_tokens: Number.isFinite(Number(p.completion_tokens)) ? Number(p.completion_tokens) : null,
                    prompt_tokens: Number.isFinite(Number(p.prompt_tokens)) ? Number(p.prompt_tokens) : null,
                    total_tokens: Number.isFinite(Number(p.total_tokens)) ? Number(p.total_tokens) : null,
                };
            } catch (e) { /* ignore */ }
        } else if (eventType === "profile_color") {
            try {
                const p = JSON.parse(data);
                if (typeof applyBubbleGlow === 'function' && p.color) applyBubbleGlow(p.color);
            } catch (e) { /* ignore */ }
        } else if (eventType === "final_message") {
            try {
                const p = JSON.parse(data);
                const finalThinking = (p.thinking || "").trim();
                if (finalThinking) thinkingContent = finalThinking;
                if (p.content != null && String(p.content).length > 0) {
                    finalMessageContent = p.content;
                }
                if (p.model) finalModelName = p.model;
                if (p.model_id) finalModelId = p.model_id;
                if (!thinkingStartTime && thinkingContent) thinkingStartTime = Date.now() - 1000;
                // Final render is handled once at stream end in doFinalRender().
            } catch (e) { /* ignore */ }
        }
    }

    const sseEventQueue: SseQueueItem[] = [];
    function drainSSEQueue() {
        while (sseEventQueue.length > 0) {
            const item = sseEventQueue.shift();
            if (!item) break;
            processOneSSEEvent(item.eventType, item.data);
        }
    }
    function parseSSEEvents(chunk: string | undefined) {
        if (!chunk) return;
        sseBuffer += String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() || "";
        for (const block of events) {
            let eventType = "";
            const dataParts = [];
            for (const line of block.split("\n")) {
                if (line.startsWith("event:")) eventType = line.slice(6).trim();
                else if (line.startsWith("data:")) dataParts.push(line.slice(5).replace(/^\s/, ""));
            }
            const data = dataParts.join("\n");
            sseEventQueue.push({ eventType, data });
        }
        if (sseEventQueue.length > 0) drainSSEQueue();
    }

    renderBubble(true);

    while (true) {
        const { done, value } = await reader.read();
        if (value) {
            parseSSEEvents(decoder.decode(value, { stream: true }));
        }
        if (done) break;
    }
    parseSSEEvents(decoder.decode());
    if (sseBuffer.trim()) parseSSEEvents("\n\n");
    drainSSEQueue();
    // Flush remaining accumulated TTS text
    if (_ttsAccum.trim()) { getTts().streamPush(_ttsAccum.trim()); _ttsAccum = ''; }
    async function doFinalRender() {
        // Drain any remaining SSE events synchronously so nothing is lost
        drainSSEQueue();

        // Prefer final_message only when it carries visible text; an empty string
        // must not wipe chunks accumulated during the stream.
        if (typeof finalMessageContent === 'string' && finalMessageContent.length > 0) {
            fullText = finalMessageContent;
        } else if (!fullText && thinkingContent) {
            fullText = thinkingContent;
        }
        pendingPhase = 'done';
        pendingPhaseLabel = '';
        isStreaming = false;
        if (chunkThrottleTimer) { clearTimeout(chunkThrottleTimer); chunkThrottleTimer = 0; }
        if (scheduledRenderRAF) { cancelAnimationFrame(scheduledRenderRAF); scheduledRenderRAF = 0; }
        renderBubble(false);
        decorateCodeBlocks(streamBubble);
        decorateImages(streamBubble);

        const visibleText = (fullText || '').trim();
        const errPart = streamBubble.querySelector('.chat-bubble-main .chat-bubble-content')
            || streamBubble.querySelector('.chat-bubble-content');
        if (errPart) {
            if (/^Error:/i.test(visibleText)) {
                errPart.innerHTML = `<span class="chat-error"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(visibleText)}</span>`;
            } else if (!visibleText && !thinkingContent.trim() && !statusLines.length) {
                errPart.innerHTML = `<span class="chat-error"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(t('chat.error_empty_response') || 'Răspuns gol de la server.')}</span>`;
            }
        }

        const responseEndTime = Date.now();
        const totalElapsed = responseEndTime - responseStartTime;
        const thinkingElapsed = thinkingStartTime
            ? (firstChunkTime || responseEndTime) - thinkingStartTime
            : 0;
        const genElapsed = firstChunkTime
            ? responseEndTime - firstChunkTime
            : totalElapsed;
        const responseStats = {
            elapsed: totalElapsed,
            charCount: (fullText || '').length,
            thinkingTime: thinkingElapsed > 500 ? thinkingElapsed : 0,
            generationTime: genElapsed,
            completionTokens: streamMetrics.completion_tokens,
            promptTokens: streamMetrics.prompt_tokens,
            totalTokens: streamMetrics.total_tokens,
            model: finalModelName || '',
            modelId: finalModelId || '',
            tools: statusLines.slice()
        };
        appendConsciousnessFeedbackBar(streamBubble, aiBubbleId, responseStats);

        // Auto-speak response if triggered by voice input or always-speak
        const shouldAutoSpeak = isVoiceInputPending() || getTts().alwaysSpeak;
        if (isVoiceInputPending()) setVoiceInputPending(false);

        if (shouldAutoSpeak && !getTts().streamWasActive()) {
            speakBubble(streamBubble);
        }

        const activeSessionId = newSessionId || currentSessionId;
        if (activeSessionId) {
            try {
                await loadSessionsList?.();
                const res = await apiCall(`/api/sessions/${activeSessionId}`);
                if (res.ok) {
                    const data = await res.json();
                    setSessionDisplay(data.title || t('sessions.new_chat'));

                    document.querySelectorAll('.session-item').forEach(btn => {
                        if (btn.getAttribute('data-id') === activeSessionId) {
                            btn.classList.add('bg-white/10', 'text-accent');
                        } else {
                            btn.classList.remove('bg-white/10', 'text-accent');
                        }
                    });
                }
            } catch (e) {
                console.warn("Nu am putut actualiza sesiunea", e);
            }
        }
        // Persist response stats to session for future loads
        const statsSessionId = activeSessionId;
        if (statsSessionId) {
            try {
                await apiCall(`/api/sessions/${statsSessionId}/message-stats`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stats: responseStats }),
                });
            } catch (e) {
                console.warn("Nu am putut salva stats", e);
            }
        }
    }
    await doFinalRender();
}
