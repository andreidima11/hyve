# Dashboard layout — design doc

**Date:** 1 Jun 2026  
**Status:** Partially implemented (0.9.0+)  
**Goal:** (1) per-user dashboard defaults and visibility, (2) fix mobile section reordering, (3) improve drag-and-drop on touch devices.

---

## 1. Storage model (Hyve today)

- Dashboards are stored **centrally on the server** (`config.json` / dashboard store).
- Multiple pages are supported (`pages[]`).
- Layout uses **absolute grid coordinates** (`col_start` / `row_start`) per panel.
- Per-user **default page** is implemented (`PATCH /api/dashboard/preferences/default-page`, page modal checkbox). Section visibility conditions remain partial.

---

## 2. Mobile section-reorder bug (root cause)

`static/css/dashboard.css` collapses the grid to a single column on narrow screens. Panel order follows **DOM / array order**, but drag-and-drop still persists **grid coordinates** that CSS then ignores — so sections appear not to move.

**Fix:** in single-column mode, reorder by **array index** (existing `/api/dashboard/panels/{id}/move` and `/reorder` endpoints) instead of grid coordinates. Add a short press-and-hold delay on touch so scroll vs. drag is unambiguous.

---

## 3. Proposed improvements

### A. Fix mobile section reordering *(done in 0.9.0)*
- Single-column mode reorders by **array index** (`/api/dashboard/panels/{id}/reorder`).
- Drop ghost + faded source match card drag UX (0.9.0 polish).
- Press-and-hold on touch via `_touchHoldGate`.

### B. Adopt SortableJS for drag *(medium)*
- SortableJS is already bundled; use `delay` + `delayOnTouchOnly` for touch.
- Keep 2-D desktop grid where coordinates exist; list-reorder on mobile.

### C. Per-user default dashboard + visibility conditions *(partial)*
- **Done:** per-user default page preference (API + page modal).
- **Open:** richer section/card visibility (`user`, `state`, screen width).

### D. Device-specific layouts *(decision needed)*
- **Recommended pattern:** separate dashboard pages + per-user default or kiosk URL — no per-device layout storage.
- **Alternative:** device-local overrides (heavier; new storage scope keyed by device token).

### E. Optional niceties
- Section background / theme overrides, dense packing, conditional sections, undo/redo.

---

## 4. Recommended sequence

1. **A** — fix mobile reorder (unblocks the reported pain).
2. **C** — per-user default + visibility.
3. **B** — SortableJS migration.
4. **D** only if device-local layout is still required after C.

---

## Open questions

1. Is multiple pages + per-user default + visibility enough for “different layout on tablet vs phone”?
2. Do we have real multi-user accounts for per-user defaults, or effectively single-user today?
3. Re-enable SortableJS and retire custom pointer-drag, or keep custom?
