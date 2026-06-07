from integrations.fusion_solar_power_flow import compute_power_flow
from integrations.fusion_solar_entities import extract_fusion_solar_candidates, DEV_GRID_METER, DEV_STRING_INVERTER


def test_compute_power_flow_ha_template_logic():
    """Matches HA templates: meter + inverter -> consum / import / export / panouri."""
    inverters = [{
        "device_type_id": DEV_STRING_INVERTER,
        "realtime_kpi": {"active_power": 3.2},  # 3.2 kW
    }]
    meter = {
        "device_type_id": DEV_GRID_METER,
        "realtime_kpi": {"active_power": 500},  # 0.5 kW export (was W in API)
    }
    flow = compute_power_flow(inverters=inverters, meter=meter)
    assert flow["flow_grid_export"] == 0.5
    assert flow["flow_grid_import"] == 0
    # consum = import + inv - export = 0 + 3200 - 500 W -> 2.7 kW
    assert abs(flow["flow_consumption"] - 2.7) < 0.01
    assert abs(flow["flow_from_solar"] - 2.7) < 0.01


def test_extract_emits_flow_entities():
    payload = {
        "summary": {"station_count": 1, "status": "online"},
        "realtime": [{
            "station_code": "NE1",
            "station_name": "Plant",
            "realtime_power_kw": 3.2,
        }],
        "devices": [
            {
                "device_id": "inv1",
                "device_name": "Inverter",
                "device_type_id": DEV_STRING_INVERTER,
                "device_type": "String Inverter",
                "station_code": "NE1",
                "realtime_kpi": {"active_power": 3.2},
            },
            {
                "device_id": "meter1",
                "device_name": "Meter",
                "device_type_id": DEV_GRID_METER,
                "device_type": "Grid Meter",
                "station_code": "NE1",
                "realtime_kpi": {"active_power": -1.5},  # import 1.5 kW
            },
        ],
    }
    items = extract_fusion_solar_candidates(payload)
    ids = {i["entity_id"] for i in items}
    assert "sensor.fusion_solar_station_1_flow_consumption" in ids
    assert "sensor.fusion_solar_station_1_flow_grid_import" in ids
    cons = next(i for i in items if i["entity_id"].endswith("_flow_consumption"))
    assert cons["unit"] == "kW"
    assert float(cons["state"]) > 0
