#!/usr/bin/env python3
"""
Export dataset-scoped Firebase nodes to repo JSON files.

This is intended to run in GitHub Actions on workflow_dispatch, so each
"保存版本" can produce a traceable git commit containing data-state snapshots.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]

NODES = [
    "blockingData",
    "dialogueEdits",
    "lineOperations",
    "notes",
    "versions",
    "scenes",
    "sceneStageMap",
    "stageLibrary",
    "commonActions",
    "scriptData",
]


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def sanitize_dataset_id(raw: str) -> str:
    if not raw:
        return "default"
    normalized = re.sub(r"[^a-zA-Z0-9_-]", "", raw.strip())
    if not normalized:
        return "default"
    return normalized[:64]


def sanitize_filename(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip())
    normalized = normalized.strip("-._")
    return normalized or "snapshot"


def build_node_path(dataset: str, node: str) -> str:
    if dataset == "default":
        return node
    return f"datasets/{dataset}/{node}"


def fetch_json(database_url: str, path: str, auth_token: str | None) -> object:
    base = database_url.rstrip("/")
    url = f"{base}/{path}.json"
    if auth_token:
        query = urllib.parse.urlencode({"auth": auth_token})
        url = f"{url}?{query}"

    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        fail(f"GET {url} failed ({exc.code}): {body}")
    except urllib.error.URLError as exc:
        fail(f"Network error for {url}: {exc.reason}")


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Firebase dataset snapshot to files.")
    parser.add_argument("--database-url", default=os.getenv("FIREBASE_DATABASE_URL"))
    parser.add_argument("--dataset", default="default")
    parser.add_argument("--version-name", default="manual-save")
    parser.add_argument(
        "--output-root",
        default=str(ROOT_DIR / "snapshots" / "firebase"),
        help="Root directory for snapshot outputs.",
    )
    parser.add_argument(
        "--auth-token",
        default=os.getenv("FIREBASE_DB_AUTH_TOKEN"),
        help="Optional Firebase DB auth token for locked rules.",
    )
    args = parser.parse_args()

    if not args.database_url:
        fail("Missing --database-url (or FIREBASE_DATABASE_URL env var).")

    dataset = sanitize_dataset_id(args.dataset)
    version_name = sanitize_filename(args.version_name)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")

    out_dir = Path(args.output_root) / f"dataset-{dataset}"
    latest_dir = out_dir / "latest"
    by_version_dir = out_dir / "by-version" / f"{timestamp}--{version_name}"

    metadata = {
        "dataset": dataset,
        "versionName": args.version_name,
        "exportedAtUtc": timestamp,
        "databaseUrl": args.database_url,
        "paths": {},
    }

    print(f"Exporting dataset: {dataset}")
    for node in NODES:
        db_path = build_node_path(dataset, node)
        payload = fetch_json(args.database_url, db_path, args.auth_token)

        metadata["paths"][node] = db_path
        write_json(latest_dir / f"{node}.json", payload)
        write_json(by_version_dir / f"{node}.json", payload)
        print(f"  - {node}")

    write_json(latest_dir / "metadata.json", metadata)
    write_json(by_version_dir / "metadata.json", metadata)
    print(f"Snapshot written to: {by_version_dir}")


if __name__ == "__main__":
    main()
