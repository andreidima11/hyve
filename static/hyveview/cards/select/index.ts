import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewSelectCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';
const STYLES = '/static/hyveview/cards/select/styles.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'select',
    hidden: true,
    element: HyveviewSelectCard,
    styles: [STYLES],
    shell: {
      articleClass: 'hyve-dashboard-card--select',
      clickable: false,
      editModeFlag: true,
      trackUnavailable: true,
    },
  });
}
