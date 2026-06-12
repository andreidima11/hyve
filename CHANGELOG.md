# Changelog

All notable changes to Hyve are documented here. Version format: `MAJOR.MINOR.PATCH` (no `v` prefix).

**Releases:** edit this file first, commit, then run `python scripts/publish_release.py` — GitHub release notes are taken from the matching `## [X.Y.Z]` section.

## [0.9.6] — 2026-06

Feature release: **modern Devices & entity detail UI**, inline friendly-name editing, primary-entity picker, and richer device metadata across integrations.

### Devices UI
- New full-page **device** and **entity detail** views (`devices_ui.ts`, `devices-ui.css`) — overview card (status icon, toggle, brightness), device info rows, nested entity list.
- Device list cards grouped by physical device (`devices_group.ts`); category chips and filters unchanged in behaviour.
- **Primary entity** for multi-entity devices: long-press status icon → modal to pick which entity drives toggle/state on the device page.
- **Inline rename** for device and entity friendly names (replaces `prompt()`); stays on the same detail page after rename, including through Z2M/MQTT resync.
- Entity rows show **domain** (`switch`, `lawn_mower`, `vacuum`, …) instead of integration label; hero state readout scales font size for long labels (e.g. *Indisponibil*).
- Live WS updates patch detail DOM in place (no full re-render flicker on toggle or state change).
- Removed success toast (*Comandă trimisă*) on entity toggle — errors still surface via toast.
- **Things hub** (`static/js/things/`): open device/entity detail from Integrations settings with return navigation.

### Entity registry & rename
- Friendly names stored in **`entity_registry.name`** (HA-style); one-time migration from legacy `custom_name` overrides.
- Entity detail **Avansat**: AI context + aliases; entity ID row with inline copy.
- Shared **`device_field_bundle`** / **`attach_device_fields`** for consistent `device_id` / `device_name` on entities (Pago, Sun, Tapo, Reolink, ReteleElectrice, …).
- Device resolver and AI prompt use registry display names.

### Integrations
- Reolink registry and Pago extract improvements; Sun/Tapo entity metadata alignment.
- Integration exposed-devices grid delegates detail navigation to unified Devices UI.

### Tests
- `tests/test_entity_registry.py` — custom_name migration and registry name behaviour.
- `tests/test_integration_device_ids.py` — stable device IDs in API payloads.

## [0.9.5] — 2026-06

Feature release: **RGB Zigbee light controls** (Mosquitto/Z2M), custom Hyve color picker, Mammotion camera autoplay, and Mammotion nudge / transport polish.

### Integrations — Mosquitto / Zigbee2MQTT lights
- Detect RGB, color temperature, and brightness capabilities from Z2M composite exposes, HA MQTT discovery (`supported_color_modes`), and live state.
- MQTT control: `set_brightness`, `set_color_temp`, and `set` with correct JSON payloads — RGB from the UI is converted to nested `color: {hue, saturation}` or `color: {r,g,b}` as required by Zigbee2MQTT.
- Integration **device modal**: inline brightness, custom color picker, and color-temperature sliders for `light` entities (no extra click into entity detail).
- Optimistic light attribute updates; sliders no longer snap back after control.

### Frontend — light color picker
- New **`static/js/light_controls.ts`**: shared capability detection, Hyve-styled picker (saturation/value plane, hue slider, presets), used in Integrations and Smart home entity detail.
- Replaces native `<input type="color">`; theme-aware CSS in `components.css`.
- Direct control commit from picker (`commitIntegrationControl` / `commitSmarthomeLightControl`).
- i18n: `entity.render.hue` (EN/RO).

### Mammotion
- **Camera autoplay** in integrations entity detail, device modal, and dashboard camera cards; card editor **Autoplay** toggle (`dashboard.camera.autoplay`).
- `<hv-mammotion-camera>`: immediate play on attach, compact play overlay, stream pause/resume when modals or dashboard live mode change.
- **Nudge buttons**: disabled with honest tooltip when server-side BLE is unavailable; `movement_use_wifi` / `nudge_server_ble` metadata.
- PyMammotion compat patches, session bootstrap, and command transport hardening.

### Tests
- `tests/test_mosquitto_control.py` — Z2M light color/capability and MQTT payload conversion.
- `tests/test_mammotion_nudge_availability.py`, `tests/test_mammotion_nudge_transport.py`, `tests/test_mammotion_movement_config.py`.
- `tests/test_camera_autoplay_config.py` — camera card autoplay defaults.

## [0.9.4] — 2026-06

Feature release: Mammotion lawn mower **live camera** (Agora WebRTC) in integrations, entity detail, and dashboard camera cards.

### Integrations — Mammotion camera
- **`camera.*_webrtc` entity** with `stream_type: agora_webrtc` for Luba/Yuka models that support video.
- Backend: Agora token fetch via PyMammotion cloud API (`/api/cameras/{id}/mammotion/start|tokens|stop`); optional MQTT wake for the encoder when the control path is up.
- Device resolution uses the active Mammotion session registry (not only the cloud HTTP device list), so the camera works when the rest of the integration already does.

### Frontend
- **`<hv-mammotion-camera>`** — Agora WebRTC player with Play, loader, and real error messages.
- Integrations device modal and entity renderers route Mammotion cameras to the Agora player (not MJPEG/RTSP).
- **Dashboard camera card** (`hv-camera-carousel`): detects Agora/Mammotion and embeds the same player; live mode auto-starts when visible.
- CSP: allow Agora SDK script and WebRTC connect targets (`download.agora.io`, `*.agora.io`, `*.sd-rtn.com`).

### Entity UI
- Select dropdown: removed redundant “OPTION” label above Mammotion select controls.

