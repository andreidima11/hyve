"""Search and web-reading utilities extracted from `brain.toolbox`."""

import asyncio
import hashlib
import html
import re
import time
import urllib.parse
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import httpx
import settings as settings_mod
from logger import log_line


# ---------------------------------------------------------------------------
# SOURCE AUTHORITY RANKING
# ---------------------------------------------------------------------------

_DOMAIN_AUTHORITY = {
    ".gov": 0.95,
    "gov.ro": 0.95,
    ".edu": 0.90,
    ".ac.uk": 0.85,
    "bbc.com": 0.92,
    "bbc.co.uk": 0.92,
    "reuters.com": 0.92,
    "apnews.com": 0.90,
    "theguardian.com": 0.88,
    "nytimes.com": 0.88,
    "washingtonpost.com": 0.88,
    "economist.com": 0.85,
    "wikipedia.org": 0.87,
    "arxiv.org": 0.85,
    "scholar.google.com": 0.85,
    "researchgate.net": 0.80,
    "stackoverflow.com": 0.82,
    "github.com": 0.80,
    "w3.org": 0.90,
    "bloomberg.com": 0.83,
    "cnbc.com": 0.82,
    "forbes.com": 0.80,
    "informat.ro": 0.82,
}


def _get_domain_authority(url: str) -> float:
    if not url:
        return 0.3
    url_lower = url.lower()
    for domain, score in _DOMAIN_AUTHORITY.items():
        if domain in url_lower:
            return score
    if ".gov" in url_lower:
        return 0.85
    if ".edu" in url_lower:
        return 0.80
    if ".org" in url_lower:
        return 0.65
    if ".com" in url_lower:
        return 0.50
    if ".co." in url_lower:
        return 0.55
    return 0.40


# ---------------------------------------------------------------------------
# SEARCH STATE
# ---------------------------------------------------------------------------

import threading as _threading

_SEARCH_CACHE: OrderedDict = OrderedDict()
_SEARCH_CACHE_LOCK = _threading.Lock()
_SEARCH_CACHE_MAX_SIZE = 50
_SEARCH_CACHE_TTL_SECONDS = 300
_last_search_sources: List[Dict] = []


def get_last_search_sources() -> List[Dict]:
    return list(_last_search_sources)


def set_last_search_sources(sources: List[Dict]) -> None:
    global _last_search_sources
    _last_search_sources = list(sources or [])


def clear_last_search_sources() -> None:
    global _last_search_sources
    _last_search_sources = []


def _search_cache_key(query: str) -> str:
    normalized = query.strip().lower()
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def _search_cache_get(query: str) -> Optional[Tuple[str, List[str]]]:
    key = _search_cache_key(query)
    with _SEARCH_CACHE_LOCK:
        if key not in _SEARCH_CACHE:
            return None
        result, status_msgs, timestamp = _SEARCH_CACHE[key]
        if time.time() - timestamp > _SEARCH_CACHE_TTL_SECONDS:
            del _SEARCH_CACHE[key]
            return None
        _SEARCH_CACHE.move_to_end(key)
    log_line("ha", "💾", "CACHE_HIT", f"Using cached search for: '{query[:50]}'")
    return result, status_msgs


def _search_cache_set(query: str, result: str, status_msgs: List[str]) -> None:
    key = _search_cache_key(query)
    with _SEARCH_CACHE_LOCK:
        while len(_SEARCH_CACHE) >= _SEARCH_CACHE_MAX_SIZE:
            _SEARCH_CACHE.popitem(last=False)
        _SEARCH_CACHE[key] = (result, status_msgs, time.time())


# ---------------------------------------------------------------------------
# WEB FETCH HELPERS
# ---------------------------------------------------------------------------


def _is_internal_url(url: str) -> bool:
    try:
        import ipaddress as _ipaddr
        import socket as _socket
        from urllib.parse import urlparse as _urlparse

        parsed = _urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return True
        # Block userinfo tricks like http://attacker.com@127.0.0.1/
        if parsed.username or "@" in (parsed.netloc or ""):
            return True
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal"):
            return True
        if hostname.endswith(".local") or hostname.endswith(".internal"):
            return True
        # Block cloud metadata endpoints
        if hostname in ("169.254.169.254", "metadata.google.internal", "100.100.100.200"):
            return True
        try:
            resolved = _socket.gethostbyname(hostname)
            ip = _ipaddr.ip_address(resolved)
            return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
        except (OSError, ValueError):
            # DNS resolution failed — block by default (safe side)
            return True
    except Exception:
        return True


def _extract_main_content(html_raw: str) -> Optional[str]:
    try:
        import trafilatura  # type: ignore[import-not-found]

        out = trafilatura.extract(
            html_raw,
            include_comments=False,
            include_links=False,
            include_formatting=False,
        )
        if out and len(out.strip()) > 80:
            return out.strip()
    except ImportError:
        pass
    except Exception:
        pass
    return None


