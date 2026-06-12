"""Mammotion schedule / plan button labels."""

from __future__ import annotations

from components.mammotion.snapshot.plans import plan_display_label
from components.mammotion.specs.mower import build_mower_entities
from components.mammotion.specs.row import MowerRow


def test_plan_display_label_prefers_task_name():
    assert plan_display_label({"task_name": "Dimineață curte"}, "3") == "Dimineață curte"


def test_plan_display_label_uses_zone_names_when_generic_task():
    label = plan_display_label(
        {"task_name": "Task 3", "zone_names": ["Față", "Spate"]},
        "3",
    )
    assert label == "Față, Spate"


def test_schedule_task_buttons_emitted_from_plans():
    row = MowerRow.from_snapshot(
        {
            "device_name": "Luba-TEST01",
            "name": "Grădinarul",
            "online": True,
            "status": {"sys_status": 11, "charge_state": 1, "battery": 80},
            "plans": {
                "1": {
                    "plan_id": "1",
                    "task_name": "Task 1",
                    "zone_names": ["Peluză"],
                    "enabled": True,
                },
                "2": {
                    "plan_id": "2",
                    "task_name": "Seara",
                    "enabled": False,
                },
            },
        }
    )
    entities = build_mower_entities(row)
    task_buttons = [e for e in entities if e["domain"] == "button" and e["entity_id"].endswith("_task_1")]
    assert len(task_buttons) == 1
    assert "Peluză" in task_buttons[0]["name"]
    assert task_buttons[0]["attributes"]["mammotion_button_kind"] == "schedule"
    assert task_buttons[0]["attributes"]["task_id"] == "1"

    named = next(e for e in entities if e["entity_id"].endswith("_task_2"))
    assert "Seara" in named["name"]
