from __future__ import annotations

import asyncio

import pytest

import midea_ac_client
from integrations.extractors import extract_midea_ac_candidates, infer_source
from integrations.providers.midea_ac import MideaAcEntity
from midea_ac_client import MideaAcClient, MideaAcError, normalize_cloud_region, parse_devices_field


class _FakeDiscover:
    discover_single_called = False
    discover_called = False

    @classmethod
    async def discover_single(cls, *args, **kwargs):
        cls.discover_single_called = True
        raise AssertionError("control must not call cloud-backed discover_single")

    @classmethod
    async def discover(cls, *args, **kwargs):
        cls.discover_called = True
        raise AssertionError("control must not call discovery")

class _FakeLan:
    def __init__(self):
        self.disconnected = False

    def _disconnect(self):
        self.disconnected = True


class _FakeEnumValue:
    def __init__(self, name, value):
        self.name = name
        self.value = value


class _FakeEnum:
    def __init__(self, values):
        self._values = [_FakeEnumValue(name, idx) for idx, name in enumerate(values)]

    def __iter__(self):
        return iter(self._values)

    def __call__(self, value):
        for item in self._values:
            if item.value == value:
                return item
        raise ValueError(value)


class _FakeAC:
    created: list["_FakeAC"] = []

    OperationalMode = _FakeEnum(["AUTO", "COOL", "HEAT", "DRY", "FAN_ONLY"])

    FanSpeed = _FakeEnum(["AUTO", "LOW", "MEDIUM", "HIGH"])

    SwingMode = _FakeEnum(["OFF", "VERTICAL", "HORIZONTAL", "BOTH"])

    def __init__(self, ip: str, device_id: int, port: int, **kwargs):
        self.ip = ip
        self.id = device_id
        self.port = port
        self.name = ""
        self.power_state = False
        self.operational_mode = None
        self.target_temperature = 22.0
        self._display_on = True
        self.supported = True
        self.online = True
        self.supported_operation_modes = []
        self.supported_fan_speeds = []
        self.supported_swing_modes = []
        self.authenticated_with = None
        self.refreshed = False
        self.applied = False
        self._lan = _FakeLan()
        self.__class__.created.append(self)

    async def authenticate(self, token, key):
        self.authenticated_with = (token, key)

    async def refresh(self):
        self.refreshed = True

    async def apply(self):
        self.applied = True

    @property
    def display_on(self):
        return self._display_on

    async def toggle_display(self):
        self._display_on = not self._display_on
        self.refreshed = True


class _FakeCloudTokenError(Exception):
    pass


class _FakeAuthenticationError(Exception):
    pass


class _FakeSecurity:
    @staticmethod
    def udpid(raw: bytes) -> bytes:
        return raw


class _FakeDiscoveredDevice:
    def __init__(self, device_id: int):
        self.id = device_id
        self.ip = "192.168.1.50"
        self.port = 6444
        self.version = 3
        self.supported = True
        self.name = "Midea_AC"
        self.authenticated_with = None
        self.refreshed = False
        self.token = None
        self.key = None

    async def authenticate(self, token, key):
        self.authenticated_with = (token, key)
        self.token = token
        self.key = key

    async def refresh(self):
        self.refreshed = True


class _TokenRetryCloud:
    def __init__(self):
        self.udpids: list[str] = []

    async def get_token(self, udpid: str):
        self.udpids.append(udpid)
        if len(self.udpids) == 1:
            raise _FakeCloudTokenError("Code: 3004, Message: value is illegal")
        return "tok", "key"


class _SlowTokenCloud:
    async def get_token(self, udpid: str):
        await asyncio.sleep(2)
        return "tok", "key"


@pytest.fixture
def fake_msmart(monkeypatch):
    _FakeAC.created.clear()
    _FakeDiscover.discover_single_called = False
    _FakeDiscover.discover_called = False
    monkeypatch.setattr(midea_ac_client, "_import_msmart", lambda: (_FakeAC, _FakeDiscover, object()))
    return _FakeAC, _FakeDiscover


