/**
 * <hv-mammotion-camera> — Mammotion lawn mower live view via Agora WebRTC (HA parity).
 *
 * Attributes:
 *   entity — camera.* entity id (required)
 *   alt     — accessible label
 */

import { apiCall } from '../../js/api.js';
import { t, translateApiDetail, loadBundledTranslations } from '../../js/lang/index.js';
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
  renewToken: (token: string) => Promise<void>;
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
const PUBLISHER_WAKE_MS = 3000;
const POST_LEAVE_SETTLE_MS = 350;
const VIDEO_WAIT_MS = 30000;
const KEEPALIVE_MS = 90_000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
let _agoraSdkPromise: Promise<void> | null = null;

function _mcam(key: string, params?: Record<string, string | number>): string {
  const full = `cameras.${key}`;
  const out = t(full, params);
  return out !== full ? out : key;
}

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
    throw new Error(detail || raw.slice(0, 240) || t('common.error'));
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
        else fail(_mcam('mammotion_agora_unavailable'));
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
      if (window.AgoraRTC) resolve();
      else fail(_mcam('mammotion_agora_unavailable'));
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
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _channelJoined = false;
  private _leavingChannel = false;
  private _joinGraceUntil = 0;
  private _pendingReconnectReason: string | null = null;
  private _reconnectQueued = false;
  private _connectOpId = 0;
  private _sessionEntity = '';
  private _onI18nLoaded = () => this._refreshVisibleText();

  private _logStreamEvent(event: string, detail: Record<string, unknown> = {}) {
    const payload = {
      entity: this._entity,
      playing: this._playing,
      connecting: this._connecting,
      reconnectAttempts: this._reconnectAttempts,
      autoplay: this._wantsAutoplay(),
      visible: this._effectivelyVisible,
      ts: Date.now(),
      ...detail,
    };
    console.warn(`[hv-mammotion-camera] ${event}`, payload);
  }

  private _bumpConnectOp(): number {
    this._connectOpId += 1;
    return this._connectOpId;
  }

  private _connectOpStale(opId: number): boolean {
    return opId !== this._connectOpId;
  }

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
    document.addEventListener('hyve:i18n-bundles-loaded', this._onI18nLoaded);
    void loadBundledTranslations().catch(() => {});
    this._refreshVisibleText();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this._onVisibility);
    document.removeEventListener('hyve:i18n-bundles-loaded', this._onI18nLoaded);
    this._observer?.disconnect();
    void this._teardown(true);
  }

  attributeChangedCallback(name: string) {
    if (!this._stage) return;
    if (name === 'autoplay' || name === 'force-active' || name === 'entity') {
      if (name === 'entity') {
        const next = this._entity;
        if (this._sessionEntity && next && this._sessionEntity !== next
          && (this._playing || this._connecting || this._client)) {
          void this._teardown(false);
        }
      }
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

  private _shouldStayLive(): boolean {
    return !this._paused
      && this._effectivelyVisible
      && !document.hidden
      && !!this._entity
      && (this._wantsAutoplay() || this._playing || this._connecting);
  }

  private _clearReconnectTimer() {
    if (this._reconnectTimer) {
      window.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._reconnectQueued = false;
    }
  }

  private _scheduleReconnect(reason: string) {
    if (!this._shouldStayLive()) return;
    if (this._reconnectTimer) return;
    if (this._connecting) {
      this._pendingReconnectReason = reason;
      return;
    }
    this._reconnectQueued = true;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(1.5, this._reconnectAttempts),
    );
    this._logStreamEvent('reconnect-scheduled', { reason, delayMs: delay });
    this._reconnectTimer = window.setTimeout(() => {
      this._reconnectTimer = null;
      void this._attemptReconnect(reason);
    }, delay);
  }

  private _flushPendingReconnect() {
    const reason = this._pendingReconnectReason;
    this._pendingReconnectReason = null;
    if (reason) this._scheduleReconnect(reason);
  }

  private _stopKeepalive() {
    if (this._keepaliveTimer) {
      window.clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  private _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = window.setInterval(() => {
      void this._keepaliveTick();
    }, KEEPALIVE_MS);
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
    this._setIdleMessage(_mcam('mammotion_connecting'));
  }

  private _maybeAutoplay() {
    if (!this._wantsAutoplay() || this._paused || !this._effectivelyVisible || document.hidden) return;
    if (this._playing || this._connecting || !this._entity) return;
    if (this._reconnectQueued || this._reconnectTimer) return;
    void this._startPlayback();
  }

  private _refreshVisibleText() {
    if (this._playing) return;
    const state = this.dataset.state || 'idle';
    if (state === 'loading') {
      const key = this._reconnectQueued || this._reconnectAttempts > 0
        ? 'mammotion_reconnecting'
        : 'mammotion_connecting';
      this._setIdleMessage(_mcam(key));
      return;
    }
    if (state !== 'error') this._setIdleMessage();
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
        <div class="hy-mammotion-camera__hint absolute inset-x-0 bottom-3 text-center text-[11px] px-3 pointer-events-none" data-mammotion-hint></div>
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

  private _setIdleMessage(msg?: string) {
    const hint = this.querySelector('[data-mammotion-hint]');
    if (hint) hint.textContent = msg ?? _mcam('mammotion_press_play');
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
    throw new Error(_mcam('mammotion_token_unavailable'));
  }

  private async _fetchKeepaliveTokens(): Promise<MammotionTokens> {
    const eid = encodeURIComponent(this._entity);
    const resp = await mammotionCameraApi<{ tokens?: MammotionTokens }>(
      `/api/cameras/${eid}/mammotion/keepalive`,
      { method: 'POST' },
    );
    if (resp?.tokens?.appid) return resp.tokens;
    throw new Error(_mcam('mammotion_token_unavailable'));
  }

  /** Reconnect: keepalive refresh unless the publisher likely left the channel. */
  private async _fetchReconnectTokens(reason: string): Promise<MammotionTokens> {
    const needsWake = reason === 'publisher-left'
      || reason === 'token-expired'
      || reason === 'video-wait-timeout'
      || reason === 'uid-conflict';
    if (needsWake) return this._fetchTokens();
    try {
      return await this._fetchKeepaliveTokens();
    } catch (err) {
      this._logStreamEvent('reconnect-keepalive-fallback', { error: String(err) });
      return this._fetchTokens();
    }
  }

  private async _renewClientToken(token: string) {
    const client = this._client;
    if (!client) return;
    if (typeof client.renewToken !== 'function') {
      this._scheduleReconnect('renew-token-unsupported');
      return;
    }
    try {
      await client.renewToken(token);
    } catch (err) {
      console.warn('[hv-mammotion-camera] renewToken failed', err);
      throw err;
    }
  }

  private async _refreshAgoraToken(wakeRobot: boolean) {
    if (!this._client || !this._entity) return;
    const tokens = wakeRobot
      ? await this._fetchKeepaliveTokens()
      : await mammotionCameraApi<{ tokens?: MammotionTokens }>(
        `/api/cameras/${encodeURIComponent(this._entity)}/mammotion/tokens`,
      ).then((r) => r.tokens as MammotionTokens);
    if (tokens?.token) await this._renewClientToken(tokens.token);
  }

  private async _keepaliveTick() {
    if (!this._playing || this._paused || !this._shouldStayLive()) return;
    try {
      await this._refreshAgoraToken(true);
      this._reconnectAttempts = 0;
    } catch (err) {
      this._logStreamEvent('keepalive-failed', { error: String(err) });
      if (this._playing && this._shouldStayLive()) this._scheduleReconnect('keepalive-failed');
    }
  }

  private async _attemptReconnect(reason: string) {
    if (!this._shouldStayLive()) return;
    if (this._connecting) return;
    const entity = this._entity;
    if (!entity) return;

    this._logStreamEvent('reconnect-start', { reason });
    this._connecting = true;
    this._setState('loading');
    this._setIdleMessage(_mcam('mammotion_reconnecting'));

    try {
      await _withEntityJoinLock(entity, async () => {
        if (!this._shouldStayLive() || this._entity !== entity) return;
        const canProceed = await this._releaseOtherViewers();
        if (!canProceed) return;
        const opId = this._bumpConnectOp();
        const tokens = await this._fetchReconnectTokens(reason);
        if (!this._shouldStayLive() || this._entity !== entity || this._connectOpStale(opId)) return;
        const joined = await this._connectAgora(tokens, 0, opId);
        if (!joined) return;
      });
      if (this._playing || this._channelJoined) {
        this._reconnectAttempts = 0;
        this._logStreamEvent('reconnect-success', { reason });
      }
    } catch (err) {
      this._logStreamEvent('reconnect-failed', { reason, error: String(err) });
      this._reconnectAttempts += 1;
      if (this._reconnectAttempts >= 8 || !this._wantsAutoplay()) {
        this._unregisterSession();
        const msg = err instanceof Error ? err.message : _mcam('mammotion_connection_lost_short');
        this._setIdleMessage(
          this._wantsAutoplay()
            ? `${msg} ${_mcam('mammotion_press_play_suffix')}`
            : _mcam('mammotion_connection_lost'),
        );
        this._setState('idle');
        return;
      }
      this._scheduleReconnect(reason);
    } finally {
      this._reconnectQueued = false;
      if (!this._playing) this._connecting = false;
    }
  }

  private _unregisterSession() {
    if (this._entity && _entitySessions.get(this._entity) === this) {
      _entitySessions.delete(this._entity);
    }
  }

  private async _releaseOtherViewers(): Promise<boolean> {
    const other = _entitySessions.get(this._entity);
    if (!other || other === this) return true;
    if (other._playing) {
      this._logStreamEvent('viewer-blocked', { otherPlaying: true });
      return false;
    }
    if (other._connecting) {
      const deadline = Date.now() + 8000;
      while (other._connecting && Date.now() < deadline) {
        await _sleep(200);
      }
      if (other._playing) return false;
    }
    if (_entitySessions.get(this._entity) === other) {
      other._bumpConnectOp();
      await other._teardown(false);
    }
    return true;
  }

  private async _disconnectAgoraClient(client: AgoraRtcClient | null) {
    if (!client) return;
    if (this._client === client) {
      this._client = null;
      this._channelJoined = false;
      this._joinGraceUntil = 0;
    }
    this._leavingChannel = true;
    try {
      await client.leave();
    } catch { /* ignore */ }
    finally {
      this._leavingChannel = false;
    }
    await _sleep(POST_LEAVE_SETTLE_MS);
  }

  private async _leaveClient() {
    this._bumpConnectOp();
    const client = this._client;
    this._client = null;
    this._channelJoined = false;
    this._joinGraceUntil = 0;
    this._sessionEntity = '';
    await this._disconnectAgoraClient(client);
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
      this._setIdleMessage(_mcam('mammotion_no_video'));
      this._logStreamEvent('video-wait-timeout');
      this._flushPendingReconnect();
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
    this._reconnectAttempts = 0;
    this._startKeepalive();
    this._logStreamEvent('playing');
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

  private async _connectAgora(tokens: MammotionTokens, attempt: number, opId: number): Promise<boolean> {
    await loadAgoraSdk();
    if (this._connectOpStale(opId)) return false;
    if (!window.AgoraRTC) throw new Error(_mcam('mammotion_agora_unavailable'));

    const rtc = window.AgoraRTC as typeof window.AgoraRTC & {
      setLogLevel?: (level: number) => void;
      enableLogUpload?: (enable: boolean) => void;
    };
    try {
      rtc.setLogLevel?.(3);
      rtc.enableLogUpload?.(false);
    } catch { /* optional SDK tuning */ }

    await this._disconnectAgoraClient(this._client);
    if (this._connectOpStale(opId)) return false;

    const client = window.AgoraRTC.createClient({
      mode: 'live',
      codec: 'vp8',
      role: 'host',
    });
    this._client = client;
    this._remoteUsers = [];

    client.on('user-published', async (user: unknown, mediaType: unknown) => {
      if (this._client !== client || !this._channelJoined || this._leavingChannel) return;
      try {
        await this._subscribeRemote(client, user as AgoraRemoteUser, String(mediaType));
      } catch (err) {
        if (this._client !== client || !this._channelJoined || this._leavingChannel) return;
        console.warn('[hv-mammotion-camera] subscribe failed', err);
      }
    });

    client.on('user-unpublished', (user: unknown, mediaType: unknown) => {
      if (mediaType !== 'video') return;
      const remote = user as AgoraRemoteUser;
      this._remoteUsers = this._remoteUsers.filter(u => u.uid !== remote.uid);
      if (!this._remoteUsers.length) {
        const hadVideo = this._playing;
        this._playing = false;
        this._stopKeepalive();
        if (this._videoHost) this._videoHost.innerHTML = '';
        if (hadVideo && this._shouldStayLive() && this._wantsAutoplay()) {
          this._logStreamEvent('publisher-left');
          this._setState('loading');
          this._setIdleMessage(_mcam('mammotion_reconnecting'));
          this._scheduleReconnect('publisher-left');
        } else if (!this._connecting) {
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

    client.on('connection-state-change', (curState: unknown) => {
      if (String(curState || '') !== 'DISCONNECTED') return;
      if (this._client !== client || this._leavingChannel) return;
      if (Date.now() < this._joinGraceUntil) return;
      if (this._connecting && !this._playing) return;
      this._playing = false;
      this._connecting = false;
      this._stopKeepalive();
      if (this._shouldStayLive() && this._wantsAutoplay()) {
        this._logStreamEvent('disconnected');
        this._setState('loading');
        this._setIdleMessage(_mcam('mammotion_reconnecting'));
        this._scheduleReconnect('disconnected');
      } else if (!this._connecting) {
        this._unregisterSession();
        this._setState('idle');
        this._setIdleMessage(_mcam('mammotion_connection_lost'));
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
      if (this._client === client) this._client = null;
      if (_isUidConflict(err) && attempt < 2) {
        await this._disconnectAgoraClient(client);
        await _stopRemoteSession(this._entity);
        const fresh = await this._fetchTokens();
        await _sleep(PUBLISHER_WAKE_MS);
        if (this._connectOpStale(opId)) return false;
        return this._connectAgora(fresh, attempt + 1, opId);
      }
      if (_isUidConflict(err)) {
        throw new Error(_mcam('mammotion_uid_conflict'));
      }
      throw err;
    }

    if (this._connectOpStale(opId) || this._client !== client) {
      await this._disconnectAgoraClient(client);
      return false;
    }

    this._channelJoined = true;
    this._joinGraceUntil = Date.now() + 8000;
    this._sessionEntity = this._entity;
    _entitySessions.set(this._entity, this);
    await this._subscribeExistingPublishers(client);
    this._armVideoWaitTimer();
    this._flushPendingReconnect();
    return true;
  }

  private async _startPlayback() {
    if (this._playing || this._connecting || this._paused || !this._entity) return;
    if (this._reconnectQueued || this._reconnectTimer) return;
    const entity = this._entity;
    await _withEntityJoinLock(entity, async () => {
      if (this._playing || this._connecting || this._paused || this._entity !== entity) return;
      this._connecting = true;
      this._setState('loading');
      this._setIdleMessage(_mcam('mammotion_connecting'));
      const abort = () => {
        this._connecting = false;
        this._setState('idle');
        this._setIdleMessage();
      };
      try {
        const canProceed = await this._releaseOtherViewers();
        if (!canProceed) {
          this._setIdleMessage(_mcam('mammotion_viewer_busy'));
          abort();
          return;
        }
        const opId = this._bumpConnectOp();
        const tokens = await this._fetchTokens();
        if (this._paused || this._entity !== entity || this._connectOpStale(opId)) { abort(); return; }
        const joined = await this._connectAgora(tokens, 0, opId);
        if (!joined) { abort(); return; }
      } catch (err) {
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

  private async _teardown(stopDevice: boolean) {
    this._clearVideoWaitTimer();
    this._clearReconnectTimer();
    this._stopKeepalive();
    this._reconnectAttempts = 0;
    this._pendingReconnectReason = null;
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
    this._setIdleMessage();
  }
}

if (!customElements.get('hv-mammotion-camera')) {
  customElements.define('hv-mammotion-camera', HyveMammotionCamera);
}

export { HyveMammotionCamera };
