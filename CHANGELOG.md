# Changelog

All notable changes to Hyve are documented here. Version format: `MAJOR.MINOR.PATCH` (no `v` prefix).

**Releases:** edit this file first, commit, then run `python scripts/publish_release.py` — GitHub release notes are taken from the matching `## [X.Y.Z]` section.

## [0.9.9.19] — 2026-06

Chat settings move from a cramped popup to a proper modal.

### UI — Chat
- **Change:** The chat bar cog now opens a centered modal using the same `app-modal` system as the rest of the app, instead of the tight popover. Thinking mode, model selection (full list with color dots), and the read-aloud toggle have room to breathe.
- **Change:** Model profiles are shown as a scrollable list inside the modal (color dots preserved) rather than a nested dropdown.
- Dismiss via the close button, backdrop click, or Escape. The chat bar profile glow and conditional voice/TTS controls are unchanged.

## [0.9.9.18] — 2026-06

Critical packaging fix so HTML/locale changes actually reach updated servers.

### Updates / Packaging
- **Fix:** Release tarballs now include `templates/` and `locales/`. Artifact-based self-update previously shipped new JS/CSS but kept the old server-rendered HTML, so the 0.9.9.17 chat changes (read-aloud in the cog menu, profile dropdown, bar glow) never appeared and could leave mobile Safari stuck on the loading screen. Updating to 0.9.9.18 ships the matching templates.
- **Hardening:** The artifact builder now fails fast if `templates/index.html`, `templates/partials/chat.html`, or `locales/en.json` are missing from a release.

## [0.9.9.17] — 2026-06

Chat bar settings menu: cleaner cog, profile dropdown, and voice controls only when configured.

### UI — Chat
- **Change:** Microphone (Whisper) and read-aloud (Piper) buttons stay hidden until the integration is enabled in settings.
- **Change:** “Read replies aloud” moved into the cog settings menu; removed from the input bar.
- **Change:** Cog button uses neutral styling — no longer tinted by the active model profile.
- **Change:** Model profiles are a dropdown inside the cog menu, with color dots preserved.
- **Change:** A modest glow around the chat input bar reflects the selected profile color.
- **Fix:** Cog menu sits slightly above the bar instead of flush against it.

## [0.9.9.16] — 2026-06

Safer first visit on mobile Safari, plus entity rename layout fixes.

### Boot / Auth
- **Fix:** App no longer stays on the loading screen forever on some iPhones at first visit. `localStorage` access is guarded when storage is blocked (private browsing / strict Safari settings), boot fetches have timeouts, and visitors without saved credentials go straight to login instead of waiting on auth polling.
- **Fix:** Boot progress no longer blocks on `/api/startup/status`; a watchdog and HTML failsafe surface login if startup stalls.

### UI — Smart Home / Integrations
- **Fix:** Renaming entities with very long IDs no longer breaks the layout on mobile — edit rows wrap correctly, inputs use a 16px font (no iOS zoom jump), and long values are not fully selected on focus.

## [0.9.9.15] — 2026-06

Tapo privacy mode now shows up as a switch.

### Integrations — Tapo / Cameras
- **Fix:** The **privacy mode (lens mask)** switch now appears for cameras that support it. python-kasa exposes it only as a module (not a feature), so it's surfaced explicitly like motion/person detection and is toggleable.

## [0.9.9.14] — 2026-06

Tapo cameras now expose their full capability set (privacy mode and more), plus PTZ refinements.

### Integrations — Tapo / Cameras
- **New:** Every python-kasa device feature is now exposed automatically instead of a fixed list — the **privacy mode / lens-mask** switch, flip, night-vision selector, image controls, energy sensors, etc. now appear and are controllable. The entity set tracks the device's real capabilities, so a re-sync surfaces anything previously missing.
- **New:** PTZ cameras expose **pan/tilt step** (number) and **PTZ preset** (select, jump to a saved preset).
- **Fix:** No more duplicate PTZ buttons — pan/tilt movement stays on the dedicated PTZ pad/buttons while the generic feature list keeps only the useful extras.

## [0.9.9.13] — 2026-06

Mammotion work-area zones now load automatically, and a Tapo RTSP probe fix for modern ffmpeg.

### Integrations — Mammotion
- **Fix:** Work-area zones (and the mowing-zone select) now populate automatically. The device map watchers (`setup_device_watchers`) are installed and an initial map/plan sync runs on connect, so zones no longer require a manual "Sync hartă" press. Zone enumeration is more robust (uses PyMammotion `computed_areas` with a hash-manifest fallback) and the UI refreshes as soon as a map fetch completes.

### Integrations — Tapo / Cameras
- **Fix:** RTSP validation and streaming no longer fail with a bogus "RTSP rejected" error on ffmpeg 5.0+. The removed `-stimeout` option is replaced with the version-aware `-timeout`, so valid camera credentials now pass the setup probe.

