/**
 * Short-lived camera stream tokens for media URLs (<img>/<video> cannot send Authorization).
 */
import { apiCall } from './api.js';

let _cache = { token: '', expiresAt: 0, inflight: null };

export async function getCameraStreamToken() {
    const now = Date.now();
    if (_cache.token && _cache.expiresAt > now + 30_000) {
        return _cache.token;
    }
    if (_cache.inflight) return _cache.inflight;
    _cache.inflight = (async () => {
        try {
            const res = await apiCall('/api/cameras/stream-token', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.detail || data.message || `HTTP ${res.status}`);
            }
            _cache.token = String(data.token || '');
            const ttlMs = Math.max(60, Number(data.expires_in || 300)) * 1000;
            _cache.expiresAt = Date.now() + ttlMs;
            return _cache.token;
        } finally {
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

export function clearCameraStreamTokenCache() {
    _cache = { token: '', expiresAt: 0, inflight: null };
}

let _cameraPreviewTimer = null;

function _cacheBustCameraUrl(url) {
    const raw = String(url || '');
    if (!raw) return '';
    return `${raw}${raw.includes('?') ? '&' : '?'}_hyve=${Date.now()}`;
}

export function startCameraPreviewRefresh() {
    stopCameraPreviewRefresh();
    const img = document.querySelector('#entity-detail-modal img[data-camera-refresh="true"]');
    if (!img) return;
    _cameraPreviewTimer = window.setInterval(() => {
        const src = img.dataset.cameraSrc || '';
        if (src) img.src = _cacheBustCameraUrl(src);
    }, 4500);
}

export function stopCameraPreviewRefresh() {
    if (_cameraPreviewTimer) {
        window.clearInterval(_cameraPreviewTimer);
        _cameraPreviewTimer = null;
    }
}
