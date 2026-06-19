"""Validate addon install parameters (no heavy imports)."""

from __future__ import annotations

import re

_DOCKER_IMAGE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*$")
_APT_PACKAGE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9.+@-]*$")


def validate_docker_image(image: str) -> str:
    value = str(image or "").strip()
    if not value or not _DOCKER_IMAGE_RE.match(value):
        raise ValueError(f"invalid docker image reference: {image!r}")
    return value


def validate_apt_packages(packages: list[str]) -> list[str]:
    out: list[str] = []
    for raw in packages:
        pkg = str(raw or "").strip()
        if not pkg:
            continue
        if not _APT_PACKAGE_RE.match(pkg):
            raise ValueError(f"invalid apt package name: {pkg!r}")
        out.append(pkg)
    return out
