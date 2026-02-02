(function () {
  "use strict";

  const STORAGE_PREFIX = "KbdStudy.analysisPage.";
  const URL_STORAGE_KEY = `${STORAGE_PREFIX}sheetUrl.v1`;
  const ANALYSIS_STORAGE_KEY = `${STORAGE_PREFIX}analysis.v1`;
  const THRESHOLD_STORAGE_KEY = `${STORAGE_PREFIX}thresholds.v1`;
  const DEFAULT_DEMO_CSV_URL = "analysis/fake_dataset_20_participants.csv";

  const METRICS = [
    { key: "wpm", label: "WPM", decimals: 2 },
    { key: "errorRate", label: "Error rate", decimals: 3 },
    { key: "editDistance", label: "Edit distance", decimals: 2 },
    { key: "elapsedSeconds", label: "Elapsed (s)", decimals: 2 },
    { key: "backspaceCount", label: "Backspace count", decimals: 2 },
    { key: "keypressCount", label: "Keypress count", decimals: 2 },
    { key: "kspc", label: "KSPC", decimals: 3 },
    { key: "efficiency", label: "Efficiency", decimals: 2 },
  ];

  const REQUIRED_HEADERS = [
    "layoutId",
    "participantId",
    "wpm",
    "editDistance",
    "charCount",
    "elapsedMs",
  ];

  const CHART_COLORS = [
    "#6aa6ff",
    "#9f7aea",
    "#38b2ac",
    "#f6ad55",
    "#f56565",
    "#48bb78",
  ];

  const CI_Z = 1.96;

  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el;
  }

  function safeParse(json, fallback) {
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  }

  function loadAnalysisState() {
    const raw = localStorage.getItem(ANALYSIS_STORAGE_KEY);
    return raw ? safeParse(raw, null) : null;
  }

  function saveAnalysisState(state) {
    localStorage.setItem(ANALYSIS_STORAGE_KEY, JSON.stringify(state));
  }

  function loadThresholds() {
    const raw = localStorage.getItem(THRESHOLD_STORAGE_KEY);
    return raw
      ? safeParse(raw, { minTrials: 5, minElapsedMs: 2000, maxErrorRate: 0.4, excludePractice: true })
      : { minTrials: 5, minElapsedMs: 2000, maxErrorRate: 0.4, excludePractice: true };
  }

  function saveThresholds(state) {
    localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(state));
  }

  function loadCsvUrl() {
    return String(localStorage.getItem(URL_STORAGE_KEY) || "");
  }

  function saveCsvUrl(value) {
    localStorage.setItem(URL_STORAGE_KEY, String(value || ""));
  }

  function normalizeCsvUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.includes("output=csv")) return raw;
    const idMatch = raw.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (idMatch) {
      const id = idMatch[1];
      const gidMatch = raw.match(/gid=([0-9]+)/);
      const gid = gidMatch ? gidMatch[1] : "0";
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    }
    return raw;
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) return { headers: [], rows: [] };
    const headers = lines[0].split(",").map((h) => h.trim());
    const rows = lines.slice(1).map((line) => {
      const values = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === "," && !inQuotes) {
          values.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
      values.push(current);
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = values[idx] ?? "";
      });
      return row;
    });
    return { headers, rows };
  }

  function validateHeaders(headers) {
    const normalized = headers.map((h) => h.trim());
    return REQUIRED_HEADERS.filter((h) => !normalized.includes(h));
  }

  function toNumber(value, fallback = null) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function variance(arr) {
    if (arr.length < 2) return null;
    const m = mean(arr);
    if (m == null) return null;
    return arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1);
  }

  function stdev(arr) {
    const v = variance(arr);
    return v == null ? null : Math.sqrt(v);
  }

  function meanAndCi(arr) {
    const n = arr.length;
    if (!n) return { mean: null, ci: null, n: 0 };
    const m = mean(arr);
    const sd = stdev(arr);
    if (sd == null || n < 2) return { mean: m, ci: null, n };
    const se = sd / Math.sqrt(n);
    return { mean: m, ci: CI_Z * se, n };
  }

  function pearsonCorrelation(xs, ys) {
    const pairs = xs
      .map((x, i) => ({ x, y: ys[i] }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pairs.length < 2) return null;
    const xMean = mean(pairs.map((p) => p.x));
    const yMean = mean(pairs.map((p) => p.y));
    let num = 0;
    let denX = 0;
    let denY = 0;
    pairs.forEach((p) => {
      const dx = p.x - xMean;
      const dy = p.y - yMean;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    });
    if (denX <= 0 || denY <= 0) return null;
    return num / Math.sqrt(denX * denY);
  }

  function linearRegressionSlope(xs, ys) {
    const pairs = xs
      .map((x, i) => ({ x, y: ys[i] }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pairs.length < 2) return null;
    const xMean = mean(pairs.map((p) => p.x));
    const yMean = mean(pairs.map((p) => p.y));
    let num = 0;
    let den = 0;
    pairs.forEach((p) => {
      const dx = p.x - xMean;
      num += dx * (p.y - yMean);
      den += dx * dx;
    });
    if (den <= 0) return null;
    return num / den;
  }

  function formatNumber(value, decimals) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(decimals);
  }

  function computeErrorRate(editDistance, charCount) {
    if (!Number.isFinite(editDistance) || !Number.isFinite(charCount) || charCount <= 0) return null;
    return editDistance / charCount;
  }

  function createLayoutColorMap(layouts) {
    const map = new Map();
    layouts.forEach((layoutId, idx) => {
      map.set(layoutId, CHART_COLORS[idx % CHART_COLORS.length]);
    });
    return map;
  }

  function computeSkewKurtosis(values) {
    if (values.length < 3) return { skew: null, kurtosis: null };
    const m = mean(values);
    const m2 = mean(values.map((v) => (v - m) ** 2));
    const m3 = mean(values.map((v) => (v - m) ** 3));
    const m4 = mean(values.map((v) => (v - m) ** 4));
    if (!m2 || m2 === 0) return { skew: 0, kurtosis: 0 };
    const skew = m3 / Math.pow(m2, 1.5);
    const kurtosis = m4 / (m2 * m2) - 3;
    return { skew, kurtosis };
  }

  function mergeWarnings(...lists) {
    const out = new Set();
    lists.forEach((list) => {
      if (!Array.isArray(list)) return;
      list.forEach((item) => {
        const msg = String(item || "").trim();
        if (msg) out.add(msg);
      });
    });
    return Array.from(out);
  }

  function holmAdjust(pairs) {
    if (!pairs.length) return [];
    const sorted = pairs
      .map((row, idx) => ({ ...row, _idx: idx }))
      .sort((a, b) => a.p - b.p);
    const m = sorted.length;
    let runningMax = 0;
    sorted.forEach((row, i) => {
      const rawAdj = Math.min(1, (m - i) * row.p);
      // Holm-adjusted p-values must be non-decreasing with rank.
      runningMax = Math.max(runningMax, rawAdj);
      row.pAdj = runningMax;
    });
    sorted.sort((a, b) => a._idx - b._idx);
    return sorted.map(({ _idx, ...rest }) => rest);
  }

  function getCompleteCaseMatrix(metricKey, participantMeans, layouts) {
    const participants = [];
    const matrix = [];
    participantMeans.forEach((layoutMap, participantId) => {
      const row = [];
      let ok = true;
      layouts.forEach((layoutId) => {
        const metrics = layoutMap.get(layoutId);
        const value = metrics ? metrics[metricKey] : null;
        if (!Number.isFinite(value)) ok = false;
        row.push(value);
      });
      if (ok) {
        participants.push(participantId);
        matrix.push(row);
      }
    });
    return { participants, matrix };
  }

  function rmAnova(matrix) {
    if (!window.jStat) return null;
    const n = matrix.length;
    if (!n) return null;
    const k = matrix[0].length;
    if (k < 2) return null;

    const flat = matrix.flat();
    const grand = mean(flat);
    const meanByCondition = new Array(k).fill(0);
    const meanBySubject = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      const row = matrix[i];
      meanBySubject[i] = mean(row);
      for (let j = 0; j < k; j++) meanByCondition[j] += row[j];
    }
    for (let j = 0; j < k; j++) meanByCondition[j] /= n;

    let ssTotal = 0;
    for (const v of flat) ssTotal += (v - grand) ** 2;

    let ssConditions = 0;
    for (let j = 0; j < k; j++) ssConditions += (meanByCondition[j] - grand) ** 2;
    ssConditions *= n;

    let ssSubjects = 0;
    for (let i = 0; i < n; i++) ssSubjects += (meanBySubject[i] - grand) ** 2;
    ssSubjects *= k;

    const ssError = ssTotal - ssConditions - ssSubjects;
    const dfConditions = k - 1;
    const dfError = (k - 1) * (n - 1);
    if (dfError <= 0) return null;

    const msConditions = ssConditions / dfConditions;
    const msError = ssError / dfError;
    const F = msError > 0 ? msConditions / msError : null;
    const p = F != null ? 1 - jStat.centralF.cdf(F, dfConditions, dfError) : null;
    const eta = ssConditions + ssError > 0 ? ssConditions / (ssConditions + ssError) : null;

    return { F, p, df1: dfConditions, df2: dfError, eta, n, k };
  }

  function oneWayAnova(groups) {
    if (!window.jStat) return null;
    const cleanGroups = groups.filter((g) => Array.isArray(g.values) && g.values.length > 0);
    if (cleanGroups.length < 2) return null;
    const allValues = cleanGroups.flatMap((g) => g.values);
    if (allValues.length < 3) return null;
    const grand = mean(allValues);
    let ssBetween = 0;
    let ssWithin = 0;
    cleanGroups.forEach((g) => {
      const m = mean(g.values);
      ssBetween += g.values.length * (m - grand) ** 2;
      g.values.forEach((v) => {
        ssWithin += (v - m) ** 2;
      });
    });
    const df1 = cleanGroups.length - 1;
    const df2 = allValues.length - cleanGroups.length;
    if (df2 <= 0) return null;
    const msBetween = ssBetween / df1;
    const msWithin = ssWithin / df2;
    const F = msWithin > 0 ? msBetween / msWithin : null;
    const p = F != null ? 1 - jStat.centralF.cdf(F, df1, df2) : null;
    const eta = ssBetween + ssWithin > 0 ? ssBetween / (ssBetween + ssWithin) : null;
    return { F, p, df1, df2, eta, n: allValues.length, k: cleanGroups.length };
  }

  function rankWithTies(values) {
    const sorted = values
      .map((v, idx) => ({ v, idx }))
      .sort((a, b) => a.v - b.v);
    const ranks = new Array(values.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
      const avgRank = (i + 1 + j) / 2;
      for (let k = i; k < j; k++) ranks[sorted[k].idx] = avgRank;
      i = j;
    }
    return ranks;
  }

  function friedmanTest(matrix) {
    if (!window.jStat) return null;
    const n = matrix.length;
    if (!n) return null;
    const k = matrix[0].length;
    if (k < 2) return null;

    const rankSums = new Array(k).fill(0);
    matrix.forEach((row) => {
      const ranks = rankWithTies(row);
      for (let j = 0; j < k; j++) rankSums[j] += ranks[j];
    });

    let sumSquares = 0;
    for (let j = 0; j < k; j++) sumSquares += rankSums[j] ** 2;
    const q = (12 / (n * k * (k + 1))) * sumSquares - 3 * n * (k + 1);
    const df = k - 1;
    const p = 1 - jStat.chisquare.cdf(q, df);
    const w = q / (n * (k - 1));
    return { chi2: q, p, df, w, n, k };
  }

  function pairedTTests(matrix, layouts) {
    const n = matrix.length;
    const results = [];
    for (let i = 0; i < layouts.length; i++) {
      for (let j = i + 1; j < layouts.length; j++) {
        const diffs = [];
        for (let r = 0; r < n; r++) {
          const a = matrix[r][i];
          const b = matrix[r][j];
          if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(a - b);
        }
        const sd = stdev(diffs);
        const m = mean(diffs);
        const df = diffs.length - 1;
        const t = sd && diffs.length > 1 ? m / (sd / Math.sqrt(diffs.length)) : null;
        const p =
          t != null && df > 0 ? 2 * (1 - jStat.studentt.cdf(Math.abs(t), df)) : null;
        const dz = sd ? m / sd : null;
        results.push({
          pair: `${layouts[i]} vs ${layouts[j]}`,
          test: "paired t",
          n: diffs.length,
          t,
          p,
          effect: dz,
        });
      }
    }
    return holmAdjust(
      results
        .filter((r) => Number.isFinite(r.p))
        .map((r) => ({ ...r, p: r.p ?? 1 }))
    );
  }

  function wilcoxonSignedRank(diffs) {
    const cleaned = diffs.filter((d) => Number.isFinite(d) && d !== 0);
    const n = cleaned.length;
    if (!n) return null;
    const absValues = cleaned.map((d) => Math.abs(d));
    const ranks = rankWithTies(absValues);
    let wPos = 0;
    let wNeg = 0;
    cleaned.forEach((d, idx) => {
      if (d > 0) wPos += ranks[idx];
      else wNeg += ranks[idx];
    });
    const w = Math.min(wPos, wNeg);
    const meanW = (n * (n + 1)) / 4;
    const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
    const z = sdW > 0 ? (w - meanW) / sdW : null;
    const p = z != null ? 2 * (1 - jStat.normal.cdf(Math.abs(z), 0, 1)) : null;
    const r = z != null ? Math.abs(z) / Math.sqrt(n) : null;
    return { w, z, p, r, n };
  }

  function wilcoxonTests(matrix, layouts) {
    const n = matrix.length;
    const results = [];
    for (let i = 0; i < layouts.length; i++) {
      for (let j = i + 1; j < layouts.length; j++) {
        const diffs = [];
        for (let r = 0; r < n; r++) {
          const a = matrix[r][i];
          const b = matrix[r][j];
          if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(a - b);
        }
        const res = wilcoxonSignedRank(diffs);
        results.push({
          pair: `${layouts[i]} vs ${layouts[j]}`,
          test: "Wilcoxon",
          n: diffs.length,
          z: res ? res.z : null,
          p: res ? res.p : null,
          effect: res ? res.r : null,
        });
      }
    }
    return holmAdjust(
      results
        .filter((r) => Number.isFinite(r.p))
        .map((r) => ({ ...r, p: r.p ?? 1 }))
    );
  }

  function computeLayoutSummary(trials, layouts, thresholds, warnings) {
    const byLayout = new Map();
    layouts.forEach((layoutId) => {
      byLayout.set(layoutId, {
        layoutId,
        trials: 0,
        wpm: [],
        errorRate: [],
        editDistance: [],
        elapsedSeconds: [],
        backspaceCount: [],
        keypressCount: [],
        kspc: [],
        efficiency: [],
      });
    });

    trials.forEach((trial) => {
      const bucket = byLayout.get(trial.layoutId);
      if (!bucket) return;
      bucket.trials += 1;
      METRICS.forEach((metric) => {
        const value = trial.metrics[metric.key];
        if (Number.isFinite(value)) bucket[metric.key].push(value);
      });
    });

    const layoutRows = [];
    for (const bucket of byLayout.values()) {
      if (bucket.trials < thresholds.minTrials) {
        warnings.push(`Low trials for ${bucket.layoutId}: ${bucket.trials}`);
      }
      layoutRows.push({
        layoutId: bucket.layoutId,
        trials: bucket.trials,
        meanWpm: mean(bucket.wpm) ?? 0,
        meanErr: mean(bucket.errorRate) ?? 0,
        meanEd: mean(bucket.editDistance) ?? 0,
        meanElapsed: mean(bucket.elapsedSeconds) ?? 0,
        meanBackspace: mean(bucket.backspaceCount) ?? 0,
        meanKeypress: mean(bucket.keypressCount) ?? 0,
      });
    }
    return layoutRows;
  }

  function buildParticipantMaps(trials) {
    const participantMap = new Map();
    trials.forEach((trial) => {
      if (!participantMap.has(trial.participantId)) participantMap.set(trial.participantId, new Map());
      const layoutMap = participantMap.get(trial.participantId);
      if (!layoutMap.has(trial.layoutId)) {
        layoutMap.set(trial.layoutId, {
          wpm: [],
          errorRate: [],
          editDistance: [],
          elapsedSeconds: [],
          backspaceCount: [],
          keypressCount: [],
          kspc: [],
          efficiency: [],
        });
      }
      const metricBucket = layoutMap.get(trial.layoutId);
      METRICS.forEach((metric) => {
        const value = trial.metrics[metric.key];
        if (Number.isFinite(value)) metricBucket[metric.key].push(value);
      });
    });
    return participantMap;
  }

  function computeParticipantMeans(participantMap) {
    const out = new Map();
    participantMap.forEach((layoutMap, participantId) => {
      const nextLayoutMap = new Map();
      layoutMap.forEach((metrics, layoutId) => {
        const meanValues = {};
        METRICS.forEach((metric) => {
          meanValues[metric.key] = mean(metrics[metric.key]) ?? null;
        });
        nextLayoutMap.set(layoutId, meanValues);
      });
      out.set(participantId, nextLayoutMap);
    });
    return out;
  }

  function computeLayoutParticipantMeans(participantMeans, layouts) {
    const out = new Map();
    layouts.forEach((layoutId) => {
      const metrics = {};
      METRICS.forEach((metric) => {
        metrics[metric.key] = [];
      });
      participantMeans.forEach((layoutMap) => {
        const values = layoutMap.get(layoutId);
        if (!values) return;
        METRICS.forEach((metric) => {
          const value = values[metric.key];
          if (Number.isFinite(value)) metrics[metric.key].push(value);
        });
      });
      out.set(layoutId, metrics);
    });
    return out;
  }

  function computeLearningCurves(trials, layouts) {
    const layoutMap = new Map();
    layouts.forEach((layoutId) => layoutMap.set(layoutId, new Map()));
    trials.forEach((trial) => {
      const idx = Number.isFinite(trial.trialIndex) ? trial.trialIndex : null;
      if (!idx || idx <= 0) return;
      const perLayout = layoutMap.get(trial.layoutId);
      if (!perLayout) return;
      if (!perLayout.has(idx)) {
        const entry = {};
        METRICS.forEach((metric) => {
          entry[metric.key] = [];
        });
        perLayout.set(idx, entry);
      }
      const entry = perLayout.get(idx);
      METRICS.forEach((metric) => {
        const value = trial.metrics[metric.key];
        if (Number.isFinite(value)) entry[metric.key].push(value);
      });
    });
    return layoutMap;
  }

  function computeDataQuality(rawRows, analysisRows, thresholds, layouts) {
    const missing = {
      participantId: 0,
      layoutId: 0,
      wpm: 0,
      editDistance: 0,
      charCount: 0,
      elapsedMs: 0,
    };
    const duplicateKeys = new Set();
    let duplicateTrials = 0;

    rawRows.forEach((row) => {
      if (!row.participantId) missing.participantId += 1;
      if (!row.layoutId) missing.layoutId += 1;
      if (!Number.isFinite(toNumber(row.wpm, null))) missing.wpm += 1;
      if (!Number.isFinite(toNumber(row.editDistance, null))) missing.editDistance += 1;
      if (!Number.isFinite(toNumber(row.charCount, null))) missing.charCount += 1;
      if (!Number.isFinite(toNumber(row.elapsedMs, null))) missing.elapsedMs += 1;

      const key = `${row.sessionId ?? ""}|${row.trialId ?? ""}`;
      if (key !== "|") {
        if (duplicateKeys.has(key)) duplicateTrials += 1;
        else duplicateKeys.add(key);
      }
    });

    let shortTrials = 0;
    let highError = 0;
    analysisRows.forEach((row) => {
      const elapsedMs = toNumber(row.elapsedMs, null);
      if (elapsedMs != null && elapsedMs > 0 && elapsedMs < thresholds.minElapsedMs) shortTrials += 1;
      const editDistance = toNumber(row.editDistance, null);
      const charCount = toNumber(row.charCount, null);
      const errorRate = computeErrorRate(editDistance, charCount);
      if (errorRate != null && errorRate > thresholds.maxErrorRate) highError += 1;
    });

    const layoutSet = new Set(layouts);
    const participantLayouts = new Map();
    analysisRows.forEach((row) => {
      const pid = row.participantId || "unknown";
      if (!participantLayouts.has(pid)) participantLayouts.set(pid, new Set());
      participantLayouts.get(pid).add(row.layoutId || "unknown");
    });
    let incompleteParticipants = 0;
    participantLayouts.forEach((set) => {
      if (set.size < layoutSet.size) incompleteParticipants += 1;
    });

    const practiceRows = rawRows.filter((r) => String(r.isPractice).toLowerCase() === "true").length;

    return {
      totalRows: rawRows.length,
      usedRows: analysisRows.length,
      practiceRows,
      excludedPractice: thresholds.excludePractice ? practiceRows : 0,
      missing,
      duplicateTrials,
      shortTrials,
      highError,
      participantCount: participantLayouts.size,
      layoutCount: layoutSet.size,
      incompleteParticipants,
    };
  }

  function selectPosthoc(stats) {
    if (!stats) return { list: [], label: "n/a" };
    const preferParam = stats.recommendation.startsWith("Parametric");
    const paramList = stats.posthocParam || [];
    const nonParamList = stats.posthocNonParam || [];
    if (preferParam && paramList.length) return { list: paramList, label: "paired t (Holm)" };
    if (!preferParam && nonParamList.length) return { list: nonParamList, label: "Wilcoxon (Holm)" };
    if (paramList.length) return { list: paramList, label: "paired t (Holm)" };
    if (nonParamList.length) return { list: nonParamList, label: "Wilcoxon (Holm)" };
    return { list: [], label: "n/a" };
  }

  function findPairResult(list, a, b) {
    if (!Array.isArray(list)) return null;
    return list.find((row) => row.pair === `${a} vs ${b}` || row.pair === `${b} vs ${a}`) || null;
  }

  function formatAnovaSummary(stats, preferParametric) {
    if (!stats) return "Not enough data";
    if (preferParametric && stats.anova) {
      return `RM-ANOVA F(${stats.anova.df1}, ${stats.anova.df2}) = ${formatNumber(
        stats.anova.F,
        3
      )}, p = ${formatNumber(stats.anova.p, 4)}, eta²p = ${formatNumber(stats.anova.eta, 3)}`;
    }
    if (stats.friedman) {
      return `Friedman χ²(${stats.friedman.df}) = ${formatNumber(stats.friedman.chi2, 3)}, p = ${formatNumber(
        stats.friedman.p,
        4
      )}, Kendall W = ${formatNumber(stats.friedman.w, 3)}`;
    }
    return "Not enough data";
  }

  function computePrimaryOutcomes(analysis) {
    const baseline = analysis.layouts.includes("qwerty") ? "qwerty" : analysis.layouts[0];
    const wpmStats = computeMetricStats(
      "wpm",
      analysis.participantMeans,
      analysis.layouts,
      analysis.participants
    );
    const errStats = computeMetricStats(
      "errorRate",
      analysis.participantMeans,
      analysis.layouts,
      analysis.participants
    );
    const wpmPosthoc = selectPosthoc(wpmStats);
    const errPosthoc = selectPosthoc(errStats);

    const wpmLayoutStats = analysis.layouts.map((layoutId) => {
      const values = analysis.perLayoutParticipantMeans.get(layoutId)?.wpm ?? [];
      const { mean, ci, n } = meanAndCi(values);
      return { layoutId, mean, ci, n };
    });
    const errLayoutStats = analysis.layouts.map((layoutId) => {
      const values = analysis.perLayoutParticipantMeans.get(layoutId)?.errorRate ?? [];
      const { mean, ci, n } = meanAndCi(values);
      return { layoutId, mean, ci, n };
    });

    const baselineWpm = wpmLayoutStats.find((r) => r.layoutId === baseline)?.mean ?? null;
    const baselineErr = errLayoutStats.find((r) => r.layoutId === baseline)?.mean ?? null;

    const wpmBaselineComparisons = wpmLayoutStats.map((row) => {
      const pair = row.layoutId === baseline ? null : findPairResult(wpmPosthoc.list, baseline, row.layoutId);
      return {
        layoutId: row.layoutId,
        mean: row.mean,
        ci: row.ci,
        delta: baselineWpm != null && row.mean != null ? row.mean - baselineWpm : null,
        pAdj: pair ? pair.pAdj : null,
        effect: pair ? pair.effect : null,
      };
    });
    const errBaselineComparisons = errLayoutStats.map((row) => {
      const pair = row.layoutId === baseline ? null : findPairResult(errPosthoc.list, baseline, row.layoutId);
      return {
        layoutId: row.layoutId,
        mean: row.mean,
        ci: row.ci,
        delta: baselineErr != null && row.mean != null ? row.mean - baselineErr : null,
        pAdj: pair ? pair.pAdj : null,
        effect: pair ? pair.effect : null,
      };
    });

    const bestWpm = wpmBaselineComparisons.reduce((best, row) => {
      if (row.mean == null) return best;
      if (!best || row.mean > best.mean) return row;
      return best;
    }, null);
    const bestErr = errBaselineComparisons.reduce((best, row) => {
      if (row.mean == null) return best;
      if (!best || row.mean < best.mean) return row;
      return best;
    }, null);

    const wpmPreferParam = wpmStats.recommendation.startsWith("Parametric");
    const errPreferParam = errStats.recommendation.startsWith("Parametric");

    return {
      baseline,
      bestWpm,
      bestErr,
      wpm: {
        stats: wpmStats,
        testSummary: formatAnovaSummary(wpmStats, wpmPreferParam),
        posthocLabel: wpmPosthoc.label,
        layoutStats: wpmBaselineComparisons,
      },
      errorRate: {
        stats: errStats,
        testSummary: formatAnovaSummary(errStats, errPreferParam),
        posthocLabel: errPosthoc.label,
        layoutStats: errBaselineComparisons,
      },
    };
  }

  function computeLearningSummary(analysis) {
    return analysis.layouts.map((layoutId) => {
      const curve = analysis.learningCurves.get(layoutId) || new Map();
      const points = Array.from(curve.entries())
        .map(([idx, metrics]) => ({
          idx: Number(idx),
          wpm: mean(metrics.wpm) ?? null,
          errorRate: mean(metrics.errorRate) ?? null,
        }))
        .filter((p) => Number.isFinite(p.idx))
        .sort((a, b) => a.idx - b.idx);

      const early = points.slice(0, 2);
      const late = points.slice(-2);
      const earlyWpm = mean(early.map((p) => p.wpm).filter(Number.isFinite));
      const lateWpm = mean(late.map((p) => p.wpm).filter(Number.isFinite));
      const earlyErr = mean(early.map((p) => p.errorRate).filter(Number.isFinite));
      const lateErr = mean(late.map((p) => p.errorRate).filter(Number.isFinite));
      const slopeWpm = linearRegressionSlope(
        points.map((p) => p.idx),
        points.map((p) => p.wpm)
      );
      const slopeErr = linearRegressionSlope(
        points.map((p) => p.idx),
        points.map((p) => p.errorRate)
      );

      return {
        layoutId,
        earlyWpm,
        lateWpm,
        deltaWpm: earlyWpm != null && lateWpm != null ? lateWpm - earlyWpm : null,
        slopeWpm,
        earlyErr,
        lateErr,
        deltaErr: earlyErr != null && lateErr != null ? lateErr - earlyErr : null,
        slopeErr,
      };
    });
  }

  function computeOrderEffects(analysis) {
    const positionCount = analysis.layouts.length;
    const positions = Array.from({ length: positionCount }, (_, i) => i + 1);
    const perParticipant = new Map();

    analysis.trials.forEach((trial) => {
      if (!Number.isFinite(trial.layoutIndex)) return;
      if (!perParticipant.has(trial.participantId)) perParticipant.set(trial.participantId, new Map());
      const pos = trial.layoutIndex;
      if (!perParticipant.get(trial.participantId).has(pos)) {
        perParticipant.get(trial.participantId).set(pos, { wpm: [], errorRate: [] });
      }
      const bucket = perParticipant.get(trial.participantId).get(pos);
      if (Number.isFinite(trial.metrics.wpm)) bucket.wpm.push(trial.metrics.wpm);
      if (Number.isFinite(trial.metrics.errorRate)) bucket.errorRate.push(trial.metrics.errorRate);
    });

    const matrixWpm = [];
    const matrixErr = [];
    const perPositionValues = positions.map(() => ({ wpm: [], errorRate: [] }));
    perParticipant.forEach((posMap) => {
      const rowWpm = [];
      const rowErr = [];
      let ok = true;
      positions.forEach((pos, idx) => {
        const metrics = posMap.get(pos);
        const wpmMean = metrics ? mean(metrics.wpm) : null;
        const errMean = metrics ? mean(metrics.errorRate) : null;
        if (!Number.isFinite(wpmMean) || !Number.isFinite(errMean)) ok = false;
        rowWpm.push(wpmMean);
        rowErr.push(errMean);
        if (Number.isFinite(wpmMean)) perPositionValues[idx].wpm.push(wpmMean);
        if (Number.isFinite(errMean)) perPositionValues[idx].errorRate.push(errMean);
      });
      if (ok) {
        matrixWpm.push(rowWpm);
        matrixErr.push(rowErr);
      }
    });

    const positionSummary = positions.map((pos, idx) => {
      const wpmStats = meanAndCi(perPositionValues[idx].wpm);
      const errStats = meanAndCi(perPositionValues[idx].errorRate);
      return {
        position: pos,
        wpm: wpmStats.mean,
        wpmCi: wpmStats.ci,
        wpmN: wpmStats.n,
        err: errStats.mean,
        errCi: errStats.ci,
        errN: errStats.n,
      };
    });

    const orderWpmStats = rmAnova(matrixWpm);
    const orderErrStats = rmAnova(matrixErr);
    const orderWpmFriedman = friedmanTest(matrixWpm);
    const orderErrFriedman = friedmanTest(matrixErr);

    const carryoverGroups = new Map();
    analysis.trials.forEach((trial) => {
      if (!trial.prevLayout) return;
      if (!carryoverGroups.has(trial.prevLayout)) {
        carryoverGroups.set(trial.prevLayout, []);
      }
      carryoverGroups.get(trial.prevLayout).push(trial.metrics);
    });

    const carryoverSummary = Array.from(carryoverGroups.entries()).map(([prevLayout, metrics]) => {
      const wpmValues = metrics.map((m) => m.wpm).filter(Number.isFinite);
      const errValues = metrics.map((m) => m.errorRate).filter(Number.isFinite);
      const wpmStats = meanAndCi(wpmValues);
      const errStats = meanAndCi(errValues);
      return {
        prevLayout,
        wpm: wpmStats.mean,
        wpmCi: wpmStats.ci,
        wpmN: wpmStats.n,
        err: errStats.mean,
        errCi: errStats.ci,
        errN: errStats.n,
      };
    });

    const carryoverAnovaWpm = oneWayAnova(
      Array.from(carryoverGroups.entries()).map(([prevLayout, metrics]) => ({
        label: prevLayout,
        values: metrics.map((m) => m.wpm).filter(Number.isFinite),
      }))
    );
    const carryoverAnovaErr = oneWayAnova(
      Array.from(carryoverGroups.entries()).map(([prevLayout, metrics]) => ({
        label: prevLayout,
        values: metrics.map((m) => m.errorRate).filter(Number.isFinite),
      }))
    );

    return {
      positionSummary,
      orderWpmStats,
      orderErrStats,
      orderWpmFriedman,
      orderErrFriedman,
      carryoverSummary,
      carryoverAnovaWpm,
      carryoverAnovaErr,
    };
  }

  function computeSpeedAccuracySummary(analysis) {
    const byLayout = analysis.layouts.map((layoutId) => {
      const values = analysis.perLayoutParticipantMeans.get(layoutId);
      if (!values) return { layoutId, r: null, n: 0 };
      const r = pearsonCorrelation(values.wpm, values.errorRate);
      return { layoutId, r, n: Math.min(values.wpm.length, values.errorRate.length) };
    });
    const allWpm = [];
    const allErr = [];
    analysis.perLayoutParticipantMeans.forEach((values) => {
      values.wpm.forEach((v) => allWpm.push(v));
      values.errorRate.forEach((v) => allErr.push(v));
    });
    const overall = pearsonCorrelation(allWpm, allErr);
    return { overall, byLayout };
  }

  function computeAnalysisData(rows, thresholds) {
    const warnings = [];
    const layouts = [];
    const layoutSet = new Set();
    const participants = new Set();
    const trials = [];
    const analysisRows = thresholds.excludePractice
      ? rows.filter((r) => String(r.isPractice).toLowerCase() !== "true")
      : rows;

    analysisRows.forEach((row) => {
      const layoutId = row.layoutId || "unknown";
      const participantId = row.participantId || "unknown";
      const trialIndex = toNumber(row.trialIndex, null);
      const layoutIndex = toNumber(row.layoutIndex, null);
      const layoutOrder = String(row.layoutOrder || "");
      const orderList = layoutOrder ? layoutOrder.split("|") : [];
      const prevLayout =
        Number.isFinite(layoutIndex) && layoutIndex > 1 && orderList.length >= layoutIndex
          ? orderList[layoutIndex - 2]
          : null;
      const editDistance = toNumber(row.editDistance, null);
      const charCount = toNumber(row.charCount, null);
      const elapsedMs = toNumber(row.elapsedMs, null);
      const wpm = toNumber(row.wpm, null);
      const errorRate = computeErrorRate(editDistance, charCount);
      const elapsedSeconds = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : null;
      const backspaceCount = toNumber(row.backspaceCount, null);
      const keypressCount = toNumber(row.keypressCount, null);
      const kspc =
        Number.isFinite(keypressCount) && Number.isFinite(charCount) && charCount > 0
          ? keypressCount / charCount
          : null;
      const efficiency =
        Number.isFinite(wpm) && Number.isFinite(errorRate) ? wpm * (1 - errorRate) : null;

      if (!layoutSet.has(layoutId)) {
        layoutSet.add(layoutId);
        layouts.push(layoutId);
      }
      participants.add(participantId);

      if (elapsedMs != null && elapsedMs > 0 && elapsedMs < thresholds.minElapsedMs) {
        warnings.push(`Short trial: ${layoutId} (${elapsedMs} ms)`);
      }
      if (errorRate != null && errorRate > thresholds.maxErrorRate) {
        warnings.push(`High error rate: ${layoutId} (${errorRate.toFixed(2)})`);
      }

      trials.push({
        layoutId,
        participantId,
        trialIndex: trialIndex ?? 0,
        layoutIndex: layoutIndex ?? null,
        layoutOrder,
        prevLayout,
        metrics: {
          wpm,
          errorRate,
          editDistance,
          elapsedSeconds,
          backspaceCount,
          keypressCount,
          kspc,
          efficiency,
        },
      });
    });

    const layoutRows = computeLayoutSummary(trials, layouts, thresholds, warnings);
    const participantMap = buildParticipantMaps(trials);
    const participantMeans = computeParticipantMeans(participantMap);
    const perLayoutParticipantMeans = computeLayoutParticipantMeans(participantMeans, layouts);
    const learningCurves = computeLearningCurves(trials, layouts);
    const dataQuality = computeDataQuality(rows, analysisRows, thresholds, layouts);

    const analysis = {
      summary: {
        layouts: layoutRows,
        layoutCount: layouts.length,
        participantCount: participants.size,
        warnings,
      },
      layouts,
      participants: Array.from(participants),
      trials,
      participantMeans,
      perLayoutParticipantMeans,
      learningCurves,
      dataQuality,
    };
    analysis.primaryOutcomes = computePrimaryOutcomes(analysis);
    analysis.learningSummary = computeLearningSummary(analysis);
    analysis.orderEffects = computeOrderEffects(analysis);
    analysis.speedAccuracySummary = computeSpeedAccuracySummary(analysis);
    return analysis;
  }

  function renderAnalysisSummary(summary) {
    const summaryEl = $("analysisSummary");
    summaryEl.innerHTML = `
      <div><strong>Participants:</strong> ${summary.participantCount}</div>
      <div><strong>Layouts:</strong> ${summary.layoutCount}</div>
      <div><strong>Warnings:</strong> ${summary.warnings.length}</div>
    `;
  }

  function renderEligibility(summary, thresholds) {
    const ok = summary.warnings.length === 0;
    const el = $("analysisEligibility");
    el.innerHTML = `
      <div class="${ok ? "badgeOk" : "badgeWarn"}">${ok ? "Pass" : "Review"}</div>
      <div class="hint">min trials ${thresholds.minTrials}, min elapsed ${thresholds.minElapsedMs} ms, max error ${thresholds.maxErrorRate}</div>
    `;
  }

  function renderWarnings(warnings) {
    const container = $("analysisWarnings");
    container.innerHTML = "";
    (warnings || []).slice(0, 6).forEach((w) => {
      const div = document.createElement("div");
      div.className = "warningItem";
      div.textContent = w;
      container.appendChild(div);
    });
  }

  function renderAnalysisTable(layouts) {
    const tbody = $("analysisTableBody");
    tbody.innerHTML = "";
    layouts.forEach((row) => {
      const tr = document.createElement("tr");
      const cells = [
        row.layoutId,
        row.trials,
        row.meanWpm.toFixed(2),
        row.meanEd.toFixed(2),
        row.meanErr.toFixed(3),
        row.meanElapsed.toFixed(2),
      ];
      cells.forEach((c) => {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function renderDataQuality(qc) {
    const container = $("analysisDataQuality");
    if (!qc) {
      container.textContent = "No quality data available.";
      return;
    }
    const missingRows = [
      ["participantId", qc.missing.participantId],
      ["layoutId", qc.missing.layoutId],
      ["wpm", qc.missing.wpm],
      ["editDistance", qc.missing.editDistance],
      ["charCount", qc.missing.charCount],
      ["elapsedMs", qc.missing.elapsedMs],
    ];
    container.innerHTML = `
      <div><strong>Total rows:</strong> ${qc.totalRows}</div>
      <div><strong>Rows used:</strong> ${qc.usedRows}</div>
      <div><strong>Practice rows:</strong> ${qc.practiceRows}</div>
      <div><strong>Excluded practice:</strong> ${qc.excludedPractice}</div>
      <div><strong>Participants:</strong> ${qc.participantCount}</div>
      <div><strong>Layouts:</strong> ${qc.layoutCount}</div>
      <div><strong>Short trials:</strong> ${qc.shortTrials}</div>
      <div><strong>High error rows:</strong> ${qc.highError}</div>
      <div><strong>Duplicate trials:</strong> ${qc.duplicateTrials}</div>
      <div><strong>Incomplete participants:</strong> ${qc.incompleteParticipants}</div>
      <div class="tableWrap" style="margin-top: 8px">
        <table class="table tableDense">
          <thead>
            <tr>
              <th>Missing field</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            ${missingRows
              .map(
                ([label, count]) => `
              <tr>
                <td>${label}</td>
                <td>${count}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderPrimaryOutcomes(primary) {
    const container = $("analysisPrimaryOutcomes");
    if (!primary) {
      container.textContent = "No primary outcomes available.";
      return;
    }
    const baseline = primary.baseline;
    const buildTable = (rows, metricLabel, decimals) => `
      <div class="statTitle" style="margin-top: 6px">${metricLabel} vs baseline (${baseline})</div>
      <div class="tableWrap">
        <table class="table tableDense">
          <thead>
            <tr>
              <th>Layout</th>
              <th>Mean ± CI</th>
              <th>Δ vs baseline</th>
              <th>p (Holm)</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr>
                <td>${row.layoutId}</td>
                <td>${
                  row.mean != null
                    ? `${row.mean.toFixed(decimals)}${row.ci != null ? ` ± ${row.ci.toFixed(decimals)}` : ""}`
                    : "n/a"
                }</td>
                <td>${row.delta != null ? row.delta.toFixed(decimals) : "n/a"}</td>
                <td>${row.pAdj != null ? row.pAdj.toFixed(4) : "n/a"}</td>
                <td>${row.effect != null ? row.effect.toFixed(3) : "n/a"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
    container.innerHTML = `
      <div><strong>WPM test:</strong> ${primary.wpm.testSummary}</div>
      <div><strong>Error rate test:</strong> ${primary.errorRate.testSummary}</div>
      ${buildTable(primary.wpm.layoutStats, "WPM", 2)}
      ${buildTable(primary.errorRate.layoutStats, "Error rate", 3)}
    `;
  }

  function renderLearningSummary(summary) {
    const container = $("analysisLearningSummary");
    if (!summary || !summary.length) {
      container.textContent = "No learning summary available.";
      return;
    }
    container.innerHTML = `
      <div class="tableWrap">
        <table class="table tableDense">
          <thead>
            <tr>
              <th>Layout</th>
              <th>Early WPM</th>
              <th>Late WPM</th>
              <th>Δ WPM</th>
              <th>Slope WPM</th>
              <th>Early error</th>
              <th>Late error</th>
              <th>Δ error</th>
              <th>Slope error</th>
            </tr>
          </thead>
          <tbody>
            ${summary
              .map(
                (row) => `
              <tr>
                <td>${row.layoutId}</td>
                <td>${row.earlyWpm != null ? row.earlyWpm.toFixed(2) : "n/a"}</td>
                <td>${row.lateWpm != null ? row.lateWpm.toFixed(2) : "n/a"}</td>
                <td>${row.deltaWpm != null ? row.deltaWpm.toFixed(2) : "n/a"}</td>
                <td>${row.slopeWpm != null ? row.slopeWpm.toFixed(3) : "n/a"}</td>
                <td>${row.earlyErr != null ? row.earlyErr.toFixed(3) : "n/a"}</td>
                <td>${row.lateErr != null ? row.lateErr.toFixed(3) : "n/a"}</td>
                <td>${row.deltaErr != null ? row.deltaErr.toFixed(3) : "n/a"}</td>
                <td>${row.slopeErr != null ? row.slopeErr.toFixed(4) : "n/a"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderOrderSummary(orderEffects) {
    const container = $("analysisOrderSummary");
    if (!orderEffects) {
      container.textContent = "No order/carryover summary available.";
      return;
    }
    const orderStatsLine = orderEffects.orderWpmStats
      ? `Order WPM RM-ANOVA F(${orderEffects.orderWpmStats.df1}, ${orderEffects.orderWpmStats.df2}) = ${formatNumber(
          orderEffects.orderWpmStats.F,
          3
        )}, p = ${formatNumber(orderEffects.orderWpmStats.p, 4)}`
      : orderEffects.orderWpmFriedman
        ? `Order WPM Friedman χ²(${orderEffects.orderWpmFriedman.df}) = ${formatNumber(
            orderEffects.orderWpmFriedman.chi2,
            3
          )}, p = ${formatNumber(orderEffects.orderWpmFriedman.p, 4)}`
        : "Order WPM stats: n/a";
    const orderErrLine = orderEffects.orderErrStats
      ? `Order error RM-ANOVA F(${orderEffects.orderErrStats.df1}, ${orderEffects.orderErrStats.df2}) = ${formatNumber(
          orderEffects.orderErrStats.F,
          3
        )}, p = ${formatNumber(orderEffects.orderErrStats.p, 4)}`
      : orderEffects.orderErrFriedman
        ? `Order error Friedman χ²(${orderEffects.orderErrFriedman.df}) = ${formatNumber(
            orderEffects.orderErrFriedman.chi2,
            3
          )}, p = ${formatNumber(orderEffects.orderErrFriedman.p, 4)}`
        : "Order error stats: n/a";
    const carryoverStatsLine = orderEffects.carryoverAnovaWpm
      ? `Carryover WPM ANOVA F(${orderEffects.carryoverAnovaWpm.df1}, ${orderEffects.carryoverAnovaWpm.df2}) = ${formatNumber(
          orderEffects.carryoverAnovaWpm.F,
          3
        )}, p = ${formatNumber(orderEffects.carryoverAnovaWpm.p, 4)}`
      : "Carryover WPM ANOVA: n/a";
    const carryoverErrLine = orderEffects.carryoverAnovaErr
      ? `Carryover error ANOVA F(${orderEffects.carryoverAnovaErr.df1}, ${orderEffects.carryoverAnovaErr.df2}) = ${formatNumber(
          orderEffects.carryoverAnovaErr.F,
          3
        )}, p = ${formatNumber(orderEffects.carryoverAnovaErr.p, 4)}`
      : "Carryover error ANOVA: n/a";
    container.innerHTML = `
      <div><strong>${orderStatsLine}</strong></div>
      <div><strong>${orderErrLine}</strong></div>
      <div><strong>${carryoverStatsLine}</strong></div>
      <div><strong>${carryoverErrLine}</strong></div>
      <div class="hint">Carryover stats are simple one-way tests on transitions.</div>
      <div class="tableWrap" style="margin-top: 8px">
        <div class="statTitle">Order position effects</div>
        <table class="table tableDense">
          <thead>
            <tr>
              <th>Position</th>
              <th>Mean WPM ± CI</th>
              <th>Mean error ± CI</th>
            </tr>
          </thead>
          <tbody>
            ${orderEffects.positionSummary
              .map(
                (row) => `
              <tr>
                <td>${row.position}</td>
                <td>${
                  row.wpm != null
                    ? `${row.wpm.toFixed(2)}${row.wpmCi != null ? ` ± ${row.wpmCi.toFixed(2)}` : ""}`
                    : "n/a"
                }</td>
                <td>${
                  row.err != null
                    ? `${row.err.toFixed(3)}${row.errCi != null ? ` ± ${row.errCi.toFixed(3)}` : ""}`
                    : "n/a"
                }</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="tableWrap" style="margin-top: 8px">
        <div class="statTitle">Carryover by previous layout</div>
        <table class="table tableDense">
          <thead>
            <tr>
              <th>Prev layout</th>
              <th>Mean WPM ± CI</th>
              <th>Mean error ± CI</th>
            </tr>
          </thead>
          <tbody>
            ${orderEffects.carryoverSummary
              .map(
                (row) => `
              <tr>
                <td>${row.prevLayout}</td>
                <td>${
                  row.wpm != null
                    ? `${row.wpm.toFixed(2)}${row.wpmCi != null ? ` ± ${row.wpmCi.toFixed(2)}` : ""}`
                    : "n/a"
                }</td>
                <td>${
                  row.err != null
                    ? `${row.err.toFixed(3)}${row.errCi != null ? ` ± ${row.errCi.toFixed(3)}` : ""}`
                    : "n/a"
                }</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderSpeedAccuracyStats(summary) {
    const container = $("speedAccuracyStats");
    if (!summary) {
      container.textContent = "";
      return;
    }
    const overall = summary.overall != null ? summary.overall.toFixed(3) : "n/a";
    container.innerHTML = `
      <div><strong>Overall r:</strong> ${overall}</div>
      ${summary.byLayout
        .map(
          (row) =>
            `<div><strong>${row.layoutId}:</strong> ${row.r != null ? row.r.toFixed(3) : "n/a"}</div>`
        )
        .join("")}
    `;
  }

  function renderDashboard(analysis, thresholds, statusEl) {
    const baseWarnings = analysis.summary.warnings || [];
    renderMetricPanels(analysis.layouts);

    const extraWarnings = [];
    if (analysis.dataQuality) {
      const qc = analysis.dataQuality;
      if (qc.duplicateTrials > 0) {
        extraWarnings.push(`Duplicate trials detected: ${qc.duplicateTrials}`);
      }
      if (qc.incompleteParticipants > 0) {
        extraWarnings.push(`Participants with incomplete layouts: ${qc.incompleteParticipants}`);
      }
      if (qc.missing.wpm > 0 || qc.missing.editDistance > 0 || qc.missing.charCount > 0 || qc.missing.elapsedMs > 0) {
        extraWarnings.push(
          `Missing values: wpm ${qc.missing.wpm}, editDistance ${qc.missing.editDistance}, charCount ${qc.missing.charCount}, elapsedMs ${qc.missing.elapsedMs}`
        );
      }
    }
    let canPlot = true;
    if (statusEl) {
      canPlot = ensureLibraries(statusEl);
    }

    if (canPlot) {
      const colorMap = createLayoutColorMap(analysis.layouts);
      plotSpeedAccuracy(analysis.layouts, analysis.participantMeans, colorMap);

      METRICS.forEach((metric) => {
        const stats = computeMetricStats(
          metric.key,
          analysis.participantMeans,
          analysis.layouts,
          analysis.participants
        );

        if (stats.posthocParamOmitted) {
          extraWarnings.push(
            `${metric.label}: parametric post-hoc omitted ${stats.posthocParamOmitted} pair(s) due to missing data`
          );
        }
        if (stats.posthocNonParamOmitted) {
          extraWarnings.push(
            `${metric.label}: non-parametric post-hoc omitted ${stats.posthocNonParamOmitted} pair(s) due to missing data`
          );
        }
        if (stats.insufficientVariation) {
          extraWarnings.push(`${metric.label}: insufficient variation for parametric recommendation`);
        }
        if (stats.insufficientSample) {
          extraWarnings.push(`${metric.label}: sample size too small for reliable recommendation`);
        }

        const subtitle = $("metric-" + metric.key + "-subtitle");
        if (subtitle) {
          subtitle.textContent = `Participants used: ${stats.nUsed} (excluded: ${
            stats.excluded.length ? stats.excluded.length : 0
          })`;
        }
        const badge = $("metric-" + metric.key + "-badge");
        if (badge) {
          badge.textContent = stats.recommendation;
        }
        renderStatsTable(metric.key, analysis.layouts, stats);

        plotDistribution(metric.key, analysis.layouts, analysis.perLayoutParticipantMeans, colorMap);
        plotMeanCi(metric.key, analysis.layouts, analysis.perLayoutParticipantMeans, colorMap);

        const { participants, matrix } = getCompleteCaseMatrix(
          metric.key,
          analysis.participantMeans,
          analysis.layouts
        );
        plotPaired(metric.key, analysis.layouts, matrix, participants, colorMap);
        plotLearning(metric.key, analysis.layouts, analysis.learningCurves, colorMap);
      });
    }

    const mergedWarnings = mergeWarnings(baseWarnings, extraWarnings);
    const summaryForUi = { ...analysis.summary, warnings: mergedWarnings };
    renderAnalysisSummary(summaryForUi);
    renderEligibility(summaryForUi, thresholds);
    renderWarnings(mergedWarnings);
    renderAnalysisTable(analysis.summary.layouts || []);
    renderDataQuality(analysis.dataQuality);
    renderPrimaryOutcomes(analysis.primaryOutcomes);
    renderLearningSummary(analysis.learningSummary);
    renderOrderSummary(analysis.orderEffects);
    renderSpeedAccuracyStats(analysis.speedAccuracySummary);
  }

  function renderMetricPanels(layouts) {
    const container = $("metricsDashboard");
    container.innerHTML = "";
    METRICS.forEach((metric) => {
      const panel = document.createElement("div");
      panel.className = "metricPanel";
      panel.innerHTML = `
        <div class="metricHeader">
          <div>
            <div class="studyTitle">${metric.label}</div>
            <div class="hint" id="metric-${metric.key}-subtitle"></div>
          </div>
          <div class="metricBadge" id="metric-${metric.key}-badge"></div>
        </div>
        <div class="chartGrid">
          <div class="chartCard">
            <div class="chartTitle">Distribution</div>
            <div id="chart-${metric.key}-dist" class="chart"></div>
          </div>
          <div class="chartCard">
            <div class="chartTitle">Mean + 95% CI</div>
            <div id="chart-${metric.key}-mean" class="chart"></div>
          </div>
          <div class="chartCard">
            <div class="chartTitle">Paired lines</div>
            <div id="chart-${metric.key}-paired" class="chart"></div>
          </div>
          <div class="chartCard">
            <div class="chartTitle">Learning curve</div>
            <div id="chart-${metric.key}-learning" class="chart"></div>
          </div>
        </div>
        <div class="statSection" id="stats-${metric.key}"></div>
      `;
      container.appendChild(panel);
    });
  }

  function plotlyLayoutBase(title) {
    return {
      title: { text: title, font: { size: 14 } },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#f2f5ff" },
      xaxis: { gridcolor: "rgba(255,255,255,0.08)", zerolinecolor: "rgba(255,255,255,0.2)" },
      yaxis: { gridcolor: "rgba(255,255,255,0.08)", zerolinecolor: "rgba(255,255,255,0.2)" },
      margin: { t: 36, r: 10, b: 36, l: 46 },
    };
  }

  function plotDistribution(metricKey, layouts, perLayoutMeans, colorMap) {
    const el = document.getElementById(`chart-${metricKey}-dist`);
    if (!el) return;
    const traces = layouts.map((layoutId) => {
      const values = perLayoutMeans.get(layoutId)?.[metricKey] ?? [];
      return {
        type: "violin",
        y: values,
        name: layoutId,
        box: { visible: true },
        points: "all",
        pointpos: 0,
        jitter: 0.25,
        marker: { size: 5, color: colorMap.get(layoutId) },
        line: { color: colorMap.get(layoutId) },
      };
    });
    Plotly.react(el, traces, plotlyLayoutBase("Distribution"));
  }

  function plotMeanCi(metricKey, layouts, perLayoutMeans, colorMap) {
    const el = document.getElementById(`chart-${metricKey}-mean`);
    if (!el) return;
    const means = [];
    const ci = [];
    layouts.forEach((layoutId) => {
      const values = perLayoutMeans.get(layoutId)?.[metricKey] ?? [];
      const m = mean(values) ?? 0;
      const sd = stdev(values) ?? 0;
      const err = values.length > 1 ? (CI_Z * sd) / Math.sqrt(values.length) : 0;
      means.push(m);
      ci.push(err);
    });
    const trace = {
      type: "bar",
      x: layouts,
      y: means,
      marker: { color: layouts.map((id) => colorMap.get(id)) },
      error_y: { type: "data", array: ci, visible: true },
    };
    Plotly.react(el, [trace], plotlyLayoutBase("Mean + 95% CI"));
  }

  function plotPaired(metricKey, layouts, matrix, participants, colorMap) {
    const el = document.getElementById(`chart-${metricKey}-paired`);
    if (!el) return;
    const traces = [];
    for (let i = 0; i < matrix.length; i++) {
      traces.push({
        type: "scatter",
        mode: "lines+markers",
        x: layouts,
        y: matrix[i],
        name: participants[i],
        line: { color: "rgba(255,255,255,0.18)" },
        marker: { size: 4, color: "rgba(255,255,255,0.45)" },
        hoverinfo: "name+y",
        showlegend: false,
      });
    }
    const meanTrace = {
      type: "scatter",
      mode: "lines+markers",
      x: layouts,
      y: layouts.map((_, idx) => mean(matrix.map((row) => row[idx])) ?? 0),
      name: "Mean",
      line: { color: "#6aa6ff", width: 3 },
      marker: { size: 7, color: "#6aa6ff" },
    };
    traces.push(meanTrace);
    Plotly.react(el, traces, plotlyLayoutBase("Paired lines"));
  }

  function plotLearning(metricKey, layouts, learningCurves, colorMap) {
    const el = document.getElementById(`chart-${metricKey}-learning`);
    if (!el) return;
    const traces = [];
    layouts.forEach((layoutId) => {
      const curve = learningCurves.get(layoutId);
      if (!curve) return;
      const indices = Array.from(curve.keys()).sort((a, b) => a - b);
      const means = [];
      const errors = [];
      indices.forEach((idx) => {
        const values = curve.get(idx)[metricKey] ?? [];
        const m = mean(values) ?? 0;
        const sd = stdev(values) ?? 0;
        const err = values.length > 1 ? (CI_Z * sd) / Math.sqrt(values.length) : 0;
        means.push(m);
        errors.push(err);
      });
      traces.push({
        type: "scatter",
        mode: "lines+markers",
        x: indices,
        y: means,
        name: layoutId,
        line: { color: colorMap.get(layoutId) },
        marker: { size: 6 },
        error_y: { type: "data", array: errors, visible: true },
      });
    });
    Plotly.react(el, traces, plotlyLayoutBase("Learning curve"));
  }

  function plotSpeedAccuracy(layouts, participantMeans, colorMap) {
    const el = document.getElementById("chartSpeedAccuracy");
    if (!el) return;
    const traces = layouts.map((layoutId) => {
      const x = [];
      const y = [];
      participantMeans.forEach((layoutMap) => {
        const values = layoutMap.get(layoutId);
        if (!values) return;
        if (Number.isFinite(values.wpm) && Number.isFinite(values.errorRate)) {
          x.push(values.wpm);
          y.push(values.errorRate);
        }
      });
      return {
        type: "scatter",
        mode: "markers",
        name: layoutId,
        x,
        y,
        marker: { size: 8, color: colorMap.get(layoutId) },
      };
    });
    Plotly.react(el, traces, plotlyLayoutBase("Speed–accuracy tradeoff"));
  }

  function renderStatsTable(metricKey, layouts, stats) {
    const container = $("stats-" + metricKey);
    container.innerHTML = "";
    if (!stats) {
      container.innerHTML = `<div class="hint">Not enough data to compute stats.</div>`;
      return;
    }
    const {
      anova,
      friedman,
      posthocParam,
      posthocNonParam,
      recommendation,
      nUsed,
      excluded,
      posthocParamOmitted,
      posthocNonParamOmitted,
      insufficientVariation,
      insufficientSample,
    } = stats;
    const statGrid = document.createElement("div");
    statGrid.className = "statGrid";
    statGrid.innerHTML = `
      <div class="statCard">
        <div class="statTitle">RM-ANOVA</div>
        <div class="statLine">F(${anova?.df1 ?? "?"}, ${anova?.df2 ?? "?"}) = ${
      anova?.F != null ? anova.F.toFixed(3) : "n/a"
    }</div>
        <div class="statLine">p = ${anova?.p != null ? anova.p.toFixed(4) : "n/a"}</div>
        <div class="statLine">eta²p = ${anova?.eta != null ? anova.eta.toFixed(3) : "n/a"}</div>
      </div>
      <div class="statCard">
        <div class="statTitle">Friedman</div>
        <div class="statLine">χ²(${friedman?.df ?? "?"}) = ${friedman?.chi2 != null ? friedman.chi2.toFixed(3) : "n/a"}</div>
        <div class="statLine">p = ${friedman?.p != null ? friedman.p.toFixed(4) : "n/a"}</div>
        <div class="statLine">Kendall W = ${friedman?.w != null ? friedman.w.toFixed(3) : "n/a"}</div>
      </div>
      <div class="statCard">
        <div class="statTitle">Recommendation</div>
        <div class="statLine">${recommendation}</div>
        <div class="statLine">n used: ${nUsed}</div>
        <div class="statLine">excluded: ${excluded.length ? excluded.join(", ") : "none"}</div>
      </div>
    `;
    container.appendChild(statGrid);

    const notes = [];
    if (posthocParamOmitted) {
      notes.push(`Parametric post-hoc omitted ${posthocParamOmitted} pair(s) due to missing data.`);
    }
    if (posthocNonParamOmitted) {
      notes.push(`Non-parametric post-hoc omitted ${posthocNonParamOmitted} pair(s) due to missing data.`);
    }
    if (insufficientVariation) {
      notes.push("Insufficient variation detected; treat parametric results cautiously.");
    }
    if (insufficientSample) {
      notes.push("Sample size is small; treat recommendations cautiously.");
    }
    if (notes.length) {
      const noteEl = document.createElement("div");
      noteEl.className = "hint";
      noteEl.textContent = notes.join(" ");
      container.appendChild(noteEl);
    }

    const makeTable = (title, rows) => {
      const wrap = document.createElement("div");
      wrap.className = "statTableWrap";
      const header = `
        <div class="statTitle">${title}</div>
        <div class="tableWrap">
          <table class="table tableDense">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Test</th>
                <th>n</th>
                <th>p</th>
                <th>p (Holm)</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                    <tr>
                      <td>${row.pair}</td>
                      <td>${row.test}</td>
                      <td>${row.n}</td>
                      <td>${row.p != null ? row.p.toFixed(4) : "n/a"}</td>
                      <td>${row.pAdj != null ? row.pAdj.toFixed(4) : "n/a"}</td>
                      <td>${row.effect != null ? row.effect.toFixed(3) : "n/a"}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `;
      wrap.innerHTML = header;
      return wrap;
    };

    if (posthocParam && posthocParam.length) {
      container.appendChild(makeTable("Post-hoc (parametric)", posthocParam));
    }
    if (posthocNonParam && posthocNonParam.length) {
      container.appendChild(makeTable("Post-hoc (non-parametric)", posthocNonParam));
    }
  }

  function computeMetricStats(metricKey, participantMeans, layouts, participantsAll) {
    const { participants, matrix } = getCompleteCaseMatrix(metricKey, participantMeans, layouts);
    const excluded = participantsAll.filter((p) => !participants.includes(p));
    const nUsed = participants.length;
    const expectedPairs = (layouts.length * (layouts.length - 1)) / 2;
    if (nUsed < 2) {
      return {
        nUsed,
        excluded,
        recommendation: "Not enough data",
        anova: null,
        friedman: null,
        posthocParamOmitted: expectedPairs,
        posthocNonParamOmitted: expectedPairs,
        insufficientVariation: true,
        insufficientSample: true,
      };
    }
    if (!window.jStat) {
      return {
        nUsed,
        excluded,
        recommendation: "Stats unavailable (jStat not loaded)",
        anova: null,
        friedman: null,
        posthocParam: [],
        posthocNonParam: [],
        posthocParamOmitted: 0,
        posthocNonParamOmitted: 0,
        insufficientVariation: true,
        insufficientSample: true,
      };
    }
    const anova = rmAnova(matrix);
    const friedman = friedmanTest(matrix);
    const posthocParam = pairedTTests(matrix, layouts);
    const posthocNonParam = wilcoxonTests(matrix, layouts);
    const flattened = matrix.flat();
    const { skew, kurtosis } = computeSkewKurtosis(flattened);
    const varianceValue = variance(flattened);
    const insufficientVariation = !varianceValue || varianceValue === 0;
    const insufficientSample = nUsed < 8;
    const recommendParametric =
      !insufficientVariation &&
      !insufficientSample &&
      Math.abs(skew ?? 0) < 1 &&
      Math.abs(kurtosis ?? 0) < 1;
    const recommendation = insufficientVariation
      ? "Insufficient variation to recommend parametric tests"
      : insufficientSample
        ? "Sample size too small for a reliable recommendation"
        : recommendParametric
          ? "Parametric recommended (RM-ANOVA + paired t-tests)"
          : "Non-parametric recommended (Friedman + Wilcoxon)";
    return {
      anova,
      friedman,
      posthocParam,
      posthocNonParam,
      recommendation,
      nUsed,
      excluded,
      posthocParamOmitted: Math.max(0, expectedPairs - posthocParam.length),
      posthocNonParamOmitted: Math.max(0, expectedPairs - posthocNonParam.length),
      insufficientVariation,
      insufficientSample,
    };
  }

  function downloadFile(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function buildResultsTablesCsv(analysis) {
    const lines = ["layoutId,metric,mean,ci,n"];
    analysis.layouts.forEach((layoutId) => {
      const metrics = analysis.perLayoutParticipantMeans.get(layoutId) || {};
      METRICS.forEach((metric) => {
        const values = metrics[metric.key] || [];
        const stats = meanAndCi(values);
        const meanValue = stats.mean != null ? stats.mean.toFixed(metric.decimals) : "";
        const ciValue = stats.ci != null ? stats.ci.toFixed(metric.decimals) : "";
        lines.push(`${layoutId},${metric.key},${meanValue},${ciValue},${stats.n}`);
      });
    });
    return lines.join("\n");
  }

  function buildFiguresListMarkdown() {
    const lines = [
      "# Figures list",
      "",
      "1. Speed–accuracy tradeoff (WPM vs error rate).",
    ];
    METRICS.forEach((metric, idx) => {
      const base = idx * 4 + 2;
      lines.push(`${base}. ${metric.label} distribution (violin/box).`);
      lines.push(`${base + 1}. ${metric.label} mean ± 95% CI.`);
      lines.push(`${base + 2}. ${metric.label} paired lines (within-subject).`);
      lines.push(`${base + 3}. ${metric.label} learning curve.`);
    });
    lines.push("");
    return lines.join("\n");
  }

  function buildReportSnippet(analysis) {
    const primary = analysis.primaryOutcomes;
    const bestWpm =
      primary && primary.bestWpm
        ? `${primary.bestWpm.layoutId} (${primary.bestWpm.mean.toFixed(2)} WPM)`
        : "n/a";
    const bestErr =
      primary && primary.bestErr
        ? `${primary.bestErr.layoutId} (${primary.bestErr.mean.toFixed(3)})`
        : "n/a";
    return `## Study results summary

- Participants: ${analysis.summary.participantCount}
- Layouts: ${analysis.summary.layoutCount}
- Baseline: ${primary?.baseline ?? "n/a"}
- Best WPM: ${bestWpm}
- Lowest error rate: ${bestErr}
- WPM test: ${primary?.wpm?.testSummary ?? "n/a"}
- Error rate test: ${primary?.errorRate?.testSummary ?? "n/a"}
- Warnings: ${analysis.summary.warnings.length}

Generated by the study analysis tool.
`;
  }

  function ensureLibraries(statusEl) {
    if (!window.Plotly) {
      statusEl.textContent = "Plotly failed to load. Check your connection or CDN access.";
      return false;
    }
    if (!window.jStat) {
      statusEl.textContent = "jStat failed to load. Check your connection or CDN access.";
      return false;
    }
    return true;
  }

  async function fetchAndAnalyze() {
    const statusEl = $("analysisStatus");
    const urlInput = $("analysisSheetUrl");
    const rawUrl = String(urlInput.value || "");
    const url = normalizeCsvUrl(rawUrl);
    if (!url) {
      statusEl.textContent = "Paste a published CSV URL first.";
      return;
    }
    if (!ensureLibraries(statusEl)) return;
    urlInput.value = url;
    saveCsvUrl(url);

    const excludeEl = $("analysisExcludePractice");
    const minTrialsEl = $("analysisMinTrials");
    const minElapsedEl = $("analysisMinElapsed");
    const maxErrorEl = $("analysisMaxErrorRate");
    const excludePractice = excludeEl.value === "true";
    const thresholds = {
      excludePractice,
      minTrials: toNumber(minTrialsEl.value, 5),
      minElapsedMs: toNumber(minElapsedEl.value, 2000),
      maxErrorRate: toNumber(maxErrorEl.value, 0.4),
    };
    saveThresholds(thresholds);

    statusEl.textContent = "Fetching CSV...";
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const text = await resp.text();
      const parsed = parseCsv(text);
      if (!parsed.rows.length) {
        statusEl.textContent = "No rows found in CSV.";
        return;
      }
      const missingHeaders = validateHeaders(parsed.headers);
      if (missingHeaders.length) {
        const message = `Missing required columns: ${missingHeaders.join(", ")}`;
        statusEl.textContent = message;
        renderWarnings([message]);
        return;
      }
      const rows = parsed.rows;
      const analysis = computeAnalysisData(rows, thresholds);
      const payload = { rows, thresholds, updatedAtMs: Date.now() };
      saveAnalysisState(payload);
      renderDashboard(analysis, thresholds, statusEl);

      statusEl.textContent = "Analysis updated.";
    } catch (err) {
      statusEl.textContent = `Fetch failed: ${err instanceof Error ? err.message : err}`;
    }
  }

  function init() {
    const storedUrl = loadCsvUrl();
    $("analysisSheetUrl").value = storedUrl || DEFAULT_DEMO_CSV_URL;

    const thresholds = loadThresholds();
    $("analysisExcludePractice").value = thresholds.excludePractice ? "true" : "false";
    $("analysisMinTrials").value = thresholds.minTrials;
    $("analysisMinElapsed").value = thresholds.minElapsedMs;
    $("analysisMaxErrorRate").value = thresholds.maxErrorRate;

    const stored = loadAnalysisState();
    if (stored) {
      const storedThresholds = stored.thresholds || thresholds;
      if (Array.isArray(stored.rows) && stored.rows.length) {
        const analysis = computeAnalysisData(stored.rows, storedThresholds);
        renderDashboard(analysis, storedThresholds, $("analysisStatus"));
      } else if (stored.summary) {
        renderAnalysisSummary(stored.summary);
        renderEligibility(stored.summary, storedThresholds);
        renderWarnings(stored.summary.warnings || []);
        renderAnalysisTable(stored.summary.layouts || []);
        renderMetricPanels(stored.layouts || []);
        renderDataQuality(null);
        renderPrimaryOutcomes(null);
        renderLearningSummary([]);
        renderOrderSummary(null);
        renderSpeedAccuracyStats(null);
        $("analysisStatus").textContent =
          "Stored summary loaded. Click Refresh analysis to recompute charts.";
      }
    }

    $("analysisFetchBtn").addEventListener("click", fetchAndAnalyze);
    $("downloadSummaryBtn").addEventListener("click", () => {
      const state = loadAnalysisState();
      if (!state) return;
      const analysis = state.rows ? computeAnalysisData(state.rows, state.thresholds || thresholds) : null;
      const layouts = analysis ? analysis.summary.layouts : state.summary?.layouts || [];
      const header =
        "layoutId,trials,meanWpm,meanEditDistance,meanErrorRate,meanElapsedSeconds,meanBackspaceCount,meanKeypressCount";
      const lines = layouts.map(
        (r) =>
          `${r.layoutId},${r.trials},${r.meanWpm.toFixed(2)},${r.meanEd.toFixed(2)},${r.meanErr.toFixed(
            3
          )},${r.meanElapsed.toFixed(2)},${r.meanBackspace.toFixed(2)},${r.meanKeypress.toFixed(2)}`
      );
      downloadFile("analysis_summary.csv", [header, ...lines].join("\n"));
    });

    $("downloadReportSnippetBtn").addEventListener("click", () => {
      const state = loadAnalysisState();
      if (!state) return;
      const analysis = state.rows ? computeAnalysisData(state.rows, state.thresholds || thresholds) : null;
      if (!analysis) return;
      const snippet = buildReportSnippet(analysis);
      downloadFile("report_snippet.md", snippet);
    });

    $("downloadResultsTablesBtn").addEventListener("click", () => {
      const state = loadAnalysisState();
      if (!state) return;
      const analysis = state.rows ? computeAnalysisData(state.rows, state.thresholds || thresholds) : null;
      if (!analysis) return;
      downloadFile("analysis_results_tables.csv", buildResultsTablesCsv(analysis));
    });

    $("downloadFiguresListBtn").addEventListener("click", () => {
      downloadFile("analysis_figures_list.md", buildFiguresListMarkdown());
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();
