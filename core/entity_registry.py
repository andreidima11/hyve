"""Hyve entity registry — persistent entity_id and name keyed by unique_id.

Home Assistant keeps ``unique_id`` stable while ``entity_id`` is user-editable.
Hyve mirrors that: discovery/sync may suggest new IDs, but registry rows win.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from contextlib import contextmanager
from typing import Any

from sqlalchemy import text

import database
from integrations.device_aliases import canonical_device_id
from smart_home_registry import KNOWN_DOMAINS, entity_domain, slugify_object_id

log = logging.getLogger("entity_registry")

_lock = threading.Lock()
_cache: dict[str, dict[str, Any]] | None = None
_entity_id_index: dict[str, str] | None = None

_ENTITY_ID_RE = re.compile(r"^([a-z_]+)\.([a-z0-9_]+)$")


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
    global _cache, _entity_id_index
    with _lock:
        _cache = None
        _entity_id_index = None


def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    entity_id_user_set = 0
    if len(row) >= 11:
        (
            unique_id,
            entity_id,
            domain,
            name,
            device_id,
            source,
            config_entry_id,
            disabled,
            created_at,
            updated_at,
            entity_id_user_set,
        ) = row[:11]
    else:
        (
            unique_id,
            entity_id,
            domain,
            name,
            device_id,
            source,
            config_entry_id,
            disabled,
            created_at,
            updated_at,
        ) = row
    return {
        "unique_id": unique_id,
        "entity_id": entity_id,
        "domain": domain,
        "name": name or "",
        "device_id": device_id or "",
        "source": source or "",
        "config_entry_id": config_entry_id or "",
        "disabled": bool(disabled),
        "created_at": float(created_at or 0),
        "updated_at": float(updated_at or 0),
        "entity_id_user_set": bool(entity_id_user_set),
    }


def _load_unlocked() -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    global _cache, _entity_id_index
    if _cache is not None and _entity_id_index is not None:
        return _cache, _entity_id_index
    by_uid: dict[str, dict[str, Any]] = {}
    by_eid: dict[str, str] = {}
    with _db() as db:
        rows = db.execute(text("""
            SELECT unique_id, entity_id, domain, name, device_id, source,
                   config_entry_id, disabled, created_at, updated_at,
                   entity_id_user_set
            FROM entity_registry
        """)).fetchall()
    for row in rows:
        item = _row_to_dict(row)
        by_uid[item["unique_id"]] = item
        by_eid[item["entity_id"]] = item["unique_id"]
    _cache = by_uid
    _entity_id_index = by_eid
    return by_uid, by_eid


def all_entries() -> list[dict[str, Any]]:
    by_uid, _ = _load_unlocked()
    return [dict(v) for v in by_uid.values()]


def get_by_unique_id(unique_id: str) -> dict[str, Any] | None:
    uid = (unique_id or "").strip()
    if not uid:
        return None
    by_uid, _ = _load_unlocked()
    row = by_uid.get(uid)
    return dict(row) if row else None


def get_by_entity_id(entity_id: str) -> dict[str, Any] | None:
    eid = (entity_id or "").strip()
    if not eid:
        return None
    _, by_eid = _load_unlocked()
    uid = by_eid.get(eid)
    if not uid:
        return None
    return get_by_unique_id(uid)


def normalize_entity_id(entity_id: str, domain: str | None = None) -> str:
    """Validate and normalize ``domain.object_id`` (HA-style)."""
    raw = (entity_id or "").strip().lower()
    if not raw:
        raise ValueError("entity_id is required")
    m = _ENTITY_ID_RE.match(raw)
    if not m:
        raise ValueError("entity_id must look like domain.object_id")
    dom = m.group(1)
    obj = slugify_object_id(m.group(2))
    if dom not in KNOWN_DOMAINS:
        raise ValueError(f"unsupported domain: {dom}")
    if domain and dom != str(domain).strip().lower():
        raise ValueError("entity_id domain must match entity domain")
    return f"{dom}.{obj}"


def _dedupe_entity_id(suggested: str, unique_id: str, by_eid: dict[str, str]) -> str:
    if suggested not in by_eid or by_eid[suggested] == unique_id:
        return suggested
    if "." not in suggested:
        return suggested
    dom, obj = suggested.split(".", 1)
    n = 2
    while n < 1000:
        candidate = f"{dom}.{obj}_{n}"
        if candidate not in by_eid or by_eid[candidate] == unique_id:
            return candidate
        n += 1
    return f"{dom}.{slugify_object_id(unique_id)}_{n}"


def _entity_device_id(entity: dict[str, Any]) -> str:
    attrs = entity.get("attributes") if isinstance(entity.get("attributes"), dict) else {}
    return str(
        entity.get("device_id")
        or attrs.get("device_id")
        or attrs.get("zigbee_ieee")
        or ""
    ).strip()


def register_entity(entity: dict[str, Any]) -> dict[str, Any]:
    """Insert a registry row when ``unique_id`` is new; return the stored row."""
    with _lock:
        by_uid, by_eid = _load_unlocked()
        return _register_entity_unlocked(entity, by_uid, by_eid)


def _register_entity_unlocked(
    entity: dict[str, Any],
    by_uid: dict[str, dict[str, Any]],
    by_eid: dict[str, str],
) -> dict[str, Any]:
    uid = str(entity.get("unique_id") or "").strip()
    eid = str(entity.get("entity_id") or "").strip()
    if not uid or not eid:
        raise ValueError("unique_id and entity_id are required")

    existing = by_uid.get(uid)
    if existing:
        return dict(existing)

    domain = str(entity.get("domain") or entity_domain(eid) or "sensor").strip().lower()
    if domain not in KNOWN_DOMAINS:
        domain = "sensor"

    now = time.time()
    name = str(entity.get("name") or "").strip()
    device_id = _entity_device_id(entity)
    source = str(entity.get("source") or "").strip()
    config_entry_id = str(entity.get("entry_id") or entity.get("config_entry_id") or "").strip()

    normalized = normalize_entity_id(eid, domain)
    final_eid = _dedupe_entity_id(normalized, uid, by_eid)

    with _db() as db:
        db.execute(text("""
            INSERT INTO entity_registry
            (unique_id, entity_id, domain, name, device_id, source,
             config_entry_id, disabled, created_at, updated_at, entity_id_user_set)
            VALUES
            (:uid, :eid, :domain, :name, :device_id, :source,
             :entry_id, 0, :created, :updated, 0)
        """), {
            "uid": uid,
            "eid": final_eid,
            "domain": domain,
            "name": name,
            "device_id": device_id,
            "source": source,
            "entry_id": config_entry_id,
            "created": now,
            "updated": now,
        })
        db.commit()

    row = {
        "unique_id": uid,
        "entity_id": final_eid,
        "domain": domain,
        "name": name,
        "device_id": device_id,
        "source": source,
        "config_entry_id": config_entry_id,
        "disabled": False,
        "created_at": now,
        "updated_at": now,
        "entity_id_user_set": False,
    }
    by_uid[uid] = row
    by_eid[final_eid] = uid
    return dict(row)


def _migrate_override_entity_id(old_eid: str, new_eid: str) -> None:
    if not old_eid or old_eid == new_eid:
        return
    with _db() as db:
        row = db.execute(
            text("SELECT custom_name, aliases, selected FROM integration_entity_overrides WHERE entity_id = :eid"),
            {"eid": old_eid},
        ).fetchone()
        if not row:
            return
        custom_name, aliases_json, selected = row
        db.execute(
            text("DELETE FROM integration_entity_overrides WHERE entity_id = :eid"),
            {"eid": old_eid},
        )
        db.execute(text("""
            INSERT OR REPLACE INTO integration_entity_overrides
            (entity_id, custom_name, aliases, selected)
            VALUES (:eid, :name, :aliases, :selected)
        """), {
            "eid": new_eid,
            "name": custom_name or "",
            "aliases": aliases_json or "[]",
            "selected": selected or 0,
        })
        db.commit()


def update_entry(
    unique_id: str,
    *,
    entity_id: str | None = None,
    name: str | None = None,
    disabled: bool | None = None,
    mark_user_set: bool | None = None,
) -> dict[str, Any]:
    """Update registry fields for ``unique_id``."""
    uid = (unique_id or "").strip()
    if not uid:
        raise ValueError("unique_id is required")

    with _lock:
        by_uid, by_eid = _load_unlocked()
        existing = by_uid.get(uid)
        if not existing:
            raise KeyError(uid)

        new_eid = existing["entity_id"]
        new_name = existing["name"]
        new_disabled = existing["disabled"]
        entity_id_user_set = bool(existing.get("entity_id_user_set"))

        if entity_id is not None:
            new_eid = normalize_entity_id(entity_id, existing["domain"])
            other = by_eid.get(new_eid)
            if other and other != uid:
                raise ValueError("entity_id already in use")
            if new_eid != existing["entity_id"]:
                if mark_user_set is None:
                    entity_id_user_set = True
                elif mark_user_set:
                    entity_id_user_set = True
                else:
                    entity_id_user_set = bool(existing.get("entity_id_user_set"))

        if name is not None:
            new_name = str(name).strip()

        if disabled is not None:
            new_disabled = bool(disabled)

        now = time.time()
        old_eid = existing["entity_id"]

        with _db() as db:
            db.execute(text("""
                UPDATE entity_registry
                SET entity_id = :eid,
                    name = :name,
                    disabled = :disabled,
                    entity_id_user_set = :user_set,
                    updated_at = :updated
                WHERE unique_id = :uid
            """), {
                "uid": uid,
                "eid": new_eid,
                "name": new_name,
                "disabled": 1 if new_disabled else 0,
                "user_set": 1 if entity_id_user_set else 0,
                "updated": now,
            })
            db.commit()

        if new_eid != old_eid:
            _migrate_override_entity_id(old_eid, new_eid)
            by_eid.pop(old_eid, None)
            by_eid[new_eid] = uid

        existing.update({
            "entity_id": new_eid,
            "name": new_name,
            "disabled": new_disabled,
            "entity_id_user_set": entity_id_user_set,
            "updated_at": now,
        })
        return dict(existing)


def _slug(value: str) -> str:
    from integrations.entity_utils import slugify

    return slugify(value or "")


_ENTITY_FEATURE_MARKERS = (
    "state_",
    "countdown_",
    "power_",
    "energy_",
    "voltage_",
    "current_",
    "linkquality",
)


def _device_slug_from_object_id(obj: str) -> str:
    """Extract the device portion from ``lampa_birou_state_l3`` → ``lampa_birou``."""
    text = str(obj or "").strip().lower()
    if not text:
        return ""
    for marker in _ENTITY_FEATURE_MARKERS:
        idx = text.find(marker)
        if idx > 0:
            return text[:idx].rstrip("_")
    if text.count("_") >= 2:
        return text.rsplit("_", 1)[0]
    return text


def _friendly_from_slug(slug: str) -> str:
    """Best-effort ``lampa_birou`` → ``Lampa Birou`` for rename matching."""
    parts = [p for p in re.sub(r"[-_]+", " ", str(slug or "")).split() if p]
    return " ".join(p[:1].upper() + p[1:] if p else "" for p in parts)


def _is_ieee_label(value: str) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    canonical = canonical_device_id(raw)
    return bool(canonical and re.match(r"^0x[0-9a-fA-F]{16}$", canonical))


def _collect_old_friendly_names(
    device_id: str,
    *,
    explicit: list[str] | None = None,
    exclude: str = "",
) -> list[str]:
    """Gather prior device labels that entity ids/names may still reference."""
    key = canonical_device_id(device_id) or str(device_id or "").strip()
    skip = {str(exclude or "").strip().lower()}
    seen: set[str] = set()
    out: list[str] = []

    def _add(raw: Any) -> None:
        label = str(raw or "").strip()
        if not label or _is_ieee_label(label):
            return
        norm = label.lower()
        if norm in skip or norm in seen:
            return
        seen.add(norm)
        out.append(label)

    for item in explicit or []:
        _add(item)

    try:
        from core import device_registry

        row = device_registry.get_device(key)
        if row:
            _add(row.get("z2m_friendly_name"))
            if row.get("name_by_user"):
                _add(row.get("name"))
    except Exception:
        pass

    for entry in entries_for_device(key):
        eid = str(entry.get("entity_id") or "")
        if "." in eid:
            obj = eid.split(".", 1)[1]
            slug_prefix = _device_slug_from_object_id(obj)
            _add(_friendly_from_slug(slug_prefix))
        uid = str(entry.get("unique_id") or "")
        if uid.startswith("z2m:"):
            slug_part = uid.split(":", 2)[1] if uid.count(":") >= 2 else ""
            _add(_friendly_from_slug(slug_part))

    out.sort(key=len, reverse=True)
    return out


def _matching_old_friendly(entry: dict[str, Any], old_names: list[str]) -> str | None:
    """Return the old device label that best matches this registry row."""
    name = str(entry.get("name") or "").strip()
    eid = str(entry.get("entity_id") or "")
    obj = eid.split(".", 1)[1] if "." in eid else ""
    uid = str(entry.get("unique_id") or "")

    for old in old_names:
        old_slug = _slug(old)
        if not old_slug:
            continue
        if name and name.lower().startswith(old.lower()):
            return old
        if obj and (obj == old_slug or obj.startswith(f"{old_slug}_")):
            return old
        if uid.startswith(f"z2m:{old_slug}:"):
            return old
    return None


def _suggest_name_after_rename(
    entry: dict[str, Any],
    *,
    old_friendly: str,
    new_friendly: str,
) -> str | None:
    name = str(entry.get("name") or "").strip()
    if not name or not old_friendly:
        return None
    if name.lower().startswith(old_friendly.lower()):
        tail = name[len(old_friendly):].strip()
        return f"{new_friendly} {tail}".strip() if tail else new_friendly
    return None


def _suggest_entity_id_after_rename(
    entry: dict[str, Any],
    *,
    old_friendly: str,
    new_friendly: str,
) -> str | None:
    """Return a new entity_id when the old one clearly followed the device slug."""
    if entry.get("entity_id_user_set"):
        return None
    domain = str(entry.get("domain") or "sensor").strip().lower()
    eid = str(entry.get("entity_id") or "")
    if "." not in eid:
        return None
    _, obj = eid.split(".", 1)
    old_slug = _slug(old_friendly)
    new_slug = _slug(new_friendly)
    if not old_slug or not new_slug or old_slug == new_slug:
        return None

    suffix = ""
    if obj == old_slug:
        suffix = ""
    elif obj.startswith(old_slug + "_"):
        suffix = obj[len(old_slug) + 1:]
    elif obj.startswith(old_slug):
        suffix = obj[len(old_slug):].lstrip("_")
    else:
        return None

    basis = new_friendly if not suffix else f"{new_friendly}_{suffix.replace('-', '_')}"
    try:
        return normalize_entity_id(f"{domain}.{_slug(basis)}", domain)
    except ValueError:
        return None


def _migrate_unique_id_unlocked(
    by_uid: dict[str, dict[str, Any]],
    by_eid: dict[str, str],
    old_uid: str,
    new_uid: str,
) -> None:
    if not old_uid or not new_uid or old_uid == new_uid:
        return
    row = by_uid.get(old_uid)
    if not row or new_uid in by_uid:
        return
    now = time.time()
    with _db() as db:
        db.execute(text("""
            INSERT INTO entity_registry
            (unique_id, entity_id, domain, name, device_id, source,
             config_entry_id, disabled, created_at, updated_at, entity_id_user_set)
            SELECT :new_uid, entity_id, domain, name, device_id, source,
                   config_entry_id, disabled, created_at, :updated, entity_id_user_set
            FROM entity_registry WHERE unique_id = :old_uid
        """), {"new_uid": new_uid, "old_uid": old_uid, "updated": now})
        db.execute(text("DELETE FROM entity_registry WHERE unique_id = :old_uid"), {"old_uid": old_uid})
        db.commit()
    new_row = dict(row)
    new_row["unique_id"] = new_uid
    new_row["updated_at"] = now
    by_uid[new_uid] = new_row
    by_uid.pop(old_uid, None)
    by_eid[new_row["entity_id"]] = new_uid


def refresh_entity_ids_for_device_rename(
    device_id: str,
    *,
    old_friendly: str = "",
    old_friendly_names: list[str] | None = None,
    new_friendly: str = "",
) -> dict[str, Any]:
    """After a device rename, align auto-generated registry entity_ids and names."""
    key = canonical_device_id(device_id) or str(device_id or "").strip()
    if not key:
        return {"updated": 0, "names_updated": 0, "skipped": 0}

    new_friendly = str(new_friendly or "").strip()
    if not new_friendly:
        return {"updated": 0, "names_updated": 0, "skipped": 0, "reason": "missing_new_name"}

    explicit = list(old_friendly_names or [])
    if old_friendly:
        explicit.insert(0, old_friendly)
    old_names = _collect_old_friendly_names(key, explicit=explicit, exclude=new_friendly)
    if not old_names:
        return {
            "updated": 0,
            "names_updated": 0,
            "skipped": 0,
            "reason": "missing_old_names",
            "device_id": key,
            "new_friendly": new_friendly,
        }

    new_slug = _slug(new_friendly)
    pending: list[tuple[str, str | None, str | None]] = []
    uid_migrations: list[tuple[str, str]] = []
    skipped = 0

    with _lock:
        by_uid, by_eid = _load_unlocked()
        targets = [
            dict(row)
            for row in by_uid.values()
            if canonical_device_id(row.get("device_id")) == key
        ]

        for entry in targets:
            if entry.get("entity_id_user_set"):
                skipped += 1
                continue

            old_match = _matching_old_friendly(entry, old_names)
            if not old_match:
                skipped += 1
                continue

            uid = entry["unique_id"]
            old_slug = _slug(old_match)
            if old_slug and uid.startswith(f"z2m:{old_slug}:"):
                prop = uid.split(":", 2)[2]
                new_uid = f"z2m:{new_slug}:{prop}"
                if new_uid != uid:
                    uid_migrations.append((uid, new_uid))
                    uid = new_uid
                    entry = dict(by_uid.get(new_uid) or entry)

            suggested_eid = _suggest_entity_id_after_rename(
                entry,
                old_friendly=old_match,
                new_friendly=new_friendly,
            )
            suggested_name = _suggest_name_after_rename(
                entry,
                old_friendly=old_match,
                new_friendly=new_friendly,
            )
            if (
                (not suggested_eid or suggested_eid == entry.get("entity_id"))
                and (not suggested_name or suggested_name == entry.get("name"))
            ):
                skipped += 1
                continue
            pending.append((uid, suggested_eid, suggested_name))

        for old_uid, new_uid in uid_migrations:
            _migrate_unique_id_unlocked(by_uid, by_eid, old_uid, new_uid)

    ids_updated = 0
    names_updated = 0
    for uid, suggested_eid, suggested_name in pending:
        existing = get_by_unique_id(uid)
        if not existing:
            continue
        kwargs: dict[str, Any] = {"mark_user_set": False}
        if suggested_eid and suggested_eid != existing.get("entity_id"):
            kwargs["entity_id"] = suggested_eid
        if suggested_name and suggested_name != existing.get("name"):
            kwargs["name"] = suggested_name
        if len(kwargs) <= 1:
            continue
        try:
            update_entry(uid, **kwargs)
            if "entity_id" in kwargs:
                ids_updated += 1
            if "name" in kwargs:
                names_updated += 1
        except Exception as exc:
            log.debug("entity refresh failed for %s: %s", uid, exc)
            skipped += 1

    return {
        "updated": ids_updated,
        "names_updated": names_updated,
        "skipped": skipped,
        "device_id": key,
        "old_friendly_names": old_names,
        "new_friendly": new_friendly,
    }


def entries_for_device(device_id: str) -> list[dict[str, Any]]:
    key = canonical_device_id(device_id) or str(device_id or "").strip()
    if not key:
        return []
    by_uid, _ = _load_unlocked()
    return [
        dict(row)
        for row in by_uid.values()
        if canonical_device_id(row.get("device_id")) == key
    ]


def sync_entities(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Register unseen entities and apply registry entity_id/name in-place."""
    if not entities:
        return entities

    with _lock:
        by_uid, by_eid = _load_unlocked()
        for entity in entities:
            uid = str(entity.get("unique_id") or "").strip()
            eid = str(entity.get("entity_id") or "").strip()
            if not uid or not eid:
                continue

            row = by_uid.get(uid)
            if row is None:
                try:
                    row = _register_entity_unlocked(entity, by_uid, by_eid)
                except Exception as exc:
                    log.debug("registry register failed for %s: %s", uid, exc)
                    continue

            entity["entity_id"] = row["entity_id"]
            if row.get("name"):
                entity["name"] = row["name"]
            if row.get("disabled"):
                entity["disabled"] = True
            attrs = entity.setdefault("attributes", {})
            if isinstance(attrs, dict):
                attrs["registry_unique_id"] = uid

    return entities
