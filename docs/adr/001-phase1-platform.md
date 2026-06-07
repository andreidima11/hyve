# ADR 001: Phase 1 platform cleanup

**Status:** Accepted (2026-06-06)  
**Context:** Hyve accumulated legacy integration paths (config.json bootstrap, vendor routers, context formatters in `main.py`) alongside the modern config-entry model.

## Decisions

1. **Config entries only** — Remove Pago/FusionSolar lifespan wiring from `main.py`. Sync is owned by `IntegrationManager.bootstrap_store()`.
2. **Context formatters** — Move AI prompt formatters to `integrations/context_formatters.py`; providers implement `format_context()`.
3. **No `from main import`** — Routers must not import helpers from the ASGI entrypoint.
4. **Deprecate vendor routers** — Remove `/api/pago/*` and `/api/fusion-solar/*`; use `/api/integrations/{slug}/…`.
5. **Camera stream tokens** — Issue 5-minute `camera_stream` JWTs via `POST /api/cameras/stream-token`; frontend uses `camera_auth.js` instead of long-lived access tokens in URLs.
6. **Loader fix** — `bootstrap_store()` must register every eligible integration inside the `for` loop (indentation bug fixed).

## Consequences

- Users still on legacy `config.json` credentials for Pago/FusionSolar must create config entries in Settings → Integrations.
- Camera URLs still use query tokens (required for `<img>`/`<video>`) but tokens are short-lived and scoped.
- Next phase: folder-based `components/` loader pilot (`open_meteo`).

## References

- [ARCHITECTURE.md](../ARCHITECTURE.md)
