import { renderActiveConferenceMarkup } from './conference_render.js';

export function renderConferenceActiveView({
    container,
    conf,
    artifactVisible,
    checkConferenceVoiceButton,
}) {
    if (!container || !conf) return false;

    container.innerHTML = renderActiveConferenceMarkup(conf, artifactVisible);

    const msgContainer = document.getElementById('conf-messages');
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;

    const input = document.getElementById('conf-input');
    if (input) {
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });
    }

    checkConferenceVoiceButton();
    return true;
}
