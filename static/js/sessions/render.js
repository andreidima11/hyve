/**
 * Chat sessions — delete confirm button HTML.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
export function sessionDeleteWrapHtml(id) {
    const sessionId = escapeHtml(id || '');
    return `
        <button type="button" class="w-6 h-6 rounded-lg flex items-center justify-center text-emerald-400 hover:bg-emerald-500/20 transition-all" title="${t('common.confirm')}" data-chat-action="confirmDeleteSession" data-chat-session-id="${sessionId}">
            <i class="fas fa-check text-[10px]"></i>
        </button>
        <button type="button" class="w-6 h-6 rounded-lg flex items-center justify-center text-slate-400 hover:bg-white/10 transition-all" title="${t('common.cancel')}" data-chat-action="cancelDeleteSession" data-chat-session-id="${sessionId}">
            <i class="fas fa-xmark text-[10px]"></i>
        </button>
    `;
}
export function sessionDeleteButtonHtml(id, deleteTip) {
    const sessionId = escapeHtml(id || '');
    return `
        <button type="button" class="w-6 h-6 rounded-lg text-[10px] text-slate-500 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-all" title="${deleteTip}" data-chat-action="deleteSession" data-chat-session-id="${sessionId}">
            <i class="fas fa-xmark"></i>
        </button>
    `;
}
