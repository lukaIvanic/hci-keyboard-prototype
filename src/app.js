(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const DISTANCE_MODE_STORAGE_KEY = "KbdStudy.distanceMode.v1";
  const DEFAULT_PRACTICE_TRIALS = 2;
  const DEFAULT_TRIALS_PER_LAYOUT = 10;
  const GOOGLE_SHEETS_WEB_APP_URL =
    "https://script.google.com/macros/s/AKfycbym_9NOItbd3M3HgQfr-PY_W5Utu3_BVjZcDpXhjeMTiIu3dtF0AAq9j6DRxSG0jw4mAg/exec";

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
    "sessionId",
    "participantId",
    "condition",
    "orderMode",
    "orderSeed",
    "layoutOrder",
    "layoutIndex",
    "trialIndex",
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
    orderMode: "fixed",
    orderSeed: "",
    completed: false,
    awaitingPracticeChoice: false,
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

  function createSessionMeta() {
    return {
      sessionId: createSessionId(),
      participantId: "",
      condition: "",
      orderMode: "fixed",
      orderSeed: "",
      layoutOrder: [],
      practiceTrials: DEFAULT_PRACTICE_TRIALS,
      trialsPerLayout: DEFAULT_TRIALS_PER_LAYOUT,
      startedAtMs: null,
      endedAtMs: null,
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

  function resolveLayoutOrder(orderMode, seedText) {
    const ids = ns.layouts.getAllLayouts().map((l) => l.id);
    if (orderMode === "seeded") return seededShuffle(ids, seedText);
    return ids;
  }

  function readExperimentSettings() {
    const participantId = String($("experimentParticipantId").value ?? "").trim();
    const condition = "";
    const orderMode = "fixed";
    const orderSeed = "";
    const practiceTrials = DEFAULT_PRACTICE_TRIALS;
    const trialsPerLayout = DEFAULT_TRIALS_PER_LAYOUT;

    return { participantId, condition, orderMode, orderSeed, practiceTrials, trialsPerLayout };
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
    } else if (key.type === "enter") {
      submitTrial();
      return;
    } else if (key.type === "backspace") {
      state.typed = state.typed.slice(0, -1);
    }

    renderTyped();
  }

  function formatSeconds(ms) {
    return ns.metrics.roundTo(ms / 1000, 2);
  }

  function submitTrial() {
    if (wizardModalOpen) return;
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

    state.nextTrialId += 1;
    nextPhrase();

    if (experiment.running) advanceExperimentAfterSubmit();
  }

  function trialToRow(trial) {
    return {
      sessionId: trial.sessionId ?? "",
      participantId: trial.participantId ?? "",
      condition: trial.condition ?? "",
      orderMode: trial.orderMode ?? "",
      orderSeed: trial.orderSeed ?? "",
      layoutOrder: trial.layoutOrder ?? "",
      layoutIndex: trial.layoutIndex ?? 0,
      trialIndex: trial.trialIndex ?? 0,
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

  function buildSheetPayload() {
    const rows = state.session.trials.map(trialToRow);
    const columns = CSV_COLUMNS.slice();
    return {
      exportedAtMs: Date.now(),
      session: state.sessionMeta || createSessionMeta(),
      columns,
      rows: rows.map((row) => columns.map((col) => row[col])),
    };
  }

  async function sendToGoogleSheets() {
    const url = String(GOOGLE_SHEETS_WEB_APP_URL || "").trim();
    if (!url) {
      setSheetStatus("Add your Apps Script URL in GOOGLE_SHEETS_WEB_APP_URL to enable uploads.");
      return;
    }

    const payload = buildSheetPayload();
    if (!payload.rows.length) {
      setSheetStatus("No trials to upload yet.");
      return;
    }

    setSheetStatus("Sending results to Google Sheets...");
    try {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      setSheetStatus("Sent. Check your sheet to confirm the new rows.");
    } catch (err) {
      setSheetStatus(`Send failed: ${err instanceof Error ? err.message : err}`);
    }
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
  let wizardModalCallback = null;
  let wizardModalButton = null;

  function clearGuidanceHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASSES.join(", .")}`).forEach((el) => {
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
    const open = practiceModalOpen || wizardModalOpen;
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
    if (experiment.awaitingPracticeChoice || experiment.practiceRemaining > 0) return "practice";
    return "main";
  }

  function setWizardStage(step) {
    const setup = $("stageSetup");
    const experimentStage = $("stageExperiment");
    const results = $("stageResults");
    const showExperiment = step === "practice" || step === "main";
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
    if (nextStep === "practice") {
      openWizardModal({
        title: "Practice start",
        message: "You will complete practice trials first. Use the on-screen keyboard and press Enter to submit each phrase.",
        buttonLabel: "Start practice",
      });
      return;
    }
    if (nextStep === "main") {
      openWizardModal({
        title: "Main trials",
        message: "Practice is done. Continue with the main trials and press Enter to submit each phrase.",
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

  function updateExperimentStatus() {
    if (!experiment.running) {
      setText(
        $("experimentStatus"),
        experiment.completed ? "Session complete. Download results or start a new session." : "Idle."
      );
      updateExperimentProgress();
      return;
    }

    const practiceLeft = experiment.practiceRemaining;
    const practiceText = experiment.awaitingPracticeChoice
      ? "Practice complete"
      : practiceLeft > 0
        ? `Practice (${practiceLeft} left)`
        : "Main trials";
    const layoutTotal = experiment.layoutOrder.length;
    const layoutIndex = layoutTotal > 0 ? Math.min(experiment.layoutIndex + 1, layoutTotal) : 0;
    const layoutLabel = currentLayoutLabel();
    const layoutText = layoutTotal > 0 ? `Layout ${layoutIndex}/${layoutTotal}: ${layoutLabel}` : `Layout: ${layoutLabel}`;
    const trialTotal = experiment.trialsPerLayout;
    const trialIndex = Math.min(experiment.trialInLayout + 1, trialTotal);
    const trialText = `Trial ${trialIndex}/${trialTotal}`;
    setText($("experimentStatus"), `${practiceText} • ${layoutText} • ${trialText}`);
    updateExperimentProgress();
  }

  function updateExperimentProgress() {
    clearGuidanceHighlights();
    const stepper = $("experimentStepper");
    const steps = ["Setup", "Practice", "Main", "Download"];
    let stageIndex = 0;
    if (experiment.completed) stageIndex = 3;
    else if (!experiment.running) stageIndex = 0;
    else if (experiment.awaitingPracticeChoice || experiment.practiceRemaining > 0) stageIndex = 1;
    else stageIndex = 2;

    renderStepRow(stepper, steps, stageIndex, stageIndex);

    const total = steps.length;
    const pct = total > 1 ? Math.round((stageIndex / (total - 1)) * 100) : 0;
    const fill = $("experimentProgressFill");
    fill.style.width = `${pct}%`;

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
    let detail = "Setup";

    if (experiment.awaitingPracticeChoice) {
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "Practice complete";
      detail = "Practice";
      actionEl.innerHTML =
        "<strong>Practice complete:</strong> Choose another practice round or continue to main trials.";
      markNextAction(repeatBtn);
      markRequired(continueBtn);
      focusGuidance(repeatBtn, "practice-choice");
    } else if (stageIndex === 0) {
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "";
      detail = "Setup";
      actionEl.innerHTML = "<strong>Next:</strong> Enter participant ID, then click Start experiment to begin.";
      markRequired(participantEl);
      markNextAction(startBtn);
      focusGuidance(participantEl, "setup");
    } else if (stageIndex === 1) {
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
      actionEl.innerHTML = '<strong>Practice:</strong> Type the target phrase, then press Enter to submit.';
      markFocusArea(keyboardEl);
      markNextAction(submitBtn);
      focusGuidance(keyboardEl, "practice");
    } else if (stageIndex === 2) {
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
      actionEl.innerHTML = `<strong>Main trials:</strong> ${currentLayoutLabel()} • Type the phrase, then press Enter to submit.`;
      markFocusArea(keyboardEl);
      markNextAction(submitBtn);
      focusGuidance(keyboardEl, "main");
    } else {
      renderStepRow(layoutStepper, [], -1, 0);
      renderStepRow(trialStepper, [], -1, 0);
      subLabel.textContent = "";
      detail = "Download";
      actionEl.innerHTML = "<strong>Download:</strong> Save your results, or start a new session.";
      markNextAction(downloadBtn);
      focusGuidance(downloadBtn, "download");
    }

    subLabel.style.display = subLabel.textContent ? "block" : "none";
    $("experimentProgressLabel").textContent = `Stage ${stageIndex + 1} of ${total} • ${detail} (${total - stageIndex - 1} left)`;
    if (wizardModalOpen && wizardModalButton) {
      clearGuidanceHighlights();
      markNextAction(wizardModalButton);
      focusGuidance(wizardModalButton, "wizard-modal");
    }
    updateWizardState();
  }

  function startExperiment() {
    const settings = readExperimentSettings();
    const layoutOrder = resolveLayoutOrder(settings.orderMode, settings.orderSeed);

    experiment.running = true;
    experiment.completed = false;
    closePracticeModal();
    lastGuidanceKey = "";
    experiment.layoutOrder = layoutOrder;
    experiment.layoutIndex = 0;
    experiment.trialInLayout = 0;
    experiment.practiceTrials = settings.practiceTrials;
    experiment.trialsPerLayout = settings.trialsPerLayout;
    experiment.practiceRemaining = settings.practiceTrials;
    experiment.currentTrialIsPractice = settings.practiceTrials > 0;
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
    updateExperimentStatus();
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
    experiment.practiceTrials = DEFAULT_PRACTICE_TRIALS;
    experiment.trialsPerLayout = DEFAULT_TRIALS_PER_LAYOUT;
    experiment.orderMode = "fixed";
    experiment.orderSeed = "";
    closePracticeModal();
    closeWizardModal();
    lastGuidanceKey = "";
    setExperimentUiRunning(false);
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
      experiment.layoutIndex += 1;
      experiment.trialInLayout = 0;

      if (experiment.layoutIndex >= experiment.layoutOrder.length) {
        stopExperiment({ completed: true });
        return;
      }

      state.layoutId = experiment.layoutOrder[experiment.layoutIndex];
      renderLayoutSelect();
      renderKeyboard();
      resetTrial();
    }

    updateExperimentStatus();
  }

  function handlePracticeRepeat() {
    closePracticeModal();
    experiment.practiceRemaining = DEFAULT_PRACTICE_TRIALS;
    experiment.practiceTrials = DEFAULT_PRACTICE_TRIALS;
    experiment.currentTrialIsPractice = experiment.practiceRemaining > 0;
    updateExperimentStatus();
  }

  function handlePracticeContinue() {
    closePracticeModal();
    experiment.currentTrialIsPractice = false;
    updateExperimentStatus();
  }

  function skipExperimentPhase() {
    if (!experiment.running) return;
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
    updateExperimentStatus();
  }

  function init() {
    state.sessionMeta = createSessionMeta();

    renderLayoutSelect();
    renderTarget();
    resetTrial();
    renderKeyboard();
    initTheoryDistanceControls();
    renderTheoryTable();

    $("resetTrialBtn").addEventListener("click", resetTrial);
    $("nextPhraseBtn").addEventListener("click", nextPhrase);
    $("downloadCsvBtn").addEventListener("click", downloadCsv);
    $("downloadJsonBtn").addEventListener("click", downloadJson);
    $("sendSheetBtn").addEventListener("click", sendToGoogleSheets);
    $("clearResultsBtn").addEventListener("click", clearResults);
    $("experimentStartBtn").addEventListener("click", startExperiment);
    $("experimentStopBtn").addEventListener("click", stopExperiment);
    $("experimentSkipBtn").addEventListener("click", skipExperimentPhase);
    $("practiceRepeatBtn").addEventListener("click", handlePracticeRepeat);
    $("practiceContinueBtn").addEventListener("click", handlePracticeContinue);
    $("wizardModalContinue").addEventListener("click", () => {
      const cb = wizardModalCallback;
      closeWizardModal();
      if (cb) cb();
      updateExperimentProgress();
    });
    setExperimentUiRunning(false);
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

