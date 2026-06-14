"""S3-compatible backup upload."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core.backup.remote import env_or_config

log = logging.getLogger("backup.remote.s3")


def _client(cfg: dict[str, Any]):
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError("backup.remote.boto3_missing") from exc

    access = env_or_config(None, "HYVE_BACKUP_S3_ACCESS_KEY")
    secret = env_or_config(None, "HYVE_BACKUP_S3_SECRET_KEY")
    if not access or not secret:
        raise ValueError("backup.remote.s3_credentials_missing")

    kwargs: dict[str, Any] = {
        "aws_access_key_id": access,
        "aws_secret_access_key": secret,
    }
    region = str(cfg.get("region") or "").strip()
    endpoint = str(cfg.get("endpoint_url") or "").strip()
    if region:
        kwargs["region_name"] = region
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return boto3.client("s3", **kwargs)


def _object_key(cfg: dict[str, Any], filename: str) -> str:
    prefix = str(cfg.get("prefix") or "hyve/").strip()
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return f"{prefix}{filename}"


def upload_to_s3(local_path: Path, cfg: dict[str, Any], remote: dict[str, Any]) -> dict[str, Any]:
    bucket = str(cfg.get("bucket") or "").strip()
    if not bucket:
        raise ValueError("backup.remote.s3_bucket_missing")
    client = _client(cfg)
    key = _object_key(cfg, local_path.name)
    client.upload_file(str(local_path), bucket, key)
    deleted = []
    if remote.get("upload_on_create", True):
        deleted = prune_s3(cfg, int(remote.get("retention_count") or 0))
    return {"provider": "s3", "bucket": bucket, "key": key, "remote_deleted": deleted}


def test_s3(cfg: dict[str, Any]) -> dict[str, Any]:
    bucket = str(cfg.get("bucket") or "").strip()
    if not bucket:
        raise ValueError("backup.remote.s3_bucket_missing")
    client = _client(cfg)
    client.head_bucket(Bucket=bucket)
    return {"ok": True, "provider": "s3", "bucket": bucket}


def _list_objects(client, bucket: str, prefix: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    token = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = client.list_objects_v2(**kwargs)
        for item in resp.get("Contents") or []:
            items.append(dict(item))
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return items


def _list_keys(client, bucket: str, prefix: str) -> list[str]:
    return [str(item["Key"]) for item in _list_objects(client, bucket, prefix) if item.get("Key")]


def list_s3_archives(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    from core.backup.remote.names import is_backup_filename

    bucket = str(cfg.get("bucket") or "").strip()
    if not bucket:
        raise ValueError("backup.remote.s3_bucket_missing")
    client = _client(cfg)
    prefix = str(cfg.get("prefix") or "hyve/").strip()
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    out: list[dict[str, Any]] = []
    for item in _list_objects(client, bucket, prefix):
        key = str(item.get("Key") or "")
        name = key.split("/")[-1]
        if not is_backup_filename(name):
            continue
        modified = item.get("LastModified")
        out.append(
            {
                "name": name,
                "remote_key": key,
                "size": int(item.get("Size") or 0),
                "modified_at": modified.isoformat() if modified else None,
                "provider": "s3",
            }
        )
    return sorted(out, key=lambda row: row.get("modified_at") or "", reverse=True)


def download_from_s3(cfg: dict[str, Any], name: str, dest: Path) -> Path:
    from core.backup.remote.names import validate_remote_name

    filename = validate_remote_name(name)
    bucket = str(cfg.get("bucket") or "").strip()
    if not bucket:
        raise ValueError("backup.remote.s3_bucket_missing")
    client = _client(cfg)
    key = _object_key(cfg, filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    client.download_file(bucket, key, str(dest))
    return dest


def prune_s3(cfg: dict[str, Any], retention_count: int) -> list[str]:
    if retention_count <= 0:
        return []
    bucket = str(cfg.get("bucket") or "").strip()
    if not bucket:
        return []
    client = _client(cfg)
    prefix = str(cfg.get("prefix") or "hyve/").strip()
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    keys = sorted(_list_keys(client, bucket, prefix))
    hyve_keys = [k for k in keys if k.split("/")[-1].startswith(("hyve-", "pre-restore-"))]
    to_delete = hyve_keys[: max(0, len(hyve_keys) - retention_count)]
    for key in to_delete:
        client.delete_object(Bucket=bucket, Key=key)
    if to_delete:
        log.info("S3 retention deleted %d object(s)", len(to_delete))
    return to_delete
