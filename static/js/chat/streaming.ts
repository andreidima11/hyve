/**
 * Chat SSE streaming — sendMessage and live bubble rendering.
 */

import { authToken } from '../api.js';
import { t } from '../lang/index.js';
import { getThinkingMode } from '../thinking_mode.js';
import {
    clearAttachedDocument,
    clearAttachedImage,
    getAttachedDocumentText,
    getAttachedImageBase64,
    getAttachedImageDataUrl,
    getAttachedDocumentFileName,
    waitForImageReady,
} from './attachments.js';
import { handleSlashCommand } from './slash.js';
import { appendMessage } from './render.js';
import { scrollChatToBottom } from './scroll.js';
import { currentSessionId, setCurrentSessionId } from './session_state.js';
import {
    clearStreamAbortController,
    finalizeStoppedStreamingBubble,
    getStreamAbortController,
    setSendButtonState,
    setStreamAbortController,
} from './stream_control.js';
import { runChatStreamSession } from './stream_session.js';

export async function sendMessage(optionalMessage?: string) {
    const input = document.getElementById('user-input') as HTMLTextAreaElement | null;
    const msg = (typeof optionalMessage === 'string' && optionalMessage.trim())
        ? optionalMessage.trim()
        : (input && input.value && input.value.trim()) || '';
    // Wait for any in-progress image resize to finish before reading the base64
    await waitForImageReady();
    const imageBase64 = getAttachedImageBase64();
    const documentText = getAttachedDocumentText();
    if (!msg && !imageBase64 && !documentText) return;

    // ── Slash command intercept ─────────────────────────────────
    if (msg.startsWith('/') && !imageBase64 && !documentText) {
        return handleSlashCommand(msg);
    }

    if (input && (typeof optionalMessage !== 'string' || !optionalMessage.trim())) input.value = '';
    if (input) {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
    const imageDataUrlForBubble = getAttachedImageDataUrl();
    const documentFileNameForBubble = getAttachedDocumentFileName() || null;
    clearAttachedImage();
    clearAttachedDocument();
    if (input) input.blur(); // dismiss keyboard (e.g. Android WebView) after send
    appendMessage('user', msg || '', {
        imageDataUrl: imageDataUrlForBubble,
        documentFileName: documentFileNameForBubble,
        profileName: (document.getElementById('model-selector-label')?.textContent || document.querySelector('.model-selector-item.is-active .hyd-entity-row__name')?.textContent || '').trim()
    });

    const aiBubbleId = 'ai-' + Date.now();
    const container = document.getElementById('chat-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-row chat-row-ai animate-up';
    div.innerHTML = `
        <div class="chat-msg chat-msg-ai">
            <div class="chat-bubble ai-bubble chat-bubble-typing" id="${aiBubbleId}">
                <span class="chat-typing-dots">
                    <span></span><span></span><span></span>
                </span>
            </div>
        </div>`;
    container.appendChild(div);

    requestAnimationFrame(() => {
        scrollChatToBottom({ behavior: 'smooth', force: true });
    });

    const token = localStorage.getItem('hyve_token') || authToken;
    // If there's an active AI response, abort it before starting a new one
    const prior = getStreamAbortController();
    if (prior) {
        prior.abort();
        clearStreamAbortController();
    }
    const abortController = new AbortController();
    setStreamAbortController(abortController);
    setSendButtonState(true);
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
                message: msg || '', 
                token: token,
                session_id: currentSessionId,
                thinking_mode: getThinkingMode(),
                ...(imageBase64 ? { image: imageBase64 } : {}),
                ...(documentText ? { document_text: documentText } : {})
            }),
            signal: abortController.signal
        });

        if (!response.ok) throw new Error("Server Error");

        const profileColor = response.headers.get('X-Profile-Color') || response.headers.get('X-Auto-Profile-Color');
        const bubbleEl = document.getElementById(aiBubbleId);
        if (bubbleEl && profileColor) {
            const row = bubbleEl.closest('.chat-row-ai') as HTMLElement | null;
            const c = profileColor.trim();
            if (row) row.style.setProperty('--bubble-glow-color', c);
            bubbleEl.style.setProperty('--bubble-glow-color', c);
        }
        function applyBubbleGlow(color: string) {
            const el = document.getElementById(aiBubbleId);
            if (!el || !color) return;
            const c = (color || '').trim();
            const row = el.closest('.chat-row-ai') as HTMLElement | null;
            if (row) row.style.setProperty('--bubble-glow-color', c);
            el.style.setProperty('--bubble-glow-color', c);
        }

        // Persistăm ID-ul de sesiune primit de la backend (pentru multi-chat)
        const newSessionId = response.headers.get('X-Session-Id');
        if (newSessionId) {
            setCurrentSessionId(newSessionId);
        }

        await runChatStreamSession({
            aiBubbleId,
            newSessionId,
            hasImage: !!imageBase64,
            applyBubbleGlow,
            onResendMessage: sendMessage,
        }, response);
    } catch (e: unknown) {
        const bubble = document.getElementById(aiBubbleId);
        if (e instanceof DOMException && e.name === 'AbortError') {
            finalizeStoppedStreamingBubble();
            if (bubble) {
                bubble.classList.remove('chat-bubble-typing');
                const mainPart = bubble.querySelector('.chat-bubble-main');
                if (mainPart && mainPart.textContent?.trim()) {
                    // keep partial content already rendered
                } else {
                    bubble.innerHTML = '<div class="chat-bubble-content"><span class="text-slate-500"><i class="fas fa-stop-circle"></i> Stopped</span></div>';
                }
            }
        } else {
            let errMsg = t('chat.error_connection');
            const detail = e instanceof Error ? e.message : '';
            if (detail && detail !== 'Failed to fetch') {
                errMsg += ` (${detail})`;
            }
            console.error('[CHAT] Send error:', e);
            if (bubble) {
                bubble.classList.remove('chat-bubble-typing');
                bubble.innerHTML = `<div class="chat-bubble-content"><span class="chat-error"><i class="fas fa-exclamation-triangle"></i> ${errMsg}</span></div>`;
            }
        }
    } finally {
        clearStreamAbortController();
        setSendButtonState(false);
    }
}
