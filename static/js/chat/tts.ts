// @ts-nocheck — tighten types in a follow-up pass.
/**
 * Piper/TTS playback manager and bubble context menu.
 */

import { isVoiceLoopActive, isVoiceInputPending, setVoiceInputPending } from '../voice_state.js';

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
        if (!this._isPiperOn()) return;

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
            const tts = getTts();
            if (tts) tts.speak(bubble, { fromOffset: offset });
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
        for (const id of ['piper_enabled', 'integrations-piper-enabled']) {
            const pip = document.getElementById(id);
            if (pip && pip.type === 'checkbox') return !!pip.checked;
        }
        return false;
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
            const wasVoiceLoop = isVoiceLoopActive();
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
        const shouldStream = isVoiceInputPending() || this.alwaysSpeak;
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
            this._emit('ended', { bubble: this._streamBubble, voiceLoop: isVoiceLoopActive() });
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

/** @returns {typeof _tts} Piper/TTS controller singleton. */
export function getTts() {
    return _tts;
}

/** Speak a bubble's text — convenience wrapper */
export async function speakBubble(bubble, opts) {
    return _tts.speak(bubble, opts);
}
