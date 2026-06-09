# ADR 002: Folder-based integration components (Phase 2)

## Status

Accepted — Phase 2 complete: all bundled integrations live under `components/`.

## Context

Integrations previously lived as flat modules with no manifest, no user override path, and no colocation of client/translations.

## Decision

1. Bundled integrations move to `components/<domain>/` with `manifest.json` + `entity.py`.
2. User drop-ins live in `custom_components/` or `HYVE_CUSTOM_COMPONENTS_DIR`.
3. `IntegrationManager` discovers `components/` and `custom_components/` via manifest + `entity.py`.
4. Custom components override bundled domains with the same slug.

## Consequences

- New integrations should use the folder layout.
- Remaining providers migrate incrementally (Phase 3+).
- `demo_sensor` in `custom_components/` documents the pattern; gitignore allows that folder only.
