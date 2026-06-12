/**
 * <hv-mammotion-camera> — Mammotion lawn mower live view via Agora WebRTC (HA parity).
 *
 * Attributes:
 *   entity — camera.* entity id (required)
 *   alt     — accessible label
 */
import { apiCall } from '../../js/api.js';
import { translateApiDetail } from '../../js/lang/index.js';
import { cameraLoaderMarkup, hideCameraLoader, showCameraLoaderError, showCameraLoaderLoading, } from '../../js/camera_loader.js';
const AGORA_SDK_URL = 'https://download.agora.io/sdk/release/AgoraRTC_N.js';
const MAMMOTION_CAMERA_API_TIMEOUT = 120000;
let _agoraSdkPromise = null;
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
        throw new Error(detail || raw.slice(0, 240) || `Cerere eșuată (${res.status})`);
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
                    fail('Agora SDK indisponibil după încărcare');
            }, { once: true });
            existing.addEventListener('error', () => {
                existing.remove();
                fail('Nu s-a putut încărca SDK-ul Agora (verifică conexiunea)');
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
                fail('Agora SDK indisponibil după încărcare');
        };
        script.onerror = () => {
            script.remove();
            fail('Nu s-a putut încărca SDK-ul Agora (verifică conexiunea)');
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
        this._onVisibility = () => {
            if (document.hidden)
                this.pauseStream();
        };
    }
    static get observedAttributes() {
        return ['entity', 'alt', 'autoplay'];
    }
    connectedCallback() {
        if (!this._stage)
            this._build();
        this._observer = new IntersectionObserver((entries) => {
            this._visible = entries.some(e => e.isIntersecting);
            if (!this._visible)
                this.pauseStream();
            else
                this._maybeAutoplay();
        }, { threshold: 0.08 });
        this._observer.observe(this);
        document.addEventListener('visibilitychange', this._onVisibility);
    }
    disconnectedCallback() {
        document.removeEventListener('visibilitychange', this._onVisibility);
        this._observer?.disconnect();
        void this._teardown(true);
    }
    attributeChangedCallback(name) {
        if (this._stage && name === 'autoplay') {
            this._maybeAutoplay();
            return;
        }
        if (this._stage)
            this._setIdleMessage();
    }
    pauseStream() {
        this._paused = true;
        if (this._playing || this._connecting)
            void this._teardown(false);
    }
    resumeStream() {
        this._paused = false;
        this._maybeAutoplay();
    }
    _wantsAutoplay() {
        return String(this.getAttribute('autoplay') || '').toLowerCase() === 'true';
    }
    _maybeAutoplay() {
        if (!this._wantsAutoplay() || this._paused || !this._visible || document.hidden)
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
        <button type="button" class="hy-mammotion-camera__play absolute inset-0 m-auto w-14 h-14 rounded-full bg-accent/90 text-white border-0 cursor-pointer flex items-center justify-center shadow-lg" data-mammotion-play aria-label="Play">
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
    _setIdleMessage(msg = 'Apasă play pentru live') {
        const hint = this.querySelector('[data-mammotion-hint]');
        if (hint)
            hint.textContent = msg;
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
        const refreshed = await mammotionCameraApi(`/api/cameras/${eid}/mammotion/tokens`);
        if (!refreshed?.tokens?.appid)
            throw new Error('Token video indisponibil');
        return refreshed.tokens;
    }
    async _startPlayback() {
        if (this._playing || this._connecting || this._paused || !this._entity)
            return;
        this._connecting = true;
        this._setState('loading');
        this._setIdleMessage('Conectare…');
        try {
            await loadAgoraSdk();
            if (!window.AgoraRTC)
                throw new Error('Agora SDK indisponibil');
            const tokens = await this._fetchTokens();
            if (this._client) {
                try {
                    await this._client.leave();
                }
                catch { /* ignore */ }
                this._client = null;
            }
            const client = window.AgoraRTC.createClient({
                mode: 'live',
                codec: 'vp8',
                role: 'host',
            });
            this._client = client;
            this._remoteUsers = [];
            client.on('user-published', async (user, mediaType) => {
                const remote = user;
                await client.subscribe(remote, String(mediaType));
                if (mediaType === 'video' && remote.videoTrack && this._videoHost) {
                    this._videoHost.innerHTML = '';
                    remote.videoTrack.play(this._videoHost);
                    if (!this._remoteUsers.some(u => u.uid === remote.uid))
                        this._remoteUsers.push(remote);
                    this._playing = true;
                    this._connecting = false;
                    this._setState('ready');
                    this._setIdleMessage('');
                }
                if (mediaType === 'audio' && remote.audioTrack)
                    remote.audioTrack.play();
            });
            client.on('user-unpublished', (user, mediaType) => {
                if (mediaType !== 'video')
                    return;
                const remote = user;
                this._remoteUsers = this._remoteUsers.filter(u => u.uid !== remote.uid);
                if (!this._remoteUsers.length) {
                    this._playing = false;
                    this._setState('idle');
                    this._setIdleMessage('Stream oprit — apasă play');
                    if (this._videoHost)
                        this._videoHost.innerHTML = '';
                }
            });
            client.on('connection-state-change', (state) => {
                if (state === 'DISCONNECTED') {
                    this._playing = false;
                    this._connecting = false;
                    this._setState('idle');
                    this._setIdleMessage('Conexiune pierdută — apasă play');
                }
            });
            client.setClientRole('host');
            const joinUid = Number.parseInt(String(tokens.uid ?? ''), 10);
            await client.join(tokens.appid, tokens.channelName, tokens.token, Number.isFinite(joinUid) ? joinUid : null);
            window.setTimeout(() => {
                if (this._connecting && !this._playing) {
                    this._connecting = false;
                    this._setState('idle');
                    this._setIdleMessage('Robotul nu trimite video — pornește camera în app Mammotion, apoi reîncearcă');
                }
            }, 25000);
        }
        catch (err) {
            this._connecting = false;
            this._playing = false;
            const msg = err instanceof Error ? err.message : 'Eroare cameră';
            this._setIdleMessage(msg);
            this._setState('error');
            console.warn('[hv-mammotion-camera]', err);
        }
    }
    async _teardown(stopDevice) {
        this._connecting = false;
        this._playing = false;
        if (this._client) {
            try {
                await this._client.leave();
            }
            catch { /* ignore */ }
            this._client = null;
        }
        this._remoteUsers = [];
        if (this._videoHost)
            this._videoHost.innerHTML = '';
        if (stopDevice && this._entity) {
            try {
                await mammotionCameraApi(`/api/cameras/${encodeURIComponent(this._entity)}/mammotion/stop`, { method: 'POST' });
            }
            catch { /* ignore */ }
        }
        this._setState('idle');
        this._setIdleMessage('Apasă play pentru live');
    }
}
if (!customElements.get('hv-mammotion-camera')) {
    customElements.define('hv-mammotion-camera', HyveMammotionCamera);
}
export { HyveMammotionCamera };
