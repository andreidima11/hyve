from __future__ import annotations

from typing import Any

from integrations.entity_utils import finalize_entities as _finalize, slugify

def extract_eon_romania_candidates(payload: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return items

    MONTHS_RO = {
        "01": "ianuarie", "02": "februarie", "03": "martie", "04": "aprilie",
        "05": "mai", "06": "iunie", "07": "iulie", "08": "august",
        "09": "septembrie", "10": "octombrie", "11": "noiembrie", "12": "decembrie",
    }
    CONVENTION_MONTH_KEYS = [
        ("valueMonth1", "ianuarie"), ("valueMonth2", "februarie"), ("valueMonth3", "martie"),
        ("valueMonth4", "aprilie"), ("valueMonth5", "mai"), ("valueMonth6", "iunie"),
        ("valueMonth7", "iulie"), ("valueMonth8", "august"), ("valueMonth9", "septembrie"),
        ("valueMonth10", "octombrie"), ("valueMonth11", "noiembrie"), ("valueMonth12", "decembrie"),
    ]
    UTILITY_LABEL = {
        "01": "Energie electrică",
        "1": "Energie electrică",
        "02": "Gaz",
        "2": "Gaz",
        "GN": "Gaz",
        "GAS": "Gaz",
        "GAZ": "Gaz",
        "EE": "Energie electrică",
        "ELECTRICITY": "Energie electrică",
        "ELECTRICITATE": "Energie electrică",
    }

    def _as_list(value: Any) -> list[Any]:
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            for key in ("list", "items", "data", "results", "invoices"):
                nested = value.get(key)
                if isinstance(nested, list):
                    return nested
        return []

    def _first(*values: Any) -> Any:
        for value in values:
            if value is not None and value != "":
                return value
        return None

    def _scalar(value: Any) -> str:
        if value is None or isinstance(value, bool):
            return ""
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            for key in ("label", "value", "name", "localityName", "streetName", "cityName", "countyName", "code"):
                text = _scalar(value.get(key))
                if text:
                    return text
            return ""
        if isinstance(value, list):
            for item in value:
                text = _scalar(item)
                if text:
                    return text
            return ""
        return str(value).strip()

    def _num(value: Any) -> float | None:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        text = str(value).strip().replace(" ", "").replace(".", "").replace(",", ".")
        try:
            return float(text)
        except ValueError:
            return None

    def _format_number(value: Any, decimals: int = 2) -> str:
        number = _num(value)
        if number is None:
            return str(value or "").strip()
        if abs(number - int(number)) < 0.000001:
            return f"{int(number):,}".replace(",", ".")
        text = f"{number:,.{decimals}f}".replace(",", "_").replace(".", ",").replace("_", ".")
        return text.rstrip("0").rstrip(",")

    def _money(value: Any) -> str:
        number = _num(value)
        if number is None:
            return str(value or "").strip()
        text = f"{number:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")
        return f"{text} lei"

    def _unit(value: Any, fallback: str = "") -> str:
        text = str(value or fallback or "").strip()
        normalized = text.upper().replace(" ", "")
        if normalized in {"M3", "MC", "M³"}:
            return "m³"
        if normalized in {"KWH", "KW/H"}:
            return "kWh"
        if normalized == "KW":
            return "kW"
        return text

    def _utility_name(value: Any, unit: str = "") -> str:
        text = str(value or "").strip()
        label = UTILITY_LABEL.get(text.upper())
        if label:
            return label
        unit_text = _unit(unit).lower()
        if unit_text.startswith("m"):
            return "Gaz"
        if "wh" in unit_text:
            return "Energie electrică"
        return text or "Utilitate"

    def _bool_state(value: Any) -> str:
        if isinstance(value, bool):
            return "Da" if value else "Nu"
        text = str(value or "").strip().lower()
        return "Da" if text in {"1", "true", "yes", "da", "on"} else "Nu"

    def _format_address(data: Any) -> str:
        if not isinstance(data, dict):
            return ""
        street = _scalar(_first(data.get("streetName"), data.get("street"), data.get("address"), data.get("line1")))
        number = _scalar(_first(data.get("streetNumber"), data.get("number"), data.get("houseNumber")))
        city = _scalar(_first(data.get("cityName"), data.get("city"), data.get("locality"), data.get("localityName")))
        county = _scalar(_first(data.get("countyName"), data.get("county"), data.get("district")))
        parts = []
        line = " ".join(part for part in (street, number) if part)
        if line:
            parts.append(line)
        for label, key in (("bl.", "building"), ("sc.", "stair"), ("et.", "floor"), ("ap.", "apartment")):
            value = _scalar(data.get(key))
            if value:
                parts.append(f"{label} {value}")
        if city:
            parts.append(city)
        if county:
            parts.append(f"jud. {county}")
        return ", ".join(parts)

    def _safe_device_label(code: str, contract: dict[str, Any], details: dict[str, Any], summary: dict[str, Any]) -> str:
        utility = _utility_name(_first(details.get("utilityType"), summary.get("utilityType"), details.get("portfolioName"), summary.get("portfolioName")))
        tail = code[-4:] if len(code) > 4 else code
        return f"E.ON {utility} {tail}".strip()

    def _invoice_total(invoices: list[Any]) -> float:
        total = 0.0
        for invoice in invoices:
            if not isinstance(invoice, dict):
                continue
            value = _first(invoice.get("balanceValue"), invoice.get("issuedValue"), invoice.get("invoiceValue"), invoice.get("totalBalance"), invoice.get("value"))
            number = _num(value)
            if number and number > 0:
                total += number
        return total

    def _device_attrs(code: str, contract: dict[str, Any], details: dict[str, Any] | None = None) -> dict[str, Any]:
        details = details if isinstance(details, dict) else {}
        summary = contract.get("summary") if isinstance(contract.get("summary"), dict) else {}
        address = _format_address(details.get("consumptionPointAddress")) or _format_address(summary.get("consumptionPointAddress"))
        return {
            "device_id": f"eon_romania_{slugify(code)}",
            "device_name": _safe_device_label(code, contract, details, summary),
            "device_model": "E.ON Myline contract",
            "device_manufacturer": "E.ON România",
            "account_contract": code,
            "address": address,
        }

    def _add(
        code: str,
        suffix: str,
        label: str,
        state: Any,
        contract: dict[str, Any],
        *,
        domain: str = "sensor",
        unit: str = "",
        aliases: list[str] | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> None:
        details = contract.get("contract_details") if isinstance(contract.get("contract_details"), dict) else {}
        attrs = {**_device_attrs(code, contract, details), **(attributes or {})}
        items.append({
            "entity_id": f"eon_romania:{slugify(code)}:{suffix}",
            "name": f"E.ON • {label}",
            "state": str(state if state is not None and state != "" else "unavailable"),
            "domain": domain,
            "source": "eon_romania",
            "aliases": aliases or [],
            "unit": unit,
            "controllable": False,
            "device_id": attrs["device_id"],
            "device_name": attrs["device_name"],
            "device_model": attrs["device_model"],
            "device_manufacturer": attrs["device_manufacturer"],
            "attributes": attrs,
        })

    account = payload.get("account") if isinstance(payload.get("account"), dict) else {}
    user_details = account.get("user_details") if isinstance(account.get("user_details"), dict) else None
    if user_details:
        display = " ".join(str(user_details.get(key) or "").strip() for key in ("firstName", "lastName")).strip()
        display = display or str(_first(user_details.get("email"), account.get("username"), "Cont E.ON"))
        items.append({
            "entity_id": "eon_romania:account:user",
            "name": "E.ON • Cont",
            "state": display,
            "domain": "sensor",
            "source": "eon_romania",
            "aliases": ["eon", "cont eon", "myline"],
            "unit": "",
            "controllable": False,
            "device_id": "eon_romania_account",
            "device_name": "E.ON România",
            "device_model": "E.ON Myline account",
            "device_manufacturer": "E.ON România",
            "attributes": {"device_id": "eon_romania_account", "device_name": "E.ON România", **user_details},
        })

    for contract in payload.get("contracts") or []:
        if not isinstance(contract, dict):
            continue
        code = str(_first(contract.get("account_contract"), (contract.get("summary") or {}).get("accountContract")) or "").strip()
        if not code:
            continue
        details = contract.get("contract_details") if isinstance(contract.get("contract_details"), dict) else {}
        summary = contract.get("summary") if isinstance(contract.get("summary"), dict) else {}
        invoice_balance = contract.get("invoice_balance") if isinstance(contract.get("invoice_balance"), dict) else {}
        invoices_unpaid = _as_list(contract.get("invoices_unpaid"))
        meter_index = contract.get("meter_index") if isinstance(contract.get("meter_index"), dict) else {}
        convention = contract.get("consumption_convention")

        contract_attrs = {
            "contract_type": "DUO / colectiv" if contract.get("is_collective") else "Individual",
            "utility_type": _utility_name(_first(details.get("utilityType"), summary.get("utilityType"), details.get("portfolioName"), summary.get("portfolioName"))),
            "consumption_point_code": details.get("consumptionPointCode"),
            "pod": details.get("pod"),
            "distributor": details.get("distributorName"),
            "payment_method": details.get("paymentMethod"),
            "contract_start_date": details.get("contractStartDate"),
            "verification_expiration_date": details.get("verificationExpirationDate"),
            "revision_expiration_date": details.get("revisionExpirationDate"),
            "active": _bool_state(_first(details.get("active"), summary.get("active"))),
        }
        _add(code, "date_contract", "Date contract", code, contract, aliases=["contract eon", code], attributes=contract_attrs)

        amount = _first(invoice_balance.get("totalBalance"), invoice_balance.get("balance"), invoice_balance.get("balanceValue"), invoice_balance.get("invoiceValue"))
        has_balance = invoice_balance.get("balancePay")
        number = _num(amount)
        if has_balance is None:
            has_balance = bool(number and abs(number) > 0.009)
        _add(
            code,
            "sold_factura",
            "Sold factură",
            _format_number(amount or 0),
            contract,
            unit="lei",
            aliases=["sold eon", "factură eon", code],
            attributes={
                "sold": _money(amount or 0),
                "sold_de_plată": _bool_state(has_balance),
                "data_sold": invoice_balance.get("date"),
                "rambursare_disponibilă": _bool_state(invoice_balance.get("refund")),
                "rambursare_în_curs": _bool_state(invoice_balance.get("refundInProcess")),
                "garanție_activă": _bool_state(invoice_balance.get("hasGuarantee")),
            },
        )

        unpaid_total = _invoice_total(invoices_unpaid)
        invoice_attrs: dict[str, Any] = {"count": len(invoices_unpaid)}
        for idx, invoice in enumerate(invoices_unpaid[:6], start=1):
            if not isinstance(invoice, dict):
                continue
            value = _first(invoice.get("balanceValue"), invoice.get("invoiceValue"), invoice.get("totalBalance"), invoice.get("value"))
            due = _first(invoice.get("maturityDate"), invoice.get("dueDate"), invoice.get("paymentDueDate"))
            number = str(invoice.get("invoiceNumber") or idx)
            invoice_attrs[f"factura_{idx}"] = " • ".join(str(part) for part in (number, _money(value), f"scadentă {due}" if due else "") if str(part or "").strip())
        invoice_attrs["total_neachitat"] = _money(unpaid_total)
        _add(
            code,
            "factura_restanta",
            "Factură restantă",
            _format_number(unpaid_total),
            contract,
            unit="lei",
            aliases=["facturi restante", "restanțe eon", code],
            attributes=invoice_attrs,
        )

        reading_period = meter_index.get("readingPeriod") if isinstance(meter_index.get("readingPeriod"), dict) else {}
        allowed = _first(reading_period.get("inPeriod"), reading_period.get("allowedReading"), reading_period.get("allowed"), False)
        _add(
            code,
            "citire_permisa",
            "Citire permisă",
            _bool_state(allowed),
            contract,
            domain="binary_sensor",
            aliases=["citire index", "autocitire", code],
            attributes={
                "start_date": reading_period.get("startDate"),
                "end_date": reading_period.get("endDate"),
                "allowed_reading": _bool_state(reading_period.get("allowedReading")),
                "allow_change": _bool_state(reading_period.get("allowChange")),
                "smart_device": _bool_state(reading_period.get("smartDevice")),
                "current_reading_type": reading_period.get("currentReadingType"),
            },
        )

        devices = _as_list((meter_index.get("indexDetails") or {}).get("devices") if isinstance(meter_index.get("indexDetails"), dict) else meter_index.get("devices"))
        for device_idx, device in enumerate(devices or [{}], start=1):
            if not isinstance(device, dict):
                continue
            indexes = _as_list(device.get("indexes")) or [device]
            for index_idx, index in enumerate(indexes, start=1):
                if not isinstance(index, dict):
                    continue
                value = _first(index.get("currentValue"), index.get("currentIndex"), index.get("oldValue"), index.get("value"), index.get("index"), index.get("readingValue"), device.get("currentIndex"))
                if value is None:
                    continue
                meter_number = str(_first(device.get("deviceNumber"), device.get("meterNumber"), device.get("serialNumber"), device_idx) or device_idx)
                unit = _unit(_first(index.get("unitMeasure"), meter_index.get("um"), (contract.get("graphic_consumption") or {}).get("um"), "m³"))
                utility = _utility_name(_first(index.get("utilityType"), device.get("utilityType"), contract_attrs.get("utility_type")), unit)
                suffix = f"index_{slugify(utility)}_{slugify(meter_number)}_{index_idx}"
                _add(
                    code,
                    suffix,
                    f"Index {utility.lower()}",
                    _format_number(value),
                    contract,
                    unit=unit,
                    aliases=["index eon", meter_number, code],
                    attributes={
                        "meter_number": meter_number,
                        "old_value": _format_number(index.get("oldValue")) if index.get("oldValue") is not None else "",
                        "old_date": index.get("oldDate"),
                        "min_value": _format_number(index.get("minValue")) if index.get("minValue") is not None else "",
                        "max_value": _format_number(index.get("maxValue")) if index.get("maxValue") is not None else "",
                        "reading_type": index.get("readingType") or index.get("oldReadingType"),
                        "can_be_changed_till": index.get("canBeChangedTill"),
                        "sent_at": index.get("sentAt"),
                    },
                )

        convention_items = _as_list(convention)
        convention_line = convention_items[0].get("conventionLine", {}) if convention_items and isinstance(convention_items[0], dict) else {}
        convention_unit = _unit(convention_items[0].get("unitMeasure") if convention_items and isinstance(convention_items[0], dict) else "", (contract.get("graphic_consumption") or {}).get("um") if isinstance(contract.get("graphic_consumption"), dict) else "")
        convention_values = [_num(convention_line.get(key)) or 0 for key, _month in CONVENTION_MONTH_KEYS]
        convention_total = sum(convention_values)
        convention_avg = convention_total / len([v for v in convention_values if v > 0] or [1])
        convention_attrs = {
            f"conventie_{month}": f"{_format_number(convention_line.get(key) or 0)} {convention_unit}".strip()
            for key, month in CONVENTION_MONTH_KEYS
        }
        if convention_items and isinstance(convention_items[0], dict):
            convention_attrs.update({
                "valid_from": convention_items[0].get("fromDate"),
                "valid_until": convention_items[0].get("validUntil"),
                "can_modify": _bool_state(convention_items[0].get("canModify")),
                "status": convention_items[0].get("statusCode"),
            })
        _add(
            code,
            "conventie_consum",
            "Convenție consum",
            _format_number(convention_avg) if convention_total else "0",
            contract,
            unit=convention_unit,
            aliases=["convenție consum", "consum lunar", code],
            attributes=convention_attrs,
        )

        payments = _as_list(contract.get("payments"))
        if payments:
            total_payments = sum((_num(payment.get("value")) or 0) for payment in payments if isinstance(payment, dict))
            payment_attrs = {"count": len(payments), "total": _money(total_payments)}
            for idx, payment in enumerate(payments[:8], start=1):
                if not isinstance(payment, dict):
                    continue
                payment_attrs[f"plata_{idx}"] = " • ".join(str(part) for part in (
                    payment.get("paymentDate"), _money(payment.get("value")), payment.get("paymentChannel") or payment.get("paymentType"),
                ) if str(part or "").strip())
            _add(code, "plati", "Plăți", _format_number(total_payments), contract, unit="lei", aliases=["plăți eon", code], attributes=payment_attrs)

        consumption = contract.get("graphic_consumption")
        if isinstance(consumption, dict) and consumption:
            unit = _unit(_first(consumption.get("um"), consumption.get("unitMeasure"), convention_unit, ""))
            monthly = [item for item in _as_list(consumption.get("consumption")) if isinstance(item, dict)]
            total = sum((_num(item.get("consumptionValue")) or 0) for item in monthly)
            if total:
                attrs = {"months": len(monthly)}
                _add(code, "consum_total", "Consum total", _format_number(total), contract, unit=unit, aliases=["consum eon", code], attributes=attrs)
            if monthly:
                latest = monthly[0]
                latest_month = str(latest.get("month") or "").zfill(2)
                latest_year = str(latest.get("year") or "")
                latest_label = " ".join(part for part in (MONTHS_RO.get(latest_month, latest_month), latest_year) if part)
                _add(
                    code,
                    "consum_luna_curenta",
                    "Consum luna curentă",
                    _format_number(latest.get("consumptionValue")),
                    contract,
                    unit=unit,
                    aliases=["consum luna curenta", "consum eon", code],
                    attributes={"daily_average": f"{_format_number(latest.get('consumptionValueDayValue'))} {unit}/zi"},
                )
                for item in monthly[:24]:
                    year = str(item.get("year") or "").strip()
                    month = str(item.get("month") or "").zfill(2)
                    if not year or not month:
                        continue
                    month_label = " ".join(part for part in (MONTHS_RO.get(month, month), year) if part)
                    _add(
                        code,
                        f"consum_{year}_{month}",
                        f"Consum {month_label}".strip(),
                        _format_number(item.get("consumptionValue")),
                        contract,
                        unit=unit,
                        aliases=["consum lunar", month_label, code],
                        attributes={"daily_average": f"{_format_number(item.get('consumptionValueDayValue'))} {unit}/zi", "year_month": item.get("yearMonth")},
                    )

        for subcontract in contract.get("subcontract_details") or []:
            if not isinstance(subcontract, dict):
                continue
            sub_code = str(subcontract.get("account_contract") or "").strip()
            if not sub_code:
                continue
            sub_contract = {**contract, **subcontract, "contract_details": subcontract.get("contract_details") or {}, "summary": subcontract.get("summary") or {}}
            _add(sub_code, "date_contract", "Date subcontract", sub_code, sub_contract, aliases=["subcontract eon", sub_code], attributes={"parent_contract": code})

    def _sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
        entity_id = str(item.get("entity_id") or "")
        suffix = entity_id.rsplit(":", 1)[-1]
        if suffix == "date_contract":
            priority = 0
        elif suffix == "sold_factura":
            priority = 10
        elif suffix == "factura_restanta":
            priority = 11
        elif suffix.startswith("index_"):
            priority = 20
        elif suffix == "citire_permisa":
            priority = 21
        elif suffix == "conventie_consum":
            priority = 30
        elif suffix == "consum_luna_curenta":
            priority = 40
        elif suffix == "consum_total":
            priority = 41
        elif suffix.startswith("consum_"):
            priority = 50
        elif suffix == "plati":
            priority = 60
        else:
            priority = 99
        monthly_key = 0
        parts = suffix.split("_")
        if len(parts) == 3 and parts[0] == "consum":
            monthly_key = -int(f"{parts[1]}{parts[2]}" or "0") if parts[1].isdigit() and parts[2].isdigit() else 0
        return (item.get("attributes", {}).get("device_name") or "", priority, monthly_key, item.get("name") or "")

    items.sort(key=_sort_key)
    return _finalize(items, default_source="eon_romania")


