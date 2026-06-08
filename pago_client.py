"""Pago Plătește API client.

Async client for pago.cloud — fetches bills, vehicles, cards, payments, profile.
Uses httpx with OAuth2 token management and in-memory TTL cache.

Based on https://github.com/cnecrea/pagoplateste (adapted for httpx).
"""

import asyncio
import logging
import time
from typing import Any, Dict, Optional

import httpx

log = logging.getLogger("pago")

BASE_URL = "https://pago.cloud"
AUTH_URL = f"{BASE_URL}/authentication/uaa/oauth/token"
AUTH_BASIC = "Basic cGFnby1tb2JpbGUtYXBwOnBhZ28tbW9iaWxlLWFwcC1zZWNyZXQ="
APP_ID = "bed83d2a-6287-4e6c-9ce1-e7a49d4f2a43"
APP_VERSION = "4.2.0"

HEADERS_BASE = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Authorization": AUTH_BASIC,
    "App-Id": APP_ID,
    "App-Version": APP_VERSION,
}

ENDPOINTS = {
    "profile":       "/authentication/uaa/v1.00/user_profile",
    "subscription":  "/pago-freemium/subscription/active",
    "cards":         "/payment/cards",
    "cars":          "/notification_v1_1/details/cars",
    "bills_summary": "/sdk/bills/accounts/summary",
    "invoice_payments": "/payment/payment-details-v2?paymentEntityType=INVOICE&size=100&page=0",
    "all_payments":  "/payment/payment-details-v2?paymentEntityType=all&size=50&page=0",
}


def _unwrap(resp_json: dict) -> Any:
    """Extract 'data' from the Pago envelope {error, errorMsg, data}."""
    if isinstance(resp_json, dict):
        if resp_json.get("error"):
            raise PagoAPIError(resp_json.get("errorMsg") or str(resp_json))
        return resp_json.get("data", resp_json)
    return resp_json


class PagoAPIError(Exception):
    pass


def _looks_masked_secret(value: str | None) -> bool:
    if not isinstance(value, str):
        return False
    s = value.strip()
    return bool(s) and all(ch in "•*●·xX#-" for ch in s)


