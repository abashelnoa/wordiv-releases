#!/usr/bin/env python3
"""Add a beta code to beta-codes.json — as a hash, never as the code itself.

Run this LOCALLY. It prints the plaintext code to your terminal (so you can
send it to a tester) and writes only its SHA-256 hash to beta-codes.json.
The plaintext is never written to any file and never leaves this machine.

    python add_beta_code.py WRDV-XXXX-XXXX-XXXX-XXXX   # hash a code you chose
    python add_beta_code.py --generate                 # invent a strong one
    python add_beta_code.py --generate 3               # ...three of them
    python add_beta_code.py --check WRDV-...           # is it already listed?

THE HASHING CONTRACT — the app must reproduce this exactly, or no code will
ever validate:

    normalized = "".join(code.split()).upper()
    digest     = sha256(normalized.encode("utf-8")).hexdigest()   # lowercase hex

i.e. every whitespace character is removed, the rest is upper-cased, and the
UTF-8 bytes are hashed. Dashes ARE significant. Keep this in one place on the
app side too, and change it in both places or in neither.

Why hashes: beta-codes.json is world-readable on GitHub. A hash list lets the
app check a code without the list ever containing a working one. That only
holds while the codes are long and random — a short or guessable code can be
brute-forced offline from its hash in seconds, so use --generate (80 bits of
entropy) rather than inventing codes by hand.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
from pathlib import Path

# beta-codes.json lives next to this script, in the repo root.
DEFAULT_STORE = Path(__file__).resolve().parent / "beta-codes.json"

# Crockford-style alphabet: no 0/O/1/I/L/U, so a code read over the phone or
# copied out of an email survives the trip.
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
_PREFIX = "WRDV"
_GROUPS, _GROUP_LEN = 4, 4          # WRDV-XXXX-XXXX-XXXX-XXXX -> ~78 bits


def normalize(code: str) -> str:
    """The one true normalization. Must match the app's, character for character."""
    return "".join(code.split()).upper()


def code_hash(code: str) -> str:
    return hashlib.sha256(normalize(code).encode("utf-8")).hexdigest()


def generate_code() -> str:
    groups = [
        "".join(secrets.choice(_ALPHABET) for _ in range(_GROUP_LEN))
        for _ in range(_GROUPS)
    ]
    return "-".join([_PREFIX, *groups])


def load_store(path: Path) -> dict:
    if not path.exists():
        return {"valid_code_hashes": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"error: {path} is not valid JSON ({exc}). Not touching it.")
    if not isinstance(data, dict) or not isinstance(
        data.get("valid_code_hashes"), list
    ):
        sys.exit(f'error: {path} has no "valid_code_hashes" list. Not touching it.')
    return data


def save_store(path: Path, data: dict) -> None:
    """Write via a temp file so an interrupted run cannot leave a half-written list."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def add(code: str, path: Path) -> bool:
    """Add code's hash to the store. Returns True if it was new."""
    digest = code_hash(code)
    data = load_store(path)
    hashes = data["valid_code_hashes"]
    if digest in hashes:
        print(f"already listed - nothing changed  ({digest[:12]}...)")
        _report(code, digest, len(hashes))
        return False
    hashes.append(digest)
    save_store(path, data)
    _report(code, digest, len(hashes))
    return True


def _report(code: str, digest: str, total: int) -> None:
    normalized = normalize(code)
    print()
    print("  send this to the tester:  " + normalized)
    if normalized != code:
        print(f"  (normalized from {code!r})")
    print("  stored hash:              " + digest)
    print(f"  codes now in the list:    {total}")
    print()
    print("  The code above is printed here only - it is not in any file.")
    print("  Commit and publish the hash with:")
    print("      git add beta-codes.json && git commit -m \"Add a beta code\" && git push")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Add a beta code to beta-codes.json as a SHA-256 hash.",
        epilog="The plaintext code is printed to this terminal and nowhere else.",
    )
    parser.add_argument("code", nargs="?", help="the beta code to add")
    parser.add_argument(
        "-g", "--generate", nargs="?", const=1, type=int, metavar="N",
        help="invent N strong codes (default 1) and add them",
    )
    parser.add_argument(
        "-c", "--check", metavar="CODE",
        help="report whether CODE is already listed, and change nothing",
    )
    parser.add_argument(
        "-f", "--file", type=Path, default=DEFAULT_STORE,
        help=f"path to beta-codes.json (default: {DEFAULT_STORE})",
    )
    args = parser.parse_args()

    if args.check:
        listed = code_hash(args.check) in load_store(args.file)["valid_code_hashes"]
        print(f"{normalize(args.check)}: {'listed' if listed else 'NOT listed'}")
        return 0 if listed else 1

    if args.generate:
        if args.code:
            return parser.error("give a code or --generate, not both")
        for _ in range(args.generate):
            add(generate_code(), args.file)
        return 0

    if not args.code:
        return parser.error("give a code to add, or --generate one")
    if not normalize(args.code):
        return parser.error("that code is empty once whitespace is stripped")

    add(args.code, args.file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
