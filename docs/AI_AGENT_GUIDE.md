# AI agent guide — Hyve

This document tells coding agents **where things live**, **how to add features**, and **what not to do**. Hyve is a FastAPI smart-home + AI assistant monolith with a vanilla-JS frontend (ES modules, no React).

---

## 1. Before you write code

Answer these:

| Question | If yes → read |
|----------|----------------|
| New devices/entities from an API or MQTT? | [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) |
| New row in Settings → Integrations? | [CARDS_AND_INTEGRATIONS.md](CARDS_AND_INTEGRATIONS.md) + `ui_catalog.json` |
| New dashboard tile/card? | § [Dashboard cards](#6-dashboard-cards) below |
| New theme? | [../static/css/themes/README.md](../static/css/themes/README.md) |
| New user-visible string? | § [Internationalization](#8-internationalization-i18n) |
| New HTTP API? | § [Backend API](#5-backend-api) |
| AI/chat/memory/skills? | `brain/` — keep vendor logic out of `integrations/` |
| External service (MQTT broker, STT)? | `addons/` or `custom_addons/` — not `integrations/providers/` |

**Default stance:** extend existing registries (`IntegrationManager`, `ui_catalog.json`, Hyveview card registry) instead of new ad-hoc HTML/JS.

---

## 2. Golden rules

### Always

- Use **config entries** (`integrations/config_entries.py`) as the source of truth for integration credentials — not `config.json[slug]`.
- Read integration config from `self.entry_data` inside providers.
- Mark secrets in `CONFIG_SCHEMA` with `"secret": true`.
- Return API errors as structured i18n: `{"key": "integrations.sync_throttled", "params": {"seconds": 42}}` or raise `HTTPException(detail={...})`.
- Use **`apiCall()`** from `static/js/api.js` for authenticated fetch (handles refresh).
- Use **`t('namespace.key')`** from `static/js/lang/index.js` for UI strings.
- Use **CSS variables** (`var(--surface-1)`, `var(--border-light)`, …) — see `.cursor/rules/ui-design-consistency.mdc`.
- Keep diffs **minimal** and match surrounding style.

### Never

- Add a **dedicated router** per vendor (e.g. `/api/fusion-solar/*`) — use `/api/integrations/{slug}/…`.
- Wire integrations in **`core/http/lifespan.py`** — loader + entity store handle sync.
- **`from main import …`** in routers or providers.
- Add **integration-specific HTML** in `templates/index.html` or hardcoded rows in `features.js`.
- Put **integration CSS** in `static/css/` root — themes only, or future `components/<domain>/frontend/`.
- Use **native `<select>`** in new UI (use custom dropdown pattern).
- Put **long-lived JWT** in camera/stream URLs — use short-lived tokens / `Authorization` header.
- Hardcode **Romanian or English** user strings in Python/JS (use lang files + message keys).
- Create **empty commits** or run destructive git commands unless the user asks.

---

## 3. Repository map (current)

```
hyve/
├── main.py                 # uvicorn entrypoint only (~50 lines)
├── core/http/              # create_app(), middleware, routers registry
├── settings.py             # CFG from config.json + env
├── auth.py                 # JWT, password hashing
├── database.py / models.py # SQLAlchemy + SQLite
├── ui_catalog.json         # Integration + dashboard card UI metadata
├── ui_catalog.py           # Server-side catalog normalization
│
├── integrations/           # Entity integration platform
│   ├── base.py             # BaseEntity contract
│   ├── loader.py           # IntegrationManager discovery
│   ├── config_entries.py   # HA-style entries in SQLite
│   ├── secrets.py          # Fernet encryption for secrets
│   ├── extractors.py       # Legacy shared extractors (prefer moving into provider)
│   └── providers/*.py      # One module per integration (auto-discovered)
│
├── addons/
│   ├── entity_store.py     # Sync loops, throttle, entity payload cache
│   └── registry.py         # Add-on catalog (MQTT, Zigbee2MQTT, …)
├── custom_addons/          # User drop-in add-ons (manifest.json per folder)
│
├── routers/                # FastAPI routers (one domain per file)
├── brain/                  # AI agent: cortex, toolbox, memory, channels
├── automations/            # YAML automations + engine
│
├── static/js/              # Frontend ES modules
│   ├── app.js              # Bootstrap, tab routing, lazy imports
│   ├── api.js              # apiCall, token refresh
│   ├── features.js         # Facade — re-exports feature modules (do not grow)
│   ├── features_config.js  # Settings, integrations modal, notifications, addons
│   ├── features_smarthome.js
│   ├── features_automations.js
│   ├── features_memory.js
│   ├── dashboard.js        # Dashboard grid + editor
│   ├── lang/en.js, ro.js   # UI translations
│   └── hyveview/           # Custom-element dashboard cards (preferred for new cards)
│
├── templates/index.html    # Server-rendered shell (minimize growth)
└── tests/                  # pytest (run: pytest)
```

### Two different “integration” concepts

| Concept | Location | Purpose |
|---------|----------|---------|
| **Entity integration** | `integrations/providers/` | Poll/connect → produce entities (lights, sensors, …) |
| **Settings integration** | `ui_catalog.json` + panel in `index.html` | Config-only (WAHA, SearXNG, Ollama URL, …) |
| **Add-on** | `addons/available/`, `custom_addons/` | Optional external **service** (install/start), not entity sync |

Do not confuse add-ons with entity providers.

---

## 4. Adding an entity integration (provider)

**Full reference:** [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)

### Minimal steps

1. Create `components/my_service/manifest.json` + `entity.py` (or legacy `integrations/providers/my_service.py`).
2. Set `slug`, `label`, `CONFIG_SCHEMA`, `fetch_entities`, `extract_entities`.
3. Use `"secret": true` on passwords/tokens.
4. Restart server — `IntegrationManager` discovers `components/`, `custom_components/`, then legacy `providers/*.py`.
5. User creates a **config entry** via Settings → Integrations (generic UI).

### Entity shape (extract output)

Each entity dict should include at least:

```python
{
    "id": f"{self.slug}_{self.entry_id[:8]}_temperature",  # unique
    "entity_id": "sensor.my_service_temperature",           # optional but preferred
    "name": "Temperature",
    "state": "21.5",
    "unit": "°C",
    "domain": "sensor",
    "source": self.slug,
}
```

Include `entry_id[:8]` in ids when `SUPPORTS_MULTIPLE = True`.

### Test connection

Override `async_test_connection` for a light check. Return:

```python
{"ok": True, "message_key": "integrations.test_ok", "message_params": {"count": 12}}
# or on failure:
{"ok": False, "message_key": "integrations.my_service_failed", "message": str(exc)}  # message = raw upstream
```

Add keys to `static/js/lang/en.js` and `ro.js` under `integrations.*`.

Frontend resolves via `integrationApiMessage()` in `lang/index.js`.

### Sync interval

Do **not** override `sync_interval()` with hardcoded minimums. User sets `scan_interval` in the config entry; floor comes from `CONFIG_SCHEMA` `min`.

### Optional: UI catalog entry

If the integration needs a visible row in Settings with custom accent/icon, add metadata to `ui_catalog.json` — but **no custom form** if `CONFIG_SCHEMA` suffices.

### Tests

Add `tests/test_my_service.py` or extend integration tests — at least discovery + extract with fixture payload.

---

## 5. Backend API

### Routers

- Register new routers in **`core/http/routers.py`** via `register_routers(app)`.
- Prefer extending `routers/integrations.py` for anything integration-related.
- Use **Pydantic models** for request bodies — avoid raw `body: dict` on new endpoints.

### Auth

- User endpoints: `Depends(auth.get_current_user)`
- Admin: `Depends(auth.get_current_admin)`
- SSE/WebSocket: short-lived exchange token (`getSSEToken()` / `/api/token/sse`)
- Do not add new endpoints that accept long-lived JWT in query strings.

### Errors

```python
raise HTTPException(
    status_code=400,
    detail={"key": "integrations.validation_failed", "params": {"detail": str(exc)}},
)
```

Frontend: `translateApiDetail(detail)` from `lang/index.js`.

### Entity store

- Register fetcher via integration loader — not manually in `main.py`.
- Manual sync respects `scan_interval` — raises `SyncThrottledError` → 429 with structured detail.

---

## 6. Dashboard cards

Three levels of work — pick the **smallest** that fits:

### A. New preset (reuse existing renderer)

Edit `ui_catalog.json` → `dashboard_cards`: new `id`, point `renderer` to `button`, `info`, `weather`, `label`, or `power_flow`.

No JS changes if the preset fits an existing renderer. See [CARDS_AND_INTEGRATIONS.md](CARDS_AND_INTEGRATIONS.md).

### B. New Hyveview card (preferred for new visuals)

1. Create `static/hyveview/cards/my_card.js` extending `HyveviewCardBase`.
2. Register in `static/hyveview/bridge.js` via `registerCard()`.
3. Import the module from `dashboard.js` (side-effect registration).
4. Add schema editor fields in `static/hyveview/core/schema.js` if the card is configurable.
5. Bump cache version on `dashboard.js` import query string (e.g. `?v=hyveview-cards-44`).

### C. Legacy renderer in `dashboard.js`

Avoid for new work — only if Hyveview migration cannot cover the case yet.

### Card + integration coupling

Integration-specific cards (e.g. FusionSolar) should:

- Live in `static/hyveview/cards/fusion_solar.js`
- Declare entity dependencies explicitly — **no speculative entity id lists**
- Not add CSS under `static/css/` except shared component tokens

---

## 7. Themes

Themes are **only**:

```
static/css/themes/{id}.css    # [data-theme="{id}"] { --var: ... }
static/css/themes/{id}.json   # metadata + preview colors
```

Registration is automatic via `static/js/theme-registry.js` (loaded at boot).

### Rules

- Override **CSS variables**, not random class names.
- Test on **light and dark** (`daylight`, `obsidian`).
- `id` in JSON must match filename and `[data-theme="…"]` selector.
- Do not edit core `tokens.css` for a one-off theme tweak.

Full variable list: [../static/css/themes/README.md](../static/css/themes/README.md).

---

## 8. Internationalization (i18n)

### Frontend UI

- Dictionaries: `static/js/lang/en.js`, `ro.js` (nested objects, dot keys).
- Use `t('dashboard.save_failed')`, `t('integrations.test_ok', { count: 5 })`.
- HTML shell: `data-i18n="app.boot_loading"` — applied by `applyTranslations()`.
- After adding keys, bump `?v=i18n-updates-NN` in `lang/index.js`.

### Backend → frontend

- Prefer `message_key` + `message_params` in JSON responses.
- Use `integrations.*`, `dashboard.*`, `common.*` namespaces consistently.
- Do not return Romanian error strings from Python for new code.

### Brain / prompts

- Separate files: `locales/en.json`, `locales/ro.json` — not mixed into `static/js/lang/`.

---

## 9. Frontend features (non-integration)

### Module layout (today)

| Module | File | Responsibility |
|--------|------|------------------|
| Shell | `app.js` | Tabs, auth gate, lazy load |
| API | `api.js` | Fetch + token refresh |
| Settings / devices | `features.js` | Smarthome list, config, integrations UI |
| Dashboard | `dashboard.js` | Grid, editor, YAML |
| Chat | `chat.js` | Streaming chat UI |
| i18n | `lang/index.js` | `t`, `translateApiDetail` |

**Direction:** `features.js` is a facade only. New UI code goes into `features_<domain>.js` (or existing domain file). Do not append large blocks to `features.js`.

### Cache busting

Static imports use query strings: `import … from './foo.js?v=some-version'`. When you change a module, bump its version string on imports in `app.js` (or parent importer).

### Global `window.*`

Legacy HTML uses `onclick="foo()"`. New code should:

- Prefer `addEventListener` in module init, or
- Export one handler to `window` only if `index.html` requires it.

Do not add new global functions without need.

### UI components

Read `.cursor/rules/ui-design-consistency.mdc`:

- Custom dropdowns (`_buildCustomSelect` or `js-generic-select` pattern)
- Modals: `app-modal-overlay` / `app-modal`
- No hardcoded dark-theme rgba whites/blacks

---

## 10. Automations

- User automations: YAML files under `automations/` (or user data dir).
- Engine: `automations/` Python package — well tested; follow existing patterns.
- New triggers/conditions/actions: add to schema + validator + tests in `tests/test_automation_*.py`.

---

## 11. Brain / AI layer

```
brain/
├── cortex.py       # Agent loop (large)
├── toolbox.py      # Tool definitions
├── memory/         # Extraction, recall
└── channels/       # WhatsApp, etc.
```

- Tools that control devices should go through existing HA/integration service layers — not duplicate provider HTTP clients.
- Prompts: `locales/` or config-driven — not hardcoded in `main.py`.
- Do not block the event loop with sync LLM calls.

---

## 12. Add-ons (custom_addons)

User drops a folder with `manifest.json`. See [../custom_addons/README.md](../custom_addons/README.md).

- Env override: `HYVE_CUSTOM_ADDONS_DIR`
- Scanned at catalog request — no server restart required for discovery
- **Not** the place for entity integrations — use `integrations/providers/` (future: `custom_components/`)

---

## 13. Testing & CI

```bash
pytest                    # from repo root
pytest tests/test_foo.py  # single file
```

- Run `pytest` locally before finishing backend changes (no remote CI).
- Add tests for new provider logic, API behavior, validators.
- Missing today (add when touching): auth refresh, camera tokens, chat stream.

---

## 14. Environment variables

| Variable | Purpose |
|----------|---------|
| `HYVE_SECRET_KEY` | JWT signing (required in prod) |
| `HYVE_DEV=1` | Dev mode (template reload, etc.) |
| `HYVE_CUSTOM_ADDONS_DIR` | Custom add-ons path |
| `HYVE_ENV` / `HYVE_STRICT_STARTUP` | Startup validation |

---

## 15. Anti-patterns (real examples from this repo)

| Bad | Good |
|-----|------|
| `fusion_solar_client.py` at repo root + provider + legacy router | Client colocated with provider module |
| 10k-line `features.js` | Feature modules imported by `app.js` |
| `extractors.py` 2000-line god file | `extract_entities()` inside provider |
| JWT in `/api/cameras/...?token=` | Short-lived stream token or Authorization header |
| `detail="Parola incorectă"` | `detail={"key": "user.password_incorrect"}` |
| New integration panel HTML in `index.html` | `CONFIG_SCHEMA` only |
| `except Exception: pass` in sync paths | Log + surface error on entity store |

---

## 16. Component folders (Phase 2+)

Bundled integrations live in `components/<domain>/`; user drop-ins in `custom_components/` or `HYVE_CUSTOM_COMPONENTS_DIR`. All core entity integrations are migrated; `integrations/providers/*.py` are thin shims.

```
components/<domain>/
├── manifest.json
├── entity.py
└── translations/   # optional
```

Legacy flat `integrations/providers/*.py` still loads for unmigrated slugs. Further platform extraction (`core/`, `frontend/src/`) is planned separately — do not implement unless asked.

---

## 17. Checklist before finishing a task

- [ ] No new hardcoded user strings (i18n keys added)
- [ ] No new `main.py` business logic or lifespan wiring
- [ ] No new per-vendor routers or CSS files
- [ ] Secrets use `secret: true` in schema
- [ ] API errors structured for `translateApiDetail`
- [ ] Cache-bust query strings updated if JS changed
- [ ] `pytest` passes for affected areas
- [ ] Diff is minimal — no drive-by refactors
