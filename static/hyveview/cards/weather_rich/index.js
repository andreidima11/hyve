import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewWeatherRichCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';
const SHARED = '/static/hyveview/cards/shared/shell.css';
export function register() {
    ensureCardStylesheet(SHARED);
    registerCardPackage({
        type: 'weather_rich',
        element: HyveviewWeatherRichCard,
        styles: [`/static/hyveview/cards/weather_rich/styles.css`],
        shell: {
            articleClass: 'hyve-dashboard-card--weather-rich',
            clickable: false,
            spanCompact: { maxRow: 1, class: 'hyve-dashboard-card--weather-rich-compact' },
        },
    });
}
