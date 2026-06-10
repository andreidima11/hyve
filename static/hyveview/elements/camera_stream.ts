/**
 * <hv-camera-stream> — leaf custom element that renders a camera feed
 * intelligently.
 *
 * Design goals (replaces the legacy <hyve-camera-live-player> + the
 * global `__hyveCameraTimer` poll on <img data-camera-snapshot>):
 *   - No permanent MJPEG hold-open connection unless explicitly in `live`
 *     mode AND the element is currently visible AND the tab is foregrounded.
 *   - Snapshot mode refreshes via `<img src=…&t=NNN>` only while visible.
 *   - When the element scrolls out of view or the tab is hidden, ALL
 *     network activity stops (interval cleared, src wiped). This unblocks
 *     the browser's per-host connection pool that the legacy card starved.
 *   - Pure custom element with attribute-driven config — no JSON. Drop-in
 *     replacement inside the existing `.hyve-dashboard-card--camera` frame.
 *
 * Attributes:
 *   entity     — camera.* entity id (required)
 *   mode       — 'snapshot' | 'live'  (default: 'snapshot')
 *   interval   — snapshot refresh seconds (default: 10, min: 2)
 *   alt        — accessible alt text (default: entity)
 *
 * Public methods:
 *   pauseStream()   — force-stop network activity (used by panel-hidden hook)
 *   resumeStream()  — re-evaluate visibility and start if appropriate
 *
 * Emits CSS hooks via dataset:
 *   data-state = 'loading' | 'ready' | 'error' | 'idle'
 */

import { cameraGo2rtcWsUrl, cameraMseCodecs } from '../../js/camera_live.js';
import { cameraMediaUrl } from '../../js/camera_auth.js';
import {
  cameraLoaderMarkup,
  hideCameraLoader,
  showCameraLoaderError,
  showCameraLoaderLoading,
} from '../../js/camera_loader.js';

const DEFAULT_INTERVAL = 10;

async function _snapshotUrl(entity: string): Promise<string> {
  return cameraMediaUrl(entity, 'snapshot');
}

async function _streamUrl(entity: string): Promise<string> {
  return cameraMediaUrl(entity, 'stream');
}

async function _playUrl(entity: string): Promise<string> {
  return cameraMediaUrl(entity, 'play');
}

class HyveCameraStream extends HTMLElement {
  static get observedAttributes() { return ['entity', 'mode', 'interval', 'alt', 'webm', 'go2rtc', 'muted', 'show-mute', 'buffer', 'force-active']; }

  private _img: HTMLImageElement | null = null;
  private _video: HTMLVideoElement | null = null;
  private _loader: Element | null = null;
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _visible = false;
  private _observer: IntersectionObserver | null = null;
  private _paused = false;
  private _muteBtn: HTMLButtonElement | null = null;
  private _ws: WebSocket | null = null;
  private _mseQueue: ArrayBuffer[] = [];
  private _mseBuffer: SourceBuffer | null = null;
  private _mseObjectUrl = '';
  private _mseRequested = false;
  private _mseFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _onVisibility: () => void;

  constructor() {
    super();
    this._onVisibility = () => this._reevaluate();
  }

