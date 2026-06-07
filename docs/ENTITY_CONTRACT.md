# Hyve entity contract

Platform contract for entity records produced by integration extractors and consumed by Hyveview cards.

## Core fields

| Field | Role |
|-------|------|
| `state` | Generic vocabulary shared across integrations (`docked`, `cleaning`, `idle`, `on`, `off`, …). Used for icons, automation triggers, and coarse UI grouping. |
| `attributes.status_key` | Stable snake_case key for localized display (`fully_charged`, `charging`, `cleaning`). Preferred source for UI labels. |
| `attributes.status` | Optional human-readable fallback (usually English legacy text from the vendor API). Used when no translation exists for `status_key`. |

## Display priority (vacuum card)

1. `t('hyveview.vacuum.status.' + status_key)` — core UI dictionary
2. `tVacuumStatus(attributes.status, state)` — legacy English alias map
3. Meta label derived from generic `state`

## Extractor guidance

Use `set_status_attrs()` from `integrations/entity_utils.py`:

```python
from integrations.entity_utils import set_status_attrs

set_status_attrs(attributes, key="fully_charged", label="Fully charged")
```

- Always set `status_key` when the integration knows the semantic status.
- Keep `status` as an English fallback for logs, debugging, and legacy clients.
- Prefer reusing existing `hyveview.vacuum.status.*` keys before introducing new ones.

## Component-specific labels

Integration-specific strings (config titles, sensor names) live in `components/<domain>/translations/{lang}.json` and are exposed via `GET /api/i18n/components` under the `components.<domain>.*` namespace.

See also [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md).
