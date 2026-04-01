import { apiCall, authToken } from './api.js';
import { t } from './lang/index.js';
import { escapeHtml, showToast, toolIcon, buildSourcesHtml, formatMarkdown } from './utils.js';

const formatContent = formatMarkdown;

export function scrollToBottom(el) {
    if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
}

function renderConferenceUserBubble(message) {
    return `
        <div class="chat-msg chat-msg-user">
            <div class="chat-bubble user-bubble">
                <div class="conf-user-label"><i class="fas fa-user"></i>${t('common.you') || 'You'}</div>
                <div class="chat-bubble-content">${escapeHtml(message)}</div>
            </div>
        </div>
    `;
}

function renderConferenceMetaBadges({ toolSteps = [], searchSources = [], thinking = '' }) {
    const badges = [];
    if (toolSteps.length) badges.push(`<span class="conf-msg-badge"><i class="fas fa-screwdriver-wrench"></i>${toolSteps.length}</span>`);
    if (searchSources.length) badges.push(`<span class="conf-msg-badge"><i class="fas fa-link"></i>${searchSources.length}</span>`);
    if (thinking && thinking.trim()) badges.push(`<span class="conf-msg-badge"><i class="fas fa-brain"></i>${t('conference.thinking') || 'Thinking'}</span>`);
    return badges.length ? `<div class="conf-msg-meta">${badges.join('')}</div>` : '';
}

function syncConferenceMetaBadges(ph) {
    if (!ph?.el) return;
    const head = ph.el.querySelector('.conf-msg-head');
    if (!head) return;
    const existing = head.querySelector('.conf-msg-meta');
    if (existing) existing.remove();
    const html = renderConferenceMetaBadges(ph);
    if (html) head.insertAdjacentHTML('beforeend', html);
}

export function updateConferenceSendButton(streaming) {
    const sendBtn = document.getElementById('conf-send-btn');
    const stopBtn = document.getElementById('conf-stop-btn');
    if (streaming) {
        if (sendBtn) {
            sendBtn.classList.remove('hidden');
            const icon = sendBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-comment-medical';
            sendBtn.title = 'Send interjection';
        }
        if (stopBtn) stopBtn.classList.remove('hidden');
    } else {
        if (sendBtn) {
            sendBtn.classList.remove('hidden');
            const icon = sendBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-paper-plane';
            sendBtn.title = '';
        }
        if (stopBtn) stopBtn.classList.add('hidden');
    }
}

export async function checkConferenceVoiceButton() {
    try {
        const token = localStorage.getItem('memini_token');
        const res = await fetch('/api/config', { headers: { 'Authorization': 'Bearer ' + token } });
        if (res.ok) {
            const cfg = await res.json();
            const voiceBtn = document.getElementById('conf-voice-btn');
            if (voiceBtn) voiceBtn.classList.toggle('hidden', !(cfg.whisper && cfg.whisper.enabled));
        }
    } catch (e) { /* ignore */ }
}

