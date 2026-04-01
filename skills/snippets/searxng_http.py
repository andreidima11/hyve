# Snippet: query SearXNG via HTTP (stdlib). base_url = app config (searxng.url) — injected when generating.
import urllib.request
import urllib.parse
import json

def searx_search(query: str, base_url: str = "{{SEARXNG_APP_URL}}", timeout: int = 10) -> list:
    params = {"q": query, "format": "json"}
    url = f"{base_url.rstrip('/')}/search?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return data.get("results", [])