def test_infer_source_recognizes_midea_ac():
    assert infer_source("midea_ac:12345:power") == "midea_ac"


def test_parse_devices_field_handles_json_string():
    raw = '[{"name":"Living","host":"192.168.1.50","id":12345,"token":"t","key":"k"}]'
    devices = parse_devices_field(raw)
    assert devices == [
        {"host": "192.168.1.50", "port": 6444, "id": 12345, "token": "t", "key": "k", "name": "Living"},
    ]


def test_parse_devices_field_rejects_missing_host_or_id():
    with pytest.raises(MideaAcError):
        parse_devices_field([{"host": "192.168.1.50"}])
    with pytest.raises(MideaAcError):
        parse_devices_field("not json")


def test_parse_devices_field_empty_returns_empty_list():
    assert parse_devices_field("") == []
    assert parse_devices_field(None) == []


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("US", "US"),
        ("eu", "DE"),
        ("RO", "DE"),
        ("sea", "KR"),
        ("cn", "CN"),
    ],
)
def test_normalize_cloud_region_accepts_common_aliases(raw, expected):
    assert normalize_cloud_region(raw) == expected


def test_normalize_cloud_region_rejects_unknown_values():
    with pytest.raises(MideaAcError, match="Regiune Midea necunoscută"):
        normalize_cloud_region("EUROPA-NORD")


def test_cloud_attempts_map_eu_to_de_with_public_fallback():
    client = MideaAcClient(region="EU")
    assert client.region == "DE"
    assert client._cloud_attempts() == [
        {"provider": "nethome", "region": "DE", "account": "", "password": ""},
        {"provider": "smarthome", "region": "DE", "account": "", "password": ""},
    ]


def test_cloud_attempts_try_account_backends_then_public_credentials():
    client = MideaAcClient(account="user@example.com", password="secret", region="US")
    assert client._cloud_attempts() == [
        {"provider": "nethome", "region": "US", "account": "user@example.com", "password": "secret"},
        {"provider": "smarthome", "region": "US", "account": "user@example.com", "password": "secret"},
    ]


def test_cloud_attempts_explicit_provider_is_preferred_not_exclusive():
    client = MideaAcClient(account="user@example.com", password="secret", region="DE", cloud_provider="smarthome")
    assert client._cloud_attempts() == [
        {"provider": "smarthome", "region": "DE", "account": "user@example.com", "password": "secret"},
        {"provider": "nethome", "region": "DE", "account": "user@example.com", "password": "secret"},
    ]


def test_cloud_attempts_cn_requires_account():
    client = MideaAcClient(region="CN")
    with pytest.raises(MideaAcError, match="Regiunea CN"):
        client._cloud_attempts()


def test_extract_midea_ac_candidates_emits_controllable_climate_entities():
    payload = {
        "devices": [
            {
                "id": 12345,
                "name": "Living",
                "ip": "192.168.1.50",
                "online": True,
                "power_state": True,
                "operational_mode": "COOL",
                "fan_speed": "AUTO",
                "swing_mode": "OFF",
                "target_temperature": 22.5,
                "indoor_temperature": 24.0,
                "outdoor_temperature": 30.0,
                "min_target_temperature": 17,
                "max_target_temperature": 30,
                "supports_humidity": True,
                "indoor_humidity": 55,
                "supports_eco": True,
                "eco": False,
                "supports_turbo": True,
                "turbo": False,
                "supports_display_control": True,
                "display_on": True,
                "supported_operation_modes": ["AUTO", "COOL", "HEAT", "DRY", "FAN_ONLY"],
                "supported_fan_speeds": ["AUTO", "LOW", "MEDIUM", "HIGH"],
                "supported_swing_modes": ["OFF", "VERTICAL", "HORIZONTAL", "BOTH"],
            }
        ]
    }
    items = extract_midea_ac_candidates(payload)
    by_id = {item["unique_id"]: item for item in items}

    climate = by_id["midea_ac:12345:climate"]
    assert climate["entity_id"] == "climate.midea_ac_12345_climate"
    assert climate["domain"] == "climate"
    assert climate["controllable"] is True
    assert climate["state"] == "cool"
    assert climate["attributes"]["current_temperature"] == 24.0
    assert climate["attributes"]["target_temperature"] == 22.5
    assert any(opt["value"] == "cool" for opt in climate["attributes"]["hvac_modes"])

    assert "midea_ac:12345:power" in by_id
    assert by_id["midea_ac:12345:power"]["controllable"] is True
    assert by_id["midea_ac:12345:power"]["state"] == "on"

    target = by_id["midea_ac:12345:target_temperature"]
    assert target["controllable"] is True
    assert target["domain"] == "number"
    assert target["attributes"]["capabilities"]["min"] == 17

    mode = by_id["midea_ac:12345:operational_mode"]
    assert mode["controllable"] is True
    assert any(opt["value"] == "COOL" for opt in mode["attributes"]["capabilities"]["options"])


