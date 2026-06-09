// @ts-nocheck — tighten types in a follow-up pass.
/**
 * Syntax highlighting for chat code blocks (highlight.js).
 */

import { t } from '../lang/index.js';
import { loadScriptOnce, loadStyleOnce } from '../utils.js';

export function normalizeCodeLanguage(lang) {
    const value = (lang || '').toLowerCase().trim();
    if (!value || value === (t('chat.code_label') || 'code').toLowerCase()) return '';
    const aliases = {
        py: 'python',
        js: 'javascript',
        ts: 'typescript',
        jsx: 'javascript',
        tsx: 'typescript',
        sh: 'bash',
        shell: 'bash',
        shellscript: 'bash',
        zsh: 'bash',
        ps1: 'powershell',
        ps: 'powershell',
        yml: 'yaml',
        html: 'xml',
        xhtml: 'xml',
        svg: 'xml',
        plist: 'xml',
        md: 'markdown',
        'c++': 'cpp',
        hpp: 'cpp',
        cc: 'cpp',
        hh: 'cpp',
        h: 'c',
        'c#': 'csharp',
        cs: 'csharp',
        objc: 'objectivec',
        objectivec: 'objectivec',
        docker: 'dockerfile',
        env: 'ini',
        properties: 'ini'
    };
    return aliases[value] || value;
}

const HIGHLIGHT_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1';
const HIGHLIGHT_LANGUAGE_FILES = {
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    csharp: 'csharp',
    css: 'css',
    dart: 'dart',
    dockerfile: 'dockerfile',
    go: 'go',
    ini: 'ini',
    java: 'java',
    javascript: 'javascript',
    json: 'json',
    kotlin: 'kotlin',
    lua: 'lua',
    markdown: 'markdown',
    objectivec: 'objectivec',
    php: 'php',
    powershell: 'powershell',
    python: 'python',
    ruby: 'ruby',
    rust: 'rust',
    scss: 'scss',
    sql: 'sql',
    swift: 'swift',
    toml: 'toml',
    typescript: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
};

let _highlightCorePromise = null;
const _highlightLanguagePromises = new Map();

function _ensureHighlightCore() {
    if (typeof hljs !== 'undefined') return Promise.resolve(hljs);
    if (!_highlightCorePromise) {
        _highlightCorePromise = Promise.all([
            loadStyleOnce(`${HIGHLIGHT_BASE}/styles/github-dark.min.css`),
            loadScriptOnce(`${HIGHLIGHT_BASE}/highlight.min.js`),
        ])
            .then(() => loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/highlightjs-line-numbers.js/2.9.0/highlightjs-line-numbers.min.js'))
            .then(() => hljs);
    }
    return _highlightCorePromise;
}

function _ensureHighlightLanguage(lang) {
    const normalized = normalizeCodeLanguage(lang);
    const file = HIGHLIGHT_LANGUAGE_FILES[normalized];
    if (!file) return _ensureHighlightCore();
    return _ensureHighlightCore().then(() => {
        if (typeof hljs !== 'undefined' && hljs.getLanguage(file)) return;
        if (!_highlightLanguagePromises.has(file)) {
            _highlightLanguagePromises.set(file, loadScriptOnce(`${HIGHLIGHT_BASE}/languages/${file}.min.js`));
        }
        return _highlightLanguagePromises.get(file);
    });
}

function _ensureHighlightAssets(lang) {
    return _ensureHighlightLanguage(lang).then(() => _ensureHighlightCore());
}

export function applyHighlightingWithLineNumbers(codeEl, rawSource, lang = '') {
    if (!codeEl) return;
    const normalizedLang = normalizeCodeLanguage(lang);
    codeEl.textContent = rawSource || '';
    codeEl.dataset.rawSource = rawSource || '';
    codeEl.dataset.language = normalizedLang || '';
    codeEl.className = normalizedLang ? `language-${normalizedLang}` : '';

    const needsHighlightLoad = typeof hljs === 'undefined'
        || (normalizedLang && !hljs.getLanguage(normalizedLang))
        || typeof hljs.lineNumbersBlock !== 'function';
    if (needsHighlightLoad && codeEl.dataset.highlightLoading !== '1') {
        codeEl.dataset.highlightLoading = '1';
        _ensureHighlightAssets(normalizedLang)
            .then(() => {
                codeEl.dataset.highlightLoading = '0';
                applyHighlightingWithLineNumbers(codeEl, codeEl.dataset.rawSource || rawSource || '', normalizedLang);
            })
            .catch(() => { codeEl.dataset.highlightLoading = '0'; });
    }

    if (typeof hljs !== 'undefined') {
        try {
            if (normalizedLang && hljs.getLanguage(normalizedLang)) {
                hljs.highlightElement(codeEl);
            } else {
                const result = hljs.highlightAuto(rawSource || '');
                codeEl.innerHTML = result.value;
                codeEl.className = result.language ? `language-${result.language} hljs` : 'hljs';
                codeEl.dataset.language = result.language || normalizedLang || '';
            }
        } catch (_e) {
            codeEl.textContent = rawSource || '';
        }
    }

    const applyLines = () => {
        if (codeEl.dataset.lineNumbersReady === '1') return;
        if (typeof hljs === 'undefined' || typeof hljs.lineNumbersBlock !== 'function') return;
        try {
            const maybePromise = hljs.lineNumbersBlock(codeEl, { singleLine: true });
            if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then(() => { codeEl.dataset.lineNumbersReady = '1'; }).catch(() => {});
            } else {
                codeEl.dataset.lineNumbersReady = '1';
            }
        } catch (_e) {
            // noop
        }
    };

    codeEl.dataset.lineNumbersReady = '0';
    applyLines();
}

export function enhanceCodeBlock(pre, lang, rawSource) {
    if (!pre) return;
    const codeEl = pre.querySelector('code') || pre;
    applyHighlightingWithLineNumbers(codeEl, rawSource || pre.dataset.rawSource || codeEl.textContent || '', lang);
}

