# ADR 005: HTTP application factory (Phase 5)

## Status

Accepted — Phase 5 complete (`core/http/app.py` factory; legacy routes extracted).

## Context

`main.py` mixed entrypoint concerns (~1700 lines): lifespan, middleware, DB bootstrap, router wiring, static files, and legacy chat/auth routes. Hard to test and risky to refactor.

## Decision

1. **`core/http/app.py`** — `create_app()` returns `HyveApp(app, templates, limiter, app_start_ts)`.
2. **`core/http/lifespan.py`** — startup/shutdown lifecycle.
3. **`core/http/middleware.py`** — gzip, CORS, security headers, logging, static cache policy.
4. **`core/http/startup_migrations.py`** — SQLite `create_all` + additive column migrations.
5. **`core/http/routers.py`** — `register_routers(app)`.
6. **`core/http/runtime.py`** — main asyncio loop handle for scheduler/notification thread callbacks.
7. **`core/http/limiter.py`** — shared SlowAPI limiter bound to `app.state.limiter`.
8. **`main.py`** — uvicorn entrypoint only (~50 lines); re-exports `app`, `templates`, `limiter` for compatibility.

Legacy routes moved to:

| Router | Endpoints |
|--------|-----------|
| `routers/system.py` | `/`, `/api/health`, `/api/startup/status`, `/api/themes`, `/api/tags`, `/api/logs`, `/api/restart` |
| `routers/auth_tokens.py` | `/api/token`, `/api/token/refresh`, `/api/token/sse` |
| `routers/chat_web.py` | `/api/chat`, `/api/extract-document` |
| `routers/slash.py` | `/api/slash`, `/api/slash/commands` |
| `routers/webhook_waha.py` | `/api/webhook/waha` |

WhatsApp context store: `core/whatsapp_context.py`.

## Consequences

- Tests can import `create_app()` without running uvicorn.
- `main.py` is a thin entrypoint; new HTTP routes belong in `routers/` + `core/http/routers.py`.
- Next: Alembic replaces inline migrations; optional cleanup of `from main import` in a few modules.

## Deferred

- Alembic migrations (replace PRAGMA/ALTER loops). → see ADR 006.
- Docker / multi-worker packaging.
