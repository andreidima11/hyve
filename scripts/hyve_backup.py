#!/usr/bin/env python3
"""Create, verify, and restore Hyve ``.hyvebak`` archives."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.backup.coordinator import BackupCoordinator, BackupOptions  # noqa: E402


def _default_output() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = ROOT / "output" / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"hyve-{stamp}.hyvebak"


def _build_options(args: argparse.Namespace) -> BackupOptions:
    return BackupOptions(
        include_optional=bool(args.include_optional),
        include_frigate_media=bool(args.include_frigate_media),
    )


def cmd_create(args: argparse.Namespace) -> int:
    dest = Path(args.output) if args.output else _default_output()
    coord = BackupCoordinator(ROOT)
    manifest = coord.create_backup(dest, _build_options(args))
    print(json.dumps({"path": str(dest), "files": len(manifest.files)}, indent=2))
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    coord = BackupCoordinator(ROOT)
    manifest = coord.verify_archive(Path(args.archive))
    print(
        json.dumps(
            {
                "ok": True,
                "hyve_version": manifest.hyve_version,
                "files": len(manifest.files),
                "created_at": manifest.created_at,
            },
            indent=2,
        )
    )
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    coord = BackupCoordinator(ROOT)
    result = coord.restore_backup(
        Path(args.archive),
        options=_build_options(args),
        refetch_addons=bool(args.refetch_addons),
        dry_run=bool(args.dry_run),
    )
    print(
        json.dumps(
            {
                "restored_files": len(result.restored_files),
                "pre_restore_backups": result.pre_restore_backups,
                "refetch_slugs": result.refetch_slugs,
                "refetch_log": result.refetch_log,
                "dry_run": bool(args.dry_run),
            },
            indent=2,
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Hyve backup / restore")
    sub = parser.add_subparsers(dest="command", required=True)

    create_p = sub.add_parser("create", help="Create a .hyvebak archive")
    create_p.add_argument("-o", "--output", help="Output path (.hyvebak)")
    create_p.add_argument(
        "--include-optional",
        action="store_true",
        help="Include chroma_db, sessions, static/generated, piper_models",
    )
    create_p.add_argument(
        "--include-frigate-media",
        action="store_true",
        help="Include output/addons/frigate/media (large)",
    )
    create_p.set_defaults(func=cmd_create)

    verify_p = sub.add_parser("verify", help="Verify archive checksums")
    verify_p.add_argument("archive", help="Path to .hyvebak")
    verify_p.set_defaults(func=cmd_verify)

    restore_p = sub.add_parser("restore", help="Restore from .hyvebak")
    restore_p.add_argument("archive", help="Path to .hyvebak")
    restore_p.add_argument(
        "--refetch-addons",
        action="store_true",
        help="Re-run add-on install for runtime artifacts after restore",
    )
    restore_p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and list files without writing to disk",
    )
    restore_p.add_argument("--include-optional", action="store_true")
    restore_p.add_argument("--include-frigate-media", action="store_true")
    restore_p.set_defaults(func=cmd_restore)

    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
