"""Tests for direct_commands regex parsing and execution wiring."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from brain.direct_commands import (
    _parse_regex_multi,
    try_regex_command,
    try_semantic_commands,
)


def test_parse_regex_multi_simple():
    assert _parse_regex_multi("aprinde becul") == [("turn_on", "becul")]
    assert _parse_regex_multi("turn off the fan") == [("turn_off", "fan")]


def test_parse_regex_multi_defer_coordinated():
    assert _parse_regex_multi("turn off kitchen and bedroom lights") == []
    assert _parse_regex_multi("aprinde toate luminile") == []


def test_parse_regex_multi_split_commands():
    result = _parse_regex_multi("aprinde becul și stinge lampa")
    assert result == [("turn_on", "becul"), ("turn_off", "lampa")]


def test_try_regex_command_executes_via_device_control():
    async def _run():
        with patch(
            "core.device_resolver.find_device_details",
            new=AsyncMock(return_value=("light.kitchen", "Kitchen")),
        ):
            with patch(
                "brain.direct_commands.control_entity",
                new=AsyncMock(return_value={"ok": True}),
            ):
                return await try_regex_command("aprinde bucatarie", "user_1")

    reply = asyncio.run(_run())
    assert reply is not None
    assert "Kitchen" in reply or "kitchen" in reply.lower()


def test_try_semantic_commands_no_catalogue():
    with patch("brain.direct_commands._build_catalogue_from_store", return_value=""):
        assert asyncio.run(try_semantic_commands("aprinde becul", "user_1")) is None
