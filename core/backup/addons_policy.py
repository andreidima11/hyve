"""Include/exclude rules for add-on data under ``output/addons/<slug>/``."""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from pathlib import Path

# Paths relative to ``output/addons/<slug>/``.
GLOBAL_EXCLUDE_GLOBS = (
    "runtime/**",
    "node_modules/**",
    "log/**",
    "**/runtime/**",
    "**/node_modules/**",
    "**/log/**",
)

DEFAULT_REFETCH_SLUGS = frozenset(
    {
        "zigbee2mqtt",
        "frigate",
        "mosquitto",
        "piper",
        "whisper",
        "openwakeword",
        "cloudflared",
    }
)


@dataclass(frozen=True)
class SlugPolicy:
    include_globs: tuple[str, ...] = ()
    exclude_globs: tuple[str, ...] = ()
    refetch_artifacts: bool = True


@dataclass
class AddonsBackupOptions:
    include_frigate_media: bool = False


# Built-in policies (Phase 1). Future: merge manifest.json "backup" overrides.
SLUG_POLICIES: dict[str, SlugPolicy] = {
    "zigbee2mqtt": SlugPolicy(
        include_globs=("data/**",),
        exclude_globs=("runtime/**",),
    ),
    "frigate": SlugPolicy(
        include_globs=("config/**", "db/**"),
        exclude_globs=("media/**",),
    ),
    "mosquitto": SlugPolicy(
        include_globs=("data/**", "config/**"),
    ),
    "piper": SlugPolicy(
        include_globs=("data/**", "config/**"),
        exclude_globs=("models/**", "piper_models/**"),
    ),
    "cloudflared": SlugPolicy(
        include_globs=("data/**", "config/**"),
    ),
}


def _matches_any(rel_posix: str, patterns: tuple[str, ...]) -> bool:
    for pat in patterns:
        if pat.endswith("/**"):
            prefix = pat[:-3]
            if rel_posix == prefix or rel_posix.startswith(prefix + "/"):
                return True
        elif fnmatch.fnmatch(rel_posix, pat):
            return True
    return False


def addon_data_root(root: Path, slug: str) -> Path:
    return root / "output" / "addons" / slug


def list_addon_slugs_with_data(root: Path) -> list[str]:
    base = root / "output" / "addons"
    if not base.is_dir():
        return []
    return sorted(
        p.name
        for p in base.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    )


def should_include_addon_file(
    slug: str,
    rel_to_slug: Path,
    *,
    options: AddonsBackupOptions,
) -> bool:
    """Return True if ``rel_to_slug`` should be archived for ``slug``."""
    rel_posix = rel_to_slug.as_posix()
    if _matches_any(rel_posix, GLOBAL_EXCLUDE_GLOBS):
        return False

    policy = SLUG_POLICIES.get(slug)
    if policy is None:
        # Unknown add-on: include everything except global excludes.
        return True

    if policy.exclude_globs and _matches_any(rel_posix, policy.exclude_globs):
        if slug == "frigate" and options.include_frigate_media:
            if rel_posix == "media" or rel_posix.startswith("media/"):
                return True
        return False

    if not policy.include_globs:
        return True

    return _matches_any(rel_posix, policy.include_globs)


def iter_addon_files(
    root: Path,
    slug: str,
    *,
    options: AddonsBackupOptions,
) -> list[Path]:
    """Return absolute paths of files to include for ``slug``."""
    base = addon_data_root(root, slug)
    if not base.is_dir():
        return []
    out: list[Path] = []
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(base)
        if should_include_addon_file(slug, rel, options=options):
            out.append(path)
    return sorted(out)


def slugs_needing_artifact_refetch(slugs: list[str]) -> list[str]:
    """Slugs whose install method must re-run after a file restore."""
    out: list[str] = []
    for slug in slugs:
        policy = SLUG_POLICIES.get(slug)
        if policy is None or policy.refetch_artifacts or slug in DEFAULT_REFETCH_SLUGS:
            out.append(slug)
    return sorted(set(out))
