/**
 * <hv-card-camera> — modern camera card for Hyveview.
 *
 * Design goals (lesson learned from the legacy MJPEG hold-open card):
 *   - No permanent stream connection. The card shows a poster (snapshot)
 *     by default and only opens a live stream after a click or when the
 *     `mode: 'live'` config flag is set AND the card is visible.
 *   - Live prefers WebM (/play) with audio when the proxy supports RTSP;
 *     falls back to MJPEG (/stream) for HTTP-only cameras (e.g. Frigate).
 *   - Snapshots refresh on a timer (default 10 s) ONLY while the card is
 *     visible (IntersectionObserver) AND the page is not hidden
 *     (visibilitychange). This stops cards in hidden tabs from hammering
 *     the camera proxy.
 *   - Cleanly unsubscribes when removed from DOM.
 *
 * Config:
 *   { title: string, entity: 'camera.*', mode: 'snapshot' | 'live',
 *     interval: number (seconds, snapshot mode) }
 */

import { t } from '../../js/lang/index.js';
import { cameraPreferWebmPlayer } from '../../js/camera_live.js';
import { cameraMediaUrl } from '../../js/camera_auth.js';
import { cameraLoaderMarkup, hideCameraLoader, showCameraLoaderError, showCameraLoaderLoading } from '../../js/camera_loader.js';
import { HyveviewCardBase } from '../core/card-base.js';
import { widgetTitle } from '../host.js';
import { HyveviewRegistry } from '../core/registry.js';

const DEFAULT_INTERVAL = 10;

export class HyveviewCameraCard extends HyveviewCardBase {
  static schema = {
    fields: [
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Camere curte', default: '' },
      {
        key: 'entities',
        label: 'Camere',
        type: 'multi_entity',
        domains: ['camera'],
        required: true,
        hint: 'Adaugă una sau mai multe camere. În card poți comuta cu săgeți sau swipe.',
        addLabel: 'Adaugă cameră',
      },
      { key: 'mode', label: 'Mode', type: 'select', default: 'snapshot', options: [
        { value: 'snapshot', label: 'Snapshot (refresh on a timer)' },
        { value: 'live', label: 'Live (WebM + audio when available)' },
      ]},
      { key: 'interval', label: 'Refresh interval (seconds)', type: 'number', min: 2, default: DEFAULT_INTERVAL, hint: 'Snapshot mode only.' },
      { key: 'default_audio', label: 'Pornește cu sunetul activ', type: 'boolean', default: false, inline: true, hint: 'Implicit ascultarea este dezactivată.' },
      { key: 'default_microphone', label: 'Pornește cu microfonul camerei activ', type: 'boolean', default: false, inline: true, hint: 'Implicit microfonul camerei este dezactivat.' },
      { key: 'preload', label: t('dashboard.camera.preload'), type: 'boolean', default: false, inline: true, hint: t('dashboard.camera.preload_hint') },
      {
        key: 'preload_scope',
        label: t('dashboard.camera.preload_scope'),
        type: 'select',
        default: 'adjacent',
        hint: t('dashboard.camera.preload_scope_hint'),
        options: [
          { value: 'adjacent', label: t('dashboard.camera.preload_adjacent') },
          { value: 'all', label: t('dashboard.camera.preload_all') },
        ],
      },
    ],
  };

  static meta = {
    name: 'Camera',
    description: 'Live or snapshot view of a camera.*',
    icon: '📷',
  };

  static getStubConfig(entityId) {
    return {
      title: '',
      entities: entityId ? [{ entity_id: entityId, title: '', subtitle: '' }] : [],
      mode: 'snapshot',
      interval: DEFAULT_INTERVAL,
      default_audio: false,
      default_microphone: false,
      preload: false,
      preload_scope: 'adjacent',
    };
  }