## [0.9.9.12] — 2026-06

Mammotion work-area selection and a Tapo camera setup fix.

### Integrations — Mammotion
- **New:** Work-area `select` entity (mowing zone picker) per mower, mirroring the Mammotion-HA integration. Choose **All zones** or a single mapped area; the choice drives mow start and route planning. Per-area switches remain available.

### Integrations — Tapo
- **Fix:** Camera setup no longer reports "Adresa IP este obligatorie." at step 2 — the IP and credentials entered at step 1 are now carried across wizard steps (and restored when navigating back).

## [0.9.9.11] — 2026-06

Daylight branding, settings UX, persistent login, and more reliable in-app updates.

### Updates — Hyve self-update
- **Fix:** Git-based apply no longer blocks on harmless local diffs (`core/settings.py`, `package.json`, theme CSS).
- **Fix:** Artifact metadata falls back to conventional GitHub release download URLs when the API is rate-limited.

### UI — Daylight theme
- **New:** Custom `hyve-logo-daylight.png` lockup on login, boot, and sidebar.

### UI — Canvas theme
- **Change:** Larger boot/loading screen logo.

### Settings
- **Change:** Assistant persona moved from General to **AI → Comportament AI**.
- **Change:** Timezone is a dropdown selector (same list as first-run setup).

### Auth
- **Change:** Longer-lived sessions (24h access token, 365-day refresh); login always persists refresh credentials for stay-logged-in behavior.

## [0.9.9.10] — 2026-06

Startup Hyve update check, climate card polish, and Canvas logo sizing tweaks.

### Updates — Hyve self-update
- **New:** Optional Hyve update check on server startup (`updates.hyve.check_on_startup`, default **on**). Toggle in Settings → Updates.
- **Change:** Startup check reuses the same GitHub release flow as scheduled checks (and respects auto-update if enabled).

### UI — Climate card
- **Fix:** Edit/delete controls visible in dashboard edit mode (no longer clipped by the carousel viewport).
- **Change:** Removed redundant HVAC status pill from the card header.
- **Change:** Temperature glow fades on all sides (not only horizontally).

### UI — Canvas theme
- **Change:** Smaller logo on login and boot screens.

## [0.9.9.9] — 2026-06

Canvas theme branding: custom logo lockup on login, boot, and sidebar.

### UI — Canvas theme
- **New:** Canvas theme uses the `hyve-logo-canvas.png` brand lockup (icon + HYVE) instead of the CSS-assembled mark and wordmark.
- **Change:** Logo asset is auto-cropped to content bounds — no extra empty space above or below on login or sidebar.

## [0.9.9.8] — 2026-06

Major updater redesign: pre-built release packages, safer apply, and release notes when an update is pending.

### Updates — Hyve self-update
- **Change:** Releases ship a pre-built `hyve-{version}.tar.gz` + SHA256 manifest on GitHub. Apply downloads the artifact, verifies checksum, updates code only (preserves config, databases, dashboards, `.env`), runs `pip install` + Alembic migrations, and rolls back on failure — no `npm build` on the server.
- **Change:** Git checkout remains as dev fallback when no release artifact exists.
- **Change:** Pre-update `.hyvebak` snapshot before artifact apply.
- **Change:** Scheduled Hyve update check + optional auto-update (Settings → Updates → Hyve).
- **Fix:** Release notes for a pending update now load from GitHub for the target version instead of showing empty/stale cached notes until after apply.

### Tooling
- **Change:** `scripts/build_release_artifact.py` and `publish_release.py` upload release assets automatically.

## [0.9.9.7] — 2026-06

Critical fix: the Zigbee/MQTT live bridge never started at boot, so device states were stale ("off") until manually toggled.

### Integrations — MQTT / Zigbee
- **Fix:** `components/mosquitto/lifecycle.py` imported a non-existent top-level `settings` module, so the lifecycle module failed to load and its `startup_all` hook (which boots the persistent MQTT bridge) was silently skipped. Now imports `core.settings`. Without the bridge there was no `/get` state refresh, no real-time MQTT listener, and no mirror nudges — the dashboard showed the last persisted snapshot forever.

### Tooling
- **Change:** Regression tests assert every shipped component lifecycle module imports cleanly and that mosquitto still exposes its bridge `startup_all` hook, so a broken import can't silently disable an integration again.

## [0.9.9.6] — 2026-06

Patch release: reliable Zigbee/MQTT state on boot and live updates, plus a modern responsive climate card.

