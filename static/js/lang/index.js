/**
 * i18n: extensible language system (default: English).
 *
 * To add a new language (e.g. German):
 * 1. Create lang/de.js with the same key structure as en.js (copy en.js, translate values).
 * 2. In this file: add "import de from './de.js'", add de to LANGUAGES, add { code: 'de', nameKey: 'config.language_de' } to AVAILABLE_LANGUAGES.
 * 3. In en.js and ro.js (and de.js): add config.language_de: "Deutsch" (or "German", etc.) so the settings dropdown shows the label.
 */
import en from './en.js';
import ro from './ro.js';

// Registry: add new language by adding one entry here and creating <code>.js
export const LANGUAGES = { en, ro };
export const AVAILABLE_LANGUAGES = [
    { code: 'en', nameKey: 'config.language_en' },
    { code: 'ro', nameKey: 'config.language_ro' }
];

const dictionaries = LANGUAGES;
const DEFAULT_LANG = 'en';
let currentLanguage = DEFAULT_LANG;

function resolveKey(dict, key) {
    if (!dict || !key) return null;
    return key.split('.').reduce((obj, part) => (obj && obj[part] !== undefined ? obj[part] : null), dict);
}

/** Replace {key} placeholders in str with values from params */
function interpolate(str, params) {
    if (typeof str !== 'string' || !params) return str;
    return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

/** Get translated string for key; optional params for {page}, {count}, etc. */
export function t(key, params) {
    const dict = dictionaries[currentLanguage] || dictionaries[DEFAULT_LANG];
    const val = resolveKey(dict, key);
    const str = typeof val === 'string' ? val : (resolveKey(dictionaries[DEFAULT_LANG], key) || key);
    return interpolate(str, params);
}

/** Get raw value (array, object, etc.) for a key — no string coercion. */
export function tRaw(key) {
    const dict = dictionaries[currentLanguage] || dictionaries[DEFAULT_LANG];
    const val = resolveKey(dict, key);
    return val != null ? val : resolveKey(dictionaries[DEFAULT_LANG], key);
}

export function getLanguage() {
    return currentLanguage;
}

/** List of { code, label } for current language (for settings dropdown) */
export function getAvailableLanguages() {
    return AVAILABLE_LANGUAGES.map(({ code, nameKey }) => ({
        code,
        label: t(nameKey)
    }));
}

export function setLanguage(lang) {
    if (!dictionaries[lang]) lang = DEFAULT_LANG;
    currentLanguage = lang;
    try {
        localStorage.setItem('memini_lang', lang);
    } catch (e) {}
    applyTranslations();
}

export function initI18n(initialLang) {
    let lang = initialLang;
    try {
        const stored = localStorage.getItem('memini_lang');
        if (stored) lang = stored;
    } catch (e) {}
    if (!lang) lang = DEFAULT_LANG;
    currentLanguage = dictionaries[lang] ? lang : DEFAULT_LANG;
    applyTranslations();
}

export function applyTranslations() {
    const dict = dictionaries[currentLanguage] || dictionaries[DEFAULT_LANG];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = resolveKey(dict, key);
        if (typeof val !== 'string') return;

        // If element has no child elements, safe to use textContent
        if (!el.children.length) {
            el.textContent = val;
            return;
        }

        // Element has children (icons, spans, etc.) — find a child <span>
        // without its own data-i18n to update, preserving icons
        const span = el.querySelector(':scope > span:not([data-i18n])');
        if (span) {
            span.textContent = val;
            return;
        }

        // Fallback: update last text node (preserves preceding icons)
        const textNodes = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (textNodes.length) {
            textNodes[textNodes.length - 1].textContent = ' ' + val;
        }
    });

    // data-i18n-html: translations containing HTML (rendered via innerHTML)
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        const val = resolveKey(dict, key);
        if (typeof val === 'string') {
            el.innerHTML = val;
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const val = resolveKey(dict, key);
        if (typeof val === 'string') {
            el.setAttribute('placeholder', val);
        }
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const val = resolveKey(dict, key);
        if (typeof val === 'string') {
            el.setAttribute('title', val);
        }
    });
}
