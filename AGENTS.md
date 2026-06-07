# Hyve — instructions for AI coding agents

Read this file first, then follow the linked docs for the kind of change you are making.

## Required reading

| Doc | When to read |
|-----|----------------|
| [docs/AI_AGENT_GUIDE.md](docs/AI_AGENT_GUIDE.md) | **Always** — rules, anti-patterns, workflows |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Structure, modules, data flow |
| [docs/INTEGRATION_GUIDE.md](docs/INTEGRATION_GUIDE.md) | New entity integrations (providers) |
| [docs/CARDS_AND_INTEGRATIONS.md](docs/CARDS_AND_INTEGRATIONS.md) | Dashboard cards, `ui_catalog.json` |
| [static/css/themes/README.md](static/css/themes/README.md) | Themes |
| [.cursor/rules/ui-design-consistency.mdc](.cursor/rules/ui-design-consistency.mdc) | UI dropdowns, CSS variables, modals |

## Quick rules

1. **Minimize scope** — smallest correct diff; do not refactor unrelated code.
2. **One integration path** — config entries + `components/` / `custom_components/` (or legacy `integrations/providers/`) + generic `/api/integrations/*`. Register new routers in `core/http/routers.py`, not ad-hoc in `main.py`.
3. **No vendor logic in core UI** — do not edit `features.js` / `index.html` per integration; use `CONFIG_SCHEMA` + `ui_catalog.json`.
4. **i18n** — user-visible strings in `static/js/lang/en.js` + `ro.js`; API errors as `{ key, params }`, not hardcoded Romanian/English.
5. **Never import from `main.py`** — extract shared helpers to a proper module.
6. **Themes** — CSS variables only; never hardcode `rgba(255,255,255,...)` for surfaces.
7. **Tests** — add pytest for backend behavior you change; run `pytest` before finishing.
8. **DB schema** — new columns/tables via Alembic revision in `migrations/versions/` (not inline `ALTER TABLE` in startup code).
9. **No commits** unless the user explicitly asks.

## Target direction (in progress)

Hyve uses a Home Assistant–like layout: **`components/`** (bundled) and **`custom_components/`** (user drop-ins). HTTP stack lives in **`core/http/`** (`create_app()` factory); `main.py` is the uvicorn entrypoint only.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § “Planned structure”.
