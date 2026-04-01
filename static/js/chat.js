import { apiCall, authToken, suppressLogout } from './api.js';
import { t, tRaw } from './lang/index.js';
import { escapeHtml, showToast, TOOL_ICONS, TOOL_ICON_FALLBACK, buildSourcesHtml } from './utils.js';

if (typeof marked !== 'undefined') {
    // Custom renderer for better chat markdown rendering
    // Uses marked.use() API (compatible with marked v5+)
    marked.use({
        breaks: true,
        gfm: true,
        renderer: {
            // Links open in new tab with noopener
            link({ href, title, text }) {
                const titleAttr = title ? ` title="${title}"` : '';
                const displayText = text || href;
                return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${displayText}</a>`;
            },
            // Tables get a wrapper div for horizontal scroll
            table({ header, rows }) {
                let headerHtml = '';
                let bodyHtml = '';
                if (header && header.length) {
                    headerHtml = '<thead><tr>' + header.map(cell => {
                        const align = cell.align ? ` style="text-align:${cell.align}"` : '';
                        return `<th${align}>${cell.text || ''}</th>`;
                    }).join('') + '</tr></thead>';
                }
                if (rows && rows.length) {
                    bodyHtml = '<tbody>' + rows.map(row => {
                        return '<tr>' + row.map(cell => {
                            const align = cell.align ? ` style="text-align:${cell.align}"` : '';
                            return `<td${align}>${cell.text || ''}</td>`;
                        }).join('') + '</tr>';
                    }).join('') + '</tbody>';
                }
                return `<div class="chat-table-wrap"><table>${headerHtml}${bodyHtml}</table></div>`;
            },
            // Blockquotes get styled class
            blockquote({ text }) {
                return `<blockquote class="chat-blockquote">${text || ''}</blockquote>\n`;
            }
        }
    });
}

// ID-ul conversației curente (multi-chat), păstrat și în localStorage
export let currentSessionId = localStorage.getItem('memini_session_id') || null;

// Imagine atașată pentru mesajul curent (data URL sau null)
let attachedImageDataUrl = null;
// Document atașat: text extras (PDF/DOCX/TXT) și nume fișier pentru preview
let attachedDocumentText = null;
let attachedDocumentFileName = null;

/**
 * Resize & compress an image to fit within MAX_DIM and MAX_BYTES before attaching.
 * This prevents "Could not connect" errors caused by oversized payloads.
 * Similar to how Claude / ChatGPT handle image uploads.
 */
const IMG_MAX_DIM   = 1536;   // max px on longest edge (matches vision model sweet-spot)
const IMG_MAX_BYTES = 1_500_000; // ~1.5 MB base64 budget
const IMG_QUALITY   = 0.82;   // JPEG quality

function _resizeImage(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width: w, height: h } = img;
            // Downscale if needed
            if (w > IMG_MAX_DIM || h > IMG_MAX_DIM) {
                const ratio = Math.min(IMG_MAX_DIM / w, IMG_MAX_DIM / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);

            // Try JPEG at target quality; if still too large, reduce quality iteratively
            let quality = IMG_QUALITY;
            let result = canvas.toDataURL('image/jpeg', quality);
            while (result.length > IMG_MAX_BYTES && quality > 0.3) {
                quality -= 0.1;
                result = canvas.toDataURL('image/jpeg', quality);
            }
            // Last resort: shrink dimensions further
            if (result.length > IMG_MAX_BYTES) {
                const shrink = Math.sqrt(IMG_MAX_BYTES / result.length);
                canvas.width  = Math.round(w * shrink);
                canvas.height = Math.round(h * shrink);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                result = canvas.toDataURL('image/jpeg', 0.7);
            }
            resolve(result);
        };
        img.onerror = () => resolve(dataUrl); // fallback: keep original
        img.src = dataUrl;
    });
}

// Promise that resolves when the current image resize is complete
let _imageResizePromise = null;

export async function addAttachedImage(dataUrl) {
    // Show preview immediately with original (perceived speed)
    attachedImageDataUrl = dataUrl;
    _updateImagePreview();
    // Resize in background, update when done
    const resizeP = _resizeImage(dataUrl);
    _imageResizePromise = resizeP;
    const optimized = await resizeP;
    if (attachedImageDataUrl === dataUrl) {
        // Only update if user hasn't cleared/changed it meanwhile
        attachedImageDataUrl = optimized;
    }
    if (_imageResizePromise === resizeP) _imageResizePromise = null;
}

export function clearAttachedImage() {
    attachedImageDataUrl = null;
    _imageResizePromise = null;
    _updateImagePreview();
}

/** Wait for any in-progress resize to finish before reading the base64. */
export async function waitForImageReady() {
    if (_imageResizePromise) await _imageResizePromise;
}

export function getAttachedImageBase64() {
    if (!attachedImageDataUrl) return null;
    // Strip any data URL prefix (handles all MIME types: jpeg, png, webp, heic, svg+xml, etc.)
    const idx = attachedImageDataUrl.indexOf(';base64,');
    if (idx !== -1) return attachedImageDataUrl.substring(idx + 8);
    return attachedImageDataUrl;
}

export function addAttachedDocument(text, fileName) {
    attachedDocumentText = text;
    attachedDocumentFileName = fileName || null;
    _updateDocumentPreview();
}

export function clearAttachedDocument() {
    attachedDocumentText = null;
    attachedDocumentFileName = null;
    _updateDocumentPreview();
}

export function getAttachedDocumentText() {
    return attachedDocumentText;
}

export function getAttachedDocumentFileName() {
    return attachedDocumentFileName;
}

/** Icon Font Awesome în funcție de extensie (pentru preview și balon) */
function _documentIconClass(fileName) {
    const n = (fileName || '').toLowerCase();
    if (n.endsWith('.pdf')) return 'fa-file-pdf';
    if (n.endsWith('.docx') || n.endsWith('.doc')) return 'fa-file-word';
    if (n.endsWith('.txt')) return 'fa-file-lines';
    return 'fa-file-alt';
}

function _updateDocumentPreview() {
    const el = document.getElementById('chat-document-preview');
    if (!el) return;
    if (!attachedDocumentText) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    const name = attachedDocumentFileName || 'document';
    const iconClass = _documentIconClass(name);
    el.innerHTML = `<span class="chat-document-name"><i class="fas ${iconClass}"></i> ${escapeHtml(name)}</span><button type="button" class="chat-document-remove" aria-label="${escapeHtml(t('chat.remove_document') || 'Remove document')}"><i class="fas fa-times"></i></button>`;
    const btn = el.querySelector('.chat-document-remove');
    if (btn) btn.onclick = () => clearAttachedDocument();
}

function _updateImagePreview() {
    const el = document.getElementById('chat-image-preview');
    if (!el) return;
    if (!attachedImageDataUrl) {
        el.classList.add('hidden');
        el.innerHTML = '';
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = '<img src="" alt="" /><button type="button" class="chat-image-remove" aria-label="Remove"><i class="fas fa-times"></i></button>';
    const img = el.querySelector('img');
    if (img) img.src = attachedImageDataUrl;
    const btn = el.querySelector('.chat-image-remove');
    if (btn) btn.onclick = () => clearAttachedImage();
}

export function setCurrentSessionId(id) {
    currentSessionId = id;
    try {
        if (id) localStorage.setItem('memini_session_id', id);
        else localStorage.removeItem('memini_session_id');
    } catch (e) {}
    const disp = document.getElementById('session-display');
    if (disp) disp.innerText = id ? id.slice(0, 8) + '…' : t('status.connected');
    const btnClear = document.getElementById('btn-clear-context');
    if (btnClear) {
        btnClear.classList.toggle('hidden', !id);
        if (id) btnClear.title = t('sessions.clear_context_tooltip');
    }
}

/** Actualizează numele conversației afișat în sidebar */
export function setSessionDisplay(title) {
    const el = document.getElementById('session-name-display');
    if (el) el.textContent = title || '—';
    if (el && title) el.setAttribute('title', title);
}

function syncChatEmptyLayoutState() {
    const view = document.querySelector('.chat-view');
    const emptyState = document.getElementById('chat-empty-state');
    if (!view || !emptyState) return;
    view.classList.toggle('chat-view-empty', !emptyState.classList.contains('is-hidden'));
}

function hideChatEmptyState() {
    const el = document.getElementById('chat-empty-state');
    if (el) el.classList.add('is-hidden');
    syncChatEmptyLayoutState();
}

export function showChatEmptyState() {
    const el = document.getElementById('chat-empty-state');
    if (el) {
        el.classList.remove('is-hidden');
        _applyRandomGreeting(el);
    }
    syncChatEmptyLayoutState();
}

/** Pick a random time-aware greeting and apply it with a fade. */
function _applyRandomGreeting(container) {
    const titleEl = container.querySelector('.chat-empty-title');
    if (!titleEl) return;

    // Build combined pool: general + time-of-day
    const general  = tRaw('chat.welcome_greetings') || [];
    const hour     = new Date().getHours();
    const todKey   = hour >= 5 && hour < 12 ? 'chat.welcome_greetings_morning'
                   : hour >= 12 && hour < 18 ? 'chat.welcome_greetings_afternoon'
                   : 'chat.welcome_greetings_evening';
    const todPool  = tRaw(todKey) || [];

    // Merge AI-generated greetings from localStorage (if any)
    let aiPool = [];
    try {
        const cached = JSON.parse(localStorage.getItem('memini_ai_greetings') || '{}');
        if (Array.isArray(cached.greetings) && cached.greetings.length) aiPool = cached.greetings;
    } catch {}

    const pool = [...general, ...todPool, ...aiPool];
    if (!pool.length) return;

    const pick = pool[Math.floor(Math.random() * pool.length)];

    // Set text immediately then play a subtle fade-in
    titleEl.textContent = pick.text;
    titleEl.classList.remove('greeting-fade-in');
    // Force reflow so the animation restarts
    void titleEl.offsetWidth;
    titleEl.classList.add('greeting-fade-in');
    titleEl.addEventListener('animationend', () => titleEl.classList.remove('greeting-fade-in'), { once: true });
}

/**
 * Check if AI greetings should be refreshed (based on frequency/time settings).
 * Called once on page load. Fetches from /api/welcome-greetings if due.
 */
export async function maybeRefreshAiGreetings() {
    try {
        const cached = JSON.parse(localStorage.getItem('memini_ai_greetings') || '{}');
        const enabled = cached.enabled;
        if (!enabled) return;

        const freqHours = cached.frequencyHours || 24;
        const lastGen   = cached.generatedAt || 0;
        const elapsed   = (Date.now() - lastGen) / 3600000;
        if (elapsed < freqHours) return;

        const res = await apiCall('/api/welcome-greetings', { method: 'POST' });
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.greetings) && data.greetings.length) {
            cached.greetings    = data.greetings;
            cached.generatedAt  = Date.now();
            localStorage.setItem('memini_ai_greetings', JSON.stringify(cached));
        }
    } catch {}
}

function _initEmptyState() {
    syncChatEmptyLayoutState();
    const el = document.getElementById('chat-empty-state');
    if (el && !el.classList.contains('is-hidden')) _applyRandomGreeting(el);
}

/** Called from app.js after initI18n so the correct language pool is used. */
export function applyInitialGreeting() {
    _initEmptyState();
}

// ─── Shared constants & helpers (used by both sendMessage and loadSessionHistory) ───
// TOOL_ICONS, TOOL_ICON_FALLBACK now imported from utils.js
const statusIcons = TOOL_ICONS;
const statusIconFallback = TOOL_ICON_FALLBACK;
const CHAT_AUTO_SCROLL_THRESHOLD = 10;
let chatAutoScrollPinnedToBottom = true;
let chatScrollTrackingInitialized = false;
let chatProgrammaticScroll = false;

function getChatWrapper() {
    return document.querySelector('.chat-messages-wrapper');
}

function isNearBottom(el, threshold = CHAT_AUTO_SCROLL_THRESHOLD) {
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function initChatScrollTracking() {
    const wrapper = getChatWrapper();
    if (!wrapper || chatScrollTrackingInitialized) return;
    chatScrollTrackingInitialized = true;
    chatAutoScrollPinnedToBottom = isNearBottom(wrapper);
    wrapper.addEventListener('scroll', () => {
        if (chatProgrammaticScroll) return;
        chatAutoScrollPinnedToBottom = isNearBottom(wrapper);
    }, { passive: true });
}

function scrollChatToBottom({ behavior = 'auto', force = false } = {}) {
    const wrapper = getChatWrapper();
    if (!wrapper) return;
    initChatScrollTracking();
    if (!force && !chatAutoScrollPinnedToBottom) return;

    chatProgrammaticScroll = true;
    if (force) chatAutoScrollPinnedToBottom = true;
    requestAnimationFrame(() => {
        wrapper.scrollTo({ top: wrapper.scrollHeight, behavior });
        // Clear flag after scroll animation finishes
        setTimeout(() => { chatProgrammaticScroll = false; }, 400);
    });
}

/** Thinking block: collapsed "Thought for Xs" + dropdown (reused by loadSessionHistory). */
function buildThinkingBlock(streaming, content, durationSec, isOpen = false) {
    const expandLabel = escapeHtml(t("chat.thinking_expand") || "Arată gândirea");
    if (streaming) {
        const safe = escapeHtml(content || "").replace(/\n/g, "<br>");
        const openClass = " chat-thinking-open";
        return `<div class="chat-thinking-block chat-thinking-streaming${openClass}">
            <button type="button" class="chat-thinking-toggle" aria-expanded="true" aria-label="${expandLabel}">
                <span class="chat-thinking-indicator"><span></span><span></span><span></span></span>
                <span class="chat-thinking-label">Se gândește</span>
                <i class="fas fa-chevron-down chat-thinking-chevron"></i>
            </button>
            <div class="chat-thinking-content"><div class="chat-thinking-stream">${safe}</div></div>
        </div>`;
    }
    if (!content && durationSec == null) return "";
    const safe = escapeHtml(content || "").replace(/\n/g, "<br>");
    const paragraphs = safe
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p class="chat-thinking-p">${p.replace(/\n/g, "<br>")}</p>`)
        .join("");
    const contentHtml = paragraphs || `<p class="chat-thinking-p">${safe.replace(/\n/g, "<br>")}</p>`;
    const durationLabel = durationSec != null
        ? `A gândit ${durationSec}s`
        : "A gândit";
    const openAttr = isOpen ? ' chat-thinking-open' : '';
    return `<div class="chat-thinking-block${openAttr}">
        <button type="button" class="chat-thinking-toggle" aria-expanded="${isOpen}" aria-label="${expandLabel}">
            <i class="fas fa-brain chat-thinking-done-icon"></i>
            <span class="chat-thinking-label">${escapeHtml(durationLabel)}</span>
            <i class="fas fa-chevron-down chat-thinking-chevron"></i>
        </button>
        <div class="chat-thinking-content">${contentHtml}</div>
    </div>`;
}

function buildPendingStateHtml(label, icon = "") {
    const safeLabel = escapeHtml(label || "Se gândește");
    const iconHtml = icon ? `<i class="fas ${icon} chat-pending-icon"></i>` : "";
    return `<div class="chat-pending-state" aria-live="polite">
        <span class="chat-pending-indicator"><span></span><span></span><span></span></span>
        ${iconHtml}<span class="chat-pending-label">${safeLabel}</span>
    </div>`;
}

export function appendMessage(role, text, options = {}) {
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
                        ${DOMPurify.sanitize(marked.parse(text))}
                    </div>
                </div>
            </div>`;
    } else {
        const contentHtml = text ? escapeHtml(text) : '';
        const docFileName = options.documentFileName;
        const docIcon = docFileName ? _documentIconClass(docFileName) : '';
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
            div.querySelector('.chat-bubble-content').appendChild(wrap);
        }
    }

    container.appendChild(div);
    if (role === 'ai' || role === 'reminder' || role === 'automation') { decorateCodeBlocks(div); decorateImages(div); }
    // Wire user action buttons
    if (role === 'user') {
        // Toggle stamp + tap animation on click/tap
        const userBubble = div.querySelector('.user-bubble');
        const stamp = div.querySelector('.chat-user-stamp');
        if (userBubble && stamp) {
            userBubble.addEventListener('click', (e) => {
                if (window.getSelection && window.getSelection().toString()) return;
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
        const copyBtn = div.querySelector('.chat-user-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const bc = div.querySelector('.chat-bubble-content');
                const txt = bc ? (bc.innerText || bc.textContent || '') : '';
                navigator.clipboard.writeText(txt).then(() => {
                    copyBtn.querySelector('i').className = 'fas fa-check';
                    setTimeout(() => { copyBtn.querySelector('i').className = 'fas fa-copy'; }, 1500);
                });
            });
        }
        const editBtn = div.querySelector('.chat-user-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                const bc = div.querySelector('.chat-bubble-content');
                const txt = bc ? (bc.innerText || bc.textContent || '') : '';
                const input = document.getElementById('user-input');
                if (input) { input.value = txt; input.focus(); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
            });
        }
    }
    scrollChatToBottom({ behavior: 'smooth', force: true });
}


/** Bară sub răspuns AI: feedback Util/Neutil + „De ce mi-ai răspuns așa?” (ultimele impresii) */
/** Strip emojis, markdown artifacts and code blocks for clean TTS */
function _stripForTTS(text) {
    if (!text) return '';
    return text
        .replace(/```[\s\S]*?```/g, '')           // code blocks
        .replace(/`[^`]+`/g, '')                   // inline code
        .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')     // links/images
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
        .replace(/[*_~#>|\-]{2,}/g, '')            // markdown formatting
        .replace(/\n{2,}/g, '\n')                   // collapse newlines
        .trim();
}

/* ── "Read from here" context menu on chat bubbles ─────────────────── */
(function _initReadFromHereMenu() {
    const menuId = 'tts-context-menu';

    function _removeMenu() {
        const old = document.getElementById(menuId);
        if (old) old.remove();
    }

    document.addEventListener('contextmenu', (e) => {
        const content = e.target.closest('.chat-bubble-content');
        if (!content) { _removeMenu(); return; }
        const bubble = content.closest('.chat-bubble');
        if (!bubble) return;
        // Only if Piper is enabled
        const piperEl = document.getElementById('piper_enabled');
        if (!piperEl || !piperEl.checked) return;

        const sel = window.getSelection();
        const selText = sel ? sel.toString().trim() : '';
        if (!selText) return; // Only show if text is selected

        e.preventDefault();
        _removeMenu();

        // Calculate offset of selection within the bubble content text
        const fullText = content.innerText || content.textContent || '';
        const selStart = fullText.indexOf(selText);
        const offset = selStart >= 0 ? selStart : 0;

        const menu = document.createElement('div');
        menu.id = menuId;
        menu.className = 'tts-context-menu';
        menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999;`;
        menu.innerHTML = `<button type="button" class="tts-context-menu-item"><i class="fas fa-play"></i> Citește de aici</button>`;
        menu.querySelector('button').addEventListener('click', () => {
            _removeMenu();
            if (window.__tts) window.__tts.speak(bubble, { fromOffset: offset });
        });
        document.body.appendChild(menu);
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#' + menuId)) _removeMenu();
    });
    document.addEventListener('scroll', _removeMenu, true);
})();

/* ══════════════════════════════════════════════════════════════════════
   TTS Manager — centralised playback with overlap protection, cache,
   visual indicator, streaming sentence queue, and voice-loop support.
   ══════════════════════════════════════════════════════════════════════ */
const _tts = {
    /** @type {Audio|null} */
    audio: null,
    /** @type {HTMLElement|null} bubble currently being spoken */
    bubble: null,
    /** @type {AbortController|null} */
    abort: null,
    /** per-bubble WAV cache for instant replay */
    cache: new WeakMap(),
    /** when true, every AI response is spoken automatically */
    alwaysSpeak: false,
    /** generation token to invalidate stale stream playback loops */
    _streamRunId: 0,

    _isPiperOn() {
        const pip = document.getElementById('piper_enabled');
        return !!(pip && pip.checked);
    },
    _getSynthUrl() {
        return '/api/piper/synthesize';
    },
    _emit(name, detail) {
        window.dispatchEvent(new CustomEvent('tts:' + name, { detail: detail || {} }));
    },
    _setIndicator(speaking) {
        const ind = document.getElementById('tts-speaking-indicator');
        const btn = document.getElementById('btn-always-speak');
        if (ind) ind.classList.toggle('hidden', !speaking);
        if (btn) btn.classList.toggle('speaking', !!speaking);
    },
    _resetBubbleBtn(bubble) {
        if (!bubble) return;
        const btn = bubble.querySelector('.chat-speak-btn');
        if (btn) {
            btn.dataset.playing = '0';
            btn.querySelector('i').className = 'fas fa-volume-up';
            btn.classList.remove('active');
            btn._audio = null;
        }
    },

    /* ── stop ────────────────────────────────────────────────────── */
    stop() {
        if (this.abort) { this.abort.abort(); this.abort = null; }
        if (this.audio) {
            this.audio.pause();
            if (this.audio._blobUrl) URL.revokeObjectURL(this.audio._blobUrl);
            this.audio = null;
        }
        this._streamRunId += 1;
        this._streamQueue = [];
        this._streamPlaying = false;
        this._streamBubble = null;
        this._resetBubbleBtn(this.bubble);
        this.bubble = null;
        this._setIndicator(false);
        this._emit('stop');
    },

    /* ── speak full bubble (or from offset for "read from here") ── */
    async speak(bubble, { fromOffset = 0 } = {}) {
        if (!this._isPiperOn()) { console.warn('[TTS] piper not enabled'); return null; }
        if (!bubble) return null;

        // Toggle off if same bubble already playing
        if (this.bubble === bubble && this.audio && !this.audio.paused) {
            this.stop();
            return null;
        }
        this.stop();

        const content = bubble.querySelector('.chat-bubble-content');
        let rawText = content ? (content.innerText || content.textContent || '') : '';
        if (fromOffset > 0) rawText = rawText.slice(fromOffset);
        const text = _stripForTTS(rawText);
        if (!text) { console.warn('[TTS] empty text after strip'); return null; }

        this.bubble = bubble;
        const btn = bubble.querySelector('.chat-speak-btn');

        // Cache hit (only for full text)
        const cached = fromOffset === 0 && this.cache.has(bubble) ? this.cache.get(bubble) : null;
        if (cached) return this._playBlob(cached, btn);

        if (btn) btn.querySelector('i').className = 'fas fa-spinner fa-spin';
        this.abort = new AbortController();
        try {
            const res = await apiCall(this._getSynthUrl(), {
                method: 'POST',
                body: { text },
                signal: this.abort.signal,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'TTS failed');
            }
            const blob = await res.blob();
            if (fromOffset === 0) this.cache.set(bubble, blob);
            this.abort = null;
            return this._playBlob(blob, btn);
        } catch (e) {
            if (e.name === 'AbortError') return null;
            console.error('[TTS] speak error:', e);
            this._resetBubbleBtn(bubble);
            this.bubble = null;
            this._setIndicator(false);
            return null;
        }
    },

    /* ── play WAV blob ──────────────────────────────────────────── */
    _playBlob(blob, btn) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio._blobUrl = url;
        this.audio = audio;

        if (btn) {
            btn._audio = audio;
            btn.dataset.playing = '1';
            btn.querySelector('i').className = 'fas fa-stop';
            btn.classList.add('active');
        }
        this._setIndicator(true);
        this._emit('start', { bubble: this.bubble });

        audio.onended = () => {
            if (btn) {
                btn.dataset.playing = '0';
                btn.querySelector('i').className = 'fas fa-volume-up';
                btn.classList.remove('active');
                btn._audio = null;
            }
            URL.revokeObjectURL(url);
            const wasVoiceLoop = !!window.__voiceLoopActive;
            this.audio = null;
            const bub = this.bubble;
            this.bubble = null;
            this._setIndicator(false);
            this._emit('ended', { bubble: bub, voiceLoop: wasVoiceLoop });
        };
        audio.play().catch(() => {
            this._resetBubbleBtn(this.bubble);
            this.bubble = null;
            this._setIndicator(false);
        });
        return audio;
    },

    /* ── streaming TTS: speak sentences as they arrive ──────────── */
    _streamQueue: [],
    _streamBubble: null,
    _streamPlaying: false,

    streamReset(bubble) {
        // Ensure any previous stream/audio is stopped before starting a new response.
        this.stop();
        this._streamQueue = [];
        this._streamBubble = bubble;
        this._streamPlaying = false;
    },

    streamPush(sentence) {
        if (!sentence || !this._isPiperOn()) return;
        const shouldStream = window.__voiceInputPending || this.alwaysSpeak;
        if (!shouldStream) return;
        this._streamQueue.push(sentence);
        if (!this._streamPlaying) this._streamPlayNext(this._streamRunId);
    },

    async _streamPlayNext(runId = this._streamRunId) {
        if (runId !== this._streamRunId) return;
        if (this._streamQueue.length === 0) {
            this._streamPlaying = false;
            this._resetBubbleBtn(this._streamBubble);
            this._setIndicator(false);
            this._emit('ended', { bubble: this._streamBubble, voiceLoop: !!window.__voiceLoopActive });
            return;
        }
        this._streamPlaying = true;
        const text = this._streamQueue.shift();
        const cleanText = _stripForTTS(text);
        if (!cleanText) { this._streamPlayNext(runId); return; }

        if (this.audio && this.bubble !== this._streamBubble) this.stop();
        if (runId !== this._streamRunId) return;
        this.bubble = this._streamBubble;
        this._setIndicator(true);

        const btn = this._streamBubble?.querySelector('.chat-speak-btn');
        if (btn) {
            btn.dataset.playing = '1';
            btn.querySelector('i').className = 'fas fa-volume-up';
            btn.classList.add('active');
        }

        try {
            const res = await apiCall(this._getSynthUrl(), {
                method: 'POST',
                body: { text: cleanText },
            });
            if (!res.ok) throw new Error('TTS stream fail');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio._blobUrl = url;
            this.audio = audio;

            await new Promise((resolve) => {
                audio.onended = () => { URL.revokeObjectURL(url); setTimeout(resolve, 80); };
                audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
                audio.play().catch(resolve);
            });
        } catch (e) {
            console.warn('[TTS-STREAM]', e.message);
        }
        this._streamPlayNext(runId);
    },

    streamWasActive() {
        return this._streamPlaying || this._streamQueue.length > 0;
    },
};

window.__tts = _tts;

/** Speak a bubble's text — convenience wrapper */
async function _speakBubble(bubble, opts) {
    return _tts.speak(bubble, opts);
}

/** Action bar under AI responses: copy, regenerate, thumbs up/down + performance stats */
function appendConsciousnessFeedbackBar(bubble, bubbleId, stats) {
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
        const content = bubble.querySelector('.chat-bubble-content');
        const text = content ? (content.innerText || content.textContent || '') : '';
        navigator.clipboard.writeText(text).then(() => {
            copyBtn.querySelector('i').className = 'fas fa-check';
            copyBtn.classList.add('active');
            setTimeout(() => {
                copyBtn.querySelector('i').className = 'fas fa-copy';
                copyBtn.classList.remove('active');
            }, 2000);
        });
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
        const userContent = prev.querySelector('.chat-bubble-content');
        if (!userContent) return;
        const userText = userContent.innerText || userContent.textContent || '';
        row.remove();
        if (typeof window.sendMessage === 'function') window.sendMessage(userText);
        else {
            const mod = window.__chatExports;
            if (mod && mod.sendMessage) mod.sendMessage(userText);
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

    // Tool indicators (icons with hover popovers)
    if (stats && stats.tools && stats.tools.length > 0) {
        const sep1 = document.createElement('div');
        sep1.className = 'chat-actions-sep';
        bar.appendChild(sep1);
        const toolsWrap = document.createElement('div');
        toolsWrap.className = 'chat-tool-indicators';
        for (const tool of stats.tools) {
            const iconClass = statusIcons[tool.type] || statusIconFallback;
            const btn = document.createElement('button');
            btn.className = 'chat-tool-indicator';
            btn.type = 'button';
            btn.innerHTML = '<i class="fas ' + iconClass + '"></i><span class="chat-tool-popover">' + escapeHtml(tool.label || tool.type || '') + '</span>';
            toolsWrap.appendChild(btn);
        }
        bar.appendChild(toolsWrap);
    }

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
function decorateCodeBlocks(container) {
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
        pre.dataset.rawSource = rawSource;

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

        const selectBtn = header.querySelector('.chat-code-select-all');
        const copyBtn = header.querySelector('.chat-code-copy');

        selectBtn?.addEventListener('click', () => {
            const range = document.createRange();
                        range.selectNodeContents(pre.querySelector('code') || pre);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          });

        copyBtn?.addEventListener('click', () => {
                        const text = pre.dataset.rawSource || (pre.querySelector('code') || pre).textContent || pre.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = t('chat.copied');
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.textContent = t('common.copy');
                    copyBtn.classList.remove('copied');
                }, 2000);
            });
          });

        wrap.appendChild(header);
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        enhanceCodeBlock(pre, lang, rawSource);
    });
}

function normalizeCodeLanguage(lang) {
    const value = (lang || '').toLowerCase().trim();
    if (!value || value === (t('chat.code_label') || 'code').toLowerCase()) return '';
    const aliases = {
        py: 'python',
        js: 'javascript',
        ts: 'typescript',
        jsx: 'javascript',
        tsx: 'typescript',
        sh: 'bash',
        shell: 'bash',
        shellscript: 'bash',
        zsh: 'bash',
        ps1: 'powershell',
        ps: 'powershell',
        yml: 'yaml',
        html: 'xml',
        xhtml: 'xml',
        svg: 'xml',
        plist: 'xml',
        md: 'markdown',
        'c++': 'cpp',
        hpp: 'cpp',
        cc: 'cpp',
        hh: 'cpp',
        h: 'c',
        'c#': 'csharp',
        cs: 'csharp',
        objc: 'objectivec',
        objectivec: 'objectivec',
        docker: 'dockerfile',
        env: 'ini',
        properties: 'ini'
    };
    return aliases[value] || value;
}

function applyHighlightingWithLineNumbers(codeEl, rawSource, lang = '') {
    if (!codeEl) return;
    const normalizedLang = normalizeCodeLanguage(lang);
    codeEl.textContent = rawSource || '';
    codeEl.dataset.rawSource = rawSource || '';
    codeEl.dataset.language = normalizedLang || '';
    codeEl.className = normalizedLang ? `language-${normalizedLang}` : '';

    if (typeof hljs !== 'undefined') {
        try {
            if (normalizedLang && hljs.getLanguage(normalizedLang)) {
                hljs.highlightElement(codeEl);
            } else {
                const result = hljs.highlightAuto(rawSource || '');
                codeEl.innerHTML = result.value;
                codeEl.className = result.language ? `language-${result.language} hljs` : 'hljs';
                codeEl.dataset.language = result.language || normalizedLang || '';
            }
        } catch (_e) {
            codeEl.textContent = rawSource || '';
        }
    }

    const applyLines = () => {
        if (codeEl.dataset.lineNumbersReady === '1') return;
        if (typeof hljs === 'undefined' || typeof hljs.lineNumbersBlock !== 'function') return;
        try {
            const maybePromise = hljs.lineNumbersBlock(codeEl, { singleLine: true });
            if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then(() => { codeEl.dataset.lineNumbersReady = '1'; }).catch(() => {});
            } else {
                codeEl.dataset.lineNumbersReady = '1';
            }
        } catch (_e) {
            // noop
        }
    };

    codeEl.dataset.lineNumbersReady = '0';
    applyLines();
}

function enhanceCodeBlock(pre, lang, rawSource) {
    if (!pre) return;
    const codeEl = pre.querySelector('code') || pre;
    applyHighlightingWithLineNumbers(codeEl, rawSource || pre.dataset.rawSource || codeEl.textContent || '', lang);
}

function enhanceForgePreview(container, streaming) {
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

function buildForgePreviewHtml(content, language = 'python', streaming = false) {
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

// ─── Image cards: styled wrapper with download/share/expand ───

/** Fetch image as blob and trigger a real file download (works cross-origin too). */
async function _downloadImageBlob(src, alt) {
    try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const ext = (blob.type || 'image/png').split('/')[1] || 'png';
        const name = (alt && alt !== 'Generated Image' && alt !== 'image' ? alt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) : 'image') + '.' + ext;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (_e) {
        // Fallback: open in new tab if fetch fails (e.g. CORS)
        window.open(src, '_blank');
    }
}

/** Wrap <img> tags in chat bubbles with a styled card + action buttons */
function decorateImages(container) {
    if (!container) return;
    const content = container.classList?.contains('chat-bubble-content')
        ? container
        : container.querySelector?.('.chat-bubble-content');
    const root = content || container;
    const imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    imgs.forEach((img) => {
        // Skip if already wrapped or if it's a user-uploaded image
        if (img.closest('.chat-image-card') || img.classList.contains('chat-user-uploaded-image')) return;
        // Skip tiny inline images (emoji etc)
        if (img.naturalWidth > 0 && img.naturalWidth < 40) return;

        const src = img.src || '';
        const alt = img.alt || '';

        const card = document.createElement('div');
        card.className = 'chat-image-card';

        // Image wrapper (clickable to expand)
        const imgWrap = document.createElement('div');
        imgWrap.className = 'chat-image-card-img';
        imgWrap.addEventListener('click', () => openImageLightbox(src, alt));

        // Action overlay (visible on hover)
        const actions = document.createElement('div');
        actions.className = 'chat-image-card-actions';

        // Download button
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'chat-image-action-btn';
        dlBtn.title = t('chat.image_download') || 'Download';
        dlBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _downloadImageBlob(src, alt);
        });

        // Share / Copy link button
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'chat-image-action-btn';
        shareBtn.title = t('chat.image_share') || 'Copy link';
        shareBtn.innerHTML = '<i class="fas fa-share-alt"></i>';
        shareBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const fullUrl = new URL(src, window.location.origin).href;
            if (navigator.share) {
                navigator.share({ title: alt || 'Image', url: fullUrl }).catch(() => {});
            } else {
                navigator.clipboard.writeText(fullUrl).then(() => {
                    shareBtn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => { shareBtn.innerHTML = '<i class="fas fa-share-alt"></i>'; }, 1500);
                });
            }
        });

        // Expand button
        const expandBtn = document.createElement('button');
        expandBtn.type = 'button';
        expandBtn.className = 'chat-image-action-btn';
        expandBtn.title = t('chat.image_expand') || 'Expand';
        expandBtn.innerHTML = '<i class="fas fa-expand"></i>';
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openImageLightbox(src, alt);
        });

        actions.appendChild(dlBtn);
        actions.appendChild(shareBtn);
        actions.appendChild(expandBtn);

        // Move the img into our card
        img.parentNode.insertBefore(card, img);
        imgWrap.appendChild(img);
        imgWrap.appendChild(actions);
        card.appendChild(imgWrap);

        // Alt text caption (if any)
        if (alt && alt !== 'Generated Image' && alt !== 'image') {
            const caption = document.createElement('div');
            caption.className = 'chat-image-card-caption';
            caption.textContent = alt;
            card.appendChild(caption);
        }
    });
}

/** Full-screen lightbox for image preview */
function openImageLightbox(src, alt) {
    // Remove existing lightbox if any
    document.getElementById('chat-image-lightbox')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'chat-image-lightbox';
    overlay.className = 'chat-image-lightbox';

    overlay.innerHTML = `
        <div class="chat-lightbox-backdrop"></div>
        <div class="chat-lightbox-content">
            <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="chat-lightbox-img" />
            <div class="chat-lightbox-toolbar">
                <button type="button" class="chat-lightbox-btn chat-lightbox-dl" title="${escapeHtml(t('chat.image_download') || 'Download')}">
                    <i class="fas fa-arrow-down"></i>
                </button>
                <button type="button" class="chat-lightbox-btn chat-lightbox-share" title="${escapeHtml(t('chat.image_share') || 'Copy link')}">
                    <i class="fas fa-share-alt"></i>
                </button>
                <button type="button" class="chat-lightbox-btn chat-lightbox-close" title="${escapeHtml(t('common.close') || 'Close')}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        </div>`;

    // Close on Escape key
    const onKey = (e) => { if (e.key === 'Escape') closeLightbox(); };
    const closeLightbox = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };

    // Close on backdrop click or close button
    overlay.querySelector('.chat-lightbox-backdrop').addEventListener('click', closeLightbox);
    overlay.querySelector('.chat-lightbox-close').addEventListener('click', closeLightbox);

    // Download
    overlay.querySelector('.chat-lightbox-dl').addEventListener('click', () => {
        _downloadImageBlob(src, alt);
    });

    // Share
    overlay.querySelector('.chat-lightbox-share').addEventListener('click', () => {
        const fullUrl = new URL(src, window.location.origin).href;
        if (navigator.share) {
            navigator.share({ title: alt || 'Image', url: fullUrl }).catch(() => {});
        } else {
            navigator.clipboard.writeText(fullUrl).then(() => {
                const btn = overlay.querySelector('.chat-lightbox-share');
                btn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => { btn.innerHTML = '<i class="fas fa-share-alt"></i>'; }, 1500);
            });
        }
    });

    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    // Animate in
    requestAnimationFrame(() => overlay.classList.add('chat-lightbox-visible'));
}

let _currentAbortController = null;

function finalizeStoppedStreamingBubble() {
    // Search ALL ai-bubbles — chat-bubble-typing is removed early by renderBubble,
    // so we look for any remaining streaming markers instead
    document.querySelectorAll('.ai-bubble').forEach(bubble => {
        const hasStreamingMarker = bubble.classList.contains('chat-bubble-typing')
            || bubble.querySelector('.chat-thinking-block.chat-thinking-streaming')
            || bubble.querySelector('.chat-stream-cursor')
            || bubble.querySelector('.chat-code-block.chat-code-streaming')
            || bubble.querySelector('.chat-pending-indicator');
        if (!hasStreamingMarker) return;

        bubble.classList.remove('chat-bubble-typing');
        bubble.querySelector('.chat-stream-cursor')?.remove();

        bubble.querySelectorAll('.chat-code-block.chat-code-streaming').forEach(block => {
            block.classList.remove('chat-code-streaming');
        });

        const thinkingBlock = bubble.querySelector('.chat-thinking-block.chat-thinking-streaming');
        if (thinkingBlock) {
            thinkingBlock.classList.remove('chat-thinking-streaming');
            const toggle = thinkingBlock.querySelector('.chat-thinking-toggle');
            const dots = thinkingBlock.querySelector('.chat-thinking-indicator');
            if (dots) {
                dots.outerHTML = '<i class="fas fa-brain chat-thinking-done-icon"></i>';
            }
            if (toggle && !toggle.querySelector('.fa-brain')) {
                toggle.insertAdjacentHTML('afterbegin', '<i class="fas fa-brain"></i>');
            }
        }

        const mainContent = bubble.querySelector('.chat-bubble-main .chat-bubble-content') || bubble.querySelector('.chat-bubble-content');
        if (mainContent) {
            const typingDots = mainContent.querySelector('.chat-pending-indicator');
            if (typingDots && !mainContent.textContent.trim()) {
                mainContent.innerHTML = '<span class="text-slate-500"><i class="fas fa-stop-circle"></i> Stopped</span>';
            } else if (typingDots) {
                typingDots.remove();
            }
        }
    });
}

function setSendButtonState(streaming) {
    const btn = document.getElementById('btn-send');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (!icon) return;
    if (streaming) {
        icon.className = 'fas fa-stop';
        btn.classList.add('streaming');
    } else {
        icon.className = 'fas fa-paper-plane';
        btn.classList.remove('streaming');
    }
}

export function stopStreaming() {
    if (_currentAbortController) {
        _currentAbortController.abort();
        _currentAbortController = null;
        setSendButtonState(false);
        // Run cleanup now AND after any pending RAF/throttle renders that may still fire
        finalizeStoppedStreamingBubble();
        requestAnimationFrame(() => finalizeStoppedStreamingBubble());
        setTimeout(() => finalizeStoppedStreamingBubble(), 120);
    }
}

// ── SLASH COMMANDS ──────────────────────────────────────────────────
let _slashCommandsCache = null;

async function fetchSlashCommands() {
    if (_slashCommandsCache) return _slashCommandsCache;
    try {
        const res = await apiCall('/api/slash/commands');
        if (res.ok) {
            _slashCommandsCache = await res.json();
            return _slashCommandsCache;
        }
    } catch (e) { /* ignore */ }
    return [];
}

/** Show a system-style bubble with the slash command result */
function appendSlashResult(text) {
    const container = document.getElementById('chat-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-row chat-row-ai animate-up';
    div.innerHTML = `
        <div class="chat-msg chat-msg-ai">
            <div class="chat-bubble ai-bubble chat-bubble-slash">
                <div class="chat-bubble-content prose prose-invert prose-sm">
                    ${DOMPurify.sanitize(marked.parse(text))}
                </div>
            </div>
        </div>`;
    container.appendChild(div);
    requestAnimationFrame(() => scrollChatToBottom({ behavior: 'smooth', force: true }));
}

async function handleSlashCommand(msg) {
    const input = document.getElementById('user-input');
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    hideSlashAutocomplete();
    appendMessage('user', msg);

    try {
        const res = await apiCall('/api/slash', {
            method: 'POST',
            body: { command: msg, session_id: currentSessionId },
        });
        const data = await res.json();
        appendSlashResult(data.message || (data.ok ? '✅ Done.' : '❌ Failed.'));

        // Handle post-command actions
        const action = data.action;
        if (action === 'clear_context' && typeof window.clearSessionContext === 'function') {
            window.clearSessionContext();
        } else if (action === 'new_session' && typeof window.newChatSession === 'function') {
            window.newChatSession();
        } else if (action === 'restart') {
            suppressLogout(true);
            showToast('Server restarting…', 'info', 8000);
            _startSlashReconnectPolling();
        } else if (action === 'stop') {
            showToast('Server stopped.', 'info', 10000);
        }
    } catch (e) {
        appendSlashResult('❌ Command failed: ' + (e.message || 'network error'));
    }
}

function _startSlashReconnectPolling() {
    let attempts = 0;
    const tryReconnect = () => {
        attempts++;
        fetch('/api/health', { method: 'GET', credentials: 'same-origin' })
            .then(r => { if (r.ok) { suppressLogout(false); location.reload(); } })
            .catch(() => {})
            .finally(() => { if (attempts < 30) setTimeout(tryReconnect, 2000); else suppressLogout(false); });
    };
    setTimeout(tryReconnect, 3000);
}

// ── SLASH AUTOCOMPLETE ──────────────────────────────────────────────
let _slashPopup = null;
let _slashSelectedIdx = -1;
let _slashFiltered = [];

function ensureSlashPopup() {
    if (_slashPopup) return _slashPopup;
    const popup = document.createElement('div');
    popup.id = 'slash-autocomplete';
    popup.className = 'slash-autocomplete hidden';
    const wrapper = document.querySelector('.chat-input-inner') || document.querySelector('.chat-input-wrapper') || document.body;
    wrapper.style.position = 'relative';
    wrapper.appendChild(popup);
    _slashPopup = popup;
    popup.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.slash-autocomplete-item');
        if (item) {
            e.preventDefault();
            const cmd = item.dataset.command;
            const input = document.getElementById('user-input');
            if (input) input.value = cmd + ' ';
            hideSlashAutocomplete();
            if (input) input.focus();
        }
    });
    return popup;
}

function showSlashAutocomplete(filtered) {
    const popup = ensureSlashPopup();
    _slashFiltered = filtered;
    _slashSelectedIdx = -1;
    if (!filtered.length) { popup.classList.add('hidden'); return; }
    popup.innerHTML = filtered.map((c, i) => 
        `<div class="slash-autocomplete-item${i === _slashSelectedIdx ? ' selected' : ''}" data-command="${escapeHtml(c.command)}">
            <span class="slash-cmd">${escapeHtml(c.command)}</span>
            <span class="slash-desc">${escapeHtml(c.description)}</span>
            ${c.admin ? '<span class="slash-admin">admin</span>' : ''}
        </div>`
    ).join('');
    popup.classList.remove('hidden');
}

function hideSlashAutocomplete() {
    if (_slashPopup) _slashPopup.classList.add('hidden');
    _slashFiltered = [];
    _slashSelectedIdx = -1;
}

function updateSlashSelection(idx) {
    if (!_slashPopup) return;
    _slashSelectedIdx = idx;
    const items = _slashPopup.querySelectorAll('.slash-autocomplete-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === idx));
}

export function handleSlashInput(value) {
    if (!value.startsWith('/')) { hideSlashAutocomplete(); return; }
    const typed = value.toLowerCase();
    fetchSlashCommands().then(cmds => {
        const filtered = cmds.filter(c => c.command.startsWith(typed));
        showSlashAutocomplete(filtered);
    });
}

export function handleSlashKeydown(e) {
    if (!_slashPopup || _slashPopup.classList.contains('hidden') || !_slashFiltered.length) return false;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        updateSlashSelection(Math.min(_slashSelectedIdx + 1, _slashFiltered.length - 1));
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        updateSlashSelection(Math.max(_slashSelectedIdx - 1, 0));
        return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && _slashSelectedIdx >= 0)) {
        e.preventDefault();
        const sel = _slashFiltered[_slashSelectedIdx >= 0 ? _slashSelectedIdx : 0];
        if (sel) {
            const input = document.getElementById('user-input');
            if (input) { input.value = sel.command + ' '; input.focus(); }
        }
        hideSlashAutocomplete();
        return true;
    }
    if (e.key === 'Escape') {
        hideSlashAutocomplete();
        return true;
    }
    return false;
}

export async function sendMessage(optionalMessage) {
    const input = document.getElementById('user-input');
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
    const imageDataUrlForBubble = attachedImageDataUrl || null;
    const documentFileNameForBubble = getAttachedDocumentFileName() || null;
    clearAttachedImage();
    clearAttachedDocument();
    if (input) input.blur(); // dismiss keyboard (e.g. Android WebView) after send
    appendMessage('user', msg || '', {
        imageDataUrl: imageDataUrlForBubble,
        documentFileName: documentFileNameForBubble,
        profileName: (document.getElementById('model-selector-label')?.textContent || document.querySelector('.model-selector-item.active .model-selector-item-name')?.textContent || '').trim()
    });

    const aiBubbleId = 'ai-' + Date.now();
    const container = document.getElementById('chat-container');
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

    chatAutoScrollPinnedToBottom = true;
    requestAnimationFrame(() => {
        scrollChatToBottom({ behavior: 'smooth', force: true });
    });

    const token = localStorage.getItem('memini_token') || authToken;
    // If there's an active AI response, abort it before starting a new one
    if (_currentAbortController) {
        _currentAbortController.abort();
        _currentAbortController = null;
    }
    _currentAbortController = new AbortController();
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
                ...(imageBase64 ? { image: imageBase64 } : {}),
                ...(documentText ? { document_text: documentText } : {})
            }),
            signal: _currentAbortController.signal
        });

        if (!response.ok) throw new Error("Server Error");

        const profileColor = response.headers.get('X-Profile-Color') || response.headers.get('X-Auto-Profile-Color');
        const bubbleEl = document.getElementById(aiBubbleId);
        if (bubbleEl && profileColor) {
            const row = bubbleEl.closest('.chat-row-ai');
            const c = profileColor.trim();
            if (row) row.style.setProperty('--bubble-glow-color', c);
            bubbleEl.style.setProperty('--bubble-glow-color', c);
        }
        function applyBubbleGlow(color) {
            const el = document.getElementById(aiBubbleId);
            if (!el || !color) return;
            const c = (color || '').trim();
            const row = el.closest('.chat-row-ai');
            if (row) row.style.setProperty('--bubble-glow-color', c);
            el.style.setProperty('--bubble-glow-color', c);
        }

        // Persistăm ID-ul de sesiune primit de la backend (pentru multi-chat)
        const newSessionId = response.headers.get('X-Session-Id');
        if (newSessionId) {
            setCurrentSessionId(newSessionId);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let sseBuffer = "";
        const statusLines = [];
        let streamMetrics = { completion_tokens: null, prompt_tokens: null, total_tokens: null };
        let thinkingContent = "";
        let finalMessageContent = null;
        let finalModelName = "";
        let finalModelId = "";
        let thinkingStartTime = null;
        let pendingPhase = imageBase64 ? 'vision' : 'preparing';
        let pendingPhaseLabel = imageBase64 ? 'Analizez imaginea' : 'Se gândește';
        const responseStartTime = Date.now();
        let firstChunkTime = null;
        const shellCards = [];
        const searchSources = [];
        const bubble = document.getElementById(aiBubbleId);
        let isStreaming = true;
        let scheduledRenderRAF = 0;
        let chunkThrottleTimer = 0;
        let lastChunkRenderTime = 0;
        const CHUNK_RENDER_THROTTLE_MS = 72;

        // Streaming TTS: accumulate text and push complete sentences
        let _ttsAccum = '';
        _tts.streamReset(bubble);
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


        /** Strip </think> / <think> and <thinking>...</thinking> from content so nothing leaks into the reply. */
        function stripThinkFromContent(text) {
            if (!text || typeof text !== "string") return text || "";
            let s = text;
            const thinkBlockRe = new RegExp("<think>[\\s\\S]*?<\\/think>", "gi");
            const thinkingBlockRe = new RegExp("<thinking>[\\s\\S]*?<\\/thinking>", "gi");
            s = s.replace(thinkBlockRe, "");
            s = s.replace(thinkingBlockRe, "");
            s = s.replace(/\s*<\/think>\s*|\s*<\/thinking>\s*/gi, " ");
            s = s.replace(/\s*<think>\s*|\s*<thinking>\s*/gi, " ");
            return s.replace(/\s{3,}/g, " ").trim();
        }
        /** During stream: show only text after last </think> or </thinking> so thinking never appears in the bubble. */
        function contentAfterThink(text) {
            if (!text || typeof text !== "string") return text || "";
            const closeTags = ["</think>", "</thinking>"];
            let best = -1;
            let tagLen = 0;
            const lower = text.toLowerCase();
            for (const tag of closeTags) {
                const i = lower.lastIndexOf(tag.toLowerCase());
                if (i >= 0 && (best < 0 || i > best)) { best = i; tagLen = tag.length; }
            }
            if (best < 0) return "";
            return text.slice(best + tagLen).trim();
        }

        const proposalCards = [];
        const forgePreview = { content: '', language: 'python', done: false };

        /** Dacă modelul nu folosește <think>, încearcă să descompunem textul în gândire + răspuns (ex: "..." + "Uite, răspuns."). */
        function splitThinkingFromReply(text) {
            if (!text || text.length < 80) return null;
            const replyStarters = /(?:\.|\n)\s*(Uite|Iată|So,|Well,|Here'?s?|I'm |Deci,|Așadar,|În concluzie,|Pe scurt,)/gi;
            let lastMatch = null;
            let m;
            while ((m = replyStarters.exec(text)) !== null) lastMatch = m;
            if (lastMatch && lastMatch.index >= 50) {
                const replyStart = lastMatch.index + lastMatch[0].length - lastMatch[1].length;
                const thinking = text.slice(0, replyStart).trim();
                const reply = text.slice(replyStart).trim();
                if (reply.length > 0 && thinking.length >= 50) return { thinking, reply };
            }
            const segments = text.split(/\n\n+/);
            const starterRe = /^\s*(Uite|Iată|So,|Well,|Here'?s?|I'm |Deci,|Așadar,)/i;
            for (let i = segments.length - 1; i >= 0; i--) {
                const seg = segments[i].trim();
                if (starterRe.test(seg) && seg.length < 600) {
                    const thinking = segments.slice(0, i).join("\n\n").trim();
                    const reply = segments.slice(i).join("\n\n").trim();
                    if (thinking.length >= 60) return { thinking, reply };
                }
            }
            return null;
        }

        function attachBubbleListeners(bubble) {
            const thinkingBlock = bubble.querySelector(".chat-thinking-block");
            const thinkingToggle = bubble.querySelector(".chat-thinking-toggle");
            if (thinkingBlock && thinkingToggle) {
                thinkingToggle.addEventListener("click", () => {
                    const open = thinkingBlock.classList.toggle("chat-thinking-open");
                    thinkingToggle.setAttribute("aria-expanded", open);
                    if (open) {
                        const contentBox = thinkingBlock.querySelector(".chat-thinking-content");
                        if (contentBox) contentBox.scrollTop = contentBox.scrollHeight;
                    }
                });
            }
            bubble.querySelectorAll(".chat-shell-allow-btn").forEach(btn => {
                btn.addEventListener("click", async () => {
                    try {
                        const res = await fetch("/api/shell/allow", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("memini_token") || ""}` } });
                        if (res.ok) {
                            btn.textContent = t("chat.shell_allowed") || "Permisiune acordată";
                            btn.disabled = true;
                            sendMessage("da");
                        }
                    } catch (e) { console.warn("Shell allow failed", e); }
                });
            });
            bubble.querySelectorAll(".chat-shell-run-btn").forEach(btn => {
                const card = btn.closest(".chat-shell-suggest");
                if (!card) return;
                btn.addEventListener("click", async () => {
                    const command = card.getAttribute("data-command") || "";
                    if (!command) return;
                    btn.disabled = true;
                    try {
                        const res = await fetch("/api/shell/run", {
                            method: "POST",
                            headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("memini_token") || ""}` },
                            body: JSON.stringify({ command })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (res.ok && data.result) {
                            const idx = shellCards.findIndex(c => c.suggest && c.command === command);
                            if (idx !== -1) {
                                const exitCode = (data.result.match(/Exit code:\s*(-?\d+)/) || [])[1];
                                const outputMatch = data.result.match(/(?:Output|Stdout):\s*([\s\S]*)/);
                                shellCards[idx] = { command, exit_code: parseInt(exitCode, 10) || 0, output_preview: (outputMatch && outputMatch[1]) ? outputMatch[1].trim() : data.result };
                                renderBubble();
                            }
                        } else {
                            shellCards.push({ command, exit_code: 1, output_preview: data.error || "Error" });
                            renderBubble();
                        }
                    } catch (e) {
                        shellCards.push({ command, exit_code: 1, output_preview: (e && e.message) || "Error" });
                        renderBubble();
                    }
                });
            });
            bubble.querySelectorAll(".chat-shell-cancel-btn").forEach(btn => {
                const card = btn.closest(".chat-shell-suggest");
                if (!card) return;
                btn.addEventListener("click", () => {
                    const command = card.getAttribute("data-command") || "";
                    const idx = shellCards.findIndex(c => c.suggest && c.command === command);
                    if (idx !== -1) shellCards.splice(idx, 1);
                    renderBubble();
                });
            });
            bubble.querySelectorAll('.chat-forge-preview-copy').forEach(btn => {
                btn.addEventListener('click', () => {
                    const pre = btn.closest('.chat-forge-preview')?.querySelector('pre');
                    const text = pre?.innerText || pre?.textContent || '';
                    navigator.clipboard.writeText(text).then(() => {
                        btn.textContent = t('chat.copied');
                        btn.classList.add('copied');
                        setTimeout(() => {
                            btn.textContent = t('common.copy');
                            btn.classList.remove('copied');
                        }, 2000);
                    });
                });
            });
            bubble.querySelectorAll('.chat-forge-preview-select').forEach(btn => {
                btn.addEventListener('click', () => {
                    const pre = btn.closest('.chat-forge-preview')?.querySelector('pre');
                    if (!pre) return;
                    const range = document.createRange();
                    range.selectNodeContents(pre);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                });
            });
            bubble.querySelectorAll(".chat-proposal-apply-btn").forEach(btn => {
                const card = btn.closest(".chat-proposal-card");
                if (!card) return;
                btn.addEventListener("click", async () => {
                    const raw = card.getAttribute("data-proposal");
                    if (!raw) return;
                    try {
                        const proposal = JSON.parse(raw.replace(/&quot;/g, '"'));
                        const res = await fetch("/api/proposal/apply", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("memini_token") || ""}` }, body: JSON.stringify(proposal) });
                        const data = await res.json().catch(() => ({}));
                        if (res.ok) { btn.textContent = t("chat.proposal_applied") || "Aplicat"; btn.disabled = true; card.querySelector(".chat-proposal-refuse-btn")?.remove(); }
                        else { showToast(data.detail || data.error || "Error", 'error'); }
                    } catch (e) { showToast(e && e.message || "Error", 'error'); }
                });
            });
            bubble.querySelectorAll(".chat-proposal-refuse-btn").forEach(btn => {
                const card = btn.closest(".chat-proposal-card");
                if (!card) return;
                btn.addEventListener("click", () => {
                    const idx = parseInt(card.getAttribute("data-proposal-index"), 10);
                    if (!Number.isNaN(idx) && idx >= 0 && idx < proposalCards.length) proposalCards.splice(idx, 1);
                    renderBubble();
                });
            });
            decorateCodeBlocks(bubble);
            enhanceForgePreview(bubble, bubble.querySelector('.chat-forge-preview')?.classList.contains('chat-forge-preview-streaming'));
            decorateImages(bubble);
        }

        function renderBubble(streaming) {
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
            const thinkingDurationSec = (thinkingStartTime && (firstChunkTime || !streaming))
                ? (((firstChunkTime || Date.now()) - thinkingStartTime) / 1000).toFixed(1)
                : null;
            let displayThinking = showFinalStructure ? thinkingContent : "";
            if (showFinalStructure && !displayThinking && fullText) {
                const split = splitThinkingFromReply(fullText);
                if (split) {
                    displayThinking = split.thinking;
                    displayContent = stripThinkFromContent(split.reply);
                }
            }

            const thinkingWasOpen = !!bubble.querySelector(".chat-thinking-block.chat-thinking-open");
            const thinkingStillStreaming = streaming && hasThinking;
            const thinkingHtml = (thinkingStillStreaming)
                ? buildThinkingBlock(true, thinkingContent, null, thinkingWasOpen)
                : (hasThinking || displayThinking)
                    ? buildThinkingBlock(false, displayThinking || thinkingContent, thinkingDurationSec, thinkingWasOpen)
                    : "";

            const stepsCount = statusLines.length;
            const stepsHtml = stepsCount === 0 ? "" : `
                <div class="chat-tools-row">
                    <div class="chat-steps">
                        ${statusLines.map(s => `
                            <span class="chat-step">
                                <i class="fas ${statusIcons[s.type] || statusIconFallback} chat-step-icon"></i>
                                <span class="chat-step-label">${escapeHtml(s.label || "")}</span>
                            </span>
                        `).join("")}
                    </div>
                    ${!streaming && stepsCount ? `<div class="chat-tools-summary">${escapeHtml((t("chat.used_tools") || "Used {n} tools").replace("{n}", String(stepsCount)))}</div>` : ""}
                </div>`;

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
            const showPendingState = !displayContent && !thinkingHtml;
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
                        const markedPart = DOMPurify.sanitize(marked.parse(before));
                        const streamBlock = `<div class="chat-code-block chat-code-streaming"><div class="chat-code-header"><span class="chat-code-lang">${escapeHtml(lang)}</span></div><pre><code>${escapeHtml(streamCode)}</code></pre></div>`;
                        return `<div class="chat-bubble-content prose prose-invert prose-sm">${markedPart}${streamBlock}${streamCursor}</div>`;
                    }
                    return `<div class="chat-bubble-content prose prose-invert prose-sm">${DOMPurify.sanitize(marked.parse(renderContent))}${streamCursor}</div>`;
                })()
                : showPendingState
                    ? `<div class="chat-bubble-content">${buildPendingStateHtml(pendingLabel, pendingIcon)}</div>`
                    : `<div class="chat-bubble-content"></div>`;
            const shellCardsHtml = shellCards.map(c => {
                if (c.suggest) {
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
                if (c.requested_but_denied) {
                    return `<div class="chat-shell-card chat-shell-request" data-command="${escapeHtml(c.command || '').replace(/"/g, '&quot;')}">
                        <div class="chat-shell-card-header"><i class="fas fa-terminal"></i> <span>${escapeHtml(t('chat.shell_request_title') || 'AI vrea să ruleze o comandă')}</span></div>
                        <pre class="chat-shell-command">${escapeHtml(c.command || '')}</pre>
                        <div class="chat-shell-actions">
                            <button type="button" class="chat-shell-allow-btn">${escapeHtml(t('chat.shell_allow') || 'Permite')}</button>
                            <span class="chat-shell-hint">${escapeHtml(t('chat.shell_allow_hint') || 'Apasă Permite apoi trimite "da" pentru a rula.')}</span>
                        </div>
                    </div>`;
                }
                const exitOk = c.exit_code === 0;
                return `<div class="chat-shell-card chat-shell-done">
                    <div class="chat-shell-card-header"><i class="fas fa-check-circle ${exitOk ? 'text-emerald-400' : 'text-amber-400'}"></i> <span>${escapeHtml(t('chat.shell_done_title') || 'Comandă rulată')}</span> <span class="chat-shell-exit">exit ${c.exit_code}</span></div>
                    <pre class="chat-shell-command">${escapeHtml(c.command || '')}</pre>
                    <details class="chat-shell-output"><summary>${escapeHtml(t('chat.shell_output') || 'Output')}</summary><pre>${escapeHtml(c.output_preview || '')}</pre></details>
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
            const sourcesHtml = buildSourcesHtml(searchSources);
            const cardsHtml = (shellCardsHtml ? `<div class="chat-shell-cards">${shellCardsHtml}</div>` : "") + (proposalCardsHtml ? `<div class="chat-proposal-cards">${proposalCardsHtml}</div>` : "") + sourcesHtml;

            bubble.classList.remove("chat-bubble-typing");

            const existingThinkingBlock = bubble.querySelector(".chat-thinking-block");
            const doPartialUpdate = streaming && existingThinkingBlock;

            if (doPartialUpdate) {
                const stepsPart = bubble.querySelector(".chat-bubble-part.chat-bubble-steps");
                const thinkingPart = bubble.querySelector(".chat-bubble-part.chat-bubble-thinking");
                const previewPart = bubble.querySelector(".chat-bubble-part.chat-bubble-preview");
                const mainPart = bubble.querySelector(".chat-bubble-part.chat-bubble-main");
                const cardsPart = bubble.querySelector(".chat-bubble-part.chat-bubble-cards");
                if (stepsPart) stepsPart.innerHTML = stepsHtml;
                if (thinkingPart) thinkingPart.innerHTML = thinkingHtml;
                if (previewPart) previewPart.innerHTML = forgePreviewHtml;
                if (mainPart) mainPart.innerHTML = contentHtml;
                if (cardsPart) cardsPart.innerHTML = cardsHtml;
                attachBubbleListeners(bubble);
                if (thinkingWasOpen) {
                    const thinkingContentBox = bubble.querySelector(".chat-thinking-block.chat-thinking-open .chat-thinking-content");
                    if (thinkingContentBox) thinkingContentBox.scrollTop = thinkingContentBox.scrollHeight;
                }
            } else {
                bubble.innerHTML =
                    '<div class="chat-bubble-part chat-bubble-steps">' + stepsHtml + '</div>' +
                    '<div class="chat-bubble-part chat-bubble-thinking">' + thinkingHtml + '</div>' +
                    '<div class="chat-bubble-part chat-bubble-preview">' + forgePreviewHtml + '</div>' +
                    '<div class="chat-bubble-part chat-bubble-main">' + contentHtml + '</div>' +
                    '<div class="chat-bubble-part chat-bubble-cards">' + cardsHtml + '</div>';
                attachBubbleListeners(bubble);
                if (thinkingWasOpen) {
                    const thinkingContentBox = bubble.querySelector(".chat-thinking-block.chat-thinking-open .chat-thinking-content");
                    if (thinkingContentBox) thinkingContentBox.scrollTop = thinkingContentBox.scrollHeight;
                }
            }

            scrollChatToBottom({ behavior: 'auto' });
        }

        function processOneSSEEvent(eventType, data) {
            if (!data) return;
            if (eventType === "thinking") {
                try {
                    const p = JSON.parse(data);
                    if (!thinkingStartTime) thinkingStartTime = Date.now();
                    pendingPhase = 'thinking';
                    pendingPhaseLabel = 'Se gândește';
                    thinkingContent += p.content || "";
                    const streamEl = bubble.querySelector(".chat-thinking-stream");
                    if (streamEl) {
                        streamEl.innerHTML = escapeHtml(thinkingContent).replace(/\n/g, "<br>");
                        const contentBox = streamEl.closest(".chat-thinking-content");
                        if (contentBox) {
                            // Auto-scroll thinking content only if user opened it
                            const block = streamEl.closest(".chat-thinking-block");
                            if (block && block.classList.contains("chat-thinking-open")) {
                                contentBox.scrollTop = contentBox.scrollHeight;
                            }
                        }
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
                            _tts.streamPush(ready);
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
                scheduleRender();
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
                    if (p.thinking != null) thinkingContent = p.thinking || "";
                    if (p.content != null) {
                        finalMessageContent = p.content || "";
                    }
                    if (p.model) finalModelName = p.model;
                    if (p.model_id) finalModelId = p.model_id;
                    if (!thinkingStartTime && thinkingContent) thinkingStartTime = Date.now() - 1000;
                    // Final render is handled once at stream end in doFinalRender().
                } catch (e) { /* ignore */ }
            }
        }

        const sseEventQueue = [];
        let sseDrainScheduled = false;
        function drainSSEQueue() {
            while (sseEventQueue.length > 0) {
                const { eventType, data } = sseEventQueue.shift();
                processOneSSEEvent(eventType, data);
            }
        }
        function scheduleSSEDrain() {
            if (sseDrainScheduled) return;
            sseDrainScheduled = true;
            setTimeout(() => {
                sseDrainScheduled = false;
                drainSSEQueue();
            }, 0);
        }
        function parseSSEEvents(chunk) {
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
            if (sseEventQueue.length > 0) scheduleSSEDrain();
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parseSSEEvents(decoder.decode(value, { stream: true }));
        }
        parseSSEEvents(decoder.decode());
        if (sseBuffer.trim()) parseSSEEvents("\n\n");
        // Flush remaining accumulated TTS text
        if (_ttsAccum.trim()) { _tts.streamPush(_ttsAccum.trim()); _ttsAccum = ''; }
        async function doFinalRender() {
            // Drain any remaining SSE events synchronously so nothing is lost
            drainSSEQueue();

            // Backend's final_message is the authoritative, complete response –
            // always prefer it over the chunked accumulation which may be
            // incomplete if the last TCP segment arrived at stream-close.
            if (typeof finalMessageContent === "string" && finalMessageContent) {
                fullText = finalMessageContent;
            }
            isStreaming = false;
            if (chunkThrottleTimer) { clearTimeout(chunkThrottleTimer); chunkThrottleTimer = 0; }
            if (scheduledRenderRAF) { cancelAnimationFrame(scheduledRenderRAF); scheduledRenderRAF = 0; }
            renderBubble(false);
            decorateCodeBlocks(bubble);
            decorateImages(bubble);

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
            appendConsciousnessFeedbackBar(bubble, aiBubbleId, responseStats);

            // Auto-speak response if triggered by voice input or always-speak
            const shouldAutoSpeak = window.__voiceInputPending || _tts.alwaysSpeak;
            if (window.__voiceInputPending) window.__voiceInputPending = false;

            if (shouldAutoSpeak && !_tts.streamWasActive()) {
                _speakBubble(bubble);
            }

            const activeSessionId = newSessionId || currentSessionId;
            if (activeSessionId) {
                try {
                    if (window.loadSessionsList) await window.loadSessionsList();
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
        doFinalRender();
    } catch (e) {
        const bubble = document.getElementById(aiBubbleId);
        if (e.name === 'AbortError') {
            finalizeStoppedStreamingBubble();
            if (bubble) {
                bubble.classList.remove('chat-bubble-typing');
                const mainPart = bubble.querySelector('.chat-bubble-main');
                if (mainPart && mainPart.textContent.trim()) {
                    // keep partial content already rendered
                } else {
                    bubble.innerHTML = '<div class="chat-bubble-content"><span class="text-slate-500"><i class="fas fa-stop-circle"></i> Stopped</span></div>';
                }
            }
        } else {
            let msg = t('chat.error_connection');
            // Show more detail when possible (e.g. 413 = payload too large, 422 = validation)
            if (e.message && e.message !== 'Failed to fetch') {
                msg += ` (${e.message})`;
            }
            console.error('[CHAT] Send error:', e);
            if (bubble) {
                bubble.classList.remove('chat-bubble-typing');
                bubble.innerHTML = `<div class="chat-bubble-content"><span class="chat-error"><i class="fas fa-exclamation-triangle"></i> ${msg}</span></div>`;
            }
        }
    } finally {
        _currentAbortController = null;
        setSendButtonState(false);
    }
}

// Încarcă istoricul unei sesiuni existente în UI
export async function loadSessionHistory(sessionId) {
    if (!sessionId) return;
    try {
        const res = await apiCall(`/api/sessions/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        const container = document.getElementById('chat-container');
        if (!container) return;
        container.innerHTML = '';

        const messages = data.messages || [];
        if (messages.length === 0) { showChatEmptyState(); }
        else {
            // Extract thinking content from an assistant message
            function _extractThinking(s) {
                if (!s) return "";
                const parts = [];
                const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
                let m;
                while ((m = re.exec(s)) !== null) parts.push(m[1].trim());
                return parts.join("\n\n");
            }
            // Strip <think>/<thinking> blocks from saved assistant messages
            function _stripThinkTags(s) {
                if (!s) return s || "";
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
            // Notification messages (notification: true) are rendered standalone as reminder bubbles.
            const turns = [];
            for (const m of messages) {
                if (m.notification) {
                    // Standalone notification — render as its own "turn" with no user message
                    turns.push({ notification: m });
                } else if (m.role === 'user') {
                    turns.push({ user: m, chain: [] });
                } else if (turns.length > 0 && turns[turns.length - 1].user) {
                    turns[turns.length - 1].chain.push(m);
                }
            }

            for (const turn of turns) {
                // Render standalone notification bubble
                if (turn.notification) {
                    const nid = turn.notification.notification_id;
                    if (nid) _shownNotificationIds.add(nid);  // prevent WS re-showing
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
                        if (m.profile_color) finalAssistantColor = m.profile_color;
                        if (m.model_name) persistedModelName = m.model_name;
                        if (m.model_id) persistedModelId = m.model_id;
                        if (m.response_stats) persistedResponseStats = m.response_stats;
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
                        } else {
                            const thinking = _extractThinking(m.content || "");
                            if (thinking) allThinking += (allThinking ? "\n\n" : "") + thinking;
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
                        } else {
                            // Final assistant message (no tool_calls) — this is the response
                            finalContent = _stripThinkTags(m.content || "");
                        }
                    }
                    // 'tool' role messages are results — we don't display them
                }

                if (!finalContent && !toolSteps.length && !allThinking) continue;

                // Build rich AI bubble with thinking + tool steps + content
                const thinkingDurationSec = (persistedResponseStats && persistedResponseStats.thinkingTime > 0)
                    ? (persistedResponseStats.thinkingTime / 1000).toFixed(1)
                    : null;
                const thinkingHtml = allThinking ? buildThinkingBlock(false, allThinking, thinkingDurationSec) : "";
                const stepsCount = toolSteps.length;
                const stepsHtml = stepsCount === 0 ? "" : `
                    <div class="chat-tools-row">
                        <div class="chat-steps">
                            ${toolSteps.map(s => `
                                <span class="chat-step">
                                    <i class="fas ${statusIcons[s.type] || statusIconFallback} chat-step-icon"></i>
                                    <span class="chat-step-label">${escapeHtml(s.label || "")}</span>
                                </span>
                            `).join("")}
                        </div>
                        ${stepsCount ? `<div class="chat-tools-summary">${escapeHtml((t("chat.used_tools") || "Used {n} tools").replace("{n}", String(stepsCount)))}</div>` : ""}
                    </div>`;

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
                                if (contentBox) contentBox.scrollTop = contentBox.scrollHeight;
                            }
                        });
                    }
                    decorateCodeBlocks(bubble);
                    decorateImages(bubble);
                    // Add action bar for history-loaded messages with persisted stats
                    const historyStats = {};
                    if (persistedModelName) historyStats.model = persistedModelName;
                    if (persistedModelId) historyStats.modelId = persistedModelId;
                    if (toolSteps.length > 0) historyStats.tools = toolSteps;
                    // Merge persisted response_stats (timing, tokens) from the saved session
                    if (persistedResponseStats) {
                        if (persistedResponseStats.elapsed) historyStats.elapsed = persistedResponseStats.elapsed;
                        if (persistedResponseStats.thinkingTime) historyStats.thinkingTime = persistedResponseStats.thinkingTime;
                        if (persistedResponseStats.generationTime) historyStats.generationTime = persistedResponseStats.generationTime;
                        if (persistedResponseStats.completionTokens) historyStats.completionTokens = persistedResponseStats.completionTokens;
                        if (persistedResponseStats.promptTokens) historyStats.promptTokens = persistedResponseStats.promptTokens;
                        if (persistedResponseStats.totalTokens) historyStats.totalTokens = persistedResponseStats.totalTokens;
                    }
                    appendConsciousnessFeedbackBar(bubble, null, Object.keys(historyStats).length > 0 ? historyStats : null);
                }
            }
        }

        setCurrentSessionId(data.id);
        setSessionDisplay(data.title || t('sessions.new_chat'));

        // Scroll la ultimul mesaj (de obicei răspunsul AI), nu la ultimul mesaj user
        chatAutoScrollPinnedToBottom = true;
        scrollChatToBottom({ behavior: 'auto', force: true });
    } catch (e) {
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
    if (!message) return;
    try { new Audio('/static/ding.mp3').play(); } catch(e){}
    const role = (type === 'automation') ? 'automation' : 'reminder';
    appendMessage(role, message);
    chatAutoScrollPinnedToBottom = true;
    scrollChatToBottom({ behavior: 'smooth', force: true });
}

// Global function for Android native bridge to show a notification message in chat.
// Called when user taps a system notification — shows the message as a chat bubble.
// If a session_id is provided and matches the current session, just append.
// If different session, switch to that session first.
window.__meminiShowNotification = function(title, message, sessionId) {
    if (!message) return;
    if (sessionId && sessionId !== currentSessionId) {
        // Switch to the notification's session, which will load history including the notification
        loadSessionHistory(sessionId);
    } else {
        _showNotificationBubble(message);
    }
};

export function initNotifications(userId) {
    let ws = null;
    let wsReconnectAttempts = 0;
    let _wsReconnectTimer = null;
    const maxWsReconnect = 10;
    let _wsEnabled = true;

    async function _loadWsEnabledFromConfig() {
        try {
            const res = await apiCall('/api/config');
            if (!res.ok) return true;
            const cfg = await res.json();
            const fcm = cfg?.fcm || {};
            const mode = String(fcm.transport_mode || 'websocket').toLowerCase();
            const wsEnabledFlag = fcm.websocket_enabled !== false;
            return wsEnabledFlag && mode !== 'firebase';
        } catch (_) {
            return true;
        }
    }

    // --- WebSocket for instant notifications ---
    async function connectWebSocket() {
        if (!_wsEnabled) {
            stop();
            return;
        }

        const token = localStorage.getItem('memini_token');
        if (!token) {
            console.warn('[WS] No memini_token in localStorage — skipping WebSocket');
            return;
        }

        // Get short-lived exchange token for WS (avoids passing long-lived JWT in URL)
        let wsToken = token;
        try {
            const { getSSEToken } = await import('./api.js');
            wsToken = await getSSEToken();
        } catch (_) {}

        // Close existing connection before creating a new one (prevent duplicates)
        if (ws) {
            try {
                if (ws._pingInterval) clearInterval(ws._pingInterval);
                ws.onclose = null;  // Prevent reconnect from old close handler
                ws.onerror = null;
                ws.onmessage = null;
                ws.close();
            } catch(e) {}
            ws = null;
        }
        
        try {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${proto}//${location.host}/ws/notifications?token=${wsToken}`;
            console.log('[WS] Connecting to', wsUrl.substring(0, 60) + '...');
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log('[WS] Notification WebSocket connected');
                wsReconnectAttempts = 0;
                // Keep-alive ping every 30s
                ws._pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
                }, 30000);
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'reminder' || data.type === 'automation') {
                        const isSettingsTest = String(data.notification_id || '').startsWith('test_ws_') || String(data.notification_id || '').startsWith('test_fcm_');
                        if (isSettingsTest) {
                            showToast('Test WebSocket primit ✓', 'success', 3500);
                            return;
                        }

                        // Dedup: track notification_id to prevent showing same notification twice
                        const nid = data.notification_id;
                        if (nid && _shownNotificationIds.has(nid)) {
                            console.log('[WS] Skipping duplicate notification:', nid);
                            return;
                        }
                        if (nid) _shownNotificationIds.add(nid);
                        // Keep dedup set small (max 200 entries)
                        if (_shownNotificationIds.size > 200) {
                            const it = _shownNotificationIds.values();
                            for (let i = 0; i < 100; i++) _shownNotificationIds.delete(it.next().value);
                        }

                        const notifSessionId = data.session_id;
                        if (notifSessionId && notifSessionId === currentSessionId) {
                            // Notification belongs to current session — just append the bubble
                            // (it's already persisted server-side in the session JSON)
                            _showNotificationBubble(data.message, data.type);
                        } else if (notifSessionId && notifSessionId !== currentSessionId) {
                            // Notification is for a different session — show a toast
                            showToast(data.message, 'info', 5000);
                            try { new Audio('/static/ding.mp3').play(); } catch(e){}
                        } else {
                            // No session_id in payload (legacy) — just append
                            _showNotificationBubble(data.message, data.type);
                        }
                    }
                    // pong is just a keepalive response, ignore
                } catch(e) {}
            };
            
            ws.onclose = () => {
                if (ws?._pingInterval) clearInterval(ws._pingInterval);
                ws = null;
                // Reconnect with backoff — tracked to prevent duplicates
                if (_wsReconnectTimer) clearTimeout(_wsReconnectTimer);
                if (_wsEnabled && wsReconnectAttempts < maxWsReconnect) {
                    wsReconnectAttempts++;
                    const delay = Math.min(wsReconnectAttempts * 5000, 30000);
                    _wsReconnectTimer = setTimeout(() => {
                        _wsReconnectTimer = null;
                        connectWebSocket();
                    }, delay);
                }
            };
            
            ws.onerror = (err) => {
                console.error('[WS] WebSocket error:', err);
            };
        } catch(e) {
            console.warn('[WS] WebSocket connection failed:', e);
        }
    }

    function stop() {
        if (ws) {
            try {
                if (ws._pingInterval) clearInterval(ws._pingInterval);
                ws.onclose = null;
                ws.close();
            } catch(e) {}
            ws = null;
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Reconnect WS if disconnected when tab becomes visible
            // Cancel any pending reconnect first to prevent duplicates
            if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
            if (_wsEnabled && (!ws || ws.readyState !== WebSocket.OPEN)) connectWebSocket();
        }
    });

    async function setEnabled(enabled) {
        const next = !!enabled;
        if (_wsEnabled === next) return;
        _wsEnabled = next;
        if (!_wsEnabled) {
            stop();
            if (_wsReconnectTimer) {
                clearTimeout(_wsReconnectTimer);
                _wsReconnectTimer = null;
            }
            return;
        }
        wsReconnectAttempts = 0;
        connectWebSocket();
    }

    // Start WebSocket only when transport config allows it.
    _loadWsEnabledFromConfig().then((enabled) => {
        _wsEnabled = !!enabled;
        if (_wsEnabled) connectWebSocket();
        else stop();
    });

    // Check for pending notification from Android cold-start (set before JS modules loaded)
    if (window.__pendingMeminiNotification) {
        const pn = window.__pendingMeminiNotification;
        delete window.__pendingMeminiNotification;
        window.__meminiShowNotification(pn.title, pn.message, pn.sessionId);
    }

    return { stop, setEnabled, isEnabled: () => !!_wsEnabled };
}