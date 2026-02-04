"""
Build a trigram distribution (letters + space) from one or more Project Gutenberg books.

Usage (prints JS to stdout):
  python corpus/gutenberg/build_trigram.py --book-id 1342 --book-id 1661 > corpus/gutenberg/pg_trigrams.js

Notes:
- Uses only the Python standard library.
- Strips Gutenberg header/footer using standard START/END markers.
- Output is derived statistics (trigram counts), not the book text itself.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
import urllib.request


ALPHABET = "abcdefghijklmnopqrstuvwxyz "
K = len(ALPHABET)
IDX = {c: i for i, c in enumerate(ALPHABET)}


def fetch_gutenberg_text(book_id: int) -> str:
    url = f"https://www.gutenberg.org/cache/epub/{book_id}/pg{book_id}.txt"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    return data.decode("utf-8", errors="ignore")


def strip_gutenberg_boilerplate(text: str) -> str:
    start = re.search(r"\*\*\*\s*START OF.*?\*\*\*", text, flags=re.IGNORECASE | re.DOTALL)
    end = re.search(r"\*\*\*\s*END OF.*?\*\*\*", text, flags=re.IGNORECASE | re.DOTALL)
    if start and end and start.end() < end.start():
        return text[start.end() : end.start()]
    return text


def normalize_to_alphabet(text: str) -> str:
    t = text.lower()
    # Convert anything not a-z into a space, then collapse whitespace.
    t = re.sub(r"[^a-z]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def trigram_counts(s: str) -> tuple[list[int], int]:
    counts = [0] * (K * K * K)
    total = 0
    space_idx = IDX[" "]

    for a, b, c in zip(s, s[1:], s[2:]):
        ia = IDX.get(a, space_idx)
        ib = IDX.get(b, space_idx)
        ic = IDX.get(c, space_idx)
        counts[(ia * K + ib) * K + ic] += 1
        total += 1

    return counts, total


def emit_js(book_ids: list[int], counts: list[int], total: int) -> str:
    download_urls = [f"https://www.gutenberg.org/cache/epub/{bid}/pg{bid}.txt" for bid in book_ids]
    meta = {
        "source": "Project Gutenberg",
        "bookIds": book_ids,
        "bookId": book_ids[0] if book_ids else None,
        "downloadUrls": download_urls,
        "alphabet": ALPHABET,
        "totalTrigrams": total,
        "generatedAt": _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "countsFlat": counts,
    }
    payload = json.dumps(meta, separators=(",", ":"), ensure_ascii=True)
    return (
        "(function(){\n"
        "  window.KbdStudy = window.KbdStudy || {};\n"
        "  const ns = window.KbdStudy;\n"
        "  ns.corpus = ns.corpus || {};\n"
        f"  ns.corpus.gutenbergTrigrams = {payload};\n"
        "})();\n"
    )


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--book-id",
        type=int,
        action="append",
        default=[],
        help="Project Gutenberg book ID (repeat for multiple books)",
    )
    args = ap.parse_args(argv)

    book_ids = args.book_id if args.book_id else [1342]
    normalized = []
    for book_id in book_ids:
        raw = fetch_gutenberg_text(book_id)
        body = strip_gutenberg_boilerplate(raw)
        norm = normalize_to_alphabet(body)
        if norm:
            normalized.append(norm)

    combined = " " + " ".join(normalized) + " "
    counts, total = trigram_counts(combined)

    js = emit_js(book_ids, counts, total)
    sys.stdout.write(js)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
