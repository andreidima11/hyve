import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewLawnMowerCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';
const SHARED = '/static/hyveview/cards/shared/shell.css';
export function register() {
    ensureCardStylesheet(SHARED);
    registerCardPackage({
        type: 'lawn_mower',
        element: HyveviewLawnMowerCard,
        styles: [`/static/hyveview/cards/lawn_mower/styles.css`],
        shell: { articleClass: 'hyve-dashboard-card--lawn-mower', clickable: false, editModeFlag: true },
    });
}
