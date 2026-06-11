# Hyve 0.9.1 roadmap

**Status:** complete (ready for 0.9.1 release)  
**Theme:** cleanup + test confidence

## Scope

| # | Item | Status |
|---|------|--------|
| 1 | Drop `integrations/shims/` (import `components/` directly) | done |
| 2 | Per-user default dashboard page — API tests + doc sync | done |
| 3 | CI smoke script (`scripts/smoke_test.py`) | done |
| 4 | Remove legacy dashboard modals (`widget_add_modal`, `widget_legacy_edit`) | done |
| 5 | Schema-driven integration config panels (remove legacy modal JS/HTML) | done |

## Done in 0.9.0 (reference)

See [ROADMAP-0.9.0.md](ROADMAP-0.9.0.md).

## Notes

- Per-user default page **backend + page modal UI** already shipped in 0.9.0; 0.9.1 adds regression tests and updates [dashboard_layout_design.md](dashboard_layout_design.md).
- Add/edit cards use Hyveview `hvOpenEditor` via `add_picker.ts` and `widget_editor_bridge.ts` only.
