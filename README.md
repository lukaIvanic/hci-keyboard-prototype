## HCI Keyboard Layout Prototype (web, no tooling)

### Run
- Open `index.html` in a browser (works from `file://`).
- Open `generator.html` in a browser for live layout generation.

### What this prototype does
- **On-screen keyboard** with layout switching.
- **Copy-typing trials** with a built-in phrase list.
- **Logging + metrics**: WPM, edit distance, backspace count (trial table shown in UI).
- **Export**: trial-level CSV + raw JSON download.
- **Theoretical model**: simple linear distance estimate shown per layout.
- **Generator page**: live **genetic algorithm** sequence-pair search scored by theoretical WPM; keeps a top-5 leaderboard with preview. It uses a **Gutenberg-derived bigram distribution** (letters + space) and a **Fitts’ Law** movement-time model for scoring.

### Experiment workflow
- **Setup**: enter participant ID/condition, choose layout order (fixed or seeded random), set practice and trials per layout.
- **Run**: click Start; controls lock, the status shows layout and trial progress, and practice trials are flagged.
- **Finish**: export CSV or JSON; JSON includes session metadata, layout order + seed, and environment info for reproducibility.

### File map
- `index.html`: UI shell and script loading order.
- `generator.html`: live layout generator page (top-5 leaderboard + preview).
- `styles.css`: UI styling.
- `src/app.js`: phrase flow, layout switching, trial submission, results table, export buttons.
- `src/generatorApp.js`: generator loop + scoring + leaderboard + preview.
- `src/keyboard.js`: keyboard rendering + pointer/click handling.
- `src/logger.js`: per-trial event logs (timestamped key events + timing).
- `src/metrics.js`: WPM + Levenshtein edit distance.
- `src/exportCsv.js`: CSV/JSON generation and browser download.
- `src/theoryDistanceLinear.js`: distance-linear theoretical WPM model.
- `src/layouts.js`: layout definitions + compilers (row layouts and sequence pairs).
- `corpus/gutenberg/`: Project Gutenberg–derived bigram counts + regeneration script (no raw book text stored).

### Runtime layout representation
- **Key**: `{ id, label, type, x, y, w, h }`
- **Layout**: `{ id, name, keys: Key[] }`
- Units are **abstract**; `src/keyboard.js` scales unit-space to fit `#keyboardContainer`.

### Sequence-pair representation (generator)
- A `SequencePairSpec` compiles into a runtime `Layout` via `compileSequencePair(spec, {targetW,targetH})` in `src/layouts.js`.
- **Spec fields**:
  - `keys[]`: array of `{id,label,type}`; array order defines indices `1..n` (extensible).
  - `seqA`, `seqB`: permutations of `[1..n]`.
  - optional `wRaw[]`, `hRaw[]`: per-key size weights (defaults to 1; no special-casing for space/backspace).
- **Packing rule** (standard): for `i` before `j` in `seqA`:
  - if `posB[i] < posB[j]` then `j` is right of `i` ⇒ `x[j] = max(x[j], x[i] + w[i])`
  - else `j` is below `i` ⇒ `y[j] = max(y[j], y[i] + h[i])`
- **Normalization**: after packing, apply global scales `sx,sy` so `max(x+w)=targetW` and `max(y+h)=targetH` (preserves non-overlap).
- Includes a small **unit-space overlap sanity check** (epsilon-based) to catch future packing bugs.

### Built-in layouts (IDs)
- Row-based: `qwerty`, `alpha`, `rand`
- Sequence-pair: `sp_identity`, `sp_reverse_b`, `sp_mixed`, `sp_rand_perm`, `sp_rand_perm_sizes`

### Notes / known artifacts
- Some sequence pairs can create **very thin keys** after normalization (e.g., vertical chain layouts). The renderer intentionally avoids min-size clamping because that can force visual overlaps and break the geometry guarantees.


