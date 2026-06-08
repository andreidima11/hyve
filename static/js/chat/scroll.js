/**
 * Chat message list auto-scroll tracking.
 */

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

export function scrollChatToBottom({ behavior = 'auto', force = false } = {}) {
    const wrapper = getChatWrapper();
    if (!wrapper) return;
    initChatScrollTracking();
    if (!force && !chatAutoScrollPinnedToBottom) return;

    chatProgrammaticScroll = true;
    if (force) chatAutoScrollPinnedToBottom = true;
    requestAnimationFrame(() => {
        wrapper.scrollTo({ top: wrapper.scrollHeight, behavior });
        setTimeout(() => { chatProgrammaticScroll = false; }, 400);
    });
}
