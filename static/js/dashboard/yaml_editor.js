/**
 * YAML editor for the active dashboard page.
 * Lazy-loads CodeMirror 5 from CDN on first open.
 */
export function createDashboardYamlEditor(deps) {
    const { apiCall, t, showToast, getActivePageId, getActivePageName, reloadDashboard, } = deps;
    let cm = null;
    let cdnLoading = null;
    const CDN = {
        css: 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css',
        themeCss: 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css',
        js: 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js',
        modeJs: 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/yaml/yaml.min.js',
    };
    function loadCss(href, id) {
        return new Promise((resolve) => {
            if (document.getElementById(id)) {
                resolve();
                return;
            }
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = () => resolve();
            link.onerror = () => resolve();
            document.head.appendChild(link);
        });
    }
    function loadJs(src, id) {
        return new Promise((resolve, reject) => {
            if (document.getElementById(id)) {
                resolve();
                return;
            }
            const s = document.createElement('script');
            s.id = id;
            s.src = src;
            s.async = false;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('CDN load failed: ' + src));
            document.head.appendChild(s);
        });
    }
    async function ensureCodeMirror() {
        if (window.CodeMirror)
            return true;
        if (cdnLoading)
            return cdnLoading;
        cdnLoading = (async () => {
            try {
                await Promise.all([
                    loadCss(CDN.css, 'cm-core-css'),
                    loadCss(CDN.themeCss, 'cm-theme-css'),
                ]);
                await loadJs(CDN.js, 'cm-core-js');
                await loadJs(CDN.modeJs, 'cm-yaml-js');
                return true;
            }
            catch (_) {
                return false;
            }
        })();
        return cdnLoading;
    }
    function setStatus(msg, kind = 'info') {
        const el = document.getElementById('dashboard-yaml-status');
        if (!el)
            return;
        el.textContent = msg || '';
        el.className = 'ml-auto text-[11px] ' + (kind === 'error' ? 'text-red-400' :
            kind === 'ok' ? 'text-emerald-400' :
                kind === 'busy' ? 'text-amber-300' :
                    'text-slate-500');
    }
    async function fetchYaml() {
        const pid = getActivePageId();
        if (!pid)
            throw new Error('Nu există o pagină activă.');
        const res = await apiCall(`/api/dashboard/pages/${encodeURIComponent(pid)}/yaml`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        return data.yaml || '';
    }
    function getValue() {
        if (cm)
            return cm.getValue();
        const ta = document.getElementById('dashboard-yaml-editor');
        return ta ? ta.value : '';
    }
    function setValue(text) {
        const ta = document.getElementById('dashboard-yaml-editor');
        if (ta)
            ta.value = text || '';
        if (cm) {
            cm.setValue(text || '');
            setTimeout(() => cm && cm.refresh(), 0);
        }
    }
    async function openDashboardYamlEditor() {
        const modal = document.getElementById('dashboard-yaml-modal');
        if (!modal)
            return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        const nameEl = document.getElementById('dashboard-yaml-page-name');
        if (nameEl)
            nameEl.textContent = '— ' + getActivePageName();
        setStatus(t('dashboard.yaml_loading'), 'busy');
        try {
            const yaml = await fetchYaml();
            const ready = await ensureCodeMirror();
            if (ready && window.CodeMirror && !cm) {
                const ta = document.getElementById('dashboard-yaml-editor');
                if (ta) {
                    cm = window.CodeMirror.fromTextArea(ta, {
                        mode: 'yaml',
                        theme: 'dracula',
                        lineNumbers: true,
                        indentUnit: 2,
                        tabSize: 2,
                        indentWithTabs: false,
                        lineWrapping: false,
                        viewportMargin: Infinity,
                    });
                    cm.setSize('100%', '60vh');
                }
            }
            setValue(yaml);
            setStatus('Pagina ' + getActivePageId(), 'info');
        }
        catch (e) {
            const message = e instanceof Error ? e.message : t('dashboard.load_error');
            setStatus(message, 'error');
            setValue('# ' + message);
        }
    }
    function closeDashboardYamlEditor() {
        const modal = document.getElementById('dashboard-yaml-modal');
        if (!modal)
            return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    async function reloadDashboardYaml() {
        setStatus('Se reîncarcă…', 'busy');
        try {
            const yaml = await fetchYaml();
            setValue(yaml);
            setStatus('Reîncărcat', 'ok');
        }
        catch (e) {
            const message = e instanceof Error ? e.message : t('common.error');
            setStatus(message, 'error');
        }
    }
    async function saveDashboardYaml() {
        const pid = getActivePageId();
        if (!pid) {
            setStatus('Nu există pagină activă', 'error');
            return;
        }
        const text = getValue();
        if (!text || !text.trim()) {
            setStatus(t('dashboard.yaml_empty'), 'error');
            return;
        }
        setStatus('Se salvează…', 'busy');
        try {
            const res = await apiCall(`/api/dashboard/pages/${encodeURIComponent(pid)}/yaml`, {
                method: 'PUT',
                body: { yaml: text },
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok)
                throw new Error(data.detail || `HTTP ${res.status}`);
            if (data.yaml)
                setValue(data.yaml);
            setStatus('Salvat ✓', 'ok');
            showToast(t('dashboard.yaml_saved'), 'success');
            try {
                await reloadDashboard();
            }
            catch (_) { }
        }
        catch (e) {
            const message = e instanceof Error ? e.message : t('dashboard.yaml_save_error');
            setStatus(message, 'error');
            showToast(message, 'error');
        }
    }
    return {
        openDashboardYamlEditor,
        closeDashboardYamlEditor,
        reloadDashboardYaml,
        saveDashboardYaml,
    };
}