### Integrations — MQTT / Zigbee
- **Fix:** Startup bootstrap no longer wipes persisted Z2M states with a sparse broker probe — force sync uses pull (live bridge + SQLite) when devices are already known.
- **Fix:** Probe merges fresh discovery with stored states instead of replacing them.
- **Fix:** MQTT bridge waits until connected before integrations boot; mirror nudge reschedules on bursty updates; states persist after Z2M `/get` refresh.
- **Fix:** Real-time MQTT listener builds its topic map from the live bridge when the entity mirror snapshot is not ready yet.

### Dashboard — climate card
- **Change:** Redesigned `<hv-card-climate>` with hero temperature, HVAC mode pill, mode-colored accents, and glass-style setpoint/mode controls.
- **Change:** Responsive layout for all grid sizes (1-row compact through tall/wide cards) via container queries and `data-dashboard-rows` / `data-dashboard-cols`.

### Tooling
- **Change:** Mosquitto refresh tests for force-pull on populated cache and probe/state merge.

## [0.9.9.5] — 2026-06

Patch release: fixes cameras and dashboard history charts that returned 422 since the 0.9.8.27 security hardening.

### Cameras / dashboard
- **Fix:** `/api/cameras/stream-token` and `/api/dashboard/history/batch` rejected every request with `422 Unprocessable Content`. The slowapi `@limiter.limit` decorator combined with `from __future__ import annotations` left the Pydantic body type unresolved, so FastAPI parsed the JSON body as a phantom query param. Cameras now stream and sparkline charts load again.

### Tooling
- **New:** Regression tests asserting rate-limited body endpoints parse a valid body (must not 422) and report validation errors against the `body`, not a `query` field.

## [0.9.9.4] — 2026-06

Patch release: longer-lived sessions with reliable silent refresh, and camera stream auth hardening.

### Auth / sessions
- **Fix:** Boot no longer wipes the refresh token before attempting renewal — expired access tokens recover silently instead of forcing login.
- **Fix:** Unified JWT refresh (single-flight) — dashboard layout fetch no longer races `/api/token/refresh` and invalidates sessions across tabs.
- **Fix:** Proactive session refresh every 90 minutes and on tab focus while logged in.
- **Change:** Default access token lifetime 8 h (was 4 h); refresh token 30 days (was 7 days), overridable via `HYVE_ACCESS_TOKEN_MINUTES` / `HYVE_REFRESH_TOKEN_MINUTES`.
- **Change:** “Remember me” checked by default on the login form.

### Cameras
- **Fix:** Camera/media stream tokens require an active JWT — no requests while logged out (stops 401/422 spam).
- **Fix:** Validate `camera.*` / `image.*` entity ids before `stream-token`; stop snapshot retry loop on errors.
- **Fix:** `hv-camera-stream` waits for auth and re-starts after `hyve:auth-changed`.

### Tooling
- **New:** API contract tests for camera/media `stream-token` auth and validation.

## [0.9.9.3] — 2026-06

Patch release: fixes double `/static/dist/` chunk 404s (regression from 0.9.9.2), dashboard initial entity state, and camera stream guards.

### Dashboard — fixes
- **Fix:** Remove chunk URL rewrite from `fix-dist-imports.mjs` — Vite `base` already prefixes `/static/dist/`; double prefix caused lazy module 404s (`/static/dist//static/dist/chunks/...`).
- **Fix:** Load entity states on dashboard boot when cache is empty (Zigbee lights/switches no longer show `unknown` until toggled).
- **Fix:** Re-bootstrap Hyveview card states after WebSocket entity snapshot.

### Cameras
- **Fix:** `hv-camera-stream` skips refresh when `entity` is missing or whitespace (reduces `stream-token` 422 spam).

### Tooling
- **Change:** `tests/test_fix_dist_imports.py` asserts relative chunk deps (no absolute `/static/dist/chunks/` in preload list).

## [0.9.9.2] — 2026-06

Patch release: MQTT/Zigbee state sync survives restarts, lawn mower card renders, and frontend chunk/auth fixes.

### Integrations — MQTT / Zigbee
- **Fix:** Control from Hyve updates local MQTT state immediately (optimistic persist + mirror refresh) so lights/relays stay correct after restart.
- **Fix:** MQTT bridge hydrates last saved states from SQLite on connect and flushes on shutdown (no more stale OFF after quick restarts).
- **Fix:** Relay/switch states normalize `ON`/`OFF` to `on`/`off` for live UI and WebSocket diffs.

### Dashboard — fixes
- **Fix:** Lawn mower card type registered in dashboard shell renderer (add/save no longer produces an invisible card).
- **Fix:** Widget save errors always show a toast (403/network no longer fail silently).
- **Fix:** Vite `base: '/static/dist/'` + chunk path rewrite — stops `/chunks/*.js` 404s after build.
- **Fix:** Skip `/api/dashboard/card-packages` when logged out; guard camera `stream-token` without `entity_id`.

