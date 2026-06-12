"""Per-device Mammotion coordinator — Hyve port of HA MammotionReportUpdateCoordinator controls."""

from __future__ import annotations

import asyncio
import logging
import time
from copy import copy
from typing import Any, cast

from pymammotion.data.model import GenerateRouteInformation
from pymammotion.data.model.device import MowingDevice
from pymammotion.data.model.device_config import OperationSettings, create_path_order
from pymammotion.data.model.hash_list import Plan
from pymammotion.data.model.mowing_modes import (
    BorderPatrolMode,
    CuttingMode,
    DetectionStrategy,
    MowOrder,
    ObstacleLapsMode,
    PathAngleSetting,
)
from pymammotion.proto import MulSex
from pymammotion.utility.device_type import DeviceType

from components.mammotion.command_transport import async_send_and_wait, async_send_command
from components.mammotion.coordinators.errors import ErrorCoordinator
from components.mammotion.coordinators.map import MapCoordinator
from components.mammotion.coordinators.report import ReportCoordinator

log = logging.getLogger("mammotion.coordinator")


def _make_copy_name(name: str) -> str:
    base = str(name or "Task").strip() or "Task"
    return f"{base} (copy)"


class MowerCoordinator:
    """Device-scoped control + settings state (no Home Assistant deps)."""

    def __init__(
        self,
        client: Any,
        device_name: str,
        *,
        operation_settings: OperationSettings | None = None,
        map_offset_lat: float = 0.0,
        map_offset_lon: float = 0.0,
        bluetooth_enabled: bool = True,
        cloud_enabled: bool = True,
        movement_use_wifi: bool = False,
        hub: Any | None = None,
    ) -> None:
        self._client = client
        self._hub = hub
        self.device_name = device_name
        self.operation_settings = operation_settings or OperationSettings()
        self.map_offset_lat = map_offset_lat
        self.map_offset_lon = map_offset_lon
        self.bluetooth_enabled = bluetooth_enabled
        self.cloud_enabled = cloud_enabled
        self.movement_use_wifi = movement_use_wifi
        self.report = ReportCoordinator(client, device_name)
        self.map = MapCoordinator(client, device_name)
        self.errors = ErrorCoordinator(client, device_name)
        self._last_fresh_at: float | None = None

    @property
    def map_sync_status(self) -> str:
        return self.map.map_sync_status

    @map_sync_status.setter
    def map_sync_status(self, value: str) -> None:
        self.map.map_sync_status = value

    @property
    def mqtt_online(self) -> bool:
        return self.report.mqtt_online

    @mqtt_online.setter
    def mqtt_online(self, value: bool) -> None:
        self.report.mqtt_online = value

    @property
    def data(self) -> MowingDevice | None:
        device = self._client.get_device_by_name(self.device_name)
        return cast(MowingDevice | None, device)

    def meta(self) -> dict[str, Any]:
        device = self.data
        if device is not None:
            self.errors.refresh(device)
        merged: dict[str, Any] = {
            "operation_settings": self.operation_settings.to_dict(),
            "map_offset_lat": self.map_offset_lat,
            "map_offset_lon": self.map_offset_lon,
            "bluetooth_enabled": self.bluetooth_enabled,
            "cloud_enabled": self.cloud_enabled,
        }
        merged.update(self.report.meta())
        merged.update(self.map.meta())
        merged.update(self.errors.meta())
        return merged

    async def _send(self, key: str, **kwargs: Any) -> None:
        await async_send_command(
            self._client,
            self.device_name,
            key,
            bluetooth_enabled=self.bluetooth_enabled,
            **kwargs,
        )

    async def _send_and_wait(self, key: str, expected_field: str, **kwargs: Any) -> Any:
        return await async_send_and_wait(
            self._client,
            self.device_name,
            key,
            expected_field,
            bluetooth_enabled=self.bluetooth_enabled,
            **kwargs,
        )

    async def _ensure_fresh_state(self) -> None:
        from components.mammotion.session_bootstrap import ensure_fresh_state

        self.report.last_fresh_at = await ensure_fresh_state(
            self._client,
            self.device_name,
            last_fresh_at=self.report.last_fresh_at,
        )

    async def _ensure_ready_for_control(self) -> None:
        await self.report.ensure_ready_for_control()
        self._last_fresh_at = self.report.last_fresh_at

    async def refresh_snapshot(self) -> None:
        await self.report.refresh_snapshot()
        self._last_fresh_at = self.report.last_fresh_at

    async def request_report_snapshot(self) -> None:
        await self.report.request_report_snapshot()
        self._last_fresh_at = self.report.last_fresh_at

    async def start_mow(self, **kwargs: Any) -> None:
        from pymammotion.utility.constant.device_constant import WorkMode

        await self._ensure_fresh_state()

        operational = copy(self.operation_settings)
        area_hashes = kwargs.pop("areas", None) or kwargs.pop("area_hashes", None)
        if area_hashes is not None:
            operational.areas = [int(h) for h in area_hashes]
        modify_plan = bool(kwargs.pop("modify", False))
        plan_only = bool(kwargs.pop("plan_only", False))

        for key, value in kwargs.items():
            if hasattr(operational, key):
                setattr(operational, key, value)
        if DeviceType.is_yuka(self.device_name):
            operational.blade_height = -10

        device = self.data
        if device is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")

        dev = getattr(getattr(device, "report_data", None), "dev", None)
        if dev is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")

        mode = int(getattr(dev, "sys_status", 0) or 0)
        bp_info = getattr(getattr(getattr(device, "report_data", None), "work", None), "bp_info", 0)

        if mode not in (
            WorkMode.MODE_PAUSE,
            WorkMode.MODE_READY,
            WorkMode.MODE_RETURNING,
            WorkMode.MODE_WORKING,
            WorkMode.MODE_INITIALIZATION,
        ):
            return

        try:
            if modify_plan:
                await self.modify_plan_route(operational)
                return

            if area_hashes is not None:
                await self.cancel_job()

            if mode == WorkMode.MODE_RETURNING:
                await self._send_and_wait("cancel_return_to_dock", "todev_taskctrl_ack")
                await self.request_report_snapshot()
                device = self.data
                dev = device.report_data.dev if device else dev
                mode = int(getattr(dev, "sys_status", mode) or mode) if dev is not None else mode

            if mode == WorkMode.MODE_PAUSE and bp_info != 0:
                await self._send("resume_execute_task")
                await self._send_and_wait("query_generate_route_information", "bidire_reqconver_path")

            if mode in (WorkMode.MODE_READY, WorkMode.MODE_INITIALIZATION):
                if bp_info != 0:
                    await self._send_and_wait("query_generate_route_information", "bidire_reqconver_path")
                    if not plan_only:
                        await self._send("start_job")
                    return
                await self.plan_route(operational)
                if not plan_only:
                    await self._send_and_wait("start_job", "zone_start_precent_t", send_timeout=15.0)
        finally:
            await self.request_report_snapshot()

    async def pause(self) -> None:
        from pymammotion.utility.constant.device_constant import WorkMode

        await self._ensure_fresh_state()
        device = self.data
        if device is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")
        dev = getattr(getattr(device, "report_data", None), "dev", None)
        if dev is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")
        mode = int(getattr(dev, "sys_status", 0) or 0)

        if mode not in (WorkMode.MODE_WORKING, WorkMode.MODE_RETURNING):
            raise ValueError("Nu se poate pune pe pauză în starea curentă.")

        try:
            if mode == WorkMode.MODE_WORKING:
                await self._send("pause_execute_task")
            elif mode == WorkMode.MODE_RETURNING:
                await self._send("cancel_return_to_dock")
        finally:
            await self.request_report_snapshot()

    async def dock(self) -> None:
        from components.mammotion.session_bootstrap import start_report_stream
        from pymammotion.utility.constant.device_constant import WorkMode

        await start_report_stream(self._client, self.device_name)

        device = self.data
        if device is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")
        dev = getattr(getattr(device, "report_data", None), "dev", None)
        if dev is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")

        charge = int(getattr(dev, "charge_state", 0) or 0)
        mode = int(getattr(dev, "sys_status", 0) or 0)

        if not (
            charge == 0
            and mode
            in (
                WorkMode.MODE_WORKING,
                WorkMode.MODE_PAUSE,
                WorkMode.MODE_READY,
                WorkMode.MODE_RETURNING,
            )
        ):
            return

        try:
            if mode == WorkMode.MODE_WORKING:
                await self._send("pause_execute_task")
            elif mode == WorkMode.MODE_RETURNING:
                await self._send("cancel_return_to_dock")
            else:
                await self._send("return_to_dock")
        finally:
            await self.request_report_snapshot()

    async def cancel_job(self) -> None:
        from pymammotion.utility.constant.device_constant import WorkMode

        await self._ensure_fresh_state()
        device = self.data
        if device is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")
        dev = getattr(getattr(device, "report_data", None), "dev", None)
        if dev is None:
            raise ValueError("Robotul nu este pregătit — apasă Sync și așteaptă ~1 minut.")
        mode = int(getattr(dev, "sys_status", 0) or 0)

        if mode not in (
            WorkMode.MODE_PAUSE,
            WorkMode.MODE_WORKING,
            WorkMode.MODE_RETURNING,
        ):
            return

        try:
            if mode != WorkMode.MODE_PAUSE:
                if mode == WorkMode.MODE_WORKING:
                    await self._send("pause_execute_task")
                if mode == WorkMode.MODE_RETURNING:
                    await self._send("cancel_return_to_dock")
                await self.request_report_snapshot()
                device = self.data
                dev = device.report_data.dev if device else dev
                mode = int(getattr(dev, "sys_status", mode) or mode) if dev is not None else mode

            if mode == WorkMode.MODE_PAUSE:
                await self._send("cancel_job")
        finally:
            await self.request_report_snapshot()

    async def generate_route_information(self, operation_settings: OperationSettings) -> GenerateRouteInformation:
        device = self.data
        if device is None:
            raise RuntimeError("Dispozitiv indisponibil.")
        if device.report_data.dev and device.report_data.dev.collector_status.collector_installation_status == 0:
            operation_settings.is_dump = False
        if DeviceType.is_yuka(self.device_name):
            operation_settings.blade_height = -10

        route_information = GenerateRouteInformation(
            one_hashs=list(operation_settings.areas),
            rain_tactics=operation_settings.rain_tactics,
            speed=operation_settings.speed,
            ultra_wave=operation_settings.ultra_wave,
            toward=operation_settings.toward,
            toward_included_angle=operation_settings.toward_included_angle,
            toward_mode=operation_settings.toward_mode,
            blade_height=operation_settings.blade_height,
            channel_mode=operation_settings.channel_mode,
            channel_width=operation_settings.channel_width,
            job_mode=operation_settings.job_mode,
            edge_mode=operation_settings.mowing_laps,
            path_order=create_path_order(operation_settings, self.device_name),
            obstacle_laps=operation_settings.obstacle_laps,
        )
        if DeviceType.is_luba1(self.device_name):
            route_information.toward_mode = 0
            route_information.toward_included_angle = 0
        return route_information

    async def plan_route(self, operation_settings: OperationSettings) -> None:
        route_information = await self.generate_route_information(operation_settings)
        await self._send_and_wait(
            "generate_route_information",
            "bidire_reqconver_path",
            generate_route_information=route_information,
        )

    async def modify_plan_route(self, operation_settings: OperationSettings) -> None:
        device = self.data
        if device and device.work:
            operation_settings.areas = list(dict.fromkeys(device.work.zone_hashs))
            operation_settings.toward = device.work.toward
            operation_settings.toward_mode = device.work.toward_mode
            operation_settings.toward_included_angle = device.work.toward_included_angle
            operation_settings.mowing_laps = device.work.edge_mode
            operation_settings.job_mode = device.work.job_mode
            operation_settings.job_id = device.work.job_id
            operation_settings.job_version = device.work.job_ver
        route_information = await self.generate_route_information(operation_settings)
        await self._send("modify_route_information", generate_route_information=route_information)

    async def modify_plan_if_mowing(self) -> None:
        await self.modify_plan_route(self.operation_settings)

    async def sync_maps(self) -> None:
        await self.map.sync_maps()

    async def sync_schedule(self) -> None:
        await self.map.sync_schedule()

    async def leave_dock(self) -> None:
        await self._send_and_wait("leave_dock", "todev_taskctrl_ack")

    async def cancel_task(self) -> None:
        await self._send_and_wait("cancel_job", "todev_taskctrl_ack")

    async def restart_mower(self) -> None:
        await self._send("remote_restart")

    async def relocate_charging_station(self) -> None:
        await self._send("delete_charge_point")

    async def rtk_dock_location(self) -> None:
        await self._client.fetch_rtk_lora_info(self.device_name)

    async def start_task(self, plan_id: str) -> None:
        await self._send_and_wait("single_schedule", "todev_planjob_set", plan_id=plan_id)

    async def move_forward(self, speed: float = 0.4) -> None:
        await self._send("move_ctrl", linear=speed, angular=0, prefer_ble=not self.movement_use_wifi)

    async def move_back(self, speed: float = 0.4) -> None:
        await self._send("move_ctrl", linear=-speed, angular=0, prefer_ble=not self.movement_use_wifi)

    async def move_left(self, speed: float = 0.4) -> None:
        await self._send("move_ctrl", linear=0, angular=speed, prefer_ble=not self.movement_use_wifi)

    async def move_right(self, speed: float = 0.4) -> None:
        await self._send("move_ctrl", linear=0, angular=-speed, prefer_ble=not self.movement_use_wifi)

    def _rw_expected_field(self, rw_id: int) -> str:
        if rw_id in (3, 6, 7, 8, 10, 11) and DeviceType.is_luba_pro(self.device_name):
            return "nav_sys_param_cmd"
        return "bidire_comm_cmd"

    async def set_rain_detection(self, on: bool) -> None:
        await self._send_and_wait(
            "read_write_device", self._rw_expected_field(3), rw_id=3, context=int(on), rw=1, send_timeout=4.0
        )

    async def set_sidelight(self, on: bool) -> None:
        await self._send_and_wait(
            "read_and_set_sidelight", "todev_time_ctrl_light", is_sidelight=on, operate=0, send_timeout=4.0
        )

    async def set_manual_light(self, on: bool) -> None:
        await self._send_and_wait("set_car_manual_light", "set_lamp_rsp", manual_ctrl=on, send_timeout=3.0)

    async def set_night_light(self, on: bool) -> None:
        await self._send_and_wait("set_car_light", "set_lamp_rsp", on_off=on, send_timeout=3.0)

    async def set_voice_on_off(self, on: bool) -> None:
        await self._send_and_wait("set_car_volume", "set_audio", volume=50 if on else 0)

    async def set_voice_volume(self, volume: float) -> None:
        await self._send_and_wait("set_car_volume", "set_audio", volume=int(volume))

    async def set_voice_gender(self, sex: str) -> None:
        await self._send_and_wait("set_car_volume_sex", "set_audio", sex=MulSex[sex])

    async def set_traversal_mode(self, mode: int) -> None:
        await self._send_and_wait("set_traversal_mode", "nav_sys_param_cmd", context=mode)

    async def set_turning_mode(self, mode: int) -> None:
        await self._send_and_wait("set_turning_mode", "nav_sys_param_cmd", context=mode)

    async def set_wildlife_safety(self, mode: int) -> None:
        await self._send_and_wait("read_write_device", self._rw_expected_field(12), rw_id=12, context=mode, rw=1)

    async def set_cutter_speed(self, mode: int) -> None:
        await self._send_and_wait("set_cutter_speed", "nav_sys_param_cmd", context=mode)

    async def start_stop_blades(self, start_stop: bool, blade_height: int = 60) -> None:
        if DeviceType.is_luba1(self.device_name):
            await self._send_and_wait(
                "set_blade_control",
                "toapp_knife_status_change",
                on_off=1 if start_stop else 0,
            )
            return
        if start_stop:
            if DeviceType.is_yuka(self.device_name) or DeviceType.is_yuka_mini(self.device_name):
                blade_height = 0
            await self._send(
                "operate_on_device",
                main_ctrl=1,
                cut_knife_ctrl=1,
                cut_knife_height=blade_height,
                max_run_speed=1.2,
            )
        else:
            await self._send(
                "operate_on_device",
                main_ctrl=0,
                cut_knife_ctrl=0,
                cut_knife_height=blade_height,
                max_run_speed=1.2,
            )

    async def set_non_work_hours(self, start_time: str, end_time: str) -> None:
        if start_time == end_time:
            await self._send("job_do_not_disturb_del")
            return

        def _to_minutes(hhmm: str) -> str:
            h, m = hhmm.split(":")
            return str(int(h) * 60 + int(m))

        await self._send(
            "job_do_not_disturb",
            unable_end_time=_to_minutes(end_time),
            unable_start_time=_to_minutes(start_time),
        )

    async def reset_blade_time(self) -> None:
        if DeviceType.is_luba1(self.device_name):
            return
        await self._send_and_wait("reset_blade_time", "todev_reset_blade_used_time_status")

    async def set_blade_warning_time(self, hours: int) -> None:
        if DeviceType.is_luba1(self.device_name):
            return
        await self._send("set_blade_warning_time", hours=hours)

    def set_operation_field(self, key: str, value: Any) -> None:
        if not hasattr(self.operation_settings, key):
            raise ValueError(f"Setare necunoscută: {key}")
        setattr(self.operation_settings, key, value)

    def set_area_selected(self, area_hash: int, selected: bool) -> None:
        areas = list(self.operation_settings.areas)
        if selected and area_hash not in areas:
            areas.append(area_hash)
        elif not selected and area_hash in areas:
            areas.remove(area_hash)
        self.operation_settings.areas = areas

    async def apply_config_number(self, key: str, value: float) -> None:
        mapping = {
            "start_progress": "start_progress",
            "cutting_angle": "toward",
            "toward_included_angle": "toward_included_angle",
            "dumping_interval": "collect_grass_frequency",
            "blade_height": "blade_height",
            "working_speed": "speed",
            "path_spacing": "channel_width",
        }
        field = mapping.get(key)
        if field:
            self.set_operation_field(field, int(value) if field != "speed" else float(value))
            if key in {"blade_height", "working_speed"}:
                await self.modify_plan_if_mowing()
            return
        if key == "voice_volume":
            await self.set_voice_volume(value)
            return
        if key == "map_offset_lat":
            self.map_offset_lat = float(value)
            return
        if key == "map_offset_lon":
            self.map_offset_lon = float(value)
            return
        raise ValueError(f"Number necunoscut: {key}")

    async def apply_config_select(self, key: str, option: str) -> None:
        enum_maps: dict[str, tuple[Any, str]] = {
            "channel_mode": (CuttingMode, "channel_mode"),
            "mowing_laps": (BorderPatrolMode, "mowing_laps"),
            "obstacle_laps": (ObstacleLapsMode, "obstacle_laps"),
            "border_mode": (MowOrder, "border_mode"),
            "cutting_angle_mode": (PathAngleSetting, "toward_mode"),
            "bypass_mode": (DetectionStrategy, "ultra_wave"),
        }
        if key in enum_maps:
            enum_cls, field = enum_maps[key]
            self.set_operation_field(field, enum_cls[option].value)
            if key == "bypass_mode":
                await self.modify_plan_if_mowing()
            return
        if key == "voice_gender":
            await self.set_voice_gender(option)
            return
        if key == "traversal_mode":
            from pymammotion.data.model.mowing_modes import TraversalMode

            await self.set_traversal_mode(TraversalMode[option].value)
            return
        if key == "turning_mode":
            from pymammotion.data.model.mowing_modes import TurningMode

            await self.set_turning_mode(TurningMode[option].value)
            return
        if key == "wildlife_safety":
            from pymammotion.data.model.mowing_modes import WildlifeSafety

            await self.set_wildlife_safety(WildlifeSafety[option].value)
            return
        if key == "cutter_mode":
            from pymammotion.data.model.mowing_modes import CuttingSpeedMode

            await self.set_cutter_speed(CuttingSpeedMode[option].value)
            return
        raise ValueError(f"Select necunoscut: {key}")

    async def apply_switch(self, key: str, on: bool) -> None:
        if key == "side_led":
            await self.set_sidelight(on)
        elif key == "rain_detection":
            await self.set_rain_detection(on)
        elif key == "blade_status":
            await self.start_stop_blades(on)
        elif key == "manual_light":
            await self.set_manual_light(on)
        elif key == "night_light":
            await self.set_night_light(on)
        elif key == "voice_on_off":
            await self.set_voice_on_off(on)
        elif key in {"is_mow", "is_dump", "is_edge"}:
            self.set_operation_field(key, on)
        elif key == "rain_tactics":
            self.set_operation_field("rain_tactics", 1 if on else 0)
        elif key == "schedule_updates":
            device = self.data
            if device is not None:
                device.enabled = on
        elif key == "bluetooth_enabled":
            self.bluetooth_enabled = on
        elif key == "cloud_enabled":
            self.cloud_enabled = on
        elif key.startswith("area_"):
            area_hash = int(key.split("_", 1)[1])
            self.set_area_selected(area_hash, on)
        else:
            raise ValueError(f"Switch necunoscut: {key}")

    async def press_button(self, key: str) -> None:
        handlers: dict[str, Any] = {
            "start_map_sync": self.sync_maps,
            "start_schedule_sync": self.sync_schedule,
            "resync_rtk_dock": self.rtk_dock_location,
            "release_from_dock": self.leave_dock,
            "emergency_nudge_forward": lambda: self.move_forward(0.4),
            "emergency_nudge_left": lambda: self.move_left(0.4),
            "emergency_nudge_right": lambda: self.move_right(0.4),
            "emergency_nudge_back": lambda: self.move_back(0.4),
            "cancel_task": self.cancel_task,
            "relocate_charging_station": self.relocate_charging_station,
            "restart_mower": self.restart_mower,
        }
        if key.startswith("task_"):
            await self.start_task(key.removeprefix("task_"))
            return
        handler = handlers.get(key)
        if handler is None:
            raise ValueError(f"Buton necunoscut: {key}")
        result = handler()
        if asyncio.iscoroutine(result):
            await result

    def _lookup_plan(self, plan_id: str) -> Plan:
        device = self.data
        if device is None:
            raise RuntimeError("Dispozitiv indisponibil.")
        plan = device.map.plan.get(plan_id)
        if plan is None:
            raise ValueError(f"Programare inexistentă: {plan_id}")
        return plan

    async def rename_task(self, plan_id: str, new_name: str) -> None:
        plan = self._lookup_plan(plan_id)
        await self._send("rename_plan", plan=plan, new_name=new_name)

    async def set_task_enabled(self, plan_id: str, enabled: bool) -> None:
        plan = self._lookup_plan(plan_id)
        await self._send("enable_plan", plan=plan, enabled=enabled)

    async def delete_task(self, plan_id: str) -> None:
        await self._send("delete_plan_by_id", plan_id=plan_id)

    async def copy_task(self, plan_id: str, new_name: str | None = None) -> None:
        plan = self._lookup_plan(plan_id)
        copy_name = new_name or _make_copy_name(plan.task_name)
        await self._send("copy_plan", plan=plan, new_name=copy_name)
