# Hyve

Self-hosted smart home hub with an integrated AI assistant. One FastAPI process serves the web UI, device integrations, automations, dashboards, and chat — similar in spirit to Home Assistant, with a built-in LLM agent for control, memory, and skills.

**Current version:** 0.7.2

## Features

- **Dashboard** — customizable grid with Hyveview cards, live entity state over WebSocket
- **Smart home** — unified device list from many integrations (MQTT, Roborock, Midea, Reolink, Tapo, Open-Meteo, and more)
- **AI chat** — streaming assistant with tools (device control, web search, memory, skills, planner)
- **Automations** — YAML automations with visual editor and blueprints
- **Memory** — long-term facts in ChromaDB, reminders, ambient suggestions
- **Integrations** — Home Assistant–style config entries, encrypted secrets, periodic sync
- **Add-ons** — optional bundled or custom services (MQTT broker, Whisper, Piper, etc.)
- **Android app** — native shell in `android/HyveBridge/` (WebView + background services)
- **i18n** — English and Romanian UI

## Requirements

- Python 3.12+
- Node.js 18+ (Tailwind CSS build only)
- SQLite (default), optional ChromaDB data dir (`chroma_db/`)
- LLM backend: Ollama, OpenAI-compatible API, or configured provider in `config.json`

## Quick start

```bash
# Clone and enter the repo
git clone https://github.com/andreidima11/hyve.git
cd hyve

# Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Local configuration (never commit this file)
cp .env.example .env
# Edit .env — set HYVE_SECRET_KEY at minimum

# First-time app config is created on first run, or copy a template if you maintain one locally.
# config.json is gitignored and holds LLM keys, integration toggles, and UI settings.

# Frontend CSS (optional if tailwind.built.css already present)
npm install
npm run css:build

# Create an admin user
python scripts/bootstrap_admin.py --username admin --password 'change-me' --full-name Admin

# Run
python main.py
```

Open `http://localhost:8082` (default port from config).

## Configuration

| File | Purpose |
|------|---------|
| `.env` | Secrets and env overrides (`HYVE_SECRET_KEY`, HA token, WAHA, FCM path) |
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

Updates `settings.py`, `package.json`, Android `versionName`, and this README version line.

## Security notes

- Do **not** commit `config.json`, `.env`, `assist_keys.json`, or anything under `secrets/`.
- Use a strong `HYVE_SECRET_KEY` in production.
- Admin-only routes are enforced server-side; keep the app behind HTTPS in production.

## License

Private / all rights reserved unless otherwise noted in the repository.
