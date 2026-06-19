/**
 * <hv-card-weather-rich> — full weather card with stats + forecast.
 *
 * Layout (compact vs full) is decided once in setConfig() based on widget
 * span; subsequent setState() updates mutate the visible values (temp,
 * condition, stats, forecast tiles) in place without re-rendering layout.
 *
 * The outer article (rendered by dashboard.js) owns drag/edit and the
 * data-weather/data-weather-time/data-weather-rows attributes that drive
 * CSS theming; the card mirrors weather attrs back onto the parent.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

const DAY_NAMES = ['Dum', 'Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm'];
const MONTH_NAMES = ['ianuarie','februarie','martie','aprilie','mai','iunie','iulie','august','septembrie','octombrie','noiembrie','decembrie'];
const DAY_NAMES_FULL = ['duminică','luni','marți','miercuri','joi','vineri','sâmbătă'];

function _formatLongDate(d: Date) {
  if (!d || isNaN(d.getTime())) return '';
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}
function _formatTime(d: Date) {
  if (!d || isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class HyveviewWeatherRichCard extends HyveviewCardBase {
  protected _clockTimer: ReturnType<typeof setInterval> | null;
  protected _cpCityEl: HTMLElement | null;
  protected _cpDateEl: HTMLElement | null;
  protected _cpDescEl: HTMLElement | null;
  protected _cpForecastEl: HTMLElement | null;
  protected _cpHighEl: HTMLElement | null;
  protected _cpHumidityEl: HTMLElement | null;
  protected _cpIconEl: HTMLElement | null;
  protected _cpLowEl: HTMLElement | null;
  protected _cpTempEl: HTMLElement | null;
  protected _cpTimeEl: HTMLElement | null;
  protected _cpWindEl: HTMLElement | null;
  protected _forecastDays: number;
  protected _iconEl: HTMLElement | null;
  protected _isCompact: boolean;
  protected _showForecast: unknown;
  protected _tempEl: HTMLElement | null;
  protected _titleEl: HTMLElement | null;
  protected _weatherRows: number;
  static meta = {
    name: 'Weather (rich)',
    description: 'Full weather card with stats and multi-day forecast.',
    icon: '🌤️',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Weather entity', type: 'entity', domains: ['weather'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Optional — leave empty for no title' },
    ],
  };
  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '' };
  }

  constructor() {
    super();
    this._isCompact = false;
    this._forecastDays = 4;
    this._weatherRows = 1;
    // Compact slots:
    this._tempEl = null;
    this._titleEl = null;
    this._iconEl = null;
    // CodePen-style slots:
    this._cpCityEl = null;
    this._cpDateEl = null;
    this._cpTimeEl = null;
    this._cpIconEl = null;
    this._cpTempEl = null;
    this._cpDescEl = null;
    this._cpHumidityEl = null;
    this._cpWindEl = null;
    this._cpHighEl = null;
    this._cpLowEl = null;
    this._cpForecastEl = null;
    this._clockTimer = null;
  }

  disconnectedCallback() {
    if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
  }

  setConfig(widget: CardWidget | null | undefined) {
    this._config = widget || {};
    this._render();
    this._applyState();
  }

  setState(entity: HyveviewEntityState | null) {
    if (!entity) return;
    const w = (this._config || {}) as CardWidget;
    if (entity.entity_id && entity.entity_id !== w.entity_id) return;
    w.current_state = entity.state;
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyState();
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const spanRaw = (w._span && typeof w._span === 'object' ? w._span : { row: 1, col: 1 }) as import('../../types/widget.js').HyveviewWidgetSpan;
    const span = { row: spanRaw.row ?? 1, col: spanRaw.col ?? 1 };
    this._weatherRows = Math.min(Math.max(span.row, 1), 8);
    this._isCompact = span.row <= 1;
    this._showForecast = span.row >= 3;
    // 2 forecast tiles fit narrow cards; 4 for normal/wide.
    this._forecastDays = span.col >= 6 ? 4 : (span.col >= 4 ? 3 : 2);

    const titleFull = widgetTitle(w);
    const titleClass = titleFull ? 'hyve-dashboard-card__title' : 'hyve-dashboard-card__title hidden';
    const cityClass = titleFull ? 'hv-cp-weather__city' : 'hv-cp-weather__city hidden';

    if (this._isCompact) {
      const backdrop = `
        <div class="hyve-dashboard-card__weather-bg" aria-hidden="true">
          <span class="hyve-dashboard-card__weather-rain hyve-dashboard-card__weather-rain--far"></span>
          <span class="hyve-dashboard-card__weather-rain hyve-dashboard-card__weather-rain--near"></span>
          <span class="hyve-dashboard-card__weather-rain hyve-dashboard-card__weather-rain--mist"></span>
        </div>`;
      this.innerHTML = `
        ${backdrop}
        <div class="hyve-dashboard-card__weather-compact">
          <i class="hyve-dashboard-card__weather-icon fas fa-cloud" data-icon></i>
          <div class="hyve-dashboard-card__weather-compact-body">
            <div class="hyve-dashboard-card__weather-temp" data-temp>—</div>
            <div class="${titleClass}" data-title>${escape(titleFull)}</div>
          </div>
        </div>
      `;
      this._tempEl = this.querySelector('[data-temp]');
      this._titleEl = this.querySelector('[data-title]');
      this._iconEl = this.querySelector('[data-icon]');
      if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
      return;
    }

    // CodePen-style rich layout.
    const tilesHTML = this._showForecast ? Array.from({ length: this._forecastDays }, (_, i) => `
      <div class="hv-cp-weather__day" data-day="${i + 1}">
        <div class="hv-cp-weather__day-main">
          <p class="hv-cp-weather__day-name" data-day-name>—</p>
          <div class="hv-cp-weather__day-row">
            <h5 class="hv-cp-weather__day-temp" data-day-temp>°</h5>
            <i class="hv-cp-weather__day-icon fas fa-cloud" data-day-icon></i>
          </div>
        </div>
        <div class="hv-cp-weather__day-mm">
          <p class="hv-cp-weather__day-hi" data-day-hi>—</p>
          <p class="hv-cp-weather__day-lo" data-day-lo>—</p>
        </div>
      </div>`).join('') : '';

    this.innerHTML = `
      <div class="hv-cp-weather" data-weather-root>
        <div class="hv-cp-weather__current">
          <div class="hv-cp-weather__left">
            <h5 class="${cityClass}" data-cp-city>${escape(titleFull)}</h5>
            <h6 class="hv-cp-weather__date" data-cp-date></h6>
          </div>
          <div class="hv-cp-weather__center">
            <i class="hv-cp-weather__icon fas fa-cloud" data-cp-icon></i>
            <div class="hv-cp-weather__center-temp">
              <span class="hv-cp-weather__temp" data-cp-temp>—</span>
            </div>
          </div>
          <div class="hv-cp-weather__right">
            <h6><i class="fas fa-droplet" aria-hidden="true"></i><span data-cp-humidity>—</span>%</h6>
            <h6><i class="fas fa-wind" aria-hidden="true"></i><span data-cp-wind>—</span></h6>
          </div>
        </div>
        <div class="hv-cp-weather__forecast" data-cp-forecast>${tilesHTML}</div>
      </div>
    `;

    this._cpCityEl = this.querySelector('[data-cp-city]');
    this._cpDateEl = this.querySelector('[data-cp-date]');
    this._cpTimeEl = this.querySelector('[data-cp-time]');
    this._cpIconEl = this.querySelector('[data-cp-icon]');
    this._cpTempEl = this.querySelector('[data-cp-temp]');
    this._cpDescEl = this.querySelector('[data-cp-desc]');
    this._cpHumidityEl = this.querySelector('[data-cp-humidity]');
    this._cpWindEl = this.querySelector('[data-cp-wind]');
    this._cpHighEl = this.querySelector('[data-cp-high]');
    this._cpLowEl = this.querySelector('[data-cp-low]');
    this._cpForecastEl = this.querySelector('[data-cp-forecast]');

    this._tickClock();
    if (this._clockTimer) clearInterval(this._clockTimer);
    this._clockTimer = setInterval(() => this._tickClock(), 1000);
  }

  _tickClock() {
    const now = new Date();
    if (this._cpDateEl) this._cpDateEl.textContent = _formatLongDate(now);
    if (this._cpTimeEl) this._cpTimeEl.textContent = _formatTime(now);
  }

  _applyState() {
    const w = (this._config || {}) as CardWidget;
    const attrs = (w.attributes && typeof w.attributes === 'object' ? w.attributes : {}) as Record<string, unknown>;
    const cond = String(w.current_state || '');
    const tempRaw = attrs.temperature as number | undefined;
    const tempStr = tempRaw != null ? `${Math.round(Number(tempRaw))}°` : '—';
    const isNight = typeof host.weatherIsNight === 'function' ? host.weatherIsNight(attrs) : false;
    const variant = typeof host.weatherVariant === 'function' ? host.weatherVariant(cond) : 'clear';
    const iconCls = host.iconClass(
      typeof host.weatherIcon === 'function' ? host.weatherIcon(cond, isNight) : 'fas fa-cloud',
    );

    if (this._isCompact) {
      if (this._tempEl) this._tempEl.textContent = tempStr;
      if (this._iconEl) this._iconEl.className = 'hyve-dashboard-card__weather-icon ' + iconCls;
    } else {
      const titleFull = widgetTitle(w);
      if (this._cpCityEl) this._cpCityEl.textContent = titleFull;
      if (this._cpTempEl) this._cpTempEl.textContent = tempRaw != null ? `${Math.round(Number(tempRaw))}°` : '—';
      if (this._cpDescEl) this._cpDescEl.textContent = cond ? cond.charAt(0).toUpperCase() + cond.slice(1) : '';
      if (this._cpIconEl) this._cpIconEl.className = 'hv-cp-weather__icon ' + iconCls;
      if (this._cpHumidityEl) this._cpHumidityEl.textContent = attrs.humidity != null ? String(Math.round(attrs.humidity as number)) : '—';
      if (this._cpWindEl) {
        this._cpWindEl.textContent = attrs.wind_speed != null
          ? `${Math.round(Number(attrs.wind_speed))} ${attrs.wind_speed_unit || 'km/h'}`
          : '—';
      }
      const forecast = Array.isArray(attrs.forecast) ? attrs.forecast : [];
      const today = (forecast[0] || {}) as Record<string, unknown>;
      const hi = today.temperature ?? today.tmax ?? attrs.temperature_high ?? null;
      const lo = today.templow    ?? today.tmin ?? attrs.temperature_low  ?? null;
      if (this._cpHighEl) this._cpHighEl.textContent = hi != null ? String(Math.round(hi as number)) : '—';
      if (this._cpLowEl)  this._cpLowEl.textContent  = lo != null ? String(Math.round(Number(lo))) : '—';

      if (this._cpForecastEl) {
        // Skip today; show upcoming days in tiles.
        const upcoming = forecast.slice(1, 1 + this._forecastDays);
        const tiles = this._cpForecastEl.querySelectorAll('.hv-cp-weather__day');
        tiles.forEach((tile, idx) => {
          const day = upcoming[idx] as Record<string, unknown> | undefined;
          const nameEl = tile.querySelector('[data-day-name]');
          const tempEl = tile.querySelector('[data-day-temp]');
          const iconEl = tile.querySelector('[data-day-icon]');
          const hiEl = tile.querySelector('[data-day-hi]');
          const loEl = tile.querySelector('[data-day-lo]');
          if (!day) {
            if (nameEl) nameEl.textContent = '—';
            if (tempEl) tempEl.textContent = '—';
            if (iconEl) iconEl.className = 'hv-cp-weather__day-icon ' + host.iconClass('fas fa-cloud');
            if (hiEl) hiEl.textContent = '—';
            if (loEl) loEl.textContent = '—';
            (tile as HTMLElement).style.visibility = 'hidden';
            return;
          }
          (tile as HTMLElement).style.visibility = '';
          const dt = day.datetime ? new Date(String(day.datetime)) : null;
          const dayLabel = dt && !isNaN(dt.getTime()) ? DAY_NAMES[dt.getDay()] : (day.day || '·');
          const dayCond = String(day.condition || day.summary || '');
          const dayTempVal = day.temperature ?? day.tmax;
          const dayHi = day.temperature ?? day.tmax;
          const dayLo = day.templow ?? day.tmin;
          const dayIcon = host.iconClass(
            typeof host.weatherIcon === 'function' ? host.weatherIcon(dayCond, false) : 'fas fa-cloud',
          );
          if (nameEl) nameEl.textContent = String(dayLabel);
          if (tempEl) tempEl.textContent = dayTempVal != null ? String(Math.round(dayTempVal as number)) : '—';
          if (iconEl) iconEl.className = 'hv-cp-weather__day-icon ' + dayIcon;
          if (hiEl) hiEl.textContent = dayHi != null ? String(Math.round(dayHi as number)) : '—';
          if (loEl) loEl.textContent = dayLo != null ? String(Math.round(dayLo as number)) : '—';
        });
      }
    }

    const available = w.available !== false;
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-on', 'true');
      article.setAttribute('data-unavailable', available ? 'false' : 'true');
      article.setAttribute('data-weather', variant);
      article.setAttribute('data-weather-time', isNight ? 'night' : 'day');
      article.setAttribute('data-weather-rows', String(this._weatherRows));
    }
  }
}
