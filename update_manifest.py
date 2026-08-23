#!/usr/bin/env python3
"""Generate version.json for a Wordiv release. Run locally, then commit.

    python update_manifest.py <path-to-Wordiv-Setup.exe> <version> --notes "..."

Hashing the installer by hand is a silent single point of failure: one stale
paste and every tester's update stops working, with no error shown to them and
no signal to the maintainer. This computes the hash from the actual file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent / "version.json"
RELEASE_URL = ("https://github.com/abashelnoa/wordiv-releases/releases/download/"
               "v{version}/Wordiv-Setup.exe")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 16), b""):
            digest.update(block)
    return digest.hexdigest()


def version_tuple(text: str) -> tuple[int, ...] | None:
    try:
        return tuple(int(p) for p in text.strip().lstrip("v").split("."))
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Write version.json for a release.")
    ap.add_argument("installer", type=Path, help="path to Wordiv-Setup.exe")
    ap.add_argument("version", help="the version being released, e.g. 1.3.1")
    ap.add_argument("--notes", default="", help="release notes (first line is the toast)")
    args = ap.parse_args()

    if not args.installer.is_file():
        sys.exit(f"error: no such file: {args.installer}. Nothing written. "
                  "Point this at the built installer, e.g. "
                  "dist\installer\Wordiv-Setup.exe.")
    new = version_tuple(args.version)
    if new is None:
        sys.exit(f"error: not a version number: {args.version}. Nothing written. "
                  "Use a plain version like 1.3.1 (a leading 'v' is fine, e.g. v1.3.1).")

    if MANIFEST.exists():
        try:
            current = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            sys.exit(f"error: {MANIFEST} exists but could not be read ({exc}). "
                     "Nothing written. Fix or remove the file, then re-run.")
        if not isinstance(current, dict):
            sys.exit(f"error: {MANIFEST} is valid JSON but not an object "
                     f"(found {type(current).__name__}: {current!r}). "
                     "Nothing written. Fix the file by hand, then re-run.")
        stored = current.get("latest_version") or ""
        if stored:
            old = version_tuple(str(stored))
            if old is None:
                sys.exit(f"error: {MANIFEST} has an unparseable latest_version "
                         f"({stored!r}). Nothing written. Fix the file by hand, "
                         "then re-run.")
            if new <= old:
                sys.exit(f"error: {args.version} is not newer than the published "
                         f"{stored}. Nothing written. Bump the version, or confirm "
                         "this isn't a re-run of an already-shipped release.")

    manifest = {
        "latest_version": args.version.lstrip("v"),
        "download_url": RELEASE_URL.format(version=args.version.lstrip("v")),
        "sha256": sha256_of(args.installer),
        "release_notes": args.notes,
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")

    size_mb = args.installer.stat().st_size / (1 << 20)
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"\nwritten to {MANIFEST}  ({size_mb:.1f} MB installer)")
    print("\nNext:")
    print(f"  gh release create v{manifest['latest_version']} \"{args.installer}\"")
    print("  git add version.json && git commit -m \"Release "
          f"{manifest['latest_version']}\" && git push")
    return 0


if __name__ == "__main__":
    sys.exit(main())
