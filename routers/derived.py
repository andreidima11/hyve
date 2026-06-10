"""Derived entities API — CRUD + live preview + YAML import/export."""
from __future__ import annotations

import logging
from typing import Any, List, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import auth
import derived_entities
import models
from core.http.errors import error_detail

log = logging.getLogger("derived")

router = APIRouter(prefix="/api/derived", tags=["derived_entities"])


# ── Request / response models ─────────────────────────────────────────────
class FormulaBody(BaseModel):
    type: str = Field(..., description="expression | sum | avg | min | max | difference | any_on | all_on | count_on | concat | transform")
    inputs: List[str] = Field(default_factory=list)
    expression: Optional[str] = None
    # transform-only fields
    filter: Optional[str] = None
    scale: Optional[float] = None
    offset: Optional[float] = None

    def as_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"type": self.type, "inputs": list(self.inputs or [])}
        if self.expression is not None:
            d["expression"] = self.expression
        if self.filter is not None:
            d["filter"] = self.filter
        if self.scale is not None:
            d["scale"] = self.scale
        if self.offset is not None:
            d["offset"] = self.offset
        return d


class CreateBody(BaseModel):
    name: str = Field(min_length=1)
    value_type: str = Field(default="number")
    unit: str = ""
    aliases: List[str] = Field(default_factory=list)
    selected: bool = True
    formula: FormulaBody


class UpdateBody(BaseModel):
    name: Optional[str] = None
    value_type: Optional[str] = None
    unit: Optional[str] = None
    aliases: Optional[List[str]] = None
    selected: Optional[bool] = None
    formula: Optional[FormulaBody] = None


class SelectionBody(BaseModel):
    selected: bool


class AliasBody(BaseModel):
    aliases: List[str] = Field(default_factory=list)


class PreviewBody(BaseModel):
    value_type: str = "number"
    formula: FormulaBody


class YamlBody(BaseModel):
    yaml: str
    entity_id: Optional[str] = None  # if set, update; else create


class SerializeBody(BaseModel):
    entity_id: Optional[str] = None
    name: Optional[str] = None
    value_type: str = "number"
    unit: str = ""
    aliases: List[str] = Field(default_factory=list)
    selected: bool = True
    formula: Optional[FormulaBody] = None


def _parse_yaml(text: str) -> dict[str, Any]:
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail=error_detail("derived.yaml_empty"))
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise HTTPException(status_code=400, detail=error_detail("derived.yaml_invalid", {"message": str(e)}))
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail=error_detail("derived.yaml_root_must_be_mapping"))
    return data


def _yaml_to_entry_kwargs(data: dict[str, Any]) -> dict[str, Any]:
    """Coerce a parsed YAML mapping into kwargs accepted by create/update."""
    formula = data.get("formula")
    if not isinstance(formula, dict):
        raise HTTPException(status_code=400, detail=error_detail("derived.missing_formula_mapping"))
    return {
        "name": str(data.get("name") or "").strip(),
        "value_type": str(data.get("value_type") or "number"),
        "unit": str(data.get("unit") or ""),
        "aliases": list(data.get("aliases") or []),
        "selected": bool(data.get("selected", True)),
        "formula": formula,
    }


# ── State aggregation helper ──────────────────────────────────────────────
async def _build_state_map() -> dict[str, Any]:
    """Aggregate states from every integration into entity_id -> {state, unit}."""
    state_map: dict[str, Any] = {}
    try:
        from core.entity_catalog import get_entities

        entities = await get_entities(include_derived=False)
    except Exception as exc:
        log.warning("build_state_map entity fetch failed: %s", exc)
        entities = []
    for item in entities:
        eid = item.get("entity_id")
        if not eid:
            continue
        state_map[eid] = {
            "state": item.get("state"),
            "unit": item.get("unit") or "",
        }
    return state_map


# ── Routes ────────────────────────────────────────────────────────────────
@router.get("/list")
async def list_derived(_: models.User = Depends(auth.get_current_user)):
    """List all derived entities with their currently evaluated state."""
    state_map = await _build_state_map()
    return {"entities": derived_entities.evaluate_all(state_map)}


@router.get("/raw")
async def raw_derived(_: models.User = Depends(auth.get_current_user)):
    """Return raw (unevaluated) derived entries for editing."""
    return {"entries": derived_entities.load_config()}


