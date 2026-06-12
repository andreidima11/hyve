# Hyve

Self-hosted smart home hub with an integrated AI assistant. One FastAPI process serves the web UI, device integrations, automations, dashboards, and chat — with a built-in LLM agent for control, memory, and skills.

**Current version:** 0.9.6.1

## Features

- **Dashboard** — customizable grid with Hyveview cards, live entity state over WebSocket
- **Smart home** — unified device list from many integrations (MQTT, Roborock, Midea, Reolink, Tapo, Open-Meteo, and more)
- **AI chat** — streaming assistant with tools (device control, web search, memory, skills, planner)
- **Automations** — YAML automations with visual editor and blueprints
- **Memory** — long-term facts in ChromaDB and reminders
- **Integrations** — declarative config entries, encrypted secrets, periodic sync
- **Add-ons** — optional bundled or custom services (MQTT broker, Whisper, Piper, etc.)
- **Android app** — native shell in `android/HyveBridge/` (WebView + background services)
- **i18n** — English and Romanian UI

## Requirements

- Python 3.13+
- Node.js 18+ (Tailwind CSS build only)
- SQLite (default), optional ChromaDB data dir (`chroma_db/`)
- LLM backend: Ollama, OpenAI-compatible API, or configured provider in `config.json`

## Installation

### Option A — Guided installer (recommended)

The installer creates a virtual environment, installs Python and Node dependencies, generates `.env` / `config.json`, and starts the server.

```bash
git clone https://github.com/andreidima11/hyve.git
cd hyve
python3 scripts/install_hyve.py
```

When the server is ready, open `http://localhost:8082` (default port). The **browser setup wizard** runs on first visit:

1. **Step 1** — create the admin account (username + password, min. 8 characters)
2. **Step 2** — choose UI language (English / Romanian), timezone, and home name

You are logged in automatically when setup finishes.

Useful installer flags:

| Flag | Purpose |
|------|---------|
| `--port 8082` | HTTP port (default `8082`) |
| `--no-start` | Install dependencies only; start manually with `python main.py` |
| `--skip-npm` | Skip Node.js / Tailwind build (use committed CSS) |
| `--no-open-browser` | Do not open the browser automatically |
| `--bootstrap-admin USER PASS` | Headless/Docker: create admin and skip the browser wizard |

Examples:

```bash
# Install only, then start yourself
python3 scripts/install_hyve.py --no-start
source .venv/bin/activate   # or: source venv/bin/activate
python main.py

# Docker / NAS without a browser
python3 scripts/install_hyve.py --no-start --bootstrap-admin admin 'your-secure-password'
python main.py
```

### Option B — Manual install

```bash
git clone https://github.com/andreidima11/hyve.git
cd hyve

# Python
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Secrets (never commit .env)
cp .env.example .env
# Set HYVE_SECRET_KEY — install_hyve.py generates one if missing

# Frontend CSS (optional if tailwind.built.css is already present)
npm install
npm run css:build
npm run js:build

# Run — config.json is created on first start
python main.py
```

Open `http://localhost:8082`. Complete the browser setup wizard on first visit.

### Headless admin (no browser wizard)

For servers without a GUI browser (Docker, SSH-only, CI):

```bash
source .venv/bin/activate
python scripts/bootstrap_admin.py \
  --username admin \
  --password 'change-me' \
  --full-name Admin \
  --mark-setup-complete
python main.py
```

`--mark-setup-complete` skips the onboarding overlay. Use a password of at least 8 characters.

### After installation

| Task | How |
|------|-----|
| Change port | Edit `port` in `config.json` or reinstall with `--port` |
| Add LLM (Ollama, OpenAI, …) | Settings → AI in the web UI, or edit `config.json` |
| Add integrations | Settings → Integrations |
| Run tests | `PYTHONPATH=. pytest tests/` |
| Frontend typecheck | `npm run js:check` |
| Dev mode | `HYVE_DEV=1 python main.py` |

### Troubleshooting

- **Port in use** — change `port` in `config.json` or pass `--port` to the installer.
- **Setup wizard does not appear** — an admin user may already exist; log in or reset the `users` table on a fresh install.
- **CSS looks broken** — run `npm install && npm run css:build`.
- **JS changes not showing** — run `npm run js:build` after editing `.ts` files in `static/js/`.
- **Server logs** — `logs/install-server.log` when started via `install_hyve.py`; otherwise check the terminal running `main.py`.

## Configuration

| File | Purpose |
|------|---------|
| `.env` | Secrets and env overrides (`HYVE_SECRET_KEY`, WAHA, FCM path) |
| `config.json` | Main app config: LLM, integrations, UI language, ports (**local only, gitignored**) |
| `assist_keys.json` | Assist API keys (**gitignored**) |
| `secrets/` | Firebase / service account JSON (**gitignored**) |
| `automations/` | Automation YAML on disk |
| `custom_components/` | Drop-in integrations (see `custom_components/README.md`) |
| `custom_addons/` | User-installed add-ons |

Database migrations run automatically at startup via Alembic (`migrations/`).

## Development

```bash
# Tests
PYTHONPATH=. pytest tests/

# Dev server with env flag (disables some production caches)
HYVE_DEV=1 python main.py
```

### Frontend TypeScript

Sources live in `static/js/**/*.ts`; the browser loads emitted `.js` beside them (same import paths). i18n dictionaries stay plain JS in `static/js/lang/`.

```bash
npm install
npm run js:check    # strict typecheck (no emit)
npm run js:build    # compile .ts → .js after edits
npm run js:watch    # rebuild on save
```

CI runs `npm run js:check`, `npm run js:build`, and pytest on every push/PR.

### Project layout (short)

```
core/http/          FastAPI app factory, routers, lifespan
routers/            HTTP API modules
integrations/       Entity providers + config entries
components/         Bundled integration packages
brain/              AI agent (cortex, toolbox, memory)
static/js/          ES module frontend (app.js, dashboard, chat)
static/hyveview/    Dashboard card web components
templates/          Jinja2 shell (index.html)
android/HyveBridge/ Android client
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

### Adding an integration

See [docs/INTEGRATION_GUIDE.md](docs/INTEGRATION_GUIDE.md) and [docs/CARDS_AND_INTEGRATIONS.md](docs/CARDS_AND_INTEGRATIONS.md).

## Android

Build the native wrapper from `android/HyveBridge/` with Android Studio. Point the app at your server URL in settings. See Gradle `versionName` for the mobile release tag (kept in sync with `settings.RELEASE_VERSION` via `scripts/bump_version.py`).

## Version bump

```bash
python scripts/bump_version.py 0.7.2
```

Updates `core/settings.py`, `package.json`, Android `versionName`, and this README version line.

## Security notes

- Do **not** commit `config.json`, `.env`, `assist_keys.json`, or anything under `secrets/`.
- Use a strong `HYVE_SECRET_KEY` in production.
- Admin-only routes are enforced server-side; keep the app behind HTTPS in production.

## License

Private / all rights reserved unless otherwise noted in the repository.
