import asyncio

import pytest
from fastapi import HTTPException

import core.auth as auth


class _NonAdminUser:
    is_admin = False


class _AdminUser:
    is_admin = True


def test_get_current_admin_rejects_non_admin():
    async def run():
        with pytest.raises(HTTPException) as exc:
            await auth.get_current_admin(current_user=_NonAdminUser())
        assert exc.value.status_code == 403
        assert exc.value.detail == {"key": "common.admin_required"}

    asyncio.run(run())


def test_get_current_admin_allows_admin():
    admin = _AdminUser()

    async def run():
        user = await auth.get_current_admin(current_user=admin)
        assert user is admin

    asyncio.run(run())
