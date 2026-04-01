/**
 * Shared utility functions used across multiple JS modules.
 */
import { t } from './lang/index.js';

// ─── Shared tool icon map (used by chat + conference) ───
export const TOOL_ICONS = {
    web_search: "fa-magnifying-glass",
    ha_command: "fa-bolt",
    skill: "fa-wand-magic-sparkles",
    run_shell: "fa-terminal",
    allow_shell: "fa-unlock",
    get_home_status: "fa-house",
    set_reminder: "fa-bell",
    set_automation: "fa-clock",
    list_reminders: "fa-list",
    cancel_reminder: "fa-bell-slash",
    search_web: "fa-magnifying-glass",
    search_web_images: "fa-image",
    read_web_page: "fa-book-open",
    extract_web_data: "fa-filter",
    recall_memory: "fa-brain",
    store_memory: "fa-floppy-disk",
    control_device: "fa-lightbulb",
    run_skill: "fa-wand-magic-sparkles",
    create_skill: "fa-code",
    suggest_shell: "fa-terminal",
    read_file: "fa-file-lines",
    run_script: "fa-code",
    propose_patch: "fa-pencil",
    propose_file: "fa-file-plus",
    forge_start: "fa-hammer",
    forge_coder: "fa-code",
    forge_repair: "fa-wrench",
    forge_validate: "fa-check-double",
    forge_dryrun: "fa-play",
    forge_save: "fa-floppy-disk",
    forge_done: "fa-check-circle",
    cctv_describe: "fa-video",
};
export const TOOL_ICON_FALLBACK = "fa-gear";

/** Return the Font Awesome icon class for a tool name. */
export function toolIcon(name) {
    return TOOL_ICONS[name] || TOOL_ICON_FALLBACK;
}

// ─── Shared sources renderer (used by chat + conference) ───

/**
 * Build the HTML for search-source citation cards.
 * @param {Array} sources – array of { url, domain?, link? } objects
 * @param {string} [label] – optional label override (defaults to i18n 'chat.sources_label' → "Surse")
 * @returns {string} HTML string
 */
export function buildSourcesHtml(sources, label) {
    if (!sources || !sources.length) return '';
    const labelText = label || t('chat.sources_label') || 'Surse';
    const cards = sources.map(src => {
        try {
            const rawUrl = (src.url || src.link || '').trim();
            let domainText = (src.domain || '').trim();
            if (!domainText && rawUrl) {
                try { domainText = new URL(rawUrl).hostname || ''; } catch (_) { domainText = ''; }
            }
            domainText = domainText.toLowerCase().replace(/^www\./i, '');
            const domain = escapeHtml(domainText);
            const url = rawUrl || '#';
            const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domainText)}&sz=16`;
            return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="chat-source-card" title="${domain}">
                <img src="${favicon}" alt="" class="chat-source-favicon" onerror="this.style.display='none'">
                <span class="chat-source-domain">${domain}</span>
            </a>`;
        } catch { return ''; }
    }).filter(Boolean).join('');
    if (!cards) return '';
    return `<div class="chat-sources-row">
        <div class="chat-sources-label"><i class="fas fa-book-open"></i> ${escapeHtml(labelText)}</div>
        <div class="chat-sources-list">${cards}</div>
    </div>`;
}

// ─── Shared Markdown renderer (non-streaming) ───

