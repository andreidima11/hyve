/**
 * Chat bubble rendering — messages, code blocks, images, forge preview.
 */

import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
import { documentIconClass } from './attachments.js';
import { enhanceCodeBlock, applyHighlightingWithLineNumbers } from './code_highlight.js';
import { decorateImages } from './image_cards.js';
import { hideChatEmptyState } from './empty_state.js';
import { scrollChatToBottom } from './scroll.js';
import type { AppendMessageOptions, ChatMessageRole, ChatResponseStats } from '../types/chat.js';

export function appendMessage(role: ChatMessageRole, text: string, options: AppendMessageOptions = {}) {
    const container = document.getElementById('chat-container');
    if (!container) return;
    hideChatEmptyState();

    const div = document.createElement('div');
    div.className = `chat-row ${role === 'user' ? 'chat-row-user' : 'chat-row-ai'} animate-up`;

    if (role === 'ai' || role === 'reminder' || role === 'automation') {
        const isReminder = role === 'reminder';
        const isAutomation = role === 'automation';
        const bubbleExtra = isReminder ? 'chat-bubble-reminder' : (isAutomation ? 'chat-bubble-automation' : '');
        const glowEl = (isReminder || isAutomation) ? '<div class="chat-bubble-glow"></div>' : '';
        div.innerHTML = `
            <div class="chat-msg chat-msg-ai group">
                <div class="chat-bubble ai-bubble ${bubbleExtra}">
                    ${glowEl}
                    <div class="chat-bubble-content prose prose-invert prose-sm">
                        ${DOMPurify.sanitize(marked?.parse(text) || text)}
                    </div>
                </div>
            </div>`;
    } else {
        const contentHtml = text ? escapeHtml(text) : '';
        const docFileName = options.documentFileName;
        const docIcon = docFileName ? documentIconClass(docFileName) : '';
        const docBlock = docFileName
            ? `<div class="chat-user-document-attach"><i class="fas ${docIcon}"></i><span>${escapeHtml(docFileName)}</span></div>`
            : '';
        const now = new Date();
        let timeStr, dateStr;
        if (options.timestamp) {
            const d = new Date(typeof options.timestamp === 'number' ? options.timestamp * 1000 : options.timestamp);
            timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            dateStr = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
        } else {
            timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            dateStr = now.toLocaleDateString([], { day: 'numeric', month: 'short' });
        }
        const profileName = options.profileName || '';
        const stampParts = [`${dateStr}, ${timeStr}`];
        if (profileName) stampParts.push(profileName);
        const stampText = stampParts.join(' · ');
        div.innerHTML = `
            <div class="chat-msg chat-msg-user">
                <div class="chat-bubble user-bubble">
                    <div class="chat-bubble-content">${contentHtml}${docBlock}</div>
                </div>
                <div class="chat-user-stamp" style="display:none">
                    <div class="chat-user-stamp-info"><span>${escapeHtml(stampText)}</span></div>
                    <div class="chat-user-stamp-actions">
                        <button class="chat-msg-action-btn chat-user-copy-btn" type="button"><i class="fas fa-copy"></i><span class="action-tooltip">${escapeHtml(t('common.copy') || 'Copiază')}</span></button>
                        <button class="chat-msg-action-btn chat-user-edit-btn" type="button"><i class="fas fa-rotate-left"></i><span class="action-tooltip">${escapeHtml(t('chat.reuse') || 'Refolosește')}</span></button>
                    </div>
                </div>
            </div>`;
        if (options.imageDataUrl) {
            const wrap = document.createElement('div');
            wrap.className = 'chat-user-image-wrap mt-1';
            const img = document.createElement('img');
            img.src = options.imageDataUrl;
            img.alt = '';
            img.className = 'chat-user-uploaded-image';
            wrap.appendChild(img);
            div.querySelector('.chat-bubble-content')?.appendChild(wrap);
        }
    }

    container.appendChild(div);
    if (role === 'ai' || role === 'reminder' || role === 'automation') { decorateCodeBlocks(div); decorateImages(div); }
    // Wire user action buttons
    if (role === 'user') {
        // Toggle stamp + tap animation on click/tap
        const userBubble = div.querySelector('.user-bubble') as HTMLElement | null;
        const stamp = div.querySelector('.chat-user-stamp') as HTMLElement | null;
        if (userBubble && stamp) {
            userBubble.addEventListener('click', (e) => {
                if (window.getSelection()?.toString()) return;
                // Tap animation — PERF FIX: use class toggle instead of forced reflow
                userBubble.classList.remove('user-bubble-tap');
                // requestAnimationFrame to restart animation without forced reflow
                requestAnimationFrame(() => {
                    userBubble.classList.add('user-bubble-tap');
                });
                stamp.style.display = stamp.style.display === 'none' ? '' : 'none';
            });
            userBubble.addEventListener('animationend', () => {
                userBubble.classList.remove('user-bubble-tap');
            });
        }
        const copyBtn = div.querySelector('.chat-user-copy-btn') as HTMLButtonElement | null;
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const bc = div.querySelector('.chat-bubble-content') as HTMLElement | null;
                const txt = bc ? (bc.innerText || bc.textContent || '') : '';
                navigator.clipboard.writeText(txt).then(() => {
                    const icon = copyBtn.querySelector('i');
                    if (icon) icon.className = 'fas fa-check';
                    setTimeout(() => { const ic = copyBtn.querySelector('i'); if (ic) ic.className = 'fas fa-copy'; }, 1500);
                }).catch(() => {});
            });
        }
        const editBtn = div.querySelector('.chat-user-edit-btn') as HTMLButtonElement | null;
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                const bc = div.querySelector('.chat-bubble-content');
                const txt = bc ? (bc.textContent || '') : '';
                const input = document.getElementById('user-input') as HTMLTextAreaElement | null;
                if (input) { input.value = txt; input.focus(); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
            });
        }
    }
    scrollChatToBottom({ behavior: 'smooth', force: true });
}

