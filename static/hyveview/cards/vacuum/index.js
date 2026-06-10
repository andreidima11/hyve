import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewVacuumCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';
const SHARED = '/static/hyveview/cards/shared/shell.css';
export function register() {
    ensureCardStylesheet(SHARED);
    registerCardPackage({
        type: 'vacuum',
        element: HyveviewVacuumCard,
        styles: [`/static/hyveview/cards/vacuum/styles.css`],
        shell: { articleClass: 'hyve-dashboard-card--vacuum', clickable: false, editModeFlag: true },
    });
}
