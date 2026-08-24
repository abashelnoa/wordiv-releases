#!/usr/bin/env python3
"""Generate a BATCH of beta codes: hashes into beta-codes.json, codes into a CSV.

add_beta_code.py issues codes one at a time and prints them to the terminal,
which is right when you are answering a single request by hand. This is the
other shape: pre-mint a pool of codes once, publish all their hashes in one
push, and keep the plaintext in a spreadsheet that a signup form can hand out
automatically. Nobody waits for you, and the public list still contains only
hashes.

    python make_code_batch.py 100          # mint 100, append their hashes
    python make_code_batch.py 100 --dry-run

Then:
    git add beta-codes.json && git commit -m "Publish 100 beta codes" && git push
    ...and import codes-<date>.csv into the Google Sheet behind the form.

THE CSV HOLDS WORKING CODES IN PLAINTEXT. This repository is public. The file
name matches a .gitignore rule so it cannot be committed by accident — do not
defeat that, and do not paste its contents anywhere public.
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

# The single source of truth for the format and the hashing contract.
from add_beta_code import DEFAULT_STORE, code_hash, generate_code, load_store, save_store

_MAX_BATCH = 5_000


def mint(count: int, store_path: Path, dry_run: bool) -> list[str]:
    data = load_store(store_path)
    hashes = data["valid_code_hashes"]
    known = set(hashes)

    codes: list[str] = []
    while len(codes) < count:
        code = generate_code()
        digest = code_hash(code)
        if digest in known:          # ~78 bits; belt and braces
            continue
        known.add(digest)
        hashes.append(digest)
        codes.append(code)

    if not dry_run:
        save_store(store_path, data)
    return codes


def write_csv(codes: list[str], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["code", "assigned_to", "assigned_on"])
        for code in codes:
            writer.writerow([code, "", ""])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mint a batch of beta codes: hashes published, codes kept local.")
    parser.add_argument("count", type=int, help="how many codes to mint")
    parser.add_argument("-f", "--file", type=Path, default=DEFAULT_STORE,
                        help=f"path to beta-codes.json (default: {DEFAULT_STORE})")
    parser.add_argument("-o", "--out", type=Path, default=None,
                        help="CSV to write (default: codes-<today>.csv)")
    parser.add_argument("-n", "--dry-run", action="store_true",
                        help="show what would happen; write nothing")
    args = parser.parse_args()

    if args.count < 1 or args.count > _MAX_BATCH:
        return parser.error(f"count must be between 1 and {_MAX_BATCH}")

    out = args.out or (Path(__file__).resolve().parent
                       / f"codes-{date.today().isoformat()}.csv")
    if not str(out.name).startswith("codes-"):
        return parser.error(
            "the CSV name must start with 'codes-' so .gitignore covers it -- "
            "this file contains working codes and the repo is public")
    if out.exists() and not args.dry_run:
        return parser.error(f"{out} already exists; move it aside first")

    codes = mint(args.count, args.file, args.dry_run)
    total = len(load_store(args.file)["valid_code_hashes"])

    if args.dry_run:
        print(f"dry run: would mint {len(codes)} codes and write {out}")
        print(f"         beta-codes.json would hold {total} hashes")
        for code in codes[:3]:
            print(f"         e.g. {code}")
        return 0

    write_csv(codes, out)
    print(f"minted {len(codes)} codes")
    print(f"  hashes appended to : {args.file}   ({total} total)")
    print(f"  codes written to   : {out}   <-- PRIVATE, never commit or publish")
    print()
    print("  Next:")
    print("    git add beta-codes.json")
    print(f'    git commit -m "Publish {len(codes)} beta codes"')
    print("    git push")
    print(f"    ...then import {out.name} into the Sheet behind your signup form.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
