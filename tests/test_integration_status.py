import pytest

from routers import fusion_solar, pago


class _DummyFusionClient:
    async def test_connection(self):
        return {"ok": True, "message": "Fusion ok"}


class _DummyPagoClient:
    async def test_connection(self):
        return {"ok": True, "message": "Pago ok"}


@pytest.mark.anyio
async def test_fusion_status_allows_connection_test_when_disabled(monkeypatch):
    monkeypatch.setattr(
        fusion_solar.settings_mod,
        "CFG",
        {"fusion_solar": {"enabled": False, "host": "https://example", "username": "demo", "password": "secret"}},
    )

    async def _fake_ensure_client():
        return _DummyFusionClient()

    monkeypatch.setattr(fusion_solar.fusion_solar_client, "ensure_client", _fake_ensure_client)

    result = await fusion_solar.fusion_solar_status(user=None)

    assert result["ok"] is True
    assert "Fusion" in result["message"]


@pytest.mark.anyio
async def test_pago_status_allows_connection_test_when_disabled(monkeypatch):
    monkeypatch.setattr(
        pago.settings_mod,
        "CFG",
        {"pago": {"enabled": False, "email": "demo@example.com", "password": "secret"}},
    )

    async def _fake_ensure_client():
        return _DummyPagoClient()

    monkeypatch.setattr(pago.pago_client, "ensure_client", _fake_ensure_client)

    result = await pago.pago_status(user=None)

    assert result["ok"] is True
    assert "Pago" in result["message"]


def test_extract_kiosk_id_from_fragment_url():
    from fusion_solar_client import _extract_kiosk_id

    url = "https://eu5.fusionsolar.huawei.com/pvmswebsite/nologin/assets/build/index.html#/kiosk?kk=ABC123"

    assert _extract_kiosk_id(url) == "ABC123"


def test_normalize_fusionsolar_host_examples():
    from fusion_solar_client import _normalize_host, _candidate_hosts

    normalized = _normalize_host("https://intl.fusionsolar.huawei.com/thirdData/")
    candidates = _candidate_hosts("eu5.fusionsolar.huawei.com/thirdData/")

    assert normalized == "https://intl.fusionsolar.huawei.com"
    assert candidates[0] == "https://eu5.fusionsolar.huawei.com"
    assert "https://intl.fusionsolar.huawei.com" in candidates


@pytest.mark.anyio
async def test_fusion_status_supports_kiosk_mode(monkeypatch):
    monkeypatch.setattr(
        fusion_solar.settings_mod,
        "CFG",
        {"fusion_solar": {"enabled": True, "mode": "kiosk", "kiosk_url": "https://eu5.fusionsolar.huawei.com/pvmswebsite/nologin/assets/build/index.html#/kiosk?kk=ABC123"}},
    )

    class _DummyKioskClient:
        async def test_connection(self):
            return {"ok": True, "message": "Kiosk ok"}

    async def _fake_ensure_client():
        return _DummyKioskClient()

    monkeypatch.setattr(fusion_solar.fusion_solar_client, "ensure_client", _fake_ensure_client)

    result = await fusion_solar.fusion_solar_status(user=None)

    assert result["ok"] is True
    assert "Kiosk" in result["message"]
