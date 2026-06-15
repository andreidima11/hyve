/**
 * <hv-mammotion-camera> — Mammotion lawn mower live view via Agora WebRTC (HA parity).
 *
 * Attributes:
 *   entity — camera.* entity id (required)
 *   alt     — accessible label
 */
import { apiCall } from '../../js/api.js';
import { t, translateApiDetail } from '../../js/lang/index.js';
import { cameraLoaderMarkup, hideCameraLoader, showCameraLoaderError, showCameraLoaderLoading, } from '../../js/camera_loader.js';
const AGORA_SDK_URL = 'https://download.agora.io/sdk/release/AgoraRTC_N.js';
const MAMMOTION_CAMERA_API_TIMEOUT = 120000;
const JOIN_RELEASE_MS = 500;
const PUBLISHER_WAKE_MS = 2500;
const VIDEO_WAIT_MS = 30000;
const KEEPALIVE_MS = 90000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
let _agoraSdkPromise = null;
function _mcam(key, params) {
    const full = `cameras.${key}`;
    const out = t(full, params);
    return out !== full ? out : key;
}
/** One live Agora viewer per camera entity — avoids UID_CONFLICT across tabs/cards. */
const _entitySessions = new Map();
const _joinChains = new Map();
function _isUidConflict(err) {
    const msg = String(err instanceof Error ? err.message : err).toUpperCase();
    return msg.includes('UID_CONFLICT')
        || msg.includes('UUID CONFLICT')
        || msg.includes('UID CONFLICT');
}
function _sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
async function _withEntityJoinLock(entity, fn) {
    const prev = _joinChains.get(entity) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    _joinChains.set(entity, gate);
    await prev;
    try {
        return await fn();
    }
    finally {
        release();
        if (_joinChains.get(entity) === gate)
            _joinChains.delete(entity);
    }
}
async function _stopRemoteSession(entity) {
    try {
        await mammotionCameraApi(`/api/cameras/${encodeURIComponent(entity)}/mammotion/stop`, { method: 'POST' });
    }
    catch { /* best effort */ }
    await _sleep(JOIN_RELEASE_MS);
}
async function mammotionCameraApi(url, init = {}) {
    const res = await apiCall(url, { ...init, timeout: MAMMOTION_CAMERA_API_TIMEOUT });
    const raw = await res.text();
    let data = {};
    if (raw) {
        try {
            data = JSON.parse(raw);
        }
        catch {
            data = { detail: raw.slice(0, 240) };
        }
    }
    if (!res.ok) {
        const detail = translateApiDetail(data.detail) || String(data.message || '').trim();
        throw new Error(detail || raw.slice(0, 240) || t('common.error'));
    }
    return data;
}
function loadAgoraSdk() {
    if (window.AgoraRTC)
        return Promise.resolve();
    if (_agoraSdkPromise)
        return _agoraSdkPromise;
    _agoraSdkPromise = new Promise((resolve, reject) => {
        const fail = (message) => {
            _agoraSdkPromise = null;
            reject(new Error(message));
        };
        const existing = document.querySelector('script[data-hyve-agora-sdk]');
        if (existing) {
            if (window.AgoraRTC) {
                resolve();
                return;
            }
            existing.addEventListener('load', () => {
                if (window.AgoraRTC)
                    resolve();
                else
                    fail(_mcam('mammotion_agora_unavailable'));
            }, { once: true });
            existing.addEventListener('error', () => {
                existing.remove();
                fail(_mcam('mammotion_agora_load_failed'));
            }, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = AGORA_SDK_URL;
        script.async = true;
        script.dataset.hyveAgoraSdk = '1';
        script.onload = () => {
            if (window.AgoraRTC)
                resolve();
            else
                fail(_mcam('mammotion_agora_unavailable'));
        };
        script.onerror = () => {
            script.remove();
            fail(_mcam('mammotion_agora_load_failed'));
        };
        document.head.appendChild(script);
    });
    return _agoraSdkPromise;
}
class HyveMammotionCamera extends HTMLElement {
    constructor() {
        super(...arguments);
        this._stage = null;
        this._videoHost = null;
        this._loader = null;
        this._playBtn = null;
        this._client = null;
        this._remoteUsers = [];
        this._playing = false;
        this._connecting = false;
        this._observer = null;
        this._visible = false;
        this._paused = false;
        this._videoWaitTimer = null;
        this._keepaliveTimer = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._onVisibility = () => {
            if (document.hidden)
                this.pauseStream();
        };
    }
    static get observedAttributes() {
        return ['entity', 'alt', 'autoplay', 'force-active'];
    }
    _logStreamEvent(event, detail = {}) {
        const payload = {
            event,
            entity: this._entity,
            playing: this._playing,
            connecting: this._connecting,
            reconnectAttempts: this._reconnectAttempts,
            autoplay: this._wantsAutoplay(),
            visible: this._effectivelyVisible,
            ts: Date.now(),
            ...detail,
        };
        console.warn('[hv-mammotion-camera]', payload);
    }
    connectedCallback() {
        if (!this._stage)
            this._build();
        this._observer?.disconnect();
        if (!this._forceActive) {
            this._observer = new IntersectionObserver((entries) => {
                this._visible = entries.some(e => e.isIntersecting);
                if (!this._visible)
                    this.pauseStream();
                else
                    this._scheduleAutoplay();
            }, { threshold: 0.08 });
            this._observer.observe(this);
        }
        else {
            this._observer = null;
            this._visible = true;
            this._scheduleAutoplay();
        }
        document.addEventListener('visibilitychange', this._onVisibility);
    }
    disconnectedCallback() {
        document.removeEventListener('visibilitychange', this._onVisibility);
        this._observer?.disconnect();
        void this._teardown(true);
    }
    attributeChangedCallback(name) {
        if (!this._stage)
            return;
        if (name === 'autoplay' || name === 'force-active' || name === 'entity') {
            if (this._forceActive) {
                this._observer?.disconnect();
                this._observer = null;
                this._visible = true;
            }
            this._scheduleAutoplay();
            return;
        }
        this._setIdleMessage();
    }
    pauseStream() {
        this._paused = true;
        if (this._playing || this._connecting)
            void this._teardown(false);
    }
    resumeStream() {
        this._paused = false;
        this._scheduleAutoplay();
    }
    _wantsAutoplay() {
        return String(this.getAttribute('autoplay') || '').toLowerCase() === 'true';
    }
    get _forceActive() {
        return String(this.getAttribute('force-active') || '').toLowerCase() === 'true';
    }
    get _effectivelyVisible() {
        return this._forceActive || this._visible;
    }
    _shouldStayLive() {
        return !this._paused
            && this._effectivelyVisible
            && !document.hidden
            && !!this._entity
            && (this._wantsAutoplay() || this._playing || this._connecting);
    }
    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            window.clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
    _scheduleReconnect(reason) {
        if (!this._shouldStayLive())
            return;
        if (this._reconnectTimer || this._connecting)
            return;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(1.5, this._reconnectAttempts));
        this._logStreamEvent('reconnect-scheduled', { reason, delayMs: delay });
        this._reconnectTimer = window.setTimeout(() => {
            this._reconnectTimer = null;
            void this._attemptReconnect(reason);
        }, delay);
    }
    _stopKeepalive() {
        if (this._keepaliveTimer) {
            window.clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }
    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveTimer = window.setInterval(() => {
            void this._keepaliveTick();
        }, KEEPALIVE_MS);
    }
    _scheduleAutoplay() {
        if (!this._wantsAutoplay() || this._paused || !this._effectivelyVisible || document.hidden)
            return;
        if (this._playing || this._connecting || !this._entity)
            return;
        this._primeAutoplayUi();
        queueMicrotask(() => this._maybeAutoplay());
    }
    _primeAutoplayUi() {
        if (this._playing || this._connecting)
            return;
        this._setState('loading');
        this._setIdleMessage(_mcam('mammotion_connecting'));
    }
    _maybeAutoplay() {
        if (!this._wantsAutoplay() || this._paused || !this._effectivelyVisible || document.hidden)
            return;
        if (this._playing || this._connecting || !this._entity)
            return;
        void this._startPlayback();
    }
    get _entity() {
        return String(this.getAttribute('entity') || '').trim();
    }
    _build() {
        this.classList.add('hy-mammotion-camera', 'block', 'w-full', 'h-full');
        this.innerHTML = `
      <div class="hy-mammotion-camera__stage relative block w-full h-full min-h-0 bg-black overflow-hidden">
        ${cameraLoaderMarkup()}
        <div class="hy-mammotion-camera__video w-full h-full" data-mammotion-video-host></div>
        <button type="button" class="hy-mammotion-camera__play" data-mammotion-play aria-label="Play">
          <i class="fas fa-play ml-0.5"></i>
        </button>
        <div class="hy-mammotion-camera__hint absolute inset-x-0 bottom-3 text-center text-[11px] text-slate-300 px-3 pointer-events-none" data-mammotion-hint></div>
      </div>`;
        this._stage = this.querySelector('.hy-mammotion-camera__stage');
        this._videoHost = this.querySelector('[data-mammotion-video-host]');
        this._loader = this.querySelector('[data-hv-cam-loader]');
        this._playBtn = this.querySelector('[data-mammotion-play]');
        this._playBtn?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void this._startPlayback();
        });
        this._setIdleMessage();
        hideCameraLoader(this._loader);
        this.dataset.state = 'idle';
    }
    _setIdleMessage(msg) {
        const hint = this.querySelector('[data-mammotion-hint]');
        if (hint)
            hint.textContent = msg ?? _mcam('mammotion_press_play');
    }
    _setState(state) {
        this.dataset.state = state;
        if (state === 'loading')
            showCameraLoaderLoading(this._loader);
        else if (state === 'error') {
            const hint = this.querySelector('[data-mammotion-hint]');
            const msg = String(hint?.textContent || '').trim();
            showCameraLoaderError(this._loader, msg || undefined);
        }
        else
            hideCameraLoader(this._loader);
        if (this._playBtn) {
            this._playBtn.style.display = (state === 'ready' || state === 'loading') ? 'none' : 'flex';
        }
    }
    async _fetchTokens() {
        const eid = encodeURIComponent(this._entity);
        const started = await mammotionCameraApi(`/api/cameras/${eid}/mammotion/start`, { method: 'POST' });
        if (started?.tokens?.appid)
            return started.tokens;
        throw new Error(_mcam('mammotion_token_unavailable'));
    }
    async _fetchKeepaliveTokens() {
        const eid = encodeURIComponent(this._entity);
        const resp = await mammotionCameraApi(`/api/cameras/${eid}/mammotion/keepalive`, { method: 'POST' });
        if (resp?.tokens?.appid)
            return resp.tokens;
        throw new Error(_mcam('mammotion_token_unavailable'));
    }
    async _renewClientToken(token) {
        const client = this._client;
        if (!client)
            return;
        try {
            await client.renewToken(token);
        }
        catch (err) {
            console.warn('[hv-mammotion-camera] renewToken failed', err);
            throw err;
        }
    }
    async _refreshAgoraToken(wakeRobot) {
        if (!this._client || !this._entity)
            return;
        const tokens = wakeRobot
            ? await this._fetchKeepaliveTokens()
            : await mammotionCameraApi(`/api/cameras/${encodeURIComponent(this._entity)}/mammotion/tokens`).then((r) => r.tokens);
        if (tokens?.token)
            await this._renewClientToken(tokens.token);
    }
    async _keepaliveTick() {
        if (!this._playing || this._paused || !this._shouldStayLive())
            return;
        try {
            await this._refreshAgoraToken(true);
            this._reconnectAttempts = 0;
        }
        catch (err) {
            this._logStreamEvent('keepalive-failed', { error: String(err) });
            if (this._playing && this._shouldStayLive())
                this._scheduleReconnect('keepalive-failed');
        }
    }
    async _attemptReconnect(reason) {
        if (!this._shouldStayLive())
            return;
        if (this._connecting)
            return;
        const entity = this._entity;
        if (!entity)
            return;
        this._logStreamEvent('reconnect-start', { reason });
        this._connecting = true;
        this._setState('loading');
        this._setIdleMessage(_mcam('mammotion_reconnecting'));
        try {
            await _withEntityJoinLock(entity, async () => {
                if (!this._shouldStayLive() || this._entity !== entity)
                    return;
                await this._releaseOtherViewers();
                await this._leaveClient();
                if (!this._shouldStayLive() || this._entity !== entity)
                    return;
                const tokens = await this._fetchTokens();
                if (!this._shouldStayLive() || this._entity !== entity)
                    return;
                await this._connectAgora(tokens, 0);
            });
            this._reconnectAttempts = 0;
            this._logStreamEvent('reconnect-success', { reason });
        }
        catch (err) {
            this._logStreamEvent('reconnect-failed', { reason, error: String(err) });
            this._reconnectAttempts += 1;
            if (this._reconnectAttempts >= 8 || !this._wantsAutoplay()) {
                this._unregisterSession();
                const msg = err instanceof Error ? err.message : _mcam('mammotion_connection_lost_short');
                this._setIdleMessage(this._wantsAutoplay()
                    ? `${msg} ${_mcam('mammotion_press_play_suffix')}`
                    : _mcam('mammotion_connection_lost'));
                this._setState('idle');
                return;
            }
            this._scheduleReconnect(reason);
        }
        finally {
            if (!this._playing)
                this._connecting = false;
        }
    }
    _unregisterSession() {
        if (this._entity && _entitySessions.get(this._entity) === this) {
            _entitySessions.delete(this._entity);
        }
    }
    async _releaseOtherViewers() {
        const other = _entitySessions.get(this._entity);
        if (other && other !== this) {
            await other._teardown(false);
        }
    }
    async _leaveClient() {
        const client = this._client;
        this._client = null;
        if (!client)
            return;
        try {
            await client.leave();
        }
        catch { /* ignore */ }
        await _sleep(200);
    }
    _clearVideoWaitTimer() {
        if (this._videoWaitTimer) {
            window.clearTimeout(this._videoWaitTimer);
            this._videoWaitTimer = null;
        }
    }
    _armVideoWaitTimer() {
        this._clearVideoWaitTimer();
        this._videoWaitTimer = window.setTimeout(() => {
            this._videoWaitTimer = null;
            if (!this._connecting || this._playing)
                return;
            this._connecting = false;
            void this._leaveClient();
            this._unregisterSession();
            this._setState('idle');
            this._setIdleMessage(_mcam('mammotion_no_video'));
            this._logStreamEvent('video-wait-timeout');
        }, VIDEO_WAIT_MS);
    }
    async _playRemoteVideo(remote) {
        if (!remote.videoTrack || !this._videoHost)
            return;
        this._videoHost.innerHTML = '';
        remote.videoTrack.play(this._videoHost);
        if (!this._remoteUsers.some(u => u.uid === remote.uid))
            this._remoteUsers.push(remote);
        this._playing = true;
        this._connecting = false;
        this._clearVideoWaitTimer();
        this._reconnectAttempts = 0;
        this._startKeepalive();
        this._logStreamEvent('playing');
        this._setState('ready');
        this._setIdleMessage('');
    }
    async _subscribeRemote(client, remote, mediaType) {
        await client.subscribe(remote, mediaType);
        if (mediaType === 'video')
            await this._playRemoteVideo(remote);
        if (mediaType === 'audio' && remote.audioTrack)
            remote.audioTrack.play();
    }
    async _subscribeExistingPublishers(client) {
        const existing = Array.isArray(client.remoteUsers) ? client.remoteUsers : [];
        for (const remote of existing) {
            try {
                await this._subscribeRemote(client, remote, 'video');
            }
            catch { /* publisher may not have video yet */ }
        }
    }
    async _connectAgora(tokens, attempt) {
        await loadAgoraSdk();
        if (!window.AgoraRTC)
            throw new Error(_mcam('mammotion_agora_unavailable'));
        await this._leaveClient();
        const client = window.AgoraRTC.createClient({
            mode: 'live',
            codec: 'vp8',
        });
        this._client = client;
        this._remoteUsers = [];
        client.on('user-published', async (user, mediaType) => {
            try {
                await this._subscribeRemote(client, user, String(mediaType));
            }
            catch (err) {
                console.warn('[hv-mammotion-camera] subscribe failed', err);
            }
        });
        client.on('user-unpublished', (user, mediaType) => {
            if (mediaType !== 'video')
                return;
            const remote = user;
            this._remoteUsers = this._remoteUsers.filter(u => u.uid !== remote.uid);
            if (!this._remoteUsers.length) {
                this._playing = false;
                this._stopKeepalive();
                if (this._videoHost)
                    this._videoHost.innerHTML = '';
                if (this._shouldStayLive() && this._wantsAutoplay()) {
                    this._logStreamEvent('publisher-left');
                    this._setState('loading');
                    this._setIdleMessage(_mcam('mammotion_reconnecting'));
                    this._scheduleReconnect('publisher-left');
                }
                else {
                    this._setState('idle');
                    this._setIdleMessage(_mcam('mammotion_stream_stopped'));
                }
            }
        });
        client.on('token-privilege-will-expire', () => {
            this._logStreamEvent('token-will-expire');
            void this._refreshAgoraToken(false).catch((err) => {
                this._logStreamEvent('token-refresh-failed', { error: String(err) });
            });
        });
        client.on('token-privilege-did-expire', () => {
            this._logStreamEvent('token-expired');
            if (this._shouldStayLive()) {
                this._scheduleReconnect('token-expired');
            }
        });
        client.on('connection-state-change', (state) => {
            if (state === 'DISCONNECTED') {
                this._playing = false;
                this._connecting = false;
                this._stopKeepalive();
                if (this._shouldStayLive() && this._wantsAutoplay()) {
                    this._logStreamEvent('disconnected');
                    this._setState('loading');
                    this._setIdleMessage(_mcam('mammotion_reconnecting'));
                    this._scheduleReconnect('disconnected');
                }
                else {
                    this._unregisterSession();
                    this._setState('idle');
                    this._setIdleMessage(_mcam('mammotion_connection_lost'));
                }
            }
        });
        // HA parity: host role + token uid (viewer slot from Mammotion cloud).
        client.setClientRole('host');
        const joinUid = Number.parseInt(String(tokens.uid ?? ''), 10);
        try {
            await client.join(tokens.appid, tokens.channelName, tokens.token, Number.isFinite(joinUid) ? joinUid : null);
        }
        catch (err) {
            if (_isUidConflict(err) && attempt < 2) {
                await this._leaveClient();
                await _stopRemoteSession(this._entity);
                const fresh = await this._fetchTokens();
                await _sleep(PUBLISHER_WAKE_MS);
                return this._connectAgora(fresh, attempt + 1);
            }
            if (_isUidConflict(err)) {
                throw new Error(_mcam('mammotion_uid_conflict'));
            }
            throw err;
        }
        _entitySessions.set(this._entity, this);
        await this._subscribeExistingPublishers(client);
        this._armVideoWaitTimer();
    }
    async _startPlayback() {
        if (this._playing || this._connecting || this._paused || !this._entity)
            return;
        const entity = this._entity;
        await _withEntityJoinLock(entity, async () => {
            if (this._playing || this._connecting || this._paused || this._entity !== entity)
                return;
            this._connecting = true;
            this._setState('loading');
            this._setIdleMessage(_mcam('mammotion_connecting'));
            const abort = () => {
                this._connecting = false;
                this._setState('idle');
                this._setIdleMessage();
            };
            try {
                await this._releaseOtherViewers();
                await this._leaveClient();
                if (this._paused || this._entity !== entity) {
                    abort();
                    return;
                }
                const tokens = await this._fetchTokens();
                if (this._paused || this._entity !== entity) {
                    abort();
                    return;
                }
                await this._connectAgora(tokens, 0);
            }
            catch (err) {
                this._connecting = false;
                this._playing = false;
                this._unregisterSession();
                const msg = err instanceof Error ? err.message : _mcam('mammotion_camera_error');
                this._setIdleMessage(msg);
                this._setState('error');
                this._logStreamEvent('playback-failed', { error: msg });
            }
        });
    }
    async _teardown(stopDevice) {
        this._clearVideoWaitTimer();
        this._clearReconnectTimer();
        this._stopKeepalive();
        this._reconnectAttempts = 0;
        this._connecting = false;
        this._playing = false;
        this._unregisterSession();
        await this._leaveClient();
        this._remoteUsers = [];
        if (this._videoHost)
            this._videoHost.innerHTML = '';
        if (stopDevice && this._entity) {
            await _stopRemoteSession(this._entity);
        }
        this._setState('idle');
        this._setIdleMessage();
    }
}
if (!customElements.get('hv-mammotion-camera')) {
    customElements.define('hv-mammotion-camera', HyveMammotionCamera);
}
export { HyveMammotionCamera };