def test_extract_midea_ac_candidates_skips_unsupported_optional_features():
    payload = {"devices": [{"id": 1, "name": "Test", "power_state": False}]}
    items = extract_midea_ac_candidates(payload)
    suffixes = {item["unique_id"].split(":")[-1] for item in items}
    # No mode/fan/swing/eco/turbo/humidity when not supported
    assert "operational_mode" not in suffixes
    assert "fan_speed" not in suffixes
    assert "indoor_humidity" not in suffixes
    assert "eco" not in suffixes
    # Power is always there
    assert "power" in suffixes


def test_provider_build_client_seeds_remembered_lan_devices(monkeypatch):
    monkeypatch.setattr(
        MideaAcEntity,
        "_remembered_lan_devices",
        classmethod(lambda cls: [{"host": "192.168.0.13", "port": 6444, "id": 12345, "token": None, "key": None}]),
    )

    client = MideaAcEntity._build_client({"region": "DE"}, include_remembered=True)

    assert client.manual_devices == [
        {"host": "192.168.0.13", "port": 6444, "id": 12345, "token": None, "key": None}
    ]


def test_provider_build_client_prefers_explicit_manual_devices(monkeypatch):
    monkeypatch.setattr(
        MideaAcEntity,
        "_remembered_lan_devices",
        classmethod(lambda cls: [{"host": "192.168.0.13", "port": 6444, "id": 12345, "token": None, "key": None}]),
    )

    client = MideaAcEntity._build_client(
        {"devices": '[{"host":"192.168.0.20","id":67890,"token":"tok","key":"key"}]'}
    )

    assert client.manual_devices == [
        {"host": "192.168.0.20", "port": 6444, "id": 67890, "token": "tok", "key": "key", "name": ""}
    ]


def test_provider_build_client_merges_remembered_hosts_missing_from_cache(monkeypatch):
    monkeypatch.setattr(
        MideaAcEntity,
        "_remembered_lan_devices",
        classmethod(lambda cls: [
            {"host": "192.168.0.13", "port": 6444, "id": 12345, "token": None, "key": None},
            {"host": "192.168.0.136", "port": 6444, "id": 67890, "token": None, "key": None},
        ]),
    )

    client = MideaAcEntity._build_client(
        {"_cached_devices": [{"host": "192.168.0.13", "port": 6444, "id": 12345, "token": "tok", "key": "key"}]},
        include_remembered=True,
    )

    assert client.cached_devices == [
        {"host": "192.168.0.13", "port": 6444, "id": 12345, "token": "tok", "key": "key", "name": ""}
    ]
    assert client.manual_devices == [
        {"host": "192.168.0.136", "port": 6444, "id": 67890, "token": None, "key": None}
    ]


