"""Tests for shell tool security defaults."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import core.settings as settings
from brain.tool_shell import exec_allow_shell, exec_run_shell, is_run_script_enabled, is_shell_enabled


def test_shell_disabled_by_default_in_fresh_config():
    cfg = settings.DEFAULT_CONFIG.copy()
    shell = (cfg.get("intelligence") or {}).get("shell") or {}
    assert shell.get("enabled") is False


def test_is_shell_enabled_respects_config():
    with patch.object(settings, "CFG", {"intelligence": {"shell": {"enabled": False}}}):
        assert is_shell_enabled() is False
    with patch.object(settings, "CFG", {"intelligence": {"shell": {"enabled": True}}}):
        assert is_shell_enabled() is True


def test_run_script_requires_shell_and_flag():
    with patch.object(
        settings,
        "CFG",
        {"intelligence": {"shell": {"enabled": False}, "run_script": {"enabled": True}}},
    ):
        assert is_run_script_enabled() is False
    with patch.object(
        settings,
        "CFG",
        {"intelligence": {"shell": {"enabled": True}, "run_script": {"enabled": True}}},
    ):
        assert is_run_script_enabled() is True


def test_exec_run_shell_blocked_when_disabled():
    with patch.object(settings, "CFG", {"intelligence": {"shell": {"enabled": False}}}):
        out = asyncio.run(exec_run_shell({"command": "echo hi"}, "user_1", "/tmp"))
    assert "disabled" in out.lower()


def test_exec_allow_shell_blocked_when_disabled():
    with patch.object(settings, "CFG", {"intelligence": {"shell": {"enabled": False}}}):
        out = exec_allow_shell("user_1")
    assert "disabled" in out.lower()