### Tests
- `tests/test_mammotion_camera_stream.py` — token payload, device name resolution, Agora stream attrs.

## [0.9.3] — 2026-06

Feature release: Mammotion lawn mower integration, entity control UI fixes, and dashboard lawn mower card.

### Integrations
- **Mammotion** (`components/mammotion/`): cloud login (PyMammotion 0.8.5), MQTT command transport, entity sync for Luba / Yuka / Spino — sensors, switches, numbers, selects, action buttons, and per-plan task buttons from mower maps.
- Config entry test/sync: 120s timeout for Mammotion; background wire after create/update so the UI responds before cloud login.
- `start.sh` prefers `.venv` (Python 3.13 + pymammotion) over legacy `venv`.
- CI and `.python-version` bumped to Python 3.13.

### Entity UI
- **Select** entities: dropdown with label + options (from `capabilities.options` / `attributes.options`); no longer limited to ≤6 options or plain state text.
- **Button** entities: action control instead of “unknown” empty state; momentary domains show a send/action affordance.
- Smart home device modal: richer entity detail panel and inline controls for controllable domains.

### Dashboard
- New **lawn_mower** Hyveview card (start / pause / stop / dock, battery and state).
- Widget actions wired for lawn mower entities on the dashboard.

### Mosquitto / Z2M
- Bridge version sensor and improved device metadata extraction for Zigbee2MQTT entities.

### Platform
- Entity registry: stable unique IDs and alias resolution improvements.
- i18n: entity render strings (EN/RO) for lawn mower, button, and select controls.

## [0.9.2] — 2026-06

Hotfix: boot overlay stuck on loading after upgrading from 0.9.0/0.9.1.

### Frontend
- Re-add no-op stubs for removed integration config JS (`comfyui`, Assist/CCTV helpers) so cached module graphs do not 404 on import.
- Boot: timeout on setup status and initial dashboard load so the splash screen always dismisses.

## [0.9.1] — 2026-06

Cleanup release: drop integration shims, schema-only config modal, dashboard modal removal, and CI smoke.

### Platform
- Remove `integrations/shims/`; import `components/<slug>/` modules directly from routers and brain toolbox.
- CI: `scripts/smoke_test.py` — app import + key routes after pytest.

### Integrations UI
- Integration config modal is fully schema-driven (`CONFIG_SCHEMA` + config entries); removed legacy per-integration panels, CCTV row helpers, Assist key UI stubs, and orphaned ComfyUI form JS.
- Docs: [docs/ROADMAP-0.9.1.md](docs/ROADMAP-0.9.1.md), CARDS_AND_INTEGRATIONS updated for config entries.

### Dashboard
- Remove legacy add/edit modals (`widget_add_modal`, `widget_legacy_edit`, `widget_add_editor`); Hyveview editor via `add_picker` + `widget_editor_bridge` only.
- Per-user default dashboard page: regression tests in `tests/test_dashboard_widgets.py`.

## [0.9.0] — 2026-06

Platform maturity release: config entries as the integration source of truth, catalog i18n, mobile dashboard fixes, and documentation cleanup.

### Platform
- Fix `ui_catalog.json` path after `core/ui_catalog.py` move (integrations list + icons restored).
- Add-on → integration sync writes **config entries** (SQLite), not `config.json` dual-write.
- Startup migrations: document Alembic-only schema change policy (Phase 6).
- `UploadFile` endpoints use `Annotated` for Pydantic 2.13+; `reorganize_root_modules.py` skips `venv/`.

### Integrations UI
- Catalog i18n: auto `title_key` / `description_key` for all integrations; EN/RO `integrations.catalog.*` strings.
- Integration config modal uses catalog API for title, icon, and image (removed hardcoded maps).
- Docs: [docs/ROADMAP-0.9.0.md](docs/ROADMAP-0.9.0.md), ARCHITECTURE + CARDS updated for `components/`.

### Dashboard
- Mobile section reorder: `--hyve-panel-mobile-order` from array index; persist via `/reorder` on single-column drag.
- Section drag UX: full-width drop ghost (same visual language as cards); pull-to-refresh disabled in edit mode.

## [0.8.19] — 2026-06

- Frontend legacy cleanup (HA bulk mode, add-devices modal, dead stubs).
- Root Python modules moved to `core/`, `brain/`; only `main.py` remains at repo root.
- Version tags without `v` prefix.

## [0.8.18] — 2026-06

- Phase 4 frontend split complete: thin `features_*` facades + domain modules under `static/js/<domain>/`.

## [0.8.17] — 2026-06

- Phase 2 API i18n completion, add-on state reconcile, logo polish.

## [0.8.16] — 2026-06

- i18n audit, structured add-on API errors.

## [0.8.15] — 2026-06

- Centralized add-on integration config sync.

## [0.8.14] — 2026-06

- Persist add-on state in SQLite.

## [0.8.13] — 2026-06

- CI hygiene, automations toolbar alignment.

## [0.8.12] — 2026-06

- Add-on version display, automations UI polish.

## [0.8.11] — 2026-06

- Architectural audit remediation: entity pipelines, live WS unification, camera stream tokens, sparkline batch API.

## [0.8.10] — 2026-06

- Complete `static/hyveview` TypeScript migration.

## [0.8.9] — 2026-06

- Complete `static/js` TypeScript migration.

## [0.8.7–0.8.8] — 2026-06

- TypeScript frontend migration with strict `js:check` in CI.

## [0.8.0–0.8.6] — 2026-06

- Device registry, Hyveview cards, onboarding wizard, Zigbee2MQTT/Mosquitto/Roborock fixes, component colocation.
