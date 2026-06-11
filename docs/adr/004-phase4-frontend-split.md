# ADR 004: Split `features.js` into feature modules (Phase 4)

## Status

Accepted — complete. `features.js` / `features.ts` are thin facades; each `features_<domain>.ts` re-exports from `static/js/<domain>/` submodules.

## Context

`static/js/features.js` grew to 10k+ lines mixing smarthome devices, memory, automations, config, integrations UI, voice, and notifications. Smaller slices already exist (`features_sessions.js`, `features_areas.js`, etc.) but the main file remained a bottleneck for reviews and agent edits.

## Decision

1. Extract cohesive UI domains into `static/js/features_<domain>.js` ES modules.
2. Keep `features.js` as a **facade**: re-export public APIs so `app.js` and `ui.js` imports stay stable.
3. **Pilot:** smarthome / devices list → `features_smarthome.js` (~1650 lines).
4. Export `getIntegrationEntities()` for cross-module reads (automation entity picker fallback).
5. New UI code goes into new small files; avoid appending large blocks to `features.js`.

## Extractions

| Facade | Submodule folder | Scope |
|--------|------------------|--------|
| `features_smarthome` | `smarthome/` | Device list, filters, live WS, modals |
| `features_automations` | `automations/` | Automation editor, blueprints |
| `features_memory` | `memory/` | Memory table, log, extraction examples |
| `features_config` | `config/` | Settings core, profiles, voice (+ re-export tabs) |
| `features_integrations_settings` | `integrations/` | Catalog, config entries, entity browser |
| `features_notifications_config` | `notifications_config/` | Notifications tab |
| `features_addons_settings` | `addons_settings/` | Settings add-ons + updates hub |
| `features_apps` | `apps/` | Apps / addon process lifecycle |
| `features_derived` | `derived/` | Derived entity modal |
| `features_scenes` | `scenes/` | Scenes list + editor |
| `features_areas` | `areas/` | Areas / rooms UI |
| `features_sessions` | `sessions/` | Chat session sidebar |
| `features_admin_skills` | `admin_skills/` | Admin users + skills |
| `features_custom_selects` | `custom_selects/` | Custom dropdown / native `<select>` upgrade |

Regenerate scripts live under `scripts/split_features_*.py` (source of truth: `git show HEAD:static/js/features_<name>.ts` at split time).

### Submodule splits (second pass)

| Domain folder | Files | Script |
|---------------|-------|--------|
| `smarthome/` | `device_state.ts`, `device_core.ts`, `devices.ts`; `modal_alias.ts`, `modal_detail.ts`, `modal_add_devices.ts`, `modals.ts` | `split_smarthome_devices.py`, `split_smarthome_modals.py` |
| `scenes/` | `list.ts`, `editor.ts`, `page.ts` | `split_scenes_page.py` |
| `areas/` | `list.ts`, `editor.ts`, `page.ts` | `split_areas_page.py` |
| `memory/` | `log.ts`, `facts.ts`, `page.ts` | `split_memory_page.py` |
| `apps/` | `state.ts`, `poll.ts`, `logs.ts`, `core.ts`, `lifecycle.ts`, `page.ts` | `split_apps_page.py` |
| `derived/` | `form.ts`, `modal.ts`, `page.ts` | `split_derived_page.py` |

Run feature scripts **before** submodule scripts (submodule scripts read full `page.ts` / `devices.ts` from disk). One-shot:

```bash
python3 scripts/regenerate_frontend_splits.py && npm run js:build
```

`notifications_config/page.ts` stays monolithic (autosave + circular deps).

## Consequences

- `features.js` shrinks incrementally; cache-bust query param on `app.js` import when splitting.
- Vite bundler is **not** required yet — native ES modules + existing static serving suffice.
- Tests: no JS unit suite today; manual smoke on Devices tab + automation entity picker after each split.
