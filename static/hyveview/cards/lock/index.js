import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewLockCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'lock',
    element: HyveviewLockCard,
    styles: [],
    shell: { articleClass: 'hyve-dashboard-card--lock', clickable: false, editModeFlag: true },
  });
}
