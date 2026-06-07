import asyncio
import time

from fusion_solar_client import FusionSolarClient


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
