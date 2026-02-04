# Analysis Guide (Template)

## Inputs
Use the exported CSV file from the app. The CSV contains trial rows with raw, minimal fields.

Key fields:
- `sessionId`, `participantId`, `trialId`, `layoutId`
- `trialType` (`learning`, `practice`, `main`, `free`) and `learningKind` (if applicable)
- `target`, `typed`
- `startTimeMs`, `endTimeMs`, `elapsedMs`
- `backspaceCount`, `keypressCount`

Derived during analysis:
- `charCount`, `editDistance`, `wpm`, `errorRate`
- `layoutOrder`, `layoutIndex`, `trialIndex`, `isPractice`

## Recommended metrics
- Mean WPM per layout (exclude practice).
- Mean edit distance per layout (exclude practice).
- Error rate: editDistance / charCount.
- Trial completion time in seconds.

## Suggested workflow
1. Filter out `trialType = learning`. If needed, also filter `trialType = practice`.
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