/** Action bar under AI responses: copy, regenerate, thumbs up/down + performance stats */
export function appendConsciousnessFeedbackBar(
    bubble: Element,
    bubbleId: string | null,
    stats: ChatResponseStats | null,
) {
    if (!bubble || bubble.querySelector('.chat-intelligence-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'chat-intelligence-bar';

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'chat-msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'chat-msg-action-btn';
    copyBtn.type = 'button';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i><span class="action-tooltip">' + escapeHtml(t('common.copy') || 'Copy') + '</span>';
    copyBtn.addEventListener('click', () => {
        const content = bubble.querySelector('.chat-bubble-content') as HTMLElement | null;
        const text = content ? (content.innerText || content.textContent || '') : '';
        navigator.clipboard.writeText(text).then(() => {
            const icon = copyBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-check';
            copyBtn.classList.add('active');
            setTimeout(() => {
                const ic = copyBtn.querySelector('i');
                if (ic) ic.className = 'fas fa-copy';
                copyBtn.classList.remove('active');
            }, 2000);
        }).catch(() => {});
    });
    actions.appendChild(copyBtn);

    // Regenerate button
    const regenBtn = document.createElement('button');
    regenBtn.className = 'chat-msg-action-btn';
    regenBtn.type = 'button';
    regenBtn.innerHTML = '<i class="fas fa-arrows-rotate"></i><span class="action-tooltip">' + escapeHtml(t('chat.regenerate') || 'Regenerate') + '</span>';
    regenBtn.addEventListener('click', () => {
        const row = bubble.closest('.chat-row-ai');
        if (!row) return;
        let prev = row.previousElementSibling;
        while (prev && !prev.classList.contains('chat-row-user')) prev = prev.previousElementSibling;
        if (!prev) return;
        const userContent = prev.querySelector('.chat-bubble-content') as HTMLElement | null;
        if (!userContent) return;
        const userText = userContent.innerText || userContent.textContent || '';
        row.remove();
        if (typeof window.sendMessage === 'function') window.sendMessage(userText);
        else {
            const mod = window.__chatExports;
            if (mod?.sendMessage) mod.sendMessage(userText);
        }
    });
    actions.appendChild(regenBtn);

    // Profile/model name label with separator before it
    if (stats && stats.model) {
        const sep0 = document.createElement('div');
        sep0.className = 'chat-actions-sep';
        actions.appendChild(sep0);

        const modelLabel = document.createElement('span');
        modelLabel.className = 'chat-bar-model-label';
        modelLabel.textContent = stats.model;
        if (stats.modelId) {
            modelLabel.setAttribute('title', stats.modelId);
            modelLabel.innerHTML = escapeHtml(stats.model) + '<span class="chat-model-popover">' + escapeHtml(stats.modelId) + '</span>';
        }
        actions.appendChild(modelLabel);
    }

    bar.appendChild(actions);

    // Stats
    if (stats) {
    const parts = [];
    if (stats.elapsed) {
        const sec = (stats.elapsed / 1000).toFixed(1);
        parts.push('<span title="' + escapeHtml(t('chat.stat_response_time') || 'Response time') + '"><i class="fas fa-clock"></i> ' + sec + 's</span>');
    }
    if (stats.thinkingTime) {
        const ts = (stats.thinkingTime / 1000).toFixed(1);
        parts.push('<span title="' + escapeHtml(t('chat.stat_thinking_time') || 'Thinking time') + '"><i class="fas fa-brain"></i> ' + ts + 's</span>');
    }
        if (parts.length) {
            const sep = document.createElement('div');
            sep.className = 'chat-actions-sep';
            bar.appendChild(sep);
            const statsEl = document.createElement('div');
            statsEl.className = 'chat-stats';
            statsEl.innerHTML = parts.join('<span class="chat-stats-sep">&middot;</span>');
            bar.appendChild(statsEl);
        }
    }

    bubble.appendChild(bar);
}

/** Înfășoară blocurile pre/code în ferestre cu header (limbaj + Select all / Copy) */
export function decorateCodeBlocks(container: Element | null) {
    if (!container) return;
    const content = container.classList?.contains('chat-bubble-content')
        ? container
        : container.querySelector?.('.chat-bubble-content');
    const root = content || container;
    const pres = root.querySelectorAll ? root.querySelectorAll('pre') : [];
    pres.forEach((pre) => {
        if (pre.closest('.chat-code-block')) return;
        const code = pre.querySelector('code') || pre;
        const langMatch = (code.className || '').match(/\blanguage-(\w+)/);
        const lang = langMatch ? langMatch[1] : t('chat.code_label');
        const rawSource = code.textContent || pre.textContent || '';
        (pre as HTMLElement).dataset.rawSource = rawSource;

        const wrap = document.createElement('div');
        wrap.className = 'chat-code-block';

        const header = document.createElement('div');
        header.className = 'chat-code-header';
        header.innerHTML = `
            <span class="chat-code-lang">${escapeHtml(lang)}</span>
            <div class="chat-code-actions">
                <button type="button" class="chat-code-select-all">${escapeHtml(t('chat.select_all'))}</button>
                <button type="button" class="chat-code-copy">${escapeHtml(t('common.copy'))}</button>
            </div>`;

        const selectBtn = header.querySelector('.chat-code-select-all') as HTMLButtonElement | null;
        const copyBtn = header.querySelector('.chat-code-copy') as HTMLButtonElement | null;

        selectBtn?.addEventListener('click', () => {
            const range = document.createRange();
                        range.selectNodeContents(pre.querySelector('code') || pre);
            const sel = window.getSelection();
            if (!sel) return;
            sel.removeAllRanges();
            sel.addRange(range);
          });

        copyBtn?.addEventListener('click', () => {
            const preEl = pre as HTMLElement;
            const text = preEl.dataset.rawSource || (pre.querySelector('code') || pre).textContent || pre.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = t('chat.copied');
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.textContent = t('common.copy');
                    copyBtn.classList.remove('copied');
                }, 2000);
            }).catch(() => {});
          });

        wrap.appendChild(header);
        if (pre.parentNode) pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        enhanceCodeBlock(pre, lang, rawSource);
    });
}