### Tooling
- **Change:** Release gate runs `npm run js:build`.
- **New:** `tests/test_fix_dist_imports.py`, `tests/test_mosquitto_optimistic_state.py`.

## [0.9.9.1] — 2026-06

Patch release: dashboard live sync, edit-mode banner, lawn mower cards, and more-info polish.

### Dashboard — fixes
- **Fix:** Entity more-info and history modals — close (X) button works again (click no longer swallowed by overlay handler).
- **Fix:** More-info Overview tab hides attributes and raw JSON (reserved for the Attributes tab).
- **Fix:** Camera background streams pause only for `camera` / `image` entities; streams resume when the modal closes.
- **Fix:** Edit-mode banner styling — sticky “Done” bar with proper glass/accent button (was unstyled).
- **Fix:** Lawn mower card routing — `lawn_mower` domain resolves to the dedicated card (not generic info).
- **Fix:** Live entity sync — EntityMirror no longer drops WebSocket push targets after a transient delivery error.
- **Fix:** Hyveview card `setState` uses entity-id aliases (Z2M expose vs discovery naming).

### Dashboard — editor
- **New:** Per-card YAML section in the Hyveview add/edit modal (reload from form, round-trip on save).

### i18n
- **New:** `dashboard.interactions.card_yaml_*` keys (EN/RO).

## [0.9.9.0] — 2026-06

Configurable dashboard card interactions (tap / double-tap / hold), history modal, and YAML editing.

### Dashboard — card interactions
- **New:** Per-card gestures (`tap`, `double_tap`, `hold`) with smart defaults per domain/renderer (toggle, more-info, history chart, domain actions).
- **New:** Gesture engine — tap, double-tap, hold with haptic feedback; keyboard Enter/Space support.
- **New:** Entity **more-info** modal on dashboard (Overview / History / Attributes tabs).
- **New:** **History** modal with range selector (1h–7d), chart, and stats; shared chart renderer for sparklines.
- **New:** `perform_action` for scenes, locks, vacuums, lawn mowers; optional toggle confirmation.
- **New:** `navigate` (dashboard page) and `url` (external link with confirm) actions.
- **New:** Interactions section in Hyveview card editor with live preview and reset-to-defaults.
- **New:** Page YAML export/import hoists `interactions` at card level; only non-default overrides are written.

### Security & API
- **New:** History API ACL — only entities on the user's dashboard pages (`403` off-dashboard).
- **New:** Rate limit on dashboard history endpoints (30/minute).

### i18n & docs
- **New:** `dashboard.interactions.*` translation bundle (EN/RO).
- **Docs:** Card interactions section in `docs/CARDS_AND_INTEGRATIONS.md`.

## [0.9.8.27] — 2026-06

Security hardening, dashboard fixes, and settings UX.

### Security
- **New:** First-time setup requires a one-time token (`secrets/setup_token`); server binds to `127.0.0.1` until setup completes.
- **New:** Camera ACL — admins see all cameras; other users only entities referenced on their dashboard pages.
- **Fix:** Camera stream tokens are scoped per `entity_id`; media proxy/favicon uses a separate token type.
- **Fix:** Removed Assist loopback auth bypass (`assist_default_user_id`).

### Dashboard
- **Fix:** Profile page tabs — only the active panel is visible (`.hidden` no longer overridden by flex layout).
- **Fix:** Entity card — toggle domains no longer show a redundant right-side switch on the tile.
- **Fix:** Widget delete/add on multi-page dashboards — `page_id` is sent correctly; broken legacy fallback no longer fakes success.
- **Fix:** Custom FA/MDI icons on cards — `mdi:…` and short `fa-…` forms normalize to valid CSS classes.

### Frontend
- **Fix:** Hub → Settings **Salvează** button — delegated click no longer treats `document` as the save button.
- **UI:** Updates hub and Settings → Actualizări tab document **Hyve + add-ons** (Hyve version block, link to update page).
- **UI:** Setup wizard accepts setup token; camera auth uses scoped tokens on the client.

## [0.9.8.26] — 2026-06

Security hardening (post audit).

### Security
- **Fix:** Tapo/Frigate camera entities no longer expose `rtsp_url`, internal snapshot/MJPEG URLs, or embedded credentials in dashboard/API payloads (server still resolves streams internally).
- **Fix:** Camera stream JWTs can be scoped per `entity_id`; leaked tokens no longer unlock all cameras.
- **Fix:** Agent `file_read` blocks `.env`, `config.json`, `secrets/`, `.secret_key`, and related paths.
- **Fix:** Addon docker/apt install no longer uses shell-interpolated commands (command injection via custom manifests).
- **Fix:** Logout revokes refresh tokens (sent in POST body).
- **Fix:** go2rtc WebSocket uses short-lived camera tokens instead of the 4h access JWT.
- **Change:** Mosquitto addon defaults `allow_anonymous` to **false** (new installs).
- **Change:** OpenAPI `/docs` disabled when `HYVE_ENV=production` / strict startup (override: `HYVE_OPENAPI_DOCS=1`).

