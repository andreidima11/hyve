from integrations.extractors import extract_ariston_net_candidates, infer_source


def test_infer_source_detects_ariston_net():
    assert infer_source("ariston_net:boiler:status", "AristonNET") == "ariston_net"


def test_extract_ariston_net_candidates_exposes_controls_and_sensors():
    payload = {
        "devices": [
            {
                "gateway": "GW123",
                "name": "Centrala",
                "serial_number": "SN123",
                "system_type": "GALEVO",
                "heating_circuit_pressure_value": 1.4,
                "heating_circuit_pressure_unit": "bar",
                "is_flame_on_value": True,
                "zones": [
                    {
                        "zone": 1,
                        "current_temperature": 22.1,
                        "target_temperature": 23,
                        "min_temperature": 10,
                        "max_temperature": 30,
                        "target_temperature_step": 0.5,
                        "temperature_unit": "°C",
                    }
                ],
                "water_heater_current_temperature": 47,
                "water_heater_target_temperature": 50,
                "water_heater_minimum_temperature": 35,
                "water_heater_maximum_temperature": 80,
                "water_heater_temperature_step": 1,
                "water_heater_temperature_unit": "°C",
                "water_heater_current_mode_text": "Program",
                "water_heater_mode_operation_texts": ["Program", "Manual"],
                "water_heater_power_value": True,
            }
        ]
    }

    entities = extract_ariston_net_candidates(payload)
    by_id = {entity["unique_id"]: entity for entity in entities}

    assert by_id["ariston_net:gw123:heating_circuit_pressure"]["unit"] == "bar"
    assert by_id["ariston_net:gw123:flame"]["domain"] == "binary_sensor"
    assert by_id["ariston_net:gw123:zone_1_target_temperature"]["domain"] == "number"
    assert by_id["ariston_net:gw123:zone_1_target_temperature"]["controllable"] is True
    assert by_id["ariston_net:gw123:water_heater_mode"]["domain"] == "select"
    assert by_id["ariston_net:gw123:water_heater_power"]["domain"] == "switch"
    assert by_id["ariston_net:gw123:water_heater_power"]["attributes"]["device_name"] == "Centrala"


def test_extract_ariston_net_candidates_extends_ha_like_controls_and_filters_zero_defaults():
    payload = {
        "devices": [
            {
                "gateway": "GW123",
                "name": "Centrala",
                "custom_features": {
                    "DOMESTIC_HOT_WATER_ELECTRICITY": False,
                    "CENTRAL_HEATING_GAS": True,
                },
                "domestic_hot_water_electricity_consumption": 0,
                "central_heating_gas_consumption": 12,
                "plant_mode": "HEATING",
                "plant_mode_opt_texts": ["HEATING", "OFF"],
                "automatic_thermoregulation": True,
                "elect_cost": 1.2,
                "zones": [
                    {
                        "zone": 1,
                        "zone_mode": "MANUAL",
                        "zone_mode_options": ["MANUAL", "TIME_PROGRAM"],
                        "heating_flow_temperature": 45,
                        "heating_flow_temperature_min": 30,
                        "heating_flow_temperature_max": 70,
                        "heating_flow_temperature_step": 1,
                    }
                ],
            }
        ]
    }

    entities = extract_ariston_net_candidates(payload)
    by_id = {entity["unique_id"]: entity for entity in entities}

    assert "ariston_net:gw123:dhw_electricity" not in by_id
    assert by_id["ariston_net:gw123:central_heating_gas"]["state"] == "12"
    assert by_id["ariston_net:gw123:plant_mode"]["domain"] == "select"
    assert by_id["ariston_net:gw123:plant_mode"]["controllable"] is True
    assert by_id["ariston_net:gw123:automatic_thermoregulation"]["domain"] == "switch"
    assert by_id["ariston_net:gw123:electricity_cost"]["domain"] == "number"
    assert by_id["ariston_net:gw123:zone_1_mode"]["domain"] == "select"
    assert by_id["ariston_net:gw123:zone_1_heating_flow_temperature"]["domain"] == "number"


def test_extract_ariston_net_candidates_keeps_partial_entities_visible():
    payload = {
        "devices": [
            {
                "gateway": "GW123",
                "name": "Centrala",
                "partial": True,
                "unavailable_reason": "rate limit",
                "zones": [{"zone": 1}],
            }
        ],
        "summary": {"partial": True, "last_error": "rate limit"},
    }

    entities = extract_ariston_net_candidates(payload)
    by_id = {entity["unique_id"]: entity for entity in entities}

    expected = {
        "ariston_net:gw123:heating_circuit_pressure": "sensor",
        "ariston_net:gw123:ch_flow_temp": "sensor",
        "ariston_net:gw123:ch_return_temp": "sensor",
        "ariston_net:gw123:outside_temp": "sensor",
        "ariston_net:gw123:signal_strength": "sensor",
        "ariston_net:gw123:remaining_time": "sensor",
        "ariston_net:gw123:flame": "binary_sensor",
        "ariston_net:gw123:heating_pump": "binary_sensor",
        "ariston_net:gw123:holiday": "binary_sensor",
        "ariston_net:gw123:zone_1_temperature": "sensor",
        "ariston_net:gw123:zone_1_target_temperature": "number",
        "ariston_net:gw123:zone_1_economy_temperature": "sensor",
        "ariston_net:gw123:zone_1_heat_request": "binary_sensor",
        "ariston_net:gw123:water_heater_temperature": "sensor",
        "ariston_net:gw123:water_heater_target_temperature": "number",
        "ariston_net:gw123:water_heater_mode": "sensor",
        "ariston_net:gw123:water_heater_power": "switch",
        "ariston_net:gw123:water_heater_eco": "switch",
        "ariston_net:gw123:water_heater_boost": "switch",
    }
    for entity_id, domain in expected.items():
        assert by_id[entity_id]["domain"] == domain
        assert by_id[entity_id]["state"] == "unavailable"

    noisy_partial_placeholders = [
        "ariston_net:gw123:ch_flow_setpoint_temp",
        "ariston_net:gw123:proc_req_temp",
        "ariston_net:gw123:average_showers",
        "ariston_net:gw123:electric_water_last_two_hours",
        "ariston_net:gw123:anti_legionella_cycle",
        "ariston_net:gw123:automatic_thermoregulation",
        "ariston_net:gw123:night_mode",
        "ariston_net:gw123:electricity_cost",
        "ariston_net:gw123:water_heater_reduced_temperature",
    ]
    for entity_id in noisy_partial_placeholders:
        assert entity_id not in by_id
