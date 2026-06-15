# Changelog

All notable changes to Hyve are documented here. Version format: `MAJOR.MINOR.PATCH` (no `v` prefix).

**Releases:** edit this file first, commit, then run `python scripts/publish_release.py` — GitHub release notes are taken from the matching `## [X.Y.Z]` section.

## [0.9.8.0] — 2026-06

Minor release: **professionalization pass** — Vite frontend pipeline, security hardening, modular cameras API, Alembic-only schema bootstrap, and integration lifecycle.

### Frontend
- **New:** Vite bundles for main app (`static/dist/app.js`), shared modules, and Hyveview custom elements; drop committed `static/js/**/*.js` emit.
- **New:** Theme border tokens (`border-theme-*`) across templates and TS sources; global native `<select>` auto-upgrade to custom dropdowns.
- **Fix:** `icon_picker` ESM exports for Hyveview schema forms; lazy-loaded feature chunks (`features_apps`, planner, …) use static `import()` so Vite emits hashed chunks.

### Security
- Rate limits on auth, admin destructive actions, and add-on install streams.
- Camera streams: query `?token=` accepts only `camera_stream` JWT; `/api/tags` requires auth.

### Backend / architecture
- Split `routers/cameras.py` into `core/cameras/` + vendor `camera_proxy` modules.
- Alembic `000_orm_baseline` replaces startup `create_all`; integration capability routers and addon/component lifecycle hooks.
- Decentralised i18n bundles (`GET /api/i18n/bundles`); CI router contract checks and HTTP contract smoke tests.

## [0.9.7.13] — 2026-06

Hotfix: **Mammotion camera connect regression** (0.9.7.12) and **boot overlay polish**.

### Mammotion camera
- **Fix:** auto-reconnect no longer aborts the initial connect — grace period after Agora `join`, ignore transient `DISCONNECTED`, only reconnect after video was actually playing.
- **Fix:** `renewToken` falls back to full reconnect when the Agora SDK build lacks the method.

### Boot / UX
- Complete progress bar before login, setup wizard, or boot failure paths.
- Boot overlay clears `aria-busy` when hidden; server startup poll works without auth token.

## [0.9.7.12] — 2026-06

Patch release: **boot progress bar**, **Mammotion camera stability**, and **camera API i18n**.

### Boot / UX
- **New:** startup overlay shows a progress bar with translated steps (setup → auth → dashboard).
- Progress blends client boot steps with server `/api/startup/status` (integrations / add-ons loading).

### Mammotion camera
- **Fix:** live feed no longer dies silently — Agora token keepalive (~90s), `renewToken`, and auto-reconnect on disconnect / publisher left.
- **New:** `POST /api/cameras/{entity}/mammotion/keepalive` — light MQTT wake + fresh token.
- Stream lifecycle events logged to the browser console (`[hv-mammotion-camera]`) for debugging.
- UI strings and API errors use i18n keys (`cameras.mammotion_*`).

### API / i18n
- **Cameras router:** all HTTP errors use structured `{ key, params }` (snapshot, stream, Tapo, Reolink, Frigate, audio, Mammotion).
- **`/api/startup/status`:** adds `progress` (0–100) for loading indicators.

### Tests
- `tests/test_cameras_api_errors.py`, `tests/test_startup_status.py`
- `tests/test_mammotion_camera_stream.py` — keepalive helper

## [0.9.7.11] — 2026-06

Patch release: **add-on GitHub release notes**, **Xiaomi Home OAuth on save**, and **Cloudflared icon**.

### Add-ons
- **Updates:** release notes fetched live from GitHub Releases (like Hyve) — tag variants (`1.2.3` / `v1.2.3`), repo from `version_github` or GitHub project URL.
- **`version_github`** on Mosquitto, Zigbee2MQTT, and Piper manifests; fix empty-notes cache skipping GitHub lookup.
- **Cloudflared:** custom icon (`cloudflare.webp`) in the add-on catalog.

### Integrations
- **Fix:** Xiaomi Home — saving an existing entry now exchanges the pasted OAuth code (PATCH runs validation); test connection keeps stored `_oauth` tokens when editing.