## [0.9.8.25] — 2026-06

Dashboard: **Entity** card (HA-style), legacy preset cleanup, **light** card redesign.

### Dashboard
- **New:** `entity` card — universal preset; UI auto-routes by domain (sensor, light, switch, number, select, climate, lock, etc.).
- **Removed:** Legacy picker presets (`button`, `info`, `switch_tile`, `sensor_tile`, `scene`, `tile`, dedicated `light`/`sensor`/`number`/`select` entries). Saved widgets with old types migrate to `entity` on load/save.
- **Redesign:** `light` card — large brightness readout, icon glow, modern slider with 0–100% bounds (used automatically for `light.*` via entity routing).
- **New:** `number` / `select` renderers (entity-routed only) — slider and dropdown controls.

## [0.9.8.24] — 2026-06

Hotfix: **dashboard page creation** (500 on `POST /api/dashboard/pages`).

### Dashboard
- **Fix:** Missing imports for `_page_slug` / `_unique_page_id` caused `NameError` when creating a new page from the UI.

## [0.9.8.23] — 2026-06

Hotfix: **Mosquitto sync after save** and **addon detail config UI**.

### Integrations
- **Fix:** Mosquitto — Test found devices but Save/sync showed none: manual sync and partial cache now re-run full broker discovery (`probe`) instead of a light bridge pull; bridge fallback probes when its cache is still empty; entity cache invalidated after entry save/resync; MQTT bridge restarted after entry update.

### Frontend
- **Fix:** Addon detail — settings fields and Detect (e.g. Zigbee2MQTT serial port) work while admin profile is still loading; config event bindings cover addon detail/modal; custom selects re-init after detail render.

## [0.9.8.22] — 2026-06

Hotfix: **mobile viewport safe areas** and **Skills hub width**.

### Frontend
- **Fix:** Mobile browser — HA-style safe-area handling (`--safe-area-inset-*` from `visualViewport` + `env()`); shell uses body padding instead of height shrink, so bottom toolbar no longer overlaps sidebar/footer and no gap appears above it.
- **Fix:** Skills page width matches other Hub pages — `hyd-config-page { max-width: 100% }` no longer overrides `hyd-hub-shell` on the same element.

## [0.9.8.21] — 2026-06

Patch release: **Skills width, Updates copy, mobile gap, Profile UI**.

### Frontend
- **UI:** Skills page uses the same hub content width as Settings (`hyd-hub-shell`).
- **Fix:** Updates page shows correct status text — “Nicio actualizare disponibilă” / “Totul e la zi” instead of “Niciun add-on instalat”; no misleading empty state while checking.
- **Fix:** Mobile browser — removed bottom gap above toolbar (shell stays full height; scroll padding only).
- **UI:** Profile page aligned with Hub design (`hyd-mast`, `hyd-chips`, `hyd-app-card`).

## [0.9.8.20] — 2026-06

Hotfix: **Hub touch scroll on mobile**.

### Frontend
- **Fix:** Restore vertical scroll in Hub on phone — `#view-config` had `overflow-y: hidden` (0.9.8.19) which blocked swipe scrolling on the hub grid and settings; standalone subpages get a stronger flex scroll chain for iOS (`touch-action: pan-y`).
- **UI:** Hub standalone pages and subpages use the same content width as Settings (`max-w-5xl`, 80rem on desktop).
- **Fix:** Mobile browser UI (bottom search/toolbar) no longer covers sidebar links or page footers — shell height follows `visualViewport` with dynamic bottom inset.
- **Fix:** Updates page release notes — `publish_release.py` upserts GitHub releases (edit if tag exists); Hyve notes fall back to `CHANGELOG.md`; version-specific notes no longer pull the wrong older GitHub release body.

## [0.9.8.19] — 2026-06

Patch release: **Hub titles, Blueprints, Daylight accent buttons**.

### Frontend
- **Fix:** Hub standalone pages show the correct title (not always “Integrări”) — removed conflicting `data-i18n` and re-apply dynamic title after translations.
- **UI:** Removed hub mast subtitles so title aligns with refresh/+ actions on the right.
- **UI:** Hide vertical scrollbar on hub scroll areas while keeping touch scroll.
- **Fix:** Blueprint picker buttons work from Hub — event scope includes moved subpage modal; mast actions match Devices pattern.
- **Fix:** Automation editor subpage relocates under `#view-config` for correct overlay from Hub.
- **Fix (Daylight):** Solid blue buttons (`hyd-mast__action-btn--accent`, `hyd-btn--glow`, `bg-accent`) use white text; narrowed `header button` override to top app bar only.

