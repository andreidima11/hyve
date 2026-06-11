import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { setCurrentSessionId, loadSessionHistory, currentSessionId, setSessionDisplay, showChatEmptyState } from '../chat.js';
import { escapeHtml, showToast } from '../utils.js';
import { switchTab, toggleSidebar } from '../nav_bridge.js';
import { sessionDeleteButtonHtml, sessionDeleteWrapHtml } from './render.js';
async function findExistingEmptySession(excludeSessionId = null) {
    try {
        const res = await apiCall('/api/sessions');
        if (!res.ok)
            return null;
        const sessions = await res.json();
        if (!Array.isArray(sessions) || sessions.length === 0)
            return null;
        const candidates = sessions.filter(s => s?.id && s.id !== excludeSessionId).slice(0, 3);
        for (const session of candidates) {
            try {
                const detailRes = await apiCall(`/api/sessions/${session.id}`);
                if (!detailRes.ok)
                    continue;
                const detail = await detailRes.json();
                if (Array.isArray(detail?.messages) && detail.messages.length === 0) {
                    return detail;
                }
            }
            catch (_) { }
        }
    }
    catch (_) { }
    return null;
}
export async function loadSessionsList() {
    const listEl = document.getElementById('sessions-list');
    if (!listEl)
        return;
    try {
        const res = await apiCall('/api/sessions');
        if (!res.ok)
            return;
        const sessions = await res.json();
        if (!Array.isArray(sessions) || sessions.length === 0) {
            listEl.innerHTML = `<div class="text-[10px] text-slate-600 px-2 py-2 italic">${t('sessions.empty')}</div>`;
            return;
        }
        const deleteTip = t('sessions.delete_tooltip');
        const newChatTitle = t('sessions.new_chat');
        listEl.innerHTML = sessions.map(s => {
            const title = escapeHtml(s.title || newChatTitle);
            const sessionId = escapeHtml(s.id || '');
            return `
                <div 
                    class="w-full flex items-center gap-2 session-item group rounded-xl hover:bg-white/5 text-slate-300 px-2 py-1"
                    data-id="${sessionId}"
                >
                    <button 
                        type="button"
                        class="flex-1 text-left text-[11px] px-2 py-1 rounded-lg truncate"
                        data-chat-action="openSession"
                        data-chat-session-id="${sessionId}"
                    >
                        ${title}
                    </button>
                    <span class="session-delete-wrap flex items-center gap-0.5" data-session-id="${sessionId}">
                        <button 
                            type="button"
                            class="w-6 h-6 rounded-lg text-[10px] text-slate-500 hover:text-red-400 hover:bg-red-500/10 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-all"
                            title="${deleteTip}"
                            data-chat-action="deleteSession"
                            data-chat-session-id="${sessionId}"
                        >
                            <i class="fas fa-xmark"></i>
                        </button>
                    </span>
                </div>
            `;
        }).join('');
    }
    catch (_) {
        listEl.innerHTML = `<div class="text-[10px] text-red-400 px-2 py-2">${t('sessions.load_error')}</div>`;
    }
}
export async function openSession(id) {
    if (!id)
        return;
    switchTab('chat');
    await loadSessionHistory(id);
    setCurrentSessionId(id);
    document.querySelectorAll('.session-item').forEach(btn => {
        if (btn.getAttribute('data-id') === id) {
            btn.classList.add('bg-white/10', 'text-accent');
        }
        else {
            btn.classList.remove('bg-white/10', 'text-accent');
        }
    });
}
export async function newChatSession() {
    switchTab('chat');
    if (currentSessionId) {
        const container = document.getElementById('chat-container');
        const hasMessages = container && container.querySelector('.chat-row');
        if (!hasMessages)
            return;
        const existingEmptySession = await findExistingEmptySession(currentSessionId);
        if (existingEmptySession?.id) {
            await openSession(existingEmptySession.id);
            return;
        }
    }
    else {
        const existingEmptySession = await findExistingEmptySession();
        if (existingEmptySession?.id) {
            await openSession(existingEmptySession.id);
            return;
        }
    }
    try {
        const res = await apiCall('/api/sessions', { method: 'POST' });
        if (!res.ok)
            return;
        const session = await res.json();
        if (!session.id)
            return;
        setCurrentSessionId(session.id);
        setSessionDisplay(t('sessions.new_chat'));
        const container = document.getElementById('chat-container');
        if (container)
            container.innerHTML = '';
        await loadSessionsList();
        await openSession(session.id);
    }
    catch (_) {
        showToast(t('sessions.create_error'), 'error');
    }
}
export function deleteSession(id, evt) {
    if (evt) {
        evt.stopPropagation();
        evt.preventDefault();
    }
    if (!id)
        return;
    const row = document.querySelector(`.session-item[data-id="${id}"]`);
    const wrap = row?.querySelector('.session-delete-wrap');
    if (!wrap || wrap.querySelector('[data-chat-action="confirmDeleteSession"]'))
        return;
    wrap.innerHTML = sessionDeleteWrapHtml(id);
}
export function cancelDeleteSession(id) {
    const row = document.querySelector(`.session-item[data-id="${id}"]`);
    const wrap = row?.querySelector('.session-delete-wrap');
    if (!wrap)
        return;
    wrap.innerHTML = sessionDeleteButtonHtml(id, t('sessions.delete_tooltip'));
}
export async function confirmDeleteSession(id) {
    if (!id)
        return;
    try {
        const res = await apiCall(`/api/sessions/${id}`, { method: 'DELETE' });
        if (!res.ok)
            return;
        if (id === currentSessionId) {
            const container = document.getElementById('chat-container');
            if (container)
                container.innerHTML = '';
            setCurrentSessionId(null);
            showChatEmptyState();
        }
        await loadSessionsList();
    }
    catch (_) {
        showToast(t('sessions.delete_error'), 'error');
    }
}
function _closeSidebarOnMobileIfOpen() {
    if (window.innerWidth >= 1024)
        return;
    const sb = document.getElementById('sidebar');
    const isOpen = !!(sb && !sb.classList.contains('-translate-x-full'));
    if (isOpen)
        toggleSidebar();
}
export async function clearSessionContext() {
    const clearBtn = document.getElementById('btn-clear-context');
    _closeSidebarOnMobileIfOpen();
    if (clearBtn) {
        clearBtn.classList.add('is-clearing');
        clearBtn.disabled = true;
    }
    if (!currentSessionId) {
        if (clearBtn) {
            clearBtn.classList.remove('is-clearing');
            clearBtn.disabled = false;
        }
        return;
    }
    try {
        const res = await apiCall(`/api/sessions/${currentSessionId}/clear-context`, { method: 'POST' });
        if (!res.ok)
            return;
        const container = document.getElementById('chat-container');
        if (container)
            container.innerHTML = '';
        setSessionDisplay(t('sessions.new_chat'));
        showChatEmptyState();
    }
    catch (_) {
        showToast(t('sessions.clear_context_error'), 'error');
    }
    finally {
        if (clearBtn) {
            clearBtn.classList.remove('is-clearing');
            clearBtn.disabled = false;
        }
    }
}