### Tests
- `tests/test_addon_release_notes.py` — GitHub tag variants, live notes merge
- `tests/test_integration_config_entries_api.py` — Xiaomi PATCH validate, OAuth merge on test

## [0.9.7.10] — 2026-06

Patch release: **add-on enable/disable lifecycle**, **Mosquitto on Linux**, **backup coverage**, and **integration test fix**.

### Add-ons
- **Fix:** disabling an add-on now **stops its process** and prevents watchdog / manual start until re-enabled; uninstall also stops the process first.
- **UI:** disabled add-ons show a clear “Disabled” badge; Start is blocked when the add-on is off.
- **Mosquitto (Linux):** `brew` install method uses `apt-get install mosquitto` on Linux; `run.sh` finds binaries under `/usr/sbin` and `/usr/bin`.
- **Updates:** release notes dialog works for all add-ons (not only Hyve self-update), with improved styling.

### Backup
- Broader archive coverage: full `skills/`, legacy JSON config files, encryption key path, Linux user-data paths.
- Installed add-on slugs merged from registry + filesystem for restore refetch.
- UI checklist in the backup panel; `refetch_addons` enabled by default on restore.

### Integrations
- **Fix:** “Test connection” no longer fails with `async_test_connection() got an unexpected keyword argument 'phase'` for integrations that do not support phased tests (e.g. Tapo).

### Tests
- `tests/test_addon_enable_lifecycle.py`, `tests/test_addon_brew_linux.py`, `tests/test_backup_coverage.py`, `tests/test_addon_release_notes.py`
- `tests/test_integration_config_entries_api.py` — phased vs non-phased test connection

## [0.9.7.9] — 2026-06

Patch release: **add-on install UX**, **Cloudflared version display**, and **Linux Docker bootstrap**.

### Add-ons
- **Cloudflared:** catalog version now resolves from GitHub releases (`cloudflare/cloudflared`) instead of showing the Docker tag `latest`.
- **Fix:** install log sub-page stays fixed on screen — background no longer scrolls behind `.app-subpage` overlays.
- **Linux:** Docker-based add-ons can auto-install `docker.io` via apt and start the daemon (Proxmox LXC still needs nesting).

### Tests
- `tests/test_addon_docker_bootstrap.py`, `tests/test_addon_version_resolve.py` — cloudflared GitHub version resolution

## [0.9.7.8] — 2026-06

Patch release: **Cloudflared add-on**, **save-config fix**, and **installer / add-on state** hardening.

### Add-ons
- **New:** Cloudflared add-on (`addons/available/cloudflared`) — Cloudflare Tunnel for remote Hyve access (token or local tunnel mode, Docker).
- **Fix:** Apps / Hub **Save configuration** button no longer silently no-ops (modal `open` class detection; shared `config_form` for collect/render).
- **Fix:** Docker add-ons (e.g. Cloudflared) no longer marked uninstalled after restart when Docker is slow or image uses `:latest` tag.
- **Cloudflared:** optional Cloudflare API sync for token mode (push origin URL from Hyve); LAN origin URL suggestions in UI.

### Installer
- **Fix:** `install_hyve.py --fresh` runs after venv/deps are ready (no `ModuleNotFoundError: core`).
- **Fix:** broken `.venv` without pip is detected and recreated automatically; `--recreate-venv` flag added.

### Tests
- `tests/test_cloudflared_addon.py`, `tests/test_cloudflared_config.py`, `tests/test_network_utils.py`
- `tests/test_addon_state_store.py` — docker daemon / cloudflared data-dir repair cases

## [0.9.7.7] — 2026-06

Patch release: **complete backup restore** and **auto page reload after restart**.

### Backup
- **Fix:** integration config entries (`config/integration_entries.sqlite`) are now included in `.hyvebak` archives — restores integrations, accounts, and their settings on a new server.
- **Auto-restart** after successful restore or rollback so Hyve reloads databases and config from disk.
- **Refetch add-on runtime** is enabled by default on restore (Docker/npm artifacts reinstalled).
- UI shows a restart message after restore; page reconnects automatically.

### Updates
- **Fix:** after a Hyve self-update, the browser polls until the server is back and **reloads the page** (same behavior as manual restart from Hub).

