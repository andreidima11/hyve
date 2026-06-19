/**
 * Short-lived camera stream tokens for media URLs (<img>/<video> cannot send Authorization).
 */
import { apiCall } from './api.js';
const _MEDIA_CACHE_KEY = '__media__';
const _cacheByKey = new Map();
function _cacheFor(key) {
    let row = _cacheByKey.get(key);
    if (!row) {
        row = { token: '', expiresAt: 0, inflight: null };
        _cacheByKey.set(key, row);
    }
    return row;
}
export async function getCameraStreamToken(entityId = '') {
    const key = String(entityId || '').trim() || _MEDIA_CACHE_KEY;
    const cache = _cacheFor(key);
    const now = Date.now();
    if (cache.token && cache.expiresAt > now + 30000) {
        return cache.token;
    }
    if (cache.inflight)
        return cache.inflight;
    cache.inflight = (async () => {
        try {
            const body = key === _MEDIA_CACHE_KEY ? {} : { entity_id: key };
            const res = await apiCall('/api/cameras/stream-token', { method: 'POST', body });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(String(data.detail || data.message || `HTTP ${res.status}`));
            }
            cache.token = String(data.token || '');
            const ttlMs = Math.max(60, Number(data.expires_in || 300)) * 1000;
            cache.expiresAt = Date.now() + ttlMs;
            return cache.token;
        }
        finally {
            cache.inflight = null;
        }
    })();
    return cache.inflight;
}
/** Build a proxied camera/image URL with a short-lived token. */
export async function cameraMediaUrl(entityId, kind = 'snapshot', { cacheBust } = {}) {
    const token = await getCameraStreamToken(entityId);
    const base = `/api/cameras/${encodeURIComponent(entityId)}/${kind}`;
    const q = `token=${encodeURIComponent(token)}`;
    if (kind === 'snapshot' || kind === 'image') {
        return `${base}?${q}&t=${cacheBust ?? Date.now()}`;
    }
    return `${base}?${q}`;
}
export function peekCameraStreamToken(entityId = '') {
    const key = String(entityId || '').trim() || _MEDIA_CACHE_KEY;
    return _cacheFor(key).token || '';
}
function _peekMediaAuthToken(entityId = '') {
    return peekCameraStreamToken(entityId);
}
/** Append cached short-lived media token to same-origin proxy URLs. */
export function appendMediaQueryToken(rawUrl, entityId = '') {
    const url = String(rawUrl || '');
    if (!url.startsWith('/'))
        return url;
    const token = _peekMediaAuthToken(entityId);
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
    _cacheByKey.clear();
}
/** Sync URL builder — requires prior getCameraStreamToken(entityId). */
export function cameraProxyUrlSync(entityId, kind = 'snapshot', cacheValue = Date.now()) {
    const params = new URLSearchParams();
    const token = peekCameraStreamToken(entityId);
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
    const token = peekCameraStreamToken(entityId);
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
const _CAMERA_STREAM_SELECTOR = 'hv-camera-stream, hv-mammotion-camera, hv-camera-carousel';
function _forEachCameraStream(root, fn, except) {
    root.querySelectorAll(_CAMERA_STREAM_SELECTOR).forEach((el) => {
        if (except?.contains(el))
            return;
        try {
            fn(el);
        }
        catch {
            /* ignore */
        }
    });
}
/** Pause dashboard/background camera streams so a modal viewer can take the Agora slot. */
export function pauseBackgroundCameraStreams(exceptRoot = null) {
    _forEachCameraStream(document, (el) => el.pauseStream?.(), exceptRoot);
}
/** Resume camera streams outside the entity detail modal after it closes. */
export function resumeBackgroundCameraStreams(exceptRoot = null) {
    _forEachCameraStream(document, (el) => el.resumeStream?.(), exceptRoot);
}
/** Stop live previews in the entity detail modal (MJPEG/WebM and Mammotion Agora). */
export function pauseEntityDetailCameraStreams(root = document.getElementById('entity-detail-modal')) {
    if (!root)
        return;
    _forEachCameraStream(root, (el) => el.pauseStream?.());
}
