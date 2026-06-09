"""Integration client helpers (legacy router status tests removed — see components/)."""

from tests.component_helpers import component_module

_client = component_module("fusion_solar", "client")
_candidate_hosts = _client._candidate_hosts
_extract_kiosk_id = _client._extract_kiosk_id
_normalize_host = _client._normalize_host


def test_extract_kiosk_id_from_fragment_url():
    url = "https://eu5.fusionsolar.huawei.com/pvmswebsite/nologin/assets/build/index.html#/kiosk?kk=ABC123"

    assert _extract_kiosk_id(url) == "ABC123"


def test_normalize_fusionsolar_host_examples():
    normalized = _normalize_host("https://intl.fusionsolar.huawei.com/thirdData/")
    candidates = _candidate_hosts("eu5.fusionsolar.huawei.com/thirdData/")

    assert normalized == "https://intl.fusionsolar.huawei.com"
    assert candidates[0] == "https://eu5.fusionsolar.huawei.com"
    assert "https://intl.fusionsolar.huawei.com" in candidates