## [0.9.8.18] — 2026-06

Patch release: **chat works again**, **semantic memory embeddings download**, Hub UI polish.

### Backend
- **Fix:** `/api/chat` no longer returns 422 — removed broken `BackgroundTasks` param incompatible with postponed type annotations.
- **Fix:** WAHA webhook and integration entry create/update no longer treat `BackgroundTasks` as a required query param.
- **Fix:** Memory embeddings can download from HuggingFace on first use — removed forced `HF_HUB_OFFLINE=1`; added `librarian.offline_only` config and `scripts/prefetch_embedding_model.py`.
- **Install:** `install_hyve.py` prefetches embedding models after pip install (`--skip-embeddings` for air-gapped).

### Frontend
- **Fix:** Chat shows real API errors (auth expired, etc.) instead of generic “Server Error”.
- **UI:** Hub refresh buttons spin on click across config/memory/skills sections.
- **UI:** Scene editor entity rows mobile-friendly; mast +/refresh buttons normalized.
- **UI:** Integration detail — icon inline with title, full description panel like add-ons.
- **UI:** Cloudflared token banner readable on Daylight theme (`hyd-callout--warning`).

## [0.9.8.17] — 2026-06

Hotfix: **single back navigation on add-on detail** and mobile overflow on add-on pages.

### Frontend
- **Fix:** Add-on detail hides the Hub mast back arrow — one back button returns to the add-on list (Devices pattern).
- **Fix:** Hub `closeSection` walks sub-views first (add-on detail, log modals, editors) before leaving the section.
- **Fix:** Mobile horizontal scroll on add-on detail — clipped overflow, wrapped metadata/button rows, stacked serial-detect controls.

## [0.9.8.16] — 2026-06

Hotfix: **Hub mast actions actually render** — static HTML + synced JS build pipeline.

### Frontend
- **Fix:** Scene / Zone / Automations / Updates mast buttons live in `config.html` (Devices layout); JS only toggles the active group instead of wiping `innerHTML`.
- **Fix:** Stale `static/js/ui.js` no longer cleared mast actions on every hub navigation.
- **Build:** `npm run js:build` runs `tsc` before Vite so emitted `.js` beside `.ts` stays in sync.

## [0.9.8.15] — 2026-06

Patch release: **Hub mast actions and updates page** — icon toolbar like Devices, release notes, layout on mobile.

### Frontend
- **Fix:** Scene / Zone / Automations hub pages show refresh + add icons in the standalone masthead (Devices pattern).
- **Fix:** Config standalone pages use full-height scroll shell (header fixed, body scrolls) — fixes vertical clipping on mobile add-on detail.
- **Fix:** `.hyd-btn.hidden` respected — updates «upgrade all» no longer shows when nothing to update.
- **UI:** Updates page — check = refresh icon only in mast; batch upgrade = icon, visible only when add-on updates exist.
- **Fix:** Release notes button always shown per Hyve/add-on row after list render; notes modal opens with body or GitHub link.

## [0.9.8.14] — 2026-06

Hotfix: **Hub config layout** — settings tabs and list pages no longer stack all panels; empty states match Devices masthead pattern.

### Frontend
- **Fix:** `.hyd-config-page` / `.hyd-list-placeholder` no longer override Tailwind `.hidden` — settings tabs show one panel at a time; ghost empty panels below populated lists are gone.
- **Fix:** Hub standalone navigation restores moved panels when switching sections or returning to Setări.
- **UI:** Scenes, areas, and automations empty states are text-only; **+** / refresh actions stay in the masthead (like Devices).
- **Fix:** Scene/area editor modal inputs — restore broken Tailwind classes from the P3b cleanup.

## [0.9.8.13] — 2026-06

Patch release: **P3b UI consistency complete** — Hub/config aligned to Devices pattern; sub-page modals and chat composer polished.

### Frontend
- **UI (P3b):** Config hub pages use `hyd-mast`, `hyd-config-page`, `hyd-app-card`, `hyd-entity-row` across Memorii, Setări, Skills, Logs/Backup/Updates, automation editor, blueprint picker.
- **UI:** Config sub-pages (addon config, profile editor, integration config, app logs, skills edit) → `hyd-mast` headers + `hyd-btn` footers.
- **UI:** Theme-aware form fields scoped to `#config-detail` and config sub-page modals; removed legacy `bg-slate-900` utilities from templates.
- **UI:** Chat composer + model selector — `hyd-chip--menu` thinking mode, `hyd-entity-row` profile list, theme tokens on input bar.
- **Fix:** Dashboard cog menu direct binding; edit-mode banner sync; Hyveview card editor searchable entity field.

