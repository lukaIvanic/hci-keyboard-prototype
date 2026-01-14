## Gutenberg-derived bigram corpus stats

This folder contains **derived statistics** (bigram counts) computed from a Project Gutenberg book, not the book text.

### Current dataset
- `pg1342_bigrams.js`: bigram counts for alphabet `a-z` plus space, computed from Project Gutenberg book **ID 1342**.

The file registers a global object:
- `window.KbdStudy.corpus.gutenberg`

### Regenerate
From repo root:

```bash
python corpus/gutenberg/build_bigram.py --book-id 1342 > corpus/gutenberg/pg1342_bigrams.js
```

### Notes
- The script attempts to strip Gutenberg header/footer using the standard `*** START OF` / `*** END OF` markers.
- Normalization keeps only `a-z` and converts everything else to spaces (then collapses whitespace).

