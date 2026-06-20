# Cards And Integrations

This document defines how new integrations and dashboard cards must be added in Hyve.

The rule is simple:

- do not hardcode new rows in the integrations settings page
- do not hardcode new card types in dashboard selects or editor conditionals unless you are adding a truly new renderer
- prefer metadata and registries over ad-hoc template edits

## Design Goals

- one source of truth for UI metadata
- dynamic discovery for backend integrations
- schema-driven UI for lists and selectors
- preserve a small set of reusable renderers
- allow future user-defined presets without application code changes

## Current Sources Of Truth

### Integrations

- backend integration discovery lives in [integrations/loader.py](integrations/loader.py)
- provider contract lives in [integrations/base.py](integrations/base.py)
- UI metadata lives in [ui_catalog.json](ui_catalog.json)
- server-side catalog normalization lives in [ui_catalog.py](ui_catalog.py)
- public catalog API lives in [routers/integrations.py](routers/integrations.py)
- settings list rendering lives in [static/js/features.js](static/js/features.js)

### Dashboard cards

- card preset metadata lives in [ui_catalog.json](ui_catalog.json)
- server-side card catalog API lives in [routers/dashboard.py](routers/dashboard.py)
- dashboard editor and renderer selection live in [static/js/dashboard.js](static/js/dashboard.js) (facade) and [static/js/dashboard/](static/js/dashboard/) modules
- card renderers register via [static/js/dashboard/cards/register.js](static/js/dashboard/cards/register.js) and [static/js/dashboard/card_registry.js](static/js/dashboard/card_registry.js)
- shared visual styling lives in [static/css/components.css](static/css/components.css)

## Integration Architecture

Every integration should be split into two concerns:

1. backend provider logic
2. UI metadata and configuration panel wiring

### Backend provider requirements

Create a component in `components/<slug>/entity.py` that subclasses `BaseEntity` (see `manifest.json`).

It should own:

- `slug`
- `label`
- `icon`
- `color`
- `supports_sync`
- `fetch_entities()`
- `extract_entities()`
- optionally `list_entities()` when the provider should not use the generic synced-store path

Rules:

- all hardware or upstream communication stays inside the provider or the provider's dedicated client
- no dashboard-specific logic inside the provider
- no UI row generation inside templates
- no manual registration in `main.py`

If discovery is correct, `IntegrationManager` should pick up the provider automatically.

### Integration UI requirements

To make an integration appear in Settings, add or update its metadata entry in [ui_catalog.json](ui_catalog.json).

Supported fields include:

- `slug`
- `config_key`
- `config_panel_id` (legacy alias; UI is schema-driven)
- `toggle_input_id`
- `toggle_slug`
- `label`
- `title_key`
- `description_key` (preferred; falls back to `description`)
- `description` (legacy fallback label)

**i18n:** `title_key` and `description_key` must resolve via `t()` after bundle load. Prefer `components.<slug>.catalog_desc` for descriptions (set `catalog_desc` in `components/<slug>/translations/`). Default `description_key` from the server is `components.<slug>.catalog_desc` — see [I18N.md](I18N.md). Do not add catalog strings to `static/js/lang/en.js`.
- `icon`
- `accent`
- `icon_background`
- `text_color`
- `supports_sync`
- `admin_only`
- `order`

Important:

- `slug` identifies the integration in the catalog and list rendering
- `config_key` maps to the integration slug / legacy config section key (config entries are authoritative)
- Integration settings use **config entries** rendered from each component's `CONFIG_SCHEMA` (see `static/js/integrations/config_entries.ts`); no per-integration HTML panels
- `toggle_input_id` must point to the checkbox used by `saveConfig()`
- `supports_sync` controls whether the shared Sync button is rendered

### Adding a new integration

Checklist:

1. Create a component under `components/<slug>/`.
2. Ensure it is auto-discoverable by `IntegrationManager`.
3. Add its metadata to [ui_catalog.json](ui_catalog.json).
4. Declare `CONFIG_SCHEMA` on the entity class (multi-field forms are auto-rendered in the integration config modal).
5. Add tests for discovery, sync behavior, or any custom `list_entities()` path.
6. Add `components/<slug>/translations/{en,ro}.json` (including `catalog_desc` for the settings list). See [I18N.md](I18N.md).

Do not:

- add a bespoke row directly to the integrations list HTML
- create another hand-maintained title/icon map in JS
- special-case sync buttons per integration when the generic catalog path works

## Dashboard Card Architecture

Hyve now separates a card preset from the underlying renderer.

### Terms

- `type`: the preset identity saved on the widget, for example `button`, `switch_tile`, `sensor_tile`
- `renderer`: the actual rendering behavior, for example `button`, `info`, `weather`, `label`, `power_flow`

This allows new card presets to reuse an existing renderer without new application code.

### Supported renderer model

Current built-in renderers are:

- `button`
- `info`
- `weather`
- `label`
- `power_flow`

If you only need a new preset, add a new `type` in [ui_catalog.json](ui_catalog.json) that points to one of these renderers.

If you need a truly new visual behavior, add a renderer in [static/js/dashboard/cards/renderers.js](static/js/dashboard/cards/renderers.js), register it in [static/js/dashboard/cards/register.js](static/js/dashboard/cards/register.js), and style it in [static/css/components.css](static/css/components.css).

### Card catalog fields

Each entry in `dashboard_cards` may define:

