(function () {
  "use strict";

  const STORAGE_PREFIX = "KbdStudy.analysisPage.";
  const PARTICIPANT_FILTER_KEY = `${STORAGE_PREFIX}participantFilter.v1`;
  const APPS_SCRIPT_WEB_APP_URL =
    "https://script.google.com/macros/s/AKfycbytD-NEdHkHJGAHObI12TCWxzEga5m_PX4A1vmbAJrdwQXSxEQZ8SMTZvbzJ5wq7LbNeA/exec";
  const FIXED_THRESHOLDS = { excludePractice: true, minTrials: 0, minElapsedMs: 0, maxErrorRate: 1 };

  const METRICS = [
    { key: "wpm", label: "WPM", decimals: 2 },
    { key: "errorRate", label: "Error rate", decimals: 3 },
    { key: "editDistance", label: "Edit distance", decimals: 2 },
    { key: "elapsedSeconds", label: "Elapsed (s)", decimals: 2 },
    { key: "backspaceCount", label: "Backspace count", decimals: 2 },
  ];

  const TLX_FIELDS = [
    { key: "tlxMental", label: "Mental demand", decimals: 1 },
    { key: "tlxPhysical", label: "Physical demand", decimals: 1 },
    { key: "tlxTemporal", label: "Temporal demand", decimals: 1 },
    { key: "tlxPerformance", label: "Performance", decimals: 1 },
    { key: "tlxEffort", label: "Effort", decimals: 1 },
    { key: "tlxFrustration", label: "Frustration", decimals: 1 },
  ];
  const TLX_REQUIRED_HEADERS = [
    "sessionId",
    "participantId",
    "layoutName",
    "layoutIndex",
    ...TLX_FIELDS.map((field) => field.key),
  ];

  const REQUIRED_HEADERS = [
    "sessionId",
    "participantId",
    "trialId",
    "layoutId",
    "trialType",
    "learningKind",
    "target",
    "typed",
    "startTimeMs",
    "endTimeMs",
    "elapsedMs",
    "backspaceCount",
    "keypressCount",
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

  let lastRows = null;
  let lastTlxRows = [];
  let lastThresholds = null;
  let lastParticipantIds = [];
  let lastParticipantSelection = new Set();

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

  function loadParticipantFilter() {
    const raw = localStorage.getItem(PARTICIPANT_FILTER_KEY);
    if (!raw) return null;
    const parsed = safeParse(raw, null);
    return Array.isArray(parsed) ? parsed : null;
  }

  function saveParticipantFilter(ids) {
    if (!Array.isArray(ids)) {
      localStorage.removeItem(PARTICIPANT_FILTER_KEY);
      return;
    }
    localStorage.setItem(PARTICIPANT_FILTER_KEY, JSON.stringify(ids));
  }

  function ensureAppsScriptUrl(statusEl) {
    if (!APPS_SCRIPT_WEB_APP_URL) {
      if (statusEl) statusEl.textContent = "Missing Apps Script URL. Set APPS_SCRIPT_WEB_APP_URL in analysisApp.js.";
      return false;
    }
    return true;
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

  function validateTlxHeaders(headers) {
    const normalized = headers.map((h) => h.trim());
    return TLX_REQUIRED_HEADERS.filter((h) => !normalized.includes(h));
  }

  async function fetchParticipantSheets() {
    const url = `${APPS_SCRIPT_WEB_APP_URL}?action=listSheets`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`List fetch failed (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    if (!data || data.ok !== true) {
      throw new Error(data?.error || "Failed to list participant sheets.");
    }
    return Array.isArray(data.sheets) ? data.sheets : [];
  }

  async function fetchSheetCsv(sheetName) {
    const url = `${APPS_SCRIPT_WEB_APP_URL}?action=csv&sheet=${encodeURIComponent(sheetName)}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`CSV fetch failed for ${sheetName} (HTTP ${resp.status})`);
    }
    return resp.text();
  }

  async function fetchTlxRows() {
    try {
      const tlxCsv = await fetchSheetCsv("TLX");
      const parsed = parseCsv(tlxCsv);
      if (!parsed.rows.length) return { rows: [], warnings: [] };
      const missingHeaders = validateTlxHeaders(parsed.headers);
      if (missingHeaders.length) {
        return {
          rows: [],
          warnings: [`Sheet TLX missing columns: ${missingHeaders.join(", ")}`],
        };
      }
      return { rows: parsed.rows, warnings: [] };
    } catch (err) {
      return {
        rows: [],
        warnings: [`Failed to fetch TLX sheet: ${err instanceof Error ? err.message : err}`],
      };
    }
  }

  async function fetchAllParticipantRows(statusEl) {
    if (!ensureAppsScriptUrl(statusEl)) return { rows: [], warnings: ["Missing Apps Script URL."] };
    statusEl.textContent = "Fetching participant sheet list...";
    const sheets = await fetchParticipantSheets();
    if (!sheets.length) {
      return { rows: [], warnings: ["No participant sheets found."] };
    }
    statusEl.textContent = `Fetching ${sheets.length} participant sheet${sheets.length === 1 ? "" : "s"}...`;

    const results = await Promise.allSettled(sheets.map((name) => fetchSheetCsv(name)));
    const rows = [];
    const warnings = [];

    results.forEach((result, idx) => {
      const sheetName = sheets[idx];
      if (result.status !== "fulfilled") {
        warnings.push(`Failed to fetch ${sheetName}: ${result.reason?.message || result.reason}`);
        return;
      }
      const parsed = parseCsv(result.value);
      if (!parsed.rows.length) return;
      const missingHeaders = validateHeaders(parsed.headers);
      if (missingHeaders.length) {
        warnings.push(`Sheet ${sheetName} missing columns: ${missingHeaders.join(", ")}`);
        return;
      }
      parsed.rows.forEach((row) => {
        if (!row.participantId) row.participantId = sheetName;
      });
      rows.push(...parsed.rows);
    });

    statusEl.textContent = "Fetching TLX sheet...";
    const tlxResult = await fetchTlxRows();
    if (tlxResult.warnings.length) warnings.push(...tlxResult.warnings);

    return { rows, warnings, tlxRows: tlxResult.rows };
  }

  function getAnalysisForDownload(thresholds, statusEl) {
    if (!lastRows || !lastRows.length) {
      if (statusEl) statusEl.textContent = "No data loaded yet. Click Refresh analysis.";
      return null;
    }
    const normalizedTlxRows = normalizeTlxRows(lastTlxRows || [], lastRows);
    return computeAnalysisData(lastRows, thresholds, normalizedTlxRows);
  }

  function toNumber(value, fallback = null) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function computeWpm(charCount, elapsedMs) {
    if (!Number.isFinite(charCount) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
    const minutes = elapsedMs / 1000 / 60;
    return (charCount / 5) / minutes;
  }

  function editDistance(a, b) {
    const s = String(a ?? "");
    const t = String(b ?? "");
    const n = s.length;
    const m = t.length;
    if (n === 0) return m;
    if (m === 0) return n;

    let prev = new Array(m + 1);
    let curr = new Array(m + 1);

    for (let j = 0; j <= m; j++) prev[j] = j;

    for (let i = 1; i <= n; i++) {
      curr[0] = i;
      const sChar = s.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const cost = sChar === t.charCodeAt(j - 1) ? 0 : 1;
        const del = prev[j] + 1;
        const ins = curr[j - 1] + 1;
        const sub = prev[j - 1] + cost;
        curr[j] = Math.min(del, ins, sub);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }

    return prev[m];
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

  function listParticipants(rows) {
    const set = new Set();
    rows.forEach((row) => {
      const pid = String(row.participantId || "unknown").trim() || "unknown";
      set.add(pid);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function deriveColumns(rows) {
    const bySession = new Map();
    rows.forEach((row) => {
      const sessionId = row.sessionId || "";
      if (!bySession.has(sessionId)) bySession.set(sessionId, []);
      bySession.get(sessionId).push(row);
    });

    bySession.forEach((sessionRows) => {
      const ordered = sessionRows
        .slice()
        .sort((a, b) => (toNumber(a.trialId, 0) ?? 0) - (toNumber(b.trialId, 0) ?? 0));
      const layoutOrder = [];
      const layoutIndexMap = new Map();

      ordered.forEach((row) => {
        const layoutId = row.layoutId || "";
        const trialType = String(row.trialType || "").toLowerCase();
        if (trialType === "free" || !layoutId) return;
        if (!layoutIndexMap.has(layoutId)) {
          layoutIndexMap.set(layoutId, layoutOrder.length + 1);
          layoutOrder.push(layoutId);
        }
      });

      const layoutOrderStr = layoutOrder.join("|");
      const mainCounters = new Map();

      ordered.forEach((row) => {
        const trialType = String(row.trialType || "").toLowerCase();
        const typed = String(row.typed ?? "");
        const target = String(row.target ?? "");
        const elapsedMs = toNumber(row.elapsedMs, null);
        const charCount = typed.length;
        row.charCount = charCount;
        row.editDistance = editDistance(target, typed);
        row.wpm = computeWpm(charCount, elapsedMs);
        row.isPractice = trialType === "practice";
        row.layoutOrder = layoutOrderStr;
        row.layoutIndex = layoutIndexMap.get(row.layoutId) ?? null;

        if (trialType === "main") {
          const next = (mainCounters.get(row.layoutId) || 0) + 1;
          mainCounters.set(row.layoutId, next);
          row.trialIndex = next;
        } else {
          row.trialIndex = 0;
        }
      });
    });

    return rows;
  }

  function normalizeParticipantSelection(savedIds, availableIds) {
    if (!Array.isArray(availableIds) || !availableIds.length) return new Set();
    const availableSet = new Set(availableIds);
    const saved = Array.isArray(savedIds) ? savedIds.filter((id) => availableSet.has(id)) : [];
    if (!saved.length) return new Set(availableIds);
    return new Set(saved);
  }

  function applyParticipantFilter(rows, selectedSet) {
    if (!selectedSet || selectedSet.size === 0) return [];
    return rows.filter((row) => {
      const pid = String(row.participantId || "unknown").trim() || "unknown";
      return selectedSet.has(pid);
    });
  }

  function normalizeTlxRows(tlxRows, rows) {
    if (!Array.isArray(tlxRows) || !tlxRows.length) return [];
    const sessionToParticipant = new Map();
    (rows || []).forEach((row) => {
      const sid = String(row.sessionId || "").trim();
      const pid = String(row.participantId || "").trim();
      if (sid && pid && !sessionToParticipant.has(sid)) sessionToParticipant.set(sid, pid);
    });

    return tlxRows.map((row) => {
      const sid = String(row.sessionId || "").trim();
      const pid = String(row.participantId || "").trim();
      const mapped = sessionToParticipant.get(sid);
      if (mapped && mapped !== pid) {
        return { ...row, participantId: mapped };
      }
      return row;
    });
  }

  function updateParticipantSummary(selectedSet, totalCount) {
    const summaryEl = document.getElementById("analysisParticipantSummary");
    if (!summaryEl) return;
    if (!totalCount) {
      summaryEl.textContent = "Load data to see participants.";
      return;
    }
    const selectedCount = selectedSet ? selectedSet.size : 0;
    summaryEl.textContent = `${selectedCount}/${totalCount} participants selected.`;
  }

  function recomputeFromFilters(statusEl) {
    if (!lastRows || !lastThresholds) return;
    const filteredRows = applyParticipantFilter(lastRows, lastParticipantSelection);
    const normalizedTlxRows = normalizeTlxRows(lastTlxRows || [], lastRows);
    const filteredTlxRows = applyParticipantFilter(normalizedTlxRows, lastParticipantSelection);
    const analysis = computeAnalysisData(filteredRows, lastThresholds, filteredTlxRows);
    renderAnalysisFlow(analysis, lastThresholds, statusEl || null);
    if (statusEl) {
      statusEl.textContent = filteredRows.length ? "Analysis updated." : "No participants selected.";
    }
  }

  function renderParticipantFilter(participantIds, selectedSet, statusEl) {
    const listEl = document.getElementById("analysisParticipantList");
    const selectAllBtn = document.getElementById("analysisSelectAllBtn");
    const selectNoneBtn = document.getElementById("analysisSelectNoneBtn");
    if (!listEl) return;
    listEl.innerHTML = "";

    const ids = Array.isArray(participantIds) ? participantIds : [];
    lastParticipantIds = ids;
    lastParticipantSelection = selectedSet instanceof Set ? selectedSet : new Set();

    updateParticipantSummary(lastParticipantSelection, ids.length);

    if (!ids.length) {
      if (selectAllBtn) selectAllBtn.disabled = true;
      if (selectNoneBtn) selectNoneBtn.disabled = true;
      return;
    }

    if (selectAllBtn) {
      selectAllBtn.disabled = false;
      selectAllBtn.onclick = () => {
        lastParticipantSelection = new Set(ids);
        saveParticipantFilter(Array.from(lastParticipantSelection));
        renderParticipantFilter(ids, lastParticipantSelection, statusEl);
        recomputeFromFilters(statusEl);
      };
    }
    if (selectNoneBtn) {
      selectNoneBtn.disabled = false;
      selectNoneBtn.onclick = () => {
        lastParticipantSelection = new Set();
        saveParticipantFilter([]);
        renderParticipantFilter(ids, lastParticipantSelection, statusEl);
        recomputeFromFilters(statusEl);
      };
    }

    ids.forEach((pid) => {
      const label = document.createElement("label");
      label.className = "analysisParticipantItem";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = lastParticipantSelection.has(pid);
      input.addEventListener("change", () => {
        if (input.checked) lastParticipantSelection.add(pid);
        else lastParticipantSelection.delete(pid);
        saveParticipantFilter(Array.from(lastParticipantSelection));
        updateParticipantSummary(lastParticipantSelection, ids.length);
        recomputeFromFilters(statusEl);
      });
      const text = document.createElement("span");
      text.textContent = pid;
      label.appendChild(input);
      label.appendChild(text);
      listEl.appendChild(label);
    });
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

  // ── Shapiro-Wilk test (Royston 1995 algorithm AS R94) ───────────────────────
  // Returns { W, p } or null if the input is unsuitable.
  // Valid for 3 <= n <= 5000. Uses jStat.normal.inv for quantiles.
  function shapiroWilk(x) {
    if (!window.jStat) return null;
    const sorted = x.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (n < 3) return null;

    // Check for zero variance
    const xMean = mean(sorted);
    const s2 = sorted.reduce((acc, v) => acc + (v - xMean) ** 2, 0);
    if (s2 === 0) return { W: 1, p: 1 };

    // Compute Shapiro-Wilk coefficients 'a' via Blom-type normal order statistics
    const m = new Array(n);
    for (let i = 0; i < n; i++) {
      m[i] = jStat.normal.inv((i + 1 - 0.375) / (n + 0.25), 0, 1);
    }
    const mSum2 = m.reduce((acc, v) => acc + v * v, 0);

    // Compute weights 'a'
    const a = new Array(n).fill(0);
    if (n === 3) {
      const sqrt2 = Math.SQRT2;
      a[0] = m[n - 1] / Math.sqrt(2 * mSum2);
      a[n - 1] = -a[0];
    } else {
      // Use Royston's polynomial approximation for a[n-1] and a[n-2]
      const u = 1 / Math.sqrt(n);
      // Coefficients for the largest weight a_n (from Royston 1995)
      const an = m[n - 1] / Math.sqrt(mSum2);
      const an1 = n <= 5
        ? (m[n - 2] / Math.sqrt(mSum2))
        : m[n - 2] / Math.sqrt(mSum2);

      // Polynomial approximations for a[n-1]
      const p1 = [-2.706056, 4.434685, -2.07119, -0.147981, 0.221157, an];
      const evalPoly = (coeffs, x) => {
        let result = coeffs[0];
        for (let i = 1; i < coeffs.length; i++) result = result * x + coeffs[i];
        return result;
      };

      // For small n (<=5), use simple normalized weights
      if (n <= 5) {
        for (let i = 0; i < n; i++) a[i] = m[i] / Math.sqrt(mSum2);
      } else {
        // Compute a[n-1] via polynomial in u
        a[n - 1] = -2.706056 * Math.pow(u, 5) + 4.434685 * Math.pow(u, 4)
          - 2.07119 * Math.pow(u, 3) - 0.147981 * Math.pow(u, 2)
          + 0.221157 * u + an;
        a[0] = -a[n - 1];

        // Compute a[n-2] via polynomial in u
        a[n - 2] = -3.582633 * Math.pow(u, 5) + 5.682633 * Math.pow(u, 4)
          - 1.752461 * Math.pow(u, 3) - 0.293762 * Math.pow(u, 2)
          + 0.042981 * u + an1;
        a[1] = -a[n - 2];

        // Fill middle weights using normalized m values, adjusted so sum(a^2) = 1
        const phi = (s2 - 2 * sorted[n - 1] ** 2 * a[n - 1] ** 2 - 2 * sorted[n - 2] ** 2 * a[n - 2] ** 2);
        const endSumA2 = a[0] ** 2 + a[1] ** 2 + a[n - 2] ** 2 + a[n - 1] ** 2;
        const midMSum2 = m.slice(2, n - 2).reduce((acc, v) => acc + v * v, 0);
        if (midMSum2 > 0) {
          const scale = Math.sqrt((1 - endSumA2) / midMSum2);
          for (let i = 2; i < n - 2; i++) a[i] = m[i] * scale;
        }
      }
    }

    // Compute W statistic
    let numerator = 0;
    for (let i = 0; i < n; i++) numerator += a[i] * sorted[i];
    numerator = numerator * numerator;
    const W = numerator / s2;

    // Compute p-value using Royston's normalizing transformation
    let z, mu, sigma;
    if (n <= 11) {
      // Small sample: use log-transform
      const gamma = 0.459 * n - 2.273;
      const logW = -Math.log(1 - W);
      mu = -0.0006714 * n * n * n + 0.025054 * n * n - 0.39978 * n + 0.5440;
      sigma = Math.exp(-0.0020322 * n * n * n + 0.062767 * n * n - 0.77857 * n + 1.3822);
      z = (logW - mu) / sigma;
    } else {
      // Larger sample: use log(1 - W) transform
      const logN = Math.log(n);
      mu = 0.0038915 * logN * logN * logN - 0.083751 * logN * logN - 0.31082 * logN - 1.5861;
      sigma = Math.exp(0.0030302 * logN * logN * logN - 0.082676 * logN * logN - 0.4803);
      z = (Math.log(1 - W) - mu) / sigma;
    }

    const p = 1 - jStat.normal.cdf(z, 0, 1);
    return { W: Math.min(W, 1), p: Math.max(0, Math.min(1, p)) };
  }

  // ── Mauchly's sphericity test ──────────────────────────────────────────────
  // Input: n x k matrix (participants x conditions).
  // Returns { W, chi2, df, p, epsilon } where epsilon = Greenhouse-Geisser.
  function mauchlyTest(matrix) {
    if (!window.jStat) return null;
    const n = matrix.length;
    if (!n) return null;
    const k = matrix[0].length;
    if (k < 3) return null; // sphericity is trivially satisfied with k=2

    // Compute k-1 orthogonal difference variables (simple consecutive differences)
    const p = k - 1; // number of difference variables
    const diffs = []; // n x p matrix
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let j = 0; j < p; j++) {
        row.push(matrix[i][j] - matrix[i][j + 1]);
      }
      diffs.push(row);
    }

    // Compute covariance matrix S of the difference variables (p x p)
    const diffMeans = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < p; j++) diffMeans[j] += diffs[i][j];
    }
    for (let j = 0; j < p; j++) diffMeans[j] /= n;

    const S = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < p; r++) {
        for (let c = 0; c < p; c++) {
          S[r][c] += (diffs[i][r] - diffMeans[r]) * (diffs[i][c] - diffMeans[c]);
        }
      }
    }
    for (let r = 0; r < p; r++) {
      for (let c = 0; c < p; c++) S[r][c] /= (n - 1);
    }

    // Determinant of S (for p=2, which is our k=3 case)
    let detS;
    if (p === 1) {
      detS = S[0][0];
    } else if (p === 2) {
      detS = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    } else {
      // General LU-based determinant for larger p
      detS = matDeterminant(S, p);
    }

    // Trace of S
    let traceS = 0;
    for (let j = 0; j < p; j++) traceS += S[j][j];

    // Mauchly's W
    const W = detS / Math.pow(traceS / p, p);

    // Chi-squared approximation (Box 1954)
    const f = (2 * p * p + p + 2) / (6 * p * (n - 1));
    const df = (p * (p + 1)) / 2 - 1;
    const chi2 = -(n - 1 - f) * Math.log(Math.max(W, 1e-15));
    const pValue = 1 - jStat.chisquare.cdf(chi2, df);

    // Greenhouse-Geisser epsilon
    const epsilon = computeGreenhouseGeisser(S, p);

    return {
      W: Math.max(0, Math.min(1, W)),
      chi2,
      df,
      p: Math.max(0, Math.min(1, pValue)),
      epsilon,
    };
  }

  // Determinant via LU decomposition (for general p x p matrix)
  function matDeterminant(M, p) {
    const A = M.map((row) => row.slice());
    let det = 1;
    for (let i = 0; i < p; i++) {
      let maxRow = i;
      for (let r = i + 1; r < p; r++) {
        if (Math.abs(A[r][i]) > Math.abs(A[maxRow][i])) maxRow = r;
      }
      if (maxRow !== i) {
        [A[i], A[maxRow]] = [A[maxRow], A[i]];
        det *= -1;
      }
      if (Math.abs(A[i][i]) < 1e-15) return 0;
      det *= A[i][i];
      for (let r = i + 1; r < p; r++) {
        const factor = A[r][i] / A[i][i];
        for (let c = i; c < p; c++) A[r][c] -= factor * A[i][c];
      }
    }
    return det;
  }

  // Greenhouse-Geisser epsilon from the covariance matrix of difference scores
  function computeGreenhouseGeisser(S, p) {
    // Epsilon = (trace(S))^2 / (p * trace(S * S))
    let traceS = 0;
    let traceSS = 0;
    for (let i = 0; i < p; i++) {
      traceS += S[i][i];
      for (let j = 0; j < p; j++) {
        traceSS += S[i][j] * S[j][i];
      }
    }
    if (traceSS === 0 || p === 0) return 1;
    const epsilon = (traceS * traceS) / (p * traceSS);
    // Epsilon is bounded [1/(k-1), 1] but clamp to be safe
    return Math.max(1 / p, Math.min(1, epsilon));
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


  function computeAnalysisData(rows, thresholds, tlxRows = []) {
    const warnings = [];
    const layouts = [];
    const layoutSet = new Set();
    const participants = new Set();
    const trials = [];
    const isPracticeRow = (r) => String(r.isPractice).toLowerCase() === "true";
    const isLearningRow = (r) => String(r.trialType).toLowerCase() === "learning";
    const analysisRows = thresholds.excludePractice
      ? rows.filter((r) => !isPracticeRow(r) && !isLearningRow(r))
      : rows.filter((r) => !isLearningRow(r));

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
        },
      });
    });

    const layoutRows = computeLayoutSummary(trials, layouts, thresholds, warnings);
    const participantMap = buildParticipantMaps(trials);
    const participantMeans = computeParticipantMeans(participantMap);
    const perLayoutParticipantMeans = computeLayoutParticipantMeans(participantMeans, layouts);

    // ── TLX data processing ──────────────────────────────────────────────────
    const tlxParticipantMeans = new Map(); // participantId -> Map(layoutId -> { tlxOverall, tlxMental, ... })
    const tlxPerLayoutMeans = new Map();   // layoutId -> { tlxOverall: [], tlxMental: [], ... }

    if (tlxRows.length) {
      // Build (sessionId, layoutIndex) → layoutId from ALL trial rows (incl. learning/practice)
      const sessionLayoutMap = new Map();
      rows.forEach((row) => {
        const sid = String(row.sessionId || "").trim();
        const idx = toNumber(row.layoutIndex, null);
        const id = String(row.layoutId || "").trim();
        if (sid && idx != null && id) {
          const key = `${sid}|${idx}`;
          if (!sessionLayoutMap.has(key)) sessionLayoutMap.set(key, id);
        }
      });

      // Hardcoded fallback: layoutName (display) → layoutId
      const layoutNameToId = new Map([
        ["Clancy (Custom)", "clancy_custom"],
        ["FakeQwerty", "fake_qwerty"],
        ["FittsOrSomething", "fits_or_something"],
      ]);

      // Group TLX rows by participant + layout
      tlxRows.forEach((row) => {
        const pid = row.participantId;
        const sid = String(row.sessionId || "").trim();
        const idx = toNumber(row.layoutIndex, null);
        const key = sid && idx != null ? `${sid}|${idx}` : "";
        const rawName = String(row.layoutName || "").trim();
        const lid = sessionLayoutMap.get(key) || layoutNameToId.get(rawName) || rawName;
        if (!pid || !lid) return;

        const scores = {};
        let validCount = 0;
        TLX_FIELDS.forEach((field) => {
          const v = toNumber(row[field.key], null);
          scores[field.key] = v;
          if (Number.isFinite(v)) validCount++;
        });
        if (validCount !== TLX_FIELDS.length) return; // skip incomplete rows

        scores.tlxOverall = TLX_FIELDS.reduce((sum, f) => sum + scores[f.key], 0) / TLX_FIELDS.length;

        if (!tlxParticipantMeans.has(pid)) tlxParticipantMeans.set(pid, new Map());
        tlxParticipantMeans.get(pid).set(lid, scores);
      });

      // Build per-layout arrays for charting
      layouts.forEach((layoutId) => {
        const bucket = { tlxOverall: [] };
        TLX_FIELDS.forEach((f) => { bucket[f.key] = []; });
        tlxParticipantMeans.forEach((layoutMap) => {
          const scores = layoutMap.get(layoutId);
          if (!scores) return;
          if (Number.isFinite(scores.tlxOverall)) bucket.tlxOverall.push(scores.tlxOverall);
          TLX_FIELDS.forEach((f) => {
            if (Number.isFinite(scores[f.key])) bucket[f.key].push(scores[f.key]);
          });
        });
        tlxPerLayoutMeans.set(layoutId, bucket);
      });
    }

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
      tlxParticipantMeans,
      tlxPerLayoutMeans,
    };
    return analysis;
  }

  function renderAnalysisSummary(summary) {
    const summaryEl = $("analysisSummary");
    summaryEl.innerHTML = `
      <div><strong>Participants:</strong> ${summary.participantCount}</div>
      <div><strong>Layouts:</strong> ${summary.layoutCount}</div>
    `;
  }

  function renderEligibility(summary, thresholds) {
    const ok = summary.warnings.length === 0;
    const el = $("analysisEligibility");
    const detail = thresholds.excludePractice ? "Practice excluded by default." : "Practice included.";
    el.innerHTML = `
      <div class="${ok ? "badgeOk" : "badgeWarn"}">${ok ? "Pass" : "Review"}</div>
      <div class="hint">${detail}</div>
    `;
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

  // ── Chart helpers ──────────────────────────────────────────────────────────

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

  // ── New analysis flow ───────────────────────────────────────────────────────
  function renderAnalysisFlow(analysis, thresholds, statusEl) {
    // Keep the top-level summary table and cards working
    renderAnalysisSummary(analysis.summary);
    renderEligibility(analysis.summary, thresholds);
    renderAnalysisTable(analysis.summary.layouts || []);

    // Populate key findings with basic WPM info
    const keyFindingsEl = document.getElementById("analysisKeyFindings");
    if (keyFindingsEl) {
      const layoutWpms = (analysis.summary.layouts || []).map((r) => ({
        id: r.layoutId,
        wpm: r.meanWpm,
      }));
      const best = layoutWpms.reduce((a, b) => (b.wpm > a.wpm ? b : a), layoutWpms[0] || { id: "n/a", wpm: 0 });
      const worst = layoutWpms.reduce((a, b) => (b.wpm < a.wpm ? b : a), layoutWpms[0] || { id: "n/a", wpm: 0 });
      keyFindingsEl.innerHTML = `
        <div><strong>Fastest layout:</strong> ${best.id} (${formatNumber(best.wpm, 2)} WPM)</div>
        <div><strong>Slowest layout:</strong> ${worst.id} (${formatNumber(worst.wpm, 2)} WPM)</div>
      `;
    }

    // ── Step 1: Data overview ───────────────────────────────────────────────
    const overviewEl = $("analysisDataOverview");
    const layoutNames = analysis.layouts.join(", ");
    const trialsPerLayout = analysis.summary.layouts
      ? analysis.summary.layouts.map((r) => `${r.layoutId}: ${r.trials}`).join(", ")
      : "n/a";
    overviewEl.innerHTML = `
      <div><strong>Participants:</strong> ${analysis.summary.participantCount}</div>
      <div><strong>Layouts:</strong> ${analysis.summary.layoutCount} (${layoutNames})</div>
      <div><strong>Trials per layout:</strong> ${trialsPerLayout}</div>
      <div class="hint" style="margin-top: 6px">Only <code>trialType = main</code> trials are included. Learning and practice trials are excluded.</div>
    `;

    // ── Step 2: Assumption checks ───────────────────────────────────────────
    const { participants: wpmParticipants, matrix: wpmMatrix } = getCompleteCaseMatrix(
      "wpm",
      analysis.participantMeans,
      analysis.layouts
    );

    const verdictEl = $("assumptionVerdict");
    const shapiroEl = $("shapiroResults");
    const mauchlySection = $("mauchlySection");
    const mauchlyEl = $("mauchlyResults");

    if (wpmParticipants.length < 3) {
      verdictEl.innerHTML = `<div class="badgeWarn" style="padding: 10px; font-size: 1.1em;">Not enough complete-case participants (${wpmParticipants.length}) to run assumption checks. Need at least 3.</div>`;
      shapiroEl.innerHTML = "";
      mauchlySection.style.display = "none";
      renderWpmAnalysisInsufficient(wpmParticipants.length);
      renderTlxAnalysis(analysis, statusEl);
      return;
    }

    // Compute pairwise differences for Shapiro-Wilk
    const k = analysis.layouts.length;
    const shapiroResults = [];
    let allNormal = true;
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const diffs = wpmMatrix.map((row) => row[a] - row[b]);
        const sw = shapiroWilk(diffs);
        const pass = sw && sw.p > 0.05;
        if (!pass) allNormal = false;
        shapiroResults.push({
          pairLabel: `${analysis.layouts[a]} vs ${analysis.layouts[b]}`,
          W: sw ? sw.W : null,
          p: sw ? sw.p : null,
          pass,
        });
      }
    }

    const useParametric = allNormal;

    // Render Shapiro-Wilk table
    let shapiroHtml = `<table class="table tableDense">
      <thead><tr><th>Pair (difference)</th><th>W</th><th>p</th><th>Verdict</th></tr></thead><tbody>`;
    shapiroResults.forEach((row) => {
      const verdictClass = row.pass ? "badgeOk" : "badgeWarn";
      const verdictText = row.pass ? "Normal (p > 0.05)" : "Non-normal (p <= 0.05)";
      shapiroHtml += `<tr>
        <td>${row.pairLabel}</td>
        <td>${formatNumber(row.W, 4)}</td>
        <td>${formatNumber(row.p, 4)}</td>
        <td><span class="${verdictClass}">${verdictText}</span></td>
      </tr>`;
    });
    shapiroHtml += "</tbody></table>";
    shapiroEl.innerHTML = shapiroHtml;

    // Mauchly's test (only if parametric path and k >= 3)
    let sphericityOk = true;
    let ggEpsilon = 1;
    let mauchlyResult = null;

    if (useParametric && k >= 3) {
      mauchlySection.style.display = "block";
      mauchlyResult = mauchlyTest(wpmMatrix);
      if (mauchlyResult) {
        sphericityOk = mauchlyResult.p > 0.05;
        ggEpsilon = mauchlyResult.epsilon;
        const sphVerdictClass = sphericityOk ? "badgeOk" : "badgeWarn";
        const sphVerdictText = sphericityOk
          ? "Sphericity holds (p > 0.05)"
          : `Sphericity violated (p <= 0.05) — GG epsilon = ${formatNumber(ggEpsilon, 3)}`;
        mauchlyEl.innerHTML = `<table class="table tableDense">
          <thead><tr><th>W</th><th>&chi;&sup2;</th><th>df</th><th>p</th><th>GG &epsilon;</th><th>Verdict</th></tr></thead>
          <tbody><tr>
            <td>${formatNumber(mauchlyResult.W, 4)}</td>
            <td>${formatNumber(mauchlyResult.chi2, 3)}</td>
            <td>${mauchlyResult.df}</td>
            <td>${formatNumber(mauchlyResult.p, 4)}</td>
            <td>${formatNumber(mauchlyResult.epsilon, 3)}</td>
            <td><span class="${sphVerdictClass}">${sphVerdictText}</span></td>
          </tr></tbody>
        </table>`;
      } else {
        mauchlyEl.innerHTML = `<div class="hint">Could not compute Mauchly's test.</div>`;
      }
    } else if (useParametric && k < 3) {
      mauchlySection.style.display = "none";
    } else {
      mauchlySection.style.display = "block";
      mauchlyEl.innerHTML = `<div class="hint">Skipped — non-parametric path selected (Shapiro-Wilk rejected normality).</div>`;
    }

    // Render overall verdict banner
    let verdictLabel, verdictDetail;
    if (useParametric && sphericityOk) {
      verdictLabel = "Parametric path";
      verdictDetail = "Normality holds. Sphericity holds. Using RM-ANOVA (uncorrected) + paired t-tests with Holm correction.";
    } else if (useParametric && !sphericityOk) {
      verdictLabel = "Parametric path (GG-corrected)";
      verdictDetail = `Normality holds. Sphericity violated. Using RM-ANOVA with Greenhouse-Geisser correction (&epsilon; = ${formatNumber(ggEpsilon, 3)}) + paired t-tests with Holm correction.`;
    } else {
      verdictLabel = "Non-parametric path";
      verdictDetail = "Normality violated. Using Friedman test + Wilcoxon signed-rank with Holm correction.";
    }
    verdictEl.innerHTML = `
      <div class="${useParametric ? "badgeOk" : "badgeWarn"}" style="padding: 10px 16px; font-size: 1.1em; display: inline-block; margin-bottom: 8px;">${verdictLabel}</div>
      <div class="hint">${verdictDetail}</div>
    `;

    // ── Step 3: WPM analysis ────────────────────────────────────────────────
    renderWpmAnalysis(analysis, wpmMatrix, wpmParticipants, useParametric, sphericityOk, ggEpsilon, statusEl);

    // ── Step 4: NASA-TLX analysis ───────────────────────────────────────────
    renderTlxAnalysis(analysis, statusEl);
  }

  function renderWpmAnalysisInsufficient(n) {
    const omnibusEl = $("wpmOmnibus");
    omnibusEl.innerHTML = `<div class="hint">Not enough complete-case participants (${n}) to run inferential tests.</div>`;
    $("wpmPosthoc").innerHTML = "";
  }

  function renderWpmAnalysis(analysis, wpmMatrix, wpmParticipants, useParametric, sphericityOk, ggEpsilon, statusEl) {
    const omnibusEl = $("wpmOmnibus");
    const posthocEl = $("wpmPosthoc");
    const n = wpmMatrix.length;
    const k = analysis.layouts.length;

    // ── Omnibus test ──
    let omnibusHtml = "";
    if (useParametric) {
      const anova = rmAnova(wpmMatrix);
      if (anova) {
        let df1 = anova.df1;
        let df2 = anova.df2;
        let pValue = anova.p;
        let correctionNote = "";

        if (!sphericityOk) {
          // Apply Greenhouse-Geisser correction
          df1 = anova.df1 * ggEpsilon;
          df2 = anova.df2 * ggEpsilon;
          pValue = window.jStat ? 1 - jStat.centralF.cdf(anova.F, df1, df2) : anova.p;
          correctionNote = ` (Greenhouse-Geisser corrected, &epsilon; = ${formatNumber(ggEpsilon, 3)})`;
        }

        const sig = pValue < 0.05;
        const sigLabel = sig ? "Significant" : "Not significant";
        const sigClass = sig ? "badgeOk" : "badgeWarn";

        omnibusHtml = `
          <div class="studyTitle">Repeated-measures ANOVA${correctionNote}</div>
          <table class="table tableDense" style="margin-top: 6px">
            <thead><tr><th>F</th><th>df1</th><th>df2</th><th>p</th><th>&eta;&sup2;<sub>p</sub></th><th>Result</th></tr></thead>
            <tbody><tr>
              <td>${formatNumber(anova.F, 3)}</td>
              <td>${formatNumber(df1, 2)}</td>
              <td>${formatNumber(df2, 2)}</td>
              <td>${formatNumber(pValue, 4)}</td>
              <td>${formatNumber(anova.eta, 3)}</td>
              <td><span class="${sigClass}">${sigLabel} (p ${sig ? "<" : ">"} 0.05)</span></td>
            </tr></tbody>
          </table>
          <div class="hint" style="margin-top: 4px">n = ${n} participants (complete cases across all ${k} layouts).</div>
        `;
      } else {
        omnibusHtml = `<div class="hint">Could not compute RM-ANOVA.</div>`;
      }
    } else {
      const friedman = friedmanTest(wpmMatrix);
      if (friedman) {
        const sig = friedman.p < 0.05;
        const sigLabel = sig ? "Significant" : "Not significant";
        const sigClass = sig ? "badgeOk" : "badgeWarn";

        omnibusHtml = `
          <div class="studyTitle">Friedman test</div>
          <table class="table tableDense" style="margin-top: 6px">
            <thead><tr><th>&chi;&sup2;</th><th>df</th><th>p</th><th>Kendall's W</th><th>Result</th></tr></thead>
            <tbody><tr>
              <td>${formatNumber(friedman.chi2, 3)}</td>
              <td>${friedman.df}</td>
              <td>${formatNumber(friedman.p, 4)}</td>
              <td>${formatNumber(friedman.w, 3)}</td>
              <td><span class="${sigClass}">${sigLabel} (p ${sig ? "<" : ">"} 0.05)</span></td>
            </tr></tbody>
          </table>
          <div class="hint" style="margin-top: 4px">n = ${n} participants (complete cases across all ${k} layouts).</div>
        `;
      } else {
        omnibusHtml = `<div class="hint">Could not compute Friedman test.</div>`;
      }
    }
    omnibusEl.innerHTML = omnibusHtml;

    // ── Post-hoc pairwise comparisons ──
    let posthocRows;
    let posthocLabel;
    if (useParametric) {
      posthocRows = pairedTTests(wpmMatrix, analysis.layouts);
      posthocLabel = "Paired t-tests with Holm correction";
    } else {
      posthocRows = wilcoxonTests(wpmMatrix, analysis.layouts);
      posthocLabel = "Wilcoxon signed-rank with Holm correction";
    }

    if (posthocRows && posthocRows.length) {
      let posthocHtml = `<div class="hint" style="margin-bottom: 6px">${posthocLabel}</div>`;
      posthocHtml += `<table class="table tableDense">
        <thead><tr><th>Pair</th><th>${useParametric ? "t" : "Z"}</th><th>p (raw)</th><th>p (adjusted)</th><th>Cohen's d</th><th>Result</th></tr></thead><tbody>`;
      posthocRows.forEach((row) => {
        const sig = row.pAdj < 0.05;
        const sigClass = sig ? "badgeOk" : "badgeWarn";
        const sigText = sig ? "Significant" : "Not significant";
        const statValue = useParametric ? row.t : row.z;
        posthocHtml += `<tr>
          <td>${row.pair}</td>
          <td>${formatNumber(statValue, 3)}</td>
          <td>${formatNumber(row.p, 4)}</td>
          <td>${formatNumber(row.pAdj, 4)}</td>
          <td>${formatNumber(row.effect, 3)}</td>
          <td><span class="${sigClass}">${sigText}</span></td>
        </tr>`;
      });
      posthocHtml += "</tbody></table>";
      posthocEl.innerHTML = posthocHtml;
    } else {
      posthocEl.innerHTML = `<div class="hint">No post-hoc comparisons available.</div>`;
    }

    // ── Charts ──
    let canPlot = true;
    if (statusEl) canPlot = ensureLibraries(statusEl);

    if (canPlot) {
      const colorMap = createLayoutColorMap(analysis.layouts);
      plotDistribution("wpm", analysis.layouts, analysis.perLayoutParticipantMeans, colorMap);
      plotMeanCi("wpm", analysis.layouts, analysis.perLayoutParticipantMeans, colorMap);
      plotPaired("wpm", analysis.layouts, wpmMatrix, wpmParticipants, colorMap);
    }
  }

  // ── NASA-TLX analysis ──────────────────────────────────────────────────────

  function getTlxCompleteCaseMatrix(metricKey, tlxParticipantMeans, layouts) {
    const participants = [];
    const matrix = [];
    tlxParticipantMeans.forEach((layoutMap, participantId) => {
      const row = [];
      let ok = true;
      layouts.forEach((layoutId) => {
        const scores = layoutMap.get(layoutId);
        const value = scores ? scores[metricKey] : null;
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

  function plotTlxSubscales(layouts, tlxPerLayoutMeans, colorMap) {
    const el = document.getElementById("chart-tlx-subscales");
    if (!el) return;
    const traces = layouts.map((layoutId) => {
      const bucket = tlxPerLayoutMeans.get(layoutId) || {};
      const means = TLX_FIELDS.map((f) => mean(bucket[f.key] || []) ?? 0);
      const cis = TLX_FIELDS.map((f) => {
        const vals = bucket[f.key] || [];
        const sd = stdev(vals) ?? 0;
        return vals.length > 1 ? (CI_Z * sd) / Math.sqrt(vals.length) : 0;
      });
      return {
        type: "bar",
        name: layoutId,
        x: TLX_FIELDS.map((f) => f.label),
        y: means,
        marker: { color: colorMap.get(layoutId) },
        error_y: { type: "data", array: cis, visible: true },
      };
    });
    const layout = {
      ...plotlyLayoutBase("Subscale means by layout"),
      barmode: "group",
      yaxis: {
        ...plotlyLayoutBase("").yaxis,
        range: [0, 105],
        title: { text: "Score (0-100)" },
      },
    };
    Plotly.react(el, traces, layout);
  }

  function renderTlxAnalysis(analysis, statusEl) {
    const section = $("tlxSection");

    // If no TLX data, hide section entirely
    if (!analysis.tlxParticipantMeans || analysis.tlxParticipantMeans.size === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "block";

    const layouts = analysis.layouts;
    const k = layouts.length;

    // ── 4a: Assumption checks for Overall TLX ──────────────────────────────
    const { participants: tlxParticipants, matrix: tlxMatrix } = getTlxCompleteCaseMatrix(
      "tlxOverall",
      analysis.tlxParticipantMeans,
      layouts
    );

    const verdictEl = $("tlxAssumptionVerdict");
    const shapiroEl = $("tlxShapiroResults");
    const mauchlySection = $("tlxMauchlySection");
    const mauchlyEl = $("tlxMauchlyResults");

    if (tlxParticipants.length < 3) {
      verdictEl.innerHTML = `<div class="badgeWarn" style="padding: 10px; font-size: 1.1em;">Not enough participants with complete TLX data (${tlxParticipants.length}). Need at least 3.</div>`;
      shapiroEl.innerHTML = "";
      mauchlySection.style.display = "none";
      $("tlxOmnibus").innerHTML = `<div class="hint">Not enough participants to run inferential tests.</div>`;
      $("tlxPosthoc").innerHTML = "";
      renderTlxSubscaleAnalysis(analysis, layouts, statusEl);
      return;
    }

    // Shapiro-Wilk on pairwise Overall TLX differences
    const shapiroResults = [];
    let allNormal = true;
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const diffs = tlxMatrix.map((row) => row[a] - row[b]);
        const sw = shapiroWilk(diffs);
        const pass = sw && sw.p > 0.05;
        if (!pass) allNormal = false;
        shapiroResults.push({
          pairLabel: `${layouts[a]} vs ${layouts[b]}`,
          W: sw ? sw.W : null,
          p: sw ? sw.p : null,
          pass,
        });
      }
    }

    const useParametric = allNormal;

    // Render Shapiro-Wilk table
    let shapiroHtml = `<table class="table tableDense">
      <thead><tr><th>Pair (difference)</th><th>W</th><th>p</th><th>Verdict</th></tr></thead><tbody>`;
    shapiroResults.forEach((row) => {
      const verdictClass = row.pass ? "badgeOk" : "badgeWarn";
      const verdictText = row.pass ? "Normal (p > 0.05)" : "Non-normal (p \u2264 0.05)";
      shapiroHtml += `<tr>
        <td>${row.pairLabel}</td>
        <td>${formatNumber(row.W, 4)}</td>
        <td>${formatNumber(row.p, 4)}</td>
        <td><span class="${verdictClass}">${verdictText}</span></td>
      </tr>`;
    });
    shapiroHtml += "</tbody></table>";
    shapiroEl.innerHTML = shapiroHtml;

    // Mauchly's test (only if parametric and k >= 3)
    let sphericityOk = true;
    let ggEpsilon = 1;

    if (useParametric && k >= 3) {
      mauchlySection.style.display = "block";
      const mauchlyResult = mauchlyTest(tlxMatrix);
      if (mauchlyResult) {
        sphericityOk = mauchlyResult.p > 0.05;
        ggEpsilon = mauchlyResult.epsilon;
        const sphClass = sphericityOk ? "badgeOk" : "badgeWarn";
        const sphText = sphericityOk
          ? "Sphericity holds (p > 0.05)"
          : `Sphericity violated (p \u2264 0.05) \u2014 GG \u03B5 = ${formatNumber(ggEpsilon, 3)}`;
        mauchlyEl.innerHTML = `<table class="table tableDense">
          <thead><tr><th>W</th><th>&chi;&sup2;</th><th>df</th><th>p</th><th>GG &epsilon;</th><th>Verdict</th></tr></thead>
          <tbody><tr>
            <td>${formatNumber(mauchlyResult.W, 4)}</td>
            <td>${formatNumber(mauchlyResult.chi2, 3)}</td>
            <td>${mauchlyResult.df}</td>
            <td>${formatNumber(mauchlyResult.p, 4)}</td>
            <td>${formatNumber(mauchlyResult.epsilon, 3)}</td>
            <td><span class="${sphClass}">${sphText}</span></td>
          </tr></tbody>
        </table>`;
      } else {
        mauchlyEl.innerHTML = `<div class="hint">Could not compute Mauchly's test.</div>`;
      }
    } else if (useParametric && k < 3) {
      mauchlySection.style.display = "none";
    } else {
      mauchlySection.style.display = "block";
      mauchlyEl.innerHTML = `<div class="hint">Skipped \u2014 non-parametric path selected (Shapiro-Wilk rejected normality).</div>`;
    }

    // Verdict banner
    let verdictLabel, verdictDetail;
    if (useParametric && sphericityOk) {
      verdictLabel = "Parametric path";
      verdictDetail = "Normality holds. Sphericity holds. Using RM-ANOVA (uncorrected) + paired t-tests with Holm correction.";
    } else if (useParametric && !sphericityOk) {
      verdictLabel = "Parametric path (GG-corrected)";
      verdictDetail = `Normality holds. Sphericity violated. Using RM-ANOVA with Greenhouse-Geisser correction (\u03B5 = ${formatNumber(ggEpsilon, 3)}) + paired t-tests with Holm correction.`;
    } else {
      verdictLabel = "Non-parametric path";
      verdictDetail = "Normality violated. Using Friedman test + Wilcoxon signed-rank with Holm correction.";
    }
    verdictEl.innerHTML = `
      <div class="${useParametric ? "badgeOk" : "badgeWarn"}" style="padding: 10px 16px; font-size: 1.1em; display: inline-block; margin-bottom: 8px;">${verdictLabel}</div>
      <div class="hint">${verdictDetail}</div>
    `;

    // ── 4b: Overall TLX omnibus + post-hoc ──────────────────────────────────
    const omnibusEl = $("tlxOmnibus");
    const posthocEl = $("tlxPosthoc");
    const n = tlxMatrix.length;

    let omnibusHtml = "";
    if (useParametric) {
      const anova = rmAnova(tlxMatrix);
      if (anova) {
        let df1 = anova.df1;
        let df2 = anova.df2;
        let pValue = anova.p;
        let correctionNote = "";
        if (!sphericityOk) {
          df1 = anova.df1 * ggEpsilon;
          df2 = anova.df2 * ggEpsilon;
          pValue = window.jStat ? 1 - jStat.centralF.cdf(anova.F, df1, df2) : anova.p;
          correctionNote = ` (Greenhouse-Geisser corrected, \u03B5 = ${formatNumber(ggEpsilon, 3)})`;
        }
        const sig = pValue < 0.05;
        omnibusHtml = `
          <div class="studyTitle">Repeated-measures ANOVA${correctionNote}</div>
          <table class="table tableDense" style="margin-top: 6px">
            <thead><tr><th>F</th><th>df1</th><th>df2</th><th>p</th><th>&eta;&sup2;<sub>p</sub></th><th>Result</th></tr></thead>
            <tbody><tr>
              <td>${formatNumber(anova.F, 3)}</td>
              <td>${formatNumber(df1, 2)}</td>
              <td>${formatNumber(df2, 2)}</td>
              <td>${formatNumber(pValue, 4)}</td>
              <td>${formatNumber(anova.eta, 3)}</td>
              <td><span class="${sig ? "badgeOk" : "badgeWarn"}">${sig ? "Significant" : "Not significant"} (p ${sig ? "<" : ">"} 0.05)</span></td>
            </tr></tbody>
          </table>
          <div class="hint" style="margin-top: 4px">n = ${n} participants (complete TLX cases across all ${k} layouts).</div>
        `;
      } else {
        omnibusHtml = `<div class="hint">Could not compute RM-ANOVA.</div>`;
      }
    } else {
      const friedman = friedmanTest(tlxMatrix);
      if (friedman) {
        const sig = friedman.p < 0.05;
        omnibusHtml = `
          <div class="studyTitle">Friedman test</div>
          <table class="table tableDense" style="margin-top: 6px">
            <thead><tr><th>&chi;&sup2;</th><th>df</th><th>p</th><th>Kendall's W</th><th>Result</th></tr></thead>
            <tbody><tr>
              <td>${formatNumber(friedman.chi2, 3)}</td>
              <td>${friedman.df}</td>
              <td>${formatNumber(friedman.p, 4)}</td>
              <td>${formatNumber(friedman.w, 3)}</td>
              <td><span class="${sig ? "badgeOk" : "badgeWarn"}">${sig ? "Significant" : "Not significant"} (p ${sig ? "<" : ">"} 0.05)</span></td>
            </tr></tbody>
          </table>
          <div class="hint" style="margin-top: 4px">n = ${n} participants (complete TLX cases across all ${k} layouts).</div>
        `;
      } else {
        omnibusHtml = `<div class="hint">Could not compute Friedman test.</div>`;
      }
    }
    omnibusEl.innerHTML = omnibusHtml;

    // Post-hoc
    let posthocRows;
    let posthocLabel;
    if (useParametric) {
      posthocRows = pairedTTests(tlxMatrix, layouts);
      posthocLabel = "Paired t-tests with Holm correction";
    } else {
      posthocRows = wilcoxonTests(tlxMatrix, layouts);
      posthocLabel = "Wilcoxon signed-rank with Holm correction";
    }

    if (posthocRows && posthocRows.length) {
      let posthocHtml = `<div class="hint" style="margin-bottom: 6px">${posthocLabel}</div>`;
      posthocHtml += `<table class="table tableDense">
        <thead><tr><th>Pair</th><th>${useParametric ? "t" : "Z"}</th><th>p (raw)</th><th>p (adjusted)</th><th>Cohen's d</th><th>Result</th></tr></thead><tbody>`;
      posthocRows.forEach((row) => {
        const sig = row.pAdj < 0.05;
        const statValue = useParametric ? row.t : row.z;
        posthocHtml += `<tr>
          <td>${row.pair}</td>
          <td>${formatNumber(statValue, 3)}</td>
          <td>${formatNumber(row.p, 4)}</td>
          <td>${formatNumber(row.pAdj, 4)}</td>
          <td>${formatNumber(row.effect, 3)}</td>
          <td><span class="${sig ? "badgeOk" : "badgeWarn"}">${sig ? "Significant" : "Not significant"}</span></td>
        </tr>`;
      });
      posthocHtml += "</tbody></table>";
      posthocEl.innerHTML = posthocHtml;
    } else {
      posthocEl.innerHTML = `<div class="hint">No post-hoc comparisons available.</div>`;
    }

    // Overall TLX charts
    let canPlot = true;
    if (statusEl) canPlot = ensureLibraries(statusEl);
    if (canPlot) {
      const colorMap = createLayoutColorMap(layouts);
      plotDistribution("tlxOverall", layouts, analysis.tlxPerLayoutMeans, colorMap);
      plotMeanCi("tlxOverall", layouts, analysis.tlxPerLayoutMeans, colorMap);
      plotPaired("tlxOverall", layouts, tlxMatrix, tlxParticipants, colorMap);
    }

    // ── 4c: Subscale analysis ───────────────────────────────────────────────
    renderTlxSubscaleAnalysis(analysis, layouts, statusEl);
  }

  function renderTlxSubscaleAnalysis(analysis, layouts, statusEl) {
    const summaryEl = $("tlxSubscaleSummary");
    const testsEl = $("tlxSubscaleTests");
    const k = layouts.length;

    if (!analysis.tlxParticipantMeans || analysis.tlxParticipantMeans.size === 0) {
      summaryEl.innerHTML = "";
      testsEl.innerHTML = "";
      return;
    }

    // Descriptive summary table
    let summaryHtml = `<table class="table tableDense" style="margin-top: 10px">
      <thead><tr><th>Subscale</th>`;
    layouts.forEach((id) => { summaryHtml += `<th>${id} (M \u00B1 SD)</th>`; });
    summaryHtml += `</tr></thead><tbody>`;

    TLX_FIELDS.forEach((field) => {
      summaryHtml += `<tr><td>${field.label}</td>`;
      layouts.forEach((layoutId) => {
        const bucket = analysis.tlxPerLayoutMeans.get(layoutId);
        const vals = bucket ? bucket[field.key] || [] : [];
        const m = mean(vals) ?? 0;
        const sd = stdev(vals) ?? 0;
        summaryHtml += `<td>${formatNumber(m, 1)} \u00B1 ${formatNumber(sd, 1)}</td>`;
      });
      summaryHtml += `</tr>`;
    });
    summaryHtml += `</tbody></table>`;
    summaryEl.innerHTML = summaryHtml;

    // Friedman + Wilcoxon for each subscale
    let testsHtml = `<div style="margin-top: 16px">`;

    TLX_FIELDS.forEach((field) => {
      const { participants, matrix } = getTlxCompleteCaseMatrix(field.key, analysis.tlxParticipantMeans, layouts);
      const n = participants.length;

      testsHtml += `<div class="studyTitle" style="margin-top: 14px">${field.label}</div>`;

      if (n < 3) {
        testsHtml += `<div class="hint">Not enough complete cases (${n}) for ${field.label}.</div>`;
        return;
      }

      // Friedman omnibus
    const friedman = friedmanTest(matrix);
      if (friedman) {
        const sig = friedman.p < 0.05;
        testsHtml += `<table class="table tableDense" style="margin-top: 4px">
          <thead><tr><th>Test</th><th>&chi;&sup2;</th><th>df</th><th>p</th><th>W</th><th>Result</th></tr></thead>
          <tbody><tr>
            <td>Friedman</td>
            <td>${formatNumber(friedman.chi2, 3)}</td>
            <td>${friedman.df}</td>
            <td>${formatNumber(friedman.p, 4)}</td>
            <td>${formatNumber(friedman.w, 3)}</td>
            <td><span class="${sig ? "badgeOk" : "badgeWarn"}">${sig ? "Significant" : "Not significant"}</span></td>
          </tr></tbody>
        </table>`;
      } else {
        testsHtml += `<div class="hint">Could not compute Friedman test.</div>`;
      }

      // Wilcoxon post-hoc
      const posthocRows = wilcoxonTests(matrix, layouts);
      if (posthocRows && posthocRows.length) {
        testsHtml += `<table class="table tableDense" style="margin-top: 4px">
          <thead><tr><th>Pair</th><th>Z</th><th>p (raw)</th><th>p (adj)</th><th>Cohen's d</th><th>Result</th></tr></thead><tbody>`;
        posthocRows.forEach((row) => {
          const sig = row.pAdj < 0.05;
          testsHtml += `<tr>
            <td>${row.pair}</td>
            <td>${formatNumber(row.z, 3)}</td>
            <td>${formatNumber(row.p, 4)}</td>
            <td>${formatNumber(row.pAdj, 4)}</td>
            <td>${formatNumber(row.effect, 3)}</td>
            <td><span class="${sig ? "badgeOk" : "badgeWarn"}">${sig ? "Sig." : "n.s."}</span></td>
          </tr>`;
        });
        testsHtml += `</tbody></table>`;
      }

      testsHtml += `<div class="hint" style="margin-top: 2px">n = ${n} (Wilcoxon signed-rank, Holm correction)</div>`;
    });

    testsHtml += `</div>`;
    testsEl.innerHTML = testsHtml;

    // Subscale grouped bar chart
    let canPlot = true;
    if (statusEl) canPlot = ensureLibraries(statusEl);
    if (canPlot) {
      const colorMap = createLayoutColorMap(layouts);
      plotTlxSubscales(layouts, analysis.tlxPerLayoutMeans, colorMap);
    }
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
      "1. WPM distribution (violin/box).",
      "2. WPM mean ± 95% CI.",
      "3. WPM paired lines (within-subject).",
      "",
    ];
    return lines.join("\n");
  }

  function buildReportSnippet(analysis) {
    const layoutWpms = (analysis.summary.layouts || []).map((r) => ({
      id: r.layoutId,
      wpm: r.meanWpm,
    }));
    const best = layoutWpms.length
      ? layoutWpms.reduce((a, b) => (b.wpm > a.wpm ? b : a))
      : null;
    const bestWpm = best ? `${best.id} (${best.wpm.toFixed(2)} WPM)` : "n/a";
    return `## Study results summary

- Participants: ${analysis.summary.participantCount}
- Layouts: ${analysis.summary.layoutCount}
- Best WPM: ${bestWpm}
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
    if (!ensureLibraries(statusEl)) return;
    if (!ensureAppsScriptUrl(statusEl)) return;
    const thresholds = { ...FIXED_THRESHOLDS };
    statusEl.textContent = "Fetching participant sheets...";
    try {
      const { rows: rawRows, warnings: fetchWarnings, tlxRows } = await fetchAllParticipantRows(statusEl);
      if (!rawRows.length) {
        statusEl.textContent = "No rows found in participant sheets.";
        return;
      }
      const rows = deriveColumns(rawRows);
      lastRows = rows;
      const rawTlxRows = Array.isArray(tlxRows) ? tlxRows : [];
      lastTlxRows = normalizeTlxRows(rawTlxRows, rows);
      lastThresholds = thresholds;
      const participantIds = listParticipants(rows);
      const savedFilter = loadParticipantFilter();
      const selectedSet = normalizeParticipantSelection(savedFilter, participantIds);
      saveParticipantFilter(Array.from(selectedSet));
      renderParticipantFilter(participantIds, selectedSet, statusEl);
      const filteredRows = applyParticipantFilter(rows, selectedSet);
      const filteredTlxRows = applyParticipantFilter(lastTlxRows, selectedSet);
      const analysis = computeAnalysisData(filteredRows, thresholds, filteredTlxRows);
      if (fetchWarnings.length) {
        analysis.summary.warnings = mergeWarnings(analysis.summary.warnings || [], fetchWarnings);
      }
      renderAnalysisFlow(analysis, thresholds, statusEl);

      statusEl.textContent = "Analysis updated.";
    } catch (err) {
      statusEl.textContent = `Fetch failed: ${err instanceof Error ? err.message : err}`;
    }
  }

  function init() {
    const thresholds = { ...FIXED_THRESHOLDS };
    renderParticipantFilter([], new Set(), $("analysisStatus"));

    $("analysisFetchBtn").addEventListener("click", fetchAndAnalyze);
    fetchAndAnalyze();
    $("downloadSummaryBtn").addEventListener("click", () => {
      const analysis = getAnalysisForDownload(thresholds, $("analysisStatus"));
      if (!analysis) return;
      const layouts = analysis.summary.layouts || [];
      const header =
        "layoutId,trials,meanWpm,meanEditDistance,meanErrorRate,meanElapsedSeconds,meanBackspaceCount";
      const lines = layouts.map(
        (r) =>
          `${r.layoutId},${r.trials},${r.meanWpm.toFixed(2)},${r.meanEd.toFixed(2)},${r.meanErr.toFixed(
            3
          )},${r.meanElapsed.toFixed(2)},${r.meanBackspace.toFixed(2)}`
      );
      downloadFile("analysis_summary.csv", [header, ...lines].join("\n"));
    });

    $("downloadReportSnippetBtn").addEventListener("click", () => {
      const analysis = getAnalysisForDownload(thresholds, $("analysisStatus"));
      if (!analysis) return;
      const snippet = buildReportSnippet(analysis);
      downloadFile("report_snippet.md", snippet);
    });

    $("downloadResultsTablesBtn").addEventListener("click", () => {
      const analysis = getAnalysisForDownload(thresholds, $("analysisStatus"));
      if (!analysis) return;
      downloadFile("analysis_results_tables.csv", buildResultsTablesCsv(analysis));
    });

    $("downloadFiguresListBtn").addEventListener("click", () => {
      downloadFile("analysis_figures_list.md", buildFiguresListMarkdown());
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();