async def _fetch_page_html(url: str, timeout: float = 10.0, max_bytes: int = 2_000_000) -> Optional[str]:
    if not url or not url.startswith("http"):
        return None
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
            last_resp = None
            for _ in range(2):
                resp = await client.get(url)
                last_resp = resp
                chain = list(getattr(resp, "history", []) or []) + [resp]
                if any(_is_internal_url(str(r.url)) for r in chain):
                    log_line("agent", "🛡️", "SSRF_BLOCK", f"Blocked redirect chain for HTML fetch: {url[:80]}")
                    return None
                if resp.status_code == 200:
                    break
            if last_resp is None:
                return None
            raw = last_resp.text
            if not raw or len(raw) > max_bytes:
                return None
            return raw
    except Exception:
        return None


def _extract_by_selectors(html_raw: str, selectors_str: str, attr: Optional[str] = None) -> Tuple[bool, Any]:
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return (False, "BeautifulSoup is not installed. Install with: pip install beautifulsoup4")
    sel_list = [s.strip() for s in selectors_str.split(",") if s.strip()]
    if not sel_list:
        return (False, "No selectors provided. Use comma-separated CSS selectors (e.g. h1, .price, #main).")
    try:
        soup = BeautifulSoup(html_raw, "html.parser")
    except Exception as exc:
        return (False, f"Failed to parse HTML: {exc}")
    out = []
    for sel in sel_list:
        try:
            elements = soup.select(sel)
        except Exception as exc:
            out.append({"selector": sel, "error": str(exc), "matches": []})
            continue
        matches = []
        for el in elements[:20]:
            if attr:
                val = el.get(attr) if hasattr(el, "get") else None
                if val is not None:
                    matches.append(str(val).strip())
            else:
                matches.append(el.get_text(separator=" ", strip=True))
        out.append({"selector": sel, "matches": [m for m in matches if m]})
    return (True, out)


