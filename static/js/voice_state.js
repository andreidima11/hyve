/** Shared voice/TTS coordination flags (avoids window.__voice* globals). */

let _voiceLoopActive = false;
let _voiceInputPending = false;

export function isVoiceLoopActive() {
    return _voiceLoopActive;
}

export function setVoiceLoopActive(on) {
    _voiceLoopActive = !!on;
}

export function toggleVoiceLoopActive() {
    _voiceLoopActive = !_voiceLoopActive;
    return _voiceLoopActive;
}

export function isVoiceInputPending() {
    return _voiceInputPending;
}

export function setVoiceInputPending(on) {
    _voiceInputPending = !!on;
}
