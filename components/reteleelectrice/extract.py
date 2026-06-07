from __future__ import annotations

import re
from typing import Any

from integrations.entity_utils import finalize_entities as _finalize

def _re_slug(pod_name):
    return re.sub(r"[^a-z0-9]+", "_", str(pod_name or "").lower()).strip("_") or "pod"


def _re_safe_float(value):
    """Parse numeric value; accept ',' or '.'; treat -9999/empty as None."""
    if value in (None, "", "null", "-9999", -9999):
        return None
    try:
        if isinstance(value, str):
            v = value.strip().replace(",", ".")
            if not v or v == "-9999":
                return None
            return float(v)
        return float(value)
    except (TypeError, ValueError):
        return None


def _re_html_unescape(text):
    if not text:
        return ""
    try:
        import html as _html
        return _html.unescape(str(text))
    except Exception:
        return str(text)


def _re_normalize_title(value):
    """Title-case a Romanian string while preserving short connectors."""
    if not value:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    small = {"de", "la", "cu", "si", "și", "din", "pe", "sub", "in", "în", "a", "al", "ale"}
    parts = re.split(r"(\s+)", s.lower())
    out = []
    for idx, p in enumerate(parts):
        if not p.strip():
            out.append(p)
            continue
        if idx > 0 and p in small:
            out.append(p)
        else:
            out.append(p[:1].upper() + p[1:])
    return "".join(out)


def _re_format_date_ro(value):
    """Convert ISO 'YYYY-MM-DD' or 'DD.MM.YYYY' into '1 ianuarie 2026' (RO)."""
    if not value:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})", s)
        if not m:
            return s
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= mo <= 12):
        return s
    return f"{d} {_RE_MONTHS_RO[mo - 1]} {y}"


def _re_year_from_measure_date(value):
    if not value:
        return None
    s = str(value).strip()
    m = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})", s)
    if m:
        return int(m.group(3))
    m = re.match(r"^(\d{4})-", s)
    if m:
        return int(m.group(1))
    return None


def _re_meter_value(meter_list, energy_type):
    if not isinstance(meter_list, list):
        return None
    target = str(energy_type or "").upper()
    for m in meter_list:
        if not isinstance(m, dict):
            continue
        et = str(m.get("typeofenergy_measured") or m.get("energyType") or "").upper()
        if et == target:
            return _re_safe_float(m.get("Value") or m.get("value"))
    return None


def _re_outage_state(outages):
    """Decode the PED checkInterruzione payload as a binary state.

    Returns ``(state, attrs)`` where ``state`` is ``"on"`` when an outage is
    active, ``"off"`` when none is reported, or ``"unknown"`` otherwise.
    The original human-readable label is preserved in ``attrs["Stare"]``.
    """
    if not isinstance(outages, dict):
        return ("unknown", {"Stare": "Fără date"})
    data_obj = outages.get("data") if isinstance(outages.get("data"), dict) else None
    if data_obj is not None:
        check = str(data_obj.get("checkInterruzione") or "").strip().lower()
        if check == "true":
            state = "off"
            label = "Fără întreruperi"
        elif check == "false":
            state = "on"
            label = "Întrerupere activă"
        else:
            state = "unknown"
            label = str(outages.get("esito") or data_obj.get("esito") or "Necunoscut")
        attrs = {"Stare": label}
        msg = _re_html_unescape(str(data_obj.get("messaggio") or "").strip())
        if msg:
            attrs["Mesaj"] = msg
        if data_obj.get("checkInterruzione") is not None:
            attrs["Verificare întreruperi"] = data_obj.get("checkInterruzione")
        if data_obj.get("esito") is not None:
            attrs["Rezultat"] = data_obj.get("esito")
        return state, attrs
    esito = str(outages.get("esito") or outages.get("Result") or "").strip()
    return ("unknown", {"Stare": esito or "Necunoscut"})