async def _fetch_with_js_fallback(url: str, timeout: float = 15.0) -> Optional[str]:
    try:
        from playwright.async_api import async_playwright  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(url, timeout=int(timeout * 1000), wait_until="domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            html_content = await page.content()
            await browser.close()
        if not html_content or len(html_content) < 100:
            return None
        text = _extract_main_content(html_content)
        if not text:
            clean = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", html_content, flags=re.IGNORECASE)
            clean = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", clean, flags=re.IGNORECASE)
            clean = re.sub(r"<[^>]+>", " ", clean)
            text = html.unescape(clean)
            text = re.sub(r"\s+", " ", text.strip()).strip()
        return text if text and len(text) > 50 else None
    except Exception as exc:
        log_line("ha", "⚠️", "JS_RENDER", f"Playwright fallback failed: {type(exc).__name__}: {exc}")
        return None


def _extract_pdf_text(pdf_bytes: bytes, max_chars: int = 3500) -> Optional[str]:
    if not pdf_bytes:
        return None
    text = None
    try:
        import fitz

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        pages_text = []
        for page_num in range(min(len(doc), 10)):
            page_text = doc[page_num].get_text().strip()
            if page_text:
                pages_text.append(page_text)
        doc.close()
        if pages_text:
            text = "\n\n".join(pages_text)
    except ImportError:
        pass
    except Exception as exc:
        log_line("ha", "⚠️", "PDF_EXTRACT", f"pymupdf failed: {exc}")
    if not text:
        try:
            import io
            import pdfplumber

            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                pages_text = []
                for page in pdf.pages[:10]:
                    page_text = page.extract_text()
                    if page_text:
                        pages_text.append(page_text.strip())
                if pages_text:
                    text = "\n\n".join(pages_text)
        except ImportError:
            pass
        except Exception as exc:
            log_line("ha", "⚠️", "PDF_EXTRACT", f"pdfplumber failed: {exc}")
    if not text:
        return "[PDF document — could not extract text. Install pymupdf or pdfplumber.]"
    text = re.sub(r"\s+", " ", text.strip())
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n\n[PDF content truncated to {max_chars} characters.]"
    log_line("ha", "📄", "PDF_EXTRACT", f"Extracted {len(text)} chars from PDF")
    return text


async def _fetch_page_text(url: str, max_chars: int = 3500, timeout: float = 6.0) -> Optional[str]:
    if not url or not url.startswith("http"):
        return None
    is_pdf_url = url.lower().rstrip("/").endswith(".pdf")
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
            last_resp = None
            for _ in range(2):
                resp = await client.get(url)
                last_resp = resp
                chain = list(getattr(resp, "history", []) or []) + [resp]
                if any(_is_internal_url(str(r.url)) for r in chain):
                    log_line("agent", "🛡️", "SSRF_BLOCK", f"Blocked redirect chain for page fetch: {url[:80]}")
                    return None
                if resp.status_code == 200:
                    break
        if last_resp is None:
            return None
        content_type = (last_resp.headers.get("content-type") or "").lower()
        is_pdf = is_pdf_url or "application/pdf" in content_type
        if is_pdf:
            return _extract_pdf_text(last_resp.content, max_chars)
        raw = last_resp.text
        if not raw or len(raw) > 2_000_000:
            return None
        text = _extract_main_content(raw)
        if not text:
            raw = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", raw, flags=re.IGNORECASE)
            raw = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", raw, flags=re.IGNORECASE)
            raw = re.sub(r"<[^>]+>", " ", raw)
            text = html.unescape(raw)
        text = re.sub(r"\s+", " ", (text or "").strip()).strip()
        if (not text or len(text) < 100) and not is_pdf:
            js_text = await _fetch_with_js_fallback(url, timeout=min(timeout * 2, 15.0))
            if js_text and len(js_text) > len(text or ""):
                text = js_text
                log_line("ha", "🌐", "JS_RENDER", f"Used JS rendering for {url[:50]}, got {len(text)} chars")
        if not text:
            return None
        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n[Content truncated to {} characters.]".format(max_chars)
        return text
    except Exception:
        return None


# ---------------------------------------------------------------------------
# SEARCH RANKING AND FILTERING
# ---------------------------------------------------------------------------


def _detect_query_intent(query: str) -> str:
    query_lower = query.lower()
    if any(kw in query_lower for kw in ["news", "latest", "breaking", "today", "current", "recent", "happening"]):
        return "news"
    if any(kw in query_lower for kw in ["what is", "who is", "capital of", "cost of", "definition of", "when is", "where is", "how much", "how many", "list of"]):
        return "factual"
    if any(kw in query_lower for kw in ["compare", "difference", "analyze", "research", "study", "benefits", "drawbacks", "pros and cons", "vs"]):
        return "research"
    if any(kw in query_lower for kw in ["buy", "price", "where to buy", "shop", "purchase", "cost", "discount", "sale", "product"]):
        return "shopping"
    if any(kw in query_lower for kw in ["how to", "tutorial", "guide", "steps", "instructions", "help", "manual"]):
        return "navigation"
    return "generic"


def _build_result_metadata(result: Dict, position: int, query: str, confidence: float) -> Dict:
    url = (result.get("url") or "").strip()
    title = (result.get("title") or "").strip()
    snippet = (result.get("content") or "").strip()
    try:
        domain = url.split("/")[2] if "/" in url else ""
    except (IndexError, AttributeError):
        domain = ""
    source_type = "website"
    if "wikipedia" in domain.lower():
        source_type = "reference"
    elif any(news in domain.lower() for news in ["bbc", "reuters", "apnews", "guardian", "nytimes"]):
        source_type = "news"
    elif ".gov" in domain.lower():
        source_type = "government"
    elif ".edu" in domain.lower():
        source_type = "academic"
    elif "github" in domain.lower() or "stackoverflow" in domain.lower():
        source_type = "technical"
    authority = _get_domain_authority(url)
    return {
        "position": position,
        "domain": domain,
        "source_type": source_type,
        "authority_score": round(authority, 2),
        "confidence_score": round(confidence, 2),
        "snippet_length": len(snippet),
        "title_length": len(title),
        "has_url": bool(url),
    }


def _normalize_search_query(query: str) -> str:
    if not query or not query.strip():
        return query
    q = query.strip()
    q = re.sub(r"\b(acum|ora|now|at|la)\s+\d{1,2}:\d{2}(?::\d{2})?\b", " ", q, flags=re.IGNORECASE)
    q = re.sub(r"\d{1,2}:\d{2}(?::\d{2})?\s+\d{1,2}\s+\w+\s+\d{4}\s*$", " ", q, flags=re.IGNORECASE)
    q = re.sub(r"\s+", " ", q).strip()
    return q if q else query.strip()


def _detect_query_language(query: str) -> str:
    """Very small, character-based language hint for the SearXNG `language`
    parameter. Returns an ISO-639-1 code or ``"auto"``.

    We deliberately avoid large per-language word lists — the heuristic is just
    "which script/diacritics appear?" so it stays robust across topics.
    """
    q = (query or "")
    if not q.strip():
        return "auto"
    # Cyrillic / Greek / CJK shortcuts
    if re.search(r"[\u0400-\u04FF]", q):
        return "ru"
    if re.search(r"[\u0370-\u03FF]", q):
        return "el"
    if re.search(r"[\u3040-\u30FF]", q):
        return "ja"
    if re.search(r"[\u4E00-\u9FFF]", q):
        return "zh"
    if re.search(r"[\uAC00-\uD7AF]", q):
        return "ko"
    # Romanian-specific diacritics
    if re.search(r"[ăâîșşțţĂÂÎȘŞȚŢ]", q):
        return "ro"
    # German-specific
    if re.search(r"[äöüÄÖÜß]", q):
        return "de"
    # French-specific
    if re.search(r"[çéèêëàâùûôîïÇÉÈÊËÀÂÙÛÔÎÏ]", q):
        return "fr"
    # Spanish / Portuguese (overlapping diacritics, give up to "auto")
    if re.search(r"[ñÑ¿¡]", q):
        return "es"
    # Default to auto — let SearXNG decide
    return "auto"


def _searxng_defaults() -> dict:
    defaults = getattr(settings_mod, "DEFAULT_CONFIG", {}) or {}
    return (defaults.get("searxng") or {}) if isinstance(defaults, dict) else {}


def _is_snippet_quality_good(snippet: str, title: str = "") -> bool:
    if not snippet or len(snippet.strip()) < 50:
        return False
    snippet_lower = snippet.lower()
    noise_patterns = ["...", "click here", "read more", "subscribe", "sign up", "cookie", "privacy policy", "terms of service"]
    noise_count = sum(1 for pattern in noise_patterns if pattern in snippet_lower)
    if noise_count >= 2:
        return False
    word_count = len([w for w in snippet.split() if len(w) > 3])
    return word_count >= 5


def _rank_search_results(results: List[Dict]) -> List[Dict]:
    scored_results = []
    for idx, result in enumerate(results):
        score = 0
        score += (10 - idx) if idx < 10 else 1
        content = (result.get("content") or "").strip()
        snippet_len = min(len(content), 300)
        score += snippet_len / 10
        title = (result.get("title") or "").strip()
        if len(title) > 20:
            score += 10
        elif len(title) > 10:
            score += 5
        if result.get("url"):
            score += 5
        scored_results.append((score, result))
    scored_results.sort(key=lambda x: x[0], reverse=True)
    return [result for score, result in scored_results]


def _calculate_search_satisfaction(results: List[Dict]) -> float:
    if not results:
        return 0.0
    score = 0.0
    high_authority_count = 0
    for result in results:
        url = (result.get("url") or "").lower()
        if any(domain in url for domain in ["wikipedia.org", ".gov", ".edu", "bbc", "reuters"]):
            high_authority_count += 1
    if high_authority_count >= 1:
        score += 0.5
    elif len(results) >= 3:
        score += 0.3
    avg_snippet_len = sum(len(result.get("content") or "") for result in results) / len(results)
    if avg_snippet_len > 150:
        score += 0.3
    elif avg_snippet_len > 80:
        score += 0.15
    if len(results) >= 4:
        score += 0.2
    elif len(results) >= 2:
        score += 0.1
    return min(score, 1.0)


def _score_result_relevance(result: Dict, original_query: str) -> float:
    if not result or not original_query:
        return 0.0
    query_words = set(original_query.lower().split())
    title = (result.get("title") or "").lower()
    snippet = (result.get("content") or "").lower()
    url = (result.get("url") or "").lower()
    score = 0.0
    title_matches = sum(1 for word in query_words if word in title and len(word) > 2)
    title_density = title_matches / max(len(query_words), 1)
    score += min(0.4, title_density * 0.4)
    snippet_matches = sum(1 for word in query_words if word in snippet and len(word) > 2)
    snippet_density = snippet_matches / max(len(query_words), 1)
    score += min(0.3, snippet_density * 0.3)
    trusted_domains = [".wikipedia.org", ".gov", ".edu", "news", "bbc", "reuters", "ap.org"]
    if any(domain in url for domain in trusted_domains):
        score += 0.2
    elif url.count(".") >= 2:
        score += 0.1
    if len(snippet) > 100:
        score += 0.1
    elif len(snippet) > 50:
        score += 0.05
    return min(score, 1.0)


def _filter_by_relevance(results: List[Dict], original_query: str, threshold: float = 0.25) -> List[Dict]:
    if not results:
        return results
    scored = [(result, _score_result_relevance(result, original_query)) for result in results]
    filtered = [result for result, score in scored if score >= threshold]
    if not filtered:
        log_line("ha", "⚠️", "RELEVANCE_FILTER", "All results filtered (low relevance), keeping originals")
        return results
    if len(filtered) < len(results):
        log_line("ha", "🎯", "RELEVANCE_FILTER", f"Kept {len(filtered)}/{len(results)} relevant results")
    return filtered


def _calculate_adaptive_timeout(query: str, base_timeout: float = 10.0) -> float:
    words = query.split()
    word_count = len(words)
    avg_word_len = sum(len(w) for w in words) / max(word_count, 1)
    complexity = 0
    if word_count <= 3:
        complexity -= 2
    elif word_count >= 7:
        complexity += 2
    if avg_word_len > 6:
        complexity -= 1
    if any(keyword in query.lower() for keyword in ["compare", "analyze", "evaluate", "difference", "relationship", "impact"]):
        complexity += 1
    adjustment = min(max(complexity * 1.5, -3), 5)
    return max(5.0, min(base_timeout + adjustment, 15.0))


def _extract_direct_answer(result: Dict, query: str) -> Optional[str]:
    factual_patterns = ["what is", "who is", "capital of", "cost of", "when is", "where is", "how much", "what are", "definition of"]
    if not any(pattern in query.lower() for pattern in factual_patterns):
        return None
    snippet = (result.get("content") or "").strip()
    if not snippet:
        return None
    sentences = snippet.split(". ")
    if sentences:
        answer = sentences[0]
        if len(answer) < 300:
            return answer + ("." if not answer.endswith(".") else "")
    return None


def _deduplicate_results(results: List[Dict]) -> List[Dict]:
    if not results:
        return results
    seen_domains = set()
    seen_snippets = set()
    deduplicated = []
    for result in results:
        url = (result.get("url") or "").strip()
        try:
            domain = url.split("/")[2] if "/" in url else ""
        except (IndexError, AttributeError):
            domain = ""
        snippet = (result.get("content") or "").strip()[:100]
        snippet_hash = hashlib.md5(snippet.encode()).hexdigest()[:8] if snippet else ""
        if domain and domain in seen_domains:
            continue
        if snippet_hash and snippet_hash in seen_snippets:
            continue
        deduplicated.append(result)
        if domain:
            seen_domains.add(domain)
        if snippet_hash:
            seen_snippets.add(snippet_hash)
    if len(deduplicated) < len(results):
        log_line("ha", "🔄", "DEDUP", f"Removed {len(results) - len(deduplicated)} duplicates")
    return deduplicated


def _calculate_confidence(result: Dict, query: str, rank_position: int = 0) -> float:
    confidence = 0.5
    if rank_position == 0:
        confidence += 0.3
    elif rank_position == 1:
        confidence += 0.2
    elif rank_position <= 2:
        confidence += 0.1
    url = (result.get("url") or "").lower()
    if any(d in url for d in [".wikipedia.org", ".gov", ".edu", "bbc", "reuters", "ap.org"]):
        confidence += 0.2
    title = (result.get("title") or "").strip()
    if len(title) > 15 and not title.startswith("http"):
        confidence += 0.1
    snippet = (result.get("content") or "").strip()
    if len(snippet) > 150:
        confidence += 0.15
    elif len(snippet) > 50:
        confidence += 0.05
    return min(confidence, 1.0)


def _needs_fresh_data(query: str) -> bool:
    """Deprecated keyword-based freshness detector.

    Kept as a no-op stub because a few external scripts/tests still import it.
    The orchestrator no longer uses it to gate searches — the LLM decides when
    to call `search_web` based on the tool description and system prompt.
    """
    _ = query  # intentionally unused
    return True


async def _http_get_with_retry(url: str, timeout: float, max_retries: int = 2, headers: Optional[Dict[str, str]] = None) -> Optional[httpx.Response]:
    async with httpx.AsyncClient(timeout=timeout, headers=headers or {}, follow_redirects=True) as client:
        for attempt in range(max_retries + 1):
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return resp
                if resp.status_code in (429, 500, 502, 503) and attempt < max_retries:
                    wait = 1.0 * (2 ** attempt)
                    log_line("ha", "🔄", "HTTP_RETRY", f"HTTP {resp.status_code}, retry {attempt+1}/{max_retries} in {wait:.0f}s")
                    await asyncio.sleep(wait)
                    continue
                return resp
            except (httpx.TimeoutException, httpx.ConnectError) as exc:
                if attempt < max_retries:
                    wait = 1.0 * (2 ** attempt)
                    log_line("ha", "🔄", "HTTP_RETRY", f"{type(exc).__name__}, retry {attempt+1}/{max_retries} in {wait:.0f}s")
                    await asyncio.sleep(wait)
                    continue
                log_line("error", "⚠️", "HTTP_FAIL", f"{type(exc).__name__} after {max_retries + 1} attempts")
                return None
            except Exception:
                return None
    return None


def _extract_relevant_paragraphs(page_text: str, query: str, max_chars: int = 2500) -> str:
    if not page_text or not query:
        return (page_text or "")[:max_chars]
    paragraphs = re.split(r"\n{2,}|\n(?=.{80,})", page_text)
    if len(paragraphs) <= 1:
        paragraphs = page_text.split("\n")
    stop_words = {"the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "this", "that", "with", "from", "have", "been", "will", "what", "when", "how", "who", "which", "their", "would", "about", "there", "these", "some", "them"}
    query_words = {w.lower() for w in query.split() if len(w) > 2 and w.lower() not in stop_words}
    if not query_words:
        return page_text[:max_chars]
    scored = []
    for paragraph in paragraphs:
        clean = paragraph.strip()
        if len(clean) < 40:
            continue
        lower = clean.lower()
        matches = sum(1 for word in query_words if word in lower)
        length_bonus = min(len(clean) / 500, 0.5)
        score = matches + length_bonus
        if matches > 0:
            scored.append((score, clean))
    if not scored:
        return page_text[:max_chars]
    scored.sort(key=lambda x: x[0], reverse=True)
    result = []
    chars = 0
    for score, paragraph in scored:
        if chars + len(paragraph) + 2 > max_chars:
            if not result:
                result.append(paragraph[:max_chars])
            break
        result.append(paragraph)
        chars += len(paragraph) + 2
    extracted = "\n\n".join(result)
    if len(extracted) < len(page_text) * 0.7:
        log_line("ha", "✂️", "RELEVANCE_EXTRACT", f"Extracted {len(extracted)}/{len(page_text)} chars ({len(result)} paragraphs)")
    return extracted


# ---------------------------------------------------------------------------
# SEARCH ENGINES
# ---------------------------------------------------------------------------


async def searxng_search(query: str, max_results: int = 0) -> Tuple[Optional[str], List[str], List[Dict]]:
    query = _normalize_search_query(query or "")
    intent = _detect_query_intent(query)
    print(f"🎯 INTENT_DETECTION Detected intent: {intent}")
    log_line("ha", "🎯", "INTENT", f"Query intent: {intent}")
    intent_adjustments = {
        "news": {"prefer_authority": False, "prefer_recent": True, "fetch_pages": True},
        "factual": {"prefer_authority": True, "prefer_recent": False, "fetch_pages": True},
        "research": {"prefer_authority": True, "prefer_recent": False, "fetch_pages": True},
        "shopping": {"prefer_authority": False, "prefer_recent": True, "fetch_pages": False},
        "navigation": {"prefer_authority": True, "prefer_recent": False, "fetch_pages": True},
        "generic": {"prefer_authority": False, "prefer_recent": False, "fetch_pages": "auto"},
    }
    intent_params = intent_adjustments.get(intent, intent_adjustments["generic"])
    cached = _search_cache_get(query)
    if cached is not None:
        return cached[0], cached[1], []
    searxng = settings_mod.CFG.get("searxng", {})
    status_messages: List[str] = []
    if not searxng.get("enabled") or not searxng.get("url"):
        return None, status_messages, []
    defaults = _searxng_defaults()
    if max_results <= 0:
        max_results = int(searxng.get("max_search_results", defaults.get("max_search_results", 5)))
    base_timeout = float(searxng.get("search_timeout", defaults.get("search_timeout", 10)))
    search_timeout = _calculate_adaptive_timeout(query, base_timeout)
    if search_timeout != base_timeout:
        log_line("ha", "⏱️", "ADAPTIVE_TIMEOUT", f"Timeout: {search_timeout:.1f}s (complex query)")
    try:
        url_template = searxng["url"]
        if "%3Cquery%3E" in url_template:
            search_url = url_template.replace("%3Cquery%3E", urllib.parse.quote(query))
        elif "<query>" in url_template:
            search_url = url_template.replace("<query>", urllib.parse.quote(query))
        else:
            base = url_template.split("?")[0]
            search_url = f"{base}?q={urllib.parse.quote(query)}&format=json"
        # Engine selection: prefer engines that consistently return
        # *relevant* general-web results on typical self-hosted SearXNG instances.
        # (Bing / Google / Brave / Wikipedia often return empty or garbage
        # results; DuckDuckGo / Qwant / Startpage return clean, localised ones.)
        default_engines = searxng.get("engines") or "duckduckgo,qwant,startpage"
        if "engines=" not in search_url:
            sep = "&" if "?" in search_url else "?"
            search_url = f"{search_url}{sep}engines={urllib.parse.quote(default_engines)}"
        if "format=" not in search_url:
            search_url += "&format=json"
        # SafeSearch: default to moderate ("1"). Protects against adult/porn
        # results leaking into completely unrelated queries (e.g. Romanian
        # political queries that some engines blunder into). User can override
        # in the SearXNG URL (e.g. `&safesearch=0`).
        if "safesearch=" not in search_url:
            sep = "&" if "?" in search_url else "?"
            safe_level = str(searxng.get("safesearch", 1))
            search_url = f"{search_url}{sep}safesearch={urllib.parse.quote(safe_level)}"
        # Language hint: helps engines return locally relevant results.
        # Default = auto-detect from query characters; user can override.
        if "language=" not in search_url:
            detected_lang = searxng.get("language") or _detect_query_language(query)
            sep = "&" if "?" in search_url else "?"
            search_url = f"{search_url}{sep}language={urllib.parse.quote(detected_lang)}"
        log_line("ha", "🔎", "SEARXNG", f"Searching: '{query[:60]}'")
        resp = await _http_get_with_retry(search_url, timeout=search_timeout)
        if resp is None or resp.status_code != 200:
            http_code = resp.status_code if resp else "timeout"
            log_line("error", "⚠️", "SEARXNG", f"HTTP {http_code}")
            status_messages.append("Search error (HTTP)")
            return None, status_messages, []
        data = resp.json()
        results = data.get("results", [])[:max_results]
        if not results:
            log_line("ha", "🔎", "SEARXNG", "No results found")
            status_messages.append("No results")
            return None, status_messages, []
        filtered_results = []
        for result in results:
            content = (result.get("content") or "").strip()
            title = (result.get("title") or "").strip()
            if _is_snippet_quality_good(content, title):
                filtered_results.append(result)
        if not filtered_results:
            log_line("ha", "⚠️", "SNIPPET_FILTER", "All snippets filtered out (low quality), keeping originals")
            filtered_results = results
        elif len(filtered_results) < len(results):
            log_line("ha", "🎯", "SNIPPET_FILTER", f"Kept {len(filtered_results)}/{len(results)} quality snippets")
        deduplicated = _deduplicate_results(filtered_results)
        relevance_filtered = _filter_by_relevance(deduplicated, query)
        ranked_results = _rank_search_results(relevance_filtered)
        parts = []
        if ranked_results:
            direct_answer = _extract_direct_answer(ranked_results[0], query)
            if direct_answer:
                log_line("ha", "💡", "DIRECT_ANSWER", f"Extracted: {direct_answer[:60]}...")
                parts.append(f"📌 Direct Answer: {direct_answer}")
        for i, result in enumerate(ranked_results, 1):
            title = (result.get("title") or "")[:100]
            content = (result.get("content") or "").strip()[:400]
            url = (result.get("url") or "").strip()
            url_short = url[:100] if url else ""
            confidence = _calculate_confidence(result, query, i - 1)
            authority = _get_domain_authority(url)
            _build_result_metadata(result, i, query, confidence)
            line = f"[{i}] {title}"
            if content:
                line += f" — {content}"
            if url_short:
                line += f" (URL: {url_short})"
            if confidence >= 0.7:
                line += " ⭐"
            elif confidence < 0.5:
                line += " ⚠️"
            if authority >= 0.85:
                line += " 🔐"
            elif authority < 0.5:
                line += " ❓"
            parts.append(line)
        log_line("ha", "🔎", "SEARXNG", f"Found {len(ranked_results)} results (ranked)")
        status_messages.append(f"Found {len(ranked_results)} results")
        fetch_pages = searxng.get("fetch_pages", defaults.get("fetch_pages", True))
        max_pages = max(0, min(3, int(searxng.get("max_pages_to_fetch", defaults.get("max_pages_to_fetch", 2)))))
        fetch_pages_override = intent_params.get("fetch_pages")
        if isinstance(fetch_pages_override, bool):
            fetch_pages = fetch_pages_override
            log_line("ha", "🎯", "INTENT_OVERRIDE", f"Set fetch_pages={fetch_pages} for {intent} intent")
        search_satisfaction = _calculate_search_satisfaction(ranked_results)
        if search_satisfaction >= 0.75:
            fetch_pages = False
            log_line("ha", "✅", "ANTI_BLOCK", f"Satisfaction {search_satisfaction:.2f} sufficient, skipping page fetch")
        has_trusted_source = any(_get_domain_authority(result.get("url") or "") >= 0.85 for result in ranked_results)
        if has_trusted_source:
            max_pages = min(max_pages, 1)
            log_line("ha", "🔐", "ANTI_BLOCK", "Found trusted source, limiting page fetch to 1")
        should_fetch_pages = fetch_pages and max_pages > 0 and ranked_results
        if should_fetch_pages:
            total_snippet_chars = sum(len(result.get("content") or "") for result in ranked_results)
            if total_snippet_chars >= 600:
                log_line("ha", "⚡", "LAZY_FETCH", f"Snippets sufficient ({total_snippet_chars} chars) — skipping page fetch")
                should_fetch_pages = False
            else:
                log_line("ha", "📄", "FETCH_PAGES", f"Snippets sparse ({total_snippet_chars} chars) — fetching max {max_pages} ranked pages")
        if should_fetch_pages:
            seen_urls = set()
            pages_to_fetch = min(max_pages, 2)
            for result in ranked_results[:pages_to_fetch]:
                url = (result.get("url") or "").strip()
                if not url or url in seen_urls or not url.startswith("http"):
                    continue
                seen_urls.add(url)
                page_text = await _fetch_page_text(url)
                if page_text:
                    relevant_text = _extract_relevant_paragraphs(page_text, query)
                    title = (result.get("title") or "Page")[:80]
                    parts.append(f"\n--- Conținut pagină: {title} ---\n{relevant_text}")
                    try:
                        domain = url.split("/")[2] if "/" in url else url[:40]
                    except Exception:
                        domain = url[:40]
                    log_line("ha", "🔎", "SEARXNG", f"Fetched page: {url[:50]}...")
                    status_messages.append(f"Descărcat pagină: {domain}")
        sources_footer = "\n\n---\nSOURCES (cite using [N] in your answer):\n"
        for i, result in enumerate(ranked_results, 1):
            title = (result.get("title") or "").strip()[:80]
            url = (result.get("url") or "").strip()
            sources_footer += f"[{i}] {title} — {url}\n"
        parts.append(sources_footer)
        quality_note = ""
        if len(ranked_results) < 2:
            quality_note = "\n⚠️ Very few results found. Consider searching with different/broader keywords or reading a page for details."
        elif all(_calculate_confidence(result, query, i) < 0.5 for i, result in enumerate(ranked_results)):
            quality_note = "\n⚠️ Low confidence results. Consider reading a page (read_web_page) for more details, or searching with refined terms."
        if quality_note:
            parts.append(quality_note)
        structured_sources = []
        for i, result in enumerate(ranked_results, 1):
            url = (result.get("url") or "").strip()
            title = (result.get("title") or "").strip()[:80]
            snippet = (result.get("content") or "").strip()[:120]
            try:
                domain = url.split("/")[2] if "/" in url else ""
            except Exception:
                domain = ""
            structured_sources.append({
                "index": i,
                "title": title,
                "url": url,
                "domain": domain,
                "snippet": snippet,
                "authority": round(_get_domain_authority(url), 2),
            })
        result_text = "\n".join(parts)
        _search_cache_set(query, result_text, status_messages)
        return result_text, status_messages, structured_sources
    except Exception as exc:
        log_line("error", "⚠️", "SEARXNG", f"{type(exc).__name__}: {exc}")
        status_messages.append(f"Error: {type(exc).__name__}")
        return None, status_messages, []


async def searxng_search_images(query: str, max_results: int = 6) -> Tuple[Optional[str], List[str]]:
    query = _normalize_search_query(query or "")
    searxng = settings_mod.CFG.get("searxng", {})
    status_messages: List[str] = []
    if not searxng.get("enabled") or not searxng.get("url"):
        return None, status_messages
    defaults = _searxng_defaults()
    search_timeout = float(searxng.get("search_timeout", defaults.get("search_timeout", 10)))
    max_results = max(1, min(10, int(max_results)))
    try:
        url_template = searxng["url"]
        if "%3Cquery%3E" in url_template:
            base_url = url_template.replace("%3Cquery%3E", urllib.parse.quote(query))
        elif "<query>" in url_template:
            base_url = url_template.replace("<query>", urllib.parse.quote(query))
        else:
            base = url_template.split("?")[0]
            base_url = f"{base}?q={urllib.parse.quote(query)}"
        search_url = f"{base_url}&format=json&categories=images" if "?" in base_url else f"{base_url}?format=json&categories=images"
        default_img_engines = searxng.get("image_engines") or "duckduckgo images,qwant images,wikicommons.images"
        if "engines=" not in search_url:
            search_url += f"&engines={urllib.parse.quote(default_img_engines)}"
        if "safesearch=" not in search_url:
            search_url += f"&safesearch={urllib.parse.quote(str(searxng.get('safesearch', 1)))}"
        if "language=" not in search_url:
            search_url += f"&language={urllib.parse.quote(searxng.get('language') or _detect_query_language(query))}"
        log_line("ha", "🖼️", "SEARXNG_IMAGES", f"Searching images: '{query[:50]}'")
        async with httpx.AsyncClient(timeout=search_timeout, follow_redirects=True) as client:
            resp = await client.get(search_url)
        if resp.status_code != 200:
            log_line("error", "⚠️", "SEARXNG_IMAGES", f"HTTP {resp.status_code}")
            return None, status_messages
        data = resp.json()
        results = data.get("results", [])[:max_results]
        if not results:
            log_line("ha", "🖼️", "SEARXNG_IMAGES", "No image results")
            return None, status_messages
        parts = ["Image search results. Include at least one image in your reply using markdown: ![description](IMAGE_URL)\n"]
        sec_cfg = settings_mod.CFG.get("security") or {}
        block_private = sec_cfg.get("block_private_image_urls", True)
        for i, result in enumerate(results, 1):
            img_url = (result.get("img_src") or result.get("thumbnail_src") or "").strip()
            if not img_url or not img_url.startswith("http"):
                continue
            if block_private and _is_internal_url(img_url):
                log_line("agent", "🛡️", "IMAGE_URL_BLOCK", f"Blocked private image URL: {img_url[:100]}")
                continue
            title = (result.get("title") or result.get("content") or "Image")[:80]
            parts.append(f"[{i}] {title}\nIMAGE_URL: {img_url}")
        if len(parts) <= 1:
            return None, status_messages
        log_line("ha", "🖼️", "SEARXNG_IMAGES", f"Found {len(parts) - 1} images")
        return "\n".join(parts), status_messages
    except Exception as exc:
        log_line("error", "⚠️", "SEARXNG_IMAGES", f"{type(exc).__name__}: {exc}")
        return None, status_messages
