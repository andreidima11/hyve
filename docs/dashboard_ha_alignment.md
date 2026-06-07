# Dashboard: Home Assistant alignment — design doc

**Date:** 1 Jun 2026
**Status:** Proposal — awaiting decision on scope
**Goal:** (1) decide how per-device / per-user dashboards should work "like HA",
(2) fix mobile section reordering, (3) pick targeted improvements from HA.

---

## 1. How Home Assistant actually works (verified from source)

Researched directly from `home-assistant/core` and `home-assistant/frontend`.

### Storage
- Dashboards are stored **centrally on the server**, one storage file per
  dashboard: `.storage/lovelace.<id>`. The list of dashboards (metadata) lives in
  `.storage/lovelace_dashboards`.
- A dashboard config is shared by **every device and every user**. There is **no
  per-device dashboard layout** in HA.
- `LovelaceStorage.async_save()` does a whole-config read‑modify‑write per
  dashboard — exactly like our `_save_dashboard()`.

### What *is* per-user
- Per-user **default dashboard** (`default_panel`, stored in frontend system data).
- `require_admin` and `show_in_sidebar` per dashboard.
- Per-section / per-card **visibility conditions**, including a `user` condition
  (show this section only to user X) and `screen`/`state`/`numeric_state`.

### HA's official answer to "different layout on my wall tablet"
> *"If you want your wall tablet to use a different dashboard than your other
> devices, use a separate user profile for your wall tablet."*

So HA solves "per device" by **multiple dashboards + a per-user default**, not by
storing layout on the device.

### Reordering (sections & cards), incl. mobile
- HA wraps **SortableJS** in a `<ha-sortable>` element.
- Sections sortable: `handle-selector=".handle"`, `draggable-selector=".section"`,
  `group="section"`, `rollback=false`.
- Cards sortable: `delay: 100, delayOnTouchOnly: true, direction: "vertical",
  invertedSwapThreshold: 0.7`.
  **`delay` + `delayOnTouchOnly` is the key to mobile**: a 100 ms press‑and‑hold
  starts the drag, so normal finger scrolling still works.
- Reorder = **change array order**: `moveSection(config, [view, oldIndex],
  [view, newIndex])` = delete + insert by index, then `saveConfig`. The single
  column on mobile simply renders that array top‑to‑bottom, so reordering works
  the same on phone and desktop.

---

## 2. Where Hyve stands today

| Concern | Home Assistant | Hyve today |
|---|---|---|
| Layout storage | Central, server, per‑dashboard file | Central, server, `config.json["dashboard"]` ✅ same idea |
| Scope | Shared; per‑user default + visibility | Single global layout, no per‑user default |
| Multiple dashboards | Yes (`dashboards` collection) | Yes (`pages[]`) ✅ |
| Section reorder model | **Array index** (`moveSection`) | **Absolute grid coords** (`col_start/row_start`) |
| Mobile reorder | Works (single column = array order) | **Broken** (see §3) |
| Drag input | SortableJS, press‑hold on touch | Custom pointer‑event drag |

Hyve already matches HA's *storage philosophy* (central server config). The gaps
are: reorder model, mobile, and per‑user/visibility features.

---

## 3. The mobile section‑reorder bug (root cause)

`static/css/dashboard.css`:

```css
@media (max-width: 1023px) {
  .dashboard-panels-stack { grid-template-columns: 1fr; grid-auto-rows: min-content; }
  .dashboard-panel { grid-column: 1 / -1 !important; grid-row: auto !important; }
}
```

On phones the grid collapses to one forced column, so panel order is just **DOM /
array order**. But the drag handler `startDashboardPanelDrag` →
`_commitDashboardPanelLayout` (`static/js/dashboard.js`) computes a drop target as
**absolute grid coordinates** and persists `col_start` / `row_start` via
`PATCH /api/dashboard/panels/{id}/layout`. Those coordinates are then ignored by
the `!important` single‑column rules → **the section visually never moves**.

**Fix (HA‑style):** when rendering as a single column, reorder by **array index**,
not coordinates. The array path already exists and is used by the left/right
swap buttons: `_commitDashboardPanelOrder` + `POST /api/dashboard/panels/{id}/move`
(or `/reorder`). We just need drag on mobile to route through it.

---

## 4. Proposed improvements (menu — pick what you want)

### A. Fix mobile section reordering *(small, standalone, recommended first)*
- Detect single‑column mode; in that mode the drag drop‑target becomes an
  **insert index** (reorder the `panels` array) instead of grid coordinates.
- Persist via the existing reorder endpoint.
- Add a press‑and‑hold delay on touch (HA uses 100 ms) so scroll vs. drag is
  unambiguous. Same fix benefits **widget/card** dragging on mobile.

### B. Adopt SortableJS for drag (replace custom pointer drag) *(medium)*
- HA‑parity: `delay/delayOnTouchOnly`, ghost/placeholder, cross‑container moves,
  battle‑tested touch handling. SortableJS is **already bundled but disabled**.
- Keeps the 2‑D desktop grid for sections that have explicit coordinates, falls
  back to list‑reorder on mobile.

### C. Per‑user default dashboard + section visibility conditions *(medium)*
- Add a per‑user "default page" preference (HA `default_panel`).
- Add section/card **visibility conditions** (`user`, `state`, `screen size`) —
  this is HA's real mechanism for "this device/user sees a different layout"
  without duplicating storage.

### D. "Per device" the HA way *(decision needed)*
- HA does **not** store layout per device. If you want a tablet to show a
  different layout, the HA pattern is: **create another page/dashboard** and let
  that device open it (per‑user default, or a saved URL/kiosk param).
- If you truly want *device‑local* layouts (a phone rearranges cards only for
  itself), that is a **divergence from HA** and needs a new storage scope
  (e.g. `dashboard_overrides[device_id]` keyed by a device token in
  localStorage). Heavier; recommend only if B/C don't cover the need.

### E. Card/section niceties from HA *(optional, incremental)*
- Section background color/opacity + per‑section theme (we already have themes).
- "Dense" packing toggle, heading cards, conditional sections.
- Undo/redo of layout edits.

---

## 5. Recommended sequence

1. **A** — fix mobile reorder now (unblocks the reported pain).
2. **C** — per‑user default + visibility conditions (covers most "per device" needs
   the HA way, low storage risk).
3. **B** — migrate drag to SortableJS (removes custom drag code, unifies mobile).
4. **D** only if device‑local layout is still wanted after C.

---

## Open questions for product

1. Is "per device" satisfied by **multiple pages + per‑user/default + visibility
   conditions** (HA's model), or do you specifically want **device‑local**
   rearrangement that diverges from HA?
2. Do we have real multi‑user accounts to hang per‑user defaults on, or is it
   effectively single‑user today?
3. OK to re‑enable SortableJS and retire the custom pointer‑drag, or keep custom?
