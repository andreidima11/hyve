/**
 * Voice recording, voice loop, always-speak UI, and keyboard shortcuts.
 */
import { t } from './lang/index.js';
import { showToast } from './utils.js';
import { getTts } from './chat.js';
import {
    isVoiceLoopActive,
    toggleVoiceLoopActive,
    setVoiceInputPending,
} from './voice_state.js';

interface VoiceRecordingOpts {
    btn?: HTMLElement | null;
    inputId?: string;
    sendFn?: (() => void) | null;
}

interface HyveTtsController {
    alwaysSpeak: boolean;
    audio: HTMLAudioElement | null;
    _streamPlaying?: boolean;
    stop?: () => void;
    speak?: (bubble: Element) => Promise<void>;
}

interface VoiceButton extends HTMLButtonElement {}

let _voiceMediaRecorder: MediaRecorder | null = null;
let _voiceChunks: Blob[] = [];
let _voiceStream: MediaStream | null = null;
let _voiceAudioCtx: AudioContext | null = null;
let _voiceSilenceTimer: number | null = null;
let _VOICE_SILENCE_MS = 2500;
let _VOICE_SILENCE_RMS = 0.015;

function _voiceMicIconClass(): string {
    return isVoiceLoopActive() ? 'fas fa-sync-alt' : 'fas fa-microphone';
}

function _voiceBtnIcon(btn: VoiceButton): HTMLElement | null {
    return btn.querySelector('i');
}

export async function toggleVoiceRecording(opts?: VoiceRecordingOpts) {
    const _opts = opts || {};
    const btn = (_opts.btn || document.getElementById('btn-voice')) as VoiceButton | null;
    const inputId = _opts.inputId || 'user-input';
    const sendFn = _opts.sendFn || (window.sendMessage ? () => window.sendMessage!() : null);
    if (!btn) return;

    if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
        _voiceMediaRecorder.ondataavailable = null;
        _voiceMediaRecorder.onstop = null;
        _voiceMediaRecorder.stop();
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
        if (_voiceStream) { _voiceStream.getTracks().forEach(track => track.stop()); _voiceStream = null; }
        _voiceMediaRecorder = null;
        _voiceChunks = [];
        btn.classList.remove('recording');
        const icon = _voiceBtnIcon(btn);
        if (icon) icon.className = _voiceMicIconClass();
        btn.classList.add('flash-red-cancelled');
        setTimeout(() => {
            btn.classList.remove('flash-red-cancelled');
            setTimeout(() => {
                btn.classList.add('flash-red-cancelled');
                setTimeout(() => btn.classList.remove('flash-red-cancelled'), 150);
            }, 150);
        }, 150);
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (!isSecure) showToast(t('voice.requires_https'), 'error', 6000);
        else showToast(t('voice.mic_unavailable'), 'error');
        return;
    }

    try {
        _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        const err = e as DOMException;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showToast(t('voice.mic_denied'), 'error', 5000);
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            showToast(t('voice.mic_not_found'), 'error');
        } else {
            showToast(t('voice.mic_error_detail', { message: err.message }), 'error');
        }
        return;
    }

    _voiceChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus'
        : '';
    const options = mimeType ? { mimeType } : {};
    _voiceMediaRecorder = new MediaRecorder(_voiceStream, options);

    _voiceMediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) _voiceChunks.push(e.data);
    };

    _voiceMediaRecorder.onstop = async () => {
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }

        btn.classList.remove('recording');

        if (_voiceStream) {
            _voiceStream.getTracks().forEach(track => track.stop());
            _voiceStream = null;
        }

        if (_voiceChunks.length === 0) { _voiceMediaRecorder = null; return; }

        const recordedMime = _voiceMediaRecorder?.mimeType || 'audio/webm';
        _voiceMediaRecorder = null;
        const blob = new Blob(_voiceChunks, { type: recordedMime });
        _voiceChunks = [];

        btn.disabled = true;
        btn.classList.add('recording');
        const spinnerIcon = _voiceBtnIcon(btn);
        if (spinnerIcon) spinnerIcon.className = 'fas fa-spinner fa-spin';

        try {
            const formData = new FormData();
            formData.append('file', blob, 'recording.webm');

            const token = localStorage.getItem('hyve_token');
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = 'Bearer ' + token;

            const res = await fetch('/api/whisper/transcribe', {
                method: 'POST',
                headers,
                body: formData,
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({})) as { detail?: string };
                throw new Error(errData.detail || 'Transcription failed');
            }

            const data = await res.json() as { text?: string };
            if (data.text && data.text.trim()) {
                const input = document.getElementById(inputId) as HTMLTextAreaElement | null;
                if (input) {
                    const existing = input.value.trim();
                    input.value = existing ? existing + ' ' + data.text.trim() : data.text.trim();
                    input.style.height = 'auto';
                    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
                    input.focus();
                    if (sendFn) {
                        setVoiceInputPending(true);
                        setTimeout(() => sendFn(), 300);
                    }
                }
            } else {
                showToast(t('voice.no_speech'), 'info');
            }
        } catch (e) {
            showToast(t('voice.transcribe_error') + (e instanceof Error ? e.message : ''), 'error');
        } finally {
            btn.disabled = false;
            btn.classList.remove('recording');
            const micIcon = _voiceBtnIcon(btn);
            if (micIcon) micIcon.className = _voiceMicIconClass();
        }
    };

    _voiceMediaRecorder.onerror = () => {
        if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
        if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
        btn.classList.remove('recording');
        if (_voiceStream) {
            _voiceStream.getTracks().forEach(track => track.stop());
            _voiceStream = null;
        }
        _voiceMediaRecorder = null;
        showToast(t('voice.recording_error'), 'error');
    };

    btn.classList.add('recording');
    _voiceMediaRecorder.start(250);

    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) throw new Error('AudioContext unavailable');
        _voiceAudioCtx = new AudioCtx();
        const source = _voiceAudioCtx.createMediaStreamSource(_voiceStream);
        const analyser = _voiceAudioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let silenceStart: number | null = null;

        const checkLevel = () => {
            if (!_voiceMediaRecorder || _voiceMediaRecorder.state !== 'recording') return;
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / buf.length);

            if (rms < _VOICE_SILENCE_RMS) {
                if (!silenceStart) silenceStart = Date.now();
                else if (Date.now() - silenceStart >= _VOICE_SILENCE_MS) {
                    _voiceMediaRecorder.stop();
                    return;
                }
            } else {
                silenceStart = null;
            }
            _voiceSilenceTimer = requestAnimationFrame(checkLevel);
        };
        _voiceSilenceTimer = requestAnimationFrame(checkLevel);
    } catch (err) {
        console.warn('[VOICE] VAD init failed (fallback to manual stop):', err);
    }
}

