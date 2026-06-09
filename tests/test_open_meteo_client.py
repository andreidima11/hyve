import httpx
import pytest

from tests.component_helpers import component_module

_client = component_module("open_meteo", "client")
OpenMeteoClient = _client.OpenMeteoClient
_location_query_variants = _client._location_query_variants


def test_location_query_variants_fold_diacritics():
    assert _location_query_variants("Timișoara") == ["Timișoara", "Timisoara"]


@pytest.mark.anyio
async def test_resolve_location_prefers_configured_coordinates():
    client = OpenMeteoClient(location_query="Timișoara", latitude="45.7538", longitude="21.2257")

    async def _unexpected_request(url, params):
        raise AssertionError("coordinates should skip geocoding")

    client._get_json = _unexpected_request

    location = await client._resolve_location()

    assert location.latitude == 45.7538
    assert location.longitude == 21.2257
    assert location.name == "Timișoara"


@pytest.mark.anyio
async def test_resolve_location_falls_back_to_nominatim_when_open_meteo_geocoding_fails():
    client = OpenMeteoClient(location_query="Timișoara")
    urls = []

    async def _fake_get_json(url, params):
        urls.append(url)
        if "geocoding-api.open-meteo.com" in url:
            request = httpx.Request("GET", url)
            response = httpx.Response(502, request=request)
            raise httpx.HTTPStatusError("Bad Gateway", request=request, response=response)
        if "nominatim.openstreetmap.org" in url:
            return [
                {
                    "lat": "45.7538355",
                    "lon": "21.2257474",
                    "name": "Timișoara",
                    "address": {"state": "Timiș", "country": "Romania"},
                }
            ]
        raise AssertionError(url)

    client._get_json = _fake_get_json

    location = await client._resolve_location()

    assert location.latitude == 45.7538355
    assert location.longitude == 21.2257474
    assert location.name == "Timișoara, Timiș, Romania"
    assert any("geocoding-api.open-meteo.com" in url for url in urls)
    assert any("nominatim.openstreetmap.org" in url for url in urls)