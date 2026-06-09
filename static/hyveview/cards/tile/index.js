import { registerCardPackage } from '../../core/card-package.js';
import { HyveviewTileCard } from './card.js';
import { ensureCardStylesheet } from '../../core/card-styles.js';

const SHARED = '/static/hyveview/cards/shared/shell.css';

export function register() {
  ensureCardStylesheet(SHARED);
  registerAliases();
}

export function registerAliases() {
  const base = { element: HyveviewTileCard, styles: [], shell: { articleClass: 'hyve-dashboard-card', clickable: 'tile' } };
  registerCardPackage({ ...base, type: 'tile', meta: { name: 'Tile', description: 'Generic clickable tile.', icon: '🔘' } });
  registerCardPackage({ ...base, type: 'button', meta: { name: 'Button', description: 'Tap-to-trigger button for any entity.', icon: '🟢' }, getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: false }) });
  registerCardPackage({ ...base, type: 'switch', meta: { name: 'Switch', description: 'Toggle switch (on/off) with a slider thumb.', icon: '🎚️' }, getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: true }) });
  registerCardPackage({ ...base, type: 'scene', meta: { name: 'Scene', description: 'One-shot scene activator.', icon: '🎬' }, getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: false }) });
  registerCardPackage({ ...base, type: 'info', hidden: true, meta: { name: 'Info', description: 'Read-only info tile (no controls).', icon: 'ℹ️' }, getStubConfig: (eid) => ({ entity_id: eid || '', title: '', icon: '', color: '', switch_style: false }) });
}
