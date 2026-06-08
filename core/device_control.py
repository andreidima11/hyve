"""Resolve entity_id → integration instance and execute control_entity.

Single domain entry point for device control (HTTP routers, scheduler, chat
direct commands, scenes). Does not import FastAPI routers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from core.entity_catalog import build_entities_uncached
from integrations.base import BaseEntity
from integrations.entity_utils import resolve_entity_by_id

log = logging.getLogger("device_control")

# Dashboard / MQTT aliases — zigbee2mqtt entities are served by mosquitto bridge.
SOURCE_SLUG_ALIASES: dict[str, str] = {"zigbee2mqtt": "mosquitto"}


@dataclass(frozen=True)
class ControlTarget:
    """Resolved control destination for one entity."""

    raw_entity_id: str
    target_id: str
    entity: dict[str, Any] | None
    integration: BaseEntity


class ControlTargetNotFound(LookupError):
    """Raised when no integration owns the given entity_id."""


def find_entity_record(
    entity_id: str,
    *,
    include_derived: bool = False,
    entities: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Look up a flat entity record by entity_id, unique_id, or Z2M variants."""
    raw = str(entity_id or "").strip()
    if not raw:
        return None
    items = (
        entities
        if entities is not None
        else build_entities_uncached(include_derived=include_derived, sort_mode="name")
    )
    return resolve_entity_by_id(raw, items)


def integration_for_entity(
    entity: dict[str, Any],
    *,
    raw_entity_id: str = "",
) -> BaseEntity | None:
    """Pick the integration instance that owns *entity*."""
    from integrations import get_integration_manager

    manager = get_integration_manager()
    entry_id = str(entity.get("entry_id") or "").strip()
    source = str(entity.get("source") or "").strip().lower()
    unique_id = str(entity.get("unique_id") or "").strip()

    inst = manager.get_by_entry(entry_id) if entry_id else None
    if inst is None and source:
        slug = SOURCE_SLUG_ALIASES.get(source, source)
        inst = manager.get(slug)
    if inst is None and (unique_id.startswith("z2m:") or source in SOURCE_SLUG_ALIASES):
        entries = manager.entries_for("mosquitto")
        inst = entries[0] if entries else manager.get("mosquitto")
    if inst is None and raw_entity_id:
        slug_guess = (raw_entity_id.split(".")[0] or "").lower()
        if slug_guess:
            inst = manager.get(slug_guess)
    return inst


def resolve_control_target(
    entity_id: str,
    *,
    entity: dict[str, Any] | None = None,
    include_derived: bool = False,
    slug_hint: str | None = None,
) -> ControlTarget:
    """Resolve *entity_id* to integration + provider-specific target id."""
    from integrations import get_integration_manager

    raw = str(entity_id or "").strip()
    if not raw:
        raise ControlTargetNotFound("empty entity_id")

    record = entity or find_entity_record(raw, include_derived=include_derived)
    if record:
        target_id = str(record.get("unique_id") or record.get("entity_id") or raw)
        integration = integration_for_entity(record, raw_entity_id=raw)
        if integration is None and slug_hint:
            integration = get_integration_manager().get(slug_hint.strip())
        if integration is not None:
            return ControlTarget(raw, target_id, record, integration)

    manager = get_integration_manager()
    if slug_hint:
        integration = manager.get(slug_hint.strip())
        if integration is not None:
            return ControlTarget(raw, raw, record, integration)

    slug_guess = (raw.split(".")[0] or "").lower()
    integration = manager.get(slug_guess) if slug_guess else None
    if integration is not None:
        return ControlTarget(raw, raw, record, integration)

    raise ControlTargetNotFound(f"No integration found for {raw}")


async def control_entity(
    entity_id: str,
    action: str,
    data: dict[str, Any] | None = None,
    *,
    entity: dict[str, Any] | None = None,
    include_derived: bool = False,
    slug_hint: str | None = None,
) -> Any:
    """Async control: resolve entity → call integration.control_entity."""
    target = resolve_control_target(
        entity_id,
        entity=entity,
        include_derived=include_derived,
        slug_hint=slug_hint,
    )
    return await target.integration.control_entity(
        target.target_id,
        str(action or "").strip(),
        dict(data or {}),
    )


def control_entity_sync(
    entity_id: str,
    action: str,
    data: dict[str, Any] | None = None,
    *,
    entity: dict[str, Any] | None = None,
    slug_hint: str | None = None,
    timeout: float = 30.0,
) -> Any:
    """Run control_entity on the main asyncio loop (APScheduler / sync callers)."""
    from core.http.runtime import run_coroutine_on_main_loop

    return run_coroutine_on_main_loop(
        control_entity(
            entity_id,
            action,
            data,
            entity=entity,
            slug_hint=slug_hint,
        ),
        timeout=timeout,
    )
