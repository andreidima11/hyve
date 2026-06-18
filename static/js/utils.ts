/**
 * Shared utility functions used across multiple JS modules.
 */
import { t } from './lang/index.js';
import { withCacheBust } from './asset_version.js';
import { faviconProxyUrlSync, getCameraStreamToken } from './camera_auth.js';
import type {
    ChatSourceInput,
    CodeEditorSetupOptions,
    HyveAceEditor,
    NormalizedSource,
    ToastType,
} from './types/utils.js';

const _SOURCE_FAVICON_ONERROR = 'window.__hyveSourceFaviconError?.(this)';

function _bindSourceFaviconError() {
    if (typeof window === 'undefined' || window.__hyveSourceFaviconError) return;
    window.__hyveSourceFaviconError = async (img: HTMLImageElement) => {
        if (!img || img.dataset.faviconRetry === '1') {
            img?.classList?.add('chat-source-favicon-missing');
            img?.removeAttribute?.('src');
            return;
        }
        img.dataset.faviconRetry = '1';
        try {
            await getCameraStreamToken();
            const domain = img.dataset.domain || '';
            if (domain) img.src = faviconProxyUrlSync(domain);
        } catch (_) {
            img.classList.add('chat-source-favicon-missing');
            img.removeAttribute('src');
        }
    };
}
_bindSourceFaviconError();

const _loadedScripts = new Map<string, Promise<HTMLScriptElement>>();
const _loadedStyles = new Map<string, Promise<HTMLLinkElement>>();

export function loadScriptOnce(src: string) {
    if (!src || typeof document === 'undefined') return Promise.reject(new Error('Missing script src'));
    const resolvedSrc = String(src).startsWith('/static/') ? withCacheBust(src) : src;
    if (_loadedScripts.has(resolvedSrc)) return _loadedScripts.get(resolvedSrc)!;
    const promise = new Promise<HTMLScriptElement>((resolve, reject) => {
        const existing = document.querySelector(`script[src="${resolvedSrc}"]`) as HTMLScriptElement | null;
        if (existing?.dataset.loaded === '1') {
            resolve(existing);
            return;
        }
        const script = existing || document.createElement('script');
        script.src = resolvedSrc;
        script.async = true;
        script.onload = () => {
            script.dataset.loaded = '1';
            resolve(script);
        };
        script.onerror = () => {
            _loadedScripts.delete(resolvedSrc);
            reject(new Error(`Could not load script: ${resolvedSrc}`));
        };
        if (!existing) document.head.appendChild(script);
    });
    _loadedScripts.set(resolvedSrc, promise);
    return promise;
}

export function loadStyleOnce(href: string) {
    if (!href || typeof document === 'undefined') return Promise.reject(new Error('Missing stylesheet href'));
    const resolvedHref = String(href).startsWith('/static/') ? withCacheBust(href) : href;
    if (_loadedStyles.has(resolvedHref)) return _loadedStyles.get(resolvedHref)!;
    const promise = new Promise<HTMLLinkElement>((resolve, reject) => {
        const existing = document.querySelector(`link[rel="stylesheet"][href="${resolvedHref}"]`) as HTMLLinkElement | null;
        if (existing?.dataset.loaded === '1') {
            resolve(existing);
            return;
        }
        const link = existing || document.createElement('link');
        link.rel = 'stylesheet';
        link.href = resolvedHref;
        link.onload = () => {
            link.dataset.loaded = '1';
            resolve(link);
        };
        link.onerror = () => {
            _loadedStyles.delete(resolvedHref);
            reject(new Error(`Could not load stylesheet: ${resolvedHref}`));
        };
        if (!existing) document.head.appendChild(link);
    });
    _loadedStyles.set(resolvedHref, promise);
    return promise;
}

