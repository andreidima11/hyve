"""Embedding / HuggingFace hub configuration for semantic memory."""

from __future__ import annotations

import core.storage as storage


def test_storage_does_not_force_hf_offline_at_import():
    assert storage.os.environ.get("HF_HUB_OFFLINE") != "1"


def test_hf_hub_offline_respects_librarian_config(monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.setitem(storage.CFG, "librarian", {"offline_only": True})
    assert storage._hf_hub_offline_requested() is True


def test_hf_hub_offline_respects_env(monkeypatch):
    monkeypatch.setitem(storage.CFG, "librarian", {"offline_only": False})
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    assert storage._hf_hub_offline_requested() is True


def test_set_hf_hub_online_clears_offline_flags(monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")
    storage._set_hf_hub_online(allow_download=True)
    assert "HF_HUB_OFFLINE" not in storage.os.environ
    assert "TRANSFORMERS_OFFLINE" not in storage.os.environ


def test_set_hf_hub_offline_sets_flags(monkeypatch):
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
    storage._set_hf_hub_online(allow_download=False)
    assert storage.os.environ.get("HF_HUB_OFFLINE") == "1"
    assert storage.os.environ.get("TRANSFORMERS_OFFLINE") == "1"


def test_collection_health_marks_fallback_as_degraded(monkeypatch):
    monkeypatch.setattr(storage, "_is_fallback_embedding", lambda: True)
    monkeypatch.setattr(storage, "_loaded_model_name", "fallback_embedding")
    monkeypatch.setattr(storage, "_last_embedding_error", "cache miss")
    health = storage.get_collection_health()
    assert health["status"] == "degraded"
    assert health["mode"] == "fallback"
    assert health["last_error"] == "cache miss"
