"""Home bubble source mode for the Fusion Solar power-flow diagram."""

TH = 0.04


def compute_home_source(solar_to_home, grid_import, load):
    """Mirror of computeHomeSource() in fusion_solar/power_flow.js."""
    from_solar = (solar_to_home or 0) > TH
    from_grid = (grid_import or 0) > TH
    consuming = (load or 0) > TH
    if not consuming:
        return "idle"
    if from_solar and from_grid:
        return "mixed"
    if from_solar:
        return "solar"
    if from_grid:
        return "grid"
    return "idle"


def test_home_source_idle_when_no_load():
    assert compute_home_source(2.0, 1.0, 0.0) == "idle"


def test_home_source_solar_only():
    assert compute_home_source(1.5, 0.0, 1.2) == "solar"


def test_home_source_grid_only():
    assert compute_home_source(0.0, 0.8, 1.0) == "grid"


def test_home_source_mixed():
    assert compute_home_source(0.6, 0.5, 1.1) == "mixed"


def compute_autoconsum_pct(solar_to_home, grid_import, load):
    """Mirror of computeAutoconsumPct() in fusion_solar/power_flow.js."""
    consuming = (load or 0) > TH
    if not consuming:
        return None
    solar_part = min(load, max(0, solar_to_home or 0))
    return round(min(100, max(0, (solar_part / load) * 100)))


def test_autoconsum_solar_only():
    assert compute_autoconsum_pct(2.0, 0.0, 1.5) == 100


def test_autoconsum_grid_only():
    assert compute_autoconsum_pct(0.0, 1.0, 1.2) == 0


def test_autoconsum_mixed():
    assert compute_autoconsum_pct(0.8, 0.5, 1.6) == 50
