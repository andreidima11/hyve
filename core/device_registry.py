"""Hyve device registry — persistent device metadata keyed by device_id.

Mirrors Home Assistant's device_registry: IEEE / stable id is the primary key;
manufacturer, model, and Z2M friendly_name are synced from upstream; the display
``name`` survives restarts and user renames even when Z2M forgets.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from contextlib import contextmanager
from typing import Any

from sqlalchemy import text

import core.database as database
from integrations.device_aliases import canonical_device_id

log = logging.getLogger("device_registry")

_lock = threading.Lock()
_cache: dict[str, dict[str, Any]] | None = None

_IEEE_RE = re.compile(r"^0x[0-9a-fA-F]{16}$")


def _z2m_names_equal(a: str, b: str) -> bool:
    def norm(s: str) -> str:
        return re.sub(r"[\s_]+", "", str(s or "").strip().lower())

    return norm(a) == norm(b)


@contextmanager
def _db():
    gen = database.get_db()
    session = next(gen)
    try:
        yield session
    finally:
        session.close()


def reload() -> None:
    """Drop in-memory cache so the next read hits SQLite."""
    global _cache
    with _lock:
        _cache = None


def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        device_id,
        name,
        manufacturer,
        model,
        via_device_id,
        area_id,
        source,
        config_entry_id,
        z2m_friendly_name,
        name_by_user,
        created_at,
        updated_at,
    ) = row
    return {
        "device_id": device_id,
        "name": name or "",
        "manufacturer": manufacturer or "",
        "model": model or "",
        "via_device_id": via_device_id or "",
        "area_id": area_id or "",
        "source": source or "",
        "config_entry_id": config_entry_id or "",
        "z2m_friendly_name": z2m_friendly_name or "",
        "name_by_user": bool(name_by_user),
        "created_at": float(created_at or 0),
        "updated_at": float(updated_at or 0),
    }


def _load_unlocked() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is not None:
        return _cache
    out: dict[str, dict[str, Any]] = {}
    with _db() as db:
        rows = db.execute(text("""
            SELECT device_id, name, manufacturer, model, via_device_id, area_id,
                   source, config_entry_id, z2m_friendly_name, name_by_user,
                   created_at, updated_at
            FROM device_registry
        """)).fetchall()
    for row in rows:
        item = _row_to_dict(row)
        out[item["device_id"]] = item
    _cache = out
    return out


def all_entries(*, source: str | None = None) -> list[dict[str, Any]]:
    by_id = _load_unlocked()
    items = [dict(v) for v in by_id.values()]
    if source:
        src = str(source).strip()
        items = [item for item in items if item.get("source") == src]
    return items


def get_device(device_id: str) -> dict[str, Any] | None:
    key = canonical_device_id(device_id)
    if not key:
        return None
    row = _load_unlocked().get(key)
    return dict(row) if row else None


def bootstrap_from_aliases() -> int:
    """Import existing YAML device aliases into the registry (one-time fill)."""
    try:
        from integrations import device_aliases
    except Exception:
        return 0

    imported = 0
    with _lock:
        by_id = _load_unlocked()
        for slug, mapping in device_aliases.all_aliases().items():
            for did, name in (mapping or {}).items():
                key = canonical_device_id(did)
                if not key or not name.strip():
                    continue
                if key in by_id:
                    continue
                try:
                    _upsert_unlocked(
                        by_id,
                        device_id=key,
                        name=name.strip(),
                        source=str(slug),
                        name_by_user=True,
                    )
                    imported += 1
                except Exception as exc:
                    log.debug("alias bootstrap failed for %s: %s", key, exc)
    return imported


def _upsert_unlocked(
    by_id: dict[str, dict[str, Any]],
    *,
    device_id: str,
    name: str,
    source: str,
    manufacturer: str = "",
    model: str = "",
    via_device_id: str = "",
    area_id: str = "",
    config_entry_id: str = "",
    z2m_friendly_name: str = "",
    name_by_user: bool = False,
) -> dict[str, Any]:
    key = canonical_device_id(device_id)
    if not key:
        raise ValueError("device_id is required")
    cleaned_name = (name or "").strip()
    if not cleaned_name:
        raise ValueError("name is required")

    existing = by_id.get(key)
    now = time.time()
    created = float(existing["created_at"]) if existing else now
    # ``name_by_user=True`` on this call means an explicit user rename
    # (``set_device_name``). Upstream sync must pass ``name_by_user=False``
    # so an existing user label is never replaced by Z2M's friendly_name.
    if name_by_user:
        final_name = cleaned_name
        final_name_by_user = True
    elif existing and existing.get("name_by_user"):
        existing_name = str(existing.get("name") or "").strip()
        if (
            cleaned_name
            and not _z2m_names_equal(existing_name, cleaned_name)
            and _z2m_names_equal(z2m_friendly_name or cleaned_name, cleaned_name)
        ):
            final_name = cleaned_name
        else:
            final_name = existing_name or cleaned_name
        final_name_by_user = True
    elif existing:
        final_name = cleaned_name or existing.get("name") or ""
        final_name_by_user = bool(existing.get("name_by_user"))
    else:
        final_name = cleaned_name
        final_name_by_user = False

    row = {
        "device_id": key,
        "name": final_name,
        "manufacturer": manufacturer or (existing or {}).get("manufacturer", ""),
        "model": model or (existing or {}).get("model", ""),
        "via_device_id": via_device_id or (existing or {}).get("via_device_id", ""),
        "area_id": area_id or (existing or {}).get("area_id", ""),
        "source": source or (existing or {}).get("source", ""),
        "config_entry_id": config_entry_id or (existing or {}).get("config_entry_id", ""),
        "z2m_friendly_name": z2m_friendly_name or (existing or {}).get("z2m_friendly_name", ""),
        "name_by_user": final_name_by_user,
        "created_at": created,
        "updated_at": now,
    }

    with _db() as db:
        db.execute(text("""
            INSERT OR REPLACE INTO device_registry
            (device_id, name, manufacturer, model, via_device_id, area_id,
             source, config_entry_id, z2m_friendly_name, name_by_user,
             created_at, updated_at)
            VALUES
            (:device_id, :name, :manufacturer, :model, :via_device_id, :area_id,
             :source, :entry_id, :z2m_name, :name_by_user, :created, :updated)
        """), {
            "device_id": row["device_id"],
            "name": row["name"],
            "manufacturer": row["manufacturer"],
            "model": row["model"],
            "via_device_id": row["via_device_id"],
            "area_id": row["area_id"],
            "source": row["source"],
            "entry_id": row["config_entry_id"],
            "z2m_name": row["z2m_friendly_name"],
            "name_by_user": 1 if row["name_by_user"] else 0,
            "created": row["created_at"],
            "updated": row["updated_at"],
        })
        db.commit()

    by_id[key] = row
    return dict(row)


def set_device_name(
    device_id: str,
    name: str,
    *,
    source: str,
    config_entry_id: str = "",
    z2m_friendly_name: str = "",
) -> dict[str, Any]:
    """Persist a user-chosen device display name."""
    with _lock:
        by_id = _load_unlocked()
        return _upsert_unlocked(
            by_id,
            device_id=device_id,
            name=name,
            source=source,
            config_entry_id=config_entry_id,
            z2m_friendly_name=z2m_friendly_name or name,
            name_by_user=True,
        )


def sync_z2m_devices(
    devices: list[Any],
    *,
    source: str = "mosquitto",
    config_entry_id: str = "",
) -> int:
    """Merge Z2M bridge/devices snapshot into the registry.

    Does not overwrite ``name`` when ``name_by_user`` is set or when a YAML
    alias already exists (legacy path).
    """
    if not devices:
        return 0

    try:
        from integrations import device_aliases
    except Exception:
        device_aliases = None  # type: ignore[assignment]

    synced = 0
    with _lock:
        by_id = _load_unlocked()
        for raw in devices:
            if not isinstance(raw, dict) or raw.get("type") == "Coordinator":
                continue
            ieee = canonical_device_id(raw.get("ieee_address"))
            friendly = str(raw.get("friendly_name") or "").strip()
            if not ieee or not friendly:
                continue

            definition = raw.get("definition") if isinstance(raw.get("definition"), dict) else {}
            manufacturer = str(definition.get("vendor") or "").strip()
            model = str(definition.get("model") or "").strip()

            existing = by_id.get(ieee)
            yaml_alias = (
                device_aliases.get_alias(source, ieee)
                if device_aliases is not None
                else None
            )
            ieee_friendly = bool(_IEEE_RE.match(friendly))

            if existing and existing.get("name_by_user"):
                display_name = str(existing.get("name") or "").strip()
                z2m_stored = str(existing.get("z2m_friendly_name") or "").strip()
                if (
                    not ieee_friendly
                    and z2m_stored
                    and not _IEEE_RE.match(z2m_stored)
                    and _z2m_names_equal(z2m_stored, friendly)
                    and not _z2m_names_equal(display_name, friendly)
                ):
                    display_name = friendly
            elif ieee_friendly:
                # Z2M lost the friendly name — fall back to registry, then YAML.
                reg_name = str((existing or {}).get("name") or "").strip()
                if reg_name and not _IEEE_RE.match(reg_name):
                    display_name = reg_name
                elif yaml_alias:
                    display_name = yaml_alias
                elif existing:
                    display_name = reg_name
                    if not display_name or _IEEE_RE.match(display_name):
                        continue
                else:
                    continue
            else:
                # Z2M reports a human-friendly name. Keep a different registry
                # display name — Z2M often forgets Hyve-side renames after restart.
                reg_name = str((existing or {}).get("name") or "").strip()
                if (
                    existing
                    and reg_name
                    and not _IEEE_RE.match(reg_name)
                    and reg_name.lower() != friendly.lower()
                ):
                    display_name = reg_name
                else:
                    display_name = friendly

            if (
                device_aliases is not None
                and display_name
                and yaml_alias
                and yaml_alias != display_name
                and existing
                and existing.get("name_by_user")
            ):
                # Repair stale YAML only from an explicit user registry name —
                # never push Z2M's friendly_name back into device_aliases.yaml.
                try:
                    device_aliases.set_alias(source, ieee, display_name)
                except Exception:
                    pass

            z2m_name = friendly if not ieee_friendly else str(
                (existing or {}).get("z2m_friendly_name") or yaml_alias or friendly
            )

            try:
                _upsert_unlocked(
                    by_id,
                    device_id=ieee,
                    name=display_name,
                    source=source,
                    manufacturer=manufacturer,
                    model=model,
                    config_entry_id=config_entry_id,
                    z2m_friendly_name=z2m_name or friendly,
                    name_by_user=False,
                )
                synced += 1
            except Exception as exc:
                log.debug("device registry sync skip %s: %s", ieee, exc)
    return synced


def resolve_device_id_by_friendly(friendly_name: str) -> str | None:
    """Return canonical IEEE for a Z2M friendly_name, if known."""
    needle = str(friendly_name or "").strip().lower()
    if not needle:
        return None
    for item in _load_unlocked().values():
        z2m = str(item.get("z2m_friendly_name") or "").strip().lower()
        name = str(item.get("name") or "").strip().lower()
        if needle in {z2m, name}:
            return item["device_id"]
    return None


def resolve_device_id_from_z2m_devices(from_value: str, devices: list[Any]) -> str:
    """Map a Z2M rename ``from`` field (IEEE or friendly_name) to canonical IEEE."""
    raw = str(from_value or "").strip()
    canonical = canonical_device_id(raw)
    if canonical and _IEEE_RE.match(canonical):
        return canonical
    needle = raw.lower()
    if not needle:
        return ""
    for item in devices:
        if not isinstance(item, dict):
            continue
        ieee = canonical_device_id(item.get("ieee_address"))
        friendly = str(item.get("friendly_name") or "").strip().lower()
        if ieee and friendly == needle:
            return ieee
    by_friendly = resolve_device_id_by_friendly(from_value)
    if by_friendly:
        return by_friendly
    for row in _load_unlocked().values():
        z2m = str(row.get("z2m_friendly_name") or "").strip().lower()
        if z2m == needle:
            return row["device_id"]
    return ""


def apply_to_entities(slug: str, entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Overlay registry device metadata onto entity dicts."""
    src = str(slug or "").strip()
    if not src:
        return entities

    by_id = _load_unlocked()
    relevant = {
        key: row
        for key, row in by_id.items()
        if not row.get("source") or row.get("source") == src
    }
    if not relevant:
        return entities

    for ent in entities:
        attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
        raw_did = ent.get("device_id") or attrs.get("device_id") or attrs.get("zigbee_ieee") or ""
        key = canonical_device_id(raw_did)
        if not key or key not in relevant:
            continue
        row = relevant[key]
        display = str(row.get("name") or "").strip()
        if display:
            old_device_name = str(
                ent.get("device_name")
                or (attrs.get("device_name") if isinstance(attrs, dict) else "")
                or ""
            )
            ent["device_name"] = display
            if isinstance(attrs, dict):
                attrs["device_name"] = display
                attrs["device_id"] = key
                if row.get("manufacturer"):
                    attrs["device_manufacturer"] = row["manufacturer"]
                if row.get("model"):
                    attrs["device_model"] = row["model"]
                if row.get("z2m_friendly_name"):
                    attrs["z2m_friendly_name"] = row["z2m_friendly_name"]
            if "device_id" in ent:
                ent["device_id"] = key
            cur_name = str(ent.get("name") or "")
            if not cur_name or not display:
                continue
            renamed = False
            if old_device_name and cur_name.lower().startswith(old_device_name.lower()):
                tail = cur_name[len(old_device_name):].strip()
                ent["name"] = f"{display} {tail}".strip() if tail else display
                renamed = True
            elif cur_name.lower().startswith(key.lower()):
                tail = cur_name[len(key):].strip()
                ent["name"] = f"{display} {tail}".strip() if tail else display
                renamed = True
            if not renamed and display.lower() not in cur_name.lower():
                z2m_fn = str(row.get("z2m_friendly_name") or "").strip()
                for stale in (z2m_fn, old_device_name):
                    if stale and stale.lower() != display.lower() and cur_name.lower().startswith(stale.lower()):
                        tail = cur_name[len(stale):].strip()
                        ent["name"] = f"{display} {tail}".strip() if tail else display
                        break
    return entities
