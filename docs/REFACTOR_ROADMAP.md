# Hyve refactor roadmap (2026)

Tracked follow-ups after the professionalization pass. Each item should land as
small, reviewable PRs.

## Done in this pass

- [x] `core/github_api.py` — shared GitHub token + headers
- [x] `addons/github_releases.py` + `addons/version_utils.py` — extracted from `registry.py`
- [x] `core/entity_store.py` — entity sync engine moved out of `addons/`
- [x] API i18n: `routers/scenes.py`, `routers/updates.py` (`{key, params}`)
- [x] Notification payload i18n keys (`notifications.ts`)
- [x] Vite bundle for main app (`static/dist/app.js`)
- [x] Alembic `008_scenes_areas`
- [x] Honest Tier A / Tier B split in `INTEGRATION_GUIDE.md`
- [x] Decentralised i18n: `core/i18n/*/translations/`, `GET /api/i18n/bundles`, docs in `I18N.md`
- [x] `routers/dashboard/store.py` → `core/dashboard/` (`constants`, `normalize`, `visibility`, `persistence`); lazy `core/http/__init__` breaks import cycles

## P1 — God file splits (next)

| Module | Target | Notes |
|--------|--------|-------|
| ~~`addons/registry.py`~~ | ~~`discovery.py`, `installers/`, `health.py`~~ | **Done** — see `addons/discovery.py`, `install_ops.py`, …; `registry.py` is facade |
| ~~`routers/dashboard/store.py`~~ (~1.1k) | ~~`core/dashboard/`~~ | **Done** — `constants.py`, `normalize.py`, `visibility.py`, `persistence.py`; `store.py` facade |
| ~~`components/mosquitto/extract.py`~~ (~1.9k) | ~~`parse.py`, `entities.py`, `widgets.py`~~ | **Done** — `extract.py` facade |
| ~~`routers/cameras.py`~~ (~1k) | `core/cameras/` + vendor `camera_proxy` | **Done** — router ~95 lines; logic in `snapshot`, `streaming`, `audio`, `attrs`, … |
| ~~`static/js/app.ts`~~ (~1.5k) | ~~`boot/`, `bindings/`~~ | **Done** — `boot/*`, `bindings/{shell_boot,delegated,chat_inputs}.ts` |

## P2 — Contract enforcement

- [x] CI grep: structured `HTTPException` payloads in `routers/` (`scripts/check_router_contracts.py`)
- [x] CI grep: no Romanian diacritics in `raise HTTPException|ValueError|RuntimeError|…` under `routers/` + component routers
- [x] HTTP contract tests for top routers (`tests/test_router_http_contracts.py`)
- [x] Remove `create_all` after all ORM tables have Alembic revisions (`000_orm_baseline` + startup uses Alembic only)

## P3 — Frontend professionalization

- [x] Delete committed `static/js/**/*.js` emit (gitignore already added)
- [x] Vite lib build for `static/hyveview/` (drop hyveview tsc emit)
- [x] Theme tokens: replace `border-white/10` in templates with CSS variables
- [x] Theme tokens: remaining template borders (`border-white/[0.03–0.06]`) → `border-theme-*`
- [x] Global native `<select>` auto-upgrade at app boot (`custom_selects/upgrade` + `generic`)
- [x] Remove duplicate hand-built dropdown HTML in config (language, updates interval, backup schedule)
- [x] `html lang` + clock from `ui.language` config
- [x] Theme tokens: replace remaining `border-white/10` in TS/JS sources

## P4 — Platform capabilities

- [x] `manifest.json` → `capabilities` + `lifecycle_module` (mosquitto, mammotion)
- [x] `integrations/lifecycle.py` — startup, wiring, rename, shutdown hooks
- [x] `addons/lifecycle.py` — on-disk install, config hooks, catalog enrich (piper, cloudflared)
- [x] Split `addons/registry.py` → `discovery.py`, `versions.py`, `reconcile.py`, `preflight.py`, `install_ops.py`, `health.py`, `meta.py`, `paths.py` (facade re-exports)
- [x] `integrations/capability_routers.py` — auto-register `components/<slug>/router.py` (migrate legacy routers incrementally)
- [x] Mammotion streaming routes → `components/mammotion/router.py` (+ `core/cameras/` shared lookup/auth)
- [x] Piper / Whisper Wyoming routes → `components/piper/router.py`, `components/whisper/router.py` (+ `integrations/wyoming_protocol.py`)
- [x] Frigate go2rtc WS + vendor camera_proxy modules (tapo/reolink/frigate); generic stream routes stay in `routers/cameras.py`
- [x] ComfyUI → `components/comfyui/router.py`
- [x] CI grep: no Romanian diacritics in remaining `routers/` string literals (comments/docstrings/data defaults excluded)
- [x] Remove `integrations/shims/` ghost dirs (already gone; import `components/` directly)
- [x] Startup phases: fatal vs degraded subsystem status in UI (`core/startup_status.py` + Hub indicator)

## P5 — Security hardening

- [x] Rate limits on auth, admin destructive, install streams
- [x] Remove JWT-from-query for cameras (use SSE exchange pattern)
- [x] Audit `GET /api/tags` (Ollama proxy) auth requirements

## P3b — UI design consistency (Devices pattern: `hyd-mast`, `hyd-config-page`, `hyd-app-card`)

Reference: `static/js/smarthome/device_core.ts`, `static/css/devices-ui.css`.

### Done

- [x] Devices (reference)
- [x] Scene, Zone, Automatizări, App tab
- [x] Add-ons list + Integrări standalone
- [x] Memorii, Utilizatori, Aspect
- [x] Add-on detail (`hyd-app-card`, `hyd-mast__back`)
- [x] Setări shell — `hyd-mast--stacked`, tab chips, `hyd-app-card` panels
- [x] Logs, Actualizări, Backup standalone headers
- [x] Skills page (`hyd-mast`, `hyd-entity-row`)

### In progress / bugs

- [x] Dashboard cog menu (edit/add/page actions) — direct button binding + outside-click guard
- [x] Edit mode banner visibility (`#dashboard-edit-banner` synced with edit mode)
- [x] Hyveview Add/Edit card modal — searchable entity field (`entity` + `multi_entity`)

### Remaining

_All P3b items complete._

### Cleanup (0.9.8.13)

- [x] Config sub-pages → `hyd-mast` (logs, install, addon, profile, integration, skills)
- [x] Strip legacy `bg-slate-900` / slate text utilities from Hub templates
- [x] Theme-aware fields on config sub-page modals