  constructor() {
    super();
    this._img = null;
    this._video = null;
    this._muteBtn = null;
    this._entityState = null;
    this._refreshTimer = null;
    this._visible = false;
    this._observer = null;
    this._onVisibility = () => this._reevaluate();
  }

  setState(entity) {
    this._entityState = entity || null;
    super.setState(entity);
  }

  _supportsWebmAudio() {
    return cameraPreferWebmPlayer(this._entityState?.attributes || {});
  }

  connectedCallback() {
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
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    this._stopRefresh();
    this._teardownLive();
  }

  setConfig(config) {
    const ents = Array.isArray(config?.entities) ? config.entities : [];
    if (!config || (!config.entity && !ents.length)) throw new Error('Camera card requires at least one entity');
    this._config = {
      mode: 'snapshot',
      interval: DEFAULT_INTERVAL,
      ...config,
    };
    this._render();
    this._reevaluate();
  }

  _render() {
    const { body } = this.buildFrame({
      title: widgetTitle(this._config, { entityId: this._config.entity }),
      icon: '📷',
    });
    body.style.padding = '0';
    body.style.position = 'relative';
    body.style.background = '#000';
    body.style.aspectRatio = '16 / 9';

    const img = document.createElement('img');
    img.alt = this._config.entity || 'camera';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.style.display = 'block';
    img.style.opacity = '0';
    img.style.transition = 'opacity 280ms ease';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    body.appendChild(img);
    this._img = img;

    const loaderWrap = document.createElement('div');
    loaderWrap.innerHTML = cameraLoaderMarkup();
    this._loader = loaderWrap.firstElementChild;
    body.appendChild(this._loader);

    img.addEventListener('load', () => {
      if (img.src && img.naturalWidth > 0 && img.style.display !== 'none') this._setLoading(false);
    });
    img.addEventListener('error', () => {
      if (img.style.display !== 'none') this._setLoading(true, true);
    });

    if (this._config.mode === 'snapshot') {
      const overlay = document.createElement('button');
      overlay.type = 'button';
      overlay.textContent = '▶ Live';
      overlay.title = 'Live cu sunet (WebM) sau MJPEG';
      Object.assign(overlay.style, {
        position: 'absolute', right: '8px', bottom: '8px', zIndex: '4',
        background: 'rgba(0,0,0,0.55)', color: '#fff',
        border: 'none', borderRadius: '8px',
        padding: '6px 10px', cursor: 'pointer', fontSize: '12px',
      });
      overlay.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._goLiveOnce();
      });
      body.appendChild(overlay);
    }
  }

  _reevaluate() {
    const active = this._visible && !document.hidden;
    if (active) this._startRefresh();
    else this._stopRefresh();
  }

  _snapshotUrl() {
    return cameraMediaUrl(this._config.entity, 'snapshot');
  }

  _streamUrl() {
    return cameraMediaUrl(this._config.entity, 'stream');
  }

  _playUrl() {
    return cameraMediaUrl(this._config.entity, 'play');
  }

  _ensureMuteButton(body) {
    if (this._muteBtn) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Sunet';
    btn.setAttribute('aria-label', 'Sunet');
    btn.textContent = '🔊';
    Object.assign(btn.style, {
      position: 'absolute', left: '8px', bottom: '8px', zIndex: '5',
      background: 'rgba(0,0,0,0.55)', color: '#fff',
      border: 'none', borderRadius: '8px',
      padding: '6px 10px', cursor: 'pointer', fontSize: '14px',
      display: 'none',
    });
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const v = this._video;
      if (!v) return;
      v.muted = !v.muted;
      btn.textContent = v.muted ? '🔇' : '🔊';
    });
    body.appendChild(btn);
    this._muteBtn = btn;
  }

  _startMjpegLive() {
    if (!this._img) return;
    this._teardownVideoOnly();
    this._img.style.display = 'block';
    this._img.dataset.mode = 'live';
    this._setLoading(true);
    this._streamUrl().then((url) => {
      if (this._img) this._img.src = url;
    }).catch(() => this._setLoading(false));
  }

  _startWebmLive() {
    if (!this._supportsWebmAudio()) {
      this._startMjpegLive();
      return;
    }
    const body = this.querySelector('.hv-card-body') || this._img?.parentElement;
    if (!body || !this._img) return;
    this._ensureMuteButton(body);
    if (!this._video) {
      const video = document.createElement('video');
      video.playsInline = true;
      video.autoplay = true;
      video.controls = false;
      video.muted = false;
      Object.assign(video.style, {
        width: '100%', height: '100%', objectFit: 'cover', display: 'none',
        background: '#000',
      });
      video.addEventListener('loadeddata', () => this._setLoading(false));
      video.addEventListener('playing', () => this._setLoading(false));
      video.addEventListener('error', () => this._fallbackMjpegLive());
      body.appendChild(video);
      this._video = video;
    }
    this._img.style.display = 'none';
    this._img.src = '';
    this._video.style.display = 'block';
    if (this._muteBtn) {
      this._muteBtn.style.display = 'block';
      this._muteBtn.textContent = this._video.muted ? '🔇' : '🔊';
    }
    this._setLoading(true);
    this._playUrl().then((url) => {
      if (this._video) {
        this._video.src = url;
        this._video.play().catch(() => {});
      }
    }).catch(() => this._setLoading(false));
    if (this._img) this._img.dataset.mode = 'live-webm';
  }

  _fallbackMjpegLive() {
    this._startMjpegLive();
  }

  _teardownVideoOnly() {
    if (this._video) {
      try { this._video.pause(); } catch (_) {}
      this._video.removeAttribute('src');
      try { this._video.load(); } catch (_) {}
      this._video.style.display = 'none';
    }
    if (this._muteBtn) this._muteBtn.style.display = 'none';
  }

  _teardownLive() {
    this._teardownVideoOnly();
    if (this._img) {
      this._img.src = '';
      this._img.dataset.mode = '';
      this._img.style.display = 'block';
    }
  }

  _startRefresh() {
    if (!this._img) return;
    if (this._config.mode === 'live') {
      const mode = this._img.dataset.mode || '';
      if (mode !== 'live' && mode !== 'live-webm') {
        if (this._supportsWebmAudio()) this._startWebmLive();
        else this._startMjpegLive();
      }
      return;
    }
    this._teardownLive();
    this._img.dataset.mode = 'snapshot';
    this._setLoading(true);
    this._snapshotUrl().then((url) => {
      if (this._img) this._img.src = url;
    }).catch(() => this._setLoading(false));
    const interval = Math.max(2, Number(this._config.interval) || DEFAULT_INTERVAL) * 1000;
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      if (this._img && this._img.dataset.mode === 'snapshot') {
        this._snapshotUrl().then((url) => { if (this._img) this._img.src = url; }).catch(() => {});
      }
    }, interval);
  }

  _setLoading(on, isError = false) {
    if (!this._loader) return;
    if (!on) {
      hideCameraLoader(this._loader);
      if (this._img) this._img.style.opacity = '1';
      if (this._video) this._video.style.opacity = '1';
      return;
    }
    if (isError === true) showCameraLoaderError(this._loader);
    else showCameraLoaderLoading(this._loader);
    if (this._img) this._img.style.opacity = '0';
    if (this._video) this._video.style.opacity = '0';
  }

  _stopRefresh() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    const mode = this._img?.dataset.mode || '';
    if (mode === 'live' || mode === 'live-webm') this._teardownLive();
  }

  _goLiveOnce() {
    if (!this._img) return;
    this._stopRefresh();
    if (this._supportsWebmAudio()) this._startWebmLive();
    else this._startMjpegLive();
  }
}

HyveviewRegistry.define('camera', HyveviewCameraCard, HyveviewCameraCard.meta);