- `id`
- `label`
- `description`
- `renderer`
- `requires_entity`
- `entity_filter`
- `supports_visibility`
- `supports_switch_style`
- `supports_background`
- `default_size`
- `subtitle_label`
- `subtitle_placeholder`
- `show_in_picker`
- `switch_style_default`
- `order`

### Entity filter meanings

- `controllable`: show controllable entities only
- `all`: show any available entity
- `weather`: show weather entities only
- `none`: no entity selection required

### Adding a new card preset

Use this path when the card can reuse an existing renderer.

Example cases:

- a `switch_tile` preset using the `button` renderer
- a `sensor_tile` preset using the `info` renderer
- a `section_header` preset using the `label` renderer

Checklist:

1. Add the card metadata entry in [ui_catalog.json](ui_catalog.json).
2. Choose an existing `renderer`.
3. Set the right editor capabilities like `requires_entity`, `supports_visibility`, `supports_switch_style`.
4. Verify the preset shows in dashboard add/edit selectors.
5. Add a focused test for catalog resolution or patch normalization if behavior is non-trivial.

Do not:

- add hardcoded `<option>` values directly in the template
- add one-off editor `if` branches when catalog metadata already expresses the behavior

### Adding a new renderer

Use this only when the card cannot be represented by an existing renderer.

Checklist:

1. Add the renderer in [static/js/dashboard/cards/renderers.js](static/js/dashboard/cards/renderers.js) and register it in [static/js/dashboard/cards/register.js](static/js/dashboard/cards/register.js).
2. Update any backend semantics in [routers/dashboard.py](routers/dashboard.py) if the renderer changes controllability, hydration, or validation behavior.
3. Add styling in [static/css/components.css](static/css/components.css).
4. Add at least one card catalog entry in [ui_catalog.json](ui_catalog.json) that references the new renderer.
5. Add tests for widget normalization, hydration, and any new behavior.

Questions to ask before adding a renderer:

- can this be a preset over `button`?
- can this be a preset over `info`?
- can this be handled by metadata instead of new rendering code?

If the answer is yes, do not add a renderer.

## Non-Hardcoding Rules

When extending this system, prefer these layers in order:

1. existing provider or renderer
2. catalog metadata
3. shared generic API
4. new code path only when the behavior is fundamentally new

Avoid these anti-patterns:

- duplicated slug-to-icon maps in multiple files
- duplicated slug-to-title maps in multiple files
- hand-authored HTML rows for each integration
- hand-authored dashboard select options for each card type
- per-feature custom logic when catalog metadata already captures it

## Minimum Review Checklist

Before merging a new integration or card extension, verify:

1. The change adds or updates [ui_catalog.json](ui_catalog.json) if UI metadata is needed.
2. No new hardcoded list row or select option was introduced in [templates/index.html](templates/index.html).
3. The implementation reuses shared paths in [static/js/features.js](static/js/features.js) or the [static/js/dashboard/](static/js/dashboard/) modules (via [static/js/dashboard.js](static/js/dashboard.js) exports).
4. The backend accepts the new preset via the catalog contract and does not reject it due to a fixed enum path.
5. Tests cover discovery, normalization, or behavior where appropriate.

## Practical Examples

### Example: add a new cloud storage integration

- add component in `components/cloud_storage/entity.py`
- implement `fetch_entities()` and `extract_entities()`
- add metadata entry in [ui_catalog.json](ui_catalog.json)
- create config panel markup if needed
- reuse the shared settings row automatically through the catalog

### Example: add a `thermostat_summary` card preset

- add a `dashboard_cards` entry with `id: thermostat_summary`
- point it to renderer `info`
- use `entity_filter: all`
- tune label, description, and default size
- do not add a new renderer unless the visual behavior is fundamentally different

## Card interactions (tap / double-tap / hold)

Entity cards support configurable gestures stored in `widget.config.interactions` (also hoisted at card level in page YAML).

| Action | Behavior |
|--------|----------|
| `none` | Ignore gesture |
| `toggle` | Dashboard toggle API (optional `confirmation: true`) |
| `more_info` | Entity details modal |
| `history` | History chart modal (`hours`: 1–168) |
| `perform_action` | Domain action (scene activate, lock/unlock, vacuum start, …) |
| `navigate` | Switch dashboard page (`page_id`) |
| `url` | Open external link in new tab (browser confirm dialog) |

**Defaults** are computed per domain/renderer in [core/dashboard/interactions.py](../core/dashboard/interactions.py) and mirrored in [static/js/dashboard/interactions/defaults.ts](../static/js/dashboard/interactions/defaults.ts). Omit `interactions` in YAML to use smart defaults; only overrides are exported.

**Editor:** Hyveview card modal → section *Interacțiuni* ([static/hyveview/editor/interactions_editor.ts](../static/hyveview/editor/interactions_editor.ts)).

**Engine:** [static/js/dashboard/interactions/](../static/js/dashboard/interactions/) — gesture detection, resolver, executor.

**i18n:** `dashboard.interactions.*` in [core/i18n/dashboard/translations/](../core/i18n/dashboard/translations/).

**Tests:** [tests/test_dashboard_interactions.py](../tests/test_dashboard_interactions.py), [tests/test_dashboard_history_access.py](../tests/test_dashboard_history_access.py).

**More-info modal** includes Overview, History, and Attributes tabs. History reuses the shared chart panel (`history_panel.ts`). History API endpoints are rate-limited (30/minute per IP).

## Future Direction

The next logical step is to make configuration panels schema-driven too.

Until then:

- the list and metadata must remain registry-driven
- the panel body can still be custom
- new work should move toward fewer special cases, not more