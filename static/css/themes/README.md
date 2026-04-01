# Memini Themes

Each theme is a pair of files inside `static/css/themes/`:

| File | Purpose |
|------|---------|
| `{name}.css` | CSS variable overrides via `[data-theme="{name}"]` selector |
| `{name}.json` | Metadata: display name, author, description, preview colors |

## Creating a Custom Theme

1. **Copy an existing theme** — duplicate `obsidian.css` → `mytheme.css` and `obsidian.json` → `mytheme.json`.
2. **Edit the JSON** — set a unique `id` (must match the filename), display `name`, `description`, `author`, and `preview` colors.
3. **Edit the CSS** — change the selector to `[data-theme="mytheme"]` and adjust the variable values.
4. **Restart the server** (or refresh) — the theme will appear in Settings → General → Theme.

## JSON Schema

```json
{
    "id": "mytheme",
    "name": "My Cool Theme",
    "description": "A short description shown in the selector",
    "author": "Your Name",
    "version": "1.0.0",
    "preview": {
        "bg":      "#030712",
        "surface": "#0f172a",
        "accent":  "#38bdf8",
        "text":    "#f1f5f9"
    }
}
```

`preview` colors are used to render live mini-previews in the theme picker.

## CSS Variable Reference

### Core surfaces
| Variable | What it controls |
|----------|-----------------|
| `--bg-main` | Page background |
| `--surface-0` | Main content area bg |
| `--surface-1` | Primary panel/card bg |
| `--surface-2` | Secondary panel bg |
| `--surface-3` | Tertiary/deeper bg |
| `--surface-glass` | Glassmorphism panel bg |
| `--surface-glass-heavy` | Opaque glass (sidebar, aside) |
| `--surface-sidebar` | Sidebar bg |
| `--surface-menu` | Dropdown/popover bg |
| `--surface-code` | Code block bg |
| `--surface-input` | Input field bg |
| `--surface-overlay` | Modal backdrop |
| `--surface-tooltip` | Tooltip bg |

### Text
| Variable | What it controls |
|----------|-----------------|
| `--text-primary` | Main body text |
| `--text-secondary` | Labels, subtitles |
| `--text-tertiary` | Placeholders, muted text |
| `--text-heading` | Headings (h1-h3) |
| `--text-on-accent` | Text on accent-colored bg |
| `--text-code` | Inline code color |

### Borders
| Variable | What it controls |
|----------|-----------------|
| `--border-subtle` | Almost-invisible dividers |
| `--border-light` | Default borders |
| `--border-medium` | Stronger borders |
| `--border-hover` | Hover state borders |

### Overlays (contrast tints)
`--overlay-{2,3,4,5,6,8,10,15}` — transparent overlays for hover states, active states, and subtle surfaces.
On dark themes these are white-tinted; on light themes, black-tinted.

### Semantic colors
| Variable | Purpose |
|----------|---------|
| `--accent` / `--accent-hover` / `--accent-glow` | Primary brand accent |
| `--danger` / `--danger-hover` / `--danger-soft` | Error / destructive |
| `--success` / `--success-hover` / `--success-soft` | Confirmed / online |
| `--warning` / `--warning-hover` | Caution / recording |
| `--info` | Informational |

See `obsidian.css` for the full list of all supported variables.
