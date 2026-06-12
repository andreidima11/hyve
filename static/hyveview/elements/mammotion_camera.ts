/**
 * <hv-mammotion-camera> — Mammotion lawn mower live view via Agora WebRTC (HA parity).
 *
 * Attributes:
 *   entity — camera.* entity id (required)
 *   alt     — accessible label
 */

import { apiCall } from '../../js/api.js';
import { translateApiDetail } from '../../js/lang/index.js';
import {
  cameraLoaderMarkup,
  hideCameraLoader,
  showCameraLoaderError,
  showCameraLoaderLoading,
} from '../../js/camera_loader.js';

declare global {
  interface Window {
    AgoraRTC?: {
      createClient: (cfg: Record<string, unknown>) => AgoraRtcClient;
    };
  }
}

type AgoraRemoteUser = {
  uid: number | string;
  videoTrack?: { play: (el: HTMLElement) => void; stop?: () => void };
  audioTrack?: { play: () => void; stop?: () => void };
};

type AgoraRtcClient = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  setClientRole: (role: string) => void;
  join: (appId: string, channel: string, token: string | null, uid: number | string | null) => Promise<void>;
  leave: () => Promise<void>;
  subscribe: (user: AgoraRemoteUser, mediaType: string) => Promise<void>;
  remoteUsers?: AgoraRemoteUser[];
};

type MammotionTokens = {
  appid: string;
  channelName: string;
  token: string;
  uid: number | string;
};

const AGORA_SDK_URL = 'https://download.agora.io/sdk/release/AgoraRTC_N.js';
const MAMMOTION_CAMERA_API_TIMEOUT = 120_000;
const JOIN_RELEASE_MS = 500;
const PUBLISHER_WAKE_MS = 2500;
const VIDEO_WAIT_MS = 30000;
let _agoraSdkPromise: Promise<void> | null = null;

/** One live Agora viewer per camera entity — avoids UID_CONFLICT across tabs/cards. */
const _entitySessions = new Map<string, HyveMammotionCamera>();
const _joinChains = new Map<string, Promise<void>>();

function _isUidConflict(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toUpperCase();
  return msg.includes('UID_CONFLICT')
    || msg.includes('UUID CONFLICT')
    || msg.includes('UID CONFLICT');
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function _withEntityJoinLock<T>(entity: string, fn: () => Promise<T>): Promise<T> {
  const prev = _joinChains.get(entity) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  _joinChains.set(entity, gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_joinChains.get(entity) === gate) _joinChains.delete(entity);
  }
}

async function _stopRemoteSession(entity: string): Promise<void> {
  try {
    await mammotionCameraApi(`/api/cameras/${encodeURIComponent(entity)}/mammotion/stop`, { method: 'POST' });
  } catch { /* best effort */ }
  await _sleep(JOIN_RELEASE_MS);
}

async function mammotionCameraApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiCall(url, { ...init, timeout: MAMMOTION_CAMERA_API_TIMEOUT });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  if (raw) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      data = { detail: raw.slice(0, 240) };
    }
  }
  if (!res.ok) {
    const detail = translateApiDetail(data.detail) || String(data.message || '').trim();
    throw new Error(detail || raw.slice(0, 240) || `Cerere eșuată (${res.status})`);
  }
  return data as T;
}

