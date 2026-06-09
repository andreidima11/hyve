import asyncio
import time

from pathlib import Path

from tests.component_helpers import component_module

_client = component_module("fusion_solar", "client")
FusionSolarClient = _client.FusionSolarClient
FusionSolarRateLimitError = _client.FusionSolarRateLimitError


def test_rate_limit_error_i18n_detail():
    err = FusionSolarRateLimitError(retry_after=120, interval=600)
    detail = err.as_detail()
    assert detail["key"] == "integrations.fusion_solar_rate_limit_wait"
    assert detail["params"]["seconds"] == 120
    assert detail["params"]["interval"] == 600


def test_rate_limit_wait_or_raise_uses_structured_error():
    client = FusionSolarClient("https://eu5.fusionsolar.huawei.com", "user", "pass")
    client.set_user_sync_interval(600)
    try:
        client._rate_limit_wait_or_raise(65.0, "/thirdData/getStationList")
        assert False, "expected FusionSolarRateLimitError"
    except FusionSolarRateLimitError as exc:
        assert exc.retry_after >= 65
        assert exc.interval == 600


def test_rate_limit_bucket_splits_dev_real_kpi_by_type():
    client = FusionSolarClient("https://eu5.fusionsolar.huawei.com", "user", "pass")
    p1 = {"devIds": "1", "devTypeId": 1}
    p2 = {"devIds": "2", "devTypeId": 17}
    assert client._rate_limit_bucket("/thirdData/getDevRealKpi", p1) != client._rate_limit_bucket(
        "/thirdData/getDevRealKpi", p2
    )
    assert client._rate_limit_bucket("/thirdData/login", {}) == "/thirdData/login"


def test_dev_real_kpi_types_do_not_wait_full_station_interval(monkeypatch):
    client = FusionSolarClient("https://eu5.fusionsolar.huawei.com", "user", "pass")
    client._token = "token"
    calls: list[dict] = []

    async def fake_do_call(path, payload, retry=True):
        calls.append({"path": path, "devTypeId": payload.get("devTypeId")})
        return []

    monkeypatch.setattr(client, "_do_call", fake_do_call)
    monkeypatch.setattr(client, "get_station_list", lambda: asyncio.sleep(0, result=[{"station_code": "NE123"}]))
    monkeypatch.setattr(client, "get_station_real_kpi", lambda codes: asyncio.sleep(0, result=[]))
    monkeypatch.setattr(client, "get_kpi_station_year", lambda codes: asyncio.sleep(0, result=[]))
    monkeypatch.setattr(client, "get_dev_list", lambda codes: asyncio.sleep(0, result=[
        {"id": "1", "devTypeId": 1, "devName": "Inv", "stationCode": "NE123"},
        {"id": "2", "devTypeId": 17, "devName": "Meter", "stationCode": "NE123"},
    ]))

    started = time.monotonic()
    asyncio.run(client.fetch_all())
    elapsed = time.monotonic() - started

    dev_calls = [c for c in calls if c["path"] == "/thirdData/getDevRealKpi"]
    assert len(dev_calls) == 2
    assert elapsed < 10.0


def test_fetch_realtime_round_robin_one_device_type(monkeypatch):
    client = FusionSolarClient("https://eu5.fusionsolar.huawei.com", "user", "pass")
    client._token = "token"
    dev_type_calls: list[int] = []

    async def fake_get_station_real_kpi(codes):
        return [{"stationCode": "NE123", "dataItemMap": {"realTimePower": 1.5}}]

    async def fake_get_dev_real_kpi(dev_ids, type_id):
        dev_type_calls.append(type_id)
        return [{"devId": dev_ids.split(",")[0], "dataItemMap": {"active_power": 2.0}}]

    monkeypatch.setattr(client, "login", lambda: asyncio.sleep(0))
    monkeypatch.setattr(client, "get_station_real_kpi", fake_get_station_real_kpi)
    monkeypatch.setattr(client, "get_dev_real_kpi", fake_get_dev_real_kpi)

    cached = {
        "stations": [{"station_code": "NE123", "station_name": "Home"}],
        "devices": [
            {"device_id": "1", "device_type_id": 1, "realtime_kpi": {"active_power": 1.0}},
            {"device_id": "2", "device_type_id": 17, "realtime_kpi": {"active_power": 0.5}},
        ],
    }

    asyncio.run(client.fetch_realtime(cached))
    assert dev_type_calls == [1]

    asyncio.run(client.fetch_realtime(cached))
    assert dev_type_calls == [1, 17]
