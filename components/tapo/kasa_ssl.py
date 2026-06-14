"""Extend python-kasa TLS ciphers for newer Tapo cameras.

Upstream main (post-0.10.2) adds ``ECDHE-RSA-AES128-GCM-SHA256`` and
``login_version`` 3 support. C225/C220 use EC certs and still need ECDHE-ECDSA
suites plus ``@SECLEVEL=1`` for legacy RSA-1024 devices (C120).
"""

from __future__ import annotations

_PATCHED = False

# Newer Tapo cams (EC cert, e.g. C225) and older fw bumps (RSA-1024, e.g. C120).
_EXTRA_CIPHERS = (
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
)


def apply_kasa_ssl_cipher_patch() -> None:
    """Idempotently widen ``SslAesTransport`` cipher list."""
    global _PATCHED
    if _PATCHED:
        return
    try:
        from kasa.transports import sslaestransport
    except ImportError:
        return

    cls = sslaestransport.SslAesTransport
    existing = [c for c in cls.CIPHERS.split(":") if c]
    merged: list[str] = []
    for cipher in (*_EXTRA_CIPHERS, *existing):
        if cipher not in merged:
            merged.append(cipher)
    # Allow RSA-1024 device certs (C120/C210) without lowering verify_mode.
    if "@SECLEVEL=1" not in merged:
        merged.append("@SECLEVEL=1")
    cls.CIPHERS = ":".join(merged)
    _PATCHED = True
