from __future__ import annotations

from typing import Any

from integrations.entity_utils import attach_device_fields, finalize_entities as _finalize, slugify


def _resolve_pago_device(
    payload: dict[str, Any],
    *,
    entry_id: str = "",
    entry_title: str = "",
) -> tuple[str, str]:
    """One Hyve device per Pago config entry (account)."""
    eid = str(entry_id or "").strip()
    title = str(entry_title or "").strip()
    profil = payload.get("profil") if isinstance(payload.get("profil"), dict) else {}
    email = str(profil.get("email") or "").strip()
    if eid:
        device_id = eid
    elif email:
        device_id = f"pago_{slugify(email)}"
    else:
        device_id = "pago_default"
    device_name = title or email or "Pago"
    return device_id, device_name


def extract_pago_candidates(
    payload: Any,
    *,
    entry_id: str = "",
    entry_title: str = "",
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return items

    device_id, device_name = _resolve_pago_device(
        payload,
        entry_id=entry_id,
        entry_title=entry_title,
    )

    def _push(entity: dict[str, Any]) -> None:
        attach_device_fields(
            entity,
            device_id=device_id,
            device_name=device_name,
            manufacturer="Pago",
        )
        items.append(entity)

    def _text(*parts: Any) -> str:
        return " • ".join(str(part).strip() for part in parts if str(part or "").strip())

    def _money(value: Any) -> str:
        if isinstance(value, (int, float)):
            return f"{value:.2f} RON"
        return ""

    def _date(value: Any) -> str:
        text = str(value or "").strip()
        return text[:10] if text else ""

    facturi = payload.get("facturi") or []
    for idx, factura in enumerate(facturi[:24], start=1):
        if not isinstance(factura, dict):
            continue
        furnizor = str(factura.get("furnizor_nume") or factura.get("furnizor") or f"Factura {idx}").strip()
        suma = factura.get("suma_datorata")
        scadenta = _date(factura.get("scadenta"))
        state = _text(_money(suma), f"scadentă {scadenta}" if scadenta else "", "factură")
        _push({
            "entity_id": f"pago:factura_{idx}",
            "name": furnizor,
            "state": state or "Factură",
            "domain": "sensor",
            "source": "pago",
            "aliases": [furnizor, f"factura {furnizor}".strip()],
            "unit": "",
            "controllable": False,
        })

    vehicule = payload.get("vehicule") or []
    for idx, vehicul in enumerate(vehicule[:24], start=1):
        if not isinstance(vehicul, dict):
            continue
        plate = str(vehicul.get("nr_inmatriculare") or f"Vehicul {idx}").strip()
        alerte = vehicul.get("alerte") or {}
        tags = []
        for label, key in (("RCA", "rca_expira"), ("ITP", "itp_expira"), ("Rovinietă", "rovinieta_expira"), ("Vignetă", "vinieta_expira"), ("CASCO", "casco_expira")):
            date_value = _date(alerte.get(key))
            if date_value:
                tags.append(f"{label} {date_value}")
        _push({
            "entity_id": f"pago:vehicul_{idx}",
            "name": plate,
            "state": " • ".join(tags) if tags else ("Date incomplete" if vehicul.get("incomplet") else "Fără alerte"),
            "domain": "sensor",
            "source": "pago",
            "aliases": [plate],
            "unit": "",
            "controllable": False,
        })

    abon = payload.get("abonament") or {}
    if isinstance(abon, dict) and abon:
        pret = _money(abon.get("pret"))
        plati_ramase = abon.get("plati_ramase")
        _push({
            "entity_id": "pago:abonament",
            "name": "Abonament",
            "state": _text("Activ" if abon.get("activ") else "Inactiv", f"{plati_ramase} plăți rămase" if plati_ramase is not None else "", pret),
            "domain": "sensor",
            "source": "pago",
            "aliases": ["abonament", "subscription"],
            "unit": "",
            "controllable": False,
        })

    conturi = payload.get("conturi_facturi") or []
    for idx, cont in enumerate(conturi[:24], start=1):
        if not isinstance(cont, dict):
            continue
        furnizor = str(cont.get("furnizor_nume") or cont.get("furnizor") or f"Cont {idx}").strip()
        locatie = str(cont.get("locatie") or "").strip()
        amount = _money(cont.get("ultima_plata_suma"))
        when = _date(cont.get("ultima_plata_data"))
        title = f"{furnizor}" + (f" ({locatie})" if locatie else "")
        _push({
            "entity_id": f"pago:cont_{idx}",
            "name": title,
            "state": _text(amount, when, "autoplată" if cont.get("auto_plata") else ""),
            "domain": "sensor",
            "source": "pago",
            "aliases": [furnizor, locatie] if locatie else [furnizor],
            "unit": "",
            "controllable": False,
        })

    carduri = payload.get("carduri") or []
    for idx, card in enumerate(carduri[:12], start=1):
        if not isinstance(card, dict):
            continue
        last4 = str(card.get("last4") or "").strip()
        alias = str(card.get("alias") or "").strip()
        ctype = str(card.get("tip_card") or "").strip()
        label = alias or (f"Card ****{last4}" if last4 else f"Card {idx}")
        state = _text(f"****{last4}" if last4 else "", ctype, "implicit" if card.get("default") else "", "activ" if card.get("activ") else "inactiv")
        _push({
            "entity_id": f"pago:card_{idx}",
            "name": label,
            "state": state or "Card",
            "domain": "sensor",
            "source": "pago",
            "aliases": [alias, ctype, last4] if alias else [ctype, last4],
            "unit": "",
            "controllable": False,
        })

    plati = payload.get("plati") or []
    for idx, plata in enumerate(plati[:24], start=1):
        if not isinstance(plata, dict):
            continue
        furnizor = str(plata.get("furnizor_nume") or plata.get("tip") or f"Plată {idx}").strip()
        locatie = str(plata.get("locatie") or "").strip()
        amount = _money(plata.get("suma_platita") or plata.get("suma"))
        when = _date(plata.get("data"))
        status = str(plata.get("status") or "").strip()
        title = f"{furnizor}" + (f" ({locatie})" if locatie else "")
        _push({
            "entity_id": f"pago:plata_{idx}",
            "name": title,
            "state": _text(amount, when, status),
            "domain": "sensor",
            "source": "pago",
            "aliases": [furnizor, locatie] if locatie else [furnizor],
            "unit": "",
            "controllable": False,
        })

    return _finalize(items, default_source="pago")