### Tests
- `tests/test_backup_roundtrip.py` — integration entries SQLite round-trip.
- `tests/test_backup_api.py` — restore schedules server restart.

## [0.9.7.6] — 2026-06

Patch release: **backup encryption key export** and **modal close fixes**.

### Backup
- **View / copy / download** the Fernet encryption key from Hub → Backup (admin API `GET /api/backup/encryption-key`).
- UI section under “Criptează arhivele” with key source hint and download as `backup_archive.key`.
- **Fix:** encryption-key and release-notes modals close correctly (X and backdrop) — they live outside `#view-config`.

### Tests
- `tests/test_backup_api.py` — encryption key export and missing-key error.

## [0.9.7.5] — 2026-06

Patch release: **backup migration** and **release notes button fix**.

### Backup
- **Restore encrypted archives on another server:** optional `decryption_key` on verify/restore/rollback API; UI modal prompts for the source server's Fernet key when opening `.hyvebak.enc`.
- Clearer error when decryption fails (wrong/missing key after import).

### Updates
- **Fix:** release notes button in Actualizări no longer crashes (`showUpdateReleaseNotes` handler signature).

### Tests
- `tests/test_backup_remote.py` — decrypt imported archive with explicit source key.

## [0.9.7.4] — 2026-06

Patch release: **Updates hub polish** — release notes modal, hub copy, backup UI trim.

### Updates
- **Release notes:** Hyve row in Actualizări has a notes button that opens a modal with GitHub release body (markdown) and link to the release page.
- **Hub:** Integrations card shows a descriptive subtitle instead of listing integration names.

### Backup
- **UI:** Remote backup section (S3/SFTP) hidden for now; backend and saved settings are preserved when saving other backup options.

## [0.9.7.3] — 2026-06

Patch release: **reliable in-app Hyve update** on git installs (Proxmox / self-hosted).

### Updates
- **Fix:** `apply_update()` refreshes GitHub/git tag info before checkout so stale cached releases (e.g. stuck on 0.9.7.0) no longer block upgrades.
- **Fix:** latest version is the max semver from GitHub Releases **and** remote git tags.
- **Fix:** dirty-tree guard ignores local rebuild outputs (`tailwind.built.css`, compiled `static/js/*.js`, `package-lock.json`) so server rebuilds do not block apply.

### Tests
- `tests/test_hyve_update.py` — semver resolution, dirty-tree ignore, apply refresh.

## [0.9.7.2] — 2026-06

Patch release: **fix in-app Hyve update button** (Actualizări hub).

### Updates
- **Fix:** `applyHyveUpdate` was exported but not registered in config event handlers — clicking upgrade on the Hyve row did nothing.
- Longer client timeout (5 min) while apply runs `git fetch`, `pip install`, and `js:build`.

### Tests
- `tests/test_updates_hyve_api.py` — apply endpoint happy path and error mapping.

## [0.9.7.1] — 2026-06

Patch release: **backup create fix**, **download/import archives** for server migration.

### Backup & restore
- **Fix:** backup create no longer treats add-on `.db` files (Mosquitto, Zigbee2MQTT JSON DB) as SQLite — only Hyve core DBs and real SQLite files use the online snapshot API.
- **Download** local archives via UI or `GET /api/backup/archives/download`.
- **Import** `.hyvebak` / `.hyvebak.enc` from another instance via UI or `POST /api/backup/archives/upload`, then restore as usual.

### Tests
- Non-SQLite add-on DB files included in round-trip backup test.
- API tests for download and upload endpoints.

## [0.9.7.0] — 2026-06

Feature release: **backup & restore (AAA)**, **remote targets (S3/SFTP)**, and **Hyve self-update** from GitHub Releases.

### Backup & restore
- **`.hyvebak` archives** with manifest, checksums, SQLite snapshot, and tiered data policy (`docs/adr/007-backup-restore.md`).
- **CLI** `scripts/hyve_backup.py` (create / verify / restore).
- **Admin API** `/api/backup/*`: create, verify, restore, rollback, settings, maintenance mode.
- **Scheduled backups** (daily/weekly/monthly at 03:00) with local retention and pre-restore safety snapshots.
- **Optional encryption** at rest (Fernet → `.hyvebak.enc`).
- **Remote upload** to S3-compatible storage or SFTP with remote retention.
- **Pull from remote** — list, download, and restore archives stored off-box.
- **Settings UI** — Hub card after Updates with local/remote archive management.

