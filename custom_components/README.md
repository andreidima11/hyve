# Custom integrations

User drop-in entity integrations, similar to Home Assistant `custom_components/`.

Bundled integrations live in [`components/`](../components/). Copy or create folders here to add or override integrations without editing Hyve core.

## Layout

```
custom_components/
└── my_vendor/
    ├── manifest.json      # required: domain, name, version
    ├── entity.py          # BaseEntity subclass (or integration.py / __init__.py)
    ├── client.py          # optional HTTP/MQTT client
    └── translations/      # optional en.json, ro.json
        ├── en.json
        └── ro.json
```

Restart Hyve after adding or changing a component.

## Override path

Set `HYVE_CUSTOM_COMPONENTS_DIR` to an absolute path (or path relative to the Hyve install root) to use a directory outside the repo.

## Example

See [`demo_sensor/`](demo_sensor/) — a minimal sensor integration for testing the loader. Add a config entry in **Settings → Integrations** after restart.

## Docs

- [INTEGRATION_GUIDE.md](../docs/INTEGRATION_GUIDE.md) — authoring (v2 folder layout)
- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) — platform map
