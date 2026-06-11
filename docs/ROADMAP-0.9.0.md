# Hyve 0.9.0 roadmap

**Status:** complete  
**Released:** `0.9.0`  
**Theme:** platform maturity + visible UX polish

## Delivered in 0.9.0

| # | Item | Notes |
|---|------|-------|
| 1 | `ui_catalog.json` load path fix | `core/ui_catalog.py` → repo root |
| 2 | Catalog i18n | `title_key`, `description_key`, EN/RO strings |
| 3 | `CHANGELOG.md` + doc hygiene | ARCHITECTURE, CARDS updated for `components/` |
| 4 | Phase 6 policy | Alembic-only schema changes documented |
| 5 | Config entries for add-on sync | No `config.json` dual-write from add-ons |
| 6 | Mobile dashboard reorder | Array-index order + `/reorder` API |
| 7 | Integration config modal | Catalog API for title/icon/image (no hardcoded maps) |

## Deferred to 0.9.x / 0.10

- Per-user default dashboard page (proposal C)
- Remove dashboard legacy modals (`widget_legacy_edit`, `widget_add_modal`)
- Drop `integrations/shims/` (comfyui, forge)
- Minimal Playwright or Vitest smoke in CI
- Schema-driven integration config panels (full HTML replacement)