class PagoClient:
    """Async Pago API client with token management and TTL cache."""

    def __init__(self, email: str, password: str, *, cache_ttl: int = 3600):
        self._email = email
        self._password = password
        self._cache_ttl = max(cache_ttl, 60)
        self._token: Optional[str] = None
        self._token_gen: int = 0          # bumped on each successful auth
        self._token_lock = asyncio.Lock()
        self._auth_fail_until: float = 0  # monotonic time — cooldown after auth failure
        self._cache: Dict[str, Any] = {}
        self._cache_ts: Dict[str, float] = {}

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    async def _authenticate(self) -> str:
        """Obtain an OAuth2 access token from Pago."""
        data = {
            "grant_type": "pago",
            "username": self._email,
            "password": self._password,
        }
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(AUTH_URL, data=data, headers=HEADERS_BASE)
            resp.raise_for_status()
            body = resp.json()
        token = body.get("access_token")
        if not token:
            raise PagoAPIError("Authentication failed — no access_token in response")
        log.info("Pago: authenticated successfully")
        return token

    async def _get_token(self) -> str:
        async with self._token_lock:
            if not self._token:
                # Respect cooldown after an auth failure
                now = time.monotonic()
                if now < self._auth_fail_until:
                    raise PagoAPIError("Authentication on cooldown after previous failure")
                try:
                    self._token = await self._authenticate()
                    self._token_gen += 1
                except Exception:
                    # Back off 120 s before retrying auth
                    self._auth_fail_until = time.monotonic() + 120
                    raise
            return self._token

    async def _invalidate_token(self, gen: int):
        """Invalidate the token only if nobody else already refreshed it."""
        async with self._token_lock:
            if self._token_gen == gen:
                self._token = None

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    async def _get(self, path: str) -> Any:
        """GET with auto-retry on 401 (token refresh)."""
        for attempt in range(2):
            token = await self._get_token()
            gen = self._token_gen
            headers = {
                "Authorization": f"Bearer {token}",
                "App-Id": APP_ID,
                "App-Version": APP_VERSION,
                "Accept": "application/json",
            }
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.get(f"{BASE_URL}{path}", headers=headers)
            if resp.status_code == 401 and attempt == 0:
                log.warning("Pago: 401 — refreshing token")
                await self._invalidate_token(gen)
                continue
            resp.raise_for_status()
            return _unwrap(resp.json())
        raise PagoAPIError("Authentication failed after retry")

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    def _from_cache(self, key: str) -> Optional[Any]:
        ts = self._cache_ts.get(key, 0)
        if time.monotonic() - ts < self._cache_ttl and key in self._cache:
            return self._cache[key]
        return None

    def _to_cache(self, key: str, value: Any):
        self._cache[key] = value
        self._cache_ts[key] = time.monotonic()

    def clear_cache(self):
        self._cache.clear()
        self._cache_ts.clear()

    # ------------------------------------------------------------------
    # Data fetchers
    # ------------------------------------------------------------------

    async def get_profile(self) -> Any:
        cached = self._from_cache("profile")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["profile"])
        self._to_cache("profile", data)
        return data

    async def get_subscription(self) -> Any:
        cached = self._from_cache("subscription")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["subscription"])
        self._to_cache("subscription", data)
        return data

    async def get_cards(self) -> Any:
        cached = self._from_cache("cards")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["cards"])
        self._to_cache("cards", data)
        return data

    async def get_cars(self) -> Any:
        cached = self._from_cache("cars")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["cars"])
        self._to_cache("cars", data)
        return data

    async def get_bills_summary(self) -> Any:
        cached = self._from_cache("bills_summary")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["bills_summary"])
        self._to_cache("bills_summary", data)
        return data

    async def get_invoice_payments(self) -> Any:
        """Payments of type INVOICE -> used to extract supplier accounts."""
        cached = self._from_cache("invoice_payments")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["invoice_payments"])
        self._to_cache("invoice_payments", data)
        return data

    async def get_all_payments(self) -> Any:
        """All recent payments (all types)."""
        cached = self._from_cache("all_payments")
        if cached is not None:
            return cached
        data = await self._get(ENDPOINTS["all_payments"])
        self._to_cache("all_payments", data)
        return data

    # ------------------------------------------------------------------
    # Data normalization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _ts_to_str(val) -> Optional[str]:
        """Timestamp ms -> 'YYYY-MM-DD HH:MM'."""
        if not val or not isinstance(val, (int, float)) or val <= 0:
            return None
        from datetime import datetime as _dt
        try:
            return _dt.fromtimestamp(val / 1000).strftime("%Y-%m-%d %H:%M")
        except (ValueError, OSError):
            return None

    @staticmethod
    def _provider_display(uri: Optional[str]) -> Optional[str]:
        """'rds.crawler' -> 'Rds', 'engie.gas' -> 'Engie Gas'."""
        if not uri:
            return None
        name = uri.split(".")[0] if "." in uri else uri
        return name.replace("_", " ").replace("-", " ").title()

    def _normalize_vehicles(self, raw_cars: list) -> list:
        """Parse raw car details into structured alerts."""
        _type_map = {
            "END_VALIDITY_RCA": "rca_expira",
            "END_VALIDITY_ITP": "itp_expira",
            "END_VALIDITY_VIGNETTE": "vinieta_expira",
            "END_VALIDITY_VINIETA": "vinieta_expira",
            "END_VALIDITY_ROVINIETA": "rovinieta_expira",
            "END_VALIDITY_CASCO": "casco_expira",
        }
        result = []
        for car in raw_cars:
            m: Dict[str, Any] = {
                "car_id": car.get("carId"),
                "nr_inmatriculare": car.get("registrationNumber"),
                "incomplet": car.get("incomplete", False),
                "alerte": {},
            }
            for detail in car.get("details") or []:
                tip = detail.get("detailType", "")
                val = detail.get("valueTimestamp")
                data_str = self._ts_to_str(val) if val else None
                notif = detail.get("notificationSettings") or {}

                key = _type_map.get(tip)
                if key:
                    m["alerte"][key] = data_str
                elif tip == "CUSTOM":
                    cname = detail.get("detailCustomName", "custom")
                    m["alerte"][f"custom_{cname}"] = data_str
                else:
                    m["alerte"][tip.lower()] = data_str

                if tip == "END_VALIDITY_RCA":
                    m["alerte"]["rca_notificare_sms"] = notif.get("notifyBySms", False)
                    m["alerte"]["rca_notificare_email"] = notif.get("notifyByEmail", False)
            result.append(m)
        return result

    def _extract_supplier_accounts(self, invoice_payments: list) -> list:
        """Extract unique supplier billing locations from INVOICE payments."""
        seen: Dict[int, Dict[str, Any]] = {}
        for p in invoice_payments:
            inv = p.get("invoice") or {}
            lid = inv.get("locationId")
            if not lid or lid in seen:
                continue
            seen[lid] = {
                "location_id": lid,
                "furnizor": inv.get("providerUri"),
                "furnizor_nume": self._provider_display(inv.get("providerUri")),
                "furnizor_logo": inv.get("providerImgUrl"),
                "locatie": inv.get("locationAlias"),
                "tip_locatie": inv.get("locationType"),
                "ultima_plata_suma": p.get("paidAmount"),
                "ultima_plata_data": self._ts_to_str(p.get("paymentTimestamp")),
                "auto_plata": p.get("autoPayment", False),
            }
        return sorted(seen.values(), key=lambda x: x.get("locatie") or "")

    def _normalize_payments(self, raw_payments: list) -> list:
        """Normalize recent payments with extracted supplier info."""
        result = []
        for p in raw_payments:
            inv = p.get("invoice") or {}
            result.append({
                "id": p.get("id"),
                "suma": p.get("amount"),
                "suma_platita": p.get("paidAmount"),
                "status": p.get("status"),
                "data": self._ts_to_str(p.get("paymentTimestamp")),
                "tip": p.get("paymentEntityType"),
                "auto_plata": p.get("autoPayment", False),
                "furnizor": inv.get("providerUri"),
                "furnizor_nume": self._provider_display(inv.get("providerUri")),
                "furnizor_logo": inv.get("providerImgUrl"),
                "locatie": inv.get("locationAlias"),
            })
        return result

    def _normalize_cards(self, raw_cards: list) -> list:
        """Normalize card data."""
        return [
            {
                "id": c.get("id"),
                "alias": c.get("alias"),
                "last4": c.get("last4"),
                "tip_card": c.get("cardType"),
                "procesor": c.get("paymentProcessor"),
                "activ": c.get("active"),
                "default": c.get("defaultCard"),
            }
            for c in raw_cards
        ]

    def _normalize_profile(self, raw: dict) -> dict:
        """Normalize profile data."""
        return {
            "email": raw.get("email"),
            "nume": raw.get("firstName"),
            "prenume": raw.get("lastName"),
            "telefon": raw.get("phoneNumber"),
            "creat_la": raw.get("createdAt"),
            "pos_user_id": raw.get("posUserId"),
        }

    def _normalize_subscription(self, raw: dict) -> dict:
        """Normalize subscription data."""
        total = raw.get("monthlyInvoices") or 0
        used = raw.get("usedPayments") or 0
        return {
            "activ": raw.get("active", False),
            "subscription_id": raw.get("subscriptionId"),
            "inceput": raw.get("availabilityStart"),
            "sfarsit": raw.get("availabilityEnd"),
            "grace_end": raw.get("graceEnd"),
            "perioada_zile": raw.get("period"),
            "pret": raw.get("amount"),
            "facturi_lunare": total,
            "plati_folosite": used,
            "plati_ramase": max(0, total - used),
            "luna_curenta_start": raw.get("currentMonthStart"),
            "luna_curenta_sfarsit": raw.get("currentMonthEnd"),
        }

    def _normalize_bills(self, raw: Any) -> list:
        """Normalize bills summary — extract billsList."""
        if isinstance(raw, dict):
            bills = raw.get("billsList") or []
        elif isinstance(raw, list):
            bills = raw
        else:
            return []
        from datetime import datetime as _dt
        result = []
        for b in bills:
            due_str = b.get("dueDate")
            scadenta = None
            if due_str and isinstance(due_str, str):
                for fmt in ("%Y%m%d", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
                    try:
                        scadenta = _dt.strptime(due_str.strip(), fmt).strftime("%Y-%m-%d")
                        break
                    except ValueError:
                        continue
                if not scadenta:
                    scadenta = due_str
            result.append({
                "id": b.get("id"),
                "suma_datorata": b.get("dueAmount"),
                "scadenta": scadenta,
            })
        return result

    async def fetch_all(self) -> Dict[str, Any]:
        """Fetch all data categories in parallel and normalize.

        Returns a dict matching the cnecrea/pagoplateste data keys:
        profil, abonament, carduri, vehicule, facturi,
        conturi_facturi, plati.
        """
        results: Dict[str, Any] = {}

        # Phase 1: fast endpoints in parallel
        raw = {}
        errors: Dict[str, str] = {}
        tasks1 = {
            "profile": self.get_profile(),
            "subscription": self.get_subscription(),
            "cards": self.get_cards(),
            "cars": self.get_cars(),
            "bills": self.get_bills_summary(),
        }
        gathered1 = await asyncio.gather(*tasks1.values(), return_exceptions=True)
        for key, result in zip(tasks1.keys(), gathered1):
            if isinstance(result, Exception):
                errors[key] = str(result)
                raw[key] = None
            else:
                raw[key] = result

        # Phase 2: payment endpoints in parallel
        tasks2 = {
            "invoice_payments": self.get_invoice_payments(),
            "all_payments": self.get_all_payments(),
        }
        gathered2 = await asyncio.gather(*tasks2.values(), return_exceptions=True)
        for key, result in zip(tasks2.keys(), gathered2):
            if isinstance(result, Exception):
                errors[key] = str(result)
                raw[key] = None
            else:
                raw[key] = result

        if errors:
            failed = ", ".join(sorted(errors.keys()))
            if all(v is None for v in raw.values()):
                raise PagoAPIError(f"Pago authentication failed or endpoints unavailable: {failed}")
            log.info("Pago partial sync: unavailable endpoints: %s", failed)

        # Normalize all data
        if isinstance(raw.get("profile"), dict):
            results["profil"] = self._normalize_profile(raw["profile"])
        else:
            results["profil"] = {"error": "fetch failed"}

        if isinstance(raw.get("subscription"), dict):
            results["abonament"] = self._normalize_subscription(raw["subscription"])
        else:
            results["abonament"] = {"error": "fetch failed"}

        if isinstance(raw.get("cards"), list):
            results["carduri"] = self._normalize_cards(raw["cards"])
        else:
            results["carduri"] = []

        if isinstance(raw.get("cars"), list):
            results["vehicule"] = self._normalize_vehicles(raw["cars"])
        else:
            results["vehicule"] = []

        results["facturi"] = self._normalize_bills(raw.get("bills"))

        inv_payments = raw.get("invoice_payments")
        if isinstance(inv_payments, list):
            results["conturi_facturi"] = self._extract_supplier_accounts(inv_payments)
        else:
            results["conturi_facturi"] = []

        all_payments = raw.get("all_payments")
        if isinstance(all_payments, list):
            results["plati"] = self._normalize_payments(all_payments)
        else:
            results["plati"] = []

        return results

    async def fetch_light(self, cached: Dict[str, Any] | None = None) -> Dict[str, Any]:
        """Refresh bills and recent payments; reuse stable profile data from cache."""
        base = dict(cached or {})
        raw: Dict[str, Any] = {}
        errors: Dict[str, str] = {}
        tasks = {
            "bills": self.get_bills_summary(),
            "invoice_payments": self.get_invoice_payments(),
        }
        gathered = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for key, result in zip(tasks.keys(), gathered):
            if isinstance(result, Exception):
                errors[key] = str(result)
                raw[key] = None
            else:
                raw[key] = result

        results = dict(base)
        results["facturi"] = self._normalize_bills(raw.get("bills"))
        inv_payments = raw.get("invoice_payments")
        if isinstance(inv_payments, list):
            results["conturi_facturi"] = self._extract_supplier_accounts(inv_payments)
        elif "conturi_facturi" not in results:
            results["conturi_facturi"] = []
        if errors:
            results.setdefault("_partial_errors", errors)
        return results

    # ------------------------------------------------------------------
    # Connection test
    # ------------------------------------------------------------------

    async def test_connection(self) -> Dict[str, Any]:
        """Quick auth test — returns {ok, message}."""
        try:
            async with self._token_lock:
                self._token = None
                self._auth_fail_until = 0
            token = await self._get_token()
            return {"ok": True, "message": "Autentificat cu succes la Pago"}
        except Exception as e:
            return {"ok": False, "message": str(e)}


# ---------------------------------------------------------------------------
# Singleton management  (mirrors pattern used by other integrations)
# ---------------------------------------------------------------------------

_instance: Optional[PagoClient] = None
_instance_lock = asyncio.Lock()


async def get_client() -> Optional[PagoClient]:
    """Return the current PagoClient singleton (or None if not configured)."""
    global _instance
    return _instance


async def init_client(email: str, password: str, cache_ttl: int = 3600) -> PagoClient:
    """Create / replace the global PagoClient singleton."""
    global _instance
    async with _instance_lock:
        _instance = PagoClient(email, password, cache_ttl=cache_ttl)
    return _instance


async def ensure_client():
    """Deprecated — use config entries via integrations.entry_settings."""
    from integrations import entry_settings

    data = entry_settings.entry_data("pago")
    email = (data.get("email") or "").strip()
    password = (data.get("password") or "").strip()
    if not entry_settings.is_active("pago") or not email or not password:
        return None
    if _looks_masked_secret(password):
        log.warning("Pago skipped: masked placeholder password detected. Re-enter the real password in Settings.")
        return None
    return await init_client(email, password, cache_ttl=int(data.get("scan_interval") or 3600))


def shutdown_client():
    """Clear the singleton (for clean shutdown)."""
    global _instance
    _instance = None
