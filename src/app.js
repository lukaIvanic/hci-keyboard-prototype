(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const DISTANCE_MODE_STORAGE_KEY = "KbdStudy.distanceMode.v1";
  const DEFAULT_PRACTICE_TRIALS = 2;
  const DEFAULT_TRIALS_PER_LAYOUT = 8;
  const DEV_SKIP_LEARNING = false;
  const DEV_SHOW_SKIP_PHASE = true;
  const GOOGLE_SHEETS_WEB_APP_URL =
    "https://script.google.com/macros/s/AKfycbyeNsTI5KyoY3Y3zbRKCuAohHnIsMfKMLdJJy9lBXb2k7Chvo9hRAXC2kKqDsSDSYSqVA/exec";
  const AUTO_SHEETS_UPLOAD = true;

  const PHRASES = [
    "the quick brown fox",
    "human computer interaction",
    "a simple keyboard prototype",
    "typing on a screen keyboard",
    "we measure speed and errors",
    "practice makes perfect",
    "data is logged for analysis",
    "edit distance counts mistakes",
    "web based experiments are handy",
    "layouts can be generated later",
  ];

  const LEARNING_ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");
  const LEARNING_BIGRAMS = ["th", "he", "in", "er", "an", "re", "on", "at", "en", "nd", "ti", "es"];
  const LEARNING_WORDS = ["the", "and", "for", "you", "not", "with"];
  const LEARNING_KIND_LABELS = {
    "alpha-forward": "Alphabet (forward)",
    "alpha-shuffled": "Alphabet (shuffled)",
    bigram: "Bigrams",
    word: "Short words",
  };

  const CSV_COLUMNS = [
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

  const DETAIL_COLUMNS = [
    "sessionId",
    "participantId",
    "trialId",
    "trialType",
    "layoutName",
    "layoutIndex",
    "trialIndex",
    "eventIndex",
    "key",
    "keyType",
    "timestampMs",
  ];

  const EXPERIMENT_LAYOUT_IDS = ["clancy_custom", "fits_or_something", "fake_qwerty"];

  const TLX_FIELDS = [
    { key: "tlxMental", label: "Mental demand" },
    { key: "tlxPhysical", label: "Physical demand" },
    { key: "tlxTemporal", label: "Temporal demand" },
    { key: "tlxPerformance", label: "Performance" },
    { key: "tlxEffort", label: "Effort" },
    { key: "tlxFrustration", label: "Frustration" },
  ];

  const state = {
    nextTrialId: 1,
    phraseIndex: 0,
    layoutId: "qwerty",
    typed: "",
    currentTrial: null,
    session: ns.logger.createSession(),
    sessionMeta: null,
  };

  const experiment = {
    running: false,
    layoutOrder: [],
    layoutIndex: 0,
    trialInLayout: 0,
    practiceRemaining: 0,
    currentTrialIsPractice: false,
    practiceTrials: DEFAULT_PRACTICE_TRIALS,
    trialsPerLayout: DEFAULT_TRIALS_PER_LAYOUT,
    orderMode: "random",
    orderSeed: "",
    completed: false,
    awaitingPracticeChoice: false,
    awaitingTlx: false,
    learningActive: false,
    learningQueue: [],
    learningIndex: 0,
  };

  let distanceMode = { useCenter: true, useEdge: true };
  let sheetUploadInFlight = false;
  let sheetUploadQueued = false;
  let lastUploadedIndex = 0;

  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el;
  }

  function setText(el, text) {
    el.textContent = text;
  }

  function setPhaseAttributes(phase, running) {
    document.body.dataset.phase = phase;
    document.body.dataset.sessionRunning = running ? "true" : "false";
  }

  function setControlTrayOpen(open) {
    const tray = document.getElementById("experimentControlTray");
    if (tray) tray.open = !!open;
  }

  function setTypingStatus(message, state) {
    const statusEl = document.getElementById("typingStatus");
    if (statusEl) statusEl.textContent = message ?? "";
    const taskFocus = document.getElementById("taskFocus");
    if (taskFocus) taskFocus.dataset.typingState = state ?? "";
  }

  function setSubmitReady(flag) {
    const submitBtn = document.getElementById("submitTrialBtn");
    if (!submitBtn) return;
    submitBtn.classList.toggle("submitReady", !!flag);
  }

  function showToast(message) {
    const region = document.getElementById("toastRegion");
    if (!region || !message) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    region.appendChild(toast);
    const toasts = region.querySelectorAll(".toast");
    if (toasts.length > 3) {
      region.removeChild(toasts[0]);
    }
    setTimeout(() => toast.classList.add("toastFade"), 1600);
    setTimeout(() => toast.remove(), 2200);
  }

  function setSheetStatus(message) {
    const el = $("sheetStatus");
    el.textContent = message ?? "";
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
      return normalizeDistanceMode(JSON.parse(raw));
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

  function createSessionId() {
    const rand = Math.floor(Math.random() * 1e6);
    return `session_${Date.now()}_${rand}`;
  }

  function createEmptyTlx() {
    const tlx = {};
    TLX_FIELDS.forEach((field) => {
      tlx[field.key] = null;
    });
    return tlx;
  }

  function createSessionMeta() {
    return {
      sessionId: createSessionId(),
      participantId: "",
      condition: "",
      orderMode: "random",
      orderSeed: "",
      layoutOrder: [],
      practiceTrials: DEFAULT_PRACTICE_TRIALS,
      trialsPerLayout: DEFAULT_TRIALS_PER_LAYOUT,
      startedAtMs: null,
      endedAtMs: null,
      tlxByLayout: {},
    };
  }

  function hashStringToSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), t | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(items, seedText) {
    const out = items.slice();
    const seed = hashStringToSeed(String(seedText ?? ""));
    const rand = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function shuffleArray(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function resolveLayoutOrder(orderMode, seedText) {
    const layouts = ns.layouts.getAllLayouts();
    const allowed = layouts.filter((l) => EXPERIMENT_LAYOUT_IDS.includes(l.id)).map((l) => l.id);
    if (allowed.length !== EXPERIMENT_LAYOUT_IDS.length) {
      const missing = EXPERIMENT_LAYOUT_IDS.filter((id) => !allowed.includes(id));
      if (missing.length) {
        console.warn(`Missing experiment layouts: ${missing.join(", ")}`);
      }
    }
    const base = allowed.length ? allowed : layouts.map((l) => l.id);
    const mode = String(orderMode || "").toLowerCase();
    if (mode === "random") {
      return shuffleArray(base);
    }
    if (mode === "seeded" && seedText) {
      return seededShuffle(base, seedText);
    }
    return base;
  }

  function readExperimentSettings() {
    const participantId = String($("experimentParticipantId").value ?? "").trim();
    const condition = "";
    const orderMode = "random";
    const orderSeed = "";
    const practiceTrials = DEFAULT_PRACTICE_TRIALS;
    const trialsPerLayout = DEFAULT_TRIALS_PER_LAYOUT;

    return { participantId, condition, orderMode, orderSeed, practiceTrials, trialsPerLayout };
  }

  function buildLearningQueue() {
    const queue = [];
    const alphabet = LEARNING_ALPHABET.join("");
    queue.push({ kind: "alpha-forward", target: alphabet, highlight: false, index: 1, total: 1 });
    const shuffled = shuffleArray(LEARNING_ALPHABET).join("");
    queue.push({ kind: "alpha-shuffled", target: shuffled, highlight: false, index: 1, total: 1 });
    LEARNING_BIGRAMS.forEach((pair, idx) => {
      queue.push({ kind: "bigram", target: pair, highlight: false, index: idx + 1, total: LEARNING_BIGRAMS.length });
    });
    LEARNING_WORDS.forEach((word, idx) => {
      queue.push({ kind: "word", target: word, highlight: false, index: idx + 1, total: LEARNING_WORDS.length });
    });
    return queue;
  }

  function isLearningPhase() {
    return experiment.learningActive && experiment.learningIndex < experiment.learningQueue.length;
  }

  function currentLearningItem() {
    return isLearningPhase() ? experiment.learningQueue[experiment.learningIndex] : null;
  }

  function learningLabel(item) {
    if (!item) return "Learning";
    const base = LEARNING_KIND_LABELS[item.kind] || "Learning";
    return `${base} ${item.index}/${item.total}`;
  }

  function startLearningForLayout() {
    if (DEV_SKIP_LEARNING) {
      experiment.learningActive = false;
      experiment.learningQueue = [];
      experiment.learningIndex = 0;
      resetPracticeForLayout();
      return;
    }
    experiment.learningQueue = buildLearningQueue();
    experiment.learningIndex = 0;
    experiment.learningActive = experiment.learningQueue.length > 0;
    experiment.currentTrialIsPractice = false;
    experiment.practiceRemaining = 0;
  }

  function completeLearningPhase() {
    experiment.learningActive = false;
    experiment.learningQueue = [];
    experiment.learningIndex = 0;
    resetPracticeForLayout();
  }

  function currentTargetPhrase() {
    const learningItem = currentLearningItem();
    if (learningItem) return learningItem.target;
    return PHRASES[state.phraseIndex % PHRASES.length];
  }

  function currentPhraseId() {
    const learningItem = currentLearningItem();
    if (learningItem) return `learning-${learningItem.kind}-${experiment.learningIndex + 1}`;
    return state.phraseIndex % PHRASES.length;
  }

  function currentLayout() {
    return ns.layouts.getLayoutById(state.layoutId);
  }

  function currentLayoutLabel() {
    const layout = currentLayout();
    if (!layout) return state.layoutId;
    return `${layout.name} (${layout.id})`;
  }

  function currentTrialType() {
    if (isLearningPhase()) return "learning";
    if (!experiment.running) return "free";
    return experiment.currentTrialIsPractice ? "practice" : "main";
  }

  function currentLearningKind() {
    const item = currentLearningItem();
    return item ? item.kind : "";
  }

  function computeTargetProgress(target, typed) {
    const targetNorm = String(target ?? "").toLowerCase();
    const typedNorm = String(typed ?? "").toLowerCase();
    const minLen = Math.min(targetNorm.length, typedNorm.length);
    let mismatchIndex = -1;
    for (let i = 0; i < minLen; i++) {
      if (targetNorm[i] !== typedNorm[i]) {
        mismatchIndex = i;
        break;
      }
    }
    if (mismatchIndex === -1 && typedNorm.length > targetNorm.length) {
      mismatchIndex = targetNorm.length;
    }
    const correctPrefixLen = mismatchIndex === -1 ? minLen : mismatchIndex;
    return { correctPrefixLen, mismatchIndex };
  }

  function newTrialLog() {
    const trial = ns.logger.createTrialLog({
      trialId: state.nextTrialId,
      layoutId: state.layoutId,
      phraseId: currentPhraseId(),
      target: currentTargetPhrase(),
    });
    trial.trialType = currentTrialType();
    trial.learningKind = currentLearningKind();
    return trial;
  }

  function resetTrial() {
    state.typed = "";
    state.currentTrial = newTrialLog();
    renderTyped();
    const status = isLearningPhase() ? "Learning phase." : "Ready to type.";
    setTypingStatus(status, "ready");
  }

  function nextPhrase() {
    state.phraseIndex = (state.phraseIndex + 1) % PHRASES.length;
    renderTarget();
    resetTrial();
  }

  function renderTarget() {
    const targetEl = $("targetPhrase");
    const target = currentTargetPhrase();
    const typed = state.typed || "";
    const progress = computeTargetProgress(target, typed);
    const correctPrefixLen = progress.correctPrefixLen;
    const mismatchIndex = progress.mismatchIndex;

    targetEl.innerHTML = "";
    for (let i = 0; i < target.length; i++) {
      const span = document.createElement("span");
      span.className = "targetChar";
      if (i < correctPrefixLen) {
        span.classList.add("targetCharDone");
      } else if (mismatchIndex !== -1 && i === mismatchIndex && mismatchIndex < target.length) {
        span.classList.add("targetCharError");
      } else if (mismatchIndex === -1 && i === correctPrefixLen && correctPrefixLen < target.length) {
        span.classList.add("targetCharCurrent");
      }
      const ch = target[i];
      span.textContent = ch === " " ? "\u00A0" : ch;
      targetEl.appendChild(span);
    }
  }

  function renderTyped() {
    setText($("typedText"), state.typed);
  }

  function handleLearningKeyPress(key) {
    if (tlxModalOpen || experiment.awaitingTlx) return;
    if (!state.currentTrial) state.currentTrial = newTrialLog();

    state.currentTrial.logKey(key.id, key.type);

    if (key.type === "char") {
      state.typed += key.id;
    } else if (key.type === "space") {
      state.typed += " ";
    } else if (key.type === "backspace") {
      state.typed = state.typed.slice(0, -1);
    }

    const target = currentTargetPhrase();
    const typedNorm = state.typed.toLowerCase();
    const targetNorm = String(target ?? "").toLowerCase();
    if (targetNorm.length === 1 && typedNorm.length > 1) {
      state.typed = state.typed.slice(-1);
    }
    const typingActive = state.typed.length > 0;
    setTypingStatus(typingActive ? "Learning..." : "Learning phase.", typingActive ? "typing" : "ready");
    renderTyped();
    renderTarget();

    if (state.typed.toLowerCase() === targetNorm) {
      submitLearningTrial();
    }
  }

  function handleKeyPress(key) {
    if (tlxModalOpen || experiment.awaitingTlx) return;
    if (isLearningPhase()) {
      handleLearningKeyPress(key);
      return;
    }
    if (!state.currentTrial) state.currentTrial = newTrialLog();

    // Log event first (so backspace presses are captured even if typed is empty).
    state.currentTrial.logKey(key.id, key.type);

    if (key.type === "char") {
      state.typed += key.id;
    } else if (key.type === "space") {
      state.typed += " ";
    } else if (key.type === "enter") {
      submitTrial();
      return;
    } else if (key.type === "backspace") {
      state.typed = state.typed.slice(0, -1);
    }

    const typingActive = state.typed.length > 0;
    setTypingStatus(typingActive ? "Typing..." : "Ready to type.", typingActive ? "typing" : "ready");
    renderTyped();
    renderTarget();
  }

  function handleKeyMiss() {
    const trial = state.currentTrial;
    if (!trial || trial.startTimeMs == null) return;
    trial.logKey("", "miss");
  }

  function formatSeconds(ms) {
    return ns.metrics.roundTo(ms / 1000, 2);
  }

  function computeTlxOverall(tlx) {
    const values = TLX_FIELDS.map((field) => tlx[field.key]).filter(Number.isFinite);
    if (values.length !== TLX_FIELDS.length) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  function currentLayoutName() {
    const layout = currentLayout();
    if (layout && layout.name) return layout.name;
    return state.layoutId;
  }

  function layoutNameForId(layoutId) {
    const layout = ns.layouts.getLayoutById(layoutId);
    if (layout && layout.name) return layout.name;
    return layoutId ?? "";
  }

  function buildTlxSheetPayload(values) {
    const meta = state.sessionMeta || createSessionMeta();
    const columns = [
      "sessionId",
      "participantId",
      "layoutName",
      "layoutIndex",
      "tlxMental",
      "tlxPhysical",
      "tlxTemporal",
      "tlxPerformance",
      "tlxEffort",
      "tlxFrustration",
    ];
    const layoutIndex = experiment.layoutIndex + 1;
    const row = {
      sessionId: meta.sessionId ?? "",
      participantId: meta.participantId ?? "",
      layoutName: currentLayoutName(),
      layoutIndex,
      tlxMental: values.tlxMental ?? "",
      tlxPhysical: values.tlxPhysical ?? "",
      tlxTemporal: values.tlxTemporal ?? "",
      tlxPerformance: values.tlxPerformance ?? "",
      tlxEffort: values.tlxEffort ?? "",
      tlxFrustration: values.tlxFrustration ?? "",
    };
    return {
      kind: "tlx",
      sheet: "TLX",
      exportedAtMs: Date.now(),
      session: meta,
      columns,
      rows: [columns.map((col) => row[col])],
    };
  }

  async function sendTlxToGoogleSheets(values) {
    const url = String(GOOGLE_SHEETS_WEB_APP_URL || "").trim();
    if (!url) {
      return false;
    }
    const payload = buildTlxSheetPayload(values);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        return true;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  function ensureTlxByLayout(meta) {
    if (!meta.tlxByLayout || typeof meta.tlxByLayout !== "object") {
      meta.tlxByLayout = {};
    }
    return meta.tlxByLayout;
  }

  function getTlxForLayout(layoutId) {
    if (!layoutId) return null;
    const meta = state.sessionMeta;
    if (!meta) return null;
    const map = ensureTlxByLayout(meta);
    return map[layoutId] || null;
  }

  function resetTlxInputs() {
    TLX_FIELDS.forEach((field) => {
      const input = document.getElementById(field.key);
      const output = document.getElementById(`${field.key}Value`);
      if (input) {
        input.value = "50";
        input.dataset.touched = "false";
        input.classList.add("tlxSliderUntouched");
      }
      if (output) {
        output.textContent = "—";
        output.classList.add("tlxValueEmpty");
      }
    });
  }

  function fillTlxInputs(values) {
    TLX_FIELDS.forEach((field) => {
      const input = document.getElementById(field.key);
      const output = document.getElementById(`${field.key}Value`);
      const raw = values?.[field.key];
      const nextValue = Number.isFinite(raw) ? String(raw) : "50";
      if (input) {
        input.value = nextValue;
        input.dataset.touched = "true";
        input.classList.remove("tlxSliderUntouched");
      }
      if (output) {
        output.textContent = nextValue;
        output.classList.remove("tlxValueEmpty");
      }
    });
  }

  function allTlxSelected() {
    return TLX_FIELDS.every((field) => {
      const input = document.getElementById(field.key);
      return input && input.dataset.touched === "true";
    });
  }

  function readTlxInputs() {
    const values = {};
    let ok = true;
    TLX_FIELDS.forEach((field) => {
      const input = document.getElementById(field.key);
      const raw = input ? Number.parseFloat(input.value) : Number.NaN;
      if (!Number.isFinite(raw)) ok = false;
      values[field.key] = Number.isFinite(raw) ? raw : null;
    });
    if (!allTlxSelected()) ok = false;
    return { values, ok };
  }

  function setTlxSaved(values, layoutId) {
    if (!layoutId) return;
    const meta = state.sessionMeta || createSessionMeta();
    const map = ensureTlxByLayout(meta);
    map[layoutId] = {
      values,
      overall: computeTlxOverall(values),
      savedAtMs: Date.now(),
    };
    state.sessionMeta = meta;
  }

  function clearTlxSaved(layoutId) {
    const meta = state.sessionMeta || createSessionMeta();
    const map = ensureTlxByLayout(meta);
    if (layoutId && map[layoutId]) {
      delete map[layoutId];
    }
    state.sessionMeta = meta;
  }

  function updateTlxStatus() {
    const statusEl = document.getElementById("tlxStatus");
    if (!statusEl) return;
    statusEl.textContent = "";
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Font testing controls (dev)
  // ────────────────────────────────────────────────────────────────────────────

  const FONT_STORAGE_KEY = "kbdFontSettings";

  function loadFontSettings() {
    try {
      const saved = localStorage.getItem(FONT_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      /* ignore */
    }
    return { family: "Inter", weight: "700", uppercase: true };
  }

  function saveFontSettings(settings) {
    try {
      localStorage.setItem(FONT_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      /* ignore */
    }
  }

  function applyFontSettings(settings) {
    const root = document.documentElement;
    root.style.setProperty("--kbd-font-family", settings.family === "inherit" ? "inherit" : `"${settings.family}"`);
    root.style.setProperty("--kbd-font-weight", settings.weight);
    root.style.setProperty("--kbd-char-transform", settings.uppercase ? "uppercase" : "lowercase");
  }

  function initFontControls() {
    const fontSelect = document.getElementById("kbdFontSelect");
    const weightSelect = document.getElementById("kbdWeightSelect");
    const uppercaseToggle = document.getElementById("kbdUppercaseToggle");

    if (!fontSelect || !weightSelect || !uppercaseToggle) return;

    // Load saved settings
    const settings = loadFontSettings();

    // Set initial values
    fontSelect.value = settings.family;
    weightSelect.value = settings.weight;
    uppercaseToggle.checked = settings.uppercase;

    // Apply on load
    applyFontSettings(settings);

    // Update on change
    const handleChange = () => {
      const newSettings = {
        family: fontSelect.value,
        weight: weightSelect.value,
        uppercase: uppercaseToggle.checked,
      };
      applyFontSettings(newSettings);
      saveFontSettings(newSettings);
    };

    fontSelect.addEventListener("change", handleChange);
    weightSelect.addEventListener("change", handleChange);
    uppercaseToggle.addEventListener("change", handleChange);
  }

  function initTlx() {
    const panel = document.getElementById("tlxPanel");
    if (!panel) return;
    TLX_FIELDS.forEach((field) => {
      const input = document.getElementById(field.key);
      const output = document.getElementById(`${field.key}Value`);
      if (!input) return;
      const update = () => {
        input.dataset.touched = "true";
        input.classList.remove("tlxSliderUntouched");
        if (output) {
          output.textContent = String(input.value);
          output.classList.remove("tlxValueEmpty");
        }
        const saveBtn = document.getElementById("tlxSaveBtn");
        if (saveBtn) saveBtn.disabled = !allTlxSelected();
      };
      input.addEventListener("input", update);
    });
    const saveBtn = document.getElementById("tlxSaveBtn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.addEventListener("click", () => {
        const layoutId = tlxLayoutIdPending;
        if (!layoutId) return;
        const { values, ok } = readTlxInputs();
        if (!ok) {
          const statusEl = document.getElementById("tlxStatus");
          if (statusEl) statusEl.textContent = "Please rate all six dimensions.";
          return;
        }
        setTlxSaved(values, layoutId);
        updateTlxStatus();
        sendTlxToGoogleSheets(values);
        closeTlxModal();
        completeLayoutAfterTlx();
      });
    }
    const clearBtn = document.getElementById("tlxClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const layoutId = tlxLayoutIdPending;
        resetTlxInputs();
        if (layoutId) clearTlxSaved(layoutId);
        updateTlxStatus();
        const saveBtn = document.getElementById("tlxSaveBtn");
        if (saveBtn) saveBtn.disabled = true;
      });
    }
    updateTlxStatus();
  }

  function completeTrial({ advancePhrase = true, advanceExperiment = true, showSummary = true } = {}) {
    if (wizardModalOpen || tlxModalOpen || experiment.awaitingTlx) return;
    if (experiment.running && experiment.awaitingPracticeChoice) return;
    const trial = state.currentTrial;
    if (!trial) return;
    const didFinish = trial.finish(state.typed);
    if (!didFinish) return;

    const charCount = state.typed.length;
    const wpm = ns.metrics.computeWpm(charCount, trial.elapsedMs);
    const ed = ns.metrics.editDistance(trial.target, state.typed);

    trial.charCount = charCount;
    trial.wpm = wpm;
    trial.editDistance = ed;

    const meta = state.sessionMeta || createSessionMeta();
    trial.sessionId = meta.sessionId ?? "";
    trial.participantId = meta.participantId ?? "";
    trial.condition = meta.condition ?? "";
    trial.orderMode = meta.orderMode ?? "";
    trial.orderSeed = meta.orderSeed ?? "";
    trial.layoutOrder = Array.isArray(meta.layoutOrder) ? meta.layoutOrder.join("|") : "";

    if (experiment.running) {
      trial.isPractice = experiment.currentTrialIsPractice;
      trial.layoutIndex = experiment.layoutIndex + 1;
      trial.trialIndex = experiment.currentTrialIsPractice ? 0 : experiment.trialInLayout + 1;
    } else {
      trial.isPractice = false;
      trial.layoutIndex = 0;
      trial.trialIndex = 0;
    }

    state.session.addTrial(trial);
    appendResultRow(trial);
    queueAutoSheetsUpload();
    sendDetailsToGoogleSheets(trial);
    if (showSummary) {
      showToast(`Submitted • WPM ${ns.metrics.roundTo(wpm, 1)} • ED ${ed ?? 0}`);
    }

    state.nextTrialId += 1;
    if (advancePhrase) nextPhrase();
    if (advanceExperiment) advanceExperimentAfterSubmit();
  }

  function submitLearningTrial() {
    completeTrial({ advancePhrase: false, advanceExperiment: false, showSummary: false });
    advanceLearningAfterSubmit();
  }

  function submitTrial() {
    if (isLearningPhase()) return;
    completeTrial({ advancePhrase: true, advanceExperiment: experiment.running, showSummary: true });
  }

  function trialToRow(trial) {
    return {
      sessionId: trial.sessionId ?? "",
      participantId: trial.participantId ?? "",
      trialId: trial.trialId,
      layoutId: trial.layoutId,
      trialType: trial.trialType ?? "",
      learningKind: trial.learningKind ?? "",
      target: trial.target,
      typed: trial.typed,
      startTimeMs: trial.startTimeMs,
      endTimeMs: trial.endTimeMs,
      elapsedMs: Math.round(trial.elapsedMs ?? 0),
      backspaceCount: trial.backspaceCount ?? 0,
      keypressCount: trial.keypressCount ?? (trial.events ? trial.events.length : 0),
    };
  }

  function appendResultRow(trial) {
    const tbody = $("resultsTableBody");
    const tr = document.createElement("tr");

    const cells = [
      trial.trialId,
      trial.layoutId,
      trial.phraseId,
      trial.isPractice ? "yes" : "no",
      ns.metrics.roundTo(trial.wpm ?? 0, 2),
      trial.editDistance ?? "",
      trial.backspaceCount ?? 0,
      formatSeconds(trial.elapsedMs ?? 0),
    ];

    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = String(c);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  function clearResults() {
    state.session.clear();
    $("resultsTableBody").innerHTML = "";
    sheetUploadInFlight = false;
    sheetUploadQueued = false;
    lastUploadedIndex = 0;
  }

  function downloadCsv() {
    const rows = state.session.trials.map(trialToRow);
    const filename = `keyboard_trials_${Date.now()}.csv`;
    ns.exporting.downloadCsv(filename, rows, CSV_COLUMNS);
  }

  function downloadJson() {
    const meta = state.sessionMeta || createSessionMeta();
    const session = {
      sessionId: meta.sessionId ?? "",
      participantId: meta.participantId ?? "",
      condition: meta.condition ?? "",
      orderMode: meta.orderMode ?? "",
      orderSeed: meta.orderSeed ?? "",
      layoutOrder: Array.isArray(meta.layoutOrder) ? meta.layoutOrder.slice() : [],
      practiceTrials: meta.practiceTrials ?? DEFAULT_PRACTICE_TRIALS,
      trialsPerLayout: meta.trialsPerLayout ?? DEFAULT_TRIALS_PER_LAYOUT,
      startedAtMs: meta.startedAtMs ?? null,
      endedAtMs: meta.endedAtMs ?? null,
      tlxByLayout: meta.tlxByLayout ?? {},
      environment: {
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
    };
    const raw = {
      exportedAtMs: Date.now(),
      session,
      phrases: PHRASES.slice(),
      trials: state.session.trials.map((t) => ({
        ...trialToRow(t),
        events: t.events,
      })),
    };
    const filename = `keyboard_trials_${Date.now()}.json`;
    ns.exporting.downloadJson(filename, raw);
  }

  function buildSheetPayload(trials = state.session.trials) {
    const rows = trials.map(trialToRow);
    const columns = CSV_COLUMNS.slice();
    return {
      exportedAtMs: Date.now(),
      session: state.sessionMeta || createSessionMeta(),
      columns,
      rows: rows.map((row) => columns.map((col) => row[col])),
    };
  }

  function buildDetailRows(trial) {
    if (!trial || !Array.isArray(trial.events) || !trial.events.length) return [];
    const timestampBase = trial.startTimeMs ?? null;
    return trial.events.map((event, index) => ({
      sessionId: trial.sessionId ?? "",
      participantId: trial.participantId ?? "",
      trialId: trial.trialId,
      trialType: trial.trialType ?? "",
      layoutName: layoutNameForId(trial.layoutId ?? ""),
      layoutIndex: trial.layoutIndex ?? "",
      trialIndex: trial.trialIndex ?? "",
      eventIndex: index + 1,
      key: event.keyId ?? "",
      keyType: event.kind ?? "",
      timestampMs:
        timestampBase == null || typeof event.tMs !== "number"
          ? ""
          : Math.round(timestampBase + event.tMs),
    }));
  }

  async function sendDetailsToGoogleSheets(trial) {
    if (!AUTO_SHEETS_UPLOAD) return false;
    const url = String(GOOGLE_SHEETS_WEB_APP_URL || "").trim();
    if (!url) return false;

    const rows = buildDetailRows(trial);
    if (!rows.length) return false;

    const session = state.sessionMeta || createSessionMeta();
    const participantId = String(session?.participantId ?? "").trim();
    const sheet = `${participantId || "Unknown"}_details`;
    const payload = {
      kind: "details",
      sheet,
      session,
      columns: DETAIL_COLUMNS.slice(),
      rows: rows.map((row) => DETAIL_COLUMNS.map((col) => row[col])),
    };

    try {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  async function sendTrialsToGoogleSheets(trials, options = {}) {
    const { auto = false } = options;
    const url = String(GOOGLE_SHEETS_WEB_APP_URL || "").trim();
    if (!url) {
      if (!auto) {
        setSheetStatus("Add your Apps Script URL in GOOGLE_SHEETS_WEB_APP_URL to enable uploads.");
      }
      return false;
    }

    const payload = buildSheetPayload(trials);
    if (!payload.rows.length) {
      if (!auto) setSheetStatus("No trials to upload yet.");
      return false;
    }

    const participantId = String(payload.session?.participantId ?? "").trim();
    const warningPrefix = participantId ? "" : "Participant ID is empty; sending to the 'Unknown' sheet. ";
    const verb = auto ? "Auto-sending" : "Sending results";
    setSheetStatus(`${warningPrefix}${verb} to Google Sheets...`);
    try {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      if (auto) {
        const count = payload.rows.length;
        setSheetStatus(`Auto-sent ${count} new trial${count === 1 ? "" : "s"} to Google Sheets.`);
      } else {
        setSheetStatus("Sent. Check your sheet to confirm the new rows.");
      }
      return true;
    } catch (err) {
      setSheetStatus(`Send failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async function sendToGoogleSheets() {
    await sendTrialsToGoogleSheets(state.session.trials, { auto: false });
  }

  function queueAutoSheetsUpload() {
    if (!AUTO_SHEETS_UPLOAD) return;
    const url = String(GOOGLE_SHEETS_WEB_APP_URL || "").trim();
    if (!url) return;
    if (sheetUploadInFlight) {
      sheetUploadQueued = true;
      return;
    }

    const startIndex = lastUploadedIndex;
    const endIndex = state.session.trials.length;
    const newTrials = state.session.trials.slice(startIndex, endIndex);
    if (!newTrials.length) return;

    sheetUploadInFlight = true;
    sendTrialsToGoogleSheets(newTrials, { auto: true })
      .then((ok) => {
        if (ok) {
          lastUploadedIndex = endIndex;
        }
      })
      .finally(() => {
        sheetUploadInFlight = false;
        if (sheetUploadQueued) {
          sheetUploadQueued = false;
          queueAutoSheetsUpload();
        }
      });
  }

  function renderKeyboard() {
    const container = $("keyboardContainer");
    ns.keyboard.renderKeyboard(container, currentLayout(), handleKeyPress);
    container.dataset.stickyHighlight = "true";
    markFocusArea(container);
    markNextAction(container);
  }

  function renderLayoutSelect() {
    const select = document.getElementById("layoutSelect");
    if (!select) return;
    select.innerHTML = "";
    const allLayouts = ns.layouts.getAllLayouts();
    const filteredLayouts = allLayouts.filter((layout) => EXPERIMENT_LAYOUT_IDS.includes(layout.id));
    const layoutsToShow = filteredLayouts.length ? filteredLayouts : allLayouts;
    if (!filteredLayouts.length) {
      console.warn("Experiment layout filter found no matches; showing all layouts.");
    }
    for (const layout of layoutsToShow) {
      const opt = document.createElement("option");
      opt.value = layout.id;
      opt.textContent = `${layout.name} (${layout.id})`;
      select.appendChild(opt);
    }
    select.value = state.layoutId;

    select.onchange = () => {
      if (experiment.running) return;
      state.layoutId = select.value;
      renderKeyboard();
      resetTrial(); // avoid mixing layouts mid-trial
    };
  }

  function renderTheoryTable() {
    const tbody = $("theoryTableBody");
    tbody.innerHTML = "";
    const params = { tapTimeMs: 140, moveMsPerUnit: 35, useCenter: distanceMode.useCenter, useEdge: distanceMode.useEdge };

    for (const layout of ns.layouts.getAllLayouts()) {
      const { predictedWpm, avgMsPerChar } = ns.theory.distanceLinear.estimateLayout(layout, PHRASES, params);
      const tr = document.createElement("tr");

      const cells = [
        `${layout.name} (${layout.id})`,
        ns.metrics.roundTo(predictedWpm, 2),
        ns.metrics.roundTo(avgMsPerChar, 1),
      ];

      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }
  }

  function initTheoryDistanceControls() {
    distanceMode = loadDistanceMode();
    const centerEl = $("theoryUseCenter");
    const edgeEl = $("theoryUseEdge");
    centerEl.checked = distanceMode.useCenter;
    edgeEl.checked = distanceMode.useEdge;

    const onChange = (e) => {
      // Enforce: at least one must be enabled.
      if (!centerEl.checked && !edgeEl.checked) {
        if (e?.target === centerEl) centerEl.checked = true;
        else edgeEl.checked = true;
      }
      distanceMode = normalizeDistanceMode({ useCenter: centerEl.checked, useEdge: edgeEl.checked });
      saveDistanceMode(distanceMode);
      renderTheoryTable();
    };
    centerEl.addEventListener("change", onChange);
    edgeEl.addEventListener("change", onChange);
  }

  function setExperimentUiRunning(running) {
    $("experimentStartBtn").disabled = running;
    $("experimentStopBtn").disabled = !running;
    $("experimentSkipBtn").disabled = !running;
    const layoutSelect = document.getElementById("layoutSelect");
    if (layoutSelect) layoutSelect.disabled = running;
    const resetBtn = document.getElementById("resetTrialBtn");
    if (resetBtn) resetBtn.disabled = running;
    const nextBtn = document.getElementById("nextPhraseBtn");
    if (nextBtn) nextBtn.disabled = running;
    $("experimentParticipantId").disabled = running;
  }

  function renderStepRow(el, steps, activeIndex, doneCount) {
    el.innerHTML = "";
    if (!steps.length) {
      el.style.display = "none";
      return;
    }
    el.style.display = "flex";
    const safeDone = Math.max(0, Math.min(doneCount ?? activeIndex ?? 0, steps.length));
    const safeActive = activeIndex >= 0 && activeIndex < steps.length ? activeIndex : -1;
    steps.forEach((label, idx) => {
      const step = document.createElement("div");
      step.className = "step";
      if (idx < safeDone) step.classList.add("stepDone");
      if (idx === safeActive) step.classList.add("stepActive");
      step.textContent = label;
      el.appendChild(step);
    });
  }

  const HIGHLIGHT_CLASSES = ["nextAction", "requiredField", "focusArea"];
  let lastGuidanceKey = "";
  let wizardStep = "setup";
  let wizardIntroShown = false;
  let wizardModalOpen = false;
  let practiceModalOpen = false;
  let tlxModalOpen = false;
  let wizardModalCallback = null;
  let wizardModalButton = null;
  let tlxLayoutIdPending = null;

  function clearGuidanceHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASSES.join(", .")}`).forEach((el) => {
      if (el.dataset && el.dataset.stickyHighlight === "true") return;
      HIGHLIGHT_CLASSES.forEach((cls) => el.classList.remove(cls));
    });
  }

  function markNextAction(el) {
    if (el) el.classList.add("nextAction");
  }

  function markRequired(el) {
    if (el) el.classList.add("requiredField");
  }

  function markFocusArea(el) {
    if (el) el.classList.add("focusArea");
  }

  function focusGuidance(el, key) {
    if (!el || typeof el.focus !== "function") return;
    if (key && key === lastGuidanceKey) return;
    lastGuidanceKey = key ?? "";
    if (el.disabled) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function syncModalOpenState() {
    const open = practiceModalOpen || wizardModalOpen || tlxModalOpen;
    document.body.classList.toggle("modalOpen", open);
  }

  function openWizardModal({ title, message, buttonLabel = "Continue", onContinue = null }) {
    const modal = $("wizardModal");
    $("wizardModalTitle").textContent = title;
    $("wizardModalBody").textContent = message;
    const btn = $("wizardModalContinue");
    btn.textContent = buttonLabel;
    wizardModalCallback = typeof onContinue === "function" ? onContinue : null;
    wizardModalButton = btn;
    wizardModalOpen = true;
    modal.hidden = false;
    syncModalOpenState();
    clearGuidanceHighlights();
    markNextAction(btn);
    focusGuidance(btn, `wizard-${title}`);
  }

  function closeWizardModal() {
    const modal = $("wizardModal");
    modal.hidden = true;
    wizardModalOpen = false;
    wizardModalButton = null;
    wizardModalCallback = null;
    syncModalOpenState();
  }

  function resolveWizardStep() {
    if (experiment.completed) return "results";
    if (!experiment.running) return "setup";
    if (isLearningPhase()) return "learning";
    if (experiment.awaitingPracticeChoice || experiment.practiceRemaining > 0) return "practice";
    return "main";
  }

  function setWizardStage(step) {
    const setup = $("stageSetup");
    const experimentStage = $("stageExperiment");
    const results = $("stageResults");
    const showExperiment = step === "practice" || step === "main" || step === "learning";
    setup.classList.toggle("wizardStageActive", step === "setup");
    experimentStage.classList.toggle("wizardStageActive", showExperiment);
    results.classList.toggle("wizardStageActive", step === "results");
    if (showExperiment) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => renderKeyboard());
      } else {
        setTimeout(() => renderKeyboard(), 0);
      }
    }
  }

  function showWizardTransition(prevStep, nextStep) {
    if (prevStep === nextStep) return;
    if (nextStep === "learning") {
      const layoutLabel = currentLayoutLabel();
      openWizardModal({
        title: "Learning phase",
        message: `Before trials, learn the ${layoutLabel} layout with short exercises.`,
        buttonLabel: "Start learning",
      });
      return;
    }
    if (nextStep === "practice") {
      const layoutLabel = currentLayoutLabel();
      openWizardModal({
        title: "Practice start",
        message: `You will complete practice trials for ${layoutLabel} first. Use the on-screen keyboard and press Enter to submit each phrase.`,
        buttonLabel: "Start practice",
      });
      return;
    }
    if (nextStep === "main") {
      const layoutLabel = currentLayoutLabel();
      openWizardModal({
        title: "Main trials",
        message: `Practice is done. Continue with the main trials for ${layoutLabel} and press Enter to submit each phrase.`,
        buttonLabel: "Start main trials",
      });
      return;
    }
    if (nextStep === "results") {
      openWizardModal({
        title: "Session complete",
        message: "Your session is complete. Download your results below.",
        buttonLabel: "View results",
      });
    }
  }

  function updateWizardState() {
    const nextStep = resolveWizardStep();
    const prevStep = wizardStep;
    wizardStep = nextStep;
    setWizardStage(nextStep);
    if (!wizardIntroShown) {
      wizardIntroShown = true;
      openWizardModal({
        title: "Welcome",
        message: "Enter the participant ID to begin. You will be guided step-by-step.",
        buttonLabel: "Begin setup",
      });
      return;
    }
    showWizardTransition(prevStep, nextStep);
  }

  function setAwaitingPracticeChoice(flag) {
    experiment.awaitingPracticeChoice = flag;
    const submitBtn = $("submitTrialBtn");
    submitBtn.disabled = flag;
    $("experimentSkipBtn").disabled = flag || !experiment.running;
  }

  function setAwaitingTlx(flag) {
    experiment.awaitingTlx = flag;
    const submitBtn = $("submitTrialBtn");
    submitBtn.disabled = flag;
    $("experimentSkipBtn").disabled = flag || !experiment.running;
  }

  function resetPracticeForLayout() {
    const total = experiment.practiceTrials;
    experiment.practiceRemaining = total;
    experiment.currentTrialIsPractice = total > 0;
  }

  function openPracticeModal() {
    const modal = $("practiceModal");
    modal.hidden = false;
    practiceModalOpen = true;
    syncModalOpenState();
    setAwaitingPracticeChoice(true);
  }

  function closePracticeModal() {
    const modal = $("practiceModal");
    modal.hidden = true;
    practiceModalOpen = false;
    syncModalOpenState();
    setAwaitingPracticeChoice(false);
  }

  function openTlxModal(layoutId) {
    const modal = $("tlxModal");
    const titleEl = document.getElementById("tlxModalTitle");
    const subtitleEl = document.getElementById("tlxModalSubtitle");
    tlxLayoutIdPending = layoutId;
    if (titleEl) titleEl.textContent = "Form";
    if (subtitleEl) subtitleEl.textContent = "These questions are only about the most recent keyboard you used.";
    const saved = getTlxForLayout(layoutId);
    if (saved && saved.values) {
      fillTlxInputs(saved.values);
      const saveBtn = document.getElementById("tlxSaveBtn");
      if (saveBtn) saveBtn.disabled = false;
    } else {
      resetTlxInputs();
      const saveBtn = document.getElementById("tlxSaveBtn");
      if (saveBtn) saveBtn.disabled = true;
    }
    updateTlxStatus();
    modal.hidden = false;
    tlxModalOpen = true;
    syncModalOpenState();
    setAwaitingTlx(true);
    clearGuidanceHighlights();
    markNextAction($("tlxSaveBtn"));
    focusGuidance($("tlxSaveBtn"), `tlx-${layoutId}`);
  }

  function closeTlxModal() {
    const modal = $("tlxModal");
    modal.hidden = true;
    tlxModalOpen = false;
    tlxLayoutIdPending = null;
    syncModalOpenState();
    setAwaitingTlx(false);
  }

  function updateExperimentStatus() {
    if (!experiment.running) {
      const statusText = experiment.completed
        ? "Session complete. Download results or start a new session."
        : "Idle.";
      setText($("experimentStatus"), statusText);
      const statusRail = document.getElementById("experimentStatusRail");
      if (statusRail) statusRail.textContent = statusText;
      updateExperimentProgress();
      return;
    }

    const layoutTotal = experiment.layoutOrder.length;
    const layoutIndex = layoutTotal > 0 ? Math.min(experiment.layoutIndex + 1, layoutTotal) : 0;
    const layoutLabel = currentLayoutLabel();
    const layoutText = layoutTotal > 0 ? `Layout ${layoutIndex}/${layoutTotal}: ${layoutLabel}` : `Layout: ${layoutLabel}`;
    const step = resolveWizardStep();
    let statusText = "";
    if (experiment.awaitingTlx) {
      statusText = `NASA-TLX required • ${layoutText}`;
    } else if (step === "learning") {
      const item = currentLearningItem();
      statusText = `Learning • ${layoutText} • ${learningLabel(item)}`;
    } else {
      const practiceLeft = experiment.practiceRemaining;
      const practiceText = experiment.awaitingPracticeChoice
        ? "Practice complete"
        : practiceLeft > 0
          ? `Practice (${practiceLeft} left)`
          : "Main trials";
      const trialTotal = experiment.trialsPerLayout;
      const trialIndex = Math.min(experiment.trialInLayout + 1, trialTotal);
      const trialText = `Trial ${trialIndex}/${trialTotal}`;
      statusText = `${practiceText} • ${layoutText} • ${trialText}`;
    }
    setText($("experimentStatus"), statusText);
    const statusRail = document.getElementById("experimentStatusRail");
    if (statusRail) statusRail.textContent = statusText;
    updateExperimentProgress();
  }

  function updateExperimentProgress() {
    clearGuidanceHighlights();
    const stepper = $("experimentStepper");
    const steps = ["Setup", "Learning", "Practice", "Main", "Download"];
    let stageIndex = 0;
    if (experiment.completed) stageIndex = 4;
    else if (!experiment.running) stageIndex = 0;
    else if (isLearningPhase()) stageIndex = 1;
    else if (experiment.awaitingPracticeChoice || experiment.practiceRemaining > 0) stageIndex = 2;
    else stageIndex = 3;

    const phase = resolveWizardStep();
    setPhaseAttributes(phase, experiment.running);

    renderStepRow(stepper, steps, stageIndex, stageIndex);

    const total = steps.length;
    const pct = total > 1 ? Math.round((stageIndex / (total - 1)) * 100) : 0;
    const fill = $("experimentProgressFill");
    fill.style.width = `${pct}%`;

    const practiceFill = $("experimentPracticeFill");
    const mainFill = $("experimentMainFill");
    const subLabel = $("experimentSubstepLabel");
    const layoutStepper = $("experimentLayoutStepper");
    const trialStepper = $("experimentTrialStepper");
    const actionEl = $("experimentAction");
    const participantEl = $("experimentParticipantId");
    const startBtn = $("experimentStartBtn");
    const submitBtn = $("submitTrialBtn");
    const keyboardEl = $("keyboardContainer");
    const downloadBtn = $("downloadCsvBtn");
    const repeatBtn = $("practiceRepeatBtn");
    const continueBtn = $("practiceContinueBtn");
    const tlxSaveBtn = document.getElementById("tlxSaveBtn");
    const phaseTitleEl = $("experimentPhaseTitle");
    const phaseMetaEl = $("experimentPhaseMeta");
    const phaseLeftEl = $("experimentTrialsLeft");
    let detail = "Setup";
    let phaseTitle = steps[stageIndex] ?? "Setup";
    let phaseMeta = "";
    let trialsLeftText = "";

    if (experiment.awaitingTlx) {
      phaseTitle = "NASA-TLX";
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "NASA-TLX required";
      detail = "NASA-TLX";
      phaseMeta = "Complete NASA-TLX to continue.";
      actionEl.innerHTML = "<strong>NASA-TLX:</strong> Please rate workload for the completed layout.";
      if (tlxSaveBtn) {
        markNextAction(tlxSaveBtn);
        focusGuidance(tlxSaveBtn, "tlx-save");
      }
    } else if (experiment.awaitingPracticeChoice) {
      phaseTitle = "Practice";
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "Practice complete";
      detail = "Practice";
      phaseMeta = "Practice complete • Choose another round or continue.";
      actionEl.innerHTML =
        "<strong>Practice complete:</strong> Choose another practice round or continue to main trials.";
      markNextAction(repeatBtn);
      markRequired(continueBtn);
      focusGuidance(repeatBtn, "practice-choice");
    } else if (stageIndex === 0) {
      phaseTitle = "Setup";
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "";
      detail = "Setup";
      phaseMeta = "Enter participant ID, then start the session.";
      actionEl.innerHTML = "<strong>Next:</strong> Enter participant ID, then click Start experiment to begin.";
      markRequired(participantEl);
      markNextAction(startBtn);
      focusGuidance(participantEl, "setup");
    } else if (stageIndex === 1) {
      const layoutTotal = experiment.layoutOrder.length;
      const layoutIndex = layoutTotal > 0 ? Math.min(experiment.layoutIndex + 1, layoutTotal) : 0;
      const layoutLabel = currentLayoutLabel();
      const layoutText = layoutTotal > 0 ? `Layout ${layoutIndex}/${layoutTotal}: ${layoutLabel}` : `Layout: ${layoutLabel}`;
      const item = currentLearningItem();
      const learningText = learningLabel(item);
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = `Learning • ${learningText}`;
      detail = "Learning";
      phaseTitle = "Learning";
      phaseMeta = `${layoutText} • ${learningText}`;
      trialsLeftText = experiment.learningQueue.length
        ? `Exercises left: ${Math.max(0, experiment.learningQueue.length - experiment.learningIndex)}`
        : "";
      actionEl.innerHTML = "<strong>Learning:</strong> Follow the prompt to get familiar with this layout.";
      markFocusArea(keyboardEl);
      markNextAction(keyboardEl);
      focusGuidance(keyboardEl, "learning");
    } else if (stageIndex === 2) {
      const totalPractice = experiment.practiceTrials;
      const donePractice = Math.max(0, totalPractice - experiment.practiceRemaining);
      const activePractice = donePractice < totalPractice ? donePractice : -1;
      const practiceSteps = Array.from({ length: totalPractice }, (_, idx) => `Practice ${idx + 1}`);
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, practiceSteps, activePractice, donePractice);
      subLabel.textContent = totalPractice
        ? `Practice trials (${Math.min(donePractice + 1, totalPractice)} of ${totalPractice})`
        : "";
      detail = totalPractice
        ? `Practice • Trial ${Math.min(donePractice + 1, totalPractice)}/${totalPractice}`
        : "Practice";
      phaseTitle = "Practice";
      const layoutTotal = experiment.layoutOrder.length;
      const layoutIndex = layoutTotal > 0 ? Math.min(experiment.layoutIndex + 1, layoutTotal) : 0;
      const layoutLabel = currentLayoutLabel();
      const layoutText = layoutTotal > 0 ? `Layout ${layoutIndex}/${layoutTotal}: ${layoutLabel}` : `Layout: ${layoutLabel}`;
      const practiceText = totalPractice
        ? `Practice ${Math.min(donePractice + 1, totalPractice)}/${totalPractice}`
        : "Practice";
      phaseMeta = `${layoutText} • ${practiceText}`;
      if (experiment.practiceRemaining > 0) {
        trialsLeftText = `Trials left: ${experiment.practiceRemaining}`;
      }
      actionEl.innerHTML = '<strong>Practice:</strong> Type the target phrase, then press Enter to submit.';
      markFocusArea(keyboardEl);
      markNextAction(submitBtn);
      focusGuidance(keyboardEl, "practice");
    } else if (stageIndex === 3) {
      const layoutTotal = experiment.layoutOrder.length;
      const layoutIndex = layoutTotal > 0 ? Math.min(experiment.layoutIndex, layoutTotal - 1) : 0;
      const trialTotal = experiment.trialsPerLayout;
      const trialIndex = Math.min(experiment.trialInLayout, Math.max(trialTotal - 1, 0));
      const layoutSteps = Array.from({ length: layoutTotal }, (_, idx) => `Layout ${idx + 1}`);
      const trialSteps = Array.from({ length: trialTotal }, (_, idx) => `Trial ${idx + 1}`);
      renderStepRow(layoutStepper, layoutSteps, layoutIndex, experiment.layoutIndex);
      renderStepRow(trialStepper, trialSteps, trialIndex, experiment.trialInLayout);
      subLabel.textContent = layoutTotal ? `Main trials • Layout ${layoutIndex + 1} of ${layoutTotal}` : "Main trials";
      detail = layoutTotal
        ? `Main • Layout ${layoutIndex + 1}/${layoutTotal} • Trial ${trialIndex + 1}/${trialTotal}`
        : "Main";
      phaseTitle = "Main trials";
      const layoutLabel = currentLayoutLabel();
      const layoutText = layoutTotal > 0 ? `Layout ${layoutIndex + 1}/${layoutTotal}: ${layoutLabel}` : `Layout: ${layoutLabel}`;
      const trialText = `Trial ${trialIndex + 1}/${trialTotal}`;
      phaseMeta = `${layoutText} • ${trialText}`;
      const totalMainTrials = layoutTotal * trialTotal;
      const doneMainTrials = experiment.layoutIndex * trialTotal + experiment.trialInLayout;
      if (totalMainTrials > 0) {
        trialsLeftText = `Trials left: ${Math.max(0, totalMainTrials - doneMainTrials)}`;
      }
      actionEl.innerHTML = `<strong>Main trials:</strong> ${currentLayoutLabel()} • Type the phrase, then press Enter to submit.`;
      markFocusArea(keyboardEl);
      markNextAction(submitBtn);
      focusGuidance(keyboardEl, "main");
    } else {
      phaseTitle = "Download";
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "";
      detail = "Download";
      phaseMeta = "Session complete. Save your results.";
      actionEl.innerHTML = "<strong>Download:</strong> Save your results, or start a new session.";
      markNextAction(downloadBtn);
      focusGuidance(downloadBtn, "download");
    }

    const totalPractice = experiment.practiceTrials;
    const donePractice = experiment.awaitingPracticeChoice
      ? totalPractice
      : Math.max(0, totalPractice - experiment.practiceRemaining);
    const practicePct = totalPractice > 0 ? Math.round((donePractice / totalPractice) * 100) : 0;
    const layoutTotal = experiment.layoutOrder.length;
    const trialTotal = experiment.trialsPerLayout;
    const totalMainTrials = layoutTotal * trialTotal;
    const doneMainTrials = experiment.completed ? totalMainTrials : experiment.layoutIndex * trialTotal + experiment.trialInLayout;
    const mainPct = totalMainTrials > 0 ? Math.round((doneMainTrials / totalMainTrials) * 100) : 0;
    practiceFill.style.width = `${Math.min(practicePct, 100)}%`;
    mainFill.style.width = `${Math.min(mainPct, 100)}%`;

    phaseTitleEl.textContent = phaseTitle;
    phaseMetaEl.textContent = phaseMeta;
    phaseLeftEl.textContent = trialsLeftText;

    subLabel.style.display = subLabel.textContent ? "block" : "none";
    $("experimentProgressLabel").textContent = `Stage ${stageIndex + 1} of ${total} • ${detail} (${total - stageIndex - 1} left)`;
    setSubmitReady((stageIndex === 2 || stageIndex === 3) && !experiment.awaitingPracticeChoice && !experiment.awaitingTlx);
    if (wizardModalOpen && wizardModalButton) {
      clearGuidanceHighlights();
      markNextAction(wizardModalButton);
      focusGuidance(wizardModalButton, "wizard-modal");
    }
    updateWizardState();
    updateTlxStatus();
  }

  function startExperimentWithSettings(settings, layoutOrder) {
    experiment.running = true;
    experiment.completed = false;
    closePracticeModal();
    lastGuidanceKey = "";
    experiment.layoutOrder = layoutOrder;
    experiment.layoutIndex = 0;
    experiment.trialInLayout = 0;
    experiment.practiceTrials = settings.practiceTrials;
    experiment.trialsPerLayout = settings.trialsPerLayout;
    startLearningForLayout();
    experiment.orderMode = settings.orderMode;
    experiment.orderSeed = settings.orderSeed;

    state.sessionMeta = {
      sessionId: createSessionId(),
      participantId: settings.participantId,
      condition: settings.condition,
      orderMode: settings.orderMode,
      orderSeed: settings.orderSeed,
      layoutOrder: layoutOrder.slice(),
      practiceTrials: settings.practiceTrials,
      trialsPerLayout: settings.trialsPerLayout,
      startedAtMs: Date.now(),
      endedAtMs: null,
    };

    clearResults();
    state.nextTrialId = 1;
    state.phraseIndex = 0;
    state.layoutId = experiment.layoutOrder[0] ?? state.layoutId;
    renderLayoutSelect();
    renderKeyboard();
    renderTarget();
    resetTrial();

    setExperimentUiRunning(true);
    setControlTrayOpen(false);
    updateExperimentStatus();
  }

  function startExperiment() {
    const settings = readExperimentSettings();
    const layoutOrder = resolveLayoutOrder(settings.orderMode, settings.orderSeed);
    startExperimentWithSettings(settings, layoutOrder);
  }

  function handleStartExperiment() {
    if (experiment.running || wizardModalOpen) return;
    const settings = readExperimentSettings();
    const layoutOrder = resolveLayoutOrder(settings.orderMode, settings.orderSeed);
    const layoutCount = layoutOrder.length;
    const practiceCount = settings.practiceTrials;
    const trialsPerLayout = settings.trialsPerLayout;
    const layoutLabel = layoutCount === 1 ? "layout" : "layouts";
    const trialLabel = trialsPerLayout === 1 ? "trial" : "trials";
    const practiceLabel = practiceCount === 1 ? "practice trial" : "practice trials";
    const message = `Each layout starts with a learning phase, then ${practiceCount} ${practiceLabel}, then ${trialsPerLayout} ${trialLabel}. Total layouts: ${layoutCount}.`;
    openWizardModal({
      title: "Session overview",
      message,
      buttonLabel: "Start session",
      onContinue: () => startExperimentWithSettings(settings, layoutOrder),
    });
  }

  function stopExperiment(options = {}) {
    const completed = options.completed === true;
    if (experiment.running && state.sessionMeta) {
      state.sessionMeta.endedAtMs = Date.now();
    }
    experiment.running = false;
    experiment.completed = completed;
    experiment.layoutOrder = [];
    experiment.layoutIndex = 0;
    experiment.trialInLayout = 0;
    experiment.practiceRemaining = 0;
    experiment.currentTrialIsPractice = false;
    experiment.learningActive = false;
    experiment.learningQueue = [];
    experiment.learningIndex = 0;
    experiment.practiceTrials = DEFAULT_PRACTICE_TRIALS;
    experiment.trialsPerLayout = DEFAULT_TRIALS_PER_LAYOUT;
    experiment.orderMode = "random";
    experiment.orderSeed = "";
    closePracticeModal();
    closeTlxModal();
    closeWizardModal();
    lastGuidanceKey = "";
    setExperimentUiRunning(false);
    setControlTrayOpen(true);
    updateExperimentStatus();
  }

  function advanceLearningAfterSubmit() {
    if (!isLearningPhase()) return;
    experiment.learningIndex += 1;
    if (!isLearningPhase()) {
      completeLearningPhase();
    }
    renderTarget();
    resetTrial();
    updateExperimentStatus();
  }

  function completeLayoutAfterTlx() {
    experiment.layoutIndex += 1;
    experiment.trialInLayout = 0;

    if (experiment.layoutIndex >= experiment.layoutOrder.length) {
      stopExperiment({ completed: true });
      return;
    }

    state.layoutId = experiment.layoutOrder[experiment.layoutIndex];
    renderLayoutSelect();
    renderKeyboard();
    startLearningForLayout();
    renderTarget();
    resetTrial();
    updateExperimentStatus();
  }

  function advanceExperimentAfterSubmit() {
    if (experiment.practiceRemaining > 0) {
      experiment.practiceRemaining -= 1;
      experiment.currentTrialIsPractice = experiment.practiceRemaining > 0;
      if (experiment.practiceRemaining === 0) {
        openPracticeModal();
      }
      updateExperimentStatus();
      return;
    }

    experiment.currentTrialIsPractice = false;
    experiment.trialInLayout += 1;

    if (experiment.trialInLayout >= experiment.trialsPerLayout) {
      openTlxModal(state.layoutId);
      updateExperimentStatus();
      return;
    }

    updateExperimentStatus();
  }

  function handlePracticeRepeat() {
    closePracticeModal();
    resetPracticeForLayout();
    updateExperimentStatus();
  }

  function handlePracticeContinue() {
    closePracticeModal();
    experiment.currentTrialIsPractice = false;
    updateExperimentStatus();
  }

  function skipExperimentPhase() {
    if (!experiment.running) return;
    if (experiment.awaitingTlx) return;
    if (isLearningPhase()) {
      completeLearningPhase();
      renderTarget();
      resetTrial();
      updateExperimentStatus();
      return;
    }
    if (experiment.awaitingPracticeChoice) {
      handlePracticeContinue();
      return;
    }

    if (experiment.practiceRemaining > 0) {
      experiment.practiceRemaining = 0;
      experiment.currentTrialIsPractice = false;
      updateExperimentStatus();
      return;
    }

    experiment.layoutIndex += 1;
    experiment.trialInLayout = 0;
    if (experiment.layoutIndex >= experiment.layoutOrder.length) {
      stopExperiment();
      return;
    }

    state.layoutId = experiment.layoutOrder[experiment.layoutIndex];
    renderLayoutSelect();
    renderKeyboard();
    resetTrial();
    resetPracticeForLayout();
    updateExperimentStatus();
  }

  function init() {
    state.sessionMeta = createSessionMeta();

    renderLayoutSelect();
    renderTarget();
    resetTrial();
    renderKeyboard();
    const keyboardContainer = document.getElementById("keyboardContainer");
    if (keyboardContainer && !keyboardContainer.dataset.missListener) {
      keyboardContainer.addEventListener("pointerdown", (event) => {
        if (event?.target && event.target.closest(".key")) return;
        handleKeyMiss();
      });
      keyboardContainer.dataset.missListener = "true";
    }
    initTheoryDistanceControls();
    renderTheoryTable();
    initTlx();

    const resetBtn = document.getElementById("resetTrialBtn");
    if (resetBtn) resetBtn.addEventListener("click", resetTrial);
    const nextBtn = document.getElementById("nextPhraseBtn");
    if (nextBtn) nextBtn.addEventListener("click", nextPhrase);
    $("downloadCsvBtn").addEventListener("click", downloadCsv);
    $("downloadJsonBtn").addEventListener("click", downloadJson);
    $("sendSheetBtn").addEventListener("click", sendToGoogleSheets);
    $("clearResultsBtn").addEventListener("click", clearResults);
    $("experimentStartBtn").addEventListener("click", handleStartExperiment);
    $("experimentStopBtn").addEventListener("click", stopExperiment);
    $("experimentSkipBtn").addEventListener("click", skipExperimentPhase);
    const skipPhaseBtn = document.getElementById("experimentSkipPhaseBtn");
    const devControls = document.getElementById("experimentDevControls");
    if (devControls) devControls.style.display = DEV_SHOW_SKIP_PHASE ? "block" : "none";
    if (skipPhaseBtn) skipPhaseBtn.addEventListener("click", skipExperimentPhase);

    // Font testing controls
    initFontControls();

    $("practiceRepeatBtn").addEventListener("click", handlePracticeRepeat);
    $("practiceContinueBtn").addEventListener("click", handlePracticeContinue);
    $("wizardModalContinue").addEventListener("click", () => {
      const cb = wizardModalCallback;
      closeWizardModal();
      if (cb) cb();
      updateExperimentProgress();
    });
    setExperimentUiRunning(false);
    setControlTrayOpen(true);
    updateExperimentStatus();
    updateExperimentProgress();
    setSheetStatus(
      GOOGLE_SHEETS_WEB_APP_URL.trim()
        ? "Ready to send results to Google Sheets."
        : "Optional: set GOOGLE_SHEETS_WEB_APP_URL in app.js to enable Sheets upload."
    );

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderKeyboard(), 120);
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();

