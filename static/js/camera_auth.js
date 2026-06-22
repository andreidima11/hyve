/**
 * Short-lived tokens for camera streams and media proxy URLs.
 */
import { apiCall, resolveAuthToken } from './api.js';
const CAMERA_ENTITY_RE = /^(camera|image)\.[a-z0-9_.-]+$/i;
const _cameraCacheByEntity = new Map();
let _mediaProxyCache = { token: '', expiresAt: 0, inflight: null };
function _cacheForEntity(entityId) {
    const key = String(entityId || '').trim();
    let row = _cameraCacheByEntity.get(key);
    if (!row) {
        row = { token: '', expiresAt: 0, inflight: null };
        _cameraCacheByEntity.set(key, row);
    }
    return row;
}
export function hasCameraAuthSession() {
    const token = resolveAuthToken();
    return !!(token && token !== 'null' && token !== 'undefined');
}
function _requireCameraAuthSession() {
    if (!hasCameraAuthSession()) {
        throw new Error('Not authenticated');
    }
}
function _normalizeCameraEntityId(entityId) {
    const key = String(entityId || '').trim();
    if (!CAMERA_ENTITY_RE.test(key)) {
        throw new Error(`Invalid camera entity_id: ${key || '(empty)'}`);
    }
    return key;
}
function _invalidateCache(cache) {
    cache.token = '';
    cache.expiresAt = 0;
}
async function _fetchToken(cache, path, body) {
    _requireCameraAuthSession();
    const now = Date.now();
    if (cache.token && cache.expiresAt > now + 30000) {
        return cache.token;
    }
    if (path.includes('/cameras/stream-token')) {
        const eid = _normalizeCameraEntityId(String(body.entity_id || ''));
        body = { entity_id: eid };
    }
    if (cache.inflight)
        return cache.inflight;
    cache.inflight = (async () => {
        try {
            const res = await apiCall(path, { method: 'POST', body });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401 || res.status === 403 || res.status === 422) {
                    _invalidateCache(cache);
                }
                const detail = data.detail;
                const msg = typeof detail === 'object' && detail && 'key' in detail
                    ? String(detail.key || '')
                    : String(detail || data.message || `HTTP ${res.status}`);
                throw new Error(msg || `HTTP ${res.status}`);
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
export async function getCameraStreamToken(entityId) {
    const key = _normalizeCameraEntityId(entityId);
    return _fetchToken(_cacheForEntity(key), '/api/cameras/stream-token', { entity_id: key });
}
export async function getMediaProxyToken() {
    return _fetchToken(_mediaProxyCache, '/api/media/stream-token', {});
}
export async function cameraMediaUrl(entityId, kind = 'snapshot', { cacheBust } = {}) {
    const key = _normalizeCameraEntityId(entityId);
    const token = await getCameraStreamToken(key);
    const base = `/api/cameras/${encodeURIComponent(key)}/${kind}`;
    const q = `token=${encodeURIComponent(token)}`;
    if (kind === 'snapshot' || kind === 'image') {
        return `${base}?${q}&t=${cacheBust ?? Date.now()}`;
    }
    return `${base}?${q}`;
}
export function peekCameraStreamToken(entityId) {
    return _cacheForEntity(String(entityId || '').trim()).token || '';
}
export function peekMediaProxyToken() {
    return _mediaProxyCache.token || '';
}
function _peekMediaAuthToken() {
    return peekMediaProxyToken();
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
/** Sync img-proxy URL — requires prior getMediaProxyToken(). */
export function imgProxyUrlSync(externalUrl) {
    const base = `/api/img-proxy?url=${encodeURIComponent(String(externalUrl || ''))}`;
    return appendMediaQueryToken(base);
}
/** Sync favicon proxy URL — requires prior getMediaProxyToken(). */
export function faviconProxyUrlSync(domain) {
    const base = `/api/favicon?domain=${encodeURIComponent(String(domain || ''))}`;
    return appendMediaQueryToken(base);
}
export function clearCameraStreamTokenCache() {
    _cameraCacheByEntity.clear();
    _mediaProxyCache = { token: '', expiresAt: 0, inflight: null };
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
if (typeof window !== 'undefined') {
    window.addEventListener('hyve:auth-changed', () => clearCameraStreamTokenCache());
}
