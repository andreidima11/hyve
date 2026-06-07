# ADR 004: Split `features.js` into feature modules (Phase 4)

## Status

Accepted — Phase 4 complete (`features.js` is a ~210-line facade).

## Context

`static/js/features.js` grew to 10k+ lines mixing smarthome devices, memory, automations, config, integrations UI, voice, and notifications. Smaller slices already exist (`features_sessions.js`, `features_areas.js`, etc.) but the main file remained a bottleneck for reviews and agent edits.

## Decision

1. Extract cohesive UI domains into `static/js/features_<domain>.js` ES modules.
2. Keep `features.js` as a **facade**: re-export public APIs so `app.js` and `ui.js` imports stay stable.
3. **Pilot:** smarthome / devices list → `features_smarthome.js` (~1650 lines).
4. Export `getIntegrationEntities()` for cross-module reads (automation entity picker fallback).
5. New UI code goes into new small files; avoid appending large blocks to `features.js`.

## Planned extractions (order)

| Module | Scope | Status |
|--------|--------|--------|
| `features_smarthome.js` | Device list, filters, live WS, aliases | Done |
| `features_automations.js` | Automation editor, blueprints | Done |
| `features_memory.js` | Memory table, log, extraction examples, ambient test | Done |
| `features_config.js` | Settings, integrations, notifications, addons, voice | Done |

## Consequences

- `features.js` shrinks incrementally; cache-bust query param on `app.js` import when splitting.
- Vite bundler is **not** required yet — native ES modules + existing static serving suffice.
- Tests: no JS unit suite today; manual smoke on Devices tab + automation entity picker after each split.
