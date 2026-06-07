# Hyve documentation

Developer and operator documentation for Hyve.

## Architecture & platform

| Document | Topic |
|----------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Repo map, data flow, frontend/backend layout |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | Entity integrations (providers, config entries, sync) |
| [CARDS_AND_INTEGRATIONS.md](CARDS_AND_INTEGRATIONS.md) | Dashboard cards, `ui_catalog.json`, settings integrations |
| [ENTITY_CONTRACT.md](ENTITY_CONTRACT.md) | Entity payload shape for UI and AI |
| [dashboard_ha_alignment.md](dashboard_ha_alignment.md) | Dashboard ↔ Home Assistant concepts |

## Architecture decision records

| ADR | Topic |
|-----|--------|
| [adr/001-phase1-platform.md](adr/001-phase1-platform.md) | Phase 1 refactor |
| [adr/002-phase2-components.md](adr/002-phase2-components.md) | Components layout |
| [adr/003-phase3-extractors.md](adr/003-phase3-extractors.md) | Extractors |
| [adr/004-phase4-frontend-split.md](adr/004-phase4-frontend-split.md) | Frontend split |
| [adr/005-phase5-http-factory.md](adr/005-phase5-http-factory.md) | HTTP factory |
| [adr/006-phase6-alembic.md](adr/006-phase6-alembic.md) | Alembic migrations |

## UI

| Document | Topic |
|----------|--------|
| [../static/css/themes/README.md](../static/css/themes/README.md) | Theme files (`*.css` + `*.json`) |

## Add-ons (external services)

| Document | Topic |
|----------|--------|
| [../custom_addons/README.md](../custom_addons/README.md) | User-installed add-ons (`custom_addons/`) |
| [../addons/available/](../addons/available/) | Bundled add-on manifests (MQTT, Frigate, …) |

**Add-ons ≠ integrations.** Add-ons are optional services (Docker/binary). Integrations are entity sources synced into Hyve.

## Automations

| Document | Topic |
|----------|--------|
| [../automations/README.md](../automations/README.md) | YAML automations on disk |

## Local automation tooling

If you use AI coding assistants locally, keep playbooks in **`dev-local/`** at the repo root (gitignored). See the root [README.md](../README.md) — that folder is not part of the published repository.
