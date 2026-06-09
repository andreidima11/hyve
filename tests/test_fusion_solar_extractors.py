from tests.component_helpers import component_module

_extract = component_module("fusion_solar", "extract")
device_kpi_schema = _extract.device_kpi_schema
extract_fusion_solar_candidates = _extract.extract_fusion_solar_candidates
DEV_STRING_INVERTER = _extract.DEV_STRING_INVERTER
DEV_GRID_METER = _extract.DEV_GRID_METER


def _sample_payload():
    return {
        "summary": {
            "station_count": 1,
            "realtime_power_kw": 2.5,
            "daily_energy_kwh": 10,
            "month_energy_kwh": 200,
            "yearly_energy_kwh": 1500,
            "lifetime_energy_kwh": 5000,
            "status": "online",
        },
        "realtime": [{
            "station_code": "NE150738984",
            "station_name": "Test Plant",
            "station_address": "Str. Test 1",
            "capacity_kw": 10,
            "contact_person": "Andrei",
            "contact_phone": "0700",
            "realtime_power_kw": 2.5,
            "load_power_kw": 1.2,
            "grid_power_kw": 0.5,
            "grid_import_power_kw": 0.0,
            "grid_export_power_kw": 0.5,
            "daily_energy_kwh": 10,
            "month_energy_kwh": 200,
            "yearly_energy_kwh": 1500,
            "lifetime_energy_kwh": 5000,
            "feed_in_energy_kwh": 50,
            "consumption_kwh": 180,
            "revenue": 100,
        }],
        "yearly_current": {
            "NE150738984": {"inverter_power": 1500, "ongrid_power": 400, "use_power": 1200},
        },
        "devices": [{
            "device_id": "1000000150739012",
            "device_name": "Inverter-1",
            "device_type_id": DEV_STRING_INVERTER,
            "device_type": "String Inverter",
            "esn_code": "ESN123",
            "station_code": "NE150738984",
            "realtime_kpi": {
                "active_power": 2.5,
                "day_cap": 10,
                "total_cap": 5000,
                "efficiency": 98.5,
                "temperature": 45,
                "pv1_u": 380,
                "pv1_i": 5.2,
                "month_cap": 200,
                "year_cap": 1500,
                "run_state": 1,
            },
        }, {
            "device_id": "1000000150738999",
            "device_name": "Meter-1",
            "device_type_id": DEV_GRID_METER,
            "device_type": "Grid Meter",
            "realtime_kpi": {
                "active_power": 500,
                "active_cap": 1000,
                "reverse_active_cap": 200,
                "grid_frequency": 50,
            },
        }],
    }


def test_device_schema_matches_ha_inverter_breadth():
    schema = device_kpi_schema(DEV_STRING_INVERTER)
    keys = {field.key for field in schema}
    assert "pv1_u" in keys
    assert "pv24_u" in keys
    assert "mppt_10_cap" in keys
    assert "run_state" in keys


def test_extract_fusion_solar_ha_like_entities():
    items = extract_fusion_solar_candidates(_sample_payload())
    ids = {item["entity_id"] for item in items}

    assert "sensor.fusion_solar_station_1_load" in ids
    assert "sensor.fusion_solar_station_1_grid_export" in ids
    assert "sensor.fusion_solar_device_1000000150739012_pv1_u" in ids
    assert "sensor.fusion_solar_device_1000000150739012_month_cap" in ids
    assert "binary_sensor.fusion_solar_device_1000000150739012_run_state" in ids
    assert "sensor.fusion_solar_device_1000000150739012_device_id" in ids
    assert "sensor.fusion_solar_device_1000000150738999_active_cap" in ids
    assert not any(i["entity_id"].endswith("_pv2_u") for i in items)

    run_state = next(i for i in items if i["entity_id"].endswith("_run_state"))
    assert run_state["domain"] == "binary_sensor"
    assert run_state["state"] == "on"

    assert len(items) < 120
    assert len(items) > 25


def test_skips_station_metrics_without_api_data():
    payload = _sample_payload()
    payload["realtime"][0]["load_power_kw"] = None
    payload["realtime"][0]["feed_in_energy_kwh"] = None
    items = extract_fusion_solar_candidates(payload)
    ids = {item["entity_id"] for item in items}
    assert "sensor.fusion_solar_station_1_load" not in ids
    assert "sensor.fusion_solar_station_1_feed_in" not in ids
    assert "sensor.fusion_solar_station_1_power" in ids


def test_grid_meter_active_power_scaled_to_kw():
    items = extract_fusion_solar_candidates(_sample_payload())
    power = next(
        i for i in items
        if i["entity_id"] == "sensor.fusion_solar_device_1000000150738999_active_power"
    )
    assert power["unit"] == "kW"
    assert power["state"] in {"0.5", "500"}
