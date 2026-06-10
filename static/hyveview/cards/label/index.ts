import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewLabelCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerCardPackage({
    type: 'label',
    element: HyveviewLabelCard,
    styles: [],
    shell: {
      kind: 'label',
      showBackgroundKey: 'show_background',
    },
  });
}
