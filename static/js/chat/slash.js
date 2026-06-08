/**
 * Slash commands and autocomplete popup.
 */

import { apiCall, suppressLogout } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { appendMessage } from './render.js';
import { scrollChatToBottom } from './scroll.js';
import { currentSessionId } from './session_state.js';

// ── SLASH COMMANDS ──────────────────────────────────────────────────
let _slashCommandsCache = null;

async function fetchSlashCommands() {
    if (_slashCommandsCache) return _slashCommandsCache;
    try {
        const res = await apiCall('/api/slash/commands');
        if (res.ok) {
            _slashCommandsCache = await res.json();
            return _slashCommandsCache;
        }
    } catch (e) { /* ignore */ }
    return [];
}

/** Show a system-style bubble with the slash command result */
function appendSlashResult(text) {
    const container = document.getElementById('chat-container');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-row chat-row-ai animate-up';
    div.innerHTML = `
        <div class="chat-msg chat-msg-ai">
            <div class="chat-bubble ai-bubble chat-bubble-slash">
                <div class="chat-bubble-content prose prose-invert prose-sm">
                    ${DOMPurify.sanitize(marked.parse(text))}
                </div>
            </div>
        </div>`;
    container.appendChild(div);
    requestAnimationFrame(() => scrollChatToBottom({ behavior: 'smooth', force: true }));
}

export async function handleSlashCommand(msg) {
    const input = document.getElementById('user-input');
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }
    hideSlashAutocomplete();
    appendMessage('user', msg);

    try {
        const res = await apiCall('/api/slash', {
            method: 'POST',
            body: { command: msg, session_id: currentSessionId },
        });
        const data = await res.json();
        appendSlashResult(data.message || (data.ok ? '✅ Done.' : '❌ Failed.'));

        // Handle post-command actions
        const action = data.action;
        if (action === 'clear_context') {
            const { clearSessionContext } = await import('./features_sessions.js');
            await clearSessionContext();
        } else if (action === 'new_session') {
            const { newChatSession } = await import('./features_sessions.js');
            await newChatSession();
        } else if (action === 'restart') {
            suppressLogout(true);
            showToast(t('chat.server_restarting'), 'info', 8000);
            _startSlashReconnectPolling();
        } else if (action === 'stop') {
            showToast(t('chat.server_stopped'), 'info', 10000);
        }
    } catch (e) {
        appendSlashResult('❌ Command failed: ' + (e.message || 'network error'));
    }
}

function _startSlashReconnectPolling() {
    let attempts = 0;
    const tryReconnect = () => {
        attempts++;
        fetch('/api/health', { method: 'GET', credentials: 'same-origin' })
            .then(r => { if (r.ok) { suppressLogout(false); location.reload(); } })
            .catch(() => {})
            .finally(() => { if (attempts < 30) setTimeout(tryReconnect, 2000); else suppressLogout(false); });
    };
    setTimeout(tryReconnect, 3000);
}

// ── SLASH AUTOCOMPLETE ──────────────────────────────────────────────
let _slashPopup = null;
let _slashSelectedIdx = -1;
let _slashFiltered = [];

function ensureSlashPopup() {
    if (_slashPopup) return _slashPopup;
    const popup = document.createElement('div');
    popup.id = 'slash-autocomplete';
    popup.className = 'slash-autocomplete hidden';
    const wrapper = document.querySelector('.chat-input-inner') || document.querySelector('.chat-input-wrapper') || document.body;
    wrapper.style.position = 'relative';
    wrapper.appendChild(popup);
    _slashPopup = popup;
    popup.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.slash-autocomplete-item');
        if (item) {
            e.preventDefault();
            const cmd = item.dataset.command;
            const input = document.getElementById('user-input');
            if (input) input.value = cmd + ' ';
            hideSlashAutocomplete();
            if (input) input.focus();
        }
    });
    return popup;
}

function showSlashAutocomplete(filtered) {
    const popup = ensureSlashPopup();
    _slashFiltered = filtered;
    _slashSelectedIdx = -1;
    if (!filtered.length) { popup.classList.add('hidden'); return; }
    popup.innerHTML = filtered.map((c, i) => 
        `<div class="slash-autocomplete-item${i === _slashSelectedIdx ? ' selected' : ''}" data-command="${escapeHtml(c.command)}">
            <span class="slash-cmd">${escapeHtml(c.command)}</span>
            <span class="slash-desc">${escapeHtml(c.description)}</span>
            ${c.admin ? '<span class="slash-admin">admin</span>' : ''}
        </div>`
    ).join('');
    popup.classList.remove('hidden');
}

function hideSlashAutocomplete() {
    if (_slashPopup) _slashPopup.classList.add('hidden');
    _slashFiltered = [];
    _slashSelectedIdx = -1;
}

function updateSlashSelection(idx) {
    if (!_slashPopup) return;
    _slashSelectedIdx = idx;
    const items = _slashPopup.querySelectorAll('.slash-autocomplete-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === idx));
}

export function handleSlashInput(value) {
    if (!value.startsWith('/')) { hideSlashAutocomplete(); return; }
    const typed = value.toLowerCase();
    fetchSlashCommands().then(cmds => {
        const filtered = cmds.filter(c => c.command.startsWith(typed));
        showSlashAutocomplete(filtered);
    });
}

export function handleSlashKeydown(e) {
    if (!_slashPopup || _slashPopup.classList.contains('hidden') || !_slashFiltered.length) return false;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        updateSlashSelection(Math.min(_slashSelectedIdx + 1, _slashFiltered.length - 1));
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        updateSlashSelection(Math.max(_slashSelectedIdx - 1, 0));
        return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && _slashSelectedIdx >= 0)) {
        e.preventDefault();
        const sel = _slashFiltered[_slashSelectedIdx >= 0 ? _slashSelectedIdx : 0];
        if (sel) {
            const input = document.getElementById('user-input');
            if (input) { input.value = sel.command + ' '; input.focus(); }
        }
        hideSlashAutocomplete();
        return true;
    }
    if (e.key === 'Escape') {
        hideSlashAutocomplete();
        return true;
    }
    return false;
}
