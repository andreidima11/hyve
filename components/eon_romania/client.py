"""E.ON Romania Myline API client for Hyve integrations."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import time
from typing import Any

import httpx

log = logging.getLogger("eon_romania")

API_BASE = "https://api2.eon.ro"
API_VERSION_USERS = "v1"
API_VERSION_PARTNERS = "v2"
API_VERSION_INVOICES = "v1"
API_VERSION_METERREADINGS = "v1"

SUBSCRIPTION_KEY = "e43698af63d84daa9763bbef7918378f"
AUTH_VERIFY_SECRET = "zrAnQjN0bDjlTsKYmbpexjaBNY6wrCzuIqGWNgqoaJzlLrYiqd"
MFA_REQUIRED_CODE = "6054"
TOKEN_REFRESH_THRESHOLD = 300
TOKEN_MAX_AGE = 3300

URL_LOGIN = f"{API_BASE}/users/{API_VERSION_USERS}/userauth/mobile-login"
URL_REFRESH_TOKEN = f"{API_BASE}/users/{API_VERSION_USERS}/userauth/mobile-refresh-token"
URL_USER_DETAILS = f"{API_BASE}/users/{API_VERSION_USERS}/users/user-details"
URL_CONTRACTS_LIST = f"{API_BASE}/partners/{API_VERSION_PARTNERS}/account-contracts/list"
URL_CONTRACT_DETAILS = f"{API_BASE}/partners/{API_VERSION_PARTNERS}/account-contracts/{{account_contract}}"
URL_INVOICES_UNPAID = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/invoices/list"
URL_INVOICES_PROSUM = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/invoices/list-prosum"
URL_INVOICE_BALANCE = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/invoices/invoice-balance"
URL_INVOICE_BALANCE_PROSUM = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/invoices/invoice-balance-prosum"
URL_PAYMENT_LIST = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/payments/payment-list"
URL_RESCHEDULING_PLANS = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/rescheduling-plans"
URL_GRAPHIC_CONSUMPTION = f"{API_BASE}/invoices/{API_VERSION_INVOICES}/invoices/graphic-consumption/{{account_contract}}"
URL_METER_INDEX = f"{API_BASE}/meterreadings/{API_VERSION_METERREADINGS}/meter-reading/{{account_contract}}/index"
URL_METER_HISTORY = f"{API_BASE}/meterreadings/{API_VERSION_METERREADINGS}/meter-reading/{{account_contract}}/history"
URL_CONSUMPTION_CONVENTION = f"{API_BASE}/meterreadings/{API_VERSION_METERREADINGS}/consumption-convention/{{account_contract}}"

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
    "User-Agent": "EON Myline/Android",
}


class EonRomaniaError(Exception):
    """Raised when the E.ON Romania API cannot be queried."""


class EonRomaniaAuthError(EonRomaniaError):
    """Raised when credentials are invalid or auth cannot complete."""


class EonRomaniaMfaRequired(EonRomaniaAuthError):
    """Raised when E.ON requires a second factor for this login."""

    def __init__(self, mfa_data: dict[str, Any] | None = None) -> None:
        self.mfa_data = dict(mfa_data or {})
        recipient = self.mfa_data.get("recipient") or "contul tău"
        super().__init__(f"E.ON cere cod MFA pentru {recipient}. Fluxul OTP va trebui completat în UI.")


def generate_verify_hmac(username: str) -> str:
    """Generate the mobile-login verify signature expected by the API."""
    return hmac.new(
        AUTH_VERIFY_SECRET.encode("utf-8"),
        str(username or "").encode("utf-8"),
        hashlib.md5,
    ).hexdigest()


def _parse_contract_selection(value: Any) -> list[str]:
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = str(value or "").replace("\n", ",").split(",")
    selected: list[str] = []
    for item in raw_items:
        text = str(item or "").strip()
        if text and text not in selected:
            selected.append(text)
    return selected


def _list_payload(value: Any, list_key: str = "list") -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        nested = value.get(list_key)
        if isinstance(nested, list):
            return nested
    return []


def _looks_collective(contract: dict[str, Any], metadata: dict[str, Any] | None = None) -> bool:
    meta = metadata or {}
    if isinstance(meta.get("is_collective"), bool):
        return bool(meta["is_collective"])
    blob = " ".join(str(contract.get(key) or "") for key in (
        "contractType", "utilityType", "contractName", "portfolioName", "type",
    )).lower()
    return any(token in blob for token in ("colect", "collect", "duo"))


class EonRomaniaClient:
    """Async client for the E.ON Myline mobile API."""

    def __init__(
        self,
        username: str,
        password: str,
        *,
        selected_contracts: Any = None,
        contract_metadata: dict[str, Any] | None = None,
        include_history: bool = False,
        timeout: float = 30.0,
    ) -> None:
        self.username = str(username or "").strip()
        self.password = str(password or "").strip()
        self.selected_contracts = _parse_contract_selection(selected_contracts)
        self.contract_metadata = dict(contract_metadata or {})
        self.include_history = bool(include_history)
        self.timeout = float(timeout or 30.0)
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout), headers=HEADERS)
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._token_type = "Bearer"
        self._expires_in = 3600
        self._token_obtained_at = 0.0
        self._auth_lock = asyncio.Lock()

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "EonRomaniaClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    def is_token_likely_valid(self) -> bool:
        if not self._access_token:
            return False
        age = time.monotonic() - self._token_obtained_at
        max_age = min(max(int(self._expires_in or 3600) - TOKEN_REFRESH_THRESHOLD, 60), TOKEN_MAX_AGE)
        return age < max_age

    def _auth_headers(self) -> dict[str, str]:
        headers = dict(HEADERS)
        if self._access_token:
            headers["Authorization"] = f"{self._token_type} {self._access_token}"
        return headers

    def _apply_token_data(self, data: dict[str, Any]) -> None:
        self._access_token = data.get("access_token")
        self._refresh_token = data.get("refresh_token")
        self._token_type = data.get("token_type") or "Bearer"
        try:
            self._expires_in = int(data.get("expires_in") or 3600)
        except (TypeError, ValueError):
            self._expires_in = 3600
        self._token_obtained_at = time.monotonic()

    def _invalidate_access_token(self) -> None:
        self._access_token = None
        self._token_obtained_at = 0.0

    async def login(self) -> bool:
        if not self.username or not self.password:
            raise EonRomaniaAuthError("Email și parolă E.ON sunt obligatorii.")
        payload = {
            "username": self.username,
            "password": self.password,
            "verify": generate_verify_hmac(self.username),
        }
        try:
            response = await self._client.post(URL_LOGIN, json=payload, headers=HEADERS)
        except httpx.TimeoutException as exc:
            raise EonRomaniaAuthError("E.ON nu a răspuns la autentificare în timp util.") from exc
        except httpx.HTTPError as exc:
            raise EonRomaniaAuthError(f"Autentificarea E.ON a eșuat: {exc}") from exc

        text = response.text
        if response.status_code == 200:
            data = response.json()
            if not isinstance(data, dict) or not data.get("access_token"):
                raise EonRomaniaAuthError("Răspunsul de autentificare E.ON nu conține token.")
            self._apply_token_data(data)
            return True

        if response.status_code == 400:
            try:
                data = response.json()
            except ValueError:
                data = {}
            if str(data.get("code")) == MFA_REQUIRED_CODE:
                raise EonRomaniaMfaRequired({
                    "uuid": data.get("description"),
                    "type": data.get("secondFactorType") or "EMAIL",
                    "alternative_type": data.get("secondFactorAlternativeType") or "SMS",
                    "recipient": data.get("secondFactorRecipient") or "",
                    "validity": data.get("secondFactorValidity"),
                })

        self._access_token = None
        message = self._extract_error_message(response, text) or "Autentificarea E.ON a eșuat."
        raise EonRomaniaAuthError(message)

    async def refresh_token(self) -> bool:
        if not self._refresh_token:
            return False
        try:
            response = await self._client.post(
                URL_REFRESH_TOKEN,
                json={"refreshToken": self._refresh_token},
                headers=HEADERS,
            )
        except httpx.HTTPError:
            return False
        if response.status_code != 200:
            return False
        try:
            data = response.json()
        except ValueError:
            return False
        if not isinstance(data, dict) or not data.get("access_token"):
            return False
        self._apply_token_data(data)
        return True

    async def ensure_authenticated(self) -> bool:
        if self.is_token_likely_valid():
            return True
        async with self._auth_lock:
            if self.is_token_likely_valid():
                return True
            if await self.refresh_token():
                return True
            self._invalidate_access_token()
            return await self.login()

    async def test_connection(self) -> dict[str, Any]:
        await self.login()
        contracts = await self.fetch_contracts_list()
        count = len(contracts or [])
        if count:
            return {"ok": True, "message": f"Conexiune OK ({count} contracte găsite)"}
        user = await self.fetch_user_details()
        if isinstance(user, dict):
            return {"ok": True, "message": "Conexiune OK (cont fără contracte detectate)"}
        return {"ok": True, "message": "Conexiune OK"}

    async def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_payload: Any = None,
        optional: bool = False,
        auth: bool = True,
    ) -> Any:
        if auth:
            await self.ensure_authenticated()
        response = await self._client.request(
            method,
            url,
            params=params,
            json=json_payload,
            headers=self._auth_headers() if auth else HEADERS,
        )
        if response.status_code == 401 and auth:
            self._invalidate_access_token()
            await self.ensure_authenticated()
            response = await self._client.request(
                method,
                url,
                params=params,
                json=json_payload,
                headers=self._auth_headers(),
            )
        if response.status_code in {204, 404}:
            return None
        if response.status_code >= 400:
            if optional:
                log.debug("Optional E.ON endpoint failed: %s %s -> %s", method, url, response.status_code)
                return None
            message = self._extract_error_message(response, response.text)
            raise EonRomaniaError(message or f"E.ON API a răspuns cu HTTP {response.status_code}.")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return response.text

    @staticmethod
    def _extract_error_message(response: httpx.Response, fallback: str = "") -> str:
        try:
            data = response.json()
        except ValueError:
            data = None
        if isinstance(data, dict):
            for key in ("message", "error", "description", "title", "detail"):
                value = data.get(key)
                if value:
                    return str(value)
            code = data.get("code")
            if code:
                return f"E.ON API error {code}"
        return str(fallback or "").strip()[:500]

    async def fetch_user_details(self) -> Any:
        return await self._request("GET", URL_USER_DETAILS, optional=True)

    async def fetch_contracts_list(
        self,
        *,
        partner_code: str | None = None,
        collective_contract: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if partner_code:
            params["partnerCode"] = partner_code
        if collective_contract:
            params["collectiveContract"] = collective_contract
        if limit is not None:
            params["limit"] = str(limit)
        payload = await self._request("GET", URL_CONTRACTS_LIST, params=params or None, optional=True)
        return [item for item in _list_payload(payload) if isinstance(item, dict)]

    async def fetch_contract_details(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_CONTRACT_DETAILS.format(account_contract=account_contract),
            params={"includeMeterReading": "true"},
            optional=True,
        )

    async def fetch_invoice_balance(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_INVOICE_BALANCE,
            params={"accountContract": account_contract},
            optional=True,
        )

    async def fetch_invoices_unpaid(self, account_contract: str) -> list[Any]:
        payload = await self._request(
            "GET",
            URL_INVOICES_UNPAID,
            params={"accountContract": account_contract, "status": "unpaid"},
            optional=True,
        )
        return _list_payload(payload)

    async def fetch_meter_index(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_METER_INDEX.format(account_contract=account_contract),
            optional=True,
        )

    async def fetch_consumption_convention(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_CONSUMPTION_CONVENTION.format(account_contract=account_contract),
            optional=True,
        )

    async def fetch_graphic_consumption(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_GRAPHIC_CONSUMPTION.format(account_contract=account_contract),
            optional=True,
        )

    async def fetch_meter_history(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_METER_HISTORY.format(account_contract=account_contract),
            optional=True,
        )

    async def fetch_payments(self, account_contract: str, max_pages: int = 3) -> list[Any]:
        return await self._paginated_request(
            URL_PAYMENT_LIST,
            {"accountContract": account_contract},
            max_pages=max_pages,
            optional=True,
        )

    async def fetch_invoices_prosum(self, account_contract: str, max_pages: int = 3) -> list[Any]:
        return await self._paginated_request(
            URL_INVOICES_PROSUM,
            {"accountContract": account_contract},
            max_pages=max_pages,
            optional=True,
        )

    async def fetch_invoice_balance_prosum(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_INVOICE_BALANCE_PROSUM,
            params={"accountContract": account_contract},
            optional=True,
        )

    async def fetch_rescheduling_plans(self, account_contract: str) -> Any:
        return await self._request(
            "GET",
            URL_RESCHEDULING_PLANS,
            params={"accountContract": account_contract},
            optional=True,
        )

    async def _paginated_request(
        self,
        base_url: str,
        params: dict[str, Any],
        *,
        list_key: str = "list",
        max_pages: int = 3,
        optional: bool = True,
    ) -> list[Any]:
        results: list[Any] = []
        page = 1
        while page <= max(1, int(max_pages or 1)):
            payload = await self._request(
                "GET",
                base_url,
                params={**params, "page": page},
                optional=optional,
            )
            if not isinstance(payload, dict):
                break
            chunk = payload.get(list_key)
            if isinstance(chunk, list):
                results.extend(chunk)
            if not payload.get("hasNext"):
                break
            page += 1
        return results

    async def fetch_contract_bundle(self, contract: dict[str, Any]) -> dict[str, Any]:
        account_contract = str(contract.get("accountContract") or "").strip()
        if not account_contract:
            return {}
        metadata = self.contract_metadata.get(account_contract) if isinstance(self.contract_metadata, dict) else {}
        is_collective = _looks_collective(contract, metadata if isinstance(metadata, dict) else None)
        base_tasks = {
            "contract_details": self.fetch_contract_details(account_contract),
            "invoice_balance": self.fetch_invoice_balance(account_contract),
            "invoices_unpaid": self.fetch_invoices_unpaid(account_contract),
            "meter_index": self.fetch_meter_index(account_contract),
            "consumption_convention": self.fetch_consumption_convention(account_contract),
        }
        labels = list(base_tasks.keys())
        values = await asyncio.gather(*base_tasks.values(), return_exceptions=True)
        bundle = {
            "account_contract": account_contract,
            "summary": contract,
            "is_collective": is_collective,
        }
        for label, value in zip(labels, values):
            bundle[label] = None if isinstance(value, Exception) else value

        if is_collective:
            subcontracts = await self.fetch_contracts_list(collective_contract=account_contract)
            bundle["subcontracts"] = subcontracts
            sub_results: list[dict[str, Any]] = []
            for subcontract in subcontracts:
                code = str(subcontract.get("accountContract") or "").strip()
                if not code:
                    continue
                sub_values = await asyncio.gather(
                    self.fetch_contract_details(code),
                    self.fetch_meter_index(code),
                    self.fetch_consumption_convention(code),
                    return_exceptions=True,
                )
                sub_results.append({
                    "account_contract": code,
                    "summary": subcontract,
                    "contract_details": None if isinstance(sub_values[0], Exception) else sub_values[0],
                    "meter_index": None if isinstance(sub_values[1], Exception) else sub_values[1],
                    "consumption_convention": None if isinstance(sub_values[2], Exception) else sub_values[2],
                })
            bundle["subcontract_details"] = sub_results

        if self.include_history:
            optional_tasks = {
                "graphic_consumption": self.fetch_graphic_consumption(account_contract),
                "meter_history": self.fetch_meter_history(account_contract),
                "payments": self.fetch_payments(account_contract),
                "invoices_prosum": self.fetch_invoices_prosum(account_contract),
                "invoice_balance_prosum": self.fetch_invoice_balance_prosum(account_contract),
                "rescheduling_plans": self.fetch_rescheduling_plans(account_contract),
            }
            optional_labels = list(optional_tasks.keys())
            optional_values = await asyncio.gather(*optional_tasks.values(), return_exceptions=True)
            for label, value in zip(optional_labels, optional_values):
                bundle[label] = None if isinstance(value, Exception) else value

        return bundle

    async def fetch_all(self) -> dict[str, Any]:
        await self.ensure_authenticated()
        contracts = await self.fetch_contracts_list()
        selected = set(self.selected_contracts)
        if selected:
            contracts = [contract for contract in contracts if str(contract.get("accountContract") or "") in selected]
        user_details = None
        if not contracts:
            user_details = await self.fetch_user_details()
        bundles: list[dict[str, Any]] = []
        for contract in contracts:
            bundle = await self.fetch_contract_bundle(contract)
            if bundle:
                bundles.append(bundle)
        return {
            "account": {"username": self.username, "user_details": user_details},
            "contracts": bundles,
            "available_contracts": contracts,
            "selected_contracts": self.selected_contracts,
            "fetched_at": time.time(),
        }

    async def fetch_light(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        """Refresh balances and meters for known contracts without re-listing all contracts."""
        await self.ensure_authenticated()
        contracts = list((cached or {}).get("available_contracts") or [])
        if not contracts:
            contracts = await self.fetch_contracts_list()
        selected = set(self.selected_contracts)
        if selected:
            contracts = [c for c in contracts if str(c.get("accountContract") or "") in selected]
        bundles: list[dict[str, Any]] = []
        for contract in contracts:
            account_contract = str(contract.get("accountContract") or "").strip()
            if not account_contract:
                continue
            values = await asyncio.gather(
                self.fetch_invoice_balance(account_contract),
                self.fetch_invoices_unpaid(account_contract),
                self.fetch_meter_index(account_contract),
                return_exceptions=True,
            )
            bundles.append({
                "account_contract": account_contract,
                "summary": contract,
                "invoice_balance": None if isinstance(values[0], Exception) else values[0],
                "invoices_unpaid": None if isinstance(values[1], Exception) else values[1],
                "meter_index": None if isinstance(values[2], Exception) else values[2],
            })
        base = dict(cached or {})
        base.update({
            "contracts": bundles,
            "available_contracts": contracts,
            "selected_contracts": self.selected_contracts,
            "fetched_at": time.time(),
        })
        return base
