/**
 * UI language dropdown + search tendency hint.
 */
import { apiCall } from '../api.js';
import { setLanguage, getLanguage, t, getAvailableLanguages, loadComponentTranslations } from '../lang/index.js';
import { showToast } from '../utils.js';
import { initGenericCustomSelects } from '../features_custom_selects.js';
import { cfgField } from './utils.js';
const _SEARCH_TENDENCY_HINTS = {
    1: 'Minimal — almost never searches. Only when you explicitly ask it to.',
    2: 'Conservative — prefers own knowledge, searches only for today\'s news/weather.',
    3: 'Balanced — searches for current events, uses knowledge for known facts.',
    4: 'Proactive — searches when not fully confident, verifies uncertain facts.',
    5: 'Aggressive — actively searches to provide the freshest information.',
};
export function updateSearchTendencyHint(val) {
    const hint = cfgField('search_tendency_hint');
    if (hint)
        hint.textContent = _SEARCH_TENDENCY_HINTS[val] || _SEARCH_TENDENCY_HINTS[3];
}
let _uiLanguageSaveSeq = 0;
export function refreshUiLanguageSelect(language) {
    const uiLangSelect = cfgField('ui_language');
    const dd = cfgField('ui_language_dropdown');
    if (!uiLangSelect)
        return;
    const value = language || uiLangSelect.value || getLanguage();
    const opts = getAvailableLanguages();
    uiLangSelect.value = value;
    if (!dd)
        return;
    const menu = dd.querySelector('.dashboard-custom-select__menu');
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    const selectedLabel = (opts.find(o => o.code === value)?.label) || (opts[0]?.label) || '—';
    if (valueEl)
        valueEl.textContent = selectedLabel;
    if (menu) {
        menu.innerHTML = opts.map(o => {
            const isSelected = o.code === value;
            return `<button type="button" class="dashboard-custom-select__option" data-value="${o.code}" data-selected="${isSelected ? 'true' : 'false'}">${o.label}</button>`;
        }).join('');
    }
}
let _uiLanguageDropdownBound = false;
if (typeof document !== 'undefined' && !_uiLanguageDropdownBound) {
    _uiLanguageDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = cfgField('ui_language_dropdown');
        if (!dd)
            return;
        const tgt = e.target;
        if (!tgt)
            return;
        const toggleBtn = tgt.closest('[data-action="toggle-ui-language"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = tgt.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value;
            dd.dataset.open = 'false';
            const hidden = cfgField('ui_language');
            if (hidden && value && hidden.value !== value) {
                hidden.value = value;
                applyAndSaveUiLanguage(value);
            }
            return;
        }
        if (!dd.contains(tgt))
            dd.dataset.open = 'false';
    });
}
async function applyAndSaveUiLanguage(language) {
    if (!language)
        return;
    const previousLanguage = getLanguage();
    const saveSeq = ++_uiLanguageSaveSeq;
    const dd = cfgField('ui_language_dropdown');
    try {
        setLanguage(language);
        await loadComponentTranslations(language);
        refreshUiLanguageSelect(language);
        try {
            initGenericCustomSelects();
        }
        catch (_) { }
        if (dd)
            dd.dataset.disabled = 'true';
        await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
    }
    catch (err) {
        if (saveSeq === _uiLanguageSaveSeq) {
            try {
                setLanguage(previousLanguage);
                refreshUiLanguageSelect(previousLanguage);
            }
            catch (_) { }
            showToast(t('config.save_error'), 'error');
        }
    }
    finally {
        if (dd && saveSeq === _uiLanguageSaveSeq)
            dd.dataset.disabled = 'false';
    }
}
