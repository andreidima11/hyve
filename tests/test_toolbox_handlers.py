"""Regression: toolbox handler package must expose _exec_* symbols for executor."""

import re
from pathlib import Path

from brain.toolbox import handlers


def test_handlers_package_exports_all_executor_symbols():
    executor_src = (Path(__file__).resolve().parents[1] / "brain/toolbox/executor.py").read_text()
    names = sorted(set(re.findall(r"_handlers\.(_exec_\w+)", executor_src)))
    missing = [name for name in names if not hasattr(handlers, name)]
    assert not missing, f"handlers package missing: {missing}"