function _syncVadSettings() {
    const ms = parseInt((document.getElementById('whisper_vad_silence_ms') as HTMLInputElement | null)?.value || '', 10);
    if (ms >= 500 && ms <= 10000) _VOICE_SILENCE_MS = ms;
    const sens = (document.getElementById('whisper_vad_sensitivity') as HTMLSelectElement | null)?.value || 'medium';
    const rmsMap: Record<string, number> = { low: 0.025, medium: 0.015, high: 0.008 };
    _VOICE_SILENCE_RMS = rmsMap[sens] || 0.015;
}

function _initAlwaysSpeakBtn() {
    const btn = document.getElementById('btn-always-speak') as VoiceButton | null;
    if (!btn) return;
    if (btn.dataset.boundAlwaysSpeak === '1') return;
    btn.dataset.boundAlwaysSpeak = '1';

    const tts = getTts() as unknown as HyveTtsController;
    if (tts && tts.alwaysSpeak) {
        btn.classList.add('active');
        const icon = _voiceBtnIcon(btn);
        if (icon) icon.className = 'fas fa-volume-up';
    }
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ttsCtrl = getTts() as unknown as HyveTtsController;
        if (!ttsCtrl) return;

        const isSpeakingNow = !!((ttsCtrl.audio && !ttsCtrl.audio.paused) || ttsCtrl._streamPlaying);
        if (isSpeakingNow && typeof ttsCtrl.stop === 'function') {
            try { ttsCtrl.stop(); } catch (_) {}
            return;
        }

        ttsCtrl.alwaysSpeak = !ttsCtrl.alwaysSpeak;
        btn.classList.toggle('active', ttsCtrl.alwaysSpeak);
        const icon = _voiceBtnIcon(btn);
        if (icon) icon.className = ttsCtrl.alwaysSpeak ? 'fas fa-volume-up' : 'fas fa-volume-off';

        if (ttsCtrl.alwaysSpeak) {
            for (const id of ['piper_enabled', 'integrations-piper-enabled']) {
                const piperCb = document.getElementById(id) as HTMLInputElement | null;
                if (piperCb && !piperCb.checked) piperCb.checked = true;
            }
        }

        if (ttsCtrl.alwaysSpeak) {
            const bubbles = document.querySelectorAll('.chat-row-ai .ai-bubble');
            const lastBubble = bubbles && bubbles.length ? bubbles[bubbles.length - 1] : null;
            if (lastBubble && typeof ttsCtrl.speak === 'function') {
                try { await ttsCtrl.speak(lastBubble); } catch (err) { console.warn('[TTS] speak failed:', err); }
            }
        } else if (typeof ttsCtrl.stop === 'function') {
            try { ttsCtrl.stop(); } catch (_) {}
        }

        try {
            localStorage.setItem('hyve_tts_always_speak', ttsCtrl.alwaysSpeak ? '1' : '0');
        } catch (_) {}
    });
}

