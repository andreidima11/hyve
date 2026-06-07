from integrations.source_aliases import entity_matches_integration, entity_sources_for_integration


def test_mosquitto_includes_zigbee2mqtt_sources():
    assert entity_sources_for_integration("mosquitto") == frozenset({"mosquitto", "zigbee2mqtt"})
    assert entity_matches_integration("zigbee2mqtt", "mosquitto")
    assert entity_matches_integration("mosquitto", "mosquitto")
    assert not entity_matches_integration("frigate", "mosquitto")


def test_other_integrations_use_single_source():
    assert entity_sources_for_integration("frigate") == frozenset({"frigate"})
    assert entity_matches_integration("frigate", "frigate")
