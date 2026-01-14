(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const DISTANCE_MODE_STORAGE_KEY = "KbdStudy.distanceMode.v1";
  const PRACTICE_TRIALS = 2;
  const TRIALS_PER_LAYOUT = 10;

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

  const CSV_COLUMNS = [
    "trialId",
    "layoutId",
    "phraseId",
    "isPractice",
    "target",
    "typed",
    "startTimeMs",
    "endTimeMs",
    "elapsedMs",
    "charCount",
    "wpm",
    "editDistance",
    "backspaceCount",
    "keypressCount",
  ];

  const state = {
    nextTrialId: 1,
    phraseIndex: 0,
    layoutId: "qwerty",
    typed: "",
    currentTrial: null,
    session: ns.logger.createSession(),
  };

  const experiment = {
    running: false,
    layoutOrder: [],
    layoutIndex: 0,
    trialInLayout: 0,
    practiceRemaining: 0,
    currentTrialIsPractice: false,
  };

  let distanceMode = { useCenter: true, useEdge: true };

  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el;
  }

  function setText(el, text) {
    el.textContent = text;
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

  function currentTargetPhrase() {
    return PHRASES[state.phraseIndex % PHRASES.length];
  }

  function currentPhraseId() {
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

  function newTrialLog() {
    return ns.logger.createTrialLog({
      trialId: state.nextTrialId,
      layoutId: state.layoutId,
      phraseId: currentPhraseId(),
      target: currentTargetPhrase(),
    });
  }

  function resetTrial() {
    state.typed = "";
    state.currentTrial = newTrialLog();
    renderTyped();
  }

  function nextPhrase() {
    state.phraseIndex = (state.phraseIndex + 1) % PHRASES.length;
    renderTarget();
    resetTrial();
  }

  function renderTarget() {
    setText($("targetPhrase"), currentTargetPhrase());
  }

  function renderTyped() {
    setText($("typedText"), state.typed);
  }

  function handleKeyPress(key) {
    if (!state.currentTrial) state.currentTrial = newTrialLog();

    // Log event first (so backspace presses are captured even if typed is empty).
    state.currentTrial.logKey(key.id, key.type);

    if (key.type === "char") {
      state.typed += key.id;
    } else if (key.type === "space") {
      state.typed += " ";
    } else if (key.type === "backspace") {
      state.typed = state.typed.slice(0, -1);
    }

    renderTyped();
  }

  function formatSeconds(ms) {
    return ns.metrics.roundTo(ms / 1000, 2);
  }

  function submitTrial() {
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
    if (experiment.running) trial.isPractice = experiment.currentTrialIsPractice;

    state.session.addTrial(trial);
    appendResultRow(trial);

    state.nextTrialId += 1;
    nextPhrase();

    if (experiment.running) advanceExperimentAfterSubmit();
  }

  function trialToRow(trial) {
    return {
      trialId: trial.trialId,
      layoutId: trial.layoutId,
      phraseId: trial.phraseId,
      isPractice: trial.isPractice ?? false,
      target: trial.target,
      typed: trial.typed,
      startTimeMs: trial.startTimeMs,
      endTimeMs: trial.endTimeMs,
      elapsedMs: Math.round(trial.elapsedMs ?? 0),
      charCount: trial.charCount ?? (trial.typed ? trial.typed.length : 0),
      wpm: ns.metrics.roundTo(trial.wpm ?? 0, 2),
      editDistance: trial.editDistance ?? "",
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
  }

  function downloadCsv() {
    const rows = state.session.trials.map(trialToRow);
    const filename = `keyboard_trials_${Date.now()}.csv`;
    ns.exporting.downloadCsv(filename, rows, CSV_COLUMNS);
  }

  function downloadJson() {
    const raw = {
      exportedAtMs: Date.now(),
      phrases: PHRASES.slice(),
      trials: state.session.trials.map((t) => ({
        ...trialToRow(t),
        events: t.events,
      })),
    };
    const filename = `keyboard_trials_${Date.now()}.json`;
    ns.exporting.downloadJson(filename, raw);
  }

  function renderKeyboard() {
    const container = $("keyboardContainer");
    ns.keyboard.renderKeyboard(container, currentLayout(), handleKeyPress);
  }

  function renderLayoutSelect() {
    const select = $("layoutSelect");
    select.innerHTML = "";
    for (const layout of ns.layouts.getAllLayouts()) {
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
    $("layoutSelect").disabled = running;
    $("resetTrialBtn").disabled = running;
    $("nextPhraseBtn").disabled = running;
  }

  function updateExperimentStatus() {
    if (!experiment.running) {
      setText($("experimentStatus"), "Idle.");
      return;
    }

    const practiceLeft = experiment.practiceRemaining;
    const practiceText = practiceLeft > 0 ? `Practice (${practiceLeft} left)` : "Main trials";
    const layoutText = currentLayoutLabel();
    const trialText = `${experiment.trialInLayout}/${TRIALS_PER_LAYOUT}`;
    setText($("experimentStatus"), `${practiceText} • Layout: ${layoutText} • Trial ${trialText}`);
  }

  function startExperiment() {
    experiment.running = true;
    experiment.layoutOrder = ns.layouts.getAllLayouts().map((l) => l.id);
    experiment.layoutIndex = 0;
    experiment.trialInLayout = 0;
    experiment.practiceRemaining = PRACTICE_TRIALS;
    experiment.currentTrialIsPractice = PRACTICE_TRIALS > 0;

    clearResults();
    state.nextTrialId = 1;
    state.phraseIndex = 0;
    state.layoutId = experiment.layoutOrder[0] ?? state.layoutId;
    renderLayoutSelect();
    renderKeyboard();
    renderTarget();
    resetTrial();

    setExperimentUiRunning(true);
    updateExperimentStatus();
  }

  function stopExperiment() {
    experiment.running = false;
    experiment.layoutOrder = [];
    experiment.layoutIndex = 0;
    experiment.trialInLayout = 0;
    experiment.practiceRemaining = 0;
    experiment.currentTrialIsPractice = false;
    setExperimentUiRunning(false);
    updateExperimentStatus();
  }

  function advanceExperimentAfterSubmit() {
    if (experiment.practiceRemaining > 0) {
      experiment.practiceRemaining -= 1;
      experiment.currentTrialIsPractice = experiment.practiceRemaining > 0;
      updateExperimentStatus();
      return;
    }

    experiment.currentTrialIsPractice = false;
    experiment.trialInLayout += 1;

    if (experiment.trialInLayout >= TRIALS_PER_LAYOUT) {
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
    }

    updateExperimentStatus();
  }

  function skipExperimentPhase() {
    if (!experiment.running) return;

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
    updateExperimentStatus();
  }

  function init() {
    renderLayoutSelect();
    renderTarget();
    resetTrial();
    renderKeyboard();
    initTheoryDistanceControls();
    renderTheoryTable();

    $("resetTrialBtn").addEventListener("click", resetTrial);
    $("submitTrialBtn").addEventListener("click", submitTrial);
    $("nextPhraseBtn").addEventListener("click", nextPhrase);
    $("downloadCsvBtn").addEventListener("click", downloadCsv);
    $("downloadJsonBtn").addEventListener("click", downloadJson);
    $("clearResultsBtn").addEventListener("click", clearResults);
    $("experimentStartBtn").addEventListener("click", startExperiment);
    $("experimentStopBtn").addEventListener("click", stopExperiment);
    $("experimentSkipBtn").addEventListener("click", skipExperimentPhase);
    setExperimentUiRunning(false);
    updateExperimentStatus();

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderKeyboard(), 120);
    });
  }

  window.addEventListener("DOMContentLoaded", init);
})();

