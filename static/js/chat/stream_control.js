/**
 * Chat stream abort control and stop-button state.
 */
let _currentAbortController = null;
export function finalizeStoppedStreamingBubble() {
    document.querySelectorAll('.ai-bubble').forEach((bubble) => {
        const hasStreamingMarker = bubble.classList.contains('chat-bubble-typing')
            || bubble.querySelector('.chat-thinking-block.chat-thinking-streaming')
            || bubble.querySelector('.chat-stream-cursor')
            || bubble.querySelector('.chat-code-block.chat-code-streaming')
            || bubble.querySelector('.chat-pending-indicator');
        if (!hasStreamingMarker)
            return;
        bubble.classList.remove('chat-bubble-typing');
        bubble.querySelector('.chat-stream-cursor')?.remove();
        bubble.querySelectorAll('.chat-code-block.chat-code-streaming').forEach((block) => {
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
        const mainContent = bubble.querySelector('.chat-bubble-main .chat-bubble-content')
            || bubble.querySelector('.chat-bubble-content');
        if (mainContent) {
            const typingDots = mainContent.querySelector('.chat-pending-indicator');
            if (typingDots && !mainContent.textContent?.trim()) {
                mainContent.innerHTML = '<span class="text-slate-500"><i class="fas fa-stop-circle"></i> Stopped</span>';
            }
            else if (typingDots) {
                typingDots.remove();
            }
        }
    });
}
export function setSendButtonState(streaming) {
    const btn = document.getElementById('btn-send');
    if (!btn)
        return;
    const icon = btn.querySelector('i');
    if (!icon)
        return;
    if (streaming) {
        icon.className = 'fas fa-stop';
        btn.classList.add('streaming');
    }
    else {
        icon.className = 'fas fa-paper-plane';
        btn.classList.remove('streaming');
    }
}
export function stopStreaming() {
    if (_currentAbortController) {
        _currentAbortController.abort();
        _currentAbortController = null;
        setSendButtonState(false);
        finalizeStoppedStreamingBubble();
        requestAnimationFrame(() => finalizeStoppedStreamingBubble());
        setTimeout(() => finalizeStoppedStreamingBubble(), 120);
    }
}
export function getStreamAbortController() {
    return _currentAbortController;
}
export function setStreamAbortController(controller) {
    _currentAbortController = controller;
}
export function clearStreamAbortController() {
    _currentAbortController = null;
}
