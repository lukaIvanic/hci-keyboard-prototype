# Analysis Guide (Template)

## Inputs
Use the exported CSV file from the app. The CSV contains trial rows with session metadata.

Key fields:
- `participantId`, `condition`, `layoutId`, `layoutIndex`
- `isPractice` (filter out practice trials for main analysis)
- `wpm`, `editDistance`, `elapsedMs`

## Recommended metrics
- Mean WPM per layout (exclude practice).
- Mean edit distance per layout (exclude practice).
- Error rate: editDistance / charCount.
- Trial completion time in seconds.

## Suggested workflow
1. Filter `isPractice = false`.
2. Group by `participantId` and `layoutId`.
3. Compute mean WPM and mean error rate.
4. Compare layouts using paired tests if the same participants completed all layouts.

## Quick summary script
Use the included script to generate a simple session summary:

```
python analysis/compute_summary.py path/to/export.csv --output summary_out.csv
```

## Quality checks
- Flag unusually short `elapsedMs` (possible accidental submissions).
- Flag sessions missing a layout or with very few trials.
