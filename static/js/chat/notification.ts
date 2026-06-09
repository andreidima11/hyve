/** Short audio cue when a reminder/automation bubble arrives. */

export function playNotificationCue(): void {
    if (typeof window.__hyvePlayNotificationCue === 'function') {
        window.__hyvePlayNotificationCue();
        return;
    }
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const ctx = new AudioContextClass();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const now = ctx.currentTime;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.2);
        setTimeout(() => { try { ctx.close(); } catch (_) {} }, 320);
    } catch (_) {}
}
