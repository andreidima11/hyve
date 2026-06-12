"""Mammotion snapshot compatibility with pymammotion 0.7.x HashList maps."""

from __future__ import annotations

from pymammotion.data.model.device import MowerDevice
from pymammotion.data.model.hash_list import AreaHashNameList, HashList, Plan
from pymammotion.data.model.report_info import ReportData

from components.mammotion.extract import extract_mammotion_entities
from components.mammotion.snapshot import build_device_snapshot


def test_build_mower_snapshot_with_hashlist_map():
    device = MowerDevice(
        name="Luba-MNZFSWQU",
        online=True,
        map=HashList(
            area_name=[AreaHashNameList(name="Front lawn", hash=12345)],
            plan={"p1": Plan(plan_id="p1", task_name="Morning mow", total_plan_num=1)},
        ),
        report_data=ReportData(),
    )
    snap = build_device_snapshot(device, device_name="Luba-MNZFSWQU")
    assert snap["device_name"] == "Luba-MNZFSWQU"
    assert snap["areas"][0]["name"] == "Front lawn"
    assert "p1" in snap["plans"]

    items = extract_mammotion_entities({"devices": [snap]})
    mowers = [e for e in items if e["domain"] == "lawn_mower"]
    assert len(mowers) == 1
    assert mowers[0]["state"] in {"docked", "unknown", "unavailable", "idle"}