def test_provider_build_client_does_not_seed_remembered_hosts_by_default(monkeypatch):
    monkeypatch.setattr(
        MideaAcEntity,
        "_remembered_lan_devices",
        classmethod(lambda cls: [{"host": "192.168.0.13", "port": 6444, "id": 12345, "token": None, "key": None}]),
    )

    client = MideaAcEntity._build_client({"region": "DE"})

    assert client.manual_devices == []


def test_control_uses_cached_token_key_without_discovery(fake_msmart):
    FakeAC, FakeDiscover = fake_msmart
    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}])

    result = asyncio.run(client.control_entity("midea_ac:12345:power", "turn_on"))

    device = FakeAC.created[-1]
    assert result["ok"] is True
    assert device.authenticated_with == ("tok", "key")
    assert device.refreshed is True
    assert device.applied is True
    assert device._lan.disconnected is True
    assert device.power_state is True
    assert FakeDiscover.discover_single_called is False
    assert FakeDiscover.discover_called is False


def test_control_merges_cached_credentials_into_manual_entry(fake_msmart):
    FakeAC, _FakeDiscover = fake_msmart
    client = MideaAcClient(
        devices=[{"host": "192.168.1.51", "id": 12345}],
        cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}],
    )

    asyncio.run(client.control_entity("midea_ac:12345:power", "turn_off"))

    device = FakeAC.created[-1]
    assert device.ip == "192.168.1.51"
    assert device.authenticated_with == ("tok", "key")


def test_control_without_local_credentials_does_not_discover(fake_msmart):
    _FakeACClass, FakeDiscover = fake_msmart
    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345}])

    with pytest.raises(MideaAcError, match="token/key local"):
        asyncio.run(client.control_entity("midea_ac:12345:power", "turn_on"))

    assert FakeDiscover.discover_single_called is False
    assert FakeDiscover.discover_called is False


def test_control_without_any_local_device_is_actionable(fake_msmart):
    client = MideaAcClient()

    with pytest.raises(MideaAcError, match="configurează dispozitivul manual"):
        asyncio.run(client.control_entity("midea_ac:12345:power", "turn_on"))


def test_display_control_uses_toggle_api_not_readonly_setter(fake_msmart):
    FakeAC, _FakeDiscover = fake_msmart
    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}])

    result = asyncio.run(client.control_entity("midea_ac:12345:display_on", "turn_off"))

    device = FakeAC.created[-1]
    assert result["ok"] is True
    assert device.display_on is False
    assert device.applied is False
    assert device._lan.disconnected is True


def test_set_hvac_mode_action_wins_over_target_temperature_suffix(fake_msmart):
    FakeAC, _FakeDiscover = fake_msmart
    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}])

    result = asyncio.run(
        client.control_entity(
            "midea_ac:12345:target_temperature",
            "set_hvac_mode",
            {"hvac_mode": "cool", "value": "cool"},
        )
    )

    device = FakeAC.created[-1]
    assert result["ok"] is True
    assert device.power_state is True
    assert getattr(device.operational_mode, "name", "") == "COOL"
    assert device.applied is True


def test_set_temperature_action_wins_over_climate_suffix(fake_msmart):
    FakeAC, _FakeDiscover = fake_msmart
    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}])

    result = asyncio.run(
        client.control_entity("midea_ac:12345:climate", "set_temperature", {"temperature": 23.5})
    )

    device = FakeAC.created[-1]
    assert result["ok"] is True
    assert device.target_temperature == 23.5
    assert device.applied is True


def test_fetch_closes_lan_connections(fake_msmart):
    FakeAC, _FakeDiscoverClass = fake_msmart
    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}])

    result = asyncio.run(client.fetch_all())

    device = FakeAC.created[-1]
    assert len(result["devices"]) == 1
    assert device.refreshed is True
    assert device._lan.disconnected is True


