# ADR 003: Per-component entity extraction (Phase 3)

## Status

Accepted — Phase 3 complete for bundled integrations (frigate deferred).

## Context

`integrations/extractors.py` was a ~2000-line god file mixing shared normalizers with seven integration-specific extractors. `fusion_solar` already lived in a separate module.

## Decision

1. Shared helpers → `integrations/entity_utils.py` (`finalize_entities`, `slugify`, `is_state_controllable`).
2. Per-integration extract logic → `components/<domain>/extract.py`.
3. `integrations/extractors.py` keeps `infer_source`, `normalize_entities`, and **re-exports** component extractors for backward compatibility (tests, dashboard router).
4. `integrations/fusion_solar_entities.py` becomes a thin shim over `components/fusion_solar/extract.py`.
5. **Phase 3b:** `mosquitto`, `xiaomi_home`, `roborock`, and `tapo` expose `components/*/extract.py`; `entity.py` delegates to local extract.
6. **Phase 3c:** `extract_z2m_candidates` moved to `components/mosquitto/extract.py`; `hyve_scenes` and `reolink` gained dedicated `extract.py` modules.
7. **Deferred:** `frigate` keeps inline extract in `entity.py` (large, class-coupled; automated split failed once).

## Consequences

- New integrations colocate `entity.py` + `extract.py` in their component folder.
- `extractors.py` is a thin registry (~150 lines) loading from `components/*/extract.py`.
- Dashboard re-exports component extractors; Z2M widget picker uses `extract_z2m_widget_candidates` in `components/mosquitto/extract.py`.
