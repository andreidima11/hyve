# Hyve architecture

High-level map of how the application is structured today and where it is heading.

---

## Product layers

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (ES modules)                                       │
│  app.js → features | dashboard | chat | lang                │
│  hyveview/ (custom elements for dashboard cards)            │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / WSS
┌──────────────────────────▼──────────────────────────────────┐
│  FastAPI (core/http/app.py → routers/*; main.py entrypoint) │
│  auth · integrations · dashboard · cameras · automations    │
└──────────┬─────────────────────────────┬────────────────────┘
           │                             │
┌──────────▼──────────┐       ┌──────────▼──────────┐
│  Integration layer  │       │  Brain (AI)         │
│  providers · store  │       │  cortex · memory ·    │
│  config entries     │       │  toolbox · channels   │
└──────────┬──────────┘       └─────────────────────┘
           │
┌──────────▼──────────────────────────────────────────┐
│  SQLite · config.json · automations/*.yaml · files  │
└─────────────────────────────────────────────────────┘
```

Hyve is **one process**: web UI, API, sync loops, scheduler, and AI agent share the same Python event loop.

---

## Request paths (common flows)

### Load smarthome devices

```
Browser: features.js → GET /api/integrations/all-entities
Router:  routers/integrations.py
Store:   addons/entity_store.py (cached payloads per store_key)
Source:  IntegrationManager → provider.fetch_entities → extract_entities
Live:    WS /api/integrations/ws/live (entity state patches)
```

### Configure integration (HA-style)

```
Browser: features.js → GET /api/integrations/{slug}/schema
         → POST/PATCH /api/integrations/{slug}/entries
         → POST .../entries/test
Router:  routers/integrations.py
DB:      integrations/config_entries.py (secrets encrypted)
Boot:    integrations/loader.py wires fetcher + sync loop on save
```

### Dashboard render

```
Browser: dashboard.js → GET /api/dashboard/...
         → WS /api/dashboard/ws/live
Cards:   hyveview bridge mounts <hv-card-*> custom elements
Entities: shared available-entities cache + live WS
```

### Chat message

```
Browser: chat.js → POST /api/chat (SSE/stream)
Core:    routers/chat_web.py → brain/cortex.py
Tools:   brain/toolbox.py → device control, web, memory, skills
```

---

## Integration platform (entity sources)

### Discovery

`integrations/loader.py` scans `integrations/providers/*.py`, loads each module, registers every `BaseEntity` subclass by `slug`.

### Config entry lifecycle

```
User fills form (CONFIG_SCHEMA)
    → POST /api/integrations/{slug}/entries
    → config_entries.create_entry()  (SQLite)
    → loader wires entity_store.register_fetcher(store_key, ...)
    → entity_store.do_sync(store_key)  + start_sync_loop()
```

`store_key` = `{slug}` (legacy) or `{slug}:{entry_id[:8]}` (multi-instance).

### Provider contract (`integrations/base.py`)

| Method / attr | Role |
|---------------|------|
| `slug`, `label`, `CONFIG_SCHEMA` | Identity + declarative form |
| `SUPPORTS_MULTIPLE` | Multiple accounts/instances |
| `fetch_entities()` | Raw payload from upstream |
| `extract_entities()` | Flat list for UI/AI |
| `async_test_connection()` | Optional pre-save test |
| `async_validate_entry()` | Optional validation/OAuth exchange |
| `control_entity()` | Optional device control |

### Entity store (`addons/entity_store.py`)

- Background sync loops per `store_key`
- `scan_interval` from config entry (manual sync throttled — `SyncThrottledError`)
- Keeps last-good payload on timeout/error
- Overrides: custom names, aliases (`integration_entity_overrides` table)

### Legacy (avoid for new work)

| Legacy piece | Status |
|--------------|--------|
| `config.json[slug]` for credentials | Inert / migration only |
| `main.py` lifespan Pago/Fusion bootstrap | Skip when config entries exist |
| `routers/pago.py`, `routers/fusion_solar.py` | Duplicate APIs — deprecate |
| `integrations/extractors.py` | Shared extractors — move into providers |
| Root `*_client.py` files | Move next to provider |

---

## UI metadata (`ui_catalog.json`)

Two arrays:

### `integrations[]`

Settings page rows: icon, accent, `title_key`, `admin_only`, `order`.  
Does **not** replace a provider — it only controls presentation for config sections.

### `dashboard_cards[]`

Card picker presets: `id`, `renderer`, `entity_filter`, `default_size`, …

Server normalizes via `ui_catalog.py`; APIs expose catalog to frontend.

---

## Add-on system (external services)

Separate from entity integrations.

```
addons/available/<slug>/manifest.json   # bundled
custom_addons/<slug>/manifest.json      # user (HYVE_CUSTOM_ADDONS_DIR)
addons/registry.py                      # discovery + install metadata
routers/addons.py                       # API
```

Add-ons may run processes (MQTT, Zigbee2MQTT); integrations **consume** entities they expose (e.g. `mosquitto` provider reads MQTT).

---

## Frontend architecture

### Boot

`templates/index.html` → loads `static/js/app.js` (module).

`app.js`:

- Auth check, theme init (`theme-registry.js`)
- Tab routing (`#/dashboard`, `#/config`, …)
- Lazy `import()` for heavy modules

### Key files

| File | Lines (approx) | Notes |
|------|----------------|-------|
| `features.js` | ~210 (facade) | Re-exports only |
| `features_smarthome.js` | ~1.6k | Devices list, filters, live WS |
| `features_automations.js` | ~2.4k | Automation editor, blueprints |
| `features_memory.js` | ~420 | Memory, log, extraction examples |
| `features_config.js` | ~2.4k | Settings core, profiles, voice (facade) |
| `features_integrations_settings.js` | ~2.3k | Integrations catalog, entries, entity browser |
| `features_notifications_config.js` | ~360 | Notifications tab |
| `features_addons_settings.js` | ~560 | Settings add-ons + updates hub |
| `features_custom_selects.js` | ~245 | Custom dropdown / native select upgrade |
| `dashboard.js` + `dashboard/*.js` | ~8k + slices | Grid + Hyveview bridge (split in progress) |
| `chat.js` | 2.8k | Streaming UI |
| `hyveview/*` | — | Preferred new card implementations |

### Hyveview

Custom elements (`<hv-card-tile>`, …) mounted inside legacy grid `<article>` shells.  
Bridge: `static/hyveview/bridge.js` — registers types, patches entity state without full grid re-render.

---

## Brain / automations

### Automations

- Declarative YAML on disk
- Validator, linter, trace, dry-run in `automations/` package
- Router: `routers/automations_reminders.py`
- Best-tested area of the codebase

### Brain

- `cortex.py` — agent orchestration
- `toolbox.py` — callable tools (devices, search, memory, …)
- Memory pipeline — extraction, dedup, recall (`routers/memory.py`)
- Optional channels: WhatsApp (WAHA), Assist proxy

Keep **device state reads** going through integration entity APIs, not one-off HTTP in tools.

---

## Auth & tokens

| Mechanism | Use |
|-----------|-----|
| JWT access + refresh | `Authorization: Bearer` via `api.js` |
| SSE exchange token | EventSource, some WS |
| Session storage | `localStorage` `hyve_token`, `hyve_refresh_token` |

**Known issue:** camera stream/snapshot accepts JWT in query param — prefer migrating to short-lived tokens.

---

## Data storage

| Store | Contents |
|-------|----------|
| SQLite (`hyve.db`) | Users, config entries, entity overrides, tokens revoked |
| `config.json` | Global settings (LLM, WAHA, paths) — not per-integration secrets |
| `dashboards/` | Dashboard JSON/YAML layouts |
| `automations/` | User automation YAML |
| `sessions/` | Chat session files |
| `logs/` | Application logs |

Schema migrations: Alembic (`migrations/`, `alembic upgrade head` at startup via `core/http/startup_migrations.py`). New columns → new revision in `migrations/versions/`.

---

## Planned structure (target)

Home Assistant–inspired layout (**Phase 2 in progress**):

```
core/                    # platform: auth, entity store, HTTP factory
components/<domain>/     # bundled integration folders (manifest.json) — loader active
custom_components/       # user drop-in integrations — HYVE_CUSTOM_COMPONENTS_DIR
frontend/src/            # Vite-built modules
```

**Migrated to `components/`:** all bundled entity integrations. Extraction logic for Pago, E.ON, Ariston, Open-Meteo, Midea, Rețele Electrice, FusionSolar lives in each component's `extract.py`. `integrations/extractors.py` is a thin compatibility layer.

**Rule for AI agents:** new bundled integrations go in `components/<domain>/`. Legacy flat files in `integrations/providers/` still load when no component folder exists for that slug.

See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) §0 and [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) for workflows.

---

## Related docs

- [AI_AGENT_GUIDE.md](AI_AGENT_GUIDE.md) — how to implement changes
- [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) — provider authoring
- [CARDS_AND_INTEGRATIONS.md](CARDS_AND_INTEGRATIONS.md) — catalog + cards
- [../AGENTS.md](../AGENTS.md) — entry point for coding agents
