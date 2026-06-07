/**
 * i18n: extensible language system (default: English).
 *
 * To add a new language (e.g. German):
 * 1. Create lang/de.js with the same key structure as en.js (copy en.js, translate values).
 * 2. In this file: add "import de from './de.js'", add de to LANGUAGES, add { code: 'de', nameKey: 'config.language_de' } to AVAILABLE_LANGUAGES.
 * 3. In en.js and ro.js (and de.js): add config.language_de: "Deutsch" (or "German", etc.) so the settings dropdown shows the label.
 */
import en from './en.js?v=i18n-updates-31';
import ro from './ro.js?v=i18n-updates-31';

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

function deepMerge(base, overlay) {
    if (!overlay || typeof overlay !== 'object') return base;
    const out = base && typeof base === 'object' ? base : {};
    for (const [key, value] of Object.entries(overlay)) {
        if (value && typeof value === 'object' && !Array.isArray(value)
            && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            deepMerge(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/** Deep-merge component translation payload into the active language dictionary. */
export function mergeComponentTranslations(payload) {
    if (!payload || typeof payload !== 'object') return;
    const lang = currentLanguage in dictionaries ? currentLanguage : DEFAULT_LANG;
    dictionaries[lang] = deepMerge(dictionaries[lang] || {}, payload);
    if (lang !== DEFAULT_LANG && dictionaries[DEFAULT_LANG]) {
        dictionaries[DEFAULT_LANG] = deepMerge(dictionaries[DEFAULT_LANG], payload);
    }
}

/** Fetch configured component translations from the API and merge them. */
export async function loadComponentTranslations(lang) {
    const token = (() => {
        try { return localStorage.getItem('hyve_token') || ''; } catch (_) { return ''; }
    })();
    if (!token) return;
    const queryLang = lang || currentLanguage || DEFAULT_LANG;
    try {
        const res = await fetch(`/api/i18n/components?lang=${encodeURIComponent(queryLang)}`, {
            headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) return;
        const payload = await res.json();
        mergeComponentTranslations(payload);
        applyTranslations();
    } catch (_) {}
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

/** Translate structured API error payloads ({ key, params }) or plain strings. */
export function translateApiDetail(detail) {
    if (detail == null || detail === '') return '';
    if (typeof detail === 'object') {
        if (typeof detail.key === 'string') return t(detail.key, detail.params);
        if (detail.errors && typeof detail.errors === 'object') {
            return Object.values(detail.errors)
                .map((v) => translateApiDetail(v))
                .filter(Boolean)
                .join(', ');
        }
        try {
            return JSON.stringify(detail);
        } catch (_) {
            return String(detail);
        }
    }
    return String(detail);
}

/** Resolve integration test/sync API message fields to a localized string. */
export function integrationApiMessage(payload) {
    if (!payload || typeof payload !== 'object') return t('common.unknown_error');
    if (payload.message && String(payload.message).trim()) return String(payload.message);
    if (payload.message_key) return t(payload.message_key, payload.message_params);
    if (payload.detail != null) return translateApiDetail(payload.detail);
    return t('common.unknown_error');
}

/** Translate a raw Home Assistant entity state ('on', 'off', 'locked', etc.).
 *  Falls back to the raw value if no translation exists for that state. */
export function tState(rawState) {
    const s = String(rawState == null ? 'unknown' : rawState);
    const key = 'entity.state.' + s.toLowerCase().replace(/-/g, '_');
    const val = t(key);
    return val === key ? s : val;
}

/** Map integration vacuum status text (often English) to localized label. */
const VACUUM_STATUS_ALIASES = {
    charging: 'hyveview.vacuum.status.charging',
    'fully charged': 'hyveview.vacuum.status.fully_charged',
    'charging complete': 'hyveview.vacuum.status.fully_charged',
    'charging completed': 'hyveview.vacuum.status.fully_charged',
    'charging paused during peak hours': 'hyveview.vacuum.status.charging_paused',
    'emptying bin': 'hyveview.vacuum.status.emptying_bin',
    returning: 'hyveview.vacuum.status.returning',
    'returning home': 'hyveview.vacuum.status.returning',
    'go charging': 'hyveview.vacuum.status.returning',
    cleaning: 'hyveview.vacuum.status.cleaning',
    sweeping: 'hyveview.vacuum.status.cleaning',
    'sweep and mop': 'hyveview.vacuum.status.cleaning',
    'spot sweeping': 'hyveview.vacuum.status.cleaning',
    paused: 'hyveview.vacuum.status.paused',
    idle: 'hyveview.vacuum.status.idle',
    docked: 'hyveview.vacuum.status.docked',
    error: 'hyveview.vacuum.status.error',
};

export function tVacuumStatus(statusAttr, genericState) {
    const raw = String(statusAttr || '').trim().toLowerCase();
    if (raw) {
        const aliasKey = VACUUM_STATUS_ALIASES[raw];
        if (aliasKey) {
            const val = t(aliasKey);
            if (val !== aliasKey) return val;
        }
    }
    const state = String(genericState || 'unknown').toLowerCase();
    const stateKey = `hyveview.vacuum.status.${state}`;
    const stateVal = t(stateKey);
    if (stateVal !== stateKey) return stateVal;
    if (statusAttr) return String(statusAttr);
    return tState(genericState);
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
        localStorage.setItem('hyve_lang', lang);
    } catch (e) {}
    try {
        document.documentElement.setAttribute('lang', lang);
    } catch (e) {}
    applyTranslations();
}

export function initI18n(initialLang) {
    let lang = initialLang;
    try {
        const stored = localStorage.getItem('hyve_lang');
        if (stored) lang = stored;
    } catch (e) {}
    if (!lang) lang = DEFAULT_LANG;
    currentLanguage = dictionaries[lang] ? lang : DEFAULT_LANG;
    try {
        document.documentElement.setAttribute('lang', currentLanguage);
    } catch (e) {}
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

    try { window.initDashboardSidebarNav?.(); } catch (_) {}
    document.querySelectorAll('hv-card-vacuum').forEach((el) => {
        if (typeof el.refreshI18n === 'function') el.refreshI18n();
    });
}
