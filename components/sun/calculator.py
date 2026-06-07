"""NOAA solar position helpers for the Sun integration."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone


def julian_day(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    a = (14 - dt.month) // 12
    y = dt.year + 4800 - a
    m = dt.month + 12 * a - 3
    jdn = dt.day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    frac = (dt.hour - 12) / 24 + dt.minute / 1440 + dt.second / 86400
    return jdn + frac


def solar_position(dt: datetime, lat: float, lon: float) -> tuple[float, float]:
    """Return (elevation_deg, azimuth_deg) at ``dt`` for ``lat``/``lon``."""
    jd = julian_day(dt)
    n = jd - 2451545.0
    L = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    lst = math.radians((gmst * 15 + lon) % 360)
    h = lst - ra
    lat_r = math.radians(lat)
    sin_alt = math.sin(lat_r) * math.sin(dec) + math.cos(lat_r) * math.cos(dec) * math.cos(h)
    elevation = math.degrees(math.asin(max(-1.0, min(1.0, sin_alt))))
    cos_az = (math.sin(dec) - math.sin(lat_r) * math.sin(math.radians(elevation))) / (
        math.cos(lat_r) * math.cos(math.radians(elevation)) or 1e-9
    )
    az = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
    if math.sin(h) > 0:
        az = 360 - az
    return elevation, az


def find_next_event(
    start: datetime,
    lat: float,
    lon: float,
    target_alt: float,
    *,
    rising: bool,
) -> datetime | None:
    step = timedelta(minutes=5)
    prev_dt = start
    prev_alt, _ = solar_position(prev_dt, lat, lon)
    for _ in range(int(36 * 60 / 5)):
        cur_dt = prev_dt + step
        cur_alt, _ = solar_position(cur_dt, lat, lon)
        crossed = (prev_alt < target_alt <= cur_alt) if rising else (prev_alt >= target_alt > cur_alt)
        if crossed:
            frac = (target_alt - prev_alt) / (cur_alt - prev_alt) if cur_alt != prev_alt else 0.5
            return prev_dt + step * frac
        prev_dt, prev_alt = cur_dt, cur_alt
    return None


def find_next_extremum(start: datetime, lat: float, lon: float, *, maximum: bool) -> datetime | None:
    coarse_step = timedelta(minutes=5)
    samples: list[tuple[datetime, float]] = []
    cur = start
    for _ in range(int(30 * 60 / 5) + 1):
        alt, _az = solar_position(cur, lat, lon)
        samples.append((cur, alt))
        cur += coarse_step
    best_idx = None
    for i in range(1, len(samples) - 1):
        prev_a, cur_a, next_a = samples[i - 1][1], samples[i][1], samples[i + 1][1]
        if maximum and cur_a >= prev_a and cur_a >= next_a:
            best_idx = i
            break
        if not maximum and cur_a <= prev_a and cur_a <= next_a:
            best_idx = i
            break
    if best_idx is None:
        return None
    base = samples[best_idx][0]
    fine_start = base - timedelta(minutes=5)
    best_dt = base
    best_alt = samples[best_idx][1]
    fine_step = timedelta(seconds=10)
    fine_cur = fine_start
    for _ in range(60):
        alt, _az = solar_position(fine_cur, lat, lon)
        if (maximum and alt > best_alt) or (not maximum and alt < best_alt):
            best_alt = alt
            best_dt = fine_cur
        fine_cur += fine_step
    return best_dt


# Legacy names used by automations and older imports
_julian_day = julian_day
_solar_position = solar_position
_find_next_event = find_next_event
_find_next_extremum = find_next_extremum
