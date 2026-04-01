This folder stores canonical automation definitions as YAML files.

Layout:

- `automations/<owner_id>/<automation_id>.yaml`

Notes:

- YAML files are the source of truth for automation definitions.
- The database stores metadata, revision counters, and run history.
- Files are created and updated through the automation definition API.