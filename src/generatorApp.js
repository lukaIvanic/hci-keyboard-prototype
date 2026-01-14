(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const DISTANCE_MODE_STORAGE_KEY = "KbdStudy.distanceMode.v1";
  const WORKER_SCRIPT = "src/gaWorker.js";
  const WORKER_COUNT_STORAGE_KEY = "KbdStudy.workerCount.v1";
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

  const LEADERBOARD = {
    poolSize: 80,
    // Prefer distinct layouts, but relax if we can't fill 5.
    minDistThresholds: [0.45, 0.35, 0.25, 0.15, 0],
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
  let workerPool = null;
  let workerCount = 0;
  let batchInFlight = false;
  let workerEvalId = 1;

  const cached = {
    keys: null,
    target: null,
    corpus: null,
  };

  let ga = null;
  let gaSizesMode = null; // "fixed" | "random"
  let lastGaStats = null;

  const state = {
    running: false,
    generatedTotal: 0,
    bestWpm: -Infinity,
    pool: [], // larger candidate pool; top5 is derived from this with diversity constraints
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

  function getAutoWorkerCount() {
    const cores = Number(navigator.hardwareConcurrency || 0);
    if (!Number.isFinite(cores) || cores <= 1) return 1;
    return Math.max(1, cores - 1);
  }

  function loadWorkerCountSetting() {
    try {
      const raw = localStorage.getItem(WORKER_COUNT_STORAGE_KEY);
      if (!raw) return "auto";
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : "auto";
    } catch {
      return "auto";
    }
  }

  function saveWorkerCountSetting(value) {
    try {
      localStorage.setItem(WORKER_COUNT_STORAGE_KEY, JSON.stringify(String(value)));
    } catch {
      // ignore
    }
  }

  function resolveWorkerCount(value) {
    if (value === "auto") return getAutoWorkerCount();
    const n = Number.parseInt(String(value), 10);
    return Number.isInteger(n) && n > 0 ? n : getAutoWorkerCount();
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
    if (ga && typeof ga.setParams === "function") ga.setParams(gaLiveParams);
    updateStatus();
  }

  function nowTimeString() {
    const d = new Date();
    return d.toLocaleTimeString();
  }

  function resetSearch() {
    ga = null;
    gaSizesMode = null;
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

  function ensureGa(sizesMode) {
    const mode = sizesMode === "integer" ? "integer" : sizesMode === "random" ? "random" : "fixed";
    if (ga && gaSizesMode === mode) return;
    const includeSizes = mode !== "fixed";
    const sizeMin = mode === "integer" ? INTEGER_SIZE_RANGE.min : SEARCH_PARAMS.sizeMin;
    const sizeMax = mode === "integer" ? INTEGER_SIZE_RANGE.max : SEARCH_PARAMS.sizeMax;
    const keys = getDefaultKeys();
    ga = ns.geneticSearch.createSequencePairGA({
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
      maxCacheSize: SEARCH_PARAMS.maxCacheSize,
      replacementStrategy: gaLiveParams.replacementStrategy,
      rtrWindow: gaLiveParams.rtrWindow,
    });
    gaSizesMode = mode;
    lastGaStats = null;
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

  function terminateWorkerPool() {
    if (!workerPool) return;
    for (const w of workerPool.workers) w.terminate();
    workerPool = null;
    workerCount = 0;
  }

  function createWorkerPool(count, keys, target) {
    const workers = [];
    for (let i = 0; i < count; i++) {
      try {
        const w = new Worker(WORKER_SCRIPT);
        w.postMessage({ type: "init", keys, target, sizePenalty: KEY_SIZE_PENALTY });
        workers.push(w);
      } catch (err) {
        console.warn("Worker init failed; falling back to local eval.", err);
        for (const wk of workers) wk.terminate();
        return null;
      }
    }

    return {
      workers,
      count: workers.length,
      evaluate(genomes, sizesMode, theoryParams) {
        if (!workers.length) return Promise.resolve(evaluateGenomesLocal(genomes, sizesMode, target));

        const chunks = [];
        const chunkSize = Math.ceil(genomes.length / workers.length);
        for (let i = 0; i < workers.length; i++) {
          const start = i * chunkSize;
          const end = Math.min(genomes.length, start + chunkSize);
          chunks.push(genomes.slice(start, end));
        }

        const tasks = workers.map((w, idx) => {
          const chunk = chunks[idx] || [];
          if (!chunk.length) return Promise.resolve([]);
          const id = workerEvalId++;
          return new Promise((resolve) => {
            const onMessage = (evt) => {
              const payload = evt?.data;
              if (!payload || payload.id !== id) return;
              w.removeEventListener("message", onMessage);
              resolve(Array.isArray(payload.evaluations) ? payload.evaluations : []);
            };
            w.addEventListener("message", onMessage);
            w.postMessage({ type: "evaluate", id, genomes: chunk, sizesMode, theoryParams });
          });
        });

        return Promise.all(tasks).then((parts) => parts.flat());
      },
    };
  }

  function makeDefaultKeys() {
    // a..z, space, backspace (extensible later)
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

  function layoutDistance(a, b) {
    // Average distance between corresponding keys (unit-space), using the same distance metric toggles as scoring.
    // Layouts are normalized to canonical bounds, so this is comparable across candidates.
    let sum = 0;
    let count = 0;
    for (const k of a.keys) {
      const ka = ns.layouts.getKey(a, k.id);
      const kb = ns.layouts.getKey(b, k.id);
      if (!ka || !kb) continue;

      let d = null;
      if (distanceMode.useCenter && distanceMode.useEdge) d = ns.layouts.mixedDistance(ka, kb);
      else if (distanceMode.useCenter) d = ns.layouts.centerDistance(ka, kb);
      else if (distanceMode.useEdge) d = ns.layouts.rectDistance(ka, kb);
      if (d == null) continue;

      sum += d;
      count += 1;
    }
    return count > 0 ? sum / count : Infinity;
  }

  function insertTop5(entry) {
    const items = state.pool.slice();
    items.push(entry);
    items.sort((a, b) => b.predictedWpm - a.predictedWpm);

    // Maintain a larger pool of high-scoring candidates, de-duplicated by layout signature.
    const pool = [];
    const seen = new Set();
    for (const it of items) {
      const sig = `${it.sizesMode}|${it.signature}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      pool.push(it);
      if (pool.length >= LEADERBOARD.poolSize) break;
    }
    state.pool = pool;

    // Pick a diverse top-5 from the pool (greedy by predicted WPM, with relaxed thresholds fallback).
    const selected = [];
    const selectedSigs = new Set();
    for (const threshold of LEADERBOARD.minDistThresholds) {
      for (const it of state.pool) {
        if (selected.length >= 5) break;
        const sig = `${it.sizesMode}|${it.signature}`;
        if (selectedSigs.has(sig)) continue;
        let ok = true;
        for (const chosen of selected) {
          if (layoutDistance(it.layout, chosen.layout) < threshold) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        selectedSigs.add(sig);
        selected.push(it);
      }
      if (selected.length >= 5) break;
    }

    const prev = state.top5;
    const changed =
      selected.length !== prev.length ||
      selected.some((it, idx) => !prev[idx] || prev[idx].signature !== it.signature || prev[idx].sizesMode !== it.sizesMode);
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
    const gaExtra = lastGaStats
      ? ` • GA pop: ${lastGaStats.populationSize.toLocaleString()} • Cache: ${lastGaStats.cacheSize.toLocaleString()} • mut=${ns.metrics.roundTo(
          gaLiveParams.mutationRate,
          2
        )} imm=${ns.metrics.roundTo(gaLiveParams.immigrantRate, 2)} k=${gaLiveParams.tournamentK} elite=${gaLiveParams.eliteCount} rtr=${
          gaLiveParams.rtrWindow
        } • Workers: ${workerCount}`
      : "";

    setText(
      $("statusDetails"),
      `${scoring} • ${search} • Generated: ${state.generatedTotal.toLocaleString()} • Best WPM: ${
        Number.isFinite(state.bestWpm) ? ns.metrics.roundTo(state.bestWpm, 2) : "—"
      } • Top5 size: ${state.top5.length}${gaExtra}`
    );
  }

  function renderCorpusPanel() {
    const corpus = requireGutenbergCorpus();
    const meta = `Loaded: Project Gutenberg pg${corpus.bookId} • Alphabet: "${corpus.alphabet}" • Total bigrams: ${corpus.totalBigrams.toLocaleString()} • Generated: ${corpus.generatedAt ?? "—"}`;
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
      const bigram = `${it.a === " " ? "_" : it.a}${it.b === " " ? "_" : it.b}`;
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
    state.pool = [];
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

      const { genomes } = ga.generateGenomes(batchSize);
      const evals = workerPool
        ? await workerPool.evaluate(genomes, sizesMode, THEORY_PARAMS)
        : evaluateGenomesLocal(genomes, sizesMode, target);

      const { evaluations, stats } = ga.ingestEvaluations(evals);
      lastGaStats = stats;

      let leaderboardChanged = false;
      for (const ev of evaluations) {
        const predictedWpm = ev.predictedWpm;
        const avgMsPerChar = ev.avgMsPerChar;
        const layout = ev.layout;

        state.generatedTotal += 1;
        if (predictedWpm > state.bestWpm) state.bestWpm = predictedWpm;

        // Only consider entries that can affect the candidate pool.
        const worstPool = state.pool.length < LEADERBOARD.poolSize ? -Infinity : state.pool[state.pool.length - 1].predictedWpm;
        if (predictedWpm <= worstPool) continue;

        const entry = {
          predictedWpm,
          avgMsPerChar,
          sizesMode,
          generatedAt: nowTimeString(),
          layout,
          signature: signatureOfLayout(layout),
        };

        if (insertTop5(entry)) leaderboardChanged = true;
      }

      if (leaderboardChanged) {
        renderLeaderboard();
        // Auto-preview best entry if none yet, or keep current preview selection.
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

    // Worker controls (persisted).
    const workerSelect = $("workerCountSelect");
    const savedWorker = loadWorkerCountSetting();
    if ([...workerSelect.options].some((opt) => opt.value === savedWorker)) {
      workerSelect.value = savedWorker;
    } else {
      workerSelect.value = "auto";
    }

    const applyWorkerSetting = () => {
      const wasRunning = state.running;
      const setting = workerSelect.value;
      saveWorkerCountSetting(setting);
      terminateWorkerPool();
      workerCount = resolveWorkerCount(setting);
      workerPool = createWorkerPool(workerCount, getDefaultKeys(), getCanonicalTarget());
      workerCount = workerPool ? workerPool.count : 0;
      if (!workerPool) workerSelect.disabled = true;
      clearAll();
      if (wasRunning && workerPool) setRunning(true);
    };
    applyWorkerSetting();

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
      $("workerCountSelect").disabled = true;
      updateStatus();
    }

    $("startStopBtn").addEventListener("click", () => setRunning(!state.running));
    $("resetBtn").addEventListener("click", clearAll);
    $("sizeModeSelect").addEventListener("change", () => {
      // No auto-restart; the user can stop/start to compare.
      clearAll();
    });
    $("workerCountSelect").addEventListener("change", applyWorkerSetting);

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

      // Scoring changed; restart to avoid mixing caches/pool entries.
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

