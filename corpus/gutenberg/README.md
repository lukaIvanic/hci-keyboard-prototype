## Gutenberg-derived corpus stats

This folder contains **derived statistics** (bigram + trigram counts) computed from Project Gutenberg books, not the book text.

### Current dataset
- `pg1342_bigrams.js`: bigram counts for alphabet `a-z` plus space, computed from Project Gutenberg book **ID 1342**.
- `pg_trigrams.js`: trigram counts for alphabet `a-z` plus space, computed from multiple Project Gutenberg books (IDs **1342, 1661, 84, 11, 98**).

The file registers a global object:
- `window.KbdStudy.corpus.gutenberg`
- `window.KbdStudy.corpus.gutenbergTrigrams`

### Regenerate
From repo root:

```bash
python corpus/gutenberg/build_bigram.py --book-id 1342 > corpus/gutenberg/pg1342_bigrams.js
python corpus/gutenberg/build_trigram.py --book-id 1342 --book-id 1661 --book-id 84 --book-id 11 --book-id 98 > corpus/gutenberg/pg_trigrams.js
```

### Notes
- The script attempts to strip Gutenberg header/footer using the standard `*** START OF` / `*** END OF` markers.
- Normalization keeps only `a-z` and converts everything else to spaces (then collapses whitespace).

