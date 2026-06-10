import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewWeatherSimpleCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';
const SHARED = '/static/hyveview/cards/shared/shell.css';
export function register() {
    ensureCardStylesheet(SHARED);
    registerCardPackage({
        type: 'weather',
        element: HyveviewWeatherSimpleCard,
        styles: [],
        shell: {
            articleClass: 'hyve-dashboard-card',
            clickable: false,
            trackUnavailable: true,
            dataOn: 'true',
        },
    });
}
