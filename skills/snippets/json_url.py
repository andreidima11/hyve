# Snippet: fetch JSON from URL (stdlib only)
import urllib.request
import json

def fetch_json_url(url: str, timeout: int = 10) -> dict:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())
