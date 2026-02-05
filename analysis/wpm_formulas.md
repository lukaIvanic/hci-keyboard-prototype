# WPM formulas (generator)

This summarizes the predicted WPM formulas used on the generator page.

## Shared WPM conversion
- WPM = (chars / 5) / (elapsedMs / 60000)
- When using avgMsPerChar: WPM = 12000 / avgMsPerChar

## Standard (Fitts + bigrams)
Given bigram counts c_ab:

1) Distance and effective width
- D = distance(prevKey, nextKey) (center, edge, or both)
- W_eff = (|dx|/D) * w_b + (|dy|/D) * h_b
- If D is ~0: W_eff = sqrt(w_b * h_b)

2) Fitts movement time
- ID = log2(D / W_eff + 1)
- MT = fittsAms + fittsBms * ID

3) Expected time and WPM
- E[MT] = sum(c_ab * MT_ab) / sum(c_ab)
- avgMsPerChar = tapTimeMs + E[MT] + sizePenaltyMs
- predictedWpm = 12000 / avgMsPerChar

## Legacy (Linear distance + bigrams)
Given bigram counts c_ab:

- E[dist] = sum(c_ab * D_ab) / sum(c_ab)
- avgMsPerChar = tapTimeMs + moveMsPerUnit * E[dist] + sizePenaltyMs + legacyPixelPenaltyMs
- predictedWpm = 12000 / avgMsPerChar

## Legacy (Linear distance + trigrams)
Same as the legacy formula above, but E[dist] is computed over trigram transitions
(a -> b) and (b -> c) from the trigram counts.

## Generator defaults (for reference)
- tapTimeMs = 140
- fittsAms = 50
- fittsBms = 100
- moveMsPerUnit = 35
