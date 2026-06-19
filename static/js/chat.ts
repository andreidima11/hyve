/**
 * Chat UI facade — re-exports domain modules under static/js/chat/.
 */

import './chat/marked_setup.js';
import { authToken } from './api.js';
import { getMediaProxyToken } from './camera_auth.js';

import {
    addAttachedDocument,
    addAttachedImage,
    clearAttachedDocument,
    clearAttachedImage,
    getAttachedDocumentFileName,
    getAttachedDocumentText,
    getAttachedImageBase64,
    waitForImageReady,
} from './chat/attachments.js';
import {
    applyInitialGreeting,
    maybeRefreshAiGreetings,
    showChatEmptyState,
} from './chat/empty_state.js';
import { loadSessionHistory } from './chat/history.js';
import { appendMessage } from './chat/render.js';
import { handleSlashInput, handleSlashKeydown } from './chat/slash.js';
import {
    currentSessionId,
    setCurrentSessionId,
    setSessionDisplay,
} from './chat/session_state.js';
import { sendMessage } from './chat/streaming.js';
import { stopStreaming } from './chat/stream_control.js';
import { getTts } from './chat/tts.js';

export {
    addAttachedDocument,
    addAttachedImage,
    appendMessage,
    applyInitialGreeting,
    clearAttachedDocument,
    clearAttachedImage,
    currentSessionId,
    getAttachedDocumentFileName,
    getAttachedDocumentText,
    getAttachedImageBase64,
    getTts,
    handleSlashInput,
    handleSlashKeydown,
    loadSessionHistory,
    maybeRefreshAiGreetings,
    sendMessage,
    setCurrentSessionId,
    setSessionDisplay,
    showChatEmptyState,
    stopStreaming,
    waitForImageReady,
};

if (authToken) {
    getMediaProxyToken().catch(() => {});
}

window.__chatExports = { sendMessage };
