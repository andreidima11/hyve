# Custom Add-ons

Drop a folder in here to register a community / third-party add-on without
modifying Hyve's source code. This is the Hyve equivalent of Home Assistant's
`custom_components/` directory.

## Layout

```
custom_addons/
└── my_addon/
    ├── manifest.json     # Required — same schema as bundled addons
    ├── run.sh            # Optional — referenced from start_command.args
    ├── icon.png          # Optional
    └── README.md         # Optional
```

The folder name **must** match the `slug` in `manifest.json`.

## Manifest

Same JSON schema as `addons/available/<slug>/manifest.json`. Minimum:

```json
{
  "slug": "my_addon",
  "name": "My Add-on",
  "description": "Short tagline shown in the catalog.",
  "version": "1.0.0",
  "icon": "fas fa-puzzle-piece",
  "color": "indigo",
  "category": "automation",
  "install": {
    "method": "binary",
    "notes": "External-only — Hyve doesn't run anything, just stores config."
  },
  "config_schema": [
    {"key": "host", "label": "Host", "type": "text", "default": "localhost"}
  ]
}
```

Supported `install.method`: `pip`, `brew`, `npm`, `docker`, `wyoming`, `binary`.

## Run command

If your add-on launches a process, add a `start_command`. Paths are resolved
**relative to your addon folder first**, so a script named `run.sh` next to
`manifest.json` is referenced as just `"run.sh"`:

```json
"start_command": {
  "command": "bash",
  "args": ["run.sh", "{port}"],
  "description": "Launch the service."
}
```

Placeholders like `{port}` are filled from the add-on's saved config.

## Discovery

Hyve scans this folder on every catalog request — no restart needed when
adding or removing an add-on. Custom add-ons can override a bundled add-on
with the same slug.

You can change the location with the `HYVE_CUSTOM_ADDONS_DIR` environment
variable.
