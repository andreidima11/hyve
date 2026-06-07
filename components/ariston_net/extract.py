from __future__ import annotations

from typing import Any

from integrations.entity_utils import finalize_entities as _finalize, slugify

def extract_ariston_net_candidates(payload: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return items

    devices = payload.get("devices") if isinstance(payload.get("devices"), list) else []
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    payload_partial = bool(summary.get("partial"))

    def _state(value: Any) -> str:
        if isinstance(value, bool):
            return "on" if value else "off"
        if isinstance(value, float):
            return f"{value:.2f}".rstrip("0").rstrip(".")
        return str(value) if value is not None else "unknown"

    def _num(value: Any) -> float | None:
        try:
            if value in (None, "", "unknown"):
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    def _bool(value: Any) -> bool | None:
        if isinstance(value, bool):
            return value
        text = str(value or "").strip().lower()
        if text in {"true", "1", "yes", "on"}:
            return True
        if text in {"false", "0", "no", "off"}:
            return False
        return None

    def _feature_enabled(device: dict[str, Any], *keys: str) -> bool | None:
        sources = [
            device.get("features") if isinstance(device.get("features"), dict) else {},
            device.get("custom_features") if isinstance(device.get("custom_features"), dict) else {},
            device,
        ]
        candidates = {str(key) for key in keys if key}
        candidates.update(key.upper() for key in list(candidates))
        for source in sources:
            for key in candidates:
                if source.get(key) is True:
                    return True
                if source.get(key) is False:
                    return False
        return None

    def _zeroish(value: Any) -> bool:
        numeric = _num(value)
        return numeric is not None and abs(numeric) < 0.000001

    def _should_skip_energy(device: dict[str, Any], feature_key: str | None, value: Any) -> bool:
        if feature_key is None:
            return False
        enabled = _feature_enabled(device, feature_key)
        # If Ariston reports the capability as absent and value is just the
        # package default 0, hide it. Non-zero values are kept even when feature
        # metadata is incomplete.
        return enabled is False and _zeroish(value)

    def _device_attrs(device: dict[str, Any]) -> dict[str, Any]:
        gateway = str(device.get("gateway") or device.get("serial_number") or "ariston").strip()
        name = str(device.get("name") or gateway).strip()
        model_bits = [str(device.get("system_type") or "").strip(), str(device.get("whe_type") or "").strip()]
        model = " ".join(bit for bit in model_bits if bit and bit.lower() != "none").strip()
        return {
            "device_id": f"ariston_net_{slugify(gateway)}",
            "device_name": name,
            "device_model": model,
            "device_manufacturer": "Ariston",
            "gateway": gateway,
            "serial_number": device.get("serial_number") or "",
            "system_type": device.get("system_type") or "",
            "whe_type": device.get("whe_type") or "",
        }

    def _append(
        device: dict[str, Any],
        suffix: str,
        label: str,
        value: Any,
        unit: str = "",
        domain: str = "sensor",
        *,
        aliases: list[str] | None = None,
        controllable: bool = False,
        capabilities: dict[str, Any] | None = None,
        extra: dict[str, Any] | None = None,
        allow_unavailable: bool = False,
    ):
        if value is None or value == "":
            if not allow_unavailable:
                return
            value = "unavailable"
        attrs = _device_attrs(device)
        gateway = str(attrs["gateway"])
        entity_id = f"ariston_net:{slugify(gateway)}:{suffix}"
        name = f"{attrs['device_name']} • {label}"
        attributes = {**attrs, "raw_state": {suffix: value}}
        if capabilities:
            attributes["capabilities"] = capabilities
        if extra:
            attributes.update(extra)
        items.append({
            "entity_id": entity_id,
            "name": name,
            "state": _state(value),
            "domain": domain,
            "source": "ariston_net",
            "aliases": [name, label, *(aliases or [])],
            "unit": unit,
            "controllable": controllable,
            "attributes": attributes,
        })

    def _append_numeric(device: dict[str, Any], suffix: str, label: str, value: Any, unit: str = "", **kwargs: Any):
        numeric = _num(value)
        if numeric is None:
            if kwargs.pop("allow_unavailable", False):
                _append(device, suffix, label, "unavailable", unit, **kwargs)
            return
        _append(device, suffix, label, numeric, unit, **kwargs)

    for device in devices:
        if not isinstance(device, dict):
            continue
        partial = payload_partial or bool(device.get("partial"))
        unavailable_extra = {"unavailable_reason": device.get("unavailable_reason") or summary.get("last_error") or "AristonNET nu a returnat încă valoarea."}
        _append(device, "status", "Status", True, domain="binary_sensor", aliases=["ariston status", "centrală", "boiler"])

        partial_common_placeholders = {
            "heating_circuit_pressure",
            "ch_flow_temp",
            "ch_return_temp",
            "outside_temp",
            "signal_strength",
            "central_heating_total_energy",
            "dhw_total_energy",
            "central_heating_gas",
            "central_heating_electricity",
            "dhw_gas",
            "dhw_electricity",
            "remaining_time",
        }

        common_metrics = [
            ("heating_circuit_pressure", "Presiune circuit încălzire", "heating_circuit_pressure_value", "heating_circuit_pressure_unit", "bar", None),
            ("ch_flow_setpoint_temp", "Temperatură setpoint tur", "ch_flow_setpoint_temp_value", "ch_flow_setpoint_temp_unit", "°C", None),
            ("ch_flow_temp", "Temperatură tur", "ch_flow_temp_value", "ch_flow_temp_unit", "°C", None),
            ("ch_return_temp", "Temperatură retur", "ch_return_temp_value", "ch_return_temp_unit", "°C", None),
            ("outside_temp", "Temperatură exterioară", "outside_temp_value", "outside_temp_unit", "°C", None),
            ("signal_strength", "Semnal", "signal_strength_value", "signal_strength_unit", "", None),
            ("proc_req_temp", "Temperatură cerută proces", "proc_req_temp_value", None, "°C", None),
            ("average_showers", "Dușuri medii", "av_shw_value", None, "", None),
            ("electric_water_last_two_hours", "Electricitate apă caldă ultimele 2h", "electric_consumption_for_water_last_two_hours", None, "kWh", None),
            ("gas_heating_last_month", "Gaz încălzire luna trecută", "gas_consumption_for_heating_last_month", None, "kWh", None),
            ("electricity_heating_last_month", "Electricitate încălzire luna trecută", "electricity_consumption_for_heating_last_month", None, "kWh", None),
            ("electricity_cooling_last_month", "Electricitate răcire luna trecută", "electricity_consumption_for_cooling_last_month", None, "kWh", None),
            ("gas_water_last_month", "Gaz apă caldă luna trecută", "gas_consumption_for_water_last_month", None, "kWh", None),
            ("electricity_water_last_month", "Electricitate apă caldă luna trecută", "electricity_consumption_for_water_last_month", None, "kWh", None),
            ("central_heating_total_energy", "Energie totală încălzire", "central_heating_total_energy_consumption", None, "kWh", "CENTRAL_HEATING_TOTAL_ENERGY"),
            ("dhw_total_energy", "Energie totală apă caldă", "domestic_hot_water_total_energy_consumption", None, "kWh", "DOMESTIC_HOT_WATER_TOTAL_ENERGY"),
            ("central_heating_gas", "Gaz încălzire", "central_heating_gas_consumption", None, "kWh", "CENTRAL_HEATING_GAS"),
            ("central_heating_electricity", "Electricitate încălzire", "central_heating_electricity_consumption", None, "kWh", "CENTRAL_HEATING_ELECTRICITY"),
            ("dhw_gas", "Gaz apă caldă", "domestic_hot_water_gas_consumption", None, "kWh", "DOMESTIC_HOT_WATER_GAS"),
            ("dhw_electricity", "Electricitate apă caldă", "domestic_hot_water_electricity_consumption", None, "kWh", "DOMESTIC_HOT_WATER_ELECTRICITY"),
            ("dhw_heating_pump_electricity", "Electricitate pompă apă caldă", "domestic_hot_water_heating_pump_electricity_consumption", None, "kWh", "DOMESTIC_HOT_WATER_HEATING_PUMP_ELECTRICITY"),
            ("dhw_resistor_electricity", "Electricitate rezistență apă caldă", "domestic_hot_water_resistor_electricity_consumption", None, "kWh", "DOMESTIC_HOT_WATER_RESISTOR_ELECTRICITY"),
            ("remaining_time", "Timp rămas", "rm_tm_in_minutes", None, "min", None),
            ("water_heater_heating_rate", "Rată încălzire apă", "water_heater_heating_rate", None, "", None),
        ]
        for suffix, label, key, unit_key, fallback_unit, feature_key in common_metrics:
            value = device.get(key)
            if _should_skip_energy(device, feature_key, value):
                continue
            unit = str(device.get(unit_key) or fallback_unit or "") if unit_key else fallback_unit
            allow_partial_placeholder = partial and suffix in partial_common_placeholders
            _append_numeric(device, suffix, label, value, unit, allow_unavailable=allow_partial_placeholder, extra=unavailable_extra if allow_partial_placeholder and _num(value) is None else None)

        bus_errors = device.get("bus_errors") if isinstance(device.get("bus_errors"), list) else None
        if bus_errors is not None:
            _append_numeric(device, "errors_count", "Erori bus", len(bus_errors), "", aliases=["errors", "erori"], extra={"bus_errors": bus_errors})

        binary_metrics = [
            ("flame", "Flacără", "is_flame_on_value", ["flame", "arzător"]),
            ("heating_pump", "Pompă încălzire", "is_heating_pump_on_value", ["pompă", "heat pump"]),
            ("holiday", "Mod vacanță", "holiday_mode_value", ["holiday", "vacanță"]),
            ("is_heating", "Încălzire activă", "is_heating", ["heating", "încălzire"]),
            ("anti_legionella_cycle", "Ciclu anti-legionella", "is_antileg", ["anti legionella"]),
        ]
        for suffix, label, key, aliases in binary_metrics:
            flag = _bool(device.get(key))
            if flag is not None:
                _append(device, suffix, label, flag, domain="binary_sensor", aliases=aliases)
            elif partial and suffix in {"flame", "heating_pump", "holiday"}:
                _append(device, suffix, label, "unavailable", domain="binary_sensor", aliases=aliases, extra=unavailable_extra)

        select_metrics = [
            ("plant_mode", "Mod centrală", "plant_mode", "plant_mode_opt_texts", ["plant mode", "centrală"]),
            ("currency", "Monedă", "currency", "currency_options", ["currency", "monedă"]),
            ("gas_type", "Tip gaz", "gas_type", "gas_type_options", ["gas type", "tip gaz"]),
            ("gas_energy_unit", "Unitate energie gaz", "gas_energy_unit", "gas_energy_unit_options", ["gas energy unit"]),
            ("hybrid_mode", "Mod hibrid", "hybrid_mode", "hybrid_mode_opt_texts", ["hybrid"]),
            ("buffer_control_mode", "Mod control buffer", "buffer_control_mode", "buffer_control_mode_opt_texts", ["buffer"]),
        ]
        for suffix, label, key, options_key, aliases in select_metrics:
            value = device.get(key)
            options = device.get(options_key) if isinstance(device.get(options_key), list) else []
            if value is not None and value != "":
                _append(device, suffix, label, value, domain="select" if options else "sensor", aliases=aliases, controllable=bool(options), capabilities={"options": options} if options else None)
            elif partial and suffix in {"plant_mode"}:
                _append(device, suffix, label, "unavailable", domain="sensor", aliases=aliases, extra=unavailable_extra)

        switch_metrics = [
            ("automatic_thermoregulation", "Termoreglare automată", "automatic_thermoregulation", ["auto thermoregulation"]),
            ("quiet_mode", "Mod silențios", "is_quiet_value", ["quiet"]),
            ("water_heater_power_option", "Apă caldă opțiune power", "water_heater_power_option_value", ["power option", "dhw"]),
            ("anti_legionella", "Anti-legionella", "water_anti_leg_value", ["anti legionella"]),
            ("water_heater_preheating", "Apă caldă preîncălzire", "water_heater_preheating_on_off", ["preheating", "dhw"]),
            ("permanent_boost", "Boost permanent", "permanent_boost_value", ["permanent boost"]),
            ("anti_cooling", "Anti-răcire", "anti_cooling_value", ["anti cooling"]),
            ("night_mode", "Mod noapte", "night_mode_value", ["night mode"]),
        ]
        for suffix, label, key, aliases in switch_metrics:
            flag = _bool(device.get(key))
            if flag is not None:
                _append(device, suffix, label, flag, domain="switch", aliases=aliases, controllable=True)

        number_metrics = [
            ("electricity_cost", "Cost electricitate", "elect_cost", "", 0, None, 0.01, ["electricity cost"]),
            ("gas_cost", "Cost gaz", "gas_cost", "", 0, None, 0.01, ["gas cost"]),
            ("water_heater_reduced_temperature", "Apă caldă temperatură redusă", "water_heater_reduced_temperature", "°C", "water_heater_reduced_minimum_temperature", "water_heater_reduced_maximum_temperature", "water_heater_reduced_temperature_step", ["reduced temp", "dhw"]),
            ("water_heater_minimum_setpoint_temperature", "Apă caldă setpoint minim", "water_heater_minimum_setpoint_temperature", "°C", "water_heater_minimum_setpoint_temperature_minimum", "water_heater_minimum_setpoint_temperature_maximum", 1, ["min setpoint", "dhw"]),
            ("water_heater_maximum_setpoint_temperature", "Apă caldă setpoint maxim", "water_heater_maximum_setpoint_temperature", "°C", "water_heater_maximum_setpoint_temperature_minimum", "water_heater_maximum_setpoint_temperature_maximum", 1, ["max setpoint", "dhw"]),
            ("requested_showers", "Număr dușuri cerute", "req_shower", "", 0, "max_req_shower", 1, ["showers"]),
            ("anti_cooling_temperature", "Temperatură anti-răcire", "anti_cooling_temperature_value", "°C", "anti_cooling_temperature_minimum", "anti_cooling_temperature_maximum", 1, ["anti cooling temp"]),
            ("night_mode_begin", "Mod noapte început", "night_mode_begin_as_minutes_value", "min", "night_mode_begin_min_as_minutes_value", "night_mode_begin_max_as_minutes_value", 1, ["night begin"]),
            ("night_mode_end", "Mod noapte sfârșit", "night_mode_end_as_minutes_value", "min", "night_mode_end_min_as_minutes_value", "night_mode_end_max_as_minutes_value", 1, ["night end"]),
        ]
        for suffix, label, key, unit, min_key, max_key, step_key, aliases in number_metrics:
            numeric = _num(device.get(key))
            if numeric is None:
                continue
            caps = {"unit": unit, "step": _num(step_key) if isinstance(step_key, (int, float)) else (_num(device.get(step_key)) or 1)}
            min_value = _num(min_key) if isinstance(min_key, (int, float)) else _num(device.get(min_key))
            max_value = _num(device.get(max_key)) if isinstance(max_key, str) else _num(max_key)
            if min_value is not None:
                caps["min"] = min_value
            if max_value is not None:
                caps["max"] = max_value
            _append(device, suffix, label, numeric if numeric is not None else "unavailable", unit, domain="number", aliases=aliases, controllable=numeric is not None, capabilities=caps, extra=unavailable_extra if numeric is None else None)

        zones = device.get("zones") if isinstance(device.get("zones"), list) else []
        for zone in zones:
            if not isinstance(zone, dict):
                continue
            zone_no = zone.get("zone")
            zone_label = f"Zona {zone_no}"
            unit = str(zone.get("temperature_unit") or "°C")
            _append_numeric(device, f"zone_{zone_no}_temperature", f"{zone_label} temperatură", zone.get("current_temperature"), unit, aliases=["temperatură", f"zona {zone_no}"], allow_unavailable=partial, extra=unavailable_extra if partial and _num(zone.get("current_temperature")) is None else None)
            target = _num(zone.get("target_temperature"))
            if target is not None or partial:
                caps = {
                    "min": _num(zone.get("min_temperature")) or 5,
                    "max": _num(zone.get("max_temperature")) or 35,
                    "step": _num(zone.get("target_temperature_step")) or 0.5,
                    "unit": unit,
                }
                _append(device, f"zone_{zone_no}_target_temperature", f"{zone_label} setpoint", target if target is not None else "unavailable", unit, domain="number", aliases=["setpoint", "termostat", f"zona {zone_no}"], controllable=target is not None, capabilities=caps, extra={"zone": zone_no, **(unavailable_extra if target is None else {})})
            _append_numeric(device, f"zone_{zone_no}_economy_temperature", f"{zone_label} temperatură economică", zone.get("economy_temperature"), unit, allow_unavailable=partial, extra=unavailable_extra if partial and _num(zone.get("economy_temperature")) is None else None)
            heat_request = _bool(zone.get("heat_request"))
            if heat_request is not None:
                _append(device, f"zone_{zone_no}_heat_request", f"{zone_label} cerere căldură", heat_request, domain="binary_sensor", aliases=["heat request", f"zona {zone_no}"])
            elif partial:
                _append(device, f"zone_{zone_no}_heat_request", f"{zone_label} cerere căldură", "unavailable", domain="binary_sensor", aliases=["heat request", f"zona {zone_no}"], extra=unavailable_extra)
            zone_mode = zone.get("zone_mode") or zone.get("mode")
            zone_options = zone.get("zone_mode_options") if isinstance(zone.get("zone_mode_options"), list) else []
            if zone_mode:
                _append(device, f"zone_{zone_no}_mode", f"{zone_label} mod", zone_mode, domain="select" if zone_options else "sensor", aliases=["zone mode", f"zona {zone_no}"], controllable=bool(zone_options), capabilities={"options": zone_options} if zone_options else None, extra={"zone": zone_no})
            flow_temp = _num(zone.get("heating_flow_temperature"))
            if flow_temp is not None:
                caps = {
                    "min": _num(zone.get("heating_flow_temperature_min")) or 20,
                    "max": _num(zone.get("heating_flow_temperature_max")) or 80,
                    "step": _num(zone.get("heating_flow_temperature_step")) or 1,
                    "unit": str(zone.get("heating_flow_temperature_unit") or unit),
                }
                _append(device, f"zone_{zone_no}_heating_flow_temperature", f"{zone_label} temperatură tur", flow_temp, caps["unit"], domain="number", aliases=["heating flow", f"zona {zone_no}"], controllable=True, capabilities=caps, extra={"zone": zone_no})
            flow_offset = _num(zone.get("heating_flow_offset"))
            if flow_offset is not None:
                caps = {
                    "min": _num(zone.get("heating_flow_offset_min")) or -20,
                    "max": _num(zone.get("heating_flow_offset_max")) or 20,
                    "step": _num(zone.get("heating_flow_offset_step")) or 1,
                    "unit": str(zone.get("heating_flow_offset_unit") or unit),
                }
                _append(device, f"zone_{zone_no}_heating_flow_offset", f"{zone_label} offset tur", flow_offset, caps["unit"], domain="number", aliases=["heating flow offset", f"zona {zone_no}"], controllable=True, capabilities=caps, extra={"zone": zone_no})

        wh_unit = str(device.get("water_heater_temperature_unit") or "°C")
        _append_numeric(device, "water_heater_temperature", "Apă caldă temperatură", device.get("water_heater_current_temperature"), wh_unit, aliases=["apă caldă", "boiler", "dhw"], allow_unavailable=partial, extra=unavailable_extra if partial and _num(device.get("water_heater_current_temperature")) is None else None)
        target = _num(device.get("water_heater_target_temperature"))
        if target is not None or partial:
            caps = {
                "min": _num(device.get("water_heater_minimum_temperature")) or 35,
                "max": _num(device.get("water_heater_maximum_temperature")) or 80,
                "step": _num(device.get("water_heater_temperature_step")) or 1,
                "unit": wh_unit,
            }
            _append(device, "water_heater_target_temperature", "Apă caldă setpoint", target if target is not None else "unavailable", wh_unit, domain="number", aliases=["setpoint apă caldă", "boiler target", "dhw target"], controllable=target is not None, capabilities=caps, extra=unavailable_extra if target is None else None)
        mode = device.get("water_heater_current_mode_text")
        options = device.get("water_heater_mode_operation_texts") if isinstance(device.get("water_heater_mode_operation_texts"), list) else []
        if not options and isinstance(device.get("water_heater_mode_options"), list):
            options = device.get("water_heater_mode_options")
        if mode:
            _append(device, "water_heater_mode", "Apă caldă mod", mode, domain="select" if options else "sensor", aliases=["mod apă caldă", "dhw mode"], controllable=bool(options), capabilities={"options": options} if options else None)
        elif partial:
            _append(device, "water_heater_mode", "Apă caldă mod", "unavailable", domain="sensor", aliases=["mod apă caldă", "dhw mode"], extra=unavailable_extra)
        for suffix, label, key in [
            ("water_heater_power", "Apă caldă power", "water_heater_power_value"),
            ("water_heater_eco", "Apă caldă eco", "water_heater_eco_value"),
            ("water_heater_boost", "Apă caldă boost", "water_heater_boost"),
        ]:
            flag = _bool(device.get(key))
            if flag is not None:
                _append(device, suffix, label, flag, domain="switch", aliases=[label, "boiler", "dhw"], controllable=True)
            elif partial:
                _append(device, suffix, label, "unavailable", domain="switch", aliases=[label, "boiler", "dhw"], extra=unavailable_extra)

    items.sort(key=lambda item: (item.get("attributes", {}).get("device_name") or "", item.get("domain") or "", item.get("name") or ""))
    return _finalize(items, default_source="ariston_net")


