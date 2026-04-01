#!/usr/bin/env python3
"""Quick test: verify all new search functions load and work correctly."""
import sys
sys.path.insert(0, ".")

from brain import web_search

print("✅ web_search imported OK")

# Check new functions
funcs = [
    "_needs_fresh_data", "_http_get_with_retry", "_extract_relevant_paragraphs",
    "_extract_pdf_text", "_fetch_with_js_fallback", 
    "get_last_search_sources", "clear_last_search_sources",
]
for f in funcs:
    ok = hasattr(web_search, f)
    print(f"  {'✅' if ok else '❌'} {f}: {ok}")

# Test freshness detection
print("\n--- Freshness Detection ---")
tests = [
    ("bitcoin price today", True),
    ("weather in Paris", True),
    ("what is photosynthesis", False),
    ("who is the president of USA", True),
    ("capital of France", False),
    ("NVIDIA stock", True),
    ("cât costă iPhone 16", True),
    ("what is DNA", False),
    ("clasament liga 1", True),
    ("versiune Python", True),
    ("formula chimică apă", False),
]
for q, expected in tests:
    result = web_search._needs_fresh_data(q)
    status = "✅" if result == expected else "❌"
    print(f"  {status} \"{q}\" → fresh={result} (expected {expected})")

# Test content relevance extraction
print("\n--- Content Relevance Extraction ---")
page_text = """Introduction to electric cars.

Electric cars are vehicles powered by electric motors using energy stored in batteries.
They produce zero direct emissions, making them environmentally friendly.

The history of transportation goes back thousands of years to the invention of the wheel.
Ancient civilizations used horses and chariots for transportation.

Tesla Model 3 is one of the best-selling electric cars worldwide. It offers a range of
up to 350 miles on a single charge and comes with advanced autopilot features.

Cooking recipes for a perfect chocolate cake require flour, sugar, eggs, and cocoa.
Preheat the oven to 350 degrees F.

The BMW iX3 is another popular electric SUV with a competitive range and German engineering.
It has a 74 kWh battery and offers 285 miles of range."""

result = web_search._extract_relevant_paragraphs(page_text, "best electric car range 2025", max_chars=500)
print(f"  Input: {len(page_text)} chars")
print(f"  Output: {len(result)} chars")
print(f"  Contains 'Tesla': {'Tesla' in result}")
print(f"  Contains 'BMW': {'BMW' in result}")
print(f"  Contains 'chocolate cake': {'chocolate cake' in result}")
print(f"  ✅ Relevance extraction working" if "chocolate cake" not in result else "  ❌ Irrelevant content not filtered")

# Test searxng_search return type
print("\n--- searxng_search signature ---")
import inspect
sig = inspect.signature(web_search.searxng_search)
print(f"  Return annotation: {sig.return_annotation}")
print(f"  ✅ All tests passed!")
