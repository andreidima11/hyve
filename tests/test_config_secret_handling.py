import copy

from routers import config_profiles


def test_merge_masked_secrets_preserves_existing_values():
    existing = {
        "pago": {"password": "real-pago-pass"},
        "llm": {"api_key": "real-llm-key"},
    }
    incoming = {
        "pago": {"password": "••••••"},
        "llm": {"api_key": "••••••"},
    }

    merged = copy.deepcopy(incoming)
    config_profiles._merge_masked_secrets(merged, existing)

    assert merged["pago"]["password"] == "real-pago-pass"
    assert merged["llm"]["api_key"] == "real-llm-key"


def test_is_masked_secret_detects_placeholders():
    assert config_profiles._is_masked_secret("••••••") is True
    assert config_profiles._is_masked_secret("******") is True
    assert config_profiles._is_masked_secret("real-secret") is False
