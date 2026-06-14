# Automation YAML (local only)

Canonical automation definitions are stored here:

```
core/automations/<owner_id>/<automation_id>.yaml
```

The database holds metadata, revision counters, and run history. Files are
created through the automation editor API/UI.

This directory is gitignored — each Hyve instance owns its automations.

See also `automations/README.md` for YAML schema reference.
