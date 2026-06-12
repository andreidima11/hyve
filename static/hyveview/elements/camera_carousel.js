/**
 * <hv-camera-carousel> — multi-camera dashboard card with swipe / nav and audio menu.
 *
 * Attributes:
 *   entities  — URI-encoded JSON array of { entity_id, title?, webm? }
 *   mode      — snapshot | live
 *   interval  — snapshot refresh seconds
 *   index     — initial camera index (optional)
 */
import { cameraIsMammotionLive, cameraPreferWebmPlayer, cameraSupportsGo2rtc, } from '../../js/camera_live.js';
import { getCameraStreamToken } from '../../js/camera_auth.js';
import { t } from '../../js/lang/index.js';
const CAROUSEL_DOM_VERSION = '5';
function _parseEntities(raw) {
    if (!raw)
        return [];
    try {
        let decoded = String(raw).trim();
        try {
            if (decoded.includes('%'))
                decoded = decodeURIComponent(decoded);
        }
        catch (_) { /* use raw */ }
        const list = JSON.parse(decoded);
        return Array.isArray(list)
            ? list.filter((e) => e && e.entity_id).map((e) => ({
                entity_id: String(e.entity_id),
                title: String(e.title || e.entity_id || '').trim(),
                webm: e.webm === true || e.webm === 'true',
                go2rtc: e.go2rtc === true || e.go2rtc === 'true',
                agora: e.agora === true || e.agora === 'true',
            }))
            : [];
    }
    catch (_) {
        return [];
    }
}
class HyveCameraCarousel extends HTMLElement {
    static get observedAttributes() {
        return ['entities', 'mode', 'interval', 'index', 'default-audio', 'default-mic', 'preload', 'preload-scope', 'autoplay'];
    }
    constructor() {
        super();
        this._entities = [];
        this._index = 0;
        this._stream = null;
        this._streams = new Map();
        this._caps = null;
        this._capsEntity = '';
        this._menuOpen = false;
        this._speakerMuted = true;
        this._micMuted = true;
        this._speakerVolume = 50;
        this._pttActive = false;
        this._pttRecorder = null;
        this._pttChunks = [];
        this._touchStartX = null;
        this._menuListenersBound = false;
        this._audioDefaultsApplied = false;
        this._built = false;
        this._hostVisible = true;
        this._hostObserver = null;
        this._stage = null;
        this._titleEl = null;
        this._dotsEl = null;
        this._menu = null;
        this._menuBtn = null;
        this._prevBtn = null;
        this._nextBtn = null;
        this._volRow = null;
        this._micRow = null;
        this._pttBtn = null;
        this._menuHint = null;
        this._volSlider = null;
        this._spkBtn = null;
        this._micBtn = null;
        this._viewport = null;
        this._onMenuReposition = null;
        this._onDocClick = null;
    }
    connectedCallback() {
        if (this.dataset.domVersion !== CAROUSEL_DOM_VERSION) {
            this._teardownMenuListeners();
            this._clearAllStreams();
            this._built = false;
            this.innerHTML = '';
            this.dataset.domVersion = CAROUSEL_DOM_VERSION;
        }
        if (!this._built) {
            this._build();
            this._built = true;
        }
        this._applyAudioDefaultsFromAttrs();
        this._reloadEntities();
        this._renderIndex();
        // Pause every child stream while the whole card is scrolled out of view.
        // Child streams use `force-active` to bypass their own IntersectionObserver
        // (carousel layout makes per-stream IO unreliable), so off-screen gating
        // has to happen at the carousel host — otherwise the active camera keeps
        // streaming MJPEG/go2rtc/WebM while invisible.
        this._hostVisible = true;
        if ('IntersectionObserver' in window) {
            this._hostObserver = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    if (e.target !== this)
                        continue;
                    const visible = e.isIntersecting;
                    if (visible === this._hostVisible)
                        continue;
                    this._hostVisible = visible;
                    if (visible)
                        this.resumeStream();
                    else
                        this.pauseStream();
                }
            }, { threshold: 0.01 });
            this._hostObserver.observe(this);
        }
    }
    disconnectedCallback() {
        this._stopPtt();
        this.pauseStream();
        if (this._hostObserver) {
            this._hostObserver.disconnect();
            this._hostObserver = null;
        }
        this._teardownMenuListeners();
        this._closeMenu();
    }
    attributeChangedCallback(name) {
        if (!this._built)
            return;
        if (name === 'entities') {
            this._reloadEntities();
            this._renderIndex();
        }
        if (name === 'index') {
            const v = Number(this.getAttribute('index'));
            if (Number.isFinite(v) && v !== this._index) {
                this._setIndex(v, { syncAttr: false });
            }
        }
        if (name === 'default-audio' || name === 'default-mic') {
            this._applyAudioDefaultsFromAttrs({ force: true });
        }
        if (name === 'mode' || name === 'interval' || name === 'preload' || name === 'preload-scope' || name === 'autoplay') {
            this._renderIndex();
        }
    }
    get _defaultSpeakerOn() {
        return this.getAttribute('default-audio') === 'true';
    }
    get _defaultMicOn() {
        return this.getAttribute('default-mic') === 'true';
    }
    _applyAudioDefaultsFromAttrs({ force = false } = {}) {
        if (this._audioDefaultsApplied && !force)
            return;
        this._speakerMuted = !this._defaultSpeakerOn;
        this._micMuted = !this._defaultMicOn;
        this._audioDefaultsApplied = true;
        this._updateMenuUi();
        this._applySpeakerMute();
        this._applyMicToCamera();
    }
    _ensureStreamMap() {
        if (!this._streams)
            this._streams = new Map();
    }
    _clearAllStreams() {
        this._ensureStreamMap();
        for (const entityId of [...this._streams.keys()])
            this._removeStream(entityId);
        this._stream = null;
    }
    pauseStream() {
        this._ensureStreamMap();
        this._streams.forEach((stream) => { try {
            stream.pauseStream?.();
        }
        catch (_) { } });
    }
    resumeStream() {
        this._ensureStreamMap();
        if (!this._stream && this._entities.length)
            this._syncPreloadStreams();
        this._streams.forEach((stream) => { try {
            stream.resumeStream?.();
        }
        catch (_) { } });
    }
    get _preloadOn() {
        return this.getAttribute('preload') === 'true';
    }
    get _preloadScope() {
        return (this.getAttribute('preload-scope') || 'adjacent').toLowerCase() === 'all' ? 'all' : 'adjacent';
    }
    get _autoplayOn() {
        return this.getAttribute('autoplay') !== 'false';
    }
    _preloadIndices() {
        const indices = new Set();
        if (!this._preloadOn || this._entities.length < 2)
            return indices;
        if (this._preloadScope === 'all') {
            this._entities.forEach((_, i) => { if (i !== this._index)
                indices.add(i); });
            return indices;
        }
        const n = this._entities.length;
        const prev = (this._index - 1 + n) % n;
        const next = (this._index + 1) % n;
        if (prev !== this._index)
            indices.add(prev);
        if (next !== this._index && next !== prev)
            indices.add(next);
        return indices;
    }
    _removeStream(entityId) {
        this._ensureStreamMap();
        const stream = this._streams.get(entityId);
        if (!stream)
            return;
        try {
            stream.pauseStream?.();
        }
        catch (_) { }
        stream.remove();
        this._streams.delete(entityId);
        if (this._stream === stream)
            this._stream = null;
    }
    _entityStreamConfig(ent) {
        const cache = window._dashboardCache;
        const live = (cache?.available_entities || []).find((e) => e.entity_id === ent.entity_id);
        const attrs = live?.attributes || {};
        let webm = this._entityWebm(ent);
        if (webm === false)
            webm = cameraPreferWebmPlayer(attrs);
        let go2rtc = ent.go2rtc;
        if (go2rtc == null)
            go2rtc = cameraSupportsGo2rtc(attrs);
        let agora = ent.agora;
        if (!agora)
            agora = cameraIsMammotionLive(ent.entity_id, attrs);
        return { webm, go2rtc, agora };
    }
    _streamUsesAgora(stream) {
        return String(stream?.tagName || '').toLowerCase() === 'hv-mammotion-camera';
    }
    _setStreamAttr(stream, name, value) {
        if (stream.getAttribute(name) !== value)
            stream.setAttribute(name, value);
    }
    _applyStreamAttrs(stream, ent, { active = false, buffered = false } = {}) {
        const { webm, go2rtc, agora } = this._entityStreamConfig(ent);
        if (agora || this._streamUsesAgora(stream)) {
            this._setStreamAttr(stream, 'entity', ent.entity_id);
            this._setStreamAttr(stream, 'alt', ent.title || ent.entity_id);
            this._setStreamAttr(stream, 'autoplay', (active && this._autoplayOn) ? 'true' : 'false');
            // Carousel layout makes per-stream IntersectionObserver unreliable — same as hv-camera-stream.
            this._setStreamAttr(stream, 'force-active', active ? 'true' : 'false');
            stream.classList.toggle('hv-camera-carousel__stream--active', active);
            stream.classList.toggle('hv-camera-carousel__stream--buffer', buffered);
            return;
        }
        // Only the active slide goes live; preloaded (buffered) slides poll a
        // snapshot so off-screen cameras don't each hold a live MJPEG/go2rtc/WebM
        // connection. On swipe the slide becomes active and upgrades to live.
        const mode = (active && this._mode === 'live') ? 'live' : 'snapshot';
        this._setStreamAttr(stream, 'entity', ent.entity_id);
        this._setStreamAttr(stream, 'mode', mode);
        this._setStreamAttr(stream, 'interval', String(this._interval));
        this._setStreamAttr(stream, 'webm', webm ? 'true' : 'false');
        this._setStreamAttr(stream, 'go2rtc', go2rtc ? 'true' : 'false');
        this._setStreamAttr(stream, 'muted', (active && !this._speakerMuted) ? 'false' : 'true');
        this._setStreamAttr(stream, 'show-mute', 'false');
        this._setStreamAttr(stream, 'buffer', buffered ? 'true' : 'false');
        this._setStreamAttr(stream, 'force-active', active ? 'true' : 'false');
        this._setStreamAttr(stream, 'alt', ent.title || ent.entity_id);
        stream.classList.toggle('hv-camera-carousel__stream--active', active);
        stream.classList.toggle('hv-camera-carousel__stream--buffer', buffered);
    }
    _createStreamElement(ent) {
        if (this._entityStreamConfig(ent).agora) {
            const stream = document.createElement('hv-mammotion-camera');
            stream.className = 'hyve-dashboard-card__camera-player hv-camera-carousel__stream hv-camera-carousel__stream--agora';
            return stream;
        }
        const stream = document.createElement('hv-camera-stream');
        stream.className = 'hyve-dashboard-card__camera-player hv-camera-carousel__stream';
        return stream;
    }
    _attachStream(ent, { active = false, buffered = false } = {}) {
        this._ensureStreamMap();
        let stream = this._streams.get(ent.entity_id);
        const wantsAgora = this._entityStreamConfig(ent).agora;
        if (stream && this._streamUsesAgora(stream) !== wantsAgora) {
            this._removeStream(ent.entity_id);
            stream = undefined;
        }
        if (!stream || !stream.isConnected) {
            if (stream)
                this._streams.delete(ent.entity_id);
            stream = this._createStreamElement(ent);
            this._stage.appendChild(stream);
            this._streams.set(ent.entity_id, stream);
        }
        this._applyStreamAttrs(stream, ent, { active, buffered });
        if (active) {
            this._stream = stream;
            this._applySpeakerMute();
        }
        stream.resumeStream?.();
        return stream;
    }
    /** Default path: one persistent stream element, swap entity on swipe. */
    _syncSingleStream() {
        const cur = this._current();
        if (!cur || !this._stage)
            return;
        this._ensureStreamMap();
        for (const entityId of [...this._streams.keys()]) {
            if (this._streams.get(entityId) !== this._stream)
                this._removeStream(entityId);
        }
        const wantsAgora = this._entityStreamConfig(cur).agora;
        if (this._stream && this._streamUsesAgora(this._stream) !== wantsAgora) {
            this._clearAllStreams();
        }
        if (!this._stream || !this._stream.isConnected) {
            this._clearAllStreams();
            this._stream = this._createStreamElement(cur);
            this._stream.classList.add('hv-camera-carousel__stream--active');
            this._stage.appendChild(this._stream);
            this._streams.set(cur.entity_id, this._stream);
        }
        this._streams.set(cur.entity_id, this._stream);
        this._applyStreamAttrs(this._stream, cur, { active: true, buffered: false });
        this._stream.resumeStream?.();
        this._applySpeakerMute();
    }
    _syncPreloadStreams() {
        if (!this._stage)
            return;
        if (!this._preloadOn || this._entities.length < 2) {
            this._syncSingleStream();
            return;
        }
        this._ensureStreamMap();
        const keep = new Set();
        const preloadIdx = this._preloadIndices();
        this._entities.forEach((ent, idx) => {
            const isActive = idx === this._index;
            const shouldBuffer = preloadIdx.has(idx);
            if (!isActive && !shouldBuffer)
                return;
            keep.add(ent.entity_id);
            this._attachStream(ent, { active: isActive, buffered: shouldBuffer });
        });
        for (const entityId of [...this._streams.keys()]) {
            if (!keep.has(entityId))
                this._removeStream(entityId);
        }
    }
    get _mode() {
        const m = (this.getAttribute('mode') || 'snapshot').toLowerCase();
        return m === 'live' ? 'live' : 'snapshot';
    }
    get _interval() {
        const v = Number(this.getAttribute('interval'));
        return Number.isFinite(v) && v >= 2 ? v : 10;
    }
    _reloadEntities() {
        this._entities = _parseEntities(this.getAttribute('entities') || '');
        const idx = Number(this.getAttribute('index'));
        if (Number.isFinite(idx))
            this._index = Math.min(Math.max(0, idx), Math.max(0, this._entities.length - 1));
        else if (this._index >= this._entities.length)
            this._index = 0;
        this._renderDots();
    }
    _current() {
        return this._entities[this._index] || null;
    }
    _build() {
        this.className = 'hv-camera-carousel';
        this.innerHTML = `
      <div class="hv-camera-carousel__viewport">
        <button type="button" class="hv-camera-carousel__nav hv-camera-carousel__nav--prev" aria-label="${t('dashboard.camera.prev_camera')}" hidden>
          <i class="fas fa-chevron-left"></i>
        </button>
        <div class="hv-camera-carousel__stage"></div>
        <button type="button" class="hv-camera-carousel__nav hv-camera-carousel__nav--next" aria-label="${t('dashboard.camera.next_camera')}" hidden>
          <i class="fas fa-chevron-right"></i>
        </button>
        <button type="button" class="hv-camera-carousel__menu-btn" aria-label="${t('dashboard.camera.audio_settings')}" title="${t('dashboard.camera.audio')}">
          <i class="fas fa-ellipsis-vertical"></i>
        </button>
        <div class="hv-camera-carousel__menu hidden" role="dialog" aria-label="${t('dashboard.camera.audio_settings')}">
          <div class="hv-camera-carousel__menu-head">${t('dashboard.camera.audio')}</div>
          <label class="hv-camera-carousel__menu-row">
            <span><i class="fas fa-volume-high"></i> ${t('dashboard.camera.listen')}</span>
            <button type="button" class="hv-camera-carousel__toggle is-muted" data-act="speaker-mute" aria-pressed="true"><i class="fas fa-volume-xmark"></i></button>
          </label>
          <label class="hv-camera-carousel__menu-row hv-camera-carousel__menu-row--vol" hidden>
            <span>${t('dashboard.camera.speaker_volume')}</span>
            <input type="range" min="0" max="100" step="1" value="50" data-act="speaker-volume" class="hv-camera-carousel__range">
          </label>
          <label class="hv-camera-carousel__menu-row hv-camera-carousel__menu-row--mic" hidden>
            <span><i class="fas fa-microphone"></i> ${t('dashboard.camera.camera_mic')}</span>
            <button type="button" class="hv-camera-carousel__toggle is-muted" data-act="mic-mute" aria-pressed="true"><i class="fas fa-microphone-slash"></i></button>
          </label>
          <button type="button" class="hv-camera-carousel__ptt" data-act="ptt" hidden>
            <i class="fas fa-microphone-lines"></i> ${t('dashboard.camera.ptt_hold')}
          </button>
          <div class="hv-camera-carousel__menu-hint" data-menu-hint></div>
        </div>
        <div class="hv-camera-carousel__footer">
          <div class="hv-camera-carousel__dots"></div>
          <div class="hv-camera-carousel__title"></div>
        </div>
      </div>`;
        this._stage = this.querySelector('.hv-camera-carousel__stage');
        this._titleEl = this.querySelector('.hv-camera-carousel__title');
        this._dotsEl = this.querySelector('.hv-camera-carousel__dots');
        this._menu = this.querySelector('.hv-camera-carousel__menu');
        this._menuBtn = this.querySelector('.hv-camera-carousel__menu-btn');
        this._prevBtn = this.querySelector('.hv-camera-carousel__nav--prev');
        this._nextBtn = this.querySelector('.hv-camera-carousel__nav--next');
        this._volRow = this.querySelector('.hv-camera-carousel__menu-row--vol');
        this._micRow = this.querySelector('.hv-camera-carousel__menu-row--mic');
        this._pttBtn = this.querySelector('[data-act="ptt"]');
        this._menuHint = this.querySelector('[data-menu-hint]');
        this._volSlider = this.querySelector('[data-act="speaker-volume"]');
        this._spkBtn = this.querySelector('[data-act="speaker-mute"]');
        this._micBtn = this.querySelector('[data-act="mic-mute"]');
        this._prevBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this._setIndex(this._index - 1); });
        this._nextBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this._setIndex(this._index + 1); });
        this._menuBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._toggleMenu();
        });
        this._spkBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._speakerMuted = !this._speakerMuted;
            this._applySpeakerMute();
            this._updateMenuUi();
        });
        this._micBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._micMuted = !this._micMuted;
            this._postAudio('set_microphone_muted', { enabled: this._micMuted });
            this._updateMenuUi();
        });
        this._volSlider.addEventListener('input', (ev) => {
            ev.stopPropagation();
            this._speakerVolume = Number(ev.target.value);
        });
        this._volSlider.addEventListener('change', (ev) => {
            ev.stopPropagation();
            this._postAudio('set_speaker_volume', { volume: Number(ev.target.value) });
        });
        const startPtt = (ev) => { ev.preventDefault(); ev.stopPropagation(); this._startPtt(); };
        const stopPtt = (ev) => { ev.preventDefault(); ev.stopPropagation(); void this._stopPtt(true); };
        this._pttBtn.addEventListener('mousedown', startPtt);
        this._pttBtn.addEventListener('mouseup', stopPtt);
        this._pttBtn.addEventListener('mouseleave', stopPtt);
        this._pttBtn.addEventListener('touchstart', startPtt, { passive: false });
        this._pttBtn.addEventListener('touchend', stopPtt, { passive: false });
        this._pttBtn.addEventListener('touchcancel', stopPtt, { passive: false });
        this._viewport = this.querySelector('.hv-camera-carousel__viewport');
        this._viewport.addEventListener('touchstart', (ev) => {
            if (this._entities.length < 2)
                return;
            this._touchStartX = ev.changedTouches?.[0]?.clientX ?? null;
        }, { passive: true });
        this._viewport.addEventListener('touchend', (ev) => {
            if (this._touchStartX == null || this._entities.length < 2)
                return;
            const endX = ev.changedTouches?.[0]?.clientX;
            if (endX == null)
                return;
            const delta = endX - this._touchStartX;
            this._touchStartX = null;
            if (Math.abs(delta) < 40)
                return;
            if (delta < 0)
                this._setIndex(this._index + 1);
            else
                this._setIndex(this._index - 1);
        }, { passive: true });
    }
    _toggleMenu() {
        if (this._menuOpen)
            this._closeMenu();
        else
            this._openMenu();
    }
    _openMenu() {
        this._menuOpen = true;
        this._menu.classList.remove('hidden');
        this._mountMenuPortal();
        this._loadCapabilities();
    }
    _closeMenu() {
        this._menuOpen = false;
        this._menu.classList.add('hidden');
        this._unmountMenuPortal();
    }
    _ensureMenuListeners() {
        if (this._menuListenersBound)
            return;
        this._menuListenersBound = true;
        this._onMenuReposition = () => {
            if (this._menuOpen)
                this._positionMenu();
        };
        window.addEventListener('resize', this._onMenuReposition);
        window.addEventListener('scroll', this._onMenuReposition, true);
        this._onDocClick = (ev) => {
            if (!this._menuOpen)
                return;
            const target = ev.target;
            if (target?.closest('.hv-camera-carousel__menu') || target?.closest('.hv-camera-carousel__menu-btn'))
                return;
            this._closeMenu();
        };
        document.addEventListener('click', this._onDocClick, true);
    }
    _teardownMenuListeners() {
        if (!this._menuListenersBound)
            return;
        window.removeEventListener('resize', this._onMenuReposition);
        window.removeEventListener('scroll', this._onMenuReposition, true);
        document.removeEventListener('click', this._onDocClick, true);
        this._menuListenersBound = false;
    }
    _mountMenuPortal() {
        if (!this._menu || !this._menuBtn)
            return;
        this._ensureMenuListeners();
        this._menu.classList.add('hv-camera-carousel__menu--portal');
        if (this._menu.parentElement !== document.body) {
            document.body.appendChild(this._menu);
        }
        requestAnimationFrame(() => this._positionMenu());
    }
    _positionMenu() {
        if (!this._menu || !this._menuBtn)
            return;
        const rect = this._menuBtn.getBoundingClientRect();
        const gap = 6;
        const menu = this._menu;
        menu.style.position = 'fixed';
        menu.style.zIndex = '12000';
        menu.style.left = 'auto';
        menu.style.maxWidth = 'min(16rem, calc(100vw - 1rem))';
        const menuHeight = menu.offsetHeight || 220;
        let top = rect.bottom + gap;
        if (top + menuHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - gap - menuHeight);
        }
        menu.style.top = `${top}px`;
        menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    }
    _unmountMenuPortal() {
        if (!this._menu)
            return;
        this._menu.classList.remove('hv-camera-carousel__menu--portal');
        if (this._viewport && this._menu.parentElement === document.body) {
            this._viewport.appendChild(this._menu);
        }
        this._menu.style.position = '';
        this._menu.style.top = '';
        this._menu.style.right = '';
        this._menu.style.left = '';
        this._menu.style.zIndex = '';
        this._menu.style.maxWidth = '';
    }
    async _loadCapabilities(attempt = 0) {
        const cur = this._current();
        if (!cur)
            return;
        if (this._capsEntity === cur.entity_id && this._caps) {
            this._applyCapabilitiesUi();
            return;
        }
        const maxAttempts = 2;
        try {
            const token = await getCameraStreamToken();
            const res = await fetch(`/api/cameras/${encodeURIComponent(cur.entity_id)}/capabilities?token=${encodeURIComponent(token)}`);
            if (!res.ok)
                throw new Error('capabilities failed');
            this._caps = await res.json();
            this._capsEntity = cur.entity_id;
            if (this._caps?.speaker_volume != null) {
                this._speakerVolume = Number(this._caps.speaker_volume) || 50;
                if (this._volSlider)
                    this._volSlider.value = String(this._speakerVolume);
            }
            this._applyCapabilitiesUi();
            this._applyMicToCamera();
            requestAnimationFrame(() => this._positionMenu());
        }
        catch (_) {
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
                return this._loadCapabilities(attempt + 1);
            }
            if (this._menuHint)
                this._menuHint.textContent = t('dashboard.camera.caps_failed');
        }
    }
    _applyCapabilitiesUi() {
        const caps = this._caps || {};
        if (this._volRow)
            this._volRow.hidden = !caps.speaker_volume_mutable;
        if (this._micRow)
            this._micRow.hidden = !caps.microphone_mutable;
        const showPtt = !!caps.supports_talk;
        if (this._pttBtn)
            this._pttBtn.hidden = !showPtt;
        const methods = Array.isArray(caps.talk_methods) ? caps.talk_methods.join(', ') : '';
        if (!this._menuHint)
            return;
        if (showPtt) {
            this._menuHint.textContent = methods
                ? t('dashboard.camera.talk_via', { methods })
                : t('dashboard.camera.talk_hint');
        }
        else if (caps.two_way_audio_capable && !caps.go2rtc_available) {
            this._menuHint.textContent = t('dashboard.camera.two_way_needs_go2rtc');
        }
        else if (caps.has_audio || caps.go2rtc_available) {
            this._menuHint.textContent = caps.source === 'frigate' && !caps.go2rtc_available
                ? t('dashboard.camera.listen_only_frigate')
                : t('dashboard.camera.listen_only');
        }
        else {
            this._menuHint.textContent = t('dashboard.camera.no_audio');
        }
        this._updateMenuUi();
    }
    _updateMenuUi() {
        if (this._spkBtn) {
            const icon = this._spkBtn.querySelector('i');
            if (icon)
                icon.className = this._speakerMuted ? 'fas fa-volume-xmark' : 'fas fa-volume-high';
            this._spkBtn.classList.toggle('is-muted', this._speakerMuted);
            this._spkBtn.setAttribute('aria-pressed', this._speakerMuted ? 'true' : 'false');
        }
        if (this._micBtn) {
            const icon = this._micBtn.querySelector('i');
            if (icon)
                icon.className = this._micMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
            this._micBtn.classList.toggle('is-muted', this._micMuted);
            this._micBtn.setAttribute('aria-pressed', this._micMuted ? 'true' : 'false');
        }
        this._pttBtn?.classList.toggle('is-active', this._pttActive);
    }
    _applySpeakerMute() {
        if (this._stream) {
            this._stream.setAttribute('muted', this._speakerMuted ? 'true' : 'false');
            this._stream.setAttribute('show-mute', 'false');
        }
        const video = this._stream?.querySelector?.('video');
        if (video)
            video.muted = this._speakerMuted;
        if (this._caps?.speaker_volume_mutable && this._caps?.source === 'tapo') {
            this._postAudio('set_speaker_muted', { enabled: this._speakerMuted });
        }
    }
    _applyMicToCamera() {
        if (!this._caps?.microphone_mutable)
            return;
        this._postAudio('set_microphone_muted', { enabled: this._micMuted });
    }
    async _postAudio(action, payload) {
        const cur = this._current();
        if (!cur)
            return;
        try {
            const token = await getCameraStreamToken();
            await fetch(`/api/cameras/${encodeURIComponent(cur.entity_id)}/audio?token=${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ action, ...payload }),
            });
        }
        catch (_) { /* best effort */ }
    }
    async _startPtt() {
        if (this._pttActive || !this._caps?.supports_talk)
            return;
        if (!navigator.mediaDevices?.getUserMedia)
            return;
        this._pttActive = true;
        this._pttChunks = [];
        this._updateMenuUi();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus' : 'audio/webm';
            this._pttRecorder = new MediaRecorder(stream, { mimeType: mime });
            this._pttRecorder.ondataavailable = (ev) => {
                if (ev.data?.size)
                    this._pttChunks.push(ev.data);
            };
            this._pttRecorder.start();
        }
        catch (_) {
            this._pttActive = false;
            this._updateMenuUi();
        }
    }
    async _stopPtt(send = false) {
        if (!this._pttActive)
            return;
        this._pttActive = false;
        this._updateMenuUi();
        const recorder = this._pttRecorder;
        this._pttRecorder = null;
        if (!recorder)
            return;
        const finalize = async () => {
            recorder.stream?.getTracks?.().forEach((t) => t.stop());
            if (!send || !this._pttChunks.length)
                return;
            const cur = this._current();
            if (!cur)
                return;
            const blob = new Blob(this._pttChunks, { type: recorder.mimeType || 'audio/webm' });
            this._pttChunks = [];
            const token = await getCameraStreamToken();
            const form = new FormData();
            form.append('audio', blob, 'talk.webm');
            try {
                const res = await fetch(`/api/cameras/${encodeURIComponent(cur.entity_id)}/talk?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    if (this._menuHint)
                        this._menuHint.textContent = String(err.detail || t('dashboard.camera.talk_error'));
                }
            }
            catch (_) {
                if (this._menuHint)
                    this._menuHint.textContent = t('dashboard.camera.talk_send_error');
            }
        };
        if (recorder.state === 'recording') {
            recorder.onstop = () => { finalize(); };
            recorder.stop();
        }
        else {
            await finalize();
        }
    }
    _renderDots() {
        if (!this._dotsEl)
            return;
        const multi = this._entities.length > 1;
        if (this._prevBtn)
            this._prevBtn.hidden = !multi;
        if (this._nextBtn)
            this._nextBtn.hidden = !multi;
        this._dotsEl.innerHTML = multi
            ? this._entities.map((_, i) => `<span class="hv-camera-carousel__dot${i === this._index ? ' is-active' : ''}" data-idx="${i}"></span>`).join('')
            : '';
        this._dotsEl.querySelectorAll('.hv-camera-carousel__dot').forEach((node) => {
            const dot = node;
            dot.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._setIndex(Number(dot.dataset.idx));
            });
        });
    }
    _setIndex(next, { force = false, syncAttr = true } = {}) {
        if (!this._entities.length)
            return;
        let idx = next;
        if (idx < 0)
            idx = this._entities.length - 1;
        if (idx >= this._entities.length)
            idx = 0;
        if (!force && idx === this._index)
            return;
        this._index = idx;
        if (syncAttr) {
            const idxStr = String(idx);
            if (this.getAttribute('index') !== idxStr)
                this.setAttribute('index', idxStr);
        }
        this._caps = null;
        this._capsEntity = '';
        this._closeMenu();
        this._renderIndex();
    }
    _entityWebm(ent) {
        if (ent.webm != null)
            return ent.webm;
        return false;
    }
    _renderIndex() {
        const cur = this._current();
        if (!this._titleEl)
            return;
        if (!cur || !this._stage) {
            this._titleEl.textContent = '';
            return;
        }
        this._titleEl.textContent = cur.title || cur.entity_id;
        this._renderDots();
        if (this._menuBtn) {
            this._menuBtn.hidden = this._entityStreamConfig(cur).agora;
        }
        this._syncPreloadStreams();
        this._applyMicToCamera();
    }
}
if (!customElements.get('hv-camera-carousel')) {
    customElements.define('hv-camera-carousel', HyveCameraCarousel);
}
export { HyveCameraCarousel };
