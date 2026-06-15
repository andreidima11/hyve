/**
 * UI language select + search tendency hint.
 */
import { apiCall } from '../api.js';
import { setLanguage, getLanguage, t, getAvailableLanguages, loadComponentTranslations } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast } from '../utils.js';
import { upgradeNativeSelect } from '../features_custom_selects.js';
import { cfgField } from './utils.js';

const _SEARCH_TENDENCY_HINTS: Record<number, string> = {
    1: 'Minimal — almost never searches. Only when you explicitly ask it to.',
    2: 'Conservative — prefers own knowledge, searches only for today\'s news/weather.',
    3: 'Balanced — searches for current events, uses knowledge for known facts.',
    4: 'Proactive — searches when not fully confident, verifies uncertain facts.',
    5: 'Aggressive — actively searches to provide the freshest information.',
};

export function updateSearchTendencyHint(val: number) {
    const hint = cfgField('search_tendency_hint');
    if (hint) hint.textContent = _SEARCH_TENDENCY_HINTS[val] || _SEARCH_TENDENCY_HINTS[3];
}

let _uiLanguageSaveSeq = 0;

export function refreshUiLanguageSelect(language: string) {
    const uiLangSelect = cfgField('ui_language') as HTMLSelectElement | null;
    if (!uiLangSelect || uiLangSelect.tagName !== 'SELECT') return;
    const value = language || uiLangSelect.value || getLanguage();
    const opts = getAvailableLanguages();
    uiLangSelect.innerHTML = opts.map((o) =>
        `<option value="${escapeHtmlAttr(o.code)}">${escapeHtml(o.label)}</option>`,
    ).join('');
    uiLangSelect.value = value;
    upgradeNativeSelect(uiLangSelect);
}

let _uiLanguageChangeBound = false;

if (typeof document !== 'undefined' && !_uiLanguageChangeBound) {
    _uiLanguageChangeBound = true;
    document.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLSelectElement) || target.id !== 'ui_language') return;
        void applyAndSaveUiLanguage(target.value);
    });
}

async function applyAndSaveUiLanguage(language: string) {
    if (!language) return;
    const previousLanguage = getLanguage();
    const saveSeq = ++_uiLanguageSaveSeq;
    const select = cfgField('ui_language') as HTMLSelectElement | null;

    try {
        setLanguage(language);
        await loadComponentTranslations(language);
        refreshUiLanguageSelect(language);
        if (select) select.disabled = true;
        await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
    } catch (err) {
        if (saveSeq === _uiLanguageSaveSeq) {
            try {
                setLanguage(previousLanguage);
                refreshUiLanguageSelect(previousLanguage);
            } catch (_) {}
            showToast(t('config.save_error'), 'error');
        }
    } finally {
        if (select && saveSeq === _uiLanguageSaveSeq) select.disabled = false;
    }
}