function loadAgoraSdk(): Promise<void> {
  if (window.AgoraRTC) return Promise.resolve();
  if (_agoraSdkPromise) return _agoraSdkPromise;
  _agoraSdkPromise = new Promise((resolve, reject) => {
    const fail = (message: string) => {
      _agoraSdkPromise = null;
      reject(new Error(message));
    };
    const existing = document.querySelector('script[data-hyve-agora-sdk]') as HTMLScriptElement | null;
    if (existing) {
      if (window.AgoraRTC) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => {
        if (window.AgoraRTC) resolve();
        else fail('Agora SDK indisponibil după încărcare');
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
      if (window.AgoraRTC) resolve();
      else fail('Agora SDK indisponibil după încărcare');
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
  static get observedAttributes() {
    return ['entity', 'alt', 'autoplay', 'force-active'];
  }

  private _stage: HTMLDivElement | null = null;
  private _videoHost: HTMLDivElement | null = null;
  private _loader: HTMLElement | null = null;
  private _playBtn: HTMLButtonElement | null = null;
  private _client: AgoraRtcClient | null = null;
  private _remoteUsers: AgoraRemoteUser[] = [];
  private _playing = false;
  private _connecting = false;
  private _observer: IntersectionObserver | null = null;
  private _visible = false;
  private _paused = false;
  private _videoWaitTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback() {
    if (!this._stage) this._build();
    this._observer?.disconnect();
    if (!this._forceActive) {
      this._observer = new IntersectionObserver((entries) => {
        this._visible = entries.some(e => e.isIntersecting);
        if (!this._visible) this.pauseStream();
        else this._scheduleAutoplay();
      }, { threshold: 0.08 });
      this._observer.observe(this);
    } else {
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

  attributeChangedCallback(name: string) {
    if (!this._stage) return;
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
    if (this._playing || this._connecting) void this._teardown(false);
  }

  resumeStream() {
    this._paused = false;
    this._scheduleAutoplay();
  }

  private _wantsAutoplay(): boolean {
    return String(this.getAttribute('autoplay') || '').toLowerCase() === 'true';
  }

  private get _forceActive(): boolean {
    return String(this.getAttribute('force-active') || '').toLowerCase() === 'true';
  }

  private get _effectivelyVisible(): boolean {
    return this._forceActive || this._visible;
  }

  private _scheduleAutoplay() {
    if (!this._wantsAutoplay() || this._paused || !this._effectivelyVisible || document.hidden) return;
    if (this._playing || this._connecting || !this._entity) return;
    this._primeAutoplayUi();
    queueMicrotask(() => this._maybeAutoplay());
  }

  private _primeAutoplayUi() {
    if (this._playing || this._connecting) return;
    this._setState('loading');
    this._setIdleMessage('Conectare…');
  }

  private _maybeAutoplay() {
    if (!this._wantsAutoplay() || this._paused || !this._effectivelyVisible || document.hidden) return;
    if (this._playing || this._connecting || !this._entity) return;
    void this._startPlayback();
  }

  private _onVisibility = () => {
    if (document.hidden) this.pauseStream();
  };

  private get _entity(): string {
    return String(this.getAttribute('entity') || '').trim();
  }

  private _build() {
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

  private _setIdleMessage(msg = 'Apasă play pentru live') {
    const hint = this.querySelector('[data-mammotion-hint]');
    if (hint) hint.textContent = msg;
  }

  private _setState(state: 'idle' | 'loading' | 'ready' | 'error') {
    this.dataset.state = state;
    if (state === 'loading') showCameraLoaderLoading(this._loader);
    else if (state === 'error') {
      const hint = this.querySelector('[data-mammotion-hint]');
      const msg = String(hint?.textContent || '').trim();
      showCameraLoaderError(this._loader, msg || undefined);
    }
    else hideCameraLoader(this._loader);
    if (this._playBtn) {
      this._playBtn.style.display = (state === 'ready' || state === 'loading') ? 'none' : 'flex';
    }
  }

  private async _fetchTokens(): Promise<MammotionTokens> {
    const eid = encodeURIComponent(this._entity);
    const started = await mammotionCameraApi<{ tokens?: MammotionTokens }>(
      `/api/cameras/${eid}/mammotion/start`,
      { method: 'POST' },
    );
    if (started?.tokens?.appid) return started.tokens;
    throw new Error('Token video indisponibil');
  }

  private _unregisterSession() {
    if (this._entity && _entitySessions.get(this._entity) === this) {
      _entitySessions.delete(this._entity);
    }
  }

  private async _releaseOtherViewers() {
    const other = _entitySessions.get(this._entity);
    if (other && other !== this) {
      await other._teardown(false);
    }
  }

  private async _leaveClient() {
    const client = this._client;
    this._client = null;
    if (!client) return;
    try { await client.leave(); } catch { /* ignore */ }
    await _sleep(200);
  }

  private _clearVideoWaitTimer() {
    if (this._videoWaitTimer) {
      window.clearTimeout(this._videoWaitTimer);
      this._videoWaitTimer = null;
    }
  }

  private _armVideoWaitTimer() {
    this._clearVideoWaitTimer();
    this._videoWaitTimer = window.setTimeout(() => {
      this._videoWaitTimer = null;
      if (!this._connecting || this._playing) return;
      this._connecting = false;
      void this._leaveClient();
      this._unregisterSession();
      this._setState('idle');
      this._setIdleMessage('Robotul nu trimite video — pornește camera în app Mammotion, apoi reîncearcă');
    }, VIDEO_WAIT_MS);
  }

  private async _playRemoteVideo(remote: AgoraRemoteUser) {
    if (!remote.videoTrack || !this._videoHost) return;
    this._videoHost.innerHTML = '';
    remote.videoTrack.play(this._videoHost);
    if (!this._remoteUsers.some(u => u.uid === remote.uid)) this._remoteUsers.push(remote);
    this._playing = true;
    this._connecting = false;
    this._clearVideoWaitTimer();
    this._setState('ready');
    this._setIdleMessage('');
  }

  private async _subscribeRemote(client: AgoraRtcClient, remote: AgoraRemoteUser, mediaType: string) {
    await client.subscribe(remote, mediaType);
    if (mediaType === 'video') await this._playRemoteVideo(remote);
    if (mediaType === 'audio' && remote.audioTrack) remote.audioTrack.play();
  }

  private async _subscribeExistingPublishers(client: AgoraRtcClient) {
    const existing = Array.isArray(client.remoteUsers) ? client.remoteUsers : [];
    for (const remote of existing) {
      try {
        await this._subscribeRemote(client, remote, 'video');
      } catch { /* publisher may not have video yet */ }
    }
  }

  private async _connectAgora(tokens: MammotionTokens, attempt: number): Promise<void> {
    await loadAgoraSdk();
    if (!window.AgoraRTC) throw new Error('Agora SDK indisponibil');

    await this._leaveClient();

    const client = window.AgoraRTC.createClient({
      mode: 'live',
      codec: 'vp8',
    });
    this._client = client;
    this._remoteUsers = [];

    client.on('user-published', async (user: unknown, mediaType: unknown) => {
      try {
        await this._subscribeRemote(client, user as AgoraRemoteUser, String(mediaType));
      } catch (err) {
        console.warn('[hv-mammotion-camera] subscribe failed', err);
      }
    });

    client.on('user-unpublished', (user: unknown, mediaType: unknown) => {
      if (mediaType !== 'video') return;
      const remote = user as AgoraRemoteUser;
      this._remoteUsers = this._remoteUsers.filter(u => u.uid !== remote.uid);
      if (!this._remoteUsers.length) {
        this._playing = false;
        this._setState('idle');
        this._setIdleMessage('Stream oprit — apasă play');
        if (this._videoHost) this._videoHost.innerHTML = '';
      }
    });

    client.on('connection-state-change', (state: unknown) => {
      if (state === 'DISCONNECTED') {
        this._playing = false;
        this._connecting = false;
        this._unregisterSession();
        this._setState('idle');
        this._setIdleMessage('Conexiune pierdută — apasă play');
      }
    });

    // HA parity: host role + token uid (viewer slot from Mammotion cloud).
    client.setClientRole('host');
    const joinUid = Number.parseInt(String(tokens.uid ?? ''), 10);
    try {
      await client.join(
        tokens.appid,
        tokens.channelName,
        tokens.token,
        Number.isFinite(joinUid) ? joinUid : null,
      );
    } catch (err) {
      if (_isUidConflict(err) && attempt < 2) {
        await this._leaveClient();
        await _stopRemoteSession(this._entity);
        const fresh = await this._fetchTokens();
        await _sleep(PUBLISHER_WAKE_MS);
        return this._connectAgora(fresh, attempt + 1);
      }
      if (_isUidConflict(err)) {
        throw new Error(
          'Camera deja folosită (închide app Mammotion sau alte ferestre Hyve cu live), apoi apasă play din nou.',
        );
      }
      throw err;
    }

    _entitySessions.set(this._entity, this);
    await this._subscribeExistingPublishers(client);
    this._armVideoWaitTimer();
  }

  private async _startPlayback() {
    if (this._playing || this._connecting || this._paused || !this._entity) return;
    const entity = this._entity;
    await _withEntityJoinLock(entity, async () => {
      if (this._playing || this._connecting || this._paused || this._entity !== entity) return;
      this._connecting = true;
      this._setState('loading');
      this._setIdleMessage('Conectare…');
      const abort = () => {
        this._connecting = false;
        this._setState('idle');
        this._setIdleMessage('Apasă play pentru live');
      };
      try {
        await this._releaseOtherViewers();
        await this._leaveClient();
        if (this._paused || this._entity !== entity) { abort(); return; }
        const tokens = await this._fetchTokens();
        if (this._paused || this._entity !== entity) { abort(); return; }
        await this._connectAgora(tokens, 0);
      } catch (err) {
        this._connecting = false;
        this._playing = false;
        this._unregisterSession();
        const msg = err instanceof Error ? err.message : 'Eroare cameră';
        this._setIdleMessage(msg);
        this._setState('error');
        console.warn('[hv-mammotion-camera]', err);
      }
    });
  }

  private async _teardown(stopDevice: boolean) {
    this._clearVideoWaitTimer();
    this._connecting = false;
    this._playing = false;
    this._unregisterSession();
    await this._leaveClient();
    this._remoteUsers = [];
    if (this._videoHost) this._videoHost.innerHTML = '';
    if (stopDevice && this._entity) {
      await _stopRemoteSession(this._entity);
    }
    this._setState('idle');
    this._setIdleMessage('Apasă play pentru live');
  }
}

if (!customElements.get('hv-mammotion-camera')) {
  customElements.define('hv-mammotion-camera', HyveMammotionCamera);
}

export { HyveMammotionCamera };
