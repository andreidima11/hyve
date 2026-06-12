"""pymammotion 0.8.x compatibility patches."""

from __future__ import annotations

from components.mammotion.pymammotion_compat import apply_pymammotion_patches


def test_apply_pymammotion_patches_idempotent():
    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    assert getattr(MammotionClient._full_relogin, "_hyve_patched", False) is True
    apply_pymammotion_patches()
    assert getattr(MammotionClient._full_relogin, "_hyve_patched", False) is True


def test_mammotion_http_uses_ha_app_version_header():
    from pymammotion.http.http import MammotionHTTP

    from components.mammotion.utils import mammotion_ha_fingerprint

    tag = mammotion_ha_fingerprint()
    http = MammotionHTTP(ha_version=tag)
    assert http._headers.get("App-Version") == f"HA,2.{tag}"
    assert hasattr(http, "devices_shared_info")


def test_mammotion_ha_fingerprint_defaults_to_known_good_tag(monkeypatch):
    from components.mammotion.utils import mammotion_ha_fingerprint

    monkeypatch.delenv("MAMMOTION_HA_FINGERPRINT", raising=False)
    assert mammotion_ha_fingerprint() == "0.6.4"


def test_login_and_initiate_cloud_is_not_wrapped():
    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    assert getattr(MammotionClient.login_and_initiate_cloud, "_hyve_patched", False) is False


def test_pymammotion_patch_shim_reexports():
    from components.mammotion import pymammotion_patch

    assert callable(pymammotion_patch.apply_pymammotion_patches)
    assert callable(pymammotion_patch.complete_device_registration)
    assert callable(pymammotion_patch.list_http_device_names)


def test_full_relogin_patch_is_applied():
    apply_pymammotion_patches()
    from pymammotion.client import MammotionClient

    assert getattr(MammotionClient._full_relogin, "_hyve_patched", False) is True
    assert getattr(MammotionClient._restore_aliyun, "_hyve_patched", False) is True
    assert getattr(MammotionClient._setup_aliyun_transport, "_hyve_patched", False) is True
