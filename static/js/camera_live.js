/**
 * Helpers for choosing live camera transport (WebM+audio vs MJPEG vs go2rtc).
 */
import { peekCameraStreamToken } from './camera_auth.js';
function asCameraAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object')
        return null;
    return attrs;
}
export function cameraHasRtspLive(attrs) {
    const a = asCameraAttrs(attrs);
    if (!a)
        return false;
    const providers = a.live_providers;
    if (Array.isArray(providers)) {
        return providers.includes('rtsp') || providers.includes('webm');
    }
    for (const key of ['rtsp_url', 'stream_url']) {
        const url = String(a[key] || '').trim().toLowerCase();
        if (url.startsWith('rtsp://'))
            return true;
    }
    return false;
}
export function cameraSupportsWebmLive(attrs) {
    const a = asCameraAttrs(attrs);
    if (!a)
        return false;
    const providers = a.live_providers;
    return Array.isArray(providers) && providers.includes('webm');
}
/**
 * Tapo/Reolink-style live player (WebM + audio).
 * Frigate exposes RTSP for restream but live_providers are mjpeg/go2rtc only —
 * do not treat bare rtsp_url as WebM-capable when providers are declared.
 */
export function cameraPreferWebmPlayer(attrs) {
    const a = asCameraAttrs(attrs);
    if (!a)
        return false;
    const providers = a.live_providers;
    if (Array.isArray(providers)) {
        return providers.includes('webm');
    }
    return cameraHasRtspLive(attrs);
}
/** HTTP MJPEG or snapshot proxy (Frigate, birdseye, etc.). */
export function cameraPreferHttpLive(attrs) {
    const a = asCameraAttrs(attrs);
    if (!a)
        return false;
    const providers = a.live_providers;
    if (Array.isArray(providers)) {
        return providers.includes('mjpeg') || providers.includes('go2rtc') || providers.includes('snapshot');
    }
    const mjpeg = String(a.mjpeg_url || '').trim();
    return mjpeg.startsWith('http://') || mjpeg.startsWith('https://');
}
/** Mammotion lawn mower — Agora cloud WebRTC (not RTSP/MJPEG). */
export function cameraIsAgoraMammotion(attrs) {
    const a = asCameraAttrs(attrs);
    if (!a)
        return false;
    if (String(a.stream_type || '') === 'agora_webrtc')
        return true;
    const providers = a.live_providers;
    return Array.isArray(providers) && providers.includes('agora');
}
/** Entity id fallback when dashboard cache attrs are not loaded yet. */
export function cameraEntityIdIsMammotionWebrtc(entityId) {
    return String(entityId || '').trim().endsWith('_webrtc');
}
export function cameraIsMammotionLive(entityId, attrs) {
    return cameraIsAgoraMammotion(attrs) || cameraEntityIdIsMammotionWebrtc(entityId);
}
/** Mammotion Agora camera — attrs and/or entity_id suffix (integrations list may omit stream_type). */
export function cameraIsMammotionEntity(entityId, attrs) {
    return cameraIsMammotionLive(entityId, attrs);
}
/** Dashboard camera card — autoplay checkbox; defaults on for live mode and Mammotion. */
export function cameraAutoplayEnabled(cfg, options) {
    const raw = cfg?.autoplay;
    if (raw === false || raw === 'false')
        return false;
    if (raw === true || raw === 'true')
        return true;
    return options.liveMode || options.mammotionOnly;
}
/** Pick the live transport for `<hv-camera-stream>` / dashboard camera cards. */
export function cameraLiveTransport(attrs) {
    if (cameraIsAgoraMammotion(attrs))
        return 'agora';
    if (cameraSupportsGo2rtc(attrs))
        return 'go2rtc';
    if (cameraPreferWebmPlayer(attrs))
        return 'webm';
    return 'mjpeg';
}
export function cameraSupportsGo2rtc(attrs) {
    const a = asCameraAttrs(attrs);
    if (!a)
        return false;
    return !!(a.go2rtc_available && a.go2rtc_stream);
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
    const token = peekCameraStreamToken(entityId);
    if (token)
        params.set('token', token);
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof window !== 'undefined' ? window.location.host : '';
    const qs = params.toString();
    return `${protocol}//${host}/api/cameras/${encodeURIComponent(entityId)}/go2rtc/ws${qs ? `?${qs}` : ''}`;
}
