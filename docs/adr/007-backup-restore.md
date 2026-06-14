# ADR 007: Backup and restore (AAA)

## Status

Accepted — Phase 4 complete (remote + encryption); pull restore from remote implemented.

## Context

Hyve stores critical state across SQLite (`users.db`, sidecars), `config.json`, encrypted integration secrets, and user-local directories (dashboards, automations, skills). Add-ons add a third layer: registry state in SQLite plus large runtime trees under `output/addons/<slug>/` (Docker images, `node_modules`, media).

Fresh installs and git history cleanup showed that user data must never live in the repo; operators need a supported way to move or recover an instance.

## Decision

### Archive format

- **`.hyvebak`**: gzip-compressed tar with `manifest.json` at archive root and payload under `data/` (paths relative to Hyve project root).
- **`manifest.json`**: `format_version`, timestamps, Hyve version, Alembic revision (from `users.db`), SHA-256 per file, backup options, add-on slugs included.

### Data tiers

| Tier | Contents | Default in backup |
|------|----------|-------------------|
| A (critical) | `users.db`, `jobs.sqlite`, `scheduler_meta.sqlite`, `config.json`, `secrets/integration_entries.key`, `core/.secret_key`, `.env` | always |
| B (user) | `dashboards/`, `core/automations/`, aliases, `derived_entities.json`, `skills/generated/`, `comfyui_workflows/`, `custom_addons/`, `custom_components/` | always |
| C (optional) | `chroma_db/`, `sessions/`, `static/generated/`, `piper_models/` | off |
| D (exclude) | `venv/`, `logs/`, live entity cache, add-on `runtime/` trees | never |

### Add-ons (three layers)

1. **Registry** — `addon_state` rows live in `users.db`; `custom_addons/` manifests are Tier B. Always included when present.
2. **User data** — selective paths under `output/addons/<slug>/` via `core/backup/addons_policy.py`:
   - **zigbee2mqtt**: `data/` yes; `runtime/` no
   - **frigate**: `config/`, `db/` yes; `media/` no (optional flag)
   - **mosquitto**: `data/`, `config/` yes
   - **piper**: models excluded by default (refetch)
   - Global excludes: `**/runtime/**`, `**/node_modules/**`, `**/log/**`
3. **Artifacts** — never archived; **refetch on restore** (`docker pull`, `npm install`, etc.) via `AddonRestoreCoordinator` calling existing add-on install paths.

Future: optional `"backup"` block in add-on `manifest.json` overrides built-in policy.

### Phases

| Phase | Scope |
|-------|--------|
| **1** | `core/backup/`, manifest v1, CLI (`scripts/hyve_backup.py`), add-on policy, round-trip tests |
| **2** | Admin API (`/api/backup/*`), pre-restore snapshot, rollback, maintenance mode middleware |
| **3** | Settings UI (Hub card), scheduled backups, retention — done |
| **4** | Remote targets (S3/SFTP), optional encryption — done |

### SQLite handling

- Online backup via `sqlite3.Connection.backup()` into the archive (not raw copy while Hyve is running).
- WAL/SHM are not copied separately; backup API produces a consistent snapshot.

## Consequences

- Operators can migrate CT/LXC instances without committing personal data to git.
- Restore on a newer Hyve version still runs Alembic on startup; manifest records source revision for diagnostics.
- Large add-on media stays out of default archives; optional flags opt in.

## Deferred

- Alembic for auxiliary SQLite sidecars beyond snapshot restore.
- Per-add-on `"backup"` manifest overrides (policy is hard-coded in Phase 1).
