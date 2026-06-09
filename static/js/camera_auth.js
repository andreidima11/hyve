/**
 * Short-lived camera stream tokens for media URLs (<img>/<video> cannot send Authorization).
 */
import { apiCall } from './api.js';
let _cache = { token: '', expiresAt: 0, inflight: null };
export async function getCameraStreamToken() {
    const now = Date.now();
    if (_cache.token && _cache.expiresAt > now + 30000) {
        return _cache.token;
    }
    if (_cache.inflight)
        return _cache.inflight;
    _cache.inflight = (async () => {
        try {
            const res = await apiCall('/api/cameras/stream-token', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(String(data.detail || data.message || `HTTP ${res.status}`));
            }
            _cache.token = String(data.token || '');
            const ttlMs = Math.max(60, Number(data.expires_in || 300)) * 1000;
            _cache.expiresAt = Date.now() + ttlMs;
            return _cache.token;
        }
        finally {
            _cache.inflight = null;
        }
    })();
    return _cache.inflight;
}
/** Build a proxied camera/image URL with a short-lived token. */
export async function cameraMediaUrl(entityId, kind = 'snapshot', { cacheBust } = {}) {
    const token = await getCameraStreamToken();
    const base = `/api/cameras/${encodeURIComponent(entityId)}/${kind}`;
    const q = `token=${encodeURIComponent(token)}`;
    if (kind === 'snapshot' || kind === 'image') {
        return `${base}?${q}&t=${cacheBust ?? Date.now()}`;
    }
    return `${base}?${q}`;
}
export function peekCameraStreamToken() {
    return _cache.token || '';
}
function _peekMediaAuthToken() {
    const cached = peekCameraStreamToken();
    if (cached)
        return cached;
    try {
        return localStorage.getItem('hyve_token') || '';
    }
    catch {
        return '';
    }
}
/** Append cached short-lived media token to same-origin proxy URLs. */
export function appendMediaQueryToken(rawUrl) {
    const url = String(rawUrl || '');
    if (!url.startsWith('/'))
        return url;
    const token = _peekMediaAuthToken();
    if (!token)
        return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}token=${encodeURIComponent(token)}`;
}
/** Sync img-proxy URL — requires prior getCameraStreamToken(). */
export function imgProxyUrlSync(externalUrl) {
    const base = `/api/img-proxy?url=${encodeURIComponent(String(externalUrl || ''))}`;
    return appendMediaQueryToken(base);
}
/** Sync favicon proxy URL — requires prior getCameraStreamToken(). */
export function faviconProxyUrlSync(domain) {
    const base = `/api/favicon?domain=${encodeURIComponent(String(domain || ''))}`;
    return appendMediaQueryToken(base);
}
export function clearCameraStreamTokenCache() {
    _cache = { token: '', expiresAt: 0, inflight: null };
}
/** Sync URL builder — requires prior getCameraStreamToken() (uses cached short-lived token). */
export function cameraProxyUrlSync(entityId, kind = 'snapshot', cacheValue = Date.now()) {
    const params = new URLSearchParams();
    const token = peekCameraStreamToken();
    if (token)
        params.set('token', token);
    if (kind === 'snapshot' || kind === 'image') {
        params.set('t', String(cacheValue));
    }
    else {
        params.set('_t', String(cacheValue));
    }
    const qs = params.toString();
    return `/api/cameras/${encodeURIComponent(entityId)}/${kind}${qs ? `?${qs}` : ''}`;
}
export function cameraGo2rtcWsUrlSync(entityId) {
    const params = new URLSearchParams();
    const token = peekCameraStreamToken();
    if (token)
        params.set('token', token);
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : '';
    const qs = params.toString();
    return `${protocol}//${host}/api/cameras/${encodeURIComponent(entityId)}/go2rtc/ws${qs ? `?${qs}` : ''}`;
}
let _cameraPreviewTimer = null;
function _cacheBustCameraUrl(url) {
    const raw = String(url || '');
    if (!raw)
        return '';
    return `${raw}${raw.includes('?') ? '&' : '?'}_hyve=${Date.now()}`;
}
export function startCameraPreviewRefresh() {
    stopCameraPreviewRefresh();
    const img = document.querySelector('#entity-detail-modal img[data-camera-refresh="true"]');
    if (!img)
        return;
    _cameraPreviewTimer = window.setInterval(() => {
        const src = img.dataset.cameraSrc || '';
        if (src)
            img.src = _cacheBustCameraUrl(src);
    }, 4500);
}
export function stopCameraPreviewRefresh() {
    if (_cameraPreviewTimer) {
        window.clearInterval(_cameraPreviewTimer);
        _cameraPreviewTimer = null;
    }
}
