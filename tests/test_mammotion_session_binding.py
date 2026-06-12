"""Session binding and auth error helpers."""

from __future__ import annotations

from components.mammotion.session_binding import bind_http_to_client, resolve_mammotion_http
from components.mammotion.utils import is_auth_session_error


def test_is_auth_session_error_detects_stale_tokens():
    assert is_auth_session_error(Exception("refreshToken invalid!!"))
    assert is_auth_session_error(Exception("No HTTP client available for re-login"))
    assert not is_auth_session_error(Exception("timeout"))


def test_resolve_mammotion_http_prefers_account_session():
    http = object()
    acct = type(
        "Acct",
        (),
        {
            "account_id": "a@b.com",
            "mammotion_http": http,
            "cloud_client": None,
        },
    )()
    client = type(
        "Client",
        (),
        {
            "_account_registry": type(
                "Reg",
                (),
                {"get": lambda self, key: acct if key == "a@b.com" else None, "all_sessions": [acct]},
            )(),
            "mammotion_http": None,
        },
    )()
    assert resolve_mammotion_http(client, "a@b.com") is http


def test_bind_http_to_client_sets_session_on_account():
    http = object()
    acct = type("Acct", (), {"mammotion_http": type("H", (), {"_session": None})(), "cloud_client": None})()
    client = type(
        "Client",
        (),
        {
            "_account_registry": type(
                "Reg",
                (),
                {"get": lambda self, _a: acct, "all_sessions": [acct]},
            )(),
            "mammotion_http": None,
        },
    )()
    bind_http_to_client(client, http, account="a@b.com")
    assert client._hyve_http_session is http
    assert acct.mammotion_http._session is http


def test_resolve_mammotion_http_does_not_recurse_with_patched_property():
    from components.mammotion.pymammotion_compat import apply_pymammotion_patches
    from pymammotion.client import MammotionClient

    apply_pymammotion_patches()
    client = MammotionClient()
    assert resolve_mammotion_http(client, "missing@x.com") is None
    assert client.mammotion_http is None


def test_ensure_account_http_registers_session():
    import asyncio
    from unittest.mock import AsyncMock, MagicMock, patch

    from components.mammotion.pymammotion_compat import apply_pymammotion_patches
    from pymammotion.client import MammotionClient

    apply_pymammotion_patches()
    client = MammotionClient()
    fake_http = MagicMock()
    fake_resp = MagicMock(code=0, msg="ok")
    fake_http.login_v2 = AsyncMock(return_value=fake_resp)

    with patch("pymammotion.http.http.MammotionHTTP", return_value=fake_http):
        http = asyncio.run(
            __import__("components.mammotion.session_binding", fromlist=["ensure_account_http"]).ensure_account_http(
                client,
                "a@b.com",
                "secret",
            )
        )
    assert http is fake_http
    acct = client._account_registry.get("a@b.com")
    assert acct is not None
    assert acct.mammotion_http is fake_http
