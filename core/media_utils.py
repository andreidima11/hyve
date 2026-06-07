import base64
import ipaddress
import re
import socket
from io import BytesIO
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse

# Pre-compiled patterns reused on every chat response.
_RE_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\(https?://[^)\s]+\)\s*")
_RE_MULTI_NEWLINE = re.compile(r"\n{3,}")


def waha_media_url_reachable(media_url: str, api_url: str) -> str:
    """Rewrite WAHA media URLs so they use an externally reachable API host."""
    if not api_url or not media_url:
        return media_url
    api_url = api_url.rstrip("/")
    parsed = urlparse(media_url)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    if media_url.startswith("/"):
        return f"{api_url}{path}"
    parsed_api = urlparse(api_url)
    base = f"{parsed_api.scheme or 'http'}://{parsed_api.netloc or parsed_api.path}"
    return f"{base.rstrip('/')}{path}" if path.startswith("/") else f"{base}/{path}"


async def waha_download_media_as_base64(
    media_url: str,
    mimetype: str,
    cfg: Dict[str, Any],
    http_client: Any,
    log_line: Callable[[str, str, str, str], None],
) -> Optional[str]:
    """Download WAHA media and return base64 for images only."""
    if not media_url or not (mimetype or "").startswith("image/"):
        return None
    waha_cfg = cfg.get("waha") or {}
    api_url = waha_cfg.get("api_url") or ""
    media_url = waha_media_url_reachable(media_url, api_url)
    try:
        headers = {}
        if waha_cfg.get("api_key"):
            headers["X-Api-Key"] = waha_cfg["api_key"]
        response = await http_client.get(media_url, headers=headers, timeout=15.0)
        if response.status_code != 200:
            log_line("error", "🖼", "WAHA IMAGE", f"HTTP {response.status_code} for media URL")
            return None
        return base64.b64encode(response.content).decode("ascii")
    except Exception as exc:
        log_line("error", "🖼", "WAHA IMAGE", f"Download error: {type(exc).__name__}: {exc}")
        return None


def extract_markdown_image_urls(
    text: str,
    log_line: Callable[[str, str, str, str], None],
) -> List[Tuple[str, str]]:
    """Extract up to 6 safe public markdown image URLs from text."""
    if not text:
        return []

    def _is_safe_public_image_url(url: str) -> bool:
        try:
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                return False
            host = (parsed.hostname or "").strip().lower()
            if not host:
                return False
            if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal"):
                return False
            if host.endswith(".local") or host.endswith(".internal"):
                return False
            try:
                resolved = socket.gethostbyname(host)
                ip = ipaddress.ip_address(resolved)
                if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                    return False
            except Exception:
                pass
            path = (parsed.path or "").lower()
            if path.endswith(".svg"):
                return False
            if any(path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif")):
                return True
            if any(token in url.lower() for token in ("img", "image", "photo", "thumbnail", "media")):
                return True
            return False
        except Exception:
            return False

    pattern = re.compile(r"!\[([^\]]*)\]\((https?://[^)\s]+)\)")
    out: List[Tuple[str, str]] = []
    for match in pattern.finditer(text):
        image_url = match.group(2).strip()
        if not _is_safe_public_image_url(image_url):
            log_line("agent", "🛡️", "IMAGE_URL_SKIP", f"Skipping unsafe markdown image URL: {image_url[:100]}")
            continue
        out.append((match.group(1) or "", image_url))
        if len(out) >= 6:
            break
    return out


def strip_markdown_images(text: str) -> str:
    if not text:
        return text
    stripped = _RE_MARKDOWN_IMAGE.sub("", text)
    return _RE_MULTI_NEWLINE.sub("\n\n", stripped).strip()


async def waha_send_image(
    chat_id: str,
    image_url: str,
    caption: Optional[str],
    cfg: Dict[str, Any],
    http_client: Any,
    log_line: Callable[[str, str, str, str], None],
) -> str:
    """Send an image via WAHA. Returns ok, plus_required, or error."""
    waha_cfg = cfg.get("waha") or {}
    api_url = (waha_cfg.get("api_url") or "").rstrip("/")
    if not api_url:
        return "error"
    url = f"{api_url}/api/sendImage"
    headers = {"Content-Type": "application/json"}
    if waha_cfg.get("api_key"):
        headers["X-Api-Key"] = waha_cfg["api_key"]
    auth = (waha_cfg.get("username"), waha_cfg.get("password")) if waha_cfg.get("username") else None
    body = {
        "session": "default",
        "chatId": chat_id,
        "file": {
            "url": image_url,
            "filename": "image.jpg",
            "mimetype": "image/jpeg",
        },
    }
    if caption:
        body["caption"] = caption[:1024]
    try:
        response = await http_client.post(url, json=body, headers=headers, auth=auth, timeout=20.0)
        if response.status_code == 422:
            log_line("sys", "🖼", "WAHA SEND IMAGE", "Send image is available only in WAHA Plus – sending links as fallback.")
            return "plus_required"
        if response.status_code >= 400:
            log_line("error", "🖼", "WAHA SEND IMAGE", f"HTTP {response.status_code}: {response.text[:200]}")
            return "error"
        log_line("whatsapp", "🖼", "WAHA IMAGE SENT", image_url[:60] + "…")
        return "ok"
    except Exception as exc:
        log_line("error", "🖼", "WAHA SEND IMAGE", f"{type(exc).__name__}: {exc}")
        return "error"


def extract_document_text(data: bytes, filename: str) -> str:
    """Extract plain text from PDF, TXT, or DOCX."""
    name = (filename or "").lower()
    if name.endswith(".txt"):
        return data.decode("utf-8", errors="replace")
    if name.endswith(".pdf"):
        try:
            import pymupdf

            doc = pymupdf.open(stream=data, filetype="pdf")
            parts = []
            for page in doc:
                parts.append(page.get_text())
            doc.close()
            return "\n".join(parts)
        except Exception as exc:
            raise ValueError(f"PDF extraction failed: {exc}") from exc
    if name.endswith(".docx"):
        try:
            from docx import Document  # type: ignore[import-not-found]

            doc = Document(BytesIO(data))
            return "\n".join(paragraph.text for paragraph in doc.paragraphs)
        except Exception as exc:
            raise ValueError(f"DOCX extraction failed: {exc}") from exc
    raise ValueError("Unsupported format. Use .pdf, .txt, or .docx")
