/**
 * <hv-card-entity> — universal entity card (picker metadata + schema).
 * Runtime rendering resolves to sensor/tile/switch/number/etc. via entity_routing.
 */
import { HyveviewTileCard } from '../tile/card.js';

export class HyveviewEntityCard extends HyveviewTileCard {
  static meta = {
    name: 'Entity',
    description: 'Universal card — UI adapts automatically to the entity domain.',
    icon: '📦',
  };

  static schema = {
    fields: [
      { key: 'entity_id', label: 'Entity', type: 'entity', required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-bolt' },
      { key: 'color', label: 'Accent color', type: 'color' },
    ],
  };

  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '', icon: '', color: '' };
  }
}
