/** Shared voice/TTS coordination flags (avoids window.__voice* globals). */

let _voiceLoopActive = false;
let _voiceInputPending = false;

export function isVoiceLoopActive(): boolean {
    return _voiceLoopActive;
}

export function setVoiceLoopActive(on: boolean): void {
    _voiceLoopActive = !!on;
}

export function toggleVoiceLoopActive(): boolean {
    _voiceLoopActive = !_voiceLoopActive;
    return _voiceLoopActive;
}

export function isVoiceInputPending(): boolean {
    return _voiceInputPending;
}

export function setVoiceInputPending(on: boolean): void {
    _voiceInputPending = !!on;
}
