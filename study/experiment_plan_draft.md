# Experiment Plan Draft (Group A)

## Overview
We evaluate whether theoretical WPM predictions align with real on-screen typing
performance. Four layouts are tested using mouse-based on-screen clicking. Layouts
are generated with the standard theoretical WPM model, but we compute both
theoretical models (standard and custom) for analysis.

## Design
- Design: within-subjects (Group A only).
- Layout order: counterbalanced (Latin square).
- Session length target: flexible (extended learning phase; expect >20 minutes).
- Acclimatization is required for unfamiliar layouts; separate training from
  measured trials.

## Layouts (Group A)
Generated using the standard theoretical WPM model:
1) QWERTY
2) Same-theoretical-WPM-as-QWERTY layout (different letter arrangement)
3) Best-predicted layout
4) Worst-predicted layout

## Input Method
- On-screen keyboard with mouse clicking.

## Timing Model (Updated, excludes TLX)
- Assumption for typing time: 30 characters per phrase, conservative 15 WPM.
- Estimated time per phrase: 24 seconds (typing only).
- Measured typing time: 4 layouts x 10 phrases x 24 seconds = ~16 minutes.
- Add learning phase + practice + breaks: expect ~10-15 minutes extra.
- Estimated total (excluding TLX): ~26-32 minutes.
Notes:
- Use pilot runs to refine timing estimates.
- If time becomes an issue, reduce measured phrases to 8 or shorten drills.

## Procedure (Final Draft)
1) QWERTY warm-up (2 phrases, not counted).
2) For each layout:
   - Learning phase (not counted), see extended package below.
   - 2 practice phrases (not counted).
   - 10 measured phrases (about 30 characters each).
   - NASA-TLX (all 6 items) immediately after the layout block.
   - Short break between layouts.

## Measures
- Observed WPM
- Error rate and corrected error rate
- Theoretical WPM (standard model)
- Theoretical WPM (custom trigram/edge model)
- NASA-TLX workload after each layout (all 6 items)

## Primary Analysis
- Repeated-measures test on WPM (ANOVA or Friedman).
- Planned comparisons:
  - Best vs Worst
  - Best vs Baseline (QWERTY)
  - Baseline vs Same-WPM layout

## Secondary Analysis
- Correlation between predicted and observed WPM per participant.
- Compare model predictions using slope or RMSE per participant.

## Notes and Constraints
- If recruitment allows a second group later, use an identical protocol for
  comparability.
- Keep phrases and language consistent with the n-gram source used to build
  layouts.
 - If timing drifts in pilot runs, adjust phrase length or measured phrase count
   and update the timing model.

## Learning Phase (Per Layout, Extended Package)
Goal: reduce search time so measured trials reflect layout efficiency, not
first-time discovery.
- Alphabet drill (guided): click A-Z with the next key highlighted.
- Alphabet drill (unguided): click A-Z without highlights; randomize order.
- Bigram drill: 10-12 common bigrams for the target language.
- Short word drill: 6 short words (2-4 letters).
- 2 short practice phrases (not counted).
Notes:
- Log learning-phase performance to chart learning curves if desired.
- If time becomes a constraint, remove the short-word drill or reduce bigrams.

## Controls and Data Quality
- Use a fixed phrase pool matched to the n-gram language source.
- Randomize phrase order per layout while keeping difficulty balanced.
- Record device type (mouse vs trackpad), screen size, and zoom level.
- Exclude trials with incomplete phrases or abnormal delays (define thresholds
  up front).
- Log layout order, practice vs measured trials, and any resets.

## Phrase Pool Requirements (Draft)
- Keep phrase length tightly controlled (about 30 characters) to reduce
  variance.
- Use the same phrase pool across all layouts; only randomize order.
- Match the phrase language and character distribution to the n-gram source
  used to generate layouts.
- Avoid rare punctuation, numbers, and capitalization unless they are part of
  the layout being evaluated.
- Balance word frequency and avoid highly idiosyncratic phrases that could
  cause outlier timings.