### Updates
- **Hyve self-update** via GitHub Releases (`core/hyve_update.py`): check, apply tag checkout, persist last check in config.
- Updates hub shows Hyve release info alongside add-on updates.

### Add-ons
- Persist **user-stopped** process flag across restarts (watchdog respects manual stop).
- Sanitize implausible version strings from GitHub/Docker metadata.
- Bidirectional **enabled** sync between integration entries and add-on state (`__hyve_meta` isolation).

### Integrations
- **Tapo:** Kasa SSL helper, improved connection/RTSP flow.

### Tests
- `tests/test_backup_*.py` — round-trip, API, retention, remote, encryption.
- `tests/test_hyve_update.py`, `tests/test_updates_check_persist.py`, Tapo and add-on sync tests.

## [0.9.6.4] — 2026-06

Patch release: **fix JS boot error** on fresh installs after 0.9.6.3.

### First-run / install
- **Fix:** remove stale `applyHyveUpdate` import from `app.js` (not exported in 0.9.6.3 `features.js`), which blocked the setup wizard with `Uncaught SyntaxError`.

## [0.9.6.3] — 2026-06

Patch release: **first-run setup wizard fix** (Proxmox / fresh install) and **installer improvements**.

### First-run / install
- **Fix:** stop infinite page reload with “session expired” before the setup wizard on fresh installs (401 redirect loop when no JWT was present).
- **Boot:** clear stale browser tokens when setup is incomplete; tolerate `/api/setup/status` failures and still show the wizard.
- **Installer (`install_hyve.py`):** run `npm run js:build`, print LAN URL (not only `127.0.0.1`), verify setup API after start, `--fresh` to reset wizard, stop stale PID before restart.

### Tests
- `tests/test_install_hyve.py` — installer URL / banner helpers.

## [0.9.6.2] — 2026-06

Patch release: **addon watchdog & reconcile fixes**, **Integrations list UI polish**, and **navigation back-stack** fix.

### Addons
- **Watchdog (HA-style):** 30s health checks, exponential backoff (30s → 480s), 1h pause after 6 consecutive failures — no tight restart loops on bad config.
- Watchdog toggle **persists immediately** (not only on Save); supervised addons require `installed + watchdog` only.
- **Mosquitto start:** merge `config_schema` defaults before resolving start args (fixes unresolved `{ws_port}` placeholders).
- **Frigate false “installed”:** artifact-based reconcile + startup repair when integration config points at a remote host without local Docker image.
- **Brew addons (Mosquitto):** detect Homebrew binary/version and restore installed state after reconcile.

### Integrations UI
- Catalog rows use the same **`hyd-entity-row`** card style as Devices (icons, typography, hover).
- Removed **Sync** from the catalog list — sync stays in the integration detail modal.
- Updated integration logos: **WAHA** (SVG), **SearXNG**, **Midea AC**, **Roborock**.

### Apps & navigation
- Fix **`[object Object]`** toast when addon start fails (API error detail translation).
- **Back navigation:** Integrations → device → entity → back ×2 returns to the integration page (not the Devices tab).

### Tests
- `tests/test_addon_watchdog.py` — backoff and long-pause behaviour.
- Extended addon state / home-automation tests for brew reconcile, watchdog persistence, Frigate repair.

## [0.9.6.1] — 2026-06

Patch release: **Devices list polish** and **sync-all** for integrations.

### Devices UI
- Device list cards use the same row layout as entity rows (square icon, domain subtitle, chevron).
- Removed active-state card glow/outline and icon text-shadow; ON/OFF shown via icon tone only.
- Removed inline toggle switches from list rows — control from detail/overview only.
- Hub-aligned surfaces and typography in `devices-ui.css` (no separate glass styling).

### Integrations
- **`POST /api/integrations/sync-all`** — resync all configured integrations in one request; partial/error aggregation.
- Devices page **Sync** button calls sync-all with spinner while in progress; success/partial/error toasts.

### Tests
- `tests/test_integrations_sync_all.py` — sync-all happy path and total-failure handling.

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
