"""Tests for core.http.runtime run_coroutine_on_main_loop."""

from __future__ import annotations

import asyncio

import pytest

from core.http import runtime


def test_run_coroutine_on_main_loop_uses_running_loop():
    async def _run():
        loop = asyncio.get_running_loop()
        runtime.set_main_loop(loop)
        try:

            async def _add(a, b):
                await asyncio.sleep(0)
                return a + b

            result = await asyncio.to_thread(
                runtime.run_coroutine_on_main_loop,
                _add(2, 3),
            )
            assert result == 5
        finally:
            runtime.set_main_loop(None)

    asyncio.run(_run())


def test_run_coroutine_on_main_loop_refuses_orphan_without_fallback():
    runtime.set_main_loop(None)

    async def _noop():
        return None

    with pytest.raises(RuntimeError, match="not running"):
        runtime.run_coroutine_on_main_loop(_noop(), allow_fallback=False)


def test_run_coroutine_on_main_loop_fallback_for_tests():
    runtime.set_main_loop(None)

    async def _value():
        return 42

    assert runtime.run_coroutine_on_main_loop(_value(), allow_fallback=True) == 42