export async function sendConferenceInterjection(activeConf) {
    const input = document.getElementById('conf-input');
    const msg = input ? input.value.trim() : '';
    if (!msg || !activeConf) return;

    input.value = '';
    input.style.height = 'auto';

    const msgContainer = document.getElementById('conf-messages');
    if (msgContainer) {
        const userRow = document.createElement('div');
        userRow.className = 'chat-row chat-row-user conf-msg animate-up';
        userRow.innerHTML = renderConferenceUserBubble(msg);
        msgContainer.appendChild(userRow);
        scrollToBottom(msgContainer);
    }

    try {
        const resp = await apiCall(`/api/conference/${activeConf.id}/interject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg }),
        });
        if (!resp.ok) {
            showToast('Interjection not delivered to server — displayed locally only', 'warning');
            if (msgContainer) {
                const lastRow = msgContainer.querySelector('.chat-row-user:last-of-type .user-bubble');
                if (lastRow) lastRow.style.opacity = '0.5';
            }
        }
    } catch (e) {
        showToast('Interjection failed to send — displayed locally only', 'warning');
        if (msgContainer) {
            const lastRow = msgContainer.querySelector('.chat-row-user:last-of-type .user-bubble');
            if (lastRow) lastRow.style.opacity = '0.5';
        }
    }
}

export async function streamConferenceMessage({
    optionalMsg,
    activeConf,
    streaming,
    setStreaming,
    setAbortController,
    personaMemoryCounts,
    onReloadConference,
}) {
    const input = document.getElementById('conf-input');
    const msg = optionalMsg || (input ? input.value.trim() : '');
    if (!msg || streaming || !activeConf) return;

    if (input && !optionalMsg) input.value = '';
    if (input) input.style.height = 'auto';

    const msgContainer = document.getElementById('conf-messages');
    if (!msgContainer) return;

    const empty = msgContainer.querySelector('.conf-empty-state');
    if (empty) empty.remove();

    const userRow = document.createElement('div');
    userRow.className = 'chat-row chat-row-user conf-msg animate-up';
    userRow.innerHTML = renderConferenceUserBubble(msg);
    msgContainer.appendChild(userRow);

    const progressEl = document.createElement('div');
    progressEl.className = 'conf-discussion-progress';
    progressEl.innerHTML = `
        <div class="conf-progress-inner">
            <span class="chat-typing-dots"><span></span><span></span><span></span></span>
            <span class="conf-progress-text">Discussion starting…</span>
        </div>
    `;
    msgContainer.appendChild(progressEl);

    scrollToBottom(msgContainer);
    setStreaming(true);
    updateConferenceSendButton(true);
    const abortController = new AbortController();
    setAbortController(abortController);
    const token = localStorage.getItem('memini_token') || authToken;

    let activePh = null;
    const pMap = {};
    activeConf.participants.forEach(p => { pMap[p.id] = p; });

    function createBubble(pid, name, color, icon) {
        const row = document.createElement('div');
        row.className = 'chat-row chat-row-ai conf-msg animate-up';
        row.innerHTML = `
            <div class="chat-msg chat-msg-ai">
                <div class="chat-avatar" style="--bubble-glow-color: ${color}">
                    <i class="fas ${icon}" style="color: ${color}"></i>
                </div>
                <div class="chat-bubble ai-bubble chat-bubble-typing" style="--bubble-glow-color: ${color}">
                    <div class="conf-msg-head">
                        <div class="conf-agent-chip" style="--persona-color: ${color}">
                            <i class="fas ${icon}"></i>
                            <span class="conf-agent-name" style="color: ${color}">${escapeHtml(name)}</span>
                        </div>
                    </div>
                    <div class="chat-bubble-part chat-bubble-steps" data-steps></div>
                    <div class="chat-bubble-part chat-bubble-thinking" data-thinking></div>
                    <div class="chat-bubble-part chat-bubble-main">
                        <div class="chat-bubble-content">
                            <span class="chat-typing-dots"><span></span><span></span><span></span></span>
                        </div>
                    </div>
                    <div class="chat-bubble-part chat-bubble-cards" data-cards></div>
                </div>
            </div>
        `;
        msgContainer.insertBefore(row, progressEl);
        scrollToBottom(msgContainer);
        return { el: row, content: '', thinking: '', toolSteps: [], searchSources: [], pid };
    }

    function finalizeBubble(ph) {
        if (!ph) return;
        const bubble = ph.el.querySelector('.ai-bubble');
        if (bubble) bubble.classList.remove('chat-bubble-typing');
        const contentEl = ph.el.querySelector('.chat-bubble-content');
        if (contentEl && ph.content) {
            contentEl.innerHTML = `<div class="prose prose-invert prose-sm">${formatContent(ph.content)}</div>`;
        }
        if (ph.thinking) {
            const thinkingPart = ph.el.querySelector('[data-thinking]');
            if (thinkingPart) {
                thinkingPart.innerHTML = `
                    <div class="chat-thinking-block">
                        <button type="button" class="chat-thinking-toggle" aria-expanded="false"
                            onclick="const b=this.closest('.chat-thinking-block'); const o=b.classList.toggle('chat-thinking-open'); this.setAttribute('aria-expanded', o?'true':'false')">
                            <i class="fas fa-brain"></i>
                            <span class="chat-thinking-label">${t('conference.thinking') || 'Thinking'}</span>
                            <i class="fas fa-chevron-down chat-thinking-chevron"></i>
                        </button>
                        <div class="chat-thinking-content">
                            <p class="chat-thinking-p">${formatContent(ph.thinking)}</p>
                        </div>
                    </div>
                `;
            }
        }
        if (ph.toolSteps.length) {
            const stepsPart = ph.el.querySelector('[data-steps]');
            if (stepsPart) {
                stepsPart.innerHTML = `
                    <div class="chat-tools-row">
                        <div class="chat-steps">
                            ${ph.toolSteps.map(s => `
                                <span class="chat-step">
                                    <i class="fas ${toolIcon(s.name)} chat-step-icon"></i>
                                    <span class="chat-step-label">${escapeHtml(s.label || s.name || '')}</span>
                                </span>
                            `).join('')}
                        </div>
                        <div class="chat-tools-summary">${ph.toolSteps.length} tool${ph.toolSteps.length > 1 ? 's' : ''}</div>
                    </div>
                `;
            }
        }
        if (ph.searchSources.length) {
            const cardsPart = ph.el.querySelector('[data-cards]');
            if (cardsPart) cardsPart.innerHTML = buildSourcesHtml(ph.searchSources);
        }
    }

    function scheduleChunkRender(ph) {
        if (ph._renderScheduled) return;
        ph._renderScheduled = true;
        requestAnimationFrame(() => {
            ph._renderScheduled = false;
            const contentEl = ph.el.querySelector('.chat-bubble-content');
            if (contentEl && ph.content) {
                contentEl.innerHTML = escapeHtml(ph.content).replace(/\n/g, '<br>');
            }
            scrollToBottom(msgContainer);
        });
    }

    function handleSSEEvent(eventType, data) {
        switch (eventType) {
            case 'discussion_start': {
                const maxT = data.max_turns || 15;
                progressEl.querySelector('.conf-progress-text').textContent = `Discussion starting… (max ${maxT} turns)`;
                break;
            }
            case 'turn_info': {
                const phase = data.phase === 'initial' ? 'Round 1' : 'Free discussion';
                progressEl.querySelector('.conf-progress-text').textContent = `${phase} · Turn ${data.turn}/${data.max_turns} · ${escapeHtml(data.speaker_name || '')}…`;
                break;
            }
            case 'participant_start': {
                if (activePh) finalizeBubble(activePh);
                const p = pMap[data.id] || {};
                const name = data.name || p.name || 'AI';
                const color = data.color || p.color || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#38bdf8';
                const icon = data.icon || p.icon || 'fa-robot';
                activePh = createBubble(data.id, name, color, icon);
                break;
            }
            case 'chunk': {
                if (activePh) {
                    activePh.content += data.content || '';
                    scheduleChunkRender(activePh);
                }
                break;
            }
            case 'thinking': {
                if (activePh) activePh.thinking += data.content || '';
                if (activePh) syncConferenceMetaBadges(activePh);
                break;
            }
            case 'tool_use': {
                if (activePh) {
                    activePh.toolSteps.push({ name: data.tool_name || '', label: data.label || data.tool_name || '' });
                    syncConferenceMetaBadges(activePh);
                    const stepsPart = activePh.el.querySelector('[data-steps]');
                    if (stepsPart) {
                        if (!stepsPart.querySelector('.chat-steps')) {
                            stepsPart.innerHTML = '<div class="chat-tools-row"><div class="chat-steps"></div></div>';
                        }
                        const stepsContainer = stepsPart.querySelector('.chat-steps');
                        if (stepsContainer) {
                            stepsContainer.insertAdjacentHTML('beforeend', `
                                <span class="chat-step">
                                    <i class="fas ${toolIcon(data.tool_name)} chat-step-icon"></i>
                                    <span class="chat-step-label">${escapeHtml(data.label || data.tool_name || '')}</span>
                                </span>
                            `);
                        }
                    }
                }
                break;
            }
            case 'search_sources': {
                if (activePh && Array.isArray(data.sources)) {
                    for (const src of data.sources) activePh.searchSources.push(src);
                    syncConferenceMetaBadges(activePh);
                    const cardsPart = activePh.el.querySelector('[data-cards]');
                    if (cardsPart) cardsPart.innerHTML = buildSourcesHtml(activePh.searchSources);
                }
                break;
            }
            case 'participant_done': {
                if (activePh) {
                    activePh.content = data.content || activePh.content;
                    if (data.thinking) activePh.thinking = data.thinking;
                    if (data.tool_steps) activePh.toolSteps = data.tool_steps;
                    if (data.search_sources) activePh.searchSources = data.search_sources;
                    syncConferenceMetaBadges(activePh);
                    finalizeBubble(activePh);
                    activePh = null;
                }
                scrollToBottom(msgContainer);
                break;
            }
            case 'participant_error': {
                if (activePh) {
                    const bubble = activePh.el.querySelector('.ai-bubble');
                    if (bubble) bubble.classList.remove('chat-bubble-typing');
                    const contentEl = activePh.el.querySelector('.chat-bubble-content');
                    if (contentEl) {
                        contentEl.innerHTML = `<span class="text-red-400 text-xs"><i class="fas fa-exclamation-triangle mr-1"></i>${escapeHtml(data.error || 'Error')}</span>`;
                    }
                    activePh = null;
                }
                break;
            }
            case 'discussion_conclude': {
                progressEl.querySelector('.conf-progress-text').textContent = `Discussion concluded after ${data.turns || '?'} turns`;
                progressEl.classList.add('conf-progress-done');
                break;
            }
            case 'synthesis_start': {
                progressEl.querySelector('.conf-progress-text').textContent = 'Generating discussion summary…';
                progressEl.classList.remove('conf-progress-done');
                break;
            }
            case 'discussion_summary': {
                const summaryRow = document.createElement('div');
                summaryRow.className = 'chat-row conf-msg conf-summary-row animate-up';
                summaryRow.innerHTML = `
                    <div class="conf-summary-card glass">
                        <div class="conf-summary-header">
                            <i class="fas fa-clipboard-list"></i>
                            <span>Discussion Summary</span>
                        </div>
                        <div class="conf-summary-content prose prose-invert prose-sm">
                            ${formatContent(data.summary || '')}
                        </div>
                    </div>
                `;
                msgContainer.insertBefore(summaryRow, progressEl);
                scrollToBottom(msgContainer);
                break;
            }
            case 'done':
                scrollToBottom(msgContainer);
                break;
            case 'artifact_update': {
                const panel = document.getElementById('conf-artifact-content');
                if (panel) {
                    panel.innerHTML = formatContent(data.content || '');
                    panel.classList.add('conf-artifact-flash');
                    setTimeout(() => panel.classList.remove('conf-artifact-flash'), 600);
                }
                const metaEl = document.querySelector('.conf-artifact-meta');
                if (metaEl) metaEl.textContent = `v${data.version || 0} — ${escapeHtml(data.updated_by || '')}`;
                if (activeConf && activeConf.artifact) {
                    activeConf.artifact.content = data.content;
                    activeConf.artifact.version = data.version;
                }
                break;
            }
            case 'expert_memory': {
                if (data.persona_id) {
                    personaMemoryCounts[data.persona_id] = (personaMemoryCounts[data.persona_id] || 0) + (data.count || 0);
                }
                break;
            }
        }
    }

    try {
        const response = await fetch(`/api/conference/${activeConf.id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ message: msg }),
            signal: abortController.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        function parseSSEEvents(chunk) {
            if (!chunk) return;
            sseBuffer += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const blocks = sseBuffer.split('\n\n');
            sseBuffer = blocks.pop() || '';
            for (const block of blocks) {
                if (!block.trim()) continue;
                let eventType = '';
                const dataParts = [];
                for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) eventType = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataParts.push(line.slice(5).replace(/^\s/, ''));
                }
                const dataStr = dataParts.join('\n');
                if (!eventType || !dataStr) continue;
                try {
                    handleSSEEvent(eventType, JSON.parse(dataStr));
                } catch (e) { /* parse error, skip */ }
            }
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parseSSEEvents(decoder.decode(value, { stream: true }));
        }
        parseSSEEvents(decoder.decode());
        if (sseBuffer.trim()) parseSSEEvents('\n\n');
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error('Conference stream error', e);
            showToast('Stream error: ' + e.message, 'error');
        }
    } finally {
        setStreaming(false);
        setAbortController(null);
        updateConferenceSendButton(false);

        if (activePh) finalizeBubble(activePh);

        if (progressEl.parentNode) {
            if (progressEl.classList.contains('conf-progress-done')) {
                setTimeout(() => { if (progressEl.parentNode) progressEl.remove(); }, 4000);
            } else {
                progressEl.remove();
            }
        }

        if (activeConf) await onReloadConference(activeConf.id);
    }
}
