#!/usr/bin/env python3
"""Create a production Yomu deploy/.env without printing generated secrets."""

from __future__ import annotations

import argparse
import os
import secrets
from pathlib import Path
from urllib.parse import urlparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--storage", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    parsed = urlparse(args.origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path not in {"", "/"}:
        raise SystemExit("origin must be an HTTPS origin without a path")
    if not 1 <= args.port <= 65535:
        raise SystemExit("port must be between 1 and 65535")
    storage = args.storage.resolve(strict=True)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    values = {
        "YOMU_PORT": str(args.port),
        "YOMU_PUBLIC_ORIGIN": args.origin.rstrip("/"),
        "YOMU_SESSION_SECRET": secrets.token_hex(32),
        "YOMU_COOKIE_SECURE": "true",
        "YOMU_SESSION_TTL_SECONDS": "604800",
        "YOMU_MAX_BODY_BYTES": "2097152",
        "YOMU_MAX_UPLOAD_BYTES": "104857600",
        "YOMU_IMAGE_VERSION": "latest",
        "READER_STORAGE": str(storage),
        "READER_SECURE": "true",
        "READER_SECURE_KEY": secrets.token_hex(32),
        "READER_INVITE_CODE": secrets.token_hex(24),
        "READER_USER_LIMIT": "10",
        "READER_USER_BOOK_LIMIT": "2000",
        "READER_REQUEST_TIMEOUT_SECS": "20",
        "READER_LOG_LEVEL": "info",
        "WEBVIEW_BRIDGE_KEY": secrets.token_hex(32),
        "WEBVIEW_MAX_CONCURRENT": "1",
        "WEBVIEW_IDLE_SECONDS": "120",
    }
    payload = "".join(f"{key}={value}\n" for key, value in values.items())
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload.encode("utf-8"))
    finally:
        os.close(descriptor)
    print(f"created {output} for {values['YOMU_PUBLIC_ORIGIN']} on port {args.port}")


if __name__ == "__main__":
    main()
