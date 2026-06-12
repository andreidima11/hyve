"""Integrations must set shared device_id so UI groups entities under one device."""

from __future__ import annotations

from components.pago.extract import extract_pago_candidates
from components.reteleelectrice.extract import extract_reteleelectrice_candidates
from components.sun.entity import SunEntity


def test_pago_entities_share_one_device_per_entry():
    entry_id = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    items = extract_pago_candidates({
        "facturi": [{"furnizor": "Engie", "suma_datorata": 10, "scadenta": "2026-04-01"}],
        "vehicule": [{"nr_inmatriculare": "B-123-ABC", "alerte": {"rca_expira": "2026-07-01"}}],
        "abonament": {"activ": True, "plati_ramase": 1},
    }, entry_id=entry_id, entry_title="Cont Pago")
    assert len(items) >= 3
    device_ids = {e["device_id"] for e in items}
    assert device_ids == {entry_id}
    assert all(e["device_name"] == "Cont Pago" for e in items)


def test_reteleelectrice_pod_entities_share_device_id():
    pod = "RO0012345678901"
    items = extract_reteleelectrice_candidates({
        "user_name": "Test User",
        "account": {"Name": "Test User"},
        "contact": {},
        "pods": [{
            "name": pod,
            "raw": {
                "Contract_Type__c": "CONSUMER",
                "Smart_meter__c": False,
                "isProductor__c": False,
            },
            "outages": {"data": {"checkInterruzione": "true", "messaggio": "OK"}},
            "readings": {"XML_Readings": []},
        }],
    })
    assert len(items) >= 3
    device_ids = {e["device_id"] for e in items}
    assert device_ids == {pod}
    assert all(e["device_name"] == pod for e in items)


def test_sun_entities_share_device_id():
    ent = SunEntity(entry_id="entry-abc", entry_data={"latitude": "44.4", "longitude": "26.1"}, entry_title="Sun")
    items = ent.extract_entities({
        "elevation": 12.5,
        "azimuth": 180.0,
        "next_rising": "2026-06-08 05:30:00",
        "next_setting": "2026-06-08 20:45:00",
        "rising": True,
    })
    assert len(items) > 1
    device_ids = {e["device_id"] for e in items}
    assert len(device_ids) == 1
    assert list(device_ids)[0].startswith("sun_")
