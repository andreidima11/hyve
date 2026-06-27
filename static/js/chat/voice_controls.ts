/**
 * Show/hide chat microphone (Whisper) and TTS (Piper) controls from integration state.
 */
import { getIntegrationCatalog } from '../integrations/catalog_meta.js';
import { findIntegrationCheckbox } from '../integrations/utils.js';
import { toggleVoiceRecording, isVoiceLoopActive } from '../voice.js';

function _integrationEnabled(slug: string): boolean {
    const fromCatalog = getIntegrationCatalog().find((e) => String(e.slug || '') === slug);
    if (fromCatalog) return !!fromCatalog.enabled;
    const cb = findIntegrationCheckbox(slug);
    return !!(cb && cb.checked);
}

export function syncChatVoiceControls(): void {
    const whisperOn = _integrationEnabled('whisper');
    const piperOn = _integrationEnabled('piper');

    const voiceWrap = document.querySelector('.voice-btn-wrap') as HTMLElement | null;
    const voiceBtn = document.getElementById('btn-voice') as HTMLButtonElement | null;
    if (voiceWrap) voiceWrap.classList.toggle('hidden', !whisperOn);
    if (voiceBtn) {
        voiceBtn.classList.toggle('hidden', !whisperOn);
        if (!whisperOn) {
            if (voiceBtn.classList.contains('recording')) {
                toggleVoiceRecording({ btn: voiceBtn });
            } else {
                voiceBtn.disabled = false;
                voiceBtn.classList.remove('recording');
                const icon = voiceBtn.querySelector('i');
                if (icon) icon.className = isVoiceLoopActive() ? 'fas fa-sync-alt' : 'fas fa-microphone';
            }
        }
    }

    const ttsSection = document.getElementById('chat-tts-menu-section');
    const alwaysSpeakBtn = document.getElementById('btn-always-speak');
    if (ttsSection) ttsSection.classList.toggle('hidden', !piperOn);
    if (alwaysSpeakBtn) alwaysSpeakBtn.classList.toggle('hidden', !piperOn);
}