function _initVoiceBalloon() {
    const voiceBtn = document.getElementById('btn-voice') as VoiceButton | null;
    const balloonEl = document.getElementById('voice-mode-balloon');
    const loopToggle = document.getElementById('voice-loop-toggle');
    const loopBadge = document.getElementById('voice-loop-badge');
    if (!voiceBtn || !balloonEl) return;
    const balloon = balloonEl;
    const activeVoiceBtn = voiceBtn;

    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let didLongPress = false;

    function closeBalloon() {
        balloon.classList.add('hidden');
    }
    function openBalloon() {
        balloon.classList.remove('hidden');
    }
    function _syncLoopUI() {
        const on = isVoiceLoopActive();
        if (loopBadge) {
            loopBadge.textContent = on ? 'ON' : 'OFF';
            loopBadge.classList.toggle('on', on);
            loopBadge.classList.toggle('off', !on);
        }
        activeVoiceBtn.classList.toggle('voice-loop-active', on);
        const icon = _voiceBtnIcon(activeVoiceBtn);
        if (icon && !activeVoiceBtn.classList.contains('recording')) {
            icon.className = on ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
        const tts = getTts() as unknown as HyveTtsController;
        if (on && tts) {
            tts.alwaysSpeak = true;
            const asBtn = document.getElementById('btn-always-speak') as VoiceButton | null;
            if (asBtn) {
                asBtn.classList.add('active');
                const asIcon = _voiceBtnIcon(asBtn);
                if (asIcon) asIcon.className = 'fas fa-volume-up';
            }
        }
    }

    activeVoiceBtn.addEventListener('touchstart', () => {
        didLongPress = false;
        longPressTimer = setTimeout(() => {
            didLongPress = true;
            if (balloon.classList.contains('hidden')) openBalloon();
            else closeBalloon();
        }, 500);
    }, { passive: true });
    activeVoiceBtn.addEventListener('touchend', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (didLongPress) e.preventDefault();
    });
    activeVoiceBtn.addEventListener('touchcancel', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    activeVoiceBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (balloon.classList.contains('hidden')) openBalloon();
        else closeBalloon();
    });

    activeVoiceBtn.addEventListener('click', () => {
        if (didLongPress) { didLongPress = false; return; }
        toggleVoiceRecording();
    });

    if (loopToggle) {
        loopToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleVoiceLoopActive();
            _syncLoopUI();
            closeBalloon();
        });
    }

    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (!target.closest('.voice-btn-wrap')) closeBalloon();
    });

    window.addEventListener('tts:ended', (e) => {
        if (!isVoiceLoopActive()) return;
        if (!e.detail?.voiceLoop) return;
        setTimeout(() => {
            if (isVoiceLoopActive()) toggleVoiceRecording();
        }, 400);
    });

    _syncLoopUI();
}

function _initVoiceKeyboardShortcuts() {
    let spaceHeld = false;

    document.addEventListener('keydown', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;

        if (e.code === 'Space' && !e.repeat) {
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && !voiceBtn.classList.contains('hidden')) {
                e.preventDefault();
                spaceHeld = true;
                if (!_voiceMediaRecorder || _voiceMediaRecorder.state !== 'recording') {
                    toggleVoiceRecording();
                }
            }
        }

        if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey) {
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && !voiceBtn.classList.contains('hidden')) {
                e.preventDefault();
                toggleVoiceRecording();
            }
        }

        const tts = getTts() as unknown as HyveTtsController;
        if (e.code === 'Escape' && tts?.stop) tts.stop();
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spaceHeld) {
            spaceHeld = false;
            if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
                _voiceMediaRecorder.stop();
            }
        }
    });
}

function _initVoiceUi() {
    _syncVadSettings();
    _initAlwaysSpeakBtn();
    _initVoiceBalloon();
    _initVoiceKeyboardShortcuts();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initVoiceUi);
} else {
    _initVoiceUi();
}

export { isVoiceLoopActive } from './voice_state.js';
