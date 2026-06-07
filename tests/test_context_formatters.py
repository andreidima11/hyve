"""Tests for integration context formatters and loader bootstrap."""

from integrations.context_formatters import format_fusion_solar_context, format_pago_context


def test_format_pago_context_empty():
    assert format_pago_context({}) == ""


def test_format_pago_context_profile():
    text = format_pago_context({"profil": {"nume": "Ion", "prenume": "Pop"}})
    assert "Titular: Ion Pop" in text
    assert text.startswith("[Pago")


def test_format_fusion_solar_context_summary():
    text = format_fusion_solar_context({"summary": {"realtime_power_kw": 1.5}})
    assert "1.50 kW" in text
    assert text.startswith("[FusionSolar")
