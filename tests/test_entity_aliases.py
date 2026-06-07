"""Entity id alias resolution for Z2M vs HA discovery naming."""

from integrations.entity_utils import entity_id_lookup_variants, resolve_entity_by_id


def test_entity_id_lookup_variants_z2m_to_ha():
    variants = entity_id_lookup_variants("switch.releu_dormitor2_state_l3")
    assert "switch.releu_dormitor2_state_l3" in variants
    assert "switch.releu_dormitor2_l3" in variants


def test_entity_id_lookup_variants_ha_to_z2m():
    variants = entity_id_lookup_variants("switch.releu_dormitor2_l3")
    assert "switch.releu_dormitor2_state_l3" in variants


def test_resolve_entity_by_id_matches_alias():
    items = [{
        "entity_id": "switch.releu_dormitor2_l3",
        "unique_id": "z2m:releu_dormitor2:state_l3",
        "state": "off",
        "controllable": True,
        "source": "mosquitto",
    }]
    hit = resolve_entity_by_id("switch.releu_dormitor2_state_l3", items)
    assert hit is not None
    assert hit["entity_id"] == "switch.releu_dormitor2_l3"
