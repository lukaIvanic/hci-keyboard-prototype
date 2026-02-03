(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const THEORY_PARAMS = { tapTimeMs: 140, fittsAms: 50, fittsBms: 100, eps: 1e-6, useCenter: true, useEdge: false };
  const LINEAR_PARAMS = { tapTimeMs: 140, moveMsPerUnit: 35, useCenter: true, useEdge: true };

  // Extra fitness shaping: penalize layouts that produce tiny keys after normalization.
  // Rationale: Shannon Fitts' ID is scale-invariant (scaling both D and W cancels), so without an
  // explicit small-key penalty the GA can converge to layouts that look unusably thin/short.
  const KEY_SIZE_PENALTY = {
    // Keys with min(w,h) >= refDim have 0 penalty.
    refDim: 0.85,
    // Penalty added to avg ms/char for small keys: strengthMs * (1/minDim - 1/refDim).
    strengthMs: 110,
    eps: 1e-6,
  };
  const LEGACY_PIXEL_PENALTY = {
    // Only applies to legacy scoring when a key falls below this pixel size.
    minPx: 100,
    // Penalty added to avg ms/char: strengthMs * (1/minPx - 1/minPxThreshold).
    strengthMs: 55,
    eps: 1e-6,
  };

  const SEARCH_PARAMS = {
    batchSize: 80,
    populationSize: 160,
    eliteCount: 4,
    tournamentK: 2,
    crossoverRate: 0.9,
    mutationRate: 0.35,
    immigrantRate: 0.08,
    sizeMutationRate: 0.15,
    sizeMin: 0.8,
    sizeMax: 1.3,
    maxCacheSize: 1500,
  };

  const INTEGER_SIZE_RANGE = { min: 1, max: 5 };

  const GA_DEFAULTS = {
    eliteCount: SEARCH_PARAMS.eliteCount,
    tournamentK: SEARCH_PARAMS.tournamentK,
    crossoverRate: SEARCH_PARAMS.crossoverRate,
    mutationRate: SEARCH_PARAMS.mutationRate,
    immigrantRate: SEARCH_PARAMS.immigrantRate,
    sizeMutationRate: SEARCH_PARAMS.sizeMutationRate,
    replacementStrategy: "rtr",
    rtrWindow: 12,
  };

  const SCORING_DEFAULT = "linear";
  const OBJECTIVE_DEFAULT = { mode: "maximize", targetWpmStandard: null, targetWpmLegacy: null };
  const PENALTY_MODE_DEFAULT = "all";

  let gaLiveParams = { ...GA_DEFAULTS };
  let scoringModel = SCORING_DEFAULT;
  let objectiveMode = OBJECTIVE_DEFAULT.mode;
  let targetWpmStandard = OBJECTIVE_DEFAULT.targetWpmStandard;
  let targetWpmLegacy = OBJECTIVE_DEFAULT.targetWpmLegacy;
  let penaltyMode = PENALTY_MODE_DEFAULT;
  let batchInFlight = false;

  const cached = {
    keys: null,
    target: null,
    corpus: null,
  };

  let lastGaStats = null;

  const state = {
    running: false,
    generatedTotal: 0,
    bestWpm: -Infinity,
    bestFitness: -Infinity,
    bestDiff: null,
    ga: null,
    sizesMode: null,
    top5: [],
    lastPreviewIndex: 0,
    fatalError: null,
  };

  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el;
  }

  function setText(el, text) {
    el.textContent = String(text);
  }

  function parseFloatOr(value, fallback) {
    const x = Number.parseFloat(String(value));
    return Number.isFinite(x) ? x : fallback;
  }

  function parseFloatOrNull(value) {
    const x = Number.parseFloat(String(value));
    return Number.isFinite(x) ? x : null;
  }

  function parseIntOr(value, fallback) {
    const x = Number.parseInt(String(value), 10);
    return Number.isFinite(x) ? x : fallback;
  }

  function formatRate(x) {
    if (!Number.isFinite(x)) return "—";
    return `${ns.metrics.roundTo(x, 2)}`;
  }

  function normalizeScoringModel(mode) {
    if (mode === "linear") return "linear";
    return mode === "custom" ? "custom" : "standard";
  }

  function normalizePenaltyMode(mode) {
    return mode === "min" ? "min" : "all";
  }

  function applyScoringModel(mode) {
    scoringModel = normalizeScoringModel(mode);
    return scoringModel;
  }

  function syncScoringUi() {
    const select = document.getElementById("scoringModelSelect");
    if (select) select.value = scoringModel;
    const hint = document.getElementById("scoringModelHint");
    if (hint) {
      if (scoringModel === "linear") {
        hint.textContent = "Legacy linear distance + digram scoring.";
      } else if (scoringModel === "custom") {
        hint.textContent = "Custom scoring not implemented yet.";
      } else {
        hint.textContent = "Standard Fitts+digram scoring.";
      }
      if (objectiveMode === "dual") {
        hint.textContent += " (Ignored in dual objective.)";
      } else {
        hint.textContent += " (Used for Maximize/Match target.)";
      }
    }
  }

  function syncObjectiveUi() {
    const maxEl = document.getElementById("objectiveMaximize");
    const targetEl = document.getElementById("objectiveTarget");
    const dualEl = document.getElementById("objectiveDual");
    if (maxEl) maxEl.checked = objectiveMode === "maximize";
    if (targetEl) targetEl.checked = objectiveMode === "target";
    if (dualEl) dualEl.checked = objectiveMode === "dual";
    const scoringSelect = document.getElementById("scoringModelSelect");
    if (scoringSelect) scoringSelect.disabled = objectiveMode === "dual";
    const standardInput = document.getElementById("targetWpmStandardInput");
    const legacyInput = document.getElementById("targetWpmLegacyInput");
    const useBothBtn = document.getElementById("targetUseQwertyBothBtn");
    const enableStandard = objectiveMode === "dual" || (objectiveMode === "target" && scoringModel !== "linear");
    const enableLegacy = objectiveMode === "dual" || (objectiveMode === "target" && scoringModel === "linear");
    if (standardInput) standardInput.disabled = !enableStandard;
    if (legacyInput) legacyInput.disabled = !enableLegacy;
    if (useBothBtn) useBothBtn.disabled = objectiveMode !== "dual";
    const hint = document.getElementById("objectiveHint");
    if (hint) {
      if (objectiveMode === "dual") {
        hint.textContent = "Searches for layouts near both target WPMs (ignores scoring dropdown).";
      } else if (objectiveMode === "target") {
        hint.textContent = "Searches for layouts near the target WPM (uses scoring dropdown).";
      } else {
        hint.textContent = "Searches for the highest predicted WPM (uses scoring dropdown).";
      }
    }
    updateTargetStatus();
  }

  function syncTargetUi() {
    const standardInput = document.getElementById("targetWpmStandardInput");
    const legacyInput = document.getElementById("targetWpmLegacyInput");
    if (standardInput) {
      standardInput.value = Number.isFinite(targetWpmStandard) ? String(ns.metrics.roundTo(targetWpmStandard, 2)) : "";
    }
    if (legacyInput) {
      legacyInput.value = Number.isFinite(targetWpmLegacy) ? String(ns.metrics.roundTo(targetWpmLegacy, 2)) : "";
    }
  }

  function updateTargetStatus() {
    const statusEl = document.getElementById("targetWpmStatus");
    if (!statusEl) return;
    if (objectiveMode === "maximize") {
      statusEl.textContent = "Only used in Match modes.";
      return;
    }
    if (objectiveMode === "dual") {
      if (Number.isFinite(targetWpmStandard) && Number.isFinite(targetWpmLegacy)) {
        statusEl.textContent = `Targets set to ${ns.metrics.roundTo(targetWpmStandard, 2)} / ${ns.metrics.roundTo(
          targetWpmLegacy,
          2
        )} wpm.`;
      } else {
        statusEl.textContent = "Enter standard and legacy target WPMs.";
      }
      return;
    }
    const activeTarget = scoringModel === "linear" ? targetWpmLegacy : targetWpmStandard;
    const label = scoringModel === "linear" ? "legacy" : "standard";
    statusEl.textContent = Number.isFinite(activeTarget)
      ? `Target (${label}) set to ${ns.metrics.roundTo(activeTarget, 2)} wpm.`
      : `Enter ${label} target WPM.`;
  }

  function applyObjectiveMode(mode) {
    objectiveMode = mode === "dual" ? "dual" : mode === "target" ? "target" : "maximize";
  }

  function applyTargetStandardFromUi(value) {
    targetWpmStandard = parseFloatOrNull(value);
    updateTargetStatus();
  }

  function applyTargetLegacyFromUi(value) {
    targetWpmLegacy = parseFloatOrNull(value);
    updateTargetStatus();
  }

  function entryFitness(entry) {
    if (Number.isFinite(entry?.fitness)) return entry.fitness;
    return Number.isFinite(entry?.predictedWpm) ? entry.predictedWpm : -Infinity;
  }

  function activeTargetForSingle() {
    return scoringModel === "linear" ? targetWpmLegacy : targetWpmStandard;
  }

  function computeFitnessSingle(predictedWpm) {
    if (!Number.isFinite(predictedWpm)) return -Infinity;
    if (objectiveMode === "target") {
      const target = activeTargetForSingle();
      if (!Number.isFinite(target)) return -Infinity;
      return -Math.abs(predictedWpm - target);
    }
    return predictedWpm;
  }

  function computeFitnessDual(predictedWpmStandard, predictedWpmLegacy) {
    if (!Number.isFinite(predictedWpmStandard) || !Number.isFinite(predictedWpmLegacy)) return -Infinity;
    if (!Number.isFinite(targetWpmStandard) || !Number.isFinite(targetWpmLegacy)) return -Infinity;
    const diffStandard = Math.abs(predictedWpmStandard - targetWpmStandard);
    const diffLegacy = Math.abs(predictedWpmLegacy - targetWpmLegacy);
    return -(diffStandard + diffLegacy);
  }

  function computeTargetDiffSingle(predictedWpm) {
    if (objectiveMode !== "target") return null;
    const target = activeTargetForSingle();
    if (!Number.isFinite(target) || !Number.isFinite(predictedWpm)) return null;
    return Math.abs(predictedWpm - target);
  }

  function computeTargetDiffStandard(predictedWpmStandard) {
    if (!Number.isFinite(targetWpmStandard) || !Number.isFinite(predictedWpmStandard)) return null;
    return Math.abs(predictedWpmStandard - targetWpmStandard);
  }

  function computeTargetDiffLegacy(predictedWpmLegacy) {
    if (!Number.isFinite(targetWpmLegacy) || !Number.isFinite(predictedWpmLegacy)) return null;
    return Math.abs(predictedWpmLegacy - targetWpmLegacy);
  }

  function distanceModeLabelForModel(model) {
    return model === "linear" ? "center+edge" : "center";
  }

  function syncGaUiFromParams(params) {
    // Sliders
    $("gaMutationRate").value = String(params.mutationRate);
    setText($("gaMutationRateValue"), formatRate(params.mutationRate));

    $("gaImmigrantRate").value = String(params.immigrantRate);
    setText($("gaImmigrantRateValue"), formatRate(params.immigrantRate));

    $("gaCrossoverRate").value = String(params.crossoverRate);
    setText($("gaCrossoverRateValue"), formatRate(params.crossoverRate));

    $("gaSizeMutationRate").value = String(params.sizeMutationRate);
    setText($("gaSizeMutationRateValue"), formatRate(params.sizeMutationRate));

    // Integers
    $("gaTournamentK").value = String(params.tournamentK);
    $("gaEliteCount").value = String(params.eliteCount);
    $("gaRtrWindow").value = String(params.rtrWindow);
  }

  function readGaUiParams() {
    return {
      mutationRate: parseFloatOr($("gaMutationRate").value, GA_DEFAULTS.mutationRate),
      immigrantRate: parseFloatOr($("gaImmigrantRate").value, GA_DEFAULTS.immigrantRate),
      crossoverRate: parseFloatOr($("gaCrossoverRate").value, GA_DEFAULTS.crossoverRate),
      sizeMutationRate: parseFloatOr($("gaSizeMutationRate").value, GA_DEFAULTS.sizeMutationRate),
      tournamentK: parseIntOr($("gaTournamentK").value, GA_DEFAULTS.tournamentK),
      eliteCount: parseIntOr($("gaEliteCount").value, GA_DEFAULTS.eliteCount),
      rtrWindow: parseIntOr($("gaRtrWindow").value, GA_DEFAULTS.rtrWindow),
      replacementStrategy: "rtr",
    };
  }

  function applyGaParamsFromUi() {
    gaLiveParams = readGaUiParams();
    syncGaUiFromParams(gaLiveParams);
    if (state.ga && typeof state.ga.setParams === "function") {
      state.ga.setParams(gaLiveParams);
      lastGaStats = state.ga.getStats ? state.ga.getStats() : null;
    }
    updateStatus();
  }

  function nowTimeString() {
    const d = new Date();
    return d.toLocaleTimeString();
  }

  function resetSearch() {
    state.ga = null;
    state.sizesMode = null;
    lastGaStats = null;
  }

  function getDefaultKeys() {
    if (!cached.keys) cached.keys = makeDefaultKeys();
    return cached.keys;
  }

  function getCanonicalTarget() {
    if (!cached.target) cached.target = canonicalTargetFromQwerty();
    return cached.target;
  }

  function getCorpusCached() {
    if (!cached.corpus) cached.corpus = requireGutenbergCorpus();
    return cached.corpus;
  }

  function normalizeSizesMode(sizesMode) {
    return sizesMode === "integer" ? "integer" : sizesMode === "random" ? "random" : "fixed";
  }

  function createGa(sizesMode) {
    const mode = normalizeSizesMode(sizesMode);
    const includeSizes = mode !== "fixed";
    const sizeMin = mode === "integer" ? INTEGER_SIZE_RANGE.min : SEARCH_PARAMS.sizeMin;
    const sizeMax = mode === "integer" ? INTEGER_SIZE_RANGE.max : SEARCH_PARAMS.sizeMax;
    const keys = getDefaultKeys();
    return ns.geneticSearch.createSequencePairGA({
      n: keys.length,
      includeSizes,
      sizeMin,
      sizeMax,
      populationSize: SEARCH_PARAMS.populationSize,
      eliteCount: gaLiveParams.eliteCount,
      tournamentK: gaLiveParams.tournamentK,
      crossoverRate: gaLiveParams.crossoverRate,
      mutationRate: gaLiveParams.mutationRate,
      sizeMutationRate: gaLiveParams.sizeMutationRate,
      immigrantRate: gaLiveParams.immigrantRate,
      maxCacheSize: 0,
      replacementStrategy: gaLiveParams.replacementStrategy,
      rtrWindow: gaLiveParams.rtrWindow,
    });
  }

  function ensureGa(sizesMode) {
    const mode = normalizeSizesMode(sizesMode);
    if (state.ga && state.sizesMode === mode) return;
    state.ga = createGa(mode);
    state.sizesMode = mode;
    lastGaStats = null;
  }

  function getGaStats() {
    return state.ga?.getStats ? state.ga.getStats() : null;
  }

  function clampInt(x, min, max) {
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function quantizeSizeArray(arr, min, max) {
    return arr.map((v) => clampInt(Math.round(v), min, max));
  }

  function evaluateGenomesLocal(genomes, sizesMode, target) {
    const out = [];
    for (const genome of genomes) {
      if (!genome) {
        out.push(null);
        continue;
      }

      const spec = {
        id: "sp_candidate",
        name: "Candidate",
        keys: getDefaultKeys(),
        seqA: genome.seqA,
        seqB: genome.seqB,
      };

      if (sizesMode === "random") {
        spec.wRaw = genome.wRaw;
        spec.hRaw = genome.hRaw;
      } else if (sizesMode === "integer") {
        spec.wRaw = quantizeSizeArray(genome.wRaw, INTEGER_SIZE_RANGE.min, INTEGER_SIZE_RANGE.max);
        spec.hRaw = quantizeSizeArray(genome.hRaw, INTEGER_SIZE_RANGE.min, INTEGER_SIZE_RANGE.max);
      }

      let layout = null;
      try {
        layout = ns.layouts.compileSequencePair(spec, target);
      } catch {
        out.push(null);
        continue;
      }

      const scoredStandard = scoreLayoutStandard(layout);
      const scoredLegacy = scoreLayoutLinear(layout);
      const primary = scoringModel === "linear" ? scoredLegacy : scoredStandard;
      if (!primary || !Number.isFinite(primary.predictedWpm)) {
        out.push(null);
        continue;
      }
      const predictedWpmStandard = scoredStandard?.predictedWpm;
      const predictedWpmLegacy = scoredLegacy?.predictedWpm;
      const targetDiffStandard = computeTargetDiffStandard(predictedWpmStandard);
      const targetDiffLegacy = computeTargetDiffLegacy(predictedWpmLegacy);
      const targetDiffCombined =
        Number.isFinite(targetDiffStandard) && Number.isFinite(targetDiffLegacy) ? targetDiffStandard + targetDiffLegacy : null;
      const fitness =
        objectiveMode === "dual" ? computeFitnessDual(predictedWpmStandard, predictedWpmLegacy) : computeFitnessSingle(primary.predictedWpm);
      const targetDiff = objectiveMode === "dual" ? targetDiffCombined : computeTargetDiffSingle(primary.predictedWpm);
      out.push({
        predictedWpm: primary.predictedWpm,
        avgMsPerChar: primary.avgMsPerChar,
        predictedWpmStandard,
        predictedWpmLegacy,
        avgMsPerCharStandard: scoredStandard?.avgMsPerChar,
        avgMsPerCharLegacy: scoredLegacy?.avgMsPerChar,
        targetDiffStandard,
        targetDiffLegacy,
        fitness,
        targetDiff,
        layout,
        genome,
      });
    }
    return out;
  }


  function makeDefaultKeys() {
    // a..z, space, backspace (enter is fixed on the right for all layouts)
    const keys = [];
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      keys.push({ id: ch, label: ch.toUpperCase(), type: "char" });
    }
    keys.push({ id: "space", label: "Space", type: "space" });
    keys.push({ id: "backspace", label: "⌫", type: "backspace" });
    return keys;
  }

  function canonicalTargetFromQwerty() {
    const q = ns.layouts.getLayoutById("qwerty");
    const b = ns.layouts.getLayoutBounds(q);
    return { targetW: b.width, targetH: b.height };
  }

  function formatCorpusChar(ch) {
    if (ch === " ") return "_";
    if (ch === "\n") return "↵";
    return ch;
  }

  function formatAlphabet(alphabet) {
    return String(alphabet ?? "")
      .split("")
      .map((ch) => formatCorpusChar(ch))
      .join("");
  }

  function requireGutenbergCorpus() {
    const corpus = ns.corpus?.gutenberg;
    if (!corpus) throw new Error("Missing corpus: ns.corpus.gutenberg is not loaded");
    if (typeof corpus.bookId !== "number") throw new Error("Invalid corpus: missing bookId");
    if (!Array.isArray(corpus.countsFlat)) throw new Error("Invalid corpus: missing countsFlat");
    if (typeof corpus.alphabet !== "string") throw new Error("Invalid corpus: missing alphabet");
    if (!Number.isFinite(corpus.totalBigrams) || corpus.totalBigrams <= 0) throw new Error("Invalid corpus: totalBigrams must be > 0");
    if (!ns.theory?.distanceLinear?.estimateLayoutFromBigramCountsFitts) {
      throw new Error("Missing scorer: ns.theory.distanceLinear.estimateLayoutFromBigramCountsFitts");
    }
    return corpus;
  }

  function computeSizePenalty(layout) {
    let minDim = Infinity;
    let penaltySum = 0;
    let penaltyCount = 0;
    for (const k of layout.keys) {
      const keyMin = Math.min(k.w, k.h);
      minDim = Math.min(minDim, keyMin);
      if (penaltyMode === "all" && keyMin > 0 && keyMin < KEY_SIZE_PENALTY.refDim) {
        const inv = 1 / Math.max(keyMin, KEY_SIZE_PENALTY.eps);
        const invRef = 1 / KEY_SIZE_PENALTY.refDim;
        penaltySum += KEY_SIZE_PENALTY.strengthMs * Math.max(0, inv - invRef);
        penaltyCount += 1;
      }
    }
    if (!Number.isFinite(minDim)) minDim = 0;
    let penaltyMs = 0;
    if (penaltyMode === "min") {
      if (minDim > 0 && minDim < KEY_SIZE_PENALTY.refDim) {
        const inv = 1 / Math.max(minDim, KEY_SIZE_PENALTY.eps);
        const invRef = 1 / KEY_SIZE_PENALTY.refDim;
        penaltyMs = KEY_SIZE_PENALTY.strengthMs * Math.max(0, inv - invRef);
      }
    } else {
      penaltyMs = penaltyCount > 0 ? penaltySum / penaltyCount : 0;
    }
    return { minDim, penaltyMs };
  }

  function getLayoutUnitPx(layout) {
    const container = document.getElementById("keyboardContainer");
    if (!container) return null;
    const bounds = ns.layouts.getLayoutBounds(layout);
    if (!bounds || !Number.isFinite(bounds.width) || bounds.width <= 0) return null;
    const paddingPx = 10;
    const usableWidthPx = Math.max(200, container.clientWidth - paddingPx * 2);
    return usableWidthPx / bounds.width;
  }

  function computeLegacyPixelPenalty(layout) {
    const unitPx = getLayoutUnitPx(layout);
    if (!Number.isFinite(unitPx)) return 0;
    let minPx = Infinity;
    for (const k of layout.keys) {
      const wPx = k.w * unitPx;
      const hPx = k.h * unitPx;
      minPx = Math.min(minPx, wPx, hPx);
    }
    if (!Number.isFinite(minPx) || minPx >= LEGACY_PIXEL_PENALTY.minPx) return 0;
    const inv = 1 / Math.max(minPx, LEGACY_PIXEL_PENALTY.eps);
    const invRef = 1 / LEGACY_PIXEL_PENALTY.minPx;
    return LEGACY_PIXEL_PENALTY.strengthMs * Math.max(0, inv - invRef);
  }

  function scoreLayoutStandard(layout) {
    const corpus = getCorpusCached();
    const base = ns.theory.distanceLinear.estimateLayoutFromBigramCountsFitts(layout, corpus, THEORY_PARAMS);
    const { minDim, penaltyMs } = computeSizePenalty(layout);
    const avgMsPerChar = (base.avgMsPerChar ?? 0) + penaltyMs;
    const predictedWpm = ns.metrics.computeWpm(1, avgMsPerChar);
    return { predictedWpm, avgMsPerChar, minKeyDim: minDim, sizePenaltyMs: penaltyMs };
  }

  function scoreLayoutLinear(layout) {
    const corpus = getCorpusCached();
    const base = ns.theory.distanceLinear.estimateLayoutFromBigramCounts(layout, corpus, LINEAR_PARAMS);
    const { minDim, penaltyMs } = computeSizePenalty(layout);
    const legacyPixelPenaltyMs = computeLegacyPixelPenalty(layout);
    const avgMsPerChar = (base.avgMsPerChar ?? 0) + penaltyMs + legacyPixelPenaltyMs;
    const predictedWpm = ns.metrics.computeWpm(1, avgMsPerChar);
    return {
      predictedWpm,
      avgMsPerChar,
      minKeyDim: minDim,
      sizePenaltyMs: penaltyMs,
      legacyPixelPenaltyMs,
    };
  }

  function scoreLayout(layout) {
    // Fail fast: no silent fallback. Generator requires Gutenberg bigrams.
    getCorpusCached();
    if (scoringModel === "linear") {
      return scoreLayoutLinear(layout);
    }
    if (scoringModel === "custom") {
      return scoreLayoutStandard(layout);
    }
    return scoreLayoutStandard(layout);
  }

  function computeQwertyWpmStandard() {
    const qwerty = ns.layouts.getLayoutById("qwerty");
    if (!qwerty) return null;
    const scored = scoreLayoutStandard(qwerty);
    return Number.isFinite(scored?.predictedWpm) ? scored.predictedWpm : null;
  }

  function computeQwertyWpmLegacy() {
    const qwerty = ns.layouts.getLayoutById("qwerty");
    if (!qwerty) return null;
    const scored = scoreLayoutLinear(qwerty);
    return Number.isFinite(scored?.predictedWpm) ? scored.predictedWpm : null;
  }

  function updateQwertyWpm() {
    const stdEl = document.getElementById("qwertyWpmValueStandard");
    const legacyEl = document.getElementById("qwertyWpmValueLegacy");
    if (!stdEl && !legacyEl) return;
    try {
      const wpmStandard = computeQwertyWpmStandard();
      const wpmLegacy = computeQwertyWpmLegacy();
      if (stdEl) stdEl.textContent = Number.isFinite(wpmStandard) ? String(ns.metrics.roundTo(wpmStandard, 2)) : "—";
      if (legacyEl) legacyEl.textContent = Number.isFinite(wpmLegacy) ? String(ns.metrics.roundTo(wpmLegacy, 2)) : "—";
    } catch {
      if (stdEl) stdEl.textContent = "—";
      if (legacyEl) legacyEl.textContent = "—";
    }
  }

  function upsertTop5(entry) {
    if (!entry || !entry.layout || !entry.signature) return false;
    const idx = state.top5.findIndex((it) => it.signature === entry.signature);
    if (idx >= 0) {
      if (entryFitness(entry) <= entryFitness(state.top5[idx])) return false;
      state.top5[idx] = entry;
    } else {
      state.top5.push(entry);
    }
    state.top5.sort((a, b) => entryFitness(b) - entryFitness(a));
    if (state.top5.length > 5) state.top5 = state.top5.slice(0, 5);
    return true;
  }

  function signatureOfLayout(layout) {
    // Simple stable signature for UI de-duplication.
    // (Not cryptographic; just helps avoid repeated entries.)
    const parts = [];
    for (const k of layout.keys) {
      parts.push(`${k.id}:${ns.metrics.roundTo(k.x, 3)}:${ns.metrics.roundTo(k.y, 3)}:${ns.metrics.roundTo(k.w, 3)}:${ns.metrics.roundTo(k.h, 3)}`);
    }
    return parts.join("|");
  }

  function renderPreview(layout) {
    ns.keyboard.renderKeyboard($("keyboardContainer"), layout, function () {});
  }

  function currentPreviewEntry() {
    const idx = Math.min(state.lastPreviewIndex, state.top5.length - 1);
    if (idx < 0) return null;
    return state.top5[idx] || null;
  }

  function updateSavePanel() {
    const entry = currentPreviewEntry();
    const btn = $("saveLayoutBtn");
    const input = $("saveLayoutName");
    if (!entry) {
      btn.disabled = true;
      input.disabled = true;
      setText($("saveLayoutStatus"), "");
      input.value = "";
      return;
    }
    btn.disabled = false;
    input.disabled = false;
    if (!String(input.value ?? "").trim()) {
      input.value = `GA ${ns.metrics.roundTo(entry.predictedWpm, 2)} WPM (${entry.sizesMode})`;
    }
  }

  function renderLeaderboard() {
    const tbody = $("leaderboardBody");
    tbody.innerHTML = "";

    state.top5.forEach((it, idx) => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => {
        state.lastPreviewIndex = idx;
        renderPreview(it.layout);
        updateSavePanel();
      });

      const wpmLabel =
        objectiveMode === "dual"
          ? `Std ${Number.isFinite(it.predictedWpmStandard) ? ns.metrics.roundTo(it.predictedWpmStandard, 2) : "—"} / Leg ${
              Number.isFinite(it.predictedWpmLegacy) ? ns.metrics.roundTo(it.predictedWpmLegacy, 2) : "—"
            }${Number.isFinite(it.targetDiff) ? ` (Δ ${ns.metrics.roundTo(it.targetDiff, 2)})` : ""}`
          : objectiveMode === "target" && Number.isFinite(it.targetDiff)
          ? `${ns.metrics.roundTo(it.predictedWpm, 2)} (Δ ${ns.metrics.roundTo(it.targetDiff, 2)})`
          : ns.metrics.roundTo(it.predictedWpm, 2);
      const avgLabel =
        objectiveMode === "dual"
          ? `${Number.isFinite(it.avgMsPerCharStandard) ? ns.metrics.roundTo(it.avgMsPerCharStandard, 1) : "—"} / ${
              Number.isFinite(it.avgMsPerCharLegacy) ? ns.metrics.roundTo(it.avgMsPerCharLegacy, 1) : "—"
            }`
          : ns.metrics.roundTo(it.avgMsPerChar, 1);
      const cells = [idx + 1, wpmLabel, avgLabel, it.sizesMode, it.generatedAt];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    updateSavePanel();
  }

  function updateStatus() {
    if (state.fatalError) {
      setText($("statusText"), `ERROR: ${state.fatalError}`);
      setText($("statusDetails"), "Fix the corpus load problem and reload the page.");
      return;
    }

    const status = state.running ? "Running…" : "Idle.";
    setText($("statusText"), status);

    let corpus = null;
    try {
      corpus = getCorpusCached();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.fatalError = message;
      state.running = false;
      $("startStopBtn").disabled = true;
      $("sizeModeSelect").disabled = true;
      $("startStopBtn").textContent = "Start";
      setText($("statusText"), `ERROR: ${state.fatalError}`);
      setText($("statusDetails"), "Fix the corpus load problem and reload the page.");
      return;
    }

    updateQwertyWpm();

    const scoringModelLabel =
      objectiveMode === "dual"
        ? "Standard+Legacy"
        : scoringModel === "linear"
        ? "Legacy (Linear+digram)"
        : scoringModel === "custom"
        ? "Custom (coming soon)"
        : "Standard (Fitts+digram)";
    const penaltyLabel = penaltyMode === "min" ? "min-key penalty" : "all-keys penalty";
    const distLabel =
      objectiveMode === "dual"
        ? `std:${distanceModeLabelForModel("standard")}, legacy:${distanceModeLabelForModel("linear")}`
        : distanceModeLabelForModel(scoringModel);
    const scoring = `Scoring: ${scoringModelLabel} • Gutenberg bigrams (pg${corpus.bookId}) • dist=${distLabel} • ${penaltyLabel}`;
    const objective =
      objectiveMode === "dual"
        ? `Objective: Match std ${Number.isFinite(targetWpmStandard) ? ns.metrics.roundTo(targetWpmStandard, 2) : "—"} + legacy ${
            Number.isFinite(targetWpmLegacy) ? ns.metrics.roundTo(targetWpmLegacy, 2) : "—"
          } wpm (best Δ ${Number.isFinite(state.bestDiff) ? ns.metrics.roundTo(state.bestDiff, 2) : "—"})`
        : objectiveMode === "target"
        ? `Objective: Match ${
            Number.isFinite(activeTargetForSingle()) ? ns.metrics.roundTo(activeTargetForSingle(), 2) : "—"
          } wpm (best Δ ${Number.isFinite(state.bestDiff) ? ns.metrics.roundTo(state.bestDiff, 2) : "—"})`
        : "Objective: Maximize WPM";
    const search = "Search: genetic algorithm (sequence-pair)";
    const gaStats = lastGaStats ?? getGaStats();
    const gaExtra = gaStats
      ? ` • GA pop: ${gaStats.populationSize.toLocaleString()} • Cache: ${gaStats.cacheSize.toLocaleString()} • mut=${ns.metrics.roundTo(
          gaLiveParams.mutationRate,
          2
        )} imm=${ns.metrics.roundTo(gaLiveParams.immigrantRate, 2)} k=${gaLiveParams.tournamentK} elite=${gaLiveParams.eliteCount} rtr=${
          gaLiveParams.rtrWindow
        } • Batch: ${SEARCH_PARAMS.batchSize}`
      : ` • Batch: ${SEARCH_PARAMS.batchSize}`;

    setText(
      $("statusDetails"),
      `${scoring} • ${objective} • ${search} • Generated: ${state.generatedTotal.toLocaleString()} • Best WPM: ${
        Number.isFinite(state.bestWpm) ? ns.metrics.roundTo(state.bestWpm, 2) : "—"
      } • Top5 size: ${state.top5.length}${gaExtra}`
    );
  }

  function renderCorpusPanel() {
    const corpus = getCorpusCached();
    const meta = `Loaded: Project Gutenberg pg${corpus.bookId} • Alphabet: "${formatAlphabet(
      corpus.alphabet
    )}" • Total bigrams: ${ns.metrics.roundTo(corpus.totalBigrams, 0).toLocaleString()} • Generated: ${
      corpus.generatedAt ?? "—"
    }`;
    setText($("corpusMeta"), meta);

    // Top 60 bigrams by count
    const K = corpus.alphabet.length;
    const items = [];
    for (let i = 0; i < corpus.countsFlat.length; i++) {
      const c = corpus.countsFlat[i] || 0;
      if (c <= 0) continue;
      const a = Math.floor(i / K);
      const b = i % K;
      const chA = corpus.alphabet[a];
      const chB = corpus.alphabet[b];
      items.push({ a: chA, b: chB, count: c });
    }
    items.sort((x, y) => y.count - x.count);

    const topN = 60;
    const tbody = $("bigramsTableBody");
    tbody.innerHTML = "";
    for (let r = 0; r < Math.min(topN, items.length); r++) {
      const it = items[r];
      const tr = document.createElement("tr");
      const bigram = `${formatCorpusChar(it.a)}${formatCorpusChar(it.b)}`;
      const pct = (it.count / corpus.totalBigrams) * 100;

      const cells = [r + 1, bigram, it.count.toLocaleString(), `${ns.metrics.roundTo(pct, 2)}%`];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    $("downloadCorpusJsonBtn").addEventListener("click", () => {
      const json = JSON.stringify(corpus, null, 2);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gutenberg_pg${corpus.bookId}_bigrams.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    });
  }

  function clearAll() {
    state.running = false;
    resetSearch();
    state.generatedTotal = 0;
    state.bestWpm = -Infinity;
    state.bestFitness = -Infinity;
    state.bestDiff = null;
    state.top5 = [];
    state.lastPreviewIndex = 0;
    state.fatalError = null;
    $("leaderboardBody").innerHTML = "";
    $("startStopBtn").textContent = "Start";
    setText($("saveLayoutStatus"), "");
    updateStatus();
    updateSavePanel();
  }

  async function generateBatch() {
    if (batchInFlight) return;
    batchInFlight = true;
    try {
      const sizesMode = String($("sizeModeSelect").value ?? "fixed");
      ensureGa(sizesMode);
      const target = getCanonicalTarget();
      const batchSize = SEARCH_PARAMS.batchSize;
      const ga = state.ga;
      if (!ga) {
        updateStatus();
        return;
      }

      const { genomes } = ga.generateGenomes(batchSize);
      const evals = evaluateGenomesLocal(genomes, sizesMode, target);
      const { evaluations } = ga.ingestEvaluations(evals);

      let leaderboardChanged = false;
      for (const ev of evaluations) {
        const predictedWpm = ev.predictedWpm;
        const fitness = entryFitness(ev);
        state.generatedTotal += 1;

        if (Number.isFinite(predictedWpm) && predictedWpm > state.bestWpm) {
          state.bestWpm = predictedWpm;
        }
        if (Number.isFinite(fitness) && fitness > state.bestFitness) {
          state.bestFitness = fitness;
          state.bestDiff = Number.isFinite(ev.targetDiff) ? ev.targetDiff : null;
        }

        if (!ev.layout) continue;
        const entry = {
          predictedWpm,
          avgMsPerChar: ev.avgMsPerChar,
          predictedWpmStandard: ev.predictedWpmStandard,
          predictedWpmLegacy: ev.predictedWpmLegacy,
          avgMsPerCharStandard: ev.avgMsPerCharStandard,
          avgMsPerCharLegacy: ev.avgMsPerCharLegacy,
          targetDiffStandard: ev.targetDiffStandard,
          targetDiffLegacy: ev.targetDiffLegacy,
          fitness,
          targetDiff: ev.targetDiff ?? null,
          sizesMode,
          generatedAt: nowTimeString(),
          layout: ev.layout,
          signature: signatureOfLayout(ev.layout),
        };
        if (upsertTop5(entry)) leaderboardChanged = true;
      }

      lastGaStats = getGaStats();

      if (leaderboardChanged) {
        renderLeaderboard();
        const idx = Math.min(state.lastPreviewIndex, state.top5.length - 1);
        if (state.top5[idx]) renderPreview(state.top5[idx].layout);
      }

      updateStatus();
    } finally {
      batchInFlight = false;
    }
  }

  async function loop() {
    if (!state.running) return;
    await generateBatch();
    setTimeout(loop, 0);
  }

  function setRunning(running) {
    if (state.fatalError) return;
    state.running = running;
    $("startStopBtn").textContent = running ? "Stop" : "Start";
    updateStatus();
    if (running) loop();
  }

  function init() {
    applyScoringModel(SCORING_DEFAULT);
    syncScoringUi();
    syncTargetUi();
    syncObjectiveUi();
    const penaltySelect = document.getElementById("sizePenaltyModeSelect");
    if (penaltySelect) penaltySelect.value = penaltyMode;

    clearAll();

    // Hard requirement: corpus must exist; show a fatal error if not.
    try {
      renderCorpusPanel();
      // Prime status string (also validates corpus).
      updateStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.fatalError = message;
      console.error(err);
      $("startStopBtn").disabled = true;
      $("sizeModeSelect").disabled = true;
      updateStatus();
    }

    $("startStopBtn").addEventListener("click", () => setRunning(!state.running));
    $("resetBtn").addEventListener("click", clearAll);
    $("sizeModeSelect").addEventListener("change", () => {
      // No auto-restart; the user can stop/start to compare.
      clearAll();
    });


    updateQwertyWpm();
    updateTargetStatus();

    const scoringSelect = document.getElementById("scoringModelSelect");
    if (scoringSelect) {
      scoringSelect.addEventListener("change", () => {
        const wasRunning = state.running;
        applyScoringModel(scoringSelect.value);
        syncScoringUi();
        syncObjectiveUi();
        clearAll();
        updateQwertyWpm();
        updateTargetStatus();
        if (wasRunning) setRunning(true);
      });
    }

    if (penaltySelect) {
      penaltySelect.addEventListener("change", () => {
        const wasRunning = state.running;
        penaltyMode = normalizePenaltyMode(penaltySelect.value);
        clearAll();
        updateQwertyWpm();
        updateStatus();
        if (wasRunning) setRunning(true);
      });
    }

    const objectiveMax = document.getElementById("objectiveMaximize");
    const objectiveTarget = document.getElementById("objectiveTarget");
    const objectiveDual = document.getElementById("objectiveDual");
    const onObjectiveChange = () => {
      const wasRunning = state.running;
      objectiveMode = objectiveDual?.checked ? "dual" : objectiveTarget?.checked ? "target" : "maximize";
      syncObjectiveUi();
      syncScoringUi();
      clearAll();
      if (wasRunning) setRunning(true);
    };
    if (objectiveMax) objectiveMax.addEventListener("change", onObjectiveChange);
    if (objectiveTarget) objectiveTarget.addEventListener("change", onObjectiveChange);
    if (objectiveDual) objectiveDual.addEventListener("change", onObjectiveChange);

    const targetStandardInput = document.getElementById("targetWpmStandardInput");
    if (targetStandardInput) {
      targetStandardInput.addEventListener("input", () => {
        applyTargetStandardFromUi(targetStandardInput.value);
        updateStatus();
      });
      targetStandardInput.addEventListener("change", () => {
        const wasRunning = state.running;
        applyTargetStandardFromUi(targetStandardInput.value);
        if (objectiveMode === "target" || objectiveMode === "dual") {
          clearAll();
          if (wasRunning) setRunning(true);
        } else {
          updateStatus();
        }
      });
    }

    const targetLegacyInput = document.getElementById("targetWpmLegacyInput");
    if (targetLegacyInput) {
      targetLegacyInput.addEventListener("input", () => {
        applyTargetLegacyFromUi(targetLegacyInput.value);
        updateStatus();
      });
      targetLegacyInput.addEventListener("change", () => {
        const wasRunning = state.running;
        applyTargetLegacyFromUi(targetLegacyInput.value);
        if (objectiveMode === "target" || objectiveMode === "dual") {
          clearAll();
          if (wasRunning) setRunning(true);
        } else {
          updateStatus();
        }
      });
    }

    const targetQwertyBtn = document.getElementById("targetUseQwertyBothBtn");
    if (targetQwertyBtn) {
      targetQwertyBtn.addEventListener("click", () => {
        const wpmStandard = computeQwertyWpmStandard();
        const wpmLegacy = computeQwertyWpmLegacy();
        if (!Number.isFinite(wpmStandard) || !Number.isFinite(wpmLegacy)) return;
        targetWpmStandard = wpmStandard;
        targetWpmLegacy = wpmLegacy;
        syncTargetUi();
        updateTargetStatus();
        const wasRunning = state.running;
        if (objectiveMode === "target" || objectiveMode === "dual") {
          clearAll();
          if (wasRunning) setRunning(true);
        } else {
          updateStatus();
        }
      });
    }

    // GA live controls
    syncGaUiFromParams(gaLiveParams);
    const onGaControl = () => applyGaParamsFromUi();
    $("gaMutationRate").addEventListener("input", onGaControl);
    $("gaImmigrantRate").addEventListener("input", onGaControl);
    $("gaCrossoverRate").addEventListener("input", onGaControl);
    $("gaSizeMutationRate").addEventListener("input", onGaControl);
    $("gaTournamentK").addEventListener("change", onGaControl);
    $("gaEliteCount").addEventListener("change", onGaControl);
    $("gaRtrWindow").addEventListener("change", onGaControl);

    // Save layout to main typing page (localStorage-backed)
    $("saveLayoutBtn").addEventListener("click", () => {
      const entry = currentPreviewEntry();
      if (!entry) return;

      const name = String($("saveLayoutName").value ?? "").trim() || `GA ${ns.metrics.roundTo(entry.predictedWpm, 2)} WPM`;
      try {
        const saved = ns.layouts.saveUserLayout(entry.layout, { name });
        setText($("saveLayoutStatus"), `Saved as "${saved.name}" (id: ${saved.id}). Reload the typing page to see it in the dropdown.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setText($("saveLayoutStatus"), `Save failed: ${msg}`);
      }
    });

    const exportBtn = document.getElementById("exportLayoutsBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        const records = ns.layouts.exportUserLayouts();
        if (!Array.isArray(records) || !records.length) {
          setText($("saveLayoutStatus"), "No saved layouts to export.");
          return;
        }
        const json = JSON.stringify(records, null, 2);
        const blob = new Blob([json], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "baked_layouts.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 500);
        setText($("saveLayoutStatus"), `Downloaded ${records.length} layout(s).`);
      });
    }

    $("clearSavedLayoutsBtn").addEventListener("click", () => {
      try {
        ns.layouts.clearUserLayouts();
        setText($("saveLayoutStatus"), "Cleared saved layouts.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setText($("saveLayoutStatus"), `Clear failed: ${msg}`);
      }
    });

    // Preview something stable on load (QWERTY).
    const qwerty = ns.layouts.getLayoutById("qwerty");
    if (qwerty) renderPreview(qwerty);
    updateSavePanel();
  }

  window.addEventListener("DOMContentLoaded", init);
})();

