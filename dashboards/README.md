# Dashboard pages (local only)

Each page is stored as `dashboards/<page_id>.json`. Sidebar entries, panels,
widgets, and layout are **per-installation** — they are not shipped with Hyve
releases.

On first use Hyve starts with an empty dashboard; create pages from the UI.

Backups: `dashboards/.backups/` (automatic, local only).

Reset: `python scripts/install_hyve.py --fresh`
