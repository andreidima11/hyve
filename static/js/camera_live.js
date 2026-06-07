/**
 * Helpers for choosing live camera transport (WebM+audio vs MJPEG vs go2rtc).
 * Tapo sets live_providers including "webm"; Frigate uses mjpeg/go2rtc only.
 */

export function cameraHasRtspLive(attrs) {
    if (!attrs || typeof attrs !== 'object') return false;
    for (const key of ['rtsp_url', 'stream_url']) {
        const url = String(attrs[key] || '').trim().toLowerCase();
        if (url.startsWith('rtsp://')) return true;
    }
    return false;
}

export function cameraSupportsWebmLive(attrs) {
    if (!attrs || typeof attrs !== 'object') return false;
    const providers = attrs.live_providers;
    if (Array.isArray(providers) && providers.includes('webm')) return true;
    return false;
}

/**
 * Tapo/Reolink-style live player (WebM + audio).
 * Frigate exposes RTSP for restream but live_providers are mjpeg/go2rtc only —
 * do not treat bare rtsp_url as WebM-capable when providers are declared.
 */
export function cameraPreferWebmPlayer(attrs) {
    if (!attrs || typeof attrs !== 'object') return false;
    const providers = attrs.live_providers;
    if (Array.isArray(providers)) {
        return providers.includes('webm');
    }
    return cameraHasRtspLive(attrs);
}

/** HTTP MJPEG or snapshot proxy (Frigate, birdseye, etc.). */
export function cameraPreferHttpLive(attrs) {
    if (!attrs || typeof attrs !== 'object') return false;
    const providers = attrs.live_providers;
    if (Array.isArray(providers)) {
        return providers.includes('mjpeg') || providers.includes('go2rtc') || providers.includes('snapshot');
    }
    const mjpeg = String(attrs.mjpeg_url || '').trim();
    return mjpeg.startsWith('http://') || mjpeg.startsWith('https://');
}

/** Pick the live transport for hyve-camera-live-player. */
export function cameraLiveTransport(attrs) {
    if (cameraSupportsGo2rtc(attrs)) return 'go2rtc';
    if (cameraPreferWebmPlayer(attrs)) return 'webm';
    return 'mjpeg';
}

export function cameraSupportsGo2rtc(attrs) {
    if (!attrs || typeof attrs !== 'object') return false;
    return !!(attrs.go2rtc_available && attrs.go2rtc_stream);
}

export function cameraMseCodecs() {
    return [
        'avc1.640029',
        'avc1.64002A',
        'avc1.640033',
        'mp4a.40.2',
        'mp4a.40.5',
        'opus',
    ].join(',');
}

export function cameraGo2rtcWsUrl(entityId) {
    const params = new URLSearchParams();
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('hyve_token') : '';
    if (token) params.set('token', token);
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : '';
    return `${protocol}//${host}/api/cameras/${encodeURIComponent(entityId)}/go2rtc/ws?${params.toString()}`;
}
