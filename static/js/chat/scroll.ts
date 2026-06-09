/**
 * Chat message list auto-scroll tracking.
 */

const CHAT_AUTO_SCROLL_THRESHOLD = 10;
let chatAutoScrollPinnedToBottom = true;
let chatScrollTrackingInitialized = false;
let chatProgrammaticScroll = false;

function getChatWrapper(): Element | null {
    return document.querySelector('.chat-messages-wrapper');
}

function isNearBottom(el: Element, threshold = CHAT_AUTO_SCROLL_THRESHOLD): boolean {
    const scrollEl = el as HTMLElement;
    return (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= threshold;
}

function initChatScrollTracking(): void {
    const wrapper = getChatWrapper();
    if (!wrapper || chatScrollTrackingInitialized) return;
    chatScrollTrackingInitialized = true;
    chatAutoScrollPinnedToBottom = isNearBottom(wrapper);
    wrapper.addEventListener('scroll', () => {
        if (chatProgrammaticScroll) return;
        chatAutoScrollPinnedToBottom = isNearBottom(wrapper);
    }, { passive: true });
}

export function scrollChatToBottom(
    options: { behavior?: ScrollBehavior; force?: boolean } = {},
): void {
    const { behavior = 'auto', force = false } = options;
    const wrapper = getChatWrapper() as HTMLElement | null;
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
