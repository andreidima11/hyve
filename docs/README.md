# Hyve documentation

Documentation for humans and for AI coding agents (Cursor, Copilot, etc.).

## For AI agents

Start here:

1. **[AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md)** — how to implement features safely
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — repo map and data flow

Root shortcut: [../AGENTS.md](../AGENTS.md)

## Features & platform

| Document | Topic |
|----------|--------|
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | Entity integrations (providers, config entries, sync) |
| [CARDS_AND_INTEGRATIONS.md](CARDS_AND_INTEGRATIONS.md) | Dashboard cards, `ui_catalog.json`, settings integrations |
| [dashboard_ha_alignment.md](dashboard_ha_alignment.md) | Dashboard ↔ Home Assistant concepts |
| [adr/001-phase1-platform.md](adr/001-phase1-platform.md) | Phase 1 refactor decisions |

## UI

| Document | Topic |
|----------|--------|
| [../static/css/themes/README.md](../static/css/themes/README.md) | Theme files (`*.css` + `*.json`) |
| [../.cursor/rules/ui-design-consistency.mdc](../.cursor/rules/ui-design-consistency.mdc) | Dropdowns, CSS variables, modals |

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