## [0.9.8.12] — 2026-06

Hotfix: **Hyveview 404 on lang bundle** after dashboard card editor / custom selects build.

### Frontend
- **Fix:** `static/hyveview/js/utils.js` no longer bundles `utils.js` with a machine-specific `lang/index.js` path (404 as `/static/hyveview/opt/hyve/static/js/lang/index.js` on Linux).
- **Fix:** `custom_selects/generic.ts` inlines HTML escaping — Hyveview schema dropdowns no longer pull the full app `utils` module.
- **Fix:** `fix-hyveview-imports.mjs` rewrites any stray `lang/index` imports to `/static/dist/lang.js` and removes orphan `hyveview/js/utils.js`.

## [0.9.8.11] — 2026-06

Patch release: **custom dropdowns work again**, config hub list pages match Devices UI, backup includes memory log, Zigbee2MQTT adapter setting.

### Frontend
- **Fix:** Custom selects (`dashboard-custom-select`, Devices `hy-picker`) — portaled menus keep visibility via `--portaled` CSS; remove stale `static/js/custom_selects/*.js` that shadowed TypeScript sources in Vite builds.
- **Fix:** Unified dropdown handler for all `[data-target]` overlays (settings, add-ons, integrations, memory log filter).
- **Fix:** Devices filter pickers portal menus to `document.body` (no longer clipped by `overflow: hidden`).
- **Fix:** «Scenă nouă» opened the wrong handler (delegated `openSceneEditor` argument order).
- **UI:** Scenes, Areas, and Automations standalone pages use Devices-style masthead, search, and `hyd-entity-row` list rows.

### Add-ons
- **New:** Zigbee2MQTT config field `adapter` (default `ember` for Sonoff ZBDongle-E); written into `configuration.yaml` on start.

### Backup
- **New:** `memory_log.sqlite` included in critical backup tier and optional ChromaDB snapshot copy.
- **UI:** Backup settings label «Include faptele de memorie AI (ChromaDB)» clarified.

### Tests
- `test_backup_includes_memory_log_sqlite`, Zigbee2MQTT adapter manifest/run tests.

## [0.9.8.10] — 2026-06

Hotfix: **Mammotion viewer-blocked loop** — one Agora session per entity, no duplicate card fights.

### Frontend
- **Fix:** Opening the entity detail modal pauses dashboard/background Mammotion streams; closing resumes them.
- **Fix:** Dashboard Mammotion card no longer uses `force-active` (was streaming while off-screen and blocking other viewers).
- **Fix:** Hidden/detached peer viewers are preempted instead of permanently blocking connect (`viewer-blocked` spam).
- **Fix:** `user-published` no longer ignored before `_channelJoined` is set; video host sizing improved.

## [0.9.8.9] — 2026-06

Hotfix: **Mammotion reconnect loop** — stop re-waking the mower on every Agora retry.

### Frontend
- **Fix:** Reconnect uses `/mammotion/keepalive` (token refresh) instead of `/mammotion/start` unless the publisher left or tokens expired — avoids join/leave storms and Agora WebSocket abort spam.
- **Fix:** Aborted Agora joins no longer leave the card stuck in “connecting”.
- **Fix:** Clear message when another card already holds the live viewer session.

### Backend
- **Fix:** `start_mammotion_camera` publisher wait increased to 3s before returning tokens.

## [0.9.8.8] — 2026-06

Hotfix: **Mammotion Agora connect** — stop join/leave races that abort WebSocket before connect.

### Frontend
- **Fix:** Mammotion camera join lifecycle matches HA `agora-client.js` — single leave before join, `_connectOpId` instead of double `_leaveClient`, settle delay after leave, clearer stream event logs.
- **Fix:** Stuck peer viewers on the same entity are torn down instead of blocking connect forever.

### Backend
- **Fix:** `start_mammotion_camera` waits 2.5s after mower wake before returning Agora tokens (publisher join time).

## [0.9.8.7] — 2026-06

Patch release: **permanent in-app update hygiene** — central runtime-artifact rules + CI gate.

### Hyve self-update
- **New:** `core/update_git_tree.py` — single classifier for safe runtime dirty paths (`__pycache__`, `.pyc`, `static/dist/`, `static/hyveview/`, legacy `static/js/*.js`, caches, logs, etc.).
- **New:** Before each update, Hyve auto-resets all paths classified as runtime artifacts (`git checkout --`), then only blocks on real source edits.
- **New:** `scripts/check_tracked_artifacts.py` + release/CI check — fails if `__pycache__`, `.pyc`, or `static/dist/` are accidentally committed again.

## [0.9.8.6] — 2026-06

Hotfix: **in-app update** no longer blocked by Python `__pycache__` / `.pyc` files.

