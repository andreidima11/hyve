"""AI context formatters for integration entity payloads.

Kept separate from ``main.py`` so routers and the entity store can import
them without circular dependencies.
"""

from __future__ import annotations

from typing import Any


def format_pago_context(entities: dict[str, Any]) -> str:
    """Format Pago entity data into a concise AI-readable block."""
    parts: list[str] = []

    profil = entities.get("profil")
    if isinstance(profil, dict) and not profil.get("error"):
        name = f"{profil.get('nume') or ''} {profil.get('prenume') or ''}".strip()
        if name:
            parts.append(f"Titular: {name}")

    abon = entities.get("abonament")
    if isinstance(abon, dict) and not abon.get("error"):
        status = "activ" if abon.get("activ") else "inactiv"
        ramase = abon.get("plati_ramase")
        if ramase is not None:
            parts.append(f"Abonament: {status}, {ramase} plăți rămase")

    vehicule = entities.get("vehicule")
    if isinstance(vehicule, list) and vehicule:
        cars = []
        for v in vehicule[:6]:
            plate = v.get("nr_inmatriculare") or ""
            if not plate:
                continue
            alerte = v.get("alerte") or {}
            tags = []
            rca = alerte.get("rca_expira")
            if rca:
                tags.append(f"RCA {rca[:10]}")
            itp = alerte.get("itp_expira")
            if itp:
                tags.append(f"ITP {itp[:10]}")
            label = plate
            if tags:
                label += f" ({', '.join(tags)})"
            cars.append(label)
        if cars:
            parts.append("Vehicule: " + "; ".join(cars))

    facturi = entities.get("facturi")
    if isinstance(facturi, list) and facturi:
        total = sum((f.get("suma_datorata") or 0) for f in facturi)
        items = []
        for f in facturi[:8]:
            amount = f.get("suma_datorata")
            scadenta = f.get("scadenta") or ""
            desc = f"{amount:.2f} RON" if amount else "?"
            if scadenta:
                desc += f" (scadentă {scadenta})"
            items.append(desc)
        parts.append(f"Facturi ({len(facturi)}, total {total:.2f} RON): " + "; ".join(items))

    conturi = entities.get("conturi_facturi")
    if isinstance(conturi, list) and conturi:
        items = []
        for c in conturi[:10]:
            fname = c.get("furnizor_nume") or c.get("furnizor") or "?"
            loc = c.get("locatie") or ""
            suma = c.get("ultima_plata_suma")
            desc = fname
            if loc:
                desc += f" ({loc})"
            if suma is not None:
                desc += f" ultima plată {suma:.2f} RON"
            items.append(desc)
        parts.append("Conturi furnizori: " + "; ".join(items))

    carduri = entities.get("carduri")
    if isinstance(carduri, list) and carduri:
        cards = []
        for c in carduri[:6]:
            last4 = c.get("last4") or ""
            ctype = c.get("tip_card") or ""
            alias = c.get("alias") or ""
            if last4:
                label = f"****{last4}"
                if ctype:
                    label += f" {ctype}"
                if alias:
                    label += f" ({alias})"
                if c.get("default"):
                    label += " [Default]"
                cards.append(label)
        if cards:
            parts.append("Carduri: " + "; ".join(cards))

    plati = entities.get("plati")
    if isinstance(plati, list) and plati:
        recent = []
        for p in plati[:8]:
            fname = p.get("furnizor_nume") or ""
            amount = p.get("suma") or p.get("suma_platita") or ""
            date = p.get("data") or ""
            tip = p.get("tip") or ""
            desc = fname or tip or "?"
            if amount:
                desc += f" {amount} RON"
            if date:
                desc += f" ({date[:10]})"
            recent.append(desc)
        if recent:
            parts.append("Plăți recente: " + "; ".join(recent))

    if not parts:
        return ""
    return "[Pago Plătește]\n" + "\n".join(parts)


def format_fusion_solar_context(entities: dict[str, Any]) -> str:
    """Format FusionSolar entity data into a concise AI-readable block."""
    summary = entities.get("summary") or {}
    realtime = entities.get("realtime") or []
    yearly_current = entities.get("yearly_current") or {}
    devices = entities.get("devices") or []
    parts: list[str] = []

    if isinstance(summary, dict) and summary:
        power = summary.get("realtime_power_kw")
        daily = summary.get("daily_energy_kwh")
        month = summary.get("month_energy_kwh")
        lifetime = summary.get("lifetime_energy_kwh")
        if power is not None:
            parts.append(f"Putere live: {float(power):.2f} kW")
        if daily is not None:
            parts.append(f"Producție azi: {float(daily):.2f} kWh")
        if month is not None:
            parts.append(f"Producție lună: {float(month):.2f} kWh")
        if lifetime is not None:
            parts.append(f"Total viață: {float(lifetime):.2f} kWh")

    if isinstance(realtime, list) and realtime:
        stations = []
        for station in realtime[:5]:
            if not isinstance(station, dict):
                continue
            name = station.get("station_name") or station.get("station_code") or "Stație"
            power = station.get("realtime_power_kw")
            daily = station.get("daily_energy_kwh")
            label = str(name)
            if power is not None:
                label += f" {float(power):.2f} kW"
            if daily is not None:
                label += f", azi {float(daily):.2f} kWh"
            stations.append(label)
        if stations:
            parts.append("Stații: " + "; ".join(stations))

    if isinstance(yearly_current, dict) and yearly_current:
        for code, kpi in list(yearly_current.items())[:3]:
            yparts = []
            if kpi.get("inverter_power") is not None:
                yparts.append(f"producție {float(kpi['inverter_power']):.1f} kWh")
            if kpi.get("ongrid_power") is not None:
                yparts.append(f"injectat {float(kpi['ongrid_power']):.1f} kWh")
            if kpi.get("use_power") is not None:
                yparts.append(f"consum {float(kpi['use_power']):.1f} kWh")
            if yparts:
                parts.append(f"KPI an curent {code}: " + ", ".join(yparts))

    if isinstance(devices, list) and devices:
        dev_summary = []
        for dev in devices[:10]:
            if not isinstance(dev, dict):
                continue
            dev_summary.append(f"{dev.get('device_name', '?')} ({dev.get('device_type', '?')})")
        if dev_summary:
            parts.append(f"Dispozitive ({len(devices)}): " + ", ".join(dev_summary))

    if not parts:
        return ""
    return "[FusionSolar]\n" + "\n".join(parts)
