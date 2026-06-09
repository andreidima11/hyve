// @ts-nocheck — tighten types in a follow-up pass.
/**
 * Session history loader and notification bubble helper.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { buildSourcesHtml, refreshSourceFavicons } from '../utils.js';
import { playNotificationCue } from './notification.js';
import { appendConsciousnessFeedbackBar, appendMessage, buildForgePreviewHtml, decorateCodeBlocks, decorateImages, } from './render.js';
import { showChatEmptyState } from './empty_state.js';
import { scrollChatToBottom } from './scroll.js';
import { setCurrentSessionId, setSessionDisplay } from './session_state.js';
import { buildAgentTimelineHtml } from './timeline.js';
// Încarcă istoricul unei sesiuni existente în UI
export async function loadSessionHistory(sessionId) {
    if (!sessionId)
        return;
    try {
        const res = await apiCall(`/api/sessions/${sessionId}`);
        if (!res.ok)
            return;
        const data = await res.json();
        const container = document.getElementById('chat-container');
        if (!container)
            return;
        container.innerHTML = '';
        const messages = data.messages || [];
        if (messages.length === 0) {
            showChatEmptyState();
        }
        else {
            // Extract thinking content from an assistant message
            function _extractThinking(s) {
                if (!s)
                    return "";
                const parts = [];
                const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
                let m;
                while ((m = re.exec(s)) !== null)
                    parts.push(m[1].trim());
                return parts.join("\n\n");
            }
            // Strip <think>/<thinking> blocks from saved assistant messages
            function _stripThinkTags(s) {
                if (!s)
                    return s || "";
                return s
                    .replace(/<think>[\s\S]*?<\/think>/gi, "")
                    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
                    .replace(/\s*<\/?think>\s*/gi, " ")
                    .replace(/\s*<\/?thinking>\s*/gi, " ")
                    .replace(/\s{3,}/g, " ")
                    .trim();
            }
            // Group messages into conversation turns: each user message starts a new turn
            // followed by 0+ assistant/tool messages that form the AI response.
            // Legacy notification messages are intentionally skipped; notifications
            // now live in User > Notificări, not in chat history.
            const turns = [];
            for (const m of messages) {
                if (m.notification) {
                    continue;
                }
                else if (m.role === 'user') {
                    turns.push({ user: m, chain: [] });
                }
                else if (turns.length > 0 && turns[turns.length - 1].user) {
                    turns[turns.length - 1].chain.push(m);
                }
            }
            for (const turn of turns) {
                // Render standalone notification bubble
                if (turn.notification) {
                    const nid = turn.notification.notification_id;
                    if (nid)
                        _shownNotificationIds.add(nid); // prevent WS re-showing
                    const isAuto = !!turn.notification.automation;
                    const bubbleCls = isAuto ? 'chat-bubble-automation' : 'chat-bubble-reminder';
                    const notifDiv = document.createElement('div');
                    notifDiv.className = 'chat-row chat-row-ai animate-up';
                    notifDiv.innerHTML = `
                        <div class="chat-msg chat-msg-ai group">
                            <div class="chat-bubble ai-bubble ${bubbleCls}">
                                <div class="chat-bubble-glow"></div>
                                <div class="chat-bubble-content prose prose-invert prose-sm">
                                    ${DOMPurify.sanitize(marked.parse(turn.notification.content || ''))}
                                </div>
                            </div>
                        </div>`;
                    container.appendChild(notifDiv);
                    decorateCodeBlocks(notifDiv);
                    decorateImages(notifDiv);
                    continue;
                }
                // Render user message
                // For history, get the profile name from the next AI response
                const aiProfileName = turn.chain.reduce((name, m) => m.model_name || name, '');
                appendMessage('user', turn.user.content || '', { profileName: aiProfileName, timestamp: turn.user.timestamp || data.created_at });
                // Collect thinking, tool steps, and final content from the AI chain
                let allThinking = "";
                const toolSteps = [];
                let finalContent = "";
                let finalAssistantColor = null;
                let persistedSources = [];
                let persistedModelName = "";
                let persistedModelId = "";
                let persistedResponseStats = null;
                let persistedForgePreview = "";
                let persistedForgePreviewLanguage = "python";
                for (const m of turn.chain) {
                    if (m.role === 'assistant') {
                        if (m.profile_color)
                            finalAssistantColor = m.profile_color;
                        if (m.model_name)
                            persistedModelName = m.model_name;
                        if (m.model_id)
                            persistedModelId = m.model_id;
                        if (m.response_stats)
                            persistedResponseStats = m.response_stats;
                        if (Array.isArray(m.search_sources) && m.search_sources.length > 0) {
                            persistedSources = m.search_sources;
                        }
                        if (m.forge_preview) {
                            persistedForgePreview = m.forge_preview;
                            persistedForgePreviewLanguage = m.forge_preview_language || 'python';
                        }
                        // Prefer explicit thinking field saved by backend
                        if (m.thinking) {
                            allThinking += (allThinking ? "\n\n" : "") + m.thinking;
                        }
                        else {
                            const thinking = _extractThinking(m.content || "");
                            if (thinking)
                                allThinking += (allThinking ? "\n\n" : "") + thinking;
                        }
                        if (m.tool_calls && m.tool_calls.length > 0) {
                            // This is an intermediate assistant message that called tools
                            for (const tc of m.tool_calls) {
                                const fnName = (tc.function && tc.function.name) || "";
                                // Clean corrupted tool names (same as backend sanitizer)
                                const cleanName = (fnName.match(/^[a-zA-Z_]+/) || [""])[0];
                                if (cleanName) {
                                    toolSteps.push({
                                        type: cleanName,
                                        label: cleanName.replace(/_/g, ' ')
                                    });
                                }
                            }
                        }
                        else {
                            // Final assistant message (no tool_calls) — this is the response
                            finalContent = _stripThinkTags(m.content || "");
                        }
                    }
                    // 'tool' role messages are results — we don't display them
                }
                if (!finalContent && !toolSteps.length && !allThinking)
                    continue;
                // Build rich AI bubble with a unified, collapsible activity timeline
                // (thinking + tool steps integrated together).
                const thinkingDurationSec = (persistedResponseStats && persistedResponseStats.thinkingTime > 0)
                    ? (persistedResponseStats.thinkingTime / 1000).toFixed(1)
                    : null;
                const thinkingHtml = "";
                const stepsCount = toolSteps.length;
                const agentActivityHtml = "";
                const stepsHtml = buildAgentTimelineHtml({
                    statusLines: toolSteps,
                    thinkingStarted: !!allThinking,
                    thinkingContent: allThinking || "",
                    thinkingDurationSec,
                    generating: false,
                    preparing: false,
                    streaming: false,
                });
                const contentHtml = finalContent
                    ? `<div class="chat-bubble-content prose prose-invert prose-sm">${DOMPurify.sanitize(marked.parse(finalContent))}</div>`
                    : '<div class="chat-bubble-content"></div>';
                const forgePreviewHtml = persistedForgePreview
                    ? buildForgePreviewHtml(persistedForgePreview, persistedForgePreviewLanguage, false)
                    : '';
                const sourcesHtml = buildSourcesHtml(persistedSources);
                const div = document.createElement('div');
                div.className = 'chat-row chat-row-ai animate-up';
                div.innerHTML = `
                    <div class="chat-msg chat-msg-ai group">
                        <div class="chat-bubble ai-bubble">
                            <div class="chat-bubble-part chat-bubble-agent">${agentActivityHtml}</div>
                            <div class="chat-bubble-part chat-bubble-steps">${stepsHtml}</div>
                            <div class="chat-bubble-part chat-bubble-thinking">${thinkingHtml}</div>
                            <div class="chat-bubble-part chat-bubble-preview">${forgePreviewHtml}</div>
                            <div class="chat-bubble-part chat-bubble-main">${contentHtml}</div>
                            <div class="chat-bubble-part chat-bubble-cards">${sourcesHtml}</div>
                        </div>
                    </div>`;
                container.appendChild(div);
                // Apply saved profile color (glow + avatar) so it persists after refresh
                const bubble = div.querySelector('.ai-bubble');
                if (bubble && finalAssistantColor) {
                    const c = finalAssistantColor.trim();
                    div.style.setProperty('--bubble-glow-color', c);
                    bubble.style.setProperty('--bubble-glow-color', c);
                }
                if (bubble) {
                    const thinkingBlock = bubble.querySelector(".chat-thinking-block");
                    const thinkingToggle = bubble.querySelector(".chat-thinking-toggle");
                    if (thinkingBlock && thinkingToggle) {
                        thinkingToggle.addEventListener("click", () => {
                            const open = thinkingBlock.classList.toggle("chat-thinking-open");
                            thinkingToggle.setAttribute("aria-expanded", open);
                            if (open) {
                                const contentBox = thinkingBlock.querySelector(".chat-thinking-content");
                                if (contentBox)
                                    contentBox.scrollTop = contentBox.scrollHeight;
                            }
                        });
                    }
                    const timelineWrap = bubble.querySelector(".chat-agent-timeline-collapsible");
                    const timelineSummary = timelineWrap?.querySelector(".chat-agent-timeline-summary");
                    if (timelineWrap && timelineSummary && !timelineSummary.dataset.bound) {
                        timelineSummary.dataset.bound = "1";
                        timelineSummary.addEventListener("click", () => {
                            const open = timelineWrap.classList.toggle("chat-agent-timeline-open");
                            timelineSummary.setAttribute("aria-expanded", open ? "true" : "false");
                        });
                    }
                    decorateCodeBlocks(bubble);
                    decorateImages(bubble);
                    void refreshSourceFavicons(bubble);
                    // Add action bar for history-loaded messages with persisted stats
                    const historyStats = {};
                    if (persistedModelName)
                        historyStats.model = persistedModelName;
                    if (persistedModelId)
                        historyStats.modelId = persistedModelId;
                    if (toolSteps.length > 0)
                        historyStats.tools = toolSteps;
                    // Merge persisted response_stats (timing, tokens) from the saved session
                    if (persistedResponseStats) {
                        if (persistedResponseStats.elapsed)
                            historyStats.elapsed = persistedResponseStats.elapsed;
                        if (persistedResponseStats.thinkingTime)
                            historyStats.thinkingTime = persistedResponseStats.thinkingTime;
                        if (persistedResponseStats.generationTime)
                            historyStats.generationTime = persistedResponseStats.generationTime;
                        if (persistedResponseStats.completionTokens)
                            historyStats.completionTokens = persistedResponseStats.completionTokens;
                        if (persistedResponseStats.promptTokens)
                            historyStats.promptTokens = persistedResponseStats.promptTokens;
                        if (persistedResponseStats.totalTokens)
                            historyStats.totalTokens = persistedResponseStats.totalTokens;
                    }
                    appendConsciousnessFeedbackBar(bubble, null, Object.keys(historyStats).length > 0 ? historyStats : null);
                }
            }
        }
        setCurrentSessionId(data.id);
        setSessionDisplay(data.title || t('sessions.new_chat'));
        // Scroll la ultimul mesaj (de obicei răspunsul AI), nu la ultimul mesaj user
        scrollChatToBottom({ behavior: 'auto', force: true });
    }
    catch (e) {
        console.warn("Nu am putut încărca sesiunea", e);
    }
}
// Dedup tracking: notification IDs already shown via WS or session history load
const _shownNotificationIds = new Set();
/**
 * Append a notification/reminder/automation bubble to the current chat.
 * Used by both WS handler and Android bridge.
 * @param {string} message - The message content (markdown)
 * @param {string} type - 'reminder' or 'automation'
 */
function _showNotificationBubble(message, type) {
    if (!message)
        return;
    playNotificationCue();
    const role = (type === 'automation') ? 'automation' : 'reminder';
    appendMessage(role, message);
    scrollChatToBottom({ behavior: 'smooth', force: true });
}
