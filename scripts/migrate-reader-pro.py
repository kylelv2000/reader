#!/usr/bin/env python3
"""Idempotently import one Reader Pro user's sources into Yomu Reader Core."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage", required=True, type=Path)
    parser.add_argument("--username", required=True)
    return parser.parse_args()


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(1)


def main() -> None:
    args = parse_args()
    username = args.username.strip()
    if not username or "/" in username or "\\" in username or username in {".", ".."}:
        fail("invalid username")

    storage = args.storage.resolve(strict=True)
    source_path = storage / "data" / username / "bookSource.json"
    shelf_path = storage / "data" / username / "bookshelf.json"
    database_path = storage / "reader.db"
    if not source_path.is_file():
        fail("legacy bookSource.json not found")
    if not database_path.is_file():
        fail("reader.db not found; start Reader Core once before importing")

    try:
        sources = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read legacy sources: {error}")
    if not isinstance(sources, list):
        fail("legacy bookSource.json must contain an array")

    imported = 0
    skipped = 0
    now = int(time.time())
    connection = sqlite3.connect(database_path, timeout=30)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='book_sources'"
        ).fetchone()
        if table is None:
            fail("book_sources table not found; Reader Core migrations are incomplete")
        with connection:
            for source in sources:
                if not isinstance(source, dict):
                    skipped += 1
                    continue
                url = str(source.get("bookSourceUrl") or "").strip()
                if not url:
                    skipped += 1
                    continue
                name = str(source.get("bookSourceName") or url).strip() or url
                payload = json.dumps(source, ensure_ascii=False, separators=(",", ":"))
                connection.execute(
                    """
                    INSERT INTO book_sources
                        (user_ns, book_source_url, book_source_name, json, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(user_ns, book_source_url) DO UPDATE SET
                        book_source_name=excluded.book_source_name,
                        json=excluded.json,
                        updated_at=excluded.updated_at
                    """,
                    (username, url, name, payload, now),
                )
                imported += 1
    finally:
        connection.close()

    shelf_count = 0
    if shelf_path.is_file():
        try:
            shelf = json.loads(shelf_path.read_text(encoding="utf-8"))
            shelf_count = len(shelf) if isinstance(shelf, list) else 0
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass
    print(
        json.dumps(
            {
                "ok": True,
                "username": username,
                "sourceFileCount": len(sources),
                "imported": imported,
                "skipped": skipped,
                "shelfCount": shelf_count,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
