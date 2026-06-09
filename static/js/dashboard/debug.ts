/** Lightweight on-screen debug overlay for dashboard troubleshooting. */

export const DASH_DEBUG_ENABLED = ((): boolean => {
    try {
        if (typeof window === 'undefined') return false;
        const search = new URLSearchParams(window.location.search || '');
        if (search.get('dashdebug') === '1') {
            try { localStorage.setItem('hyve_dash_debug', '1'); } catch { /* ignore */ }
            return true;
        }
        if (search.get('dashdebug') === '0') {
            try { localStorage.removeItem('hyve_dash_debug'); } catch { /* ignore */ }
            return false;
        }
        try { return localStorage.getItem('hyve_dash_debug') === '1'; } catch { return false; }
    } catch { return false; }
})();

function ensureDashDebugOverlay(): HTMLElement | null {
    if (!DASH_DEBUG_ENABLED || typeof document === 'undefined') return null;
    let el = document.getElementById('hyve-dash-debug-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'hyve-dash-debug-overlay';
    el.style.cssText = [
        'position:fixed', 'right:6px', 'bottom:6px', 'z-index:99999',
        'max-width:min(94vw,440px)', 'max-height:42vh', 'overflow:auto',
        'background:rgba(8,12,20,0.92)', 'color:#cfe', 'font:11px/1.35 ui-monospace,Menlo,monospace',
        'padding:6px 8px', 'border:1px solid rgba(255,255,255,0.18)', 'border-radius:8px',
        'pointer-events:auto', 'white-space:pre-wrap', 'box-shadow:0 6px 24px rgba(0,0,0,0.5)',
    ].join(';');
    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:6px;"><strong style="color:#9ff">dash debug</strong><span><button type="button" data-dash-dbg-clear style="background:#345;color:#fff;border:0;border-radius:4px;padding:2px 6px;margin-right:4px;font:10px ui-monospace,monospace">clear</button><button type="button" data-dash-dbg-close style="background:#933;color:#fff;border:0;border-radius:4px;padding:2px 6px;font:10px ui-monospace,monospace">×</button></span></div><pre data-dash-dbg-body style="margin:0;color:#cfe;white-space:pre-wrap;word-break:break-word;"></pre>';
    document.body.appendChild(el);
    el.querySelector('[data-dash-dbg-close]')?.addEventListener('click', () => {
        try { localStorage.removeItem('hyve_dash_debug'); } catch { /* ignore */ }
        el?.remove();
    });
    el.querySelector('[data-dash-dbg-clear]')?.addEventListener('click', () => {
        if (typeof window !== 'undefined') window.__hyveDashLog = [];
        renderDashDebugOverlay();
    });
    return el;
}

let dashDebugRenderQueued = false;

function renderDashDebugOverlay(): void {
    if (!DASH_DEBUG_ENABLED || typeof window === 'undefined') return;
    if (dashDebugRenderQueued) return;
    dashDebugRenderQueued = true;
    requestAnimationFrame(() => {
        dashDebugRenderQueued = false;
        const el = ensureDashDebugOverlay();
        if (!el) return;
        const body = el.querySelector('[data-dash-dbg-body]');
        if (!body) return;
        const log = Array.isArray(window.__hyveDashLog) ? window.__hyveDashLog.slice(-40) : [];
        body.textContent = log.map((e) => {
            let info: unknown = e.info;
            if (info && typeof info === 'object') {
                try { info = JSON.stringify(info); } catch { info = String(info); }
            }
            return `${e.t} ${e.tag}${info != null ? ` ${info}` : ''}`;
        }).join('\n');
        el.scrollTop = el.scrollHeight;
    });
}

export function dashDebug(tag: string, info?: unknown): void {
    if (!DASH_DEBUG_ENABLED) return;
    try {
        const entry = { t: new Date().toISOString().slice(11, 23), tag: String(tag || ''), info };
        if (typeof window !== 'undefined') {
            if (!Array.isArray(window.__hyveDashLog)) window.__hyveDashLog = [];
            window.__hyveDashLog.push(entry);
            if (window.__hyveDashLog.length > 200) window.__hyveDashLog.shift();
        }
        console.log('[dash]', entry.t, entry.tag, info ?? '');
        renderDashDebugOverlay();
    } catch { /* ignore */ }
}

if (typeof window !== 'undefined') {
    window.__hyveDashDebug = { enabled: DASH_DEBUG_ENABLED, log: () => window.__hyveDashLog || [] };
    if (DASH_DEBUG_ENABLED) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => renderDashDebugOverlay());
        } else {
            renderDashDebugOverlay();
        }
    }
}