/** Parse markdown & sanitize. Used for finalized content in chat + conference. */
export function formatMarkdown(text) {
    if (!text) return '';
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        return DOMPurify.sanitize(marked.parse(text));
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * Creates a debounced version of a function that delays execution until
 * `delay` ms have passed since the last call.
 */
export function debounce(fn, delay = 250) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

export function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

export function getSessionId() {
    return localStorage.getItem('memini_session_id');
}

/* ─── Sub-page helpers ─── */

export function openSubPage(id) {
    const el = document.getElementById(id);
    if (!el) return;
    /* Scroll any overflow-auto ancestor to top so the absolute-positioned
       overlay covers the full viewport (not offset by scroll position). */
    const p = el.parentElement;
    if (p) {
        el._savedParentScroll = p.scrollTop;
        p.scrollTop = 0;
    }
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
}

export function closeSubPage(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    const p = el.parentElement;
    if (p && el._savedParentScroll != null) {
        p.scrollTop = el._savedParentScroll;
        delete el._savedParentScroll;
    }
}

export function closeAllSubPages() {
    document.querySelectorAll('.app-subpage.open').forEach(el => {
        el.classList.remove('open');
        el.setAttribute('aria-hidden', 'true');
    });
}

/* ─── Code editor helpers ─── */

const _codeEditors = new Map();

function _aceThemeForApp() {
    const sel = document.documentElement.getAttribute('data-theme') || 'dark';
    return sel === 'light' ? 'ace/theme/chrome' : 'ace/theme/monokai';
}

let _aceThemeObserverInit = false;
function _initAceThemeObserver() {
    if (_aceThemeObserverInit) return;
    _aceThemeObserverInit = true;
    new MutationObserver(() => {
        const theme = _aceThemeForApp();
        _codeEditors.forEach(editor => editor.setTheme(theme));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function setupCodeEditor({ textareaId, mode = 'text' }) {
    const textarea = document.getElementById(textareaId);
    if (!textarea || typeof window === 'undefined' || typeof window.ace === 'undefined') return null;

    _initAceThemeObserver();

    if (_codeEditors.has(textareaId)) {
        const existing = _codeEditors.get(textareaId);
        existing.getSession().setMode(`ace/mode/${mode}`);
        existing.setTheme(_aceThemeForApp());
        existing.resize(true);
        return existing;
    }

    const host = document.createElement('div');
    host.id = `${textareaId}-ace`;
    host.className = 'app-code-editor';
    textarea.insertAdjacentElement('afterend', host);
    textarea.classList.add('hidden');

    const editor = window.ace.edit(host);
    editor.setTheme(_aceThemeForApp());
    editor.session.setMode(`ace/mode/${mode}`);
    editor.session.setTabSize(2);
    editor.session.setUseSoftTabs(true);
    editor.session.setUseWrapMode(true);
    editor.setShowPrintMargin(false);
    editor.setHighlightActiveLine(true);
    editor.setOptions({
        fontSize: '13px',
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: true,
        enableSnippets: true,
        showLineNumbers: true,
    });

    editor.session.on('change', () => {
        textarea.value = editor.getValue();
    });

    editor.setValue(textarea.value || '', -1);
    _codeEditors.set(textareaId, editor);
    requestAnimationFrame(() => editor.resize(true));
    return editor;
}

export function setCodeEditorValue(textareaId, value) {
    const textarea = document.getElementById(textareaId);
    if (textarea) textarea.value = value ?? '';
    const editor = _codeEditors.get(textareaId);
    if (editor) editor.setValue(value ?? '', -1);
}

export function getCodeEditorValue(textareaId) {
    const editor = _codeEditors.get(textareaId);
    if (editor) return editor.getValue();
    return document.getElementById(textareaId)?.value || '';
}

export function refreshCodeEditor(textareaId) {
    const editor = _codeEditors.get(textareaId);
    if (!editor) return;
    requestAnimationFrame(() => editor.resize(true));
}

// --- Escape key closes topmost sub-page ---
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const openPages = document.querySelectorAll('.app-subpage.open');
        if (openPages.length) {
            e.preventDefault();
            const last = openPages[openPages.length - 1];
            last.classList.remove('open');
            last.setAttribute('aria-hidden', 'true');
        }
    }
});

// --- Global modal scroll lock ---
let _modalScrollLockInitialized = false;

function _modalScrollLockTargets() {
    const targets = [document.documentElement, document.body];
    document.querySelectorAll('[id^="view-"]').forEach(el => targets.push(el));
    const conferenceContainer = document.getElementById('conference-container');
    if (conferenceContainer) targets.push(conferenceContainer);
    return targets;
}

function _setModalScrollLocked(locked) {
    _modalScrollLockTargets().forEach(el => {
        if (!el) return;
        if (locked) {
            if (el.dataset.modalPrevOverflow == null) el.dataset.modalPrevOverflow = el.style.overflow || '';
            if (el.dataset.modalPrevOverscroll == null) el.dataset.modalPrevOverscroll = el.style.overscrollBehavior || '';
            el.style.overflow = 'hidden';
            el.style.overscrollBehavior = 'none';
        } else {
            if (el.dataset.modalPrevOverflow != null) {
                el.style.overflow = el.dataset.modalPrevOverflow;
                delete el.dataset.modalPrevOverflow;
            } else {
                el.style.removeProperty('overflow');
            }
            if (el.dataset.modalPrevOverscroll != null) {
                el.style.overscrollBehavior = el.dataset.modalPrevOverscroll;
                delete el.dataset.modalPrevOverscroll;
            } else {
                el.style.removeProperty('overscroll-behavior');
            }
        }
    });
}

function _syncModalScrollLock() {
    const hasOpenModal = !!document.querySelector('.modal-overlay:not(.hidden)');
    _setModalScrollLocked(hasOpenModal);
}

function _initModalScrollLockObserver() {
    if (_modalScrollLockInitialized || typeof document === 'undefined') return;
    _modalScrollLockInitialized = true;

    let scheduled = false;
    const scheduleSync = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            _syncModalScrollLock();
        });
    };

    const observer = new MutationObserver(scheduleSync);
    const startObserver = () => {
        if (!document.body) return;
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class']
        });
        scheduleSync();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
        startObserver();
    }
}

