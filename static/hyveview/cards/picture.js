/**
 * <hv-card-picture> — picture gallery card for Hyveview.
 *
 * Shows one or more images from URLs or `image.*` entities, with touch/mouse
 * swipe navigation when multiple sources are configured. Each source can be
 * either a raw URL string or an `image.*` entity ID (proxied through the
 * backend so the browser never talks to Frigate/etc directly).
 *
 * Config:
 *   { title: string, sources: Array<{ type: 'url'|'entity', value: string }>,
 *     interval: number (seconds, auto-refresh for entity snapshots) }
 */

import { HyveviewCardBase } from '../core/card-base.js';
import { widgetTitle } from '../host.js';
import { cameraMediaUrl } from '../../js/camera_auth.js';
import { HyveviewRegistry } from '../core/registry.js';

const DEFAULT_INTERVAL = 15;

export class HyveviewPictureCard extends HyveviewCardBase {
  static schema = {
    fields: [
      { key: 'title', label: 'Titlu', type: 'string', placeholder: 'Galerie', default: '' },
      { key: 'sources', label: 'Surse imagine', type: 'picture_sources', required: true },
      { key: 'interval', label: 'Refresh (secunde)', type: 'number', min: 5, default: DEFAULT_INTERVAL, hint: 'Interval de reîmprospătare pentru entități image.' },
    ],
  };

  static meta = {
    name: 'Picture',
    description: 'Afișează imagini din URL-uri sau entități image.* cu swipe',
    icon: '🖼️',
  };

  static getStubConfig() {
    return {
      title: '',
      sources: [{ type: 'url', value: '' }],
      interval: DEFAULT_INTERVAL,
    };
  }

  constructor() {
    super();
    this._sources = [];
    this._currentIdx = 0;
    this._refreshTimer = null;
    this._visible = false;
    this._observer = null;
    this._onVisibility = () => this._reevaluate();
    this._touchStartX = 0;
    this._touchDelta = 0;
    this._isDragging = false;
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
  }

  setConfig(config) {
    if (!config) throw new Error('Picture card requires config');
    this._config = { interval: DEFAULT_INTERVAL, ...config };
    const cfg = config.config && typeof config.config === 'object' ? config.config : config;
    let sources = Array.isArray(cfg.sources) ? cfg.sources.filter(s => s && s.value) : [];
    if (!sources.length && Array.isArray(config.sources)) {
      sources = config.sources.filter(s => s && s.value);
    }
    if (!sources.length) {
      const eid = config.entity || config.entity_id || '';
      if (eid && eid.startsWith('image.')) {
        sources = [{ type: 'entity', value: eid }];
      }
    }
    this._sources = sources;
    this._currentIdx = 0;
    this._render();
    this._reevaluate();
  }

  _render() {
    const title = widgetTitle(this._config);

    const frame = document.createElement('div');
    frame.className = 'hyve-dashboard-card__camera-frame';

    this._slides = [];
    if (!this._sources.length) {
      frame.innerHTML = `<div class="hyve-dashboard-card__camera-placeholder"><i class="fas fa-image"></i></div>`;
      this.replaceChildren(frame);
      this._track = null;
      this._frame = frame;
      this._addOverlay(frame, title);
      return;
    }

    const track = document.createElement('div');
    Object.assign(track.style, {
      display: 'flex',
      width: '100%', height: '100%',
      transition: 'transform 0.3s ease',
    });

    for (let i = 0; i < this._sources.length; i++) {
      const slide = document.createElement('div');
      Object.assign(slide.style, {
        minWidth: '100%', height: '100%',
        position: 'relative',
      });
      const img = document.createElement('img');
      img.className = 'hyve-dashboard-card__camera-img';
      img.alt = '';
      img.loading = i === 0 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      slide.appendChild(img);
      track.appendChild(slide);
      this._slides.push(img);
    }

    frame.style.overflow = 'hidden';
    frame.appendChild(track);
    this._track = track;
    this._frame = frame;

    this._addOverlay(frame, title);

    if (this._sources.length > 1) {
      this._renderDots(frame);
      this._bindSwipe(frame);
    }

    this.replaceChildren(frame);
    this._loadAllImages();
    this._goTo(0, false);
  }

  _addOverlay(container, title) {
    if (!title) return;
    const overlay = document.createElement('div');
    overlay.className = 'hyve-dashboard-card__camera-overlay';
    overlay.innerHTML = `<span class="hyve-dashboard-card__camera-title">${title.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</span>`;
    container.appendChild(overlay);
  }

