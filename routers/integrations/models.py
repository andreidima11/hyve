from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class EntitySelectionBody(BaseModel):
    entity_id: str
    selected: bool
    unique_id: str | None = None


class EntityRegistryUpdateBody(BaseModel):
    entity_id: str | None = None
    name: str | None = None
    disabled: bool | None = None


class DeviceControlBody(BaseModel):
    entity_id: str
    action: str
    data: dict[str, Any] | None = None


class DeviceRenameBody(BaseModel):
    name: str
    current_name: str | None = None
    homeassistant_rename: bool = True


class ConfigEntryBody(BaseModel):
    title: str | None = None
    data: dict[str, Any] | None = None
    enabled: bool | None = None


class ConfigEntryTestBody(BaseModel):
    data: dict[str, Any] | None = None
    entry_id: str | None = None
