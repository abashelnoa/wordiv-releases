#!/usr/bin/env python3
"""Revoke one beta code - the other half of add_beta_code.py.

ASCII ONLY below the docstring, and in every string this prints. A Windows
console runs in the system codepage (cp1255 on a Hebrew machine), and print()
raises UnicodeEncodeError on anything it cannot encode -- which would crash
this tool mid-run, after it had already decided what to do. update_manifest.py
was bitten by exactly this with a single arrow character.

Run this LOCALLY, then commit and push. Every machine using that code is
blocked at its NEXT startup of Wordiv.

    python revoke_code.py a1b2c3d4e5f6          # the prefix from the alert email
    python revoke_code.py WRDV-XXXX-XXXX-...    # the code itself
    python revoke_code.py a1b2c3d4e5f6 --yes    # skip the confirmation

WHY THIS EXISTS
    beta-codes.json is a flat list of 64-character hashes with nothing to say
    which belongs to whom -- that is the point of hashes. So revoking by hand
    means computing a SHA-256, eyeballing sixty identical-looking lines, and
    deleting the right one. Delete the wrong one and you have silently blocked
    an innocent tester, with no error anywhere to tell you.

    This takes the 12-character prefix straight out of the leak-alert email,
    finds the code it belongs to, tells you WHO it was issued to, and asks
    before touching anything.

WHAT REVOKING DOES, AND DOES NOT, DO
    It blocks every machine on that code at its next startup -- including the
    tester it was issued to. The block is per CODE, not per machine, and there
    is no way to keep the original tester running while cutting off the people
    they passed it to.

    That is cheap once their 60 days are up: an expired tester is already
    blocked, so removing their hash costs them nothing they still had, and it
    kills the code for anybody it was passed on to. Pruning expired codes
    every month or so is the low-drama use of this tool.

    See also "activation_deadline" in beta-codes.json, which stops a leaked
    code being activated late without needing anyone to remember anything.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

from add_beta_code import DEFAULT_STORE, code_hash, load_store, normalize, save_store

_HERE = Path(__file__).resolve().parent
_PREFIX_RE = re.compile(r"^[0-9a-f]{6,64}$")


def issued_codes() -> list[tuple[str, str, str, str]]:
    """Every plaintext code from every codes-*.csv, as
    (code, assigned_to, assigned_on, filename).

    Those CSVs are gitignored -- they hold working codes and this repo is
    public -- so they exist only on your machine. Without them a hash prefix
    cannot be turned back into a code, which is exactly the property that
    makes publishing hashes safe.
    """
    found: list[tuple[str, str, str, str]] = []
    for path in sorted(_HERE.glob("codes-*.csv")):
        try:
            with path.open(newline="", encoding="utf-8") as handle:
                for row in csv.DictReader(handle):
                    code = (row.get("code") or "").strip()
                    if code:
                        found.append((code,
                                      (row.get("assigned_to") or "").strip(),
                                      (row.get("assigned_on") or "").strip(),
                                      path.name))
        except OSError as exc:
            print(f"warning: could not read {path.name} ({exc})", file=sys.stderr)
    return found


def resolve(target: str) -> tuple[str, list[tuple[str, str, str, str]]]:
    """Turn what the user typed into (hash, matching CSV rows).

    Accepts a full code, a full hash, or the 12-character prefix the alert
    email prints. Ambiguity is refused rather than guessed at -- picking one
    of two candidates would revoke a tester at random.
    """
    text = target.strip()
    rows = issued_codes()

    lowered = text.lower()
    if _PREFIX_RE.match(lowered):
        matches = [r for r in rows if code_hash(r[0]).startswith(lowered)]
        # Ambiguity means TWO DIFFERENT CODES, not two rows. The same code
        # legitimately appears in several CSVs -- the original mint, plus any
        # later export of the signup sheet with the assignments filled in --
        # and refusing to act on that would break the tool exactly when it is
        # being used properly.
        distinct = {normalize(r[0]) for r in matches}
        if len(distinct) > 1:
            sys.exit(f"error: '{text}' matches {len(distinct)} different codes. "
                     "Nothing changed. Use more characters of the hash.")
        if matches:
            # Prefer the row that knows who it went to; the mint file has the
            # code but blank assignment columns.
            matches.sort(key=lambda r: (not r[1], r[3]))
            return code_hash(matches[0][0]), matches[:1]
        if len(lowered) == 64:
            # A full hash that no CSV explains: still revocable, just anonymous.
            return lowered, []
        sys.exit(f"error: no code in any codes-*.csv hashes to '{text}'. "
                 "Nothing changed. Check the prefix, and check the CSVs are "
                 "on this machine.")

    # Not hex, so treat it as the code itself.
    if not normalize(text):
        sys.exit("error: that is empty once whitespace is stripped. Nothing changed.")
    digest = code_hash(text)
    return digest, [r for r in rows if code_hash(r[0]) == digest]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Remove one beta code's hash from beta-codes.json.",
        epilog="Then: git add beta-codes.json && git commit && git push",
    )
    parser.add_argument("target",
                        help="a hash prefix from the alert email, a full hash, "
                             "or the plaintext code")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="do not ask for confirmation")
    parser.add_argument("-f", "--file", type=Path, default=DEFAULT_STORE,
                        help=f"path to beta-codes.json (default: {DEFAULT_STORE})")
    args = parser.parse_args()

    digest, matches = resolve(args.target)
    data = load_store(args.file)
    hashes = data["valid_code_hashes"]

    if digest not in hashes:
        print(f"not listed - nothing to revoke  ({digest[:12]}...)")
        return 1

    print()
    print(f"  hash          : {digest}")
    if matches:
        for code, assigned_to, assigned_on, source in matches:
            print(f"  code          : {code}")
            print(f"  issued to     : {assigned_to or '(not recorded)'}")
            print(f"  issued on     : {assigned_on or '(not recorded)'}")
            print(f"  found in      : {source}")
    else:
        # Revoking is still correct here; you just cannot see whose it was.
        print("  code          : (no codes-*.csv on this machine explains it)")
    print(f"  codes listed  : {len(hashes)}")
    print()
    print("  Revoking blocks EVERY machine using this code at its next")
    print("  startup, including the tester it was issued to.")
    print()

    if not args.yes:
        try:
            answer = input("  Revoke it? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n  cancelled - nothing changed")
            return 1
        if answer not in ("y", "yes"):
            print("  cancelled - nothing changed")
            return 1

    hashes.remove(digest)
    save_store(args.file, data)

    print()
    print(f"  revoked. {len(hashes)} codes remain.")
    print()
    print("  It is not live until you publish it:")
    print('      git add beta-codes.json && git commit -m "Revoke a beta code" && git push')
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
