"""Async client for the Rețele Electrice România Salesforce portal.

Adapted from the cnecrea/reteleelectrice Home Assistant integration
(MIT licensed) for use as a standalone Hyve integration provider.

Authenticates against the Salesforce Experience Cloud at
``contulmeu.reteleelectrice.ro`` via the Visualforce login page, then
issues Aura action calls and Visualforce A4J proxy calls to retrieve
POD data, meter readings and outage information.

License gating from upstream is intentionally omitted — Hyve already
handles access control for integrations through its own auth layer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timedelta
from typing import Any

import aiohttp
from bs4 import BeautifulSoup

log = logging.getLogger("reteleelectrice")

BASE_URL = "https://contulmeu.reteleelectrice.ro"
LOGIN_PAGE = f"{BASE_URL}/PEDRO_SiteLogin"
AURA_URL = f"{BASE_URL}/s/sfsites/aura"

AURA_FWUID = (
    "TXFWNVprQUZzQnEtNXVXYTFLQ2ppdzJEa1N5enhOU3R5QWl2VzNveFZTbGcxMy4t"
    "MjE0NzQ4MzY0OC4xMzEwNzIwMA"
)
AURA_APP_UID = "1537_wmTAUxhOaM_47EClrN56Dw"

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8,"
        "application/signed-exchange;v=b3;q=0.7"
    ),
    "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
}

VF_PAGE_MAP: dict[str, str] = {
    "RetriveSingleSelf": "PED_ProxyCallWSAsynSingleSelf_VF",
    "PowerOutages": "PED_ProxyCallWSAsynPowerOutages_VF",
    "FindOutMeterHistoryData": "PED_ProxyCallWSAsync_SmartMeter_Vf",
    "FindOutMeterCurrentData": "PED_ProxyCallWSAsynSmartMeterCurrentData",
    "ReqMeterInstantData": "PED_ProxyCallWSAsynSmartMeterIstantData",
    "FindOutMeterInstantData": "PED_ProxyCallWSAsynSmartMeterIstantData",
    "queryPOD": "PED_ProxyCallWSAsync_Curve_VF",
}

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)
VF_TIMEOUT = aiohttp.ClientTimeout(total=60)


class ReteleElectriceError(Exception):
    """Raised when the Rețele Electrice portal cannot be queried."""


class ReteleElectriceAuthError(ReteleElectriceError):
    """Raised when authentication fails."""


class ReteleElectriceClient:
    """Async client for the Rețele Electrice România Salesforce portal."""

    def __init__(
        self,
        username: str,
        password: str,
        *,
        timeout: float = 30.0,
        selected_pods: list[str] | None = None,
    ) -> None:
        self._username = str(username or "").strip()
        self._password = str(password or "").strip()
        self._timeout = float(timeout or 30.0)
        self._selected_pods = [str(p).strip() for p in (selected_pods or []) if str(p).strip()] or None
        self._session: aiohttp.ClientSession | None = None
        self._cookie_jar = aiohttp.CookieJar(unsafe=True)
        self._aura_token: str | None = None
        self._action_counter = 0
        self._logged_in = False
        # Cache for cnp/cui (looked up once after login).
        self._cnp: str = ""
        self._cui: str = ""

    async def __aenter__(self) -> "ReteleElectriceClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                cookie_jar=self._cookie_jar,
                headers=BROWSER_HEADERS,
            )
        return self._session

    # ------------------------------------------------------------------
    # Login (Salesforce Visualforce)
    # ------------------------------------------------------------------

    async def login(self) -> bool:
        if not self._username or not self._password:
            raise ReteleElectriceAuthError("Email și parolă sunt obligatorii.")
        session = self._get_session()
        self._logged_in = False
        login_url = (
            f"{LOGIN_PAGE}?startURL=%2Fs%2F"
            f"&refURL=https%3A%2F%2Fcontulmeu.reteleelectrice.ro%2Fs%2F"
        )
        try:
            async with session.get(login_url, allow_redirects=True, timeout=REQUEST_TIMEOUT) as resp:
                if resp.status != 200:
                    raise ReteleElectriceAuthError(f"Login page HTTP {resp.status}")
                html = await resp.text()
                login_page_url = str(resp.url)

            soup = BeautifulSoup(html, "html.parser")
            viewstate = self._extract_field(soup, "com.salesforce.visualforce.ViewState")
            viewstate_ver = self._extract_field(soup, "com.salesforce.visualforce.ViewStateVersion")
            viewstate_mac = self._extract_field(soup, "com.salesforce.visualforce.ViewStateMAC")
            if not viewstate:
                raise ReteleElectriceAuthError("ViewState absent în pagina de login.")

            form = soup.find("form", {"id": "loginPage:loginForm"}) or soup.find("form")
            form_id = form.get("id", "loginPage:loginForm") if form else "loginPage:loginForm"
            username_field = self._find_input_name(soup, ["username", "email"])
            password_field = self._find_input_name(soup, ["password", "pw"])
            submit_field = self._find_submit_name(soup)

            payload = {
                form_id: form_id,
                username_field: self._username,
                password_field: self._password,
                submit_field: submit_field,
                "com.salesforce.visualforce.ViewState": viewstate,
                "com.salesforce.visualforce.ViewStateVersion": viewstate_ver,
                "com.salesforce.visualforce.ViewStateMAC": viewstate_mac,
            }
            form_action = (
                f"{LOGIN_PAGE}?startURL=%2Fs%2F"
                f"&refURL=https%3A%2F%2Fcontulmeu.reteleelectrice.ro%2Fs%2F"
            )

            async with session.post(
                form_action,
                data=payload,
                headers={
                    **BROWSER_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": BASE_URL,
                    "Referer": login_page_url,
                    "Cache-Control": "max-age=0",
                },
                allow_redirects=False,
                timeout=REQUEST_TIMEOUT,
            ) as resp:
                post_html = await resp.text()

            frontdoor_url = None
            for pattern in (
                r"window\.location\.(?:replace|href)\s*[=\(]\s*['\"](https?://[^'\"]*frontdoor\.jsp[^'\"]*)['\"]",
                r"handleRedirect\(['\"](https?://[^'\"]*frontdoor\.jsp[^'\"]*)['\"]",
            ):
                m = re.search(pattern, post_html)
                if m:
                    frontdoor_url = m.group(1)
                    break
            if not frontdoor_url:
                # Common cause: invalid credentials → page reloads with error.
                if "Invalid" in post_html or "incorect" in post_html.lower():
                    raise ReteleElectriceAuthError("Email sau parolă incorectă.")
                raise ReteleElectriceAuthError("Nu am detectat redirect-ul Salesforce după login.")

            async with session.get(frontdoor_url, allow_redirects=True, timeout=REQUEST_TIMEOUT):
                pass

            async with session.get(f"{BASE_URL}/s/", allow_redirects=True, timeout=REQUEST_TIMEOUT) as resp:
                s_html = await resp.text()

            self._aura_token = self._extract_aura_token_from_cookies()
            if not self._aura_token:
                self._aura_token = self._extract_aura_token_from_html(s_html)
            if not self._aura_token:
                raise ReteleElectriceAuthError("Aura token nu a putut fi extras.")

            self._logged_in = True
            return True
        except ReteleElectriceAuthError:
            raise
        except aiohttp.ClientError as exc:
            raise ReteleElectriceAuthError(f"Eroare rețea la login: {exc}") from exc
        except asyncio.TimeoutError as exc:
            raise ReteleElectriceAuthError("Login a expirat (timeout).") from exc

    # ------------------------------------------------------------------
    # Aura helpers (high-level)
    # ------------------------------------------------------------------

    async def get_user_name(self) -> Any:
        return await self._aura_call(
            descriptor="apex://PED_Utility/ACTION$getUserName",
            calling_descriptor="markup://c:PED_CustomProfileHeader",
        )

    async def get_account_info(self) -> Any:
        return await self._aura_call(
            descriptor="apex://PED_Utility/ACTION$getAccountInfo",
            calling_descriptor="markup://c:PED_CustomProfileHeader",
        )

    async def get_contact_info(self) -> Any:
        return await self._aura_call(
            descriptor="apex://PED_Utility/ACTION$getContactInfo",
            calling_descriptor="markup://c:PED_CustomProfileHeader",
        )

    async def get_pods(self) -> Any:
        return await self._aura_call(
            descriptor="apex://PED_Utility/ACTION$getPODs",
            calling_descriptor="markup://c:PED_HomePage",
        )

    async def get_pod_details(self, pod_name: str) -> Any:
        return await self._aura_call(
            descriptor="apex://PED_POD_Details_Controller/ACTION$getUserDetailsPodInformation",
            calling_descriptor="markup://c:PED_POD_Details",
            params={"PodName": pod_name},
        )

    # ------------------------------------------------------------------
    # VF A4J proxy calls
    # ------------------------------------------------------------------

    async def get_reading_archive(
        self,
        pod_name: str,
        start_date: str = "",
        end_date: str = "",
    ) -> Any:
        if not start_date or not end_date:
            now = datetime.now()
            one_year_ago = now - timedelta(days=365)
            start_date = start_date or one_year_ago.strftime("%d/%m/%Y 00:00:00")
            end_date = end_date or now.strftime("%d/%m/%Y 23:59:59")
        await self._ensure_identity()
        if self._cnp:
            params = ["", "", self._cnp, pod_name, start_date, end_date]
        elif self._cui:
            params = ["", self._cui, "", pod_name, start_date, end_date]
        else:
            params = ["", "", "", pod_name, start_date, end_date]
        return await self._call_vf_ws("RetriveSingleSelf", params)

    async def get_power_outages(self, pod_name: str, language: str = "RO") -> Any:
        return await self._call_vf_ws("PowerOutages", [pod_name, language])

    async def get_smart_meter_data(
        self,
        pod_name: str,
        start_date: str = "",
        end_date: str = "",
    ) -> Any:
        await self._ensure_identity()
        if not start_date or not end_date:
            now = datetime.now()
            start = now - timedelta(days=90)
            start_date = start_date or start.strftime("%d/%m/%Y") + " 00:00:00"
            end_date = end_date or now.strftime("%d/%m/%Y") + " 00:00:00"
        return await self._call_vf_ws(
            "FindOutMeterHistoryData",
            [self._cnp, "", pod_name, start_date, end_date],
        )

    async def get_supplier_data(self, pod_name: str) -> Any:
        result = await self._call_vf_ws("queryPOD", [pod_name, "Client_Company"])
        return self._clean_type_info(result) if result is not None else None

    async def get_instant_values(self, pod_name: str) -> Any:
        await self._ensure_identity()
        params = [self._cnp, "", pod_name]
        req = await self._call_vf_ws("ReqMeterInstantData", params)
        if req is None:
            return {"status": "error", "step": "ReqMeterInstantData"}
        if isinstance(req, dict):
            status = str(req.get("Result") or req.get("status") or "")
            if "error" in status.lower():
                return req
        return await self._call_vf_ws("FindOutMeterInstantData", params)

    # ------------------------------------------------------------------
    # High-level fetch — used by the Hyve provider
    # ------------------------------------------------------------------

    async def fetch_all(self) -> dict[str, Any]:
        """Login (if needed) and pull a snapshot of every configured POD."""
        if not self._logged_in:
            await self.login()
        await self._ensure_identity()

        pods_raw = await self.get_pods() or []
        pods: list[dict[str, Any]] = []
        if isinstance(pods_raw, list):
            for entry in pods_raw:
                if isinstance(entry, dict):
                    pods.append(entry)
        elif isinstance(pods_raw, dict):
            for value in pods_raw.values():
                if isinstance(value, list):
                    for entry in value:
                        if isinstance(entry, dict):
                            pods.append(entry)

        account = await self.get_account_info()
        contact = await self.get_contact_info()
        user_name = await self.get_user_name()

        if self._selected_pods:
            wanted = set(self._selected_pods)
            pods = [
                p for p in pods
                if (p.get("Name") or p.get("POD__c") or "") in wanted
            ]

        snapshot: dict[str, Any] = {
            "account": account if isinstance(account, dict) else {},
            "contact": contact if isinstance(contact, dict) else {},
            "user_name": user_name if isinstance(user_name, str) else (
                user_name.get("name") if isinstance(user_name, dict) else ""
            ),
            "pods": [],
        }

        for pod in pods:
            pod_name = pod.get("Name") or pod.get("POD__c") or ""
            if not pod_name:
                continue
            pod_entry: dict[str, Any] = {
                "name": pod_name,
                "raw": pod,
            }
            try:
                pod_entry["details"] = await self.get_pod_details(pod_name)
            except Exception as exc:  # noqa: BLE001
                log.debug("get_pod_details(%s) failed: %s", pod_name, exc)
            try:
                pod_entry["outages"] = await self.get_power_outages(pod_name)
            except Exception as exc:  # noqa: BLE001
                log.debug("get_power_outages(%s) failed: %s", pod_name, exc)
            try:
                pod_entry["supplier"] = await self.get_supplier_data(pod_name)
            except Exception as exc:  # noqa: BLE001
                log.debug("get_supplier_data(%s) failed: %s", pod_name, exc)
            try:
                pod_entry["readings"] = await self.get_reading_archive(pod_name)
            except Exception as exc:  # noqa: BLE001
                log.debug("get_reading_archive(%s) failed: %s", pod_name, exc)

            is_smart_meter = bool(pod.get("Smart_meter__c") or pod.get("IsSmartMeter__c"))
            if is_smart_meter:
                try:
                    pod_entry["smart_meter"] = await self.get_smart_meter_data(pod_name)
                except Exception as exc:  # noqa: BLE001
                    log.debug("get_smart_meter_data(%s) failed: %s", pod_name, exc)
                try:
                    pod_entry["instant"] = await self.get_instant_values(pod_name)
                except Exception as exc:  # noqa: BLE001
                    log.debug("get_instant_values(%s) failed: %s", pod_name, exc)

            snapshot["pods"].append(pod_entry)

        return snapshot

    async def fetch_light(self, cached: dict[str, Any] | None = None) -> dict[str, Any]:
        """Refresh outages and instant readings for PODs already known from cache."""
        if not self._logged_in:
            await self.login()
        await self._ensure_identity()

        pod_entries = list((cached or {}).get("pods") or [])
        if not pod_entries:
            return await self.fetch_all()

        snapshot: dict[str, Any] = {
            "account": (cached or {}).get("account") or {},
            "contact": (cached or {}).get("contact") or {},
            "user_name": (cached or {}).get("user_name") or "",
            "pods": [],
        }
        for entry in pod_entries:
            pod_name = entry.get("name") or (entry.get("raw") or {}).get("Name") or (entry.get("raw") or {}).get("POD__c") or ""
            if not pod_name:
                continue
            pod_entry = dict(entry)
            try:
                pod_entry["outages"] = await self.get_power_outages(pod_name)
            except Exception as exc:
                log.debug("fetch_light outages(%s): %s", pod_name, exc)
            raw = entry.get("raw") or {}
            if raw.get("Smart_meter__c") or raw.get("IsSmartMeter__c"):
                try:
                    pod_entry["instant"] = await self.get_instant_values(pod_name)
                except Exception as exc:
                    log.debug("fetch_light instant(%s): %s", pod_name, exc)
            snapshot["pods"].append(pod_entry)
        return snapshot

    async def test_connection(self) -> dict[str, Any]:
        try:
            await self.login()
        except ReteleElectriceAuthError as exc:
            return {"ok": False, "message": str(exc)}
        try:
            pods = await self.get_pods() or []
            count = 0
            if isinstance(pods, list):
                count = sum(1 for p in pods if isinstance(p, dict))
            return {
                "ok": True,
                "message": f"Conectat. {count} POD(uri) găsite.",
                "details": {"pod_count": count},
            }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": f"Eroare la interogarea POD-urilor: {exc}"}

    # ------------------------------------------------------------------
    # Internal — Aura/VF call plumbing
    # ------------------------------------------------------------------

    async def _ensure_identity(self) -> None:
        if self._cnp or self._cui:
            return
        account = await self.get_account_info()
        if isinstance(account, dict):
            self._cnp = str(account.get("CNP__c") or account.get("Fiscal_Code__c") or "")
            self._cui = str(account.get("Univocal_Code__c") or "")

    async def _aura_call(
        self,
        descriptor: str,
        params: dict | None = None,
        calling_descriptor: str = "UNKNOWN",
    ) -> Any:
        if not self._aura_token:
            await self.login()
        session = self._get_session()
        self._action_counter += 1
        action = {
            "id": f"{self._action_counter};a",
            "descriptor": descriptor,
            "callingDescriptor": calling_descriptor,
            "params": params or {},
            "version": None,
        }
        message = json.dumps({"actions": [action]})
        context = json.dumps({
            "mode": "PROD",
            "fwuid": AURA_FWUID,
            "app": "siteforce:communityApp",
            "loaded": {
                "APPLICATION@markup://siteforce:communityApp": AURA_APP_UID,
            },
            "dn": [],
            "globals": {},
            "uad": True,
        })
        payload = {
            "message": message,
            "aura.context": context,
            "aura.pageURI": "/s/",
            "aura.token": self._aura_token,
        }
        try:
            async with session.post(
                AURA_URL,
                data=payload,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "*/*",
                    "Referer": f"{BASE_URL}/s/",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                },
                timeout=REQUEST_TIMEOUT,
            ) as resp:
                if resp.status != 200:
                    log.debug("Aura call HTTP %d for %s", resp.status, descriptor)
                    return None
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    return None
                actions = data.get("actions") or []
                if actions:
                    action_result = actions[0]
                    if action_result.get("state") == "SUCCESS":
                        return action_result.get("returnValue")
                    log.debug(
                        "Aura action failed: state=%s, error=%s",
                        action_result.get("state"),
                        action_result.get("error"),
                    )
                    self._logged_in = False
                return None
        except Exception as exc:  # noqa: BLE001
            log.debug("Aura call error for %s: %s", descriptor, exc)
            return None

    async def _call_vf_ws(self, method_name: str, method_params: list) -> Any:
        vf_page = VF_PAGE_MAP.get(method_name)
        if not vf_page:
            return {"status": "error", "method": method_name, "error": "unknown VF page"}
        session = self._get_session()
        vf_url = f"{BASE_URL}/{vf_page}"
        try:
            async with session.get(vf_url, timeout=REQUEST_TIMEOUT, allow_redirects=True) as resp:
                if resp.status != 200:
                    return {"status": "vf_page_error", "method": method_name, "code": resp.status}
                html = await resp.text()
        except Exception as exc:  # noqa: BLE001
            return {"status": "vf_get_failed", "method": method_name, "error": str(exc)}

        soup = BeautifulSoup(html, "html.parser")
        viewstate = self._extract_field(soup, "com.salesforce.visualforce.ViewState")
        viewstate_ver = self._extract_field(soup, "com.salesforce.visualforce.ViewStateVersion")
        viewstate_mac = self._extract_field(soup, "com.salesforce.visualforce.ViewStateMAC")
        if not viewstate:
            return {"status": "vf_no_viewstate", "method": method_name}

        form = soup.find("form")
        form_id = form.get("id", "j_id0:j_id2") if form else "j_id0:j_id2"
        form_action = form.get("action", f"/{vf_page}") if form else f"/{vf_page}"

        invoke_match = re.search(
            r"invoke\s*=\s*function\s*\(\s*\)\s*\{.*?"
            r"A4J\.AJAX\.Submit\s*\(\s*'([^']+)'\s*,\s*null\s*,\s*\{"
            r".*?'similarityGroupingId'\s*:\s*'([^']+)'"
            r".*?'([^']+)'\s*:\s*'([^']+)'",
            html,
            re.DOTALL,
        )
        if invoke_match:
            a4j_action_id = invoke_match.group(2)
        else:
            a4j_match = re.search(r"'(j_id\d+:j_id\d+:j_id\d+)'", html)
            a4j_action_id = a4j_match.group(1) if a4j_match else f"{form_id}:j_id3"

        params_string = ",".join(str(p) for p in method_params)
        post_data = {
            "AJAXREQUEST": "_viewRoot",
            form_id: form_id,
            "methodN": method_name,
            "params": params_string,
            "uniqueId": f"script_{int(time.time())}",
            "com.salesforce.visualforce.ViewState": viewstate,
            "com.salesforce.visualforce.ViewStateVersion": viewstate_ver,
            "com.salesforce.visualforce.ViewStateMAC": viewstate_mac,
            a4j_action_id: a4j_action_id,
        }
        viewstate_csrf = self._extract_field(soup, "com.salesforce.visualforce.ViewStateCSRF")
        if viewstate_csrf:
            post_data["com.salesforce.visualforce.ViewStateCSRF"] = viewstate_csrf

        post_url = f"{BASE_URL}{form_action}" if form_action.startswith("/") else form_action
        try:
            async with session.post(
                post_url,
                data=post_data,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Accept": "*/*",
                    "Referer": vf_url,
                    "Origin": BASE_URL,
                },
                timeout=VF_TIMEOUT,
            ) as resp2:
                if resp2.status != 200:
                    return {
                        "status": "vf_post_error",
                        "method": method_name,
                        "http_status": resp2.status,
                    }
                response_text = await resp2.text()
        except Exception as exc:  # noqa: BLE001
            return {"status": "vf_post_failed", "method": method_name, "error": str(exc)}

        result = self._parse_a4j_response(response_text)
        if result is not None:
            return result
        return {
            "status": "a4j_no_data_in_response",
            "method": method_name,
            "response_length": len(response_text),
        }

    @staticmethod
    def _parse_a4j_response(response_text: str) -> Any:
        json_patterns = [
            re.compile(r'\[(\{[^{]*?"sampleDate"[^]]*?\})\]'),
            re.compile(r'\[(\{[^{]*?"energyType"[^]]*?\})\]'),
            re.compile(r'(\{[^{]*?"errorCode"[^}]*?\})'),
            re.compile(r'(\{(?:[^{}]|\{[^{}]*\}){50,}\})'),
            re.compile(r'(\[(?:[^\[\]]|\[[^\[\]]*\]){50,}\])'),
        ]
        for pattern in json_patterns:
            m = pattern.search(response_text)
            if m:
                try:
                    return json.loads(m.group(0))
                except (json.JSONDecodeError, ValueError):
                    pass

        for cdata in re.findall(r'<!\[CDATA\[(.*?)\]\]>', response_text, re.DOTALL):
            try:
                return json.loads(cdata.strip())
            except (json.JSONDecodeError, ValueError):
                pass
            inner = re.search(r'[\[{].*[}\]]', cdata, re.DOTALL)
            if inner:
                try:
                    return json.loads(inner.group(0))
                except (json.JSONDecodeError, ValueError):
                    pass

        soup = BeautifulSoup(response_text, "html.parser")
        result_span = soup.find(id=re.compile(r"result", re.I))
        if result_span:
            text = result_span.get_text(strip=True)
            if text and len(text) > 5:
                try:
                    return json.loads(text)
                except (json.JSONDecodeError, ValueError):
                    if len(text) > 10:
                        return {"raw_result": text}

        pm_match = re.search(r'parent\.postMessage\s*\(\s*(\{[^}]+\})', response_text)
        if pm_match:
            try:
                return json.loads(pm_match.group(1))
            except (json.JSONDecodeError, ValueError):
                pass

        return None

    @classmethod
    def _clean_type_info(cls, data: Any) -> Any:
        if isinstance(data, dict):
            return {
                k: cls._clean_type_info(v)
                for k, v in data.items()
                if not k.endswith("_type_info")
                and k not in ("apex_schema_type_info", "field_order_type_info")
            }
        if isinstance(data, list):
            return [cls._clean_type_info(item) for item in data]
        return data

    # ------------------------------------------------------------------
    # HTML helpers
    # ------------------------------------------------------------------

    def _extract_aura_token_from_cookies(self) -> str | None:
        for cookie in self._cookie_jar:
            if cookie.key.startswith("__Host-ERIC_PROD"):
                return cookie.value
        return None

    def _extract_aura_token_from_html(self, html: str) -> str | None:
        m = re.search(r'jwt=(eyJ[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+)', html)
        if m:
            return m.group(1)
        cookie_name_match = re.search(r'"eikoocnekot"\s*:\s*"([^"]+)"', html)
        if cookie_name_match:
            cookie_name = cookie_name_match.group(1)
            for cookie in self._cookie_jar:
                if cookie.key == cookie_name:
                    return cookie.value
        return None

    @staticmethod
    def _extract_field(soup: BeautifulSoup, field_name: str) -> str | None:
        inp = soup.find("input", {"name": field_name})
        if inp:
            return inp.get("value", "")
        inp = soup.find("input", {"id": field_name})
        if inp:
            return inp.get("value", "")
        m = re.search(rf'name="{re.escape(field_name)}"[^>]*value="([^"]*)"', str(soup))
        return m.group(1) if m else None

    @staticmethod
    def _find_input_name(soup: BeautifulSoup, candidates: list[str]) -> str:
        for candidate in candidates:
            inp = soup.find("input", {"name": re.compile(candidate, re.I)})
            if inp:
                return inp.get("name", "")
            inp = soup.find("input", {"id": re.compile(candidate, re.I)})
            if inp:
                return inp.get("name") or inp.get("id", "")
        return f"loginPage:loginForm:{candidates[0]}"

    @staticmethod
    def _find_submit_name(soup: BeautifulSoup) -> str:
        submit = soup.find("input", {"type": "submit"})
        if submit and submit.get("name"):
            return submit.get("name")
        for inp in soup.find_all("input"):
            name = inp.get("name", "")
            if "j_id" in name and inp.get("value") == name:
                return name
        return "loginPage:loginForm:j_id25"