export { decorateImages } from './image_cards.js';

export function enhanceForgePreview(container: Element | null, streaming: boolean) {
    if (!container) return;
    const preview = container.querySelector('.chat-forge-preview');
    if (!preview) return;
    const codeEl = preview.querySelector('code');
    const pre = preview.querySelector('pre');
    if (!codeEl || !pre) return;
    const rawSource = codeEl.dataset.rawSource || codeEl.textContent || '';
    const lang = codeEl.dataset.language || codeEl.getAttribute('data-language') || 'python';
    applyHighlightingWithLineNumbers(codeEl, rawSource, lang);
    requestAnimationFrame(() => {
        if (streaming || preview.classList.contains('chat-forge-preview-streaming')) {
            pre.scrollTop = pre.scrollHeight;
        }
    });
}

export function buildForgePreviewHtml(content: string, language = 'python', streaming = false) {
    if (!content) return '';
    const lang = language || 'python';
    return `
        <div class="chat-forge-preview ${streaming ? 'chat-forge-preview-streaming' : ''}">
            <div class="chat-code-header">
                <span class="chat-code-lang">${escapeHtml(lang)}</span>
                <div class="chat-forge-preview-title">
                    <i class="fas fa-wand-magic-sparkles"></i>
                    <span>${escapeHtml(t(streaming ? 'skills.live_code_writing' : 'skills.live_code_preview') || (streaming ? 'Forge is writing the skill live...' : 'Generated skill preview'))}</span>
                </div>
                <div class="chat-code-actions">
                    <button type="button" class="chat-forge-preview-select">${escapeHtml(t('chat.select_all'))}</button>
                    <button type="button" class="chat-forge-preview-copy">${escapeHtml(t('common.copy'))}</button>
                </div>
            </div>
            <pre><code data-language="${escapeHtml(lang)}" data-raw-source="${escapeHtml(content).replace(/"/g, '&quot;')}">${escapeHtml(content)}</code></pre>
        </div>`;
}
