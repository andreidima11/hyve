import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewNumberCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';
const STYLES = '/static/hyveview/cards/number/styles.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'number',
    hidden: true,
    element: HyveviewNumberCard,
    styles: [STYLES],
    shell: {
      articleClass: 'hyve-dashboard-card--number',
      clickable: false,
      editModeFlag: true,
      trackUnavailable: true,
    },
  });
}