// ─── Shared tool icon map (used by chat) ───
export const TOOL_ICONS: Record<string, string> = {
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
export function toolIcon(name: string) {
    return TOOL_ICONS[name] || TOOL_ICON_FALLBACK;
}

// ─── Shared sources renderer (used by chat) ───

const _sourceGroups = new Map<string, NormalizedSource[]>();
let _sourceGroupSeq = 0;

function _normalizeSource(src: ChatSourceInput | null | undefined): NormalizedSource | null {
    try {
        const rawUrl = String(src?.url || src?.link || '').trim();
        if (!rawUrl) return null;
        let domainText = String(src?.domain || '').trim();
        if (!domainText && rawUrl) {
            try { domainText = new URL(rawUrl).hostname || ''; } catch (_) { domainText = ''; }
        }
        domainText = domainText.toLowerCase().replace(/^www\./i, '');
        if (!domainText) return null;
        return {
            url: rawUrl,
            domain: domainText,
            title: String(src?.title || domainText).trim(),
            snippet: String(src?.snippet || '').trim(),
        };
    } catch {
        return null;
    }
}

function _dedupeSources(sources: ChatSourceInput[] | unknown[] | null | undefined): NormalizedSource[] {
    const seen = new Set<string>();
    const out: NormalizedSource[] = [];
    for (const src of sources || []) {
        const normalized = _normalizeSource(src as ChatSourceInput);
        if (!normalized) continue;
        const key = `${normalized.domain}|${normalized.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
    }
    return out;
}

function _faviconUrl(domainText: string) {
    return faviconProxyUrlSync(domainText);
}

function _sourceChipHtml(src: NormalizedSource) {
    const domain = escapeHtml(src.domain);
    const url = escapeHtml(src.url);
    const favicon = _faviconUrl(src.domain);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-source-card" title="${domain}">
        <img src="${favicon}" alt="" class="chat-source-favicon" data-domain="${domain}" loading="lazy" onerror="${_SOURCE_FAVICON_ONERROR}">
        <span class="chat-source-domain">${domain}</span>
    </a>`;
}

function _ensureSourcesModal() {
    let modal = document.getElementById('sources-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'sources-modal';
    modal.className = 'modal-overlay app-modal fixed inset-0 z-[80] hidden flex items-center justify-center p-2 sm:p-4';
    modal.innerHTML = `
        <div class="glass app-modal-panel app-modal-content max-w-2xl w-full">
            <div class="app-modal-header">
                <div>
                    <h3 id="sources-modal-title" class="text-sm font-bold text-accent uppercase tracking-widest flex items-center gap-2">
                        <i class="fas fa-book-open"></i>
                        <span>${escapeHtml(t('chat.sources_label') || 'Surse')}</span>
                    </h3>
                    <p id="sources-modal-subtitle" class="app-modal-subtitle"></p>
                </div>
                <button type="button" class="app-modal-close" aria-label="Close">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>
            <div id="sources-modal-body" class="app-modal-body sources-modal-body"></div>
        </div>`;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideSourcesModal();
    });
    modal.querySelector('.app-modal-panel')?.addEventListener('click', (e) => e.stopPropagation());
    modal.querySelector('.app-modal-close')?.addEventListener('click', hideSourcesModal);
    document.body.appendChild(modal);
    return modal;
}

export function showSourcesModal(groupId: string) {
    const sources = _sourceGroups.get(String(groupId)) || [];
    if (!sources.length) return;
    const modal = _ensureSourcesModal();
    const subtitle = modal.querySelector('#sources-modal-subtitle');
    const body = modal.querySelector('#sources-modal-body');
    if (subtitle) subtitle.textContent = t('chat.sources_count', { count: sources.length });
    if (body) {
        body.innerHTML = sources.map(src => {
            const domain = escapeHtml(src.domain);
            const title = escapeHtml(src.title || src.domain);
            const snippet = escapeHtml(src.snippet || '');
            const url = escapeHtml(src.url);
            const favicon = _faviconUrl(src.domain);
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="sources-modal-item">
                <span class="sources-modal-item-icon">
                    <img src="${favicon}" alt="" class="chat-source-favicon" data-domain="${domain}" loading="lazy" onerror="${_SOURCE_FAVICON_ONERROR}">
                </span>
                <span class="sources-modal-item-main">
                    <span class="sources-modal-item-title">${title}</span>
                    ${snippet ? `<span class="sources-modal-item-snippet">${snippet}</span>` : ''}
                    <span class="sources-modal-item-domain">${domain}</span>
                </span>
                <span class="sources-modal-item-action"><i class="fas fa-arrow-up-right-from-square"></i></span>
            </a>`;
        }).join('');
    }
    modal.classList.remove('hidden');
    void refreshSourceFavicons(modal as unknown as Document);
}

export function hideSourcesModal() {
    const modal = document.getElementById('sources-modal');
    if (modal) modal.classList.add('hidden');
}

/** Refresh proxied favicon URLs after media auth token is available. */
export async function refreshSourceFavicons(root: Document | Element = document) {
    try {
        await getCameraStreamToken();
    } catch (_) {}
    const scope = root instanceof Document || root instanceof Element ? root : document;
    scope.querySelectorAll('img.chat-source-favicon:not(.chat-source-favicon-missing)').forEach((imgEl) => {
        const img = imgEl as HTMLImageElement;
        const domain = img.dataset.domain || img.closest('.chat-source-card')?.getAttribute('title') || '';
        if (!domain) return;
        const next = faviconProxyUrlSync(domain);
        if (img.getAttribute('src') !== next) img.src = next;
    });
}

/**
 * Build the HTML for search-source citation cards.
 * @param {Array} sources – array of { url, domain?, link? } objects
 * @param {string} [label] – optional label override (defaults to i18n 'chat.sources_label' → "Surse")
 * @returns {string} HTML string
 */
export function buildSourcesHtml(sources: ChatSourceInput[] | unknown[] | null | undefined, label?: string) {
    const normalized = _dedupeSources(sources);
    if (!normalized.length) return '';
    const labelText = label || t('chat.sources_label') || 'Surse';
    const visible = normalized.slice(0, 3).map(_sourceChipHtml).join('');
    let moreButton = '';
    if (normalized.length > 3) {
        const groupId = `src-${Date.now()}-${++_sourceGroupSeq}`;
        _sourceGroups.set(groupId, normalized);
        const hiddenCount = normalized.length - 3;
        moreButton = `<button type="button" class="chat-source-more-btn" data-chat-action="showSourcesModal" data-chat-source-group="${groupId}">
            ${escapeHtml(t('chat.sources_more', { count: hiddenCount }))}
        </button>`;
    }
    return `<div class="chat-sources-row">
        <div class="chat-sources-label"><i class="fas fa-book-open"></i> ${escapeHtml(labelText)}</div>
        <div class="chat-sources-list">${visible}${moreButton}</div>
    </div>`;
}

// ─── Shared Markdown renderer (non-streaming) ───

/** Parse markdown & sanitize. Used for finalized content in chat. */
export function formatMarkdown(text: string | null | undefined) {
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
export function debounce<T extends (...args: never[]) => unknown>(fn: T, delay = 250) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return function (this: unknown, ...args: Parameters<T>) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

export function escapeHtml(text: unknown) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

export function escapeHtmlAttr(s: unknown) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function getSessionId() {
    return localStorage.getItem('hyve_session_id');
}

/* ─── Sub-page helpers ─── */

type SavedScroll = { el: HTMLElement; top: number };

function _resetAncestorScroll(el: HTMLElement): SavedScroll[] {
    const saved: SavedScroll[] = [];
    let node: HTMLElement | null = el.parentElement;
    while (node) {
        if (node.scrollTop > 0) {
            saved.push({ el: node, top: node.scrollTop });
            node.scrollTop = 0;
        }
        node = node.parentElement;
    }
    return saved;
}

export function openSubPage(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = _resetAncestorScroll(el);
    if (saved.length) {
        (el as HTMLElement & { _savedAncestorScrolls?: SavedScroll[] })._savedAncestorScrolls = saved;
    }
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
}

export function closeSubPage(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    const saved = (el as HTMLElement & { _savedAncestorScrolls?: SavedScroll[] })._savedAncestorScrolls;
    if (saved?.length) {
        for (const { el: ancestor, top } of saved) {
            ancestor.scrollTop = top;
        }
        delete (el as HTMLElement & { _savedAncestorScrolls?: SavedScroll[] })._savedAncestorScrolls;
    }
}

export function closeAllSubPages() {
    document.querySelectorAll('.app-subpage.open').forEach(el => {
        el.classList.remove('open');
        el.setAttribute('aria-hidden', 'true');
    });
}

/** Mast / hub refresh buttons (arrows-rotate icon in toolbar). */
export function isHubRefreshButton(el: HTMLElement): boolean {
    const scope = el.closest('#config-standalone-actions, .hyd-standalone-actions, #view-skills .hyd-mast__actions, #view-memory .hyd-mast__actions, #blueprint-picker-modal .hyd-mast__actions, #automation-editor-modal .hyd-mast__actions');
    if (!scope) return false;
    const icon = el.querySelector('i');
    if (!icon) return false;
    return icon.classList.contains('fa-arrows-rotate')
        || icon.classList.contains('fa-sync-alt')
        || icon.classList.contains('fa-sync');
}

export function withHubRefreshFeedback(el: HTMLElement, work: () => void | Promise<void>): void {
    if (el.classList.contains('is-syncing')) return;
    el.classList.add('is-syncing');
    el.setAttribute('aria-busy', 'true');
    const minSpin = new Promise<void>((resolve) => { window.setTimeout(resolve, 650); });
    Promise.all([Promise.resolve(work()), minSpin]).finally(() => {
        el.classList.remove('is-syncing');
        el.removeAttribute('aria-busy');
    });
}

/* ─── App shell safe areas (mobile browser chrome — HA-style) ─── */

function _setAppSafeAreaInset(prop: string, px: number) {
    if (px > 0) {
        document.documentElement.style.setProperty(prop, `${px}px`);
    } else {
        document.documentElement.style.removeProperty(prop);
    }
}

export function syncModalViewportMetrics() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const isNative = document.documentElement.classList.contains('is-native-app')
        || document.body?.classList.contains('hyve-native-app');
    const isMobile = window.matchMedia('(max-width: 1023px)').matches;

    if (isNative || !isMobile) {
        _setAppSafeAreaInset('--app-safe-area-inset-top', 0);
        _setAppSafeAreaInset('--app-safe-area-inset-bottom', 0);
        _setAppSafeAreaInset('--app-safe-area-inset-left', 0);
        _setAppSafeAreaInset('--app-safe-area-inset-right', 0);
        return;
    }

    const vv = window.visualViewport;
    const visibleHeight = Math.max(320, Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 0));
    const offsetTop = Math.max(0, Math.round(vv?.offsetTop || 0));
    const layoutHeight = window.innerHeight || visibleHeight;
    const bottomGap = Math.max(0, Math.round(layoutHeight - visibleHeight - offsetTop));

    _setAppSafeAreaInset('--app-safe-area-inset-top', offsetTop);
    _setAppSafeAreaInset('--app-safe-area-inset-bottom', bottomGap);
    _setAppSafeAreaInset('--app-safe-area-inset-left', 0);
    _setAppSafeAreaInset('--app-safe-area-inset-right', 0);
}

let _modalViewportSyncInitialized = false;
export function initModalViewportSync() {
    if (_modalViewportSyncInitialized || typeof window === 'undefined') return;
    _modalViewportSyncInitialized = true;

    syncModalViewportMetrics();
    window.addEventListener('resize', syncModalViewportMetrics, { passive: true });
    window.addEventListener('orientationchange', syncModalViewportMetrics, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncModalViewportMetrics, { passive: true });
        window.visualViewport.addEventListener('scroll', syncModalViewportMetrics, { passive: true });
    }
}

initModalViewportSync();

/* ─── Modal portal: move all .app-modal elements to <body> so they are
   guaranteed to be viewport-fixed regardless of any ancestor that may
   create a containing block (transform, filter, will-change, contain, etc.) */
function _portalAppModals() {
    if (typeof document === 'undefined' || !document.body) return;
    document.querySelectorAll('.app-modal').forEach((el) => {
        if (el.parentElement !== document.body) {
            document.body.appendChild(el);
        }
    });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _portalAppModals, { once: true });
    } else {
        _portalAppModals();
    }
}

/* ─── Code editor helpers ─── */

const _codeEditors = new Map<string, HyveAceEditor>();
let _aceLoadPromise: Promise<typeof window.ace> | null = null;

function _ensureAceEditor() {
    if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
    if (window.ace) return Promise.resolve(window.ace);
    if (!_aceLoadPromise) {
        _aceLoadPromise = loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6/ace.js')
            .then(() => loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.6/ext-language_tools.min.js'))
            .then(() => window.ace!);
    }
    return _aceLoadPromise;
}

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

export function setupCodeEditor({ textareaId, mode = 'text' }: CodeEditorSetupOptions): HyveAceEditor | null {
    const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    if (!textarea || typeof window === 'undefined') return null;
    if (typeof window.ace === 'undefined') {
        _ensureAceEditor()
            .then(() => setupCodeEditor({ textareaId, mode }))
            .catch((err: unknown) => console.warn('Ace editor load failed', err));
        return null;
    }

    _initAceThemeObserver();

    if (_codeEditors.has(textareaId)) {
        const existing = _codeEditors.get(textareaId)!;
        existing.getSession().setMode(`ace/mode/${mode}`);
        existing.getSession().setUseWorker(false);
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
    editor.session.setUseWorker(false);
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

export function setCodeEditorValue(textareaId: string, value: string | null | undefined) {
    const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    if (textarea) textarea.value = value ?? '';
    const editor = _codeEditors.get(textareaId);
    if (editor) editor.setValue(value ?? '', -1);
}

export function getCodeEditorValue(textareaId: string) {
    const editor = _codeEditors.get(textareaId);
    if (editor) return editor.getValue();
    return (document.getElementById(textareaId) as HTMLTextAreaElement | null)?.value || '';
}

export function refreshCodeEditor(textareaId: string) {
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

function _modalScrollLockTargets(): HTMLElement[] {
    const targets: HTMLElement[] = [document.documentElement, document.body];
    document.querySelectorAll('[id^="view-"]').forEach(el => targets.push(el as HTMLElement));
    return targets;
}

function _setModalScrollLocked(locked: boolean) {
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
    const hasOpenSubpage = !!document.querySelector('.app-subpage.open');
    _setModalScrollLocked(hasOpenModal || hasOpenSubpage);
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
export function showToast(message: string, type: string = 'info', duration = 3000) {
    const area = document.getElementById('notification-area');
    if (!area) return;
    const colors: Record<ToastType, string> = {
        info: 'border-accent/30 bg-accent/10 text-accent',
        success: 'border-green-500/30 bg-green-500/10 text-green-400',
        error: 'border-red-500/30 bg-red-500/10 text-red-400',
        warn: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
    };
    const icons: Record<ToastType, string> = { info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation' };
    const normalized = type === 'warning' ? 'warn' : type;
    const toastType: ToastType = normalized in colors ? normalized as ToastType : 'info';
    const toast = document.createElement('div');
    toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium shadow-lg backdrop-blur-lg animate-up ${colors[toastType]}`;
    toast.innerHTML = `<i class="fas ${icons[toastType]} text-base flex-shrink-0"></i><span class="flex-1">${escapeHtml(message)}</span>`;
    area.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// --- Custom confirm dialog (replaces window.confirm) ---
let _confirmResolve: ((result: boolean) => void) | null = null;

export function showConfirm(message: string) {
    return new Promise<boolean>(resolve => {
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
            (modal.querySelector('#confirm-cancel') as HTMLButtonElement).onclick = () => _resolveConfirm(false);
            (modal.querySelector('#confirm-ok') as HTMLButtonElement).onclick = () => _resolveConfirm(true);
        }
        const messageEl = modal.querySelector('#confirm-message');
        if (messageEl) messageEl.textContent = message;
        modal.classList.remove('hidden');
    });
}

function _resolveConfirm(result: boolean) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.add('hidden');
    if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}
