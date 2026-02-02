(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const DISTANCE_MODE_STORAGE_KEY = "KbdStudy.distanceMode.v1";
  const THEORY_PARAMS = { tapTimeMs: 140, fittsAms: 50, fittsBms: 100, eps: 1e-6, useCenter: true, useEdge: true };

  // Extra fitness shaping: penalize layouts that produce tiny keys after normalization.
  // Rationale: Shannon Fitts' ID is scale-invariant (scaling both D and W cancels), so without an
  // explicit small-key penalty the GA can converge to layouts that look unusably thin/short.
  const KEY_SIZE_PENALTY = {
    // Keys with min(w,h) >= refDim have 0 penalty.
    refDim: 0.85,
    // Penalty added to avg ms/char for small keys: strengthMs * (1/minDim - 1/refDim).
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
    sizeMax: 1.6,
    maxCacheSize: 1500,
  };

  const INTEGER_SIZE_RANGE = { min: 1, max: 5 };

  const ISLAND_DEFAULTS = {
    initialCount: 10,
    maxCount: 20,
    spawnEvery: 10000,
    minAgeEvals: 2000,
  };

  const ISLAND_LIMITS = {
    initialMin: 1,
    initialMax: 100,
    maxMin: 1,
    maxMax: 100,
    spawnMin: 0,
    spawnMax: 1000000,
    minAgeMin: 0,
    minAgeMax: 1000000,
  };

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

  let gaLiveParams = { ...GA_DEFAULTS };
  let distanceMode = { useCenter: true, useEdge: true };
  let batchInFlight = false;

  const cached = {
    keys: null,
    target: null,
    corpus: null,
  };

  let islandsMode = null; // "fixed" | "random" | "integer"
  let nextIslandId = 1;
  let islandSettings = { ...ISLAND_DEFAULTS };
  let lastGaStats = null;

  const state = {
    running: false,
    generatedTotal: 0,
    bestWpm: -Infinity,
    islands: [],
    nextSpawnAt: islandSettings.spawnEvery,
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

  function parseIntOr(value, fallback) {
    const x = Number.parseInt(String(value), 10);
    return Number.isFinite(x) ? x : fallback;
  }

  function formatRate(x) {
    if (!Number.isFinite(x)) return "—";
    return `${ns.metrics.roundTo(x, 2)}`;
  }

  function normalizeDistanceMode(mode) {
    const useCenter = mode?.useCenter !== undefined ? !!mode.useCenter : true;
    const useEdge = mode?.useEdge !== undefined ? !!mode.useEdge : true;
    if (!useCenter && !useEdge) return { useCenter: true, useEdge: false };
    return { useCenter, useEdge };
  }

  function loadDistanceMode() {
    try {
      const raw = localStorage.getItem(DISTANCE_MODE_STORAGE_KEY);
      if (!raw) return normalizeDistanceMode(null);
      const parsed = JSON.parse(raw);
      return normalizeDistanceMode(parsed);
    } catch {
      return normalizeDistanceMode(null);
    }
  }

  function saveDistanceMode(mode) {
    try {
      localStorage.setItem(DISTANCE_MODE_STORAGE_KEY, JSON.stringify(normalizeDistanceMode(mode)));
    } catch {
      // ignore
    }
  }

  function applyDistanceMode(mode) {
    distanceMode = normalizeDistanceMode(mode);
    THEORY_PARAMS.useCenter = distanceMode.useCenter;
    THEORY_PARAMS.useEdge = distanceMode.useEdge;
    return distanceMode;
  }

  function distanceModeLabel(mode) {
    const m = normalizeDistanceMode(mode);
    if (m.useCenter && m.useEdge) return "center+edge";
    if (m.useCenter) return "center";
    return "edge";
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

  function normalizeIslandSettings(input) {
    const initialCount = clampInt(
      parseIntOr(input?.initialCount, ISLAND_DEFAULTS.initialCount),
      ISLAND_LIMITS.initialMin,
      ISLAND_LIMITS.initialMax
    );
    let maxCount = clampInt(
      parseIntOr(input?.maxCount, ISLAND_DEFAULTS.maxCount),
      ISLAND_LIMITS.maxMin,
      ISLAND_LIMITS.maxMax
    );
    if (maxCount < initialCount) maxCount = initialCount;
    const spawnEvery = clampInt(
      parseIntOr(input?.spawnEvery, ISLAND_DEFAULTS.spawnEvery),
      ISLAND_LIMITS.spawnMin,
      ISLAND_LIMITS.spawnMax
    );
    const minAgeEvals = clampInt(
      parseIntOr(input?.minAgeEvals, ISLAND_DEFAULTS.minAgeEvals),
      ISLAND_LIMITS.minAgeMin,
      ISLAND_LIMITS.minAgeMax
    );
    return { initialCount, maxCount, spawnEvery, minAgeEvals };
  }

  function syncIslandUiFromSettings(settings) {
    const next = normalizeIslandSettings(settings);
    $("islandInitialCount").value = String(next.initialCount);
    $("islandMaxCount").value = String(next.maxCount);
    $("islandSpawnEvery").value = String(next.spawnEvery);
    $("islandMinAgeEvals").value = String(next.minAgeEvals);
  }

  function readIslandUiParams() {
    return {
      initialCount: parseIntOr($("islandInitialCount").value, ISLAND_DEFAULTS.initialCount),
      maxCount: parseIntOr($("islandMaxCount").value, ISLAND_DEFAULTS.maxCount),
      spawnEvery: parseIntOr($("islandSpawnEvery").value, ISLAND_DEFAULTS.spawnEvery),
      minAgeEvals: parseIntOr($("islandMinAgeEvals").value, ISLAND_DEFAULTS.minAgeEvals),
    };
  }

  function applyIslandParamsFromUi() {
    const wasRunning = state.running;
    islandSettings = normalizeIslandSettings(readIslandUiParams());
    syncIslandUiFromSettings(islandSettings);
    clearAll();
    if (wasRunning) setRunning(true);
  }

  function applyGaParamsFromUi() {
    gaLiveParams = readGaUiParams();
    syncGaUiFromParams(gaLiveParams);
    if (state.islands.length) {
      for (const island of state.islands) {
        if (island?.ga && typeof island.ga.setParams === "function") island.ga.setParams(gaLiveParams);
      }
      lastGaStats = aggregateIslandStats();
    }
    updateStatus();
  }

  function nowTimeString() {
    const d = new Date();
    return d.toLocaleTimeString();
  }

  function resetSearch() {
    state.islands = [];
    state.nextSpawnAt = islandSettings.spawnEvery;
    islandsMode = null;
    nextIslandId = 1;
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

  function createIsland(sizesMode) {
    const mode = normalizeSizesMode(sizesMode);
    const includeSizes = mode !== "fixed";
    const sizeMin = mode === "integer" ? INTEGER_SIZE_RANGE.min : SEARCH_PARAMS.sizeMin;
    const sizeMax = mode === "integer" ? INTEGER_SIZE_RANGE.max : SEARCH_PARAMS.sizeMax;
    const keys = getDefaultKeys();
    const ga = ns.geneticSearch.createSequencePairGA({
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
    const createdAt = state.generatedTotal;
    return {
      id: nextIslandId++,
      ga,
      sizesMode: mode,
      bestEntry: null,
      generatedTotal: 0,
      createdAt,
      lastImprovementAt: createdAt,
    };
  }

  function ensureIslands(sizesMode) {
    const mode = normalizeSizesMode(sizesMode);
    if (state.islands.length && islandsMode === mode) return;
    islandsMode = mode;
    state.islands = [];
    nextIslandId = 1;
    state.nextSpawnAt = state.generatedTotal + islandSettings.spawnEvery;
    for (let i = 0; i < islandSettings.initialCount; i++) {
      state.islands.push(createIsland(mode));
    }
    lastGaStats = null;
  }

  function spawnIslandIfNeeded(sizesMode) {
    if (islandSettings.maxCount <= 1) return;
    if (!Number.isFinite(islandSettings.spawnEvery) || islandSettings.spawnEvery <= 0) return;
    if (!state.islands.length) return;
    while (state.generatedTotal >= state.nextSpawnAt) {
      state.islands.push(createIsland(sizesMode));
      state.nextSpawnAt += islandSettings.spawnEvery;
    }
  }

  function islandBestScore(island) {
    const score = island?.bestEntry?.predictedWpm;
    return Number.isFinite(score) ? score : -Infinity;
  }

  function pruneIslandsIfNeeded() {
    if (state.islands.length <= islandSettings.maxCount) return;
    const minAge = Math.max(0, Number(islandSettings.minAgeEvals) || 0);
    while (state.islands.length > islandSettings.maxCount) {
      const now = state.generatedTotal;
      let candidates = state.islands.filter((island) => now - island.createdAt >= minAge);
      if (!candidates.length) candidates = state.islands;

      let worst = candidates[0];
      let worstScore = islandBestScore(worst);
      for (let i = 1; i < candidates.length; i++) {
        const cand = candidates[i];
        const candScore = islandBestScore(cand);
        if (candScore < worstScore || (candScore === worstScore && cand.createdAt < worst.createdAt)) {
          worst = cand;
          worstScore = candScore;
        }
      }
      state.islands = state.islands.filter((island) => island !== worst);
    }
    recomputeBestWpm();
  }

  function aggregateIslandStats() {
    const stats = { evaluations: 0, populationSize: 0, cacheSize: 0, islands: state.islands.length };
    for (const island of state.islands) {
      const islandStats = island?.ga?.getStats ? island.ga.getStats() : null;
      if (!islandStats) continue;
      stats.evaluations += islandStats.evaluations || 0;
      stats.populationSize += islandStats.populationSize || 0;
      stats.cacheSize += islandStats.cacheSize || 0;
    }
    return stats;
  }

  function recomputeBestWpm() {
    let best = -Infinity;
    for (const island of state.islands) {
      const score = island?.bestEntry?.predictedWpm;
      if (Number.isFinite(score) && score > best) best = score;
    }
    state.bestWpm = best;
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

      const scored = scoreLayout(layout);
      if (!scored || !Number.isFinite(scored.predictedWpm)) {
        out.push(null);
        continue;
      }

      out.push({ predictedWpm: scored.predictedWpm, avgMsPerChar: scored.avgMsPerChar, layout, genome });
    }
    return out;
  }


  function makeDefaultKeys() {
    // a..z, space, backspace, enter (extensible later)
    const keys = [];
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      keys.push({ id: ch, label: ch.toUpperCase(), type: "char" });
    }
    keys.push({ id: "space", label: "Space", type: "space" });
    keys.push({ id: "backspace", label: "⌫", type: "backspace" });
    keys.push({ id: "enter", label: "Enter", type: "enter" });
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

  function augmentCorpusWithEnter(corpus) {
    if (!corpus || corpus._augmented) return corpus;
    const alphabet = String(corpus.alphabet ?? "");
    if (!alphabet || alphabet.includes("\n")) return corpus;
    if (!Array.isArray(corpus.countsFlat)) return corpus;

    const spaceIdx = alphabet.indexOf(" ");
    if (spaceIdx < 0) return corpus;

    const K = alphabet.length;
    const countsFlat = corpus.countsFlat;
    if (K * K !== countsFlat.length) return corpus;

    const newAlphabet = `${alphabet}\n`;
    const newK = K + 1;
    const newCounts = new Array(newK * newK).fill(0);

    for (let a = 0; a < K; a++) {
      for (let b = 0; b < K; b++) {
        newCounts[a * newK + b] = countsFlat[a * K + b] || 0;
      }
    }

    const scale = 0.2;
    let addedTotal = 0;
    for (let a = 0; a < K; a++) {
      const c = countsFlat[a * K + spaceIdx] || 0;
      if (c <= 0) continue;
      const add = c * scale;
      newCounts[a * newK + (newK - 1)] += add;
      addedTotal += add;
    }
    for (let b = 0; b < K; b++) {
      const c = countsFlat[spaceIdx * K + b] || 0;
      if (c <= 0) continue;
      const add = c * scale;
      newCounts[(newK - 1) * newK + b] += add;
      addedTotal += add;
    }

    return {
      ...corpus,
      alphabet: newAlphabet,
      countsFlat: newCounts,
      totalBigrams: Number(corpus.totalBigrams ?? 0) + addedTotal,
      _augmented: true,
    };
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
    return augmentCorpusWithEnter(corpus);
  }

  function scoreLayout(layout) {
    // Fail fast: no silent fallback. Generator requires Gutenberg bigrams.
    const corpus = getCorpusCached();
    const base = ns.theory.distanceLinear.estimateLayoutFromBigramCountsFitts(layout, corpus, THEORY_PARAMS);

    let minDim = Infinity;
    for (const k of layout.keys) minDim = Math.min(minDim, Math.min(k.w, k.h));
    if (!Number.isFinite(minDim)) minDim = 0;

    let penaltyMs = 0;
    if (minDim > 0 && minDim < KEY_SIZE_PENALTY.refDim) {
      const inv = 1 / Math.max(minDim, KEY_SIZE_PENALTY.eps);
      const invRef = 1 / KEY_SIZE_PENALTY.refDim;
      penaltyMs = KEY_SIZE_PENALTY.strengthMs * Math.max(0, inv - invRef);
    }

    const avgMsPerChar = (base.avgMsPerChar ?? 0) + penaltyMs;
    const predictedWpm = ns.metrics.computeWpm(1, avgMsPerChar);
    return { predictedWpm, avgMsPerChar, minKeyDim: minDim, sizePenaltyMs: penaltyMs };
  }

  function rebuildLeaderboardFromIslands() {
    const items = state.islands.map((island) => island.bestEntry).filter(Boolean);
    items.sort((a, b) => b.predictedWpm - a.predictedWpm);
    const selected = items.slice(0, 5);

    const prev = state.top5;
    const changed =
      selected.length !== prev.length ||
      selected.some((it, idx) => {
        const prevIt = prev[idx];
        return (
          !prevIt ||
          prevIt.signature !== it.signature ||
          prevIt.sizesMode !== it.sizesMode ||
          prevIt.islandId !== it.islandId
        );
      });
    if (changed) state.top5 = selected;
    return changed;
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

      const cells = [
        idx + 1,
        it.islandId ?? "—",
        ns.metrics.roundTo(it.predictedWpm, 2),
        ns.metrics.roundTo(it.avgMsPerChar, 1),
        it.sizesMode,
        it.generatedAt,
      ];
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

    const scoring = `Scoring: Gutenberg bigrams (pg${corpus.bookId}) + Fitts (dist=${distanceModeLabel(distanceMode)})`;
    const search = "Search: genetic algorithm (sequence-pair)";
    const islandInfo = `Islands: ${state.islands.length}/${islandSettings.maxCount} (init ${islandSettings.initialCount}) • Spawn: ${islandSettings.spawnEvery.toLocaleString()} • MinAge: ${islandSettings.minAgeEvals.toLocaleString()} • Batch/island: ${SEARCH_PARAMS.batchSize}`;
    const gaExtra = lastGaStats
      ? ` • ${islandInfo} • GA pop: ${lastGaStats.populationSize.toLocaleString()} • Cache: ${lastGaStats.cacheSize.toLocaleString()} • mut=${ns.metrics.roundTo(
          gaLiveParams.mutationRate,
          2
        )} imm=${ns.metrics.roundTo(gaLiveParams.immigrantRate, 2)} k=${gaLiveParams.tournamentK} elite=${gaLiveParams.eliteCount} rtr=${
          gaLiveParams.rtrWindow
        }`
      : ` • ${islandInfo}`;

    setText(
      $("statusDetails"),
      `${scoring} • ${search} • Generated: ${state.generatedTotal.toLocaleString()} • Best WPM: ${
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
      ensureIslands(sizesMode);
      const target = getCanonicalTarget();
      const batchSize = SEARCH_PARAMS.batchSize;
      const islands = state.islands;
      if (!islands.length) {
        updateStatus();
        return;
      }

      for (let i = 0; i < islands.length; i++) {
        const count = batchSize;
        const island = islands[i];
        const { genomes } = island.ga.generateGenomes(count);
        const evals = evaluateGenomesLocal(genomes, sizesMode, target);
        const { evaluations } = island.ga.ingestEvaluations(evals);

        for (const ev of evaluations) {
          const predictedWpm = ev.predictedWpm;
          state.generatedTotal += 1;
          island.generatedTotal += 1;

          if (predictedWpm > state.bestWpm) state.bestWpm = predictedWpm;
          if (!island.bestEntry || predictedWpm > island.bestEntry.predictedWpm) {
            island.bestEntry = {
              predictedWpm,
              avgMsPerChar: ev.avgMsPerChar,
              sizesMode,
              generatedAt: nowTimeString(),
              layout: ev.layout,
              signature: signatureOfLayout(ev.layout),
              islandId: island.id,
            };
            island.lastImprovementAt = state.generatedTotal;
          }
        }
      }

      spawnIslandIfNeeded(sizesMode);
      pruneIslandsIfNeeded();
      lastGaStats = aggregateIslandStats();

      const leaderboardChanged = rebuildLeaderboardFromIslands();
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
    // Distance metric controls (persisted across pages via localStorage).
    applyDistanceMode(loadDistanceMode());
    $("distUseCenter").checked = distanceMode.useCenter;
    $("distUseEdge").checked = distanceMode.useEdge;

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

    const onDistanceControl = (e) => {
      const wasRunning = state.running;
      const centerEl = $("distUseCenter");
      const edgeEl = $("distUseEdge");

      // Enforce: at least one must be enabled.
      if (!centerEl.checked && !edgeEl.checked) {
        if (e?.target === centerEl) centerEl.checked = true;
        else edgeEl.checked = true;
      }

      applyDistanceMode({ useCenter: centerEl.checked, useEdge: edgeEl.checked });
      saveDistanceMode(distanceMode);

      // Scoring changed; restart to avoid mixing cached island evaluations.
      clearAll();
      if (wasRunning) setRunning(true);
    };
    $("distUseCenter").addEventListener("change", onDistanceControl);
    $("distUseEdge").addEventListener("change", onDistanceControl);

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

    // Island controls
    syncIslandUiFromSettings(islandSettings);
    const onIslandControl = () => applyIslandParamsFromUi();
    $("islandInitialCount").addEventListener("change", onIslandControl);
    $("islandMaxCount").addEventListener("change", onIslandControl);
    $("islandSpawnEvery").addEventListener("change", onIslandControl);
    $("islandMinAgeEvals").addEventListener("change", onIslandControl);

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

