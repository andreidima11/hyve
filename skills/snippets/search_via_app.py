# Snippet: web search via SearXNG URL injected by app.
# The app passes _searxng_url (string) in input_data when SearXNG is enabled.
# Skills use urllib.request (stdlib) to query it — no third-party packages needed.
# The sandbox runs with policy=network so urllib/socket are allowed.

import urllib.request
import urllib.parse
import json

query = (input_data.get("query") or "").strip()
searxng_url = input_data.get("_searxng_url", "")
if not searxng_url:
    return {"success": False, "message": "Web search not available (SearXNG not configured).", "data": {}}

params = urllib.parse.urlencode({"q": query, "format": "json"})
url = f"{searxng_url.rstrip('/')}/search?{params}"
req = urllib.request.Request(url, headers={"User-Agent": "Memini/1.0"})
with urllib.request.urlopen(req, timeout=10) as resp:
    data = json.loads(resp.read().decode())
results = data.get("results", [])[:10]
formatted = []
for r in results:
    title = r.get("title", "")
    content = r.get("content", "")
    link = r.get("url", "")
    formatted.append({"title": title, "content": content, "url": link})
return {"success": True, "message": f"Found {len(formatted)} results for '{query}'.", "data": {"results": formatted}}