def _re_pod_address(pod):
    direct = str(pod.get("POD_Address__c") or "").strip()
    if direct:
        return direct
    parts = []
    street = str(pod.get("Description_Street__c") or "").strip()
    house = str(pod.get("House_Number__c") or "").strip()
    apt = str(pod.get("Apartment__c") or "").strip()
    city = str(pod.get("City__c") or "").strip()
    county = str(pod.get("County__c") or "").strip()
    if street:
        line = street
        if house:
            line += f" nr. {house}"
        if apt:
            line += f", ap. {apt}"
        parts.append(line)
    if city:
        parts.append(city)
    if county:
        parts.append(f"jud. {county}")
    return ", ".join(parts)


def _re_filter_year(readings, year):
    out = []
    for r in readings:
        if _re_year_from_measure_date(r.get("measureDate")) == year:
            out.append(r)
    return out


def _re_extract_years(readings):
    years = set()
    for r in readings:
        y = _re_year_from_measure_date(r.get("measureDate"))
        if y is not None:
            years.add(y)
    return sorted(years, reverse=True)[:2]


def extract_reteleelectrice_candidates(payload):
    """Convert a Rețele Electrice snapshot into Hyve entity dicts.

    Mirrors the cnecrea/reteleelectrice Home Assistant integration entity-by-
    entity (sensor.py), including conditional creation for prosumer- and
    smart-meter-only sensors and matching attribute names.
    """
    items = []
    if not isinstance(payload, dict):
        return items
    pods = payload.get("pods") or []
    if not isinstance(pods, list):
        return items

    account = payload.get("account") if isinstance(payload.get("account"), dict) else {}
    contact = payload.get("contact") if isinstance(payload.get("contact"), dict) else {}
    user_name = _re_normalize_title(
        str(payload.get("user_name") or account.get("Name") or "Necunoscut").strip()
    )

    def _push(eid_suffix, *, name, state, pod_name, domain="sensor",
              unit="", attributes=None, controllable=False):
        eid = f"reteleelectrice:{_re_slug(pod_name)}:{eid_suffix}"
        attrs = {k: v for k, v in (attributes or {}).items() if v not in (None, "", [])}
        items.append({
            "entity_id": eid,
            "name": name,
            "state": "" if state is None else str(state),
            "domain": domain,
            "source": "reteleelectrice",
            "aliases": [],
            "unit": unit,
            "controllable": controllable,
            "attributes": attrs,
        })

    for pod in pods:
        if not isinstance(pod, dict):
            continue
        pod_name = str(pod.get("name") or "").strip()
        if not pod_name:
            continue
        raw = pod.get("raw") if isinstance(pod.get("raw"), dict) else {}

        contract_type = str(raw.get("Contract_Type__c") or "").strip()
        is_prosumer = bool(raw.get("isProductor__c")) or contract_type.upper() == "PROSUMER"
        is_smart = bool(raw.get("Smart_meter__c") or raw.get("IsSmartMeter__c"))
        address = _re_pod_address(raw)
        distribution = ""
        dr = raw.get("DistributionCompany__r")
        if isinstance(dr, dict):
            distribution = _re_normalize_title(str(dr.get("Name") or "").strip())

        prefix_label = f"{pod_name} — "

        # ── 1. Informații POD ───────────────────────────────────────
        pod_state = _re_normalize_title(contract_type or "Necunoscut")
        _push(
            "informatii_pod",
            name=f"{prefix_label}POD",
            state=pod_state,
            pod_name=pod_name,
            attributes={
                "POD": pod_name,
                "Adresă": address,
                "Tip contract": _re_normalize_title(contract_type),
                "Stare contract": _re_normalize_title(raw.get("Contract_State__c") or ""),
                "Tip consumator": _re_normalize_title(raw.get("Consumer_Type_Account__c") or ""),
                "Piață": _re_normalize_title(raw.get("Market_Type__c") or ""),
                "Putere absorbită (kW)": raw.get("Absorbed_Power_KW__c") or "",
                "Putere absorbită (kVA)": raw.get("Absorbed_Power_KVA__c") or "",
                "Putere cedată (kW)": raw.get("Released_Power_KW__c") or "",
                "Putere cedată (kVA)": raw.get("Released_Power_KVA__c") or "",
                "Nivel tensiune": raw.get("Voltage_Level__c") or "",
                "Tensiune nominală (kV)": raw.get("Nominal_Voltage_kV__c") or "",
                "Serie contor": raw.get("EA_METER_SERIE__c") or "",
                "Tip contor": raw.get("EA_METER_TYPE__c") or "",
                "Smart meter": is_smart,
                "Prosumer": is_prosumer,
                "Tarif": raw.get("TARIFF__c") or "",
                "Profil consum": raw.get("ConsumptionProfile__c") or "",
                "Constantă contor": raw.get("EA_CONSTANT__c") or "",
                "Precizie": raw.get("EA_PRECISION__c") or "",
                "Unitate operativă": raw.get("Operative_Unit__c") or "",
                "Zonă": raw.get("Zone_Cod__c") or "",
                "Cod CFT": raw.get("CFT_Code__c") or "",
                "ATR": raw.get("ATR__c") or "",
                "Perioadă măsurare": raw.get("MeasurementPeriod__c") or "",
                "Dată start contract": raw.get("ContractStartDate__c") or "",
                "Distribuitor": distribution,
            },
        )

        # ── 2. Informații cont (Date utilizator) ────────────────────
        cont_attrs = {
            "Nume": _re_normalize_title(account.get("Name") or ""),
            "Email": account.get("Email__c") or contact.get("Email") or "",
            "Telefon": account.get("Mobile_Phone__c") or contact.get("MobilePhone") or "",
            "CNP": account.get("CNP__c") or "",
            "Cod fiscal": account.get("Fiscal_Code__c") or "",
            "Adresă": _re_normalize_title(account.get("Address__c") or ""),
            "Oraș": _re_normalize_title(account.get("City__c") or ""),
            "Județ": _re_normalize_title(account.get("County__c") or ""),
            "Cod poștal": account.get("ZIP_COD__c") or "",
        }
        rt = account.get("RecordType")
        if isinstance(rt, dict):
            cont_attrs["Tip cont"] = _re_normalize_title(rt.get("Name") or "")
        _push(
            "informatii_cont",
            name=f"{prefix_label}Date utilizator",
            state=user_name,
            pod_name=pod_name,
            attributes=cont_attrs,
        )

        # ── 3. Întreruperi curent ───────────────────────────────────
        outage_state, outage_attrs = _re_outage_state(pod.get("outages"))
        outage_attrs = {"POD": pod_name, **outage_attrs}
        _push(
            "intreruperi_curent",
            name=f"{prefix_label}Întreruperi curent",
            state=outage_state,
            pod_name=pod_name,
            domain="binary_sensor",
            attributes=outage_attrs,
        )

        # ── Reading archive (used by 4–7) ───────────────────────────
        archive = pod.get("readings")
        readings = []
        if isinstance(archive, dict):
            raw_list = archive.get("XML_Readings")
            if isinstance(raw_list, list):
                readings = [r for r in raw_list if isinstance(r, dict)]
        elif isinstance(archive, list):
            readings = [r for r in archive if isinstance(r, dict)]

        latest = readings[0] if readings else None
        prev = readings[1] if len(readings) >= 2 else None

        # ── 4. Index citire consum (mereu) ──────────────────────────
        ea_latest = _re_meter_value(latest.get("meter") if latest else None, "EA")
        ic_attrs = {}
        if latest:
            ic_attrs = {
                "Data citire": _re_format_date_ro(latest.get("measureDate") or ""),
                "Tip citire": _re_normalize_title(latest.get("typeOfReading") or ""),
                "Serie contor": latest.get("SerialNumber") or "",
                "Constantă": latest.get("constanta") or "",
                "Index energie consumată (kWh)": ea_latest,
            }
            if prev is not None:
                prev_ea = _re_meter_value(prev.get("meter"), "EA")
                if ea_latest is not None and prev_ea is not None:
                    ic_attrs["Consum lunar (kWh)"] = round(ea_latest - prev_ea, 3)
                    ic_attrs["Citire anterioară"] = _re_format_date_ro(
                        prev.get("measureDate") or ""
                    )
        _push(
            "index_citire_consum",
            name=f"{prefix_label}Index citire consum",
            state="" if ea_latest is None else f"{ea_latest}",
            pod_name=pod_name,
            unit="kWh",
            attributes=ic_attrs,
        )

        # ── 5. Index citire producție (doar prosumer) ───────────────
        if is_prosumer:
            eap_latest = _re_meter_value(latest.get("meter") if latest else None, "EAP")
            ip_attrs = {}
            if latest:
                ip_attrs = {
                    "Data citire": _re_format_date_ro(latest.get("measureDate") or ""),
                    "Tip citire": _re_normalize_title(latest.get("typeOfReading") or ""),
                    "Serie contor": latest.get("SerialNumber") or "",
                    "Constantă": latest.get("constanta") or "",
                    "Index energie produsă (kWh)": eap_latest,
                }
                if prev is not None:
                    prev_eap = _re_meter_value(prev.get("meter"), "EAP")
                    if eap_latest is not None and prev_eap is not None:
                        ip_attrs["Producție lunară (kWh)"] = round(eap_latest - prev_eap, 3)
                        ip_attrs["Citire anterioară"] = _re_format_date_ro(
                            prev.get("measureDate") or ""
                        )
            _push(
                "index_citire_productie",
                name=f"{prefix_label}Index citire producție",
                state="" if eap_latest is None else f"{eap_latest}",
                pod_name=pod_name,
                unit="kWh",
                attributes=ip_attrs,
            )

        # ── 6/7. Arhivă energie consumată / produsă per an ──────────
        years = _re_extract_years(readings)
        for year in years:
            year_readings = _re_filter_year(readings, year)
            if not year_readings:
                continue

            # Consum
            first_ea = _re_meter_value(year_readings[-1].get("meter"), "EA")
            last_ea = _re_meter_value(year_readings[0].get("meter"), "EA")
            if first_ea is not None and last_ea is not None and len(year_readings) > 1:
                state_consum = f"{round(last_ea - first_ea, 3)} kWh"
            elif last_ea is not None:
                state_consum = f"{last_ea} kWh"
            else:
                state_consum = "Fără date"
            consum_attrs = {}
            for r in year_readings:
                label = _re_format_date_ro(r.get("measureDate") or "")
                ea_v = _re_meter_value(r.get("meter"), "EA")
                consum_attrs[label] = f"{ea_v} kWh" if ea_v is not None else "fără date"
            consum_attrs["Total citiri"] = len(year_readings)
            consum_attrs["Serie contor"] = year_readings[0].get("SerialNumber") or ""
            _push(
                f"arhiva_energie_consumata_{year}",
                name=f"{prefix_label}{year} → Energie consumată",
                state=state_consum,
                pod_name=pod_name,
                attributes=consum_attrs,
            )

            # Producție (doar prosumer)
            if is_prosumer:
                first_eap = _re_meter_value(year_readings[-1].get("meter"), "EAP")
                last_eap = _re_meter_value(year_readings[0].get("meter"), "EAP")
                if (first_eap is not None and last_eap is not None
                        and len(year_readings) > 1):
                    state_prod = f"{round(last_eap - first_eap, 3)} kWh"
                elif last_eap is not None:
                    state_prod = f"{last_eap} kWh"
                else:
                    state_prod = "Fără date"
                prod_attrs = {}
                for r in year_readings:
                    label = _re_format_date_ro(r.get("measureDate") or "")
                    eap_v = _re_meter_value(r.get("meter"), "EAP")
                    prod_attrs[label] = f"{eap_v} kWh" if eap_v is not None else "fără date"
                prod_attrs["Total citiri"] = len(year_readings)
                prod_attrs["Serie contor"] = year_readings[0].get("SerialNumber") or ""
                _push(
                    f"arhiva_energie_produsa_{year}",
                    name=f"{prefix_label}{year} → Energie produsă",
                    state=state_prod,
                    pod_name=pod_name,
                    attributes=prod_attrs,
                )

        # ── 8. Date furnizor ────────────────────────────────────────
        supplier = pod.get("supplier") if isinstance(pod.get("supplier"), dict) else None
        if supplier:
            attrs = {}
            if supplier.get("furnizor"):
                attrs["Furnizor"] = supplier["furnizor"]
            if supplier.get("furnizor_pre"):
                attrs["PRE (Operator distribuție)"] = supplier["furnizor_pre"]
            cui = supplier.get("cui") or ""
            if cui:
                attrs["CUI furnizor"] = cui
            if supplier.get("nume_client"):
                attrs["Nume client"] = supplier["nume_client"]
            if supplier.get("adresa_client"):
                attrs["Adresă client"] = supplier["adresa_client"]
            if supplier.get("adresa_locons"):
                attrs["Adresă loc de consum"] = supplier["adresa_locons"]
            if supplier.get("kw_aprobata"):
                attrs["Putere aprobată (kW)"] = supplier["kw_aprobata"]
            if supplier.get("kw_evacuata"):
                attrs["Putere evacuată (kW)"] = supplier["kw_evacuata"]
            if supplier.get("delimitare"):
                attrs["Punct delimitare"] = supplier["delimitare"]
            if supplier.get("u_delimitare"):
                attrs["Tensiune punct delimitare"] = supplier["u_delimitare"]
            racordare = supplier.get("racordare")
            if racordare and str(racordare).strip() not in ("", "-"):
                attrs["Punct de racordare"] = racordare
            activ = supplier.get("activ")
            if activ:
                attrs["Stare"] = "Activ" if str(activ).upper() == "D" else "Inactiv"
            deconectat = supplier.get("deconectat")
            if deconectat:
                attrs["Deconectat"] = "Da" if str(deconectat).upper() == "D" else "Nu"
            if supplier.get("activ_furnizor_la"):
                attrs["Activ furnizor de la"] = _re_format_date_ro(supplier["activ_furnizor_la"])
            if supplier.get("activ_consumator_la"):
                attrs["Activ consumator de la"] = _re_format_date_ro(supplier["activ_consumator_la"])
            atr_number = supplier.get("atr_number")
            atr_date = supplier.get("atr_date")
            if atr_number:
                atr_str = str(atr_number)
                if atr_date:
                    atr_str += f" / {_re_format_date_ro(atr_date)}"
                attrs["Nr. și data ATR/CER"] = atr_str
            cer_version = supplier.get("cer_version")
            cer_date = supplier.get("cer_date")
            if cer_version:
                cer_str = f"v{cer_version}"
                if cer_date:
                    cer_str += f" / {_re_format_date_ro(cer_date)}"
                attrs["Versiune CER"] = cer_str
            telecitit = supplier.get("telecitit")
            if telecitit:
                attrs["Telecitire"] = "Da" if str(telecitit).upper() == "D" else "Nu"
            contoare = supplier.get("Contor")
            if isinstance(contoare, list) and contoare and isinstance(contoare[0], dict):
                c = contoare[0]
                if c.get("seria"):
                    attrs["Seria contorului"] = c["seria"]
                if c.get("marca"):
                    attrs["Marca contor"] = c["marca"]
                if c.get("det_tip"):
                    attrs["Tip contor"] = c["det_tip"]
                if c.get("data_montare"):
                    attrs["Data montare"] = _re_format_date_ro(c["data_montare"])
                if c.get("precizie"):
                    attrs["Precizie"] = c["precizie"]
                if c.get("constanta"):
                    attrs["Constantă"] = c["constanta"]
            if supplier.get("cft_description"):
                attrs["Zonă distribuție"] = supplier["cft_description"]
            if supplier.get("cft_ou_description"):
                attrs["Unitate operațională"] = supplier["cft_ou_description"]
            if supplier.get("cft_district_uo"):
                attrs["Județ distribuție"] = supplier["cft_district_uo"]
            if supplier.get("aggregation_formula"):
                attrs["Formula agregare"] = supplier["aggregation_formula"]
            if supplier.get("compensation_mode"):
                attrs["Mod compensare"] = supplier["compensation_mode"]
            corectii = supplier.get("corectii")
            if corectii and str(corectii).strip() not in ("", "-"):
                attrs["Corecții"] = corectii
            _push(
                "date_furnizor",
                name=f"{prefix_label}Date furnizor",
                state=cui,
                pod_name=pod_name,
                attributes=attrs,
            )

        # ── 9/10. Smart meter (doar smart) ──────────────────────────
        sm = pod.get("smart_meter") if isinstance(pod.get("smart_meter"), dict) else None
        sm_row = None
        if is_smart and sm and str(sm.get("Result") or "OK").upper() == "OK":
            row_list = sm.get("row")
            if isinstance(row_list, list) and row_list and isinstance(row_list[0], dict):
                sm_row = row_list[0]

        if is_smart:
            sum_ea = _re_safe_float(sm_row.get("SUM_EA")) if sm_row else None
            sm_consum_attrs = {}
            if sm_row:
                sm_consum_attrs = {
                    "POD": sm_row.get("POD") or pod_name,
                    "Contor": sm_row.get("METER") or "",
                    "Perioadă start": sm_row.get("START_DATE") or "",
                    "Perioadă sfârșit": sm_row.get("END_DATE") or "",
                    "Total energie consumată (kWh)": sum_ea,
                    "Vârf consum (kWh)": _re_safe_float(sm_row.get("MAX_EA")),
                }
                if sm_row.get("SUM_ER"):
                    sm_consum_attrs["Total energie reactivă (kVArh)"] = _re_safe_float(sm_row["SUM_ER"])
                if sm_row.get("MAX_ER"):
                    sm_consum_attrs["Vârf energie reactivă (kVArh)"] = _re_safe_float(sm_row["MAX_ER"])
                cosfi = sm_row.get("COSFI")
                if cosfi and str(cosfi) != "-9999":
                    sm_consum_attrs["Factor de putere (cosφ)"] = _re_safe_float(cosfi)
                sm_consum_attrs["Rezultat"] = sm.get("Result") or ""
            _push(
                "smart_meter_consum",
                name=f"{prefix_label}Smart Meter Consum",
                state="" if sum_ea is None else f"{sum_ea}",
                pod_name=pod_name,
                unit="kWh",
                attributes=sm_consum_attrs,
            )

            if is_prosumer:
                sum_eap = _re_safe_float(sm_row.get("SUM_EAP")) if sm_row else None
                sm_prod_attrs = {}
                if sm_row:
                    sm_prod_attrs = {
                        "POD": sm_row.get("POD") or pod_name,
                        "Contor": sm_row.get("METER") or "",
                        "Perioadă start": sm_row.get("START_DATE") or "",
                        "Perioadă sfârșit": sm_row.get("END_DATE") or "",
                        "Total energie produsă (kWh)": sum_eap,
                        "Vârf producție (kWh)": _re_safe_float(sm_row.get("MAX_EAP")),
                    }
                    if sm_row.get("SUM_ERC"):
                        sm_prod_attrs["Total energie reactivă capacitivă (kVArh)"] = _re_safe_float(sm_row["SUM_ERC"])
                    if sm_row.get("MAX_ERC"):
                        sm_prod_attrs["Vârf energie reactivă capacitivă (kVArh)"] = _re_safe_float(sm_row["MAX_ERC"])
                    cosfic = sm_row.get("COSFIC")
                    if cosfic and str(cosfic) != "-9999":
                        sm_prod_attrs["Factor de putere capacitiv"] = _re_safe_float(cosfic)
                    sm_prod_attrs["Rezultat"] = sm.get("Result") or ""
                _push(
                    "smart_meter_productie",
                    name=f"{prefix_label}Smart Meter Producție",
                    state="" if sum_eap is None else f"{sum_eap}",
                    pod_name=pod_name,
                    unit="kWh",
                    attributes=sm_prod_attrs,
                )

        # ── 11/12. Valoare instantanee (doar smart) ─────────────────
        instant = pod.get("instant") if isinstance(pod.get("instant"), dict) else None
        first_iv = None
        if is_smart and instant:
            value_list = instant.get("dataIstantValueList")
            if isinstance(value_list, list) and value_list and isinstance(value_list[0], dict):
                first_iv = value_list[0]

        def _instant_energy(code):
            if not first_iv:
                return None
            for er in first_iv.get("energyReadingList") or []:
                if isinstance(er, dict) and str(er.get("ENERGY_TYPE") or "").upper() == code:
                    return _re_safe_float(er.get("VALUE"))
            return None

        if is_smart:
            ea_inst = _instant_energy("EA")
            inst_consum_attrs = {}
            if first_iv:
                for phase, key in (("R", "UR_VALUE"), ("S", "US_VALUE"), ("T", "UT_VALUE")):
                    v = _re_safe_float(first_iv.get(key))
                    if v is not None:
                        inst_consum_attrs[f"Tensiune faza {phase} (V)"] = v
                for phase, key in (("R", "IR_VALUE"), ("S", "IS_VALUE"), ("T", "IT_VALUE")):
                    v = _re_safe_float(first_iv.get(key))
                    if v is not None:
                        inst_consum_attrs[f"Curent faza {phase} (A)"] = v
                p_val = _re_safe_float(first_iv.get("P_VALUE"))
                if p_val is not None:
                    inst_consum_attrs["Putere activă instantanee (kW)"] = p_val
                er_val = _instant_energy("ER")
                if er_val is not None:
                    inst_consum_attrs["Energie reactivă (kVArh)"] = er_val
                if first_iv.get("READING_DATE"):
                    inst_consum_attrs["Data citire"] = first_iv["READING_DATE"]
                if first_iv.get("LAST_UPDATED"):
                    inst_consum_attrs["Ultima actualizare"] = first_iv["LAST_UPDATED"]
                if first_iv.get("METER"):
                    inst_consum_attrs["Contor"] = first_iv["METER"]
                if instant and instant.get("Result"):
                    inst_consum_attrs["Rezultat"] = instant["Result"]
            _push(
                "valoare_instantanee_consum",
                name=f"{prefix_label}Valoare instantanee consum",
                state="" if ea_inst is None else f"{ea_inst}",
                pod_name=pod_name,
                unit="kWh",
                attributes=inst_consum_attrs,
            )

            if is_prosumer:
                eap_inst = _instant_energy("EAP")
                inst_prod_attrs = {}
                if eap_inst is not None:
                    inst_prod_attrs["Energie activă produsă (kWh)"] = eap_inst
                erc_val = _instant_energy("ERC")
                if erc_val is not None:
                    inst_prod_attrs["Energie reactivă capacitivă (kVArh)"] = erc_val
                if first_iv:
                    if first_iv.get("READING_DATE"):
                        inst_prod_attrs["Data citire"] = first_iv["READING_DATE"]
                    if first_iv.get("LAST_UPDATED"):
                        inst_prod_attrs["Ultima actualizare"] = first_iv["LAST_UPDATED"]
                    if first_iv.get("METER"):
                        inst_prod_attrs["Contor"] = first_iv["METER"]
                if instant and instant.get("Result"):
                    inst_prod_attrs["Rezultat"] = instant["Result"]
                _push(
                    "valoare_instantanee_productie",
                    name=f"{prefix_label}Valoare instantanee producție",
                    state="" if eap_inst is None else f"{eap_inst}",
                    pod_name=pod_name,
                    unit="kWh",
                    attributes=inst_prod_attrs,
                )

    return _finalize(items, default_source="reteleelectrice")