  _renderDots(container) {
    const dotsWrap = document.createElement('div');
    Object.assign(dotsWrap.style, {
      position: 'absolute', bottom: '8px', left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex', gap: '6px', zIndex: '2',
      padding: '4px 8px',
      borderRadius: '12px',
      background: 'rgba(0,0,0,0.45)',
    });
    this._dots = [];
    for (let i = 0; i < this._sources.length; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-label', `Slide ${i + 1}`);
      Object.assign(dot.style, {
        width: '8px', height: '8px', borderRadius: '50%',
        border: 'none', padding: '0', cursor: 'pointer',
        background: 'rgba(255,255,255,0.4)',
        transition: 'background 0.2s, transform 0.2s',
      });
      const idx = i;
      dot.addEventListener('click', (ev) => { ev.stopPropagation(); this._goTo(idx); });
      dotsWrap.appendChild(dot);
      this._dots.push(dot);
    }
    container.appendChild(dotsWrap);
  }

  _bindSwipe(el) {
    let startX = 0, startY = 0, moved = false;
    const onStart = (x, y) => { startX = x; startY = y; this._isDragging = true; moved = false; this._track.style.transition = 'none'; };
    const onMove = (x, y) => {
      if (!this._isDragging) return;
      const dx = x - startX;
      const dy = y - startY;
      if (!moved && Math.abs(dy) > Math.abs(dx)) { this._isDragging = false; return; }
      moved = true;
      this._touchDelta = dx;
      const offset = -(this._currentIdx * 100) + (dx / el.offsetWidth) * 100;
      this._track.style.transform = `translateX(${offset}%)`;
    };
    const onEnd = () => {
      if (!this._isDragging && !moved) return;
      this._isDragging = false;
      this._track.style.transition = 'transform 0.3s ease';
      const threshold = el.offsetWidth * 0.2;
      if (this._touchDelta < -threshold && this._currentIdx < this._sources.length - 1) {
        this._goTo(this._currentIdx + 1);
      } else if (this._touchDelta > threshold && this._currentIdx > 0) {
        this._goTo(this._currentIdx - 1);
      } else {
        this._goTo(this._currentIdx);
      }
      this._touchDelta = 0;
    };

    el.addEventListener('touchstart', (e) => { const t = e.touches[0]; onStart(t.clientX, t.clientY); }, { passive: true });
    el.addEventListener('touchmove', (e) => { const t = e.touches[0]; onMove(t.clientX, t.clientY); }, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('mousedown', (e) => { e.preventDefault(); onStart(e.clientX, e.clientY); });
    el.addEventListener('mousemove', (e) => { onMove(e.clientX, e.clientY); });
    el.addEventListener('mouseup', onEnd);
    el.addEventListener('mouseleave', () => { if (this._isDragging) onEnd(); });
  }

  _goTo(idx, animate = true) {
    this._currentIdx = Math.max(0, Math.min(idx, this._sources.length - 1));
    if (!animate) this._track.style.transition = 'none';
    this._track.style.transform = `translateX(-${this._currentIdx * 100}%)`;
    if (!animate) requestAnimationFrame(() => { this._track.style.transition = 'transform 0.3s ease'; });
    if (this._dots) {
      this._dots.forEach((d, i) => {
        d.style.background = i === this._currentIdx ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)';
        d.style.transform = i === this._currentIdx ? 'scale(1.3)' : 'scale(1)';
      });
    }
  }

  _resolveUrl(source) {
    if (!source || !source.value) return Promise.resolve('');
    if (source.type === 'entity') {
      return cameraMediaUrl(source.value, 'image');
    }
    return Promise.resolve(source.value);
  }

  _loadAllImages() {
    this._sources.forEach((src, i) => {
      if (!this._slides[i]) return;
      this._resolveUrl(src).then((url) => {
        if (url && this._slides[i]) this._slides[i].src = url;
      }).catch(() => {});
    });
  }

  _refreshEntityImages() {
    this._sources.forEach((src, i) => {
      if (src.type === 'entity' && this._slides[i]) {
        this._resolveUrl(src).then((url) => {
          if (url && this._slides[i]) this._slides[i].src = url;
        }).catch(() => {});
      }
    });
  }

  _reevaluate() {
    const active = this._visible && !document.hidden;
    if (active) this._startRefresh();
    else this._stopRefresh();
  }

  _startRefresh() {
    this._stopRefresh();
    const hasEntities = this._sources.some(s => s.type === 'entity');
    if (!hasEntities) return;
    const cfgInterval = this._config?.config?.interval ?? this._config?.interval;
    const ms = Math.max(5, Number(cfgInterval) || DEFAULT_INTERVAL) * 1000;
    this._refreshTimer = setInterval(() => this._refreshEntityImages(), ms);
  }

  _stopRefresh() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  }
}

HyveviewRegistry.define('picture', HyveviewPictureCard, HyveviewPictureCard.meta);