### Hyve self-update
- **Fix:** Ignore and auto-reset dirty `__pycache__/` and `*.pyc` paths during update checks (runtime bytecode cache).
- **Fix:** Remove accidentally tracked `custom_components/demo_sensor/__pycache__/entity.cpython-313.pyc` from the repo.

## [0.9.8.5] — 2026-06

Hotfix: **Vite chunk import paths** — fixes broken lazy modules, Mammotion camera, and add-ons UI.

### Frontend
- **Fix:** Lazy chunks imported `../static/dist/lang.js`, which browsers resolved to `/static/dist/static/dist/lang.js` (404). All `static/dist/**/*.js` outputs now use absolute `/static/dist/lang.js` imports (`scripts/fix-dist-imports.mjs` + Vite `generateBundle` hook).
- **Fix:** Resolves `features_apps-*.js` dynamic import failures and `Funcția nu s-a putut încărca` when navigating between config sections.

## [0.9.8.4] — 2026-06

Patch release: **reliable in-app updates** and **add-on UI i18n refresh**.

### Hyve self-update
- **Fix:** Before checking the git tree, auto-reset ignored build artifacts (`static/hyveview/`, `static/dist/`, `static/js/*.js`, `*.js.map`, `tailwind.built.css`, `package-lock.json`) so `npm run js:build` no longer blocks updates.
- **Fix:** Ignore tracked `static/**/*.js.map` source maps in dirty-tree checks.
- **Fix:** Dirty-tree API errors append blocking file paths even when the UI string omits `{detail}`.

### Frontend
- **Fix:** Add-ons settings list and Updates panel re-render when `/api/i18n/bundles` finishes loading (`hy.addon_*`, `apps.*`, `updates.*`).

### Tests
- `tests/test_hyve_update.py` — ignored-path reset and `.js.map` coverage.

## [0.9.8.3] — 2026-06

Patch release: **Mammotion camera** — shared i18n bundle, stream reconnect stability, and theme-aware play button.

### Frontend
- **Fix:** Mammotion card showed raw i18n keys (`mammotion_press_play`) — app and Hyveview now share one `/static/dist/lang.js` module so `/api/i18n/bundles` merges apply to camera cards.
- **Fix:** Mammotion Agora live view — avoid autoplay/reconnect races (`_reconnectQueued`, `_connectGen`), stale `join()` abort after `leave()`, and refresh hint text when bundles load.
- **Fix:** Mammotion play button and hint use theme CSS variables (`--accent`, `--text-on-accent`, `--camera-footer-fg`) instead of hardcoded colors.

### Hyve self-update
- **Fix:** In-app update no longer blocks on local `config.json`, `static/hyveview/` rebuild outputs, or other server-specific dirty paths.
- **New:** Dirty-tree error lists the blocking file paths (`{detail}`).

### Tests
- `tests/test_hyve_update.py` — expanded dirty-tree ignore coverage.

## [0.9.8.2] — 2026-06

Patch release: **Scenes & Zones UI** — modal buttons, missing i18n bundles, and scene editor open action.

### Frontend
- **Fix:** Area editor modal is moved to `document.body` for overlay — config delegated handlers now include scene/area modals and entity pickers in scope (Save, Cancel, Add entities work again).
- **Fix:** `openSceneEditor` handler registered — “New scene” and edit buttons open the editor.
- **Fix:** Bundled translations (`scenes.*`, `apps.*`, `hy.*`) — `resolveAuthToken()` for `/api/i18n/bundles`; dynamic lists re-render on `hyve:i18n-bundles-loaded`.
- **Fix:** `api.js` exports `resolveAuthToken()` (sync with `api.ts`) for Vite shared bundle.

### Tests
- `tests/test_bundled_i18n.py` — platform `scenes` namespace in bundles.

## [0.9.8.1] — 2026-06

Patch release: **post-update stability** — shared auth token, safer in-app updates, Mammotion Agora session race.

### Frontend
- **Fix:** Hyveview and main app shared the same `api.js` module with separate JWT state — cameras and card-packages returned 401 after login; `resolveAuthToken()` reads `localStorage` on every request.
- **Fix:** Custom dropdowns — explicit load of `generic.js` click handlers in app entry.
- **Fix:** Mammotion live view — avoid tearing down an in-flight Agora join when two cards share one entity; teardown on `entity` change; quieter subscribe errors after `leave`.

### Hyve self-update
- **Fix:** In-app update requires `npm` and runs `npm ci && npm run js:build` before restart; rolls back git on build failure.
- **New:** Update status shows frontend prerequisites and manual build commands in UI/i18n.
- **New:** Startup warns when `static/dist/app.js` is missing.

### Tests
- `tests/test_hyve_update.py` — npm preflight, rollback on frontend build failure, prerequisites in status.

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
