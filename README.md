# Memini Bridge

Memini Bridge is a local-first application for running a personal assistant with memory, Home Assistant integration, automations, and a dedicated web interface. The project combines a FastAPI backend, local context storage, and a modular frontend for chat, conferences, and administration.

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

## Quick Start

### 1. Create the Python environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install -r requirements-dev.txt
```

### 2. Configure the environment

- start from `.env.example`
- complete `config.json` with the required local values
- see [CONFIG.md](CONFIG.md) for configuration details

For strict startup or release-oriented environments:

- `MEMINI_SECRET_KEY` must be set explicitly
- the model endpoint and model name must be configured
- anonymous access must remain disabled

### 3. Run the application

```bash
source venv/bin/activate
python main.py
```

Alternatively:

```bash
./start.sh
```

By default, the application starts on `http://localhost:8082`.

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

## Useful Documentation

- [CONFIG.md](CONFIG.md)

## Status

Active project focused on local use and practical integration between automation, memory tooling, and a web interface.