@router.post("/create")
async def create_derived(body: CreateBody, _: models.User = Depends(auth.get_current_admin)):
    try:
        entry = derived_entities.create_entry(
            name=body.name,
            value_type=body.value_type,
            formula=body.formula.as_dict(),
            unit=body.unit,
            aliases=body.aliases,
            selected=body.selected,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": str(e)}))
    state_map = await _build_state_map()
    return {"status": "ok", "entity": derived_entities.evaluate_entry(entry, state_map)}


@router.put("/{entity_id}")
async def update_derived(entity_id: str, body: UpdateBody,
                         _: models.User = Depends(auth.get_current_admin)):
    updates: dict[str, Any] = body.model_dump(exclude_none=True)
    if "formula" in updates and isinstance(updates["formula"], dict):
        # pydantic already returned dict via model_dump; make sure keys are present
        pass
    elif body.formula is not None:
        updates["formula"] = body.formula.as_dict()
    try:
        updated = derived_entities.update_entry(entity_id, **updates)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": str(e)}))
    if not updated:
        raise HTTPException(status_code=404, detail=error_detail("derived.entity_not_found"))
    state_map = await _build_state_map()
    return {"status": "ok", "entity": derived_entities.evaluate_entry(updated, state_map)}


@router.delete("/{entity_id}")
async def delete_derived(entity_id: str, _: models.User = Depends(auth.get_current_admin)):
    if not derived_entities.delete_entry(entity_id):
        raise HTTPException(status_code=404, detail=error_detail("derived.entity_not_found"))
    return {"status": "ok"}


@router.post("/{entity_id}/selection")
async def set_derived_selection(entity_id: str, body: SelectionBody,
                                _: models.User = Depends(auth.get_current_user)):
    if not derived_entities.set_selected(entity_id, body.selected):
        raise HTTPException(status_code=404, detail=error_detail("derived.entity_not_found"))
    try:
        from brain.cortex.prompt_cache import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok"}


@router.post("/{entity_id}/aliases")
async def set_derived_aliases(entity_id: str, body: AliasBody,
                              _: models.User = Depends(auth.get_current_user)):
    if not derived_entities.set_aliases(entity_id, body.aliases):
        raise HTTPException(status_code=404, detail=error_detail("derived.entity_not_found"))
    return {"status": "ok"}


@router.post("/preview")
async def preview_derived(body: PreviewBody, _: models.User = Depends(auth.get_current_user)):
    """Evaluate a formula against current states without saving."""
    try:
        formula = derived_entities._validate_formula(body.formula.as_dict())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": str(e)}))
    state_map = await _build_state_map()
    fake_entry = {
        "entity_id": "derived.__preview__",
        "name": "preview",
        "value_type": body.value_type,
        "formula": formula,
    }
    evaluated = derived_entities.evaluate_entry(fake_entry, state_map)
    return {
        "state": evaluated.get("state"),
        "value_type": evaluated.get("value_type"),
        "inputs": evaluated.get("inputs"),
        "input_states": {
            eid: state_map.get(eid, {}).get("state") if isinstance(state_map.get(eid), dict) else state_map.get(eid)
            for eid in evaluated.get("inputs") or []
        },
    }


@router.post("/yaml/parse")
async def yaml_parse(body: YamlBody, _: models.User = Depends(auth.get_current_user)):
    """Parse a YAML definition into the JSON entry shape used by /create or /update."""
    return _yaml_to_entry_kwargs(_parse_yaml(body.yaml))


@router.post("/yaml/serialize")
async def yaml_serialize(body: SerializeBody, _: models.User = Depends(auth.get_current_user)):
    """Convert an entry into a friendly YAML string."""
    payload: dict[str, Any] = {
        "name": body.name or "",
        "value_type": body.value_type,
    }
    if body.unit:
        payload["unit"] = body.unit
    if body.aliases:
        payload["aliases"] = list(body.aliases)
    payload["selected"] = bool(body.selected)
    if body.formula is not None:
        payload["formula"] = body.formula.as_dict()
    text = yaml.safe_dump(payload, sort_keys=False, allow_unicode=True, default_flow_style=False)
    return {"yaml": text}


@router.post("/yaml/save")
async def yaml_save(body: YamlBody, _: models.User = Depends(auth.get_current_admin)):
    """Create or update an entry directly from YAML text."""
    kwargs = _yaml_to_entry_kwargs(_parse_yaml(body.yaml))
    try:
        if body.entity_id:
            updated = derived_entities.update_entry(body.entity_id, **kwargs)
            if not updated:
                raise HTTPException(status_code=404, detail=error_detail("derived.entity_not_found"))
            entry = updated
        else:
            entry = derived_entities.create_entry(**kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=error_detail("common.error_with_message", {"message": str(e)}))
    state_map = await _build_state_map()
    return {"status": "ok", "entity": derived_entities.evaluate_entry(entry, state_map)}


@router.get("/candidates")
async def candidates(_: models.User = Depends(auth.get_current_user)):
    """Return all entities (from every integration) usable as formula inputs."""
    state_map = await _build_state_map()
    items = []
    for eid, meta in state_map.items():
        if isinstance(meta, dict):
            state = meta.get("state")
            unit = meta.get("unit", "")
        else:
            state = meta
            unit = ""
        items.append({"entity_id": eid, "state": state, "unit": unit})
    items.sort(key=lambda x: x["entity_id"])
    return {"entities": items}
