"""Pago Plătește — AI tool executor.

Called by brain/toolbox.py when the LLM invokes get_pago_data.
"""

import json
import logging
from typing import Any, Dict

import pago_client

log = logging.getLogger("pago")

CATEGORIES = {"all", "facturi", "vehicule", "carduri", "plati", "profil", "abonament", "conturi_facturi"}


async def exec_get_pago_data(args: Dict[str, Any]) -> str:
    """Fetch Pago data for the requested category and return as text for the LLM."""
    category = (args.get("category") or "all").strip().lower()
    if category not in CATEGORIES:
        return f"Invalid category '{category}'. Choose from: {', '.join(sorted(CATEGORIES))}"

    from integrations import entry_settings

    data = entry_settings.entry_data("pago")
    email = (data.get("email") or "").strip()
    password = (data.get("password") or "").strip()
    if not entry_settings.is_active("pago") or not email or not password:
        return "Pago integration is not configured or disabled. Ask the user to enable it in Settings → Integrations."
    client = pago_client.PagoClient(email, password, cache_ttl=int(data.get("scan_interval") or 3600))

    try:
        if category == "all":
            data = await client.fetch_all()
        elif category == "facturi":
            data = await client.get_bills_summary()
        elif category == "vehicule":
            data = await client.get_cars()
        elif category == "carduri":
            data = await client.get_cards()
        elif category == "plati":
            data = await client.get_all_payments()
        elif category == "conturi_facturi":
            data = await client.get_invoice_payments()
        elif category == "profil":
            data = await client.get_profile()
        elif category == "abonament":
            data = await client.get_subscription()
        else:
            data = await client.fetch_all()
    except Exception as e:
        log.error("Pago tool fetch failed for %s: %s", category, e)
        return f"Error fetching Pago data ({category}): {e}"

    return json.dumps(data, ensure_ascii=False, default=str)