def test_fetch_with_cached_device_offline_does_not_fall_back_to_cloud(monkeypatch):
    class OfflineAC(_FakeAC):
        async def authenticate(self, token, key):
            raise TimeoutError("No response from host.")

    _FakeDiscover.discover_single_called = False
    _FakeDiscover.discover_called = False
    monkeypatch.setattr(midea_ac_client, "_import_msmart", lambda: (OfflineAC, _FakeDiscover, object()))

    client = MideaAcClient(cached_devices=[{"host": "192.168.1.50", "id": 12345, "token": "tok", "key": "key"}])

    result = asyncio.run(client.fetch_all())

    assert result == {"devices": []}
    assert _FakeDiscover.discover_single_called is False
    assert _FakeDiscover.discover_called is False


def test_discovery_retries_big_endian_udpid_after_cloud_3004(monkeypatch):
    device_id = 0x010203040506
    device = _FakeDiscoveredDevice(device_id)
    cloud = _TokenRetryCloud()

    class FakeDiscover:
        @classmethod
        async def discover(cls, *args, **kwargs):
            return [device]

        @classmethod
        async def _get_cloud(cls):
            return cloud

    monkeypatch.setattr(midea_ac_client, "_import_msmart", lambda: (_FakeAC, FakeDiscover, object()))
    monkeypatch.setattr(
        midea_ac_client,
        "_import_lan_helpers",
        lambda: (_FakeCloudTokenError, _FakeAuthenticationError, _FakeSecurity),
    )

    client = MideaAcClient(region="DE", cloud_provider="nethome", discovery_timeout=1)
    devices = asyncio.run(client._discover_lan())

    assert devices == [device]
    assert cloud.udpids == [
        device_id.to_bytes(6, "little").hex(),
        device_id.to_bytes(6, "big").hex(),
    ]
    assert device.authenticated_with == ("tok", "key")
    assert device.refreshed is True


def test_seeded_host_lookup_persists_token_key(monkeypatch):
    device = _FakeDiscoveredDevice(12345)
    snapshots = []

    class FakeDiscover:
        @classmethod
        async def discover(cls, *args, **kwargs):
            return [device]

        @classmethod
        async def _get_cloud(cls):
            return _TokenRetryCloud()

    monkeypatch.setattr(midea_ac_client, "_import_msmart", lambda: (_FakeAC, FakeDiscover, object()))
    monkeypatch.setattr(
        midea_ac_client,
        "_import_lan_helpers",
        lambda: (_FakeCloudTokenError, _FakeAuthenticationError, _FakeSecurity),
    )

    client = MideaAcClient(
        region="DE",
        cloud_provider="nethome",
        discovery_timeout=1,
        devices=[{"host": "192.168.1.50", "id": 12345}],
        cache_callback=snapshots.append,
    )

    result = asyncio.run(client.fetch_all())

    assert len(result["devices"]) == 1
    assert snapshots == [[
        {"host": "192.168.1.50", "port": 6444, "id": 12345, "token": "tok", "key": "key", "name": "Midea_AC"}
    ]]


def test_discovery_token_lookup_has_per_udpid_timeout(monkeypatch):
    device = _FakeDiscoveredDevice(12345)

    class FakeDiscover:
        _lock = asyncio.Lock()

        @classmethod
        async def discover(cls, *args, **kwargs):
            return [device]

        @classmethod
        async def _get_cloud(cls):
            return _SlowTokenCloud()

    monkeypatch.setattr(midea_ac_client, "_import_msmart", lambda: (_FakeAC, FakeDiscover, object()))
    monkeypatch.setattr(
        midea_ac_client,
        "_import_lan_helpers",
        lambda: (_FakeCloudTokenError, _FakeAuthenticationError, _FakeSecurity),
    )

    client = MideaAcClient(region="DE", cloud_provider="nethome", discovery_timeout=1, cloud_token_timeout=1)
    monkeypatch.setattr(
        client,
        "_cloud_attempts",
        lambda: [{"provider": "nethome", "region": "DE", "account": "", "password": ""}],
    )

    with pytest.raises(MideaAcError, match="autentificare cloud eșuată"):
        asyncio.run(client._discover_lan())
