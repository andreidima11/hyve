# Memini Bridge

Memini Bridge is a local-first application for running a personal assistant with memory, Home Assistant integration, automations, and a dedicated web interface. The project combines a FastAPI backend, local context storage, and a modular frontend for chat, conferences, and administration.

## Alpha Disclaimer

This project is currently in alpha.

- use it for testing, evaluation, and local experimentation only
- expect breaking changes, incomplete flows, and rough edges
- do not treat it as production-ready software
- do not store critical secrets or irreplaceable data without your own backups and review

## What It Does

- provides a web interface for chat, memory, and administration
- can integrate with Home Assistant for control and home context
- runs automation flows and scheduled reminders
- keeps local semantic context for search and reuse
- includes a conference mode for multi-agent workflows and task orchestration
- supports local or remote models depending on configuration

## Stack

- Python 3.12
- FastAPI
- SQLAlchemy
- ChromaDB
- APScheduler
- httpx
- Tailwind CSS
- modular JavaScript in `static/js`

## Requirements

- Python 3.12
- Node.js only if you want to rebuild the CSS
- a valid `config.json` for your local environment
- a local or remote model configuration if you want chat features

## Installation

This is the recommended flow for a clean machine.

### 1. Install system prerequisites

Required:

- Git
- Python 3.12

Optional but recommended:

- Node.js 20+ if you want to rebuild frontend CSS assets locally

Quick checks:

```bash
git --version
python3 --version
npm --version
```

If `npm` is missing, the installer still works. It will skip the Node step and use the frontend assets already committed in the repository.

### 2. Clone the repository

```bash
git clone https://github.com/andreidima11/memini-bridge.git
cd memini-bridge
```

### 3. Run the guided installer

```bash
python3 scripts/install_memini.py
```

Or, if you prefer the shell wrapper:

```bash
bash install.sh
```

### 4. Follow the terminal prompts

The installer will ask for:

- admin username
- admin full name
- optional admin email
- admin password
- application port

During setup it will:

- create or reuse `venv`
- upgrade `pip`
- install Python dependencies from `requirements.txt`
- install Node dependencies when `npm` is available
- create `.env` if missing
- generate `MEMINI_SECRET_KEY` if missing
- create `config.json` if missing
- create or update the first local admin account
- start the server
- open the browser when the server is ready

### 5. Log in

Once the installer finishes, open the local URL shown in the terminal, usually:

```text
http://127.0.0.1:8082/
```

Log in with the admin username and password entered during installation.

## Minimum Configuration for First Start

The installer prepares the minimum needed to boot locally:

- `.env` with `MEMINI_SECRET_KEY`
- `config.json` with default values
- a local admin user stored in `users.db`

That is enough to open the UI and log in.

Chat quality and integrations will remain limited until you configure the services you actually want to use.

## First Things to Configure After Install

Depending on your use case, you may want to configure:

### LLM backend

Edit `config.json` and set:

- `llm.target_url`
- `llm.model_name`
- optionally `LLM_API_KEY` in `.env`

Examples:

- local Ollama / OpenAI-compatible endpoint
- remote OpenAI-compatible provider
- Z.AI-compatible endpoint

### Home Assistant

If you want HA integration, configure:

- `home_assistant.enabled`
- `home_assistant.url`
- `HA_TOKEN` in `.env`

### WhatsApp / WAHA

If you use WAHA, configure:

- `waha.enabled`
- `waha.api_url`
- optional credentials or API key through environment variables

### Firebase push

If you use push notifications, configure:

- `fcm.enabled`
- `fcm.project_id`
- `fcm.service_account_path`

See [CONFIG.md](CONFIG.md) for the detailed configuration surface.

## Daily Use Commands

Start the app manually:

```bash
source venv/bin/activate
python main.py
```

Run tests:

```bash
source venv/bin/activate
python -m pytest
```

Run release checks:

```bash
source venv/bin/activate
python scripts/release_gate.py
```

Rebuild CSS:

```bash
npm run css:build
```

Watch CSS during frontend work:

```bash
npm run css:watch
```

## Troubleshooting

### The installer says `npm` is missing

That is acceptable for a basic local install. The app can still start using committed frontend assets.

### The browser does not open automatically

Open the printed local address manually in your browser.

### The server does not become ready

Check the startup log:

```bash
cat logs/install-server.log
```

### I want to create or reset the admin account again

You can rerun the installer, or call the admin bootstrap helper directly:

```bash
venv/bin/python scripts/bootstrap_admin.py --username admin --password yourpassword --full-name "Admin" --email ""
```

### I want the installer without interactive prompts

Use non-interactive flags:

```bash
python3 scripts/install_memini.py \
	--non-interactive \
	--admin-username admin \
	--admin-password yourpassword \
	--admin-full-name "Admin" \
	--admin-email "you@example.com"
```

## Manual Setup

If you do not want to use the guided installer, you can still set the project up manually:

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install -r requirements-dev.txt
cp .env.example .env
python main.py
```

For a manual setup to be useful beyond the login screen, you will usually also need to:

- create or update `config.json`
- configure `MEMINI_SECRET_KEY` in `.env`
- bootstrap an admin user with `scripts/bootstrap_admin.py`
- configure an LLM endpoint in `config.json`

## Testing

Run the test suite:

```bash
source venv/bin/activate
python -m pytest
```

Run the release checks:

```bash
source venv/bin/activate
python scripts/release_gate.py
```

## Frontend and CSS

To build the CSS:

```bash
npm install
npm run css:build
```

For watch mode:

```bash
npm run css:watch
```

## Structure

- `main.py` — FastAPI entrypoint and main application wiring
- `auth.py` — authentication, tokens, and access policies
- `settings.py` — configuration, environment overlays, and validation
- `routers/` — FastAPI endpoints
- `brain/` — orchestration logic, tools, and memory handling
- `static/js/` — modular frontend code
- `static/css/` — styles and build output
- `templates/` — HTML templates
- `tests/` — tests and regressions

## Publishing Notes

- the repository does not include local data, sqlite databases, sessions, logs, or sensitive keys
- secret values should be injected through environment variables, not stored in the repository
- runtime files and locally generated data are excluded through `.gitignore`

## Installer Notes

- the guided installer is intended for local development or self-hosted use
- if `npm` is not installed, the installer skips the frontend dependency step and uses the committed frontend assets already present in the repository
- after installation, log in with the admin username and password you provided during setup

## Useful Documentation

- [CONFIG.md](CONFIG.md)

## Status

Active project focused on local use and practical integration between automation, memory tooling, and a web interface.
