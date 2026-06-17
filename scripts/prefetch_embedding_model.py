#!/usr/bin/env python3
"""Download the configured memory embedding model into the local HuggingFace cache."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Prefetch Hyve memory embedding model(s).")
    parser.add_argument(
        "--model",
        default="",
        help="Override model id (default: config.json librarian.model_name)",
    )
    parser.add_argument(
        "--include-fallback",
        action="store_true",
        help="Also cache sentence-transformers/all-MiniLM-L6-v2",
    )
    args = parser.parse_args()

    import core.settings as settings
    from core.storage import prefetch_embedding_model

    settings.load_config()
    primary = prefetch_embedding_model(args.model or None)
    print(f"Cached: {primary['model_name']}")

    if args.include_fallback:
        fallback = prefetch_embedding_model("sentence-transformers/all-MiniLM-L6-v2")
        print(f"Cached: {fallback['model_name']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
