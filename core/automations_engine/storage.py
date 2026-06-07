"""YAML storage helpers for automation definitions.

Pure filesystem helpers — no global state. Each function takes the
storage root as its first parameter so callers can swap roots in tests
or run against multiple roots. The legacy ``automation_definitions``
façade owns the module-level ``AUTOMATIONS_ROOT`` and supplies it to
these functions via thin wrappers; that keeps existing tests that do
``monkeypatch.setattr(ad, "AUTOMATIONS_ROOT", ...)`` working unchanged.
"""

from __future__ import annotations

import os
import re

from sqlalchemy.orm import Session


OWNER_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


def ensure_storage_root(root: str) -> str:
    os.makedirs(root, exist_ok=True)
    return root


def safe_owner_dir(root: str, owner_id: str) -> str:
    owner = OWNER_RE.sub("_", str(owner_id or "unknown")).strip("._") or "unknown"
    return os.path.join(ensure_storage_root(root), owner)


def yaml_path(root: str, owner_id: str, automation_id: str) -> str:
    return os.path.join(safe_owner_dir(root, owner_id), f"{automation_id}.yaml")


def yaml_relpath(root: str, owner_id: str, automation_id: str) -> str:
    safe_owner = os.path.basename(safe_owner_dir(root, owner_id))
    return os.path.join("automations", safe_owner, f"{automation_id}.yaml")


def write_yaml(root: str, owner_id: str, automation_id: str, source_yaml: str) -> str:
    owner_dir = safe_owner_dir(root, owner_id)
    os.makedirs(owner_dir, exist_ok=True)
    path = yaml_path(root, owner_id, automation_id)
    temp_path = f"{path}.tmp"
    normalized_text = (source_yaml or "").strip() + "\n"
    with open(temp_path, "w", encoding="utf-8") as handle:
        handle.write(normalized_text)
    os.replace(temp_path, path)
    return path


def read_yaml(root: str, owner_id: str, automation_id: str, fallback: str | None = None) -> str:
    path = yaml_path(root, owner_id, automation_id)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    if fallback is not None:
        write_yaml(root, owner_id, automation_id, fallback)
        return (fallback or "").strip() + "\n"
    raise FileNotFoundError(path)


def delete_yaml(root: str, owner_id: str, automation_id: str) -> None:
    path = yaml_path(root, owner_id, automation_id)
    if os.path.exists(path):
        os.remove(path)
    owner_dir = os.path.dirname(path)
    if os.path.isdir(owner_dir) and not os.listdir(owner_dir):
        os.rmdir(owner_dir)


def backfill_from_db(root: str, db: Session, model_cls) -> None:
    """Write missing on-disk YAML files for every definition row in the DB.

    Takes the model class as a parameter to avoid importing ``models`` from
    a low-level storage module.
    """
    ensure_storage_root(root)
    items = db.query(model_cls).all()
    for item in items:
        path = yaml_path(root, item.owner_id, item.id)
        if os.path.exists(path):
            continue
        if item.source_yaml:
            write_yaml(root, item.owner_id, item.id, item.source_yaml)
