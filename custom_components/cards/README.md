# Custom dashboard cards

Drop self-contained Hyveview card packages here (same idea as Home Assistant custom cards).

## Layout

```
custom_components/cards/my_card/
  manifest.json   # required
  index.js        # export function register()
  card.js         # custom element class
  styles.css      # optional
```

## manifest.json

```json
{
  "id": "my_card",
  "name": "My Card",
  "description": "Short picker blurb",
  "version": "0.1.0",
  "entry": "index.js",
  "styles": ["styles.css"],
  "hyve_card": true
}
```

## index.js

```javascript
import { registerCardPackage } from '/static/hyveview/core/card-package.js';
import { MyCard } from './card.js';

export function register() {
  registerCardPackage({
    type: 'my_card',
    element: MyCard,
    styles: ['/custom_components/cards/my_card/styles.css'],
    shell: { articleClass: 'hyve-dashboard-card', clickable: false },
    meta: { name: 'My Card', description: '…', icon: '✨' },
  });
}
```

Restart Hyve (or hard-refresh the dashboard). The frontend loads packages from `GET /api/dashboard/card-packages` and registers custom entries automatically.

Override directory: set `HYVE_CUSTOM_CARDS_DIR` to an absolute path or a path relative to the project root.
