/**
 * <hv-card-climate> — wrapper around the legacy climate renderer.
 *
 * Climate cards are the most complex card type: multi-entity slides, swipe
 * gestures, HVAC mode menu, target temperature stepper. All inline event
 * handlers (`adjustDashboardClimateTemperature`, `setDashboardClimateMode`,
 * `*ClimateSwipe`, …) remain on the window object — this element does NOT
 * try to re-own them. The outer article element keeps its swipe handlers.
 *
 * Strategy:
 *   - setConfig(widget) builds the full inner markup once (same string the
 *     legacy `_renderClimateCard` used to build, minus the outer <article>).
 *     The dashboard still calls setConfig again when the active slide or
 *     entity list changes — that path is unchanged.
 *   - setState(entity) skips the full rebuild and patches only the cheap
 *     fields that move every WS tick: current temperature, target temp,
 *     HVAC mode label, mode menu "active" markers, data-on / data-unavailable
 *     mirrors on the parent article.
 *
 * Result: typical state updates (temperature changes every few seconds)
 * stop triggering a full innerHTML rebuild, while slide swipes and config
 * edits still go through the legacy code path.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host } from '../../host.js';

export class HyveviewClimateCard extends HyveviewCardBase {
  static meta = {
    name: 'Climate',
    description: 'Multi-entity climate control with HVAC modes and setpoints.',
    icon: '🌡️',
  };
  static schema = {
    fields: [
      { key: 'entities', label: 'Climate entities', type: 'multi_entity', domains: ['climate'], required: true,
        hint: 'Add one row per zone. Title/subtitle override the auto-generated labels.' },
      { key: 'title', label: 'Card title', type: 'string', placeholder: 'Optional' },
    ],
  };
  static getStubConfig() {
    return { entities: [], title: '' };
  }

  setConfig(widget) {
    this._config = widget || {};
    // Dashboard passes the rendered inner HTML via widget._climateInner.
    // We don't try to recompute it here because the rendering depends on
    // many helpers (_dashboardClimateEntities, _climateOptions, swipe motion
    // state) that live in dashboard.js and would require a large port.
    const inner = widget && widget._climateInner;
    if (typeof inner === 'string') {
      this.innerHTML = inner;
    }
    this._cacheSlots();
    this._mirrorParent();
  }

  setState(entity) {
    if (!entity) return;
    const w = this._config || {};
    const activeId = String(w._climateActiveEntityId || w.entity_id || '');
    if (entity.entity_id && activeId && entity.entity_id !== activeId) return;
    // Merge into the cached active-entity snapshot so subsequent setConfig
    // calls (e.g. on slide change) see the latest values.
    w._climateActiveEntity = w._climateActiveEntity || {};
    w._climateActiveEntity.attributes = {
      ...(w._climateActiveEntity.attributes || {}),
      ...(entity.attributes || {}),
    };
    if (entity.state !== undefined) w._climateActiveEntity.current_state = entity.state;
    if (entity.available !== undefined) w._climateActiveEntity.available = entity.available;
    this._patchFields(w._climateActiveEntity);
    w.available = entity.available !== false ? w.available : false;
    this._mirrorParent();
  }

  _cacheSlots() {
    // Every zone slide carries the same data-climate-* hooks, so scope the
    // patch targets to the currently active slide (carousel) and fall back to
    // the element root for single-zone cards.
    const scope = this.querySelector('.hyve-dashboard-card__climate-slide[data-active-slide="true"]') || this;
    this._currentEl = scope.querySelector('[data-climate-current]');
    this._currentUnitEl = scope.querySelector('[data-climate-current-unit]');
    this._targetEl = scope.querySelector('[data-climate-target]');
    this._modeLabelEl = scope.querySelector('[data-climate-mode-label]');
    this._stateLineEl = scope.querySelector('[data-climate-stateline]');
    this._modeOptions = scope.querySelectorAll('[data-climate-mode-option]');
  }

  /**
   * Carousel slide change without a full dashboard re-render. The dashboard
   * translates the track itself; here we flip the active-slide markers, point
   * setState() at the new zone, re-cache the patch targets and refresh them.
   */
  setActiveSlide(index, entity) {
    const w = this._config || {};
    if (entity) {
      w._climateActiveEntity = entity;
      w._climateActiveEntityId = entity.entity_id || w._climateActiveEntityId || '';
    }
    this.querySelectorAll('.hyve-dashboard-card__climate-slide').forEach(slide => {
      const isActive = Number(slide.dataset.slideIndex) === Number(index);
      slide.setAttribute('data-active-slide', isActive ? 'true' : 'false');
      if (isActive) slide.removeAttribute('aria-hidden');
      else slide.setAttribute('aria-hidden', 'true');
    });
    this.querySelectorAll('[data-climate-pip]').forEach(pip => {
      const isActive = Number(pip.dataset.climatePip) === Number(index);
      pip.setAttribute('data-active', isActive ? 'true' : 'false');
      pip.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    this._cacheSlots();
    this._patchFields(w._climateActiveEntity);
    this._mirrorParent();
  }

  _patchFields(entity) {
    if (!entity) return;
    const attrs = entity.attributes || {};
    const escape = host.escape;

    if (this._currentEl) {
      const current = attrs.current_temperature != null
        ? attrs.current_temperature
        : (Number.isFinite(parseFloat(entity.current_state)) ? parseFloat(entity.current_state) : null);
      this._currentEl.textContent = current != null ? String(current) : '—';
      if (this._currentUnitEl) {
        this._currentUnitEl.style.display = current != null ? '' : 'none';
      }
    }

    if (this._targetEl) {
      const target = attrs.temperature != null
        ? attrs.temperature
        : (attrs.target_temperature != null ? attrs.target_temperature : null);
      const unit = this._targetEl.dataset.climateUnit || '°C';
      this._targetEl.textContent = (target != null ? String(target) : '—') + unit;
    }

    const mode = String(attrs.hvac_mode || entity.current_state || 'off').toLowerCase();
    if (this._modeLabelEl) {
      const label = this._modeLabelEl.dataset.climateModeMap
        ? (JSON.parse(this._modeLabelEl.dataset.climateModeMap)[mode] || mode)
        : mode;
      this._modeLabelEl.textContent = label;
    }

    if (this._modeOptions && this._modeOptions.length) {
      this._modeOptions.forEach(btn => {
        const v = String(btn.dataset.climateModeValue || '').toLowerCase();
        btn.setAttribute('data-active', v === mode ? 'true' : 'false');
        const check = btn.querySelector('.fa-check');
        if (v === mode && !check) {
          const i = document.createElement('i');
          i.className = 'fas fa-check';
          btn.appendChild(i);
        } else if (v !== mode && check) {
          check.remove();
        }
      });
    }
  }

  _mirrorParent() {
    const w = this._config || {};
    const entity = w._climateActiveEntity || {};
    const attrs = entity.attributes || {};
    const mode = String(attrs.hvac_mode || entity.current_state || 'off').toLowerCase();
    const stateOn = typeof host.stateOn === 'function' ? host.stateOn : () => false;
    const on = stateOn(mode) || mode === 'auto';
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (!article) return;
    article.setAttribute('data-on', on ? 'true' : 'false');
    const unavailable = (w.available === false) || (entity.available === false);
    article.setAttribute('data-unavailable', unavailable ? 'true' : 'false');
  }
}
