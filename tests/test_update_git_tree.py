"""Runtime vs. source git path classification for self-update."""

from __future__ import annotations

from core.update_git_tree import is_forbidden_tracked_path, is_safe_runtime_dirty_path


def test_safe_runtime_dirty_paths():
    assert is_safe_runtime_dirty_path("static/dist/app.js")
    assert is_safe_runtime_dirty_path("static/hyveview/elements/mammotion_camera.js.map")
    assert is_safe_runtime_dirty_path("static/js/app.js")
    assert is_safe_runtime_dirty_path("static/css/tailwind.built.css")
    assert is_safe_runtime_dirty_path("static/css/themes/canvas.css")
    assert is_safe_runtime_dirty_path("package-lock.json")
    assert is_safe_runtime_dirty_path("package.json")
    assert is_safe_runtime_dirty_path("core/settings.py")
    assert is_safe_runtime_dirty_path("custom_components/demo_sensor/__pycache__/entity.cpython-313.pyc")
    assert is_safe_runtime_dirty_path(".pytest_cache/v/cache/nodeids")
    assert not is_safe_runtime_dirty_path("custom_components/demo_sensor/entity.py")


def test_forbidden_tracked_paths():
    assert is_forbidden_tracked_path("custom_components/demo_sensor/__pycache__/entity.cpython-313.pyc")
    assert is_forbidden_tracked_path("static/dist/app.js")
    assert not is_forbidden_tracked_path("static/js/lang/index.js")
    assert not is_forbidden_tracked_path("static/css/tailwind.built.css")
