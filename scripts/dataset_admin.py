#!/usr/bin/env python3
"""
Dataset admin helper for Firebase Realtime Database.

Examples:
  python3 scripts/dataset_admin.py seed-script-data --dataset testing1
  python3 scripts/dataset_admin.py add-character --dataset testing1 --name John
  python3 scripts/dataset_admin.py show-dataset --dataset testing1
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT_DIR / "js" / "config.js"
DATA_DIR = ROOT_DIR / "data"

PALETTE = [
    "#fde2e4",
    "#c5dedd",
    "#bcd4e6",
    "#fff1e6",
    "#dbe7e4",
    "#eddcd2",
    "#e8d5b7",
    "#d6e2e9",
    "#d4c4fb",
    "#99c1de",
    "#f0efeb",
    "#fad2e1",
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


def load_database_url() -> str:
    text = CONFIG_PATH.read_text(encoding="utf-8")
    match = re.search(r'databaseURL:\s*"([^"]+)"', text)
    if not match:
        fail("Could not parse databaseURL from js/config.js")
    return match.group(1).rstrip("/")


def db_path(dataset_id: str, node: str) -> str:
    if dataset_id == "default":
        return node
    return f"datasets/{dataset_id}/{node}"


def request_json(db_url: str, path: str, method: str = "GET", payload=None):
    url = f"{db_url}/{path}.json"
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        fail(f"{method} {url} failed ({exc.code}): {body}")
    except urllib.error.URLError as exc:
        fail(f"Network error for {method} {url}: {exc.reason}")


def load_local_json(name: str):
    path = DATA_DIR / name
    if not path.exists():
        fail(f"Missing local data file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def slugify(value: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return base or "character"


def next_unique_id(existing_ids: set[str], preferred: str) -> str:
    if preferred not in existing_ids:
        return preferred
    idx = 2
    while f"{preferred}-{idx}" in existing_ids:
        idx += 1
    return f"{preferred}-{idx}"


def cmd_seed_script_data(db_url: str, dataset: str, force: bool) -> None:
    base = db_path(dataset, "scriptData")
    existing = request_json(db_url, base)
    if existing and not force:
        fail(
            f"{base} already exists. Use --force to overwrite."
        )

    payload = {
        "characters": load_local_json("characters.json"),
        "scenes": load_local_json("scenes.json"),
        "lines": load_local_json("lines.json"),
    }
    request_json(db_url, base, method="PUT", payload=payload)
    print(f"Seeded script data at {base}")


def cmd_add_character(
    db_url: str,
    dataset: str,
    name: str,
    full_name: str | None,
    character_id: str | None,
    color: str | None,
) -> None:
    path = db_path(dataset, "scriptData/characters")
    current = request_json(db_url, path)
    if not isinstance(current, list):
        current = load_local_json("characters.json")

    existing_names = {str(c.get("name", "")).strip().lower() for c in current}
    if name.strip().lower() in existing_names:
        fail(f'Character "{name}" already exists in {path}')

    existing_ids = {str(c.get("id", "")).strip() for c in current}
    preferred_id = character_id.strip() if character_id else slugify(name)
    new_id = next_unique_id(existing_ids, preferred_id)

    chosen_color = color or PALETTE[len(current) % len(PALETTE)]
    new_character = {
        "id": new_id,
        "name": name.strip(),
        "fullName": (full_name or name).strip(),
        "color": chosen_color,
    }
    current.append(new_character)
    request_json(db_url, path, method="PUT", payload=current)
    print(f'Added character "{name}" to dataset "{dataset}" at {path}')
    print(json.dumps(new_character, ensure_ascii=False, indent=2))


def cmd_show_dataset(db_url: str, dataset: str) -> None:
    script_base = db_path(dataset, "scriptData")
    script = request_json(db_url, script_base) or {}
    characters = script.get("characters") if isinstance(script, dict) else None
    scenes = script.get("scenes") if isinstance(script, dict) else None
    lines = script.get("lines") if isinstance(script, dict) else None

    print(f"Dataset: {dataset}")
    print(f"Path: {db_path(dataset, '')}".rstrip("/"))
    print(f"Characters: {len(characters) if isinstance(characters, list) else 0}")
    print(f"Scenes: {len(scenes) if isinstance(scenes, list) else 0}")
    print(f"Lines: {len(lines) if isinstance(lines, list) else 0}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage dataset script data in Firebase.")
    parser.add_argument(
        "--database-url",
        default=None,
        help="Firebase Realtime Database URL. Defaults to js/config.js databaseURL.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    seed = sub.add_parser("seed-script-data", help="Seed scriptData from local data/*.json")
    seed.add_argument("--dataset", required=True, help="Dataset id, e.g. testing1")
    seed.add_argument("--force", action="store_true", help="Overwrite existing scriptData")

    add = sub.add_parser("add-character", help="Add one character to scriptData/characters")
    add.add_argument("--dataset", required=True, help="Dataset id, e.g. testing1")
    add.add_argument("--name", required=True, help="Character short name (display name)")
    add.add_argument("--full-name", default=None, help="Character full name")
    add.add_argument("--id", default=None, help="Character id (slug if omitted)")
    add.add_argument("--color", default=None, help="Hex color, e.g. #aabbcc")

    show = sub.add_parser("show-dataset", help="Show scriptData counts for dataset")
    show.add_argument("--dataset", required=True, help="Dataset id, e.g. testing1")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    db_url = (args.database_url or load_database_url()).rstrip("/")

    dataset = sanitize_dataset_id(getattr(args, "dataset", "default"))
    if dataset != getattr(args, "dataset", dataset):
        print(f'Using sanitized dataset id: "{dataset}"')

    if args.command == "seed-script-data":
        cmd_seed_script_data(db_url, dataset, args.force)
    elif args.command == "add-character":
        cmd_add_character(
            db_url=db_url,
            dataset=dataset,
            name=args.name,
            full_name=args.full_name,
            character_id=args.id,
            color=args.color,
        )
    elif args.command == "show-dataset":
        cmd_show_dataset(db_url, dataset)
    else:
        fail(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