  connectedCallback() {
    if (!this._img) this._build();
    document.addEventListener('visibilitychange', this._onVisibility);
    this._observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === this) {
          this._visible = e.isIntersecting;
          this._reevaluate();
        }
      }
    }, { threshold: 0.05 });
    this._observer.observe(this);
    // Kick once — carousel may call resumeStream before the observer's first callback.
    requestAnimationFrame(() => this._reevaluate());
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    this._stopRefresh();
    this._teardownMse();
    if (this._img) this._img.src = '';
    if (this._video) {
      try { this._video.pause(); } catch (_) {}
      this._video.removeAttribute('src');
    }
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'muted' && this._video) {
      this._video.muted = String(value).toLowerCase() === 'true';
      if (this._muteBtn) this._muteBtn.textContent = this._video.muted ? '🔇' : '🔊';
      return;
    }
    if (name === 'buffer' || name === 'force-active') {
      this._reevaluate();
      return;
    }
    if (this._img) this._reevaluate(/* forceReset */ true);
  }

  // Public API ------------------------------------------------------------
  pauseStream()  { this._paused = true;  this._stopRefresh(); }
  resumeStream() {
    this._paused = false;
    // Force restart after background — stale live/img handles may otherwise skip _startRefresh.
    this._reevaluate(true);
  }

  // Internals -------------------------------------------------------------
  get _entity()   { return this.getAttribute('entity') || ''; }
  get _mode()     { return (this.getAttribute('mode') || 'snapshot').toLowerCase() === 'live' ? 'live' : 'snapshot'; }
  get _interval() {
    const v = Number(this.getAttribute('interval'));
    return Number.isFinite(v) && v >= 2 ? v : DEFAULT_INTERVAL;
  }
  get _webmLive() {
    const raw = (this.getAttribute('webm') || '').toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
  get _muted() {
    const raw = (this.getAttribute('muted') || '').toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
  get _showMuteBtn() {
    const raw = (this.getAttribute('show-mute') || 'true').toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'no';
  }
  get _go2rtcLive() {
    const raw = (this.getAttribute('go2rtc') || '').toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
  /** Background buffer inside a carousel — keep fetching even when not intersecting. */
  get _buffered() {
    const raw = (this.getAttribute('buffer') || '').toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
  /** Active slide in a carousel — always load (IO on nested streams is unreliable). */
  get _forceActive() {
    const raw = (this.getAttribute('force-active') || '').toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  _teardownMse() {
    if (this._mseFallbackTimer) {
      clearTimeout(this._mseFallbackTimer);
      this._mseFallbackTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    if (this._mseObjectUrl) {
      URL.revokeObjectURL(this._mseObjectUrl);
      this._mseObjectUrl = '';
    }
    this._mseBuffer = null;
    this._mseQueue = [];
    this._mseRequested = false;
  }

  _fallbackFromMse() {
    this._teardownMse();
    if (this._webmLive) this._startWebmLive();
    else this._startMjpegLive();
  }

  _startGo2rtcLive() {
    if (!this._img || !('MediaSource' in window) || !('WebSocket' in window)) {
      if (this._webmLive) this._startWebmLive();
      else this._startMjpegLive();
      return;
    }
    this._teardownMse();
    if (!this._video) {
      const video = document.createElement('video');
      video.playsInline = true;
      video.autoplay = true;
      video.muted = this._muted;
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'cover';
      video.style.display = 'none';
      video.style.opacity = '0';
      video.style.transition = 'opacity 280ms ease';
      video.addEventListener('loadeddata', () => { this._setState('ready'); });
      video.addEventListener('error', () => this._fallbackFromMse());
      this.appendChild(video);
      this._video = video;
    }
    this._img.style.display = 'none';
    this._img.src = '';
    this._video.style.display = 'block';
    this._img.dataset.streamMode = 'live-go2rtc';
    this._img.dataset.entityId = this._entity;
    this._setState('loading');

    const mediaSource = new MediaSource();
    this._mseObjectUrl = URL.createObjectURL(mediaSource);
    this._video.src = this._mseObjectUrl;
    this._mseQueue = [];
    this._mseRequested = false;

    const flush = () => {
      if (!this._mseBuffer || this._mseBuffer.updating || !this._mseQueue.length) return;
      try {
        const chunk = this._mseQueue.shift();
        if (chunk) this._mseBuffer.appendBuffer(chunk);
      } catch (_) {
        this._fallbackFromMse();
      }
    };
    const requestStream = () => {
      if (this._ws?.readyState === WebSocket.OPEN && mediaSource.readyState === 'open' && !this._mseRequested) {
        this._mseRequested = true;
        this._ws.send(JSON.stringify({ type: 'mse', value: cameraMseCodecs() }));
      }
    };

    mediaSource.addEventListener('sourceopen', requestStream, { once: true });
    this._video.addEventListener('loadeddata', () => {
      if (this._mseFallbackTimer) {
        clearTimeout(this._mseFallbackTimer);
        this._mseFallbackTimer = null;
      }
      this._setState('ready');
    }, { once: true });
    this._mseFallbackTimer = setTimeout(() => this._fallbackFromMse(), 9000);
    this._ws = new WebSocket(cameraGo2rtcWsUrl(this._entity));
    this._ws.binaryType = 'arraybuffer';
    this._ws.onopen = requestStream;
    this._ws.onerror = () => this._fallbackFromMse();
    this._ws.onclose = () => {
      if (this.dataset.state === 'loading') this._fallbackFromMse();
    };
    this._ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let message = null;
        try { message = JSON.parse(event.data); } catch (_) {}
        if (message?.type === 'mse' && message.value && !this._mseBuffer) {
          try {
            this._mseBuffer = mediaSource.addSourceBuffer(message.value);
            this._mseBuffer.mode = 'segments';
            this._mseBuffer.addEventListener('updateend', flush);
            flush();
          } catch (_) {
            this._fallbackFromMse();
          }
        } else if (message?.type === 'error') {
          this._fallbackFromMse();
        }
        return;
      }
      const chunk = event.data instanceof ArrayBuffer ? event.data : null;
      if (!chunk) return;
      if (!this._mseBuffer || this._mseBuffer.updating) {
        this._mseQueue.push(chunk);
      } else {
        try { this._mseBuffer.appendBuffer(chunk); } catch (_) { this._fallbackFromMse(); }
      }
    };
    this._video.play().catch(() => {});
  }

  _setState(state: string): void {
    this.dataset.state = state;
    const loader = this._loader;
    if (state === 'ready') {
      hideCameraLoader(loader);
      if (this._img) this._img.style.opacity = '1';
      if (this._video) this._video.style.opacity = '1';
      return;
    }
    if (state === 'loading') {
      showCameraLoaderLoading(loader);
      if (this._img) this._img.style.opacity = '0';
      if (this._video) this._video.style.opacity = '0';
      return;
    }
    if (state === 'error') {
      showCameraLoaderError(loader);
      if (this._img) this._img.style.opacity = '0';
      if (this._video) this._video.style.opacity = '0';
      return;
    }
    hideCameraLoader(loader);
  }

  _build() {
    this.dataset.state = 'idle';
    this.classList.add('hv-camera-stream');
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.height = '100%';
    this.style.position = 'relative';

    const loaderWrap = document.createElement('div');
    loaderWrap.innerHTML = cameraLoaderMarkup();
    this._loader = loaderWrap.firstElementChild;
    if (this._loader) this.appendChild(this._loader);

    const img = document.createElement('img');
    img.alt = this.getAttribute('alt') || this._entity || 'camera';
    img.loading = 'eager';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.style.display = 'block';
    img.style.opacity = '0';
    img.style.transition = 'opacity 280ms ease';
    img.addEventListener('load', () => {
      if (img.naturalWidth > 0) this._setState('ready');
    });
    img.addEventListener('error', () => { this._setState('error'); });
    this.appendChild(img);
    this._img = img;
  }

  _reevaluate(forceReset = false) {
    if (this._paused) { this._stopRefresh(); return; }
    if (forceReset) this._stopRefresh();
    const active = (this._visible || this._buffered || this._forceActive) && !document.hidden && !!this._entity;
    if (active) this._startRefresh();
    else this._stopRefresh();
  }

  _startWebmLive() {
    if (!this._img) return;
    if (!this._video) {
      const video = document.createElement('video');
      video.playsInline = true;
      video.autoplay = true;
      video.muted = this._muted;
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'cover';
      video.style.display = 'none';
      video.style.opacity = '0';
      video.style.transition = 'opacity 280ms ease';
      video.addEventListener('loadeddata', () => { this._setState('ready'); });
      video.addEventListener('error', () => this._startMjpegLive());
      this.appendChild(video);
      this._video = video;
      if (this._showMuteBtn && !this._muteBtn) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Sunet';
        btn.setAttribute('aria-label', 'Sunet');
        btn.textContent = '🔊';
        Object.assign(btn.style, {
          position: 'absolute', left: '8px', bottom: '8px', zIndex: '5',
          background: 'rgba(0,0,0,0.55)', color: '#fff',
          border: 'none', borderRadius: '8px', padding: '6px 10px',
          cursor: 'pointer', fontSize: '14px',
        });
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!this._video) return;
          this._video.muted = !this._video.muted;
          btn.textContent = this._video.muted ? '🔇' : '🔊';
        });
        this.appendChild(btn);
        this._muteBtn = btn;
      }
    }
    this._img.style.display = 'none';
    this._img.src = '';
    this._video.style.display = 'block';
    this._img.dataset.streamMode = 'live-webm';
    this._img.dataset.entityId = this._entity;
    this._setState('loading');
    _playUrl(this._entity).then((url) => {
      if (this._video && this.isConnected) this._video.src = url;
    }).catch(() => this._fallbackFromMse());
    if (this._muteBtn) {
      this._muteBtn.style.display = this._showMuteBtn ? 'block' : 'none';
      this._muteBtn.textContent = this._video.muted ? '🔇' : '🔊';
    }
  }

  _startMjpegLive() {
    if (!this._img) return;
    if (this._video) {
      try { this._video.pause(); } catch (_) {}
      this._video.removeAttribute('src');
      this._video.style.display = 'none';
    }
    this._img.style.display = 'block';
    if (this._img.dataset.streamMode === 'live' && this._img.dataset.entityId === this._entity) return;
    this._img.dataset.streamMode = 'live';
    this._img.dataset.entityId = this._entity;
    this._setState('loading');
    const onStreamError = () => {
      this._img?.removeEventListener('error', onStreamError);
      if (!this.isConnected || this._mode !== 'live') return;
      // Avoid console 404 spam: fall back to snapshot when MJPEG proxy is unavailable.
      this.setAttribute('mode', 'snapshot');
      if (this._img) {
        this._img.dataset.streamMode = '';
      }
      this._startRefresh();
    };
    this._img?.addEventListener('error', onStreamError);
    _streamUrl(this._entity).then((url) => {
      if (this._img && this.isConnected) this._img.src = url;
    }).catch(onStreamError);
  }

  _startRefresh() {
    if (!this._img) return;
    const wantLive = this._mode === 'live';
    if (wantLive) {
      const mode = this._img.dataset.streamMode || '';
      const sameEntity = this._img.dataset.entityId === this._entity;
      if (sameEntity && (mode === 'live' || mode === 'live-webm' || mode === 'live-go2rtc')) return;
      if (this._go2rtcLive) this._startGo2rtcLive();
      else if (this._webmLive) this._startWebmLive();
      else this._startMjpegLive();
      return;
    }
    // snapshot mode (HTTP-only cameras)
    this._img.dataset.streamMode = 'snapshot';
    this._img.dataset.entityId = this._entity;
    if (this.dataset.state !== 'ready') this._setState('loading');
    _snapshotUrl(this._entity).then((url) => {
      if (this._img && this.isConnected) this._img.src = url;
    }).catch(() => { this._setState('error'); });
    const ms = Math.max(2, this._interval) * 1000;
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      if (!this.isConnected || document.hidden || this._paused) return;
      if (!this._visible && !this._buffered && !this._forceActive) return;
      _snapshotUrl(this._entity).then((url) => {
        if (this._img && this.isConnected) this._img.src = url;
      }).catch(() => {});
    }, ms);
  }

  _stopRefresh() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    const mode = this._img?.dataset.streamMode || '';
    if (mode === 'live' || mode === 'live-webm' || mode === 'live-go2rtc') {
      this._teardownMse();
      if (this._video) {
        try { this._video.pause(); } catch (_) {}
        this._video.removeAttribute('src');
        this._video.style.display = 'none';
      }
      if (this._img) {
        this._img.src = '';
        this._img.dataset.streamMode = '';
        this._img.style.display = 'block';
      }
    }
    if (this.dataset.state === 'loading') this._setState('idle');
  }
}

if (!customElements.get('hv-camera-stream')) {
  customElements.define('hv-camera-stream', HyveCameraStream);
}

export { HyveCameraStream };
