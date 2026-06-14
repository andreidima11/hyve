"""Tapo / python-kasa TLS cipher patch."""

from components.tapo import kasa_ssl


def test_apply_kasa_ssl_cipher_patch_adds_ecdhe_ciphers():
    kasa_ssl._PATCHED = False
    try:
        from kasa.transports import sslaestransport
    except ImportError:
        return

    original = sslaestransport.SslAesTransport.CIPHERS
    try:
        kasa_ssl.apply_kasa_ssl_cipher_patch()
        patched = sslaestransport.SslAesTransport.CIPHERS
        assert "ECDHE-ECDSA-AES128-GCM-SHA256" in patched
        assert "ECDHE-RSA-AES128-GCM-SHA256" in patched
        assert "@SECLEVEL=1" in patched
        assert patched.startswith("ECDHE-ECDSA-AES256-GCM-SHA384")
    finally:
        sslaestransport.SslAesTransport.CIPHERS = original
        kasa_ssl._PATCHED = False


def test_apply_kasa_ssl_cipher_patch_is_idempotent():
    kasa_ssl._PATCHED = False
    try:
        from kasa.transports import sslaestransport
    except ImportError:
        return

    original = sslaestransport.SslAesTransport.CIPHERS
    try:
        kasa_ssl.apply_kasa_ssl_cipher_patch()
        first = sslaestransport.SslAesTransport.CIPHERS
        kasa_ssl.apply_kasa_ssl_cipher_patch()
        assert sslaestransport.SslAesTransport.CIPHERS == first
    finally:
        sslaestransport.SslAesTransport.CIPHERS = original
        kasa_ssl._PATCHED = False
