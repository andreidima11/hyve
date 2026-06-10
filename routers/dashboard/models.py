from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from routers.dashboard.constants import _DEFAULT_DASHBOARD_ICON, _DEFAULT_PAGE_TITLE

class DashboardWidgetBody(BaseModel):
    type: str = "button"
    entity_id: str = Field(min_length=1)
    unique_id: str | None = None
    entity_name: str = ""
    title: str = ""
    panel_id: str | None = None
    page_id: str | None = None
    source: str = "zigbee2mqtt"
    icon: str | None = None
    color: str | None = None
    size: Literal["sm", "md", "wide"] = "md"
    favorite: bool = False
    show_background: bool = False
    switch_style: bool = False
    renderer: str | None = None
    config: dict[str, Any] | None = None
    col_span: int | None = None
    row_span: int | None = None
    col_start: int | None = None
    row_start: int | None = None
    visibility: dict[str, Any] | None = None


class DashboardToggleBody(BaseModel):
    desired_state: Literal["on", "off"] | None = None
    entity_id: str | None = None
    action: str | None = None
    data: dict[str, Any] | None = None


class DashboardPreferencesBody(BaseModel):
    layout_mode: Literal["comfortable", "compact"] = "comfortable"
    show_unavailable: bool = True
    filter_mode: Literal["all", "switch", "info", "zigbee2mqtt", "pago", "fusion_solar"] = "all"
    title: str | None = None
    subtitle: str | None = None
    icon: str | None = None


class DashboardPageBody(BaseModel):
    title: str = _DEFAULT_PAGE_TITLE
    subtitle: str = "Panou control"
    icon: str = _DEFAULT_DASHBOARD_ICON
    columns: int = 0


class DashboardPageUpdateBody(BaseModel):
    title: str = _DEFAULT_PAGE_TITLE
    subtitle: str = "Panou control"
    icon: str = _DEFAULT_DASHBOARD_ICON
    columns: int | None = None
    theme: str | None = None
    parent_page_id: str | None = None


class DashboardMoveBody(BaseModel):
    direction: Literal["left", "right", "up", "down"] = "right"


class DashboardPanelPageBody(BaseModel):
    id: str | None = None
    title: str = ""
    icon: str = ""


class DashboardPanelBody(BaseModel):
    title: str = ""
    size: Literal["sm", "md", "wide"] = "md"
    icon: str = ""
    pages: list[DashboardPanelPageBody] | None = None
    show_pagination: bool = True


class DashboardPanelUpdateBody(BaseModel):
    title: str = ""
    size: Literal["sm", "md", "wide"] = "md"
    icon: str = ""
    pages: list[DashboardPanelPageBody] | None = None
    show_pagination: bool = True
    visibility: dict[str, Any] | None = None
    background: dict[str, Any] | None = None


class DashboardPanelLayoutBody(BaseModel):
    col_start: int | None = None
    row_start: int | None = None
    row_span: int | None = None


class DashboardReorderBody(BaseModel):
    target_id: str = Field(min_length=1)


class DashboardWidgetRelocateBody(BaseModel):
    target_panel_id: str = Field(min_length=1)
    target_page_id: str | None = None
    before_widget_id: str | None = None
    layout_column: int | None = None


class DashboardWidgetUpdateBody(BaseModel):
    type: str | None = None
    entity_id: str | None = None
    unique_id: str | None = None
    entity_name: str | None = None
    title: str | None = None
    panel_id: str | None = None
    page_id: str | None = None
    source: str | None = None
    icon: str | None = None
    color: str | None = None
    size: Literal["sm", "md", "wide"] | None = None
    favorite: bool | None = None
    show_background: bool | None = None
    switch_style: bool | None = None
    renderer: str | None = None
    config: dict[str, Any] | None = None
    layout_column: int | None = None
    col_span: int | None = None
    row_span: int | None = None
    col_start: int | None = None
    row_start: int | None = None
    visibility: dict[str, Any] | None = None


class DashboardHistoryBatchBody(BaseModel):
    entity_ids: list[str]
    hours: float = 24.0


class DashboardDefaultPageBody(BaseModel):
    page_id: str | None = None


class DashboardTemplateSaveBody(BaseModel):
    name: str = Field(min_length=1)
    widget_id: str | None = None
    widget: dict[str, Any] | None = None


class DashboardTemplateInstantiateBody(BaseModel):
    panel_id: str | None = None
    page_id: str | None = None


class DashboardImportBody(BaseModel):
    payload: dict[str, Any] = Field(..., description="Exported dashboard JSON")
    mode: Literal["replace", "merge"] = "merge"


class DashboardPageYamlBody(BaseModel):
    yaml: str = Field(..., min_length=1, max_length=500_000)