_initModalScrollLockObserver();

// --- Toast notifications (replaces alert) ---
export function showToast(message, type = 'info', duration = 3000) {
    const area = document.getElementById('notification-area');
    if (!area) return;
    const colors = {
        info: 'border-accent/30 bg-accent/10 text-accent',
        success: 'border-green-500/30 bg-green-500/10 text-green-400',
        error: 'border-red-500/30 bg-red-500/10 text-red-400',
        warn: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
    };
    const icons = { info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation' };
    const toast = document.createElement('div');
    toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium shadow-lg backdrop-blur-lg animate-up ${colors[type] || colors.info}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info} text-base flex-shrink-0"></i><span class="flex-1">${escapeHtml(message)}</span>`;
    area.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// --- Custom confirm dialog (replaces window.confirm) ---
let _confirmResolve = null;

export function showConfirm(message) {
    return new Promise(resolve => {
        _confirmResolve = resolve;
        let modal = document.getElementById('confirm-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'confirm-modal';
            modal.className = 'modal-overlay app-modal fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-4';
            modal.style.cssText = '';
            modal.innerHTML = `
                <div class="glass app-modal-panel app-modal-content max-w-sm">
                    <div class="app-modal-header">
                        <h3 class="text-sm font-bold text-accent uppercase tracking-widest flex items-center gap-2 mb-3"><i class="fas fa-triangle-exclamation"></i>Confirm</h3>
                        <p id="confirm-message" class="text-sm text-slate-200 leading-relaxed"></p>
                    </div>
                    <div class="app-modal-footer justify-end">
                        <button id="confirm-cancel" class="px-4 py-2 rounded-xl text-sm font-bold text-slate-400 hover:bg-white/5 transition-colors">Cancel</button>
                        <button id="confirm-ok" class="px-4 py-2 rounded-xl text-sm font-bold text-white bg-red-500 hover:bg-red-600 transition-colors">OK</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            modal.querySelector('#confirm-cancel').onclick = () => _resolveConfirm(false);
            modal.querySelector('#confirm-ok').onclick = () => _resolveConfirm(true);
        }
        modal.querySelector('#confirm-message').textContent = message;
        modal.classList.remove('hidden');
    });
}

function _resolveConfirm(result) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.add('hidden');
    if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}
