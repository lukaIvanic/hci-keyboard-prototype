(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const STORAGE_PREFIX = "KbdStudy.study.";
  const TEMPLATE_STORAGE_KEY = `${STORAGE_PREFIX}template.v1`;
  const NOTES_STORAGE_KEY = `${STORAGE_PREFIX}notes.v1`;
  const ANALYSIS_STORAGE_KEY = `${STORAGE_PREFIX}analysis.v1`;
  const THRESHOLD_STORAGE_KEY = `${STORAGE_PREFIX}thresholds.v1`;
  const STAGE_STORAGE_KEY = `${STORAGE_PREFIX}stage.v1`;

  const MAIN_BLOCK_COUNT = 3;
  const MAIN_BLOCK_STAGES = Array.from({ length: MAIN_BLOCK_COUNT }, (_, idx) => ({
    id: `main-block-${idx + 1}`,
    label: `Main block ${idx + 1}`,
    protocolId: "main",
    action: `Run main trials for layout ${idx + 1}.`,
  }));
  const STUDY_STAGES = [
    {
      id: "consent",
      label: "Consent",
      protocolId: "consent",
      action: "Review consent and confirm participant agreement.",
    },
    {
      id: "device",
      label: "Device check",
      protocolId: "device",
      action: "Confirm device, browser, and input behavior.",
    },
    {
      id: "practice-brief",
      label: "Practice briefing",
      protocolId: "practice",
      action: "Explain the task and demonstrate the on-screen keyboard.",
    },
    {
      id: "practice-trials",
      label: "Practice trials",
      protocolId: "practice",
      action: "Run the practice trials in the typing prototype.",
    },
    {
      id: "main-brief",
      label: "Main briefing",
      protocolId: "main",
      action: "Confirm readiness and remind participants to prioritize accuracy.",
    },
    ...MAIN_BLOCK_STAGES,
    {
      id: "debrief",
      label: "Debrief",
      protocolId: "debrief",
      action: "Collect feedback and record final notes.",
    },
    {
      id: "nasa-tlx",
      label: "NASA-TLX",
      protocolId: "debrief",
      action: "Administer NASA-TLX and confirm the responses were saved.",
    },
    {
      id: "analysis",
      label: "Analysis",
      protocolId: null,
      action: "Import CSV data, run QC checks, and review warnings.",
    },
    {
      id: "export",
      label: "Export",
      protocolId: null,
      action: "Download the bundle for archiving or sharing.",
    },
  ];

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

  function loadTemplateState() {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    return raw ? safeParse(raw, null) : null;
  }

  function saveTemplateState(state) {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(state));
  }

  function loadNotesState() {
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    return raw ? String(raw) : "";
  }

  function saveNotesState(value) {
    localStorage.setItem(NOTES_STORAGE_KEY, String(value ?? ""));
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

  function loadStageIndex() {
    const raw = localStorage.getItem(STAGE_STORAGE_KEY);
    const idx = Number.parseInt(raw ?? "0", 10);
    return Number.isFinite(idx) && idx >= 0 ? Math.min(idx, STUDY_STAGES.length - 1) : 0;
  }

  function saveStageIndex(index) {
    localStorage.setItem(STAGE_STORAGE_KEY, String(index));
  }

  function renderStudyStepper(currentIndex) {
    const stepper = $("studyStepper");
    stepper.innerHTML = "";
    STUDY_STAGES.forEach((stage, idx) => {
      const step = document.createElement("button");
      step.type = "button";
      step.className = "step";
      if (idx < currentIndex) step.classList.add("stepDone");
      if (idx === currentIndex) step.classList.add("stepActive");
      step.textContent = stage.label;
      step.dataset.stageId = stage.id;
      step.addEventListener("click", () => {
        saveStageIndex(idx);
        updateStudyProgress();
      });
      stepper.appendChild(step);
    });
  }

  function updateStudyProgress() {
    const idx = loadStageIndex();
    renderStudyStepper(idx);
    const total = STUDY_STAGES.length;
    const pct = total > 1 ? Math.round((idx / (total - 1)) * 100) : 0;
    const fill = $("studyProgressFill");
    fill.style.width = `${pct}%`;
    const stage = STUDY_STAGES[idx] || STUDY_STAGES[0];
    $("studyProgressLabel").textContent = `Stage ${idx + 1} of ${total} • ${stage.label} (${total - idx - 1} left)`;
    const actionEl = $("studyAction");
    actionEl.innerHTML = stage?.action ? `<strong>Now:</strong> ${stage.action}` : "";
    actionEl.style.display = actionEl.textContent ? "block" : "none";
    highlightProtocolStep(stage);
  }

  function highlightProtocolStep(stage) {
    const targetId = stage?.protocolId;
    document.querySelectorAll(".protocolStep").forEach((card) => {
      const isMatch = targetId && card.dataset.protocolId === targetId;
      card.classList.toggle("protocolStepActive", isMatch);
      if (targetId) {
        card.open = isMatch;
      } else {
        card.open = false;
      }
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const temp = document.createElement("textarea");
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand("copy");
    temp.remove();
    return Promise.resolve();
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

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (!lines.length) return [];
    const headers = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
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
  }

  function toNumber(value, fallback = 0) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function computeAnalysis(rows, thresholds) {
    const byLayout = new Map();
    const participants = new Set();
    const layouts = new Set();
    const warnings = [];

    rows.forEach((row) => {
      const layoutId = row.layoutId || "unknown";
      const participantId = row.participantId || "unknown";
      participants.add(participantId);
      layouts.add(layoutId);

      if (!byLayout.has(layoutId)) {
        byLayout.set(layoutId, { layoutId, trials: 0, wpm: [], ed: [], err: [], elapsed: [] });
      }
      const bucket = byLayout.get(layoutId);
      bucket.trials += 1;
      const wpm = toNumber(row.wpm, null);
      const ed = toNumber(row.editDistance, null);
      const charCount = toNumber(row.charCount, null);
      const elapsedMs = toNumber(row.elapsedMs, null);
      if (wpm != null) bucket.wpm.push(wpm);
      if (ed != null) bucket.ed.push(ed);
      if (charCount > 0 && ed != null) bucket.err.push(ed / charCount);
      if (elapsedMs != null) bucket.elapsed.push(elapsedMs / 1000);

      if (elapsedMs > 0 && elapsedMs < thresholds.minElapsedMs) {
        warnings.push(`Short trial: ${layoutId} (${elapsedMs} ms)`);
      }
      if (charCount > 0 && ed != null && ed / charCount > thresholds.maxErrorRate) {
        warnings.push(`High error rate: ${layoutId} (${(ed / charCount).toFixed(2)})`);
      }
    });

    const layoutRows = [];
    for (const bucket of byLayout.values()) {
      const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      layoutRows.push({
        layoutId: bucket.layoutId,
        trials: bucket.trials,
        meanWpm: mean(bucket.wpm),
        meanEd: mean(bucket.ed),
        meanErr: mean(bucket.err),
        meanElapsed: mean(bucket.elapsed),
      });
      if (bucket.trials < thresholds.minTrials) {
        warnings.push(`Low trials for ${bucket.layoutId}: ${bucket.trials}`);
      }
    }

    return {
      layouts: layoutRows,
      layoutCount: layouts.size,
      participantCount: participants.size,
      warnings,
    };
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

  function renderWarnings(summary) {
    const container = $("analysisWarnings");
    container.innerHTML = "";
    summary.warnings.slice(0, 6).forEach((w) => {
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

  function initAnalysis() {
    const stored = loadAnalysisState();
    if (stored) {
      renderAnalysisSummary(stored.summary);
      renderEligibility(stored.summary, stored.thresholds);
      renderWarnings(stored.summary);
      renderAnalysisTable(stored.summary.layouts || []);
    }

    const fileInput = $("analysisFileInput");
    const excludeEl = $("analysisExcludePractice");
    const minTrialsEl = $("analysisMinTrials");
    const minElapsedEl = $("analysisMinElapsed");
    const maxErrorEl = $("analysisMaxErrorRate");
    const thresholds = loadThresholds();
    excludeEl.value = thresholds.excludePractice ? "true" : "false";
    minTrialsEl.value = thresholds.minTrials;
    minElapsedEl.value = thresholds.minElapsedMs;
    maxErrorEl.value = thresholds.maxErrorRate;

    $("runAnalysisBtn").addEventListener("click", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        $("analysisStatus").textContent = "Select a CSV file first.";
        return;
      }
      const text = await file.text();
      const rows = parseCsv(text);
      const excludePractice = excludeEl.value === "true";
      const filtered = excludePractice ? rows.filter((r) => String(r.isPractice).toLowerCase() !== "true") : rows;

      const nextThresholds = {
        excludePractice,
        minTrials: toNumber(minTrialsEl.value, 5),
        minElapsedMs: toNumber(minElapsedEl.value, 2000),
        maxErrorRate: toNumber(maxErrorEl.value, 0.4),
      };
      saveThresholds(nextThresholds);

      const summary = computeAnalysis(filtered, nextThresholds);
      const payload = { summary, thresholds: nextThresholds, updatedAtMs: Date.now() };
      saveAnalysisState(payload);
      renderAnalysisSummary(summary);
      renderEligibility(summary, nextThresholds);
      renderWarnings(summary);
      renderAnalysisTable(summary.layouts || []);
      $("analysisStatus").textContent = "Analysis updated.";
    });

    $("downloadSummaryBtn").addEventListener("click", () => {
      const state = loadAnalysisState();
      if (!state) return;
      const rows = state.summary.layouts || [];
      const header = "layoutId,trials,meanWpm,meanEditDistance,meanErrorRate,meanElapsedSeconds";
      const lines = rows.map(
        (r) =>
          `${r.layoutId},${r.trials},${r.meanWpm.toFixed(2)},${r.meanEd.toFixed(2)},${r.meanErr.toFixed(3)},${r.meanElapsed.toFixed(2)}`
      );
      downloadFile("analysis_summary.csv", [header, ...lines].join("\n"));
    });

    $("downloadReportSnippetBtn").addEventListener("click", () => {
      const state = loadAnalysisState();
      if (!state) return;
      const summary = state.summary;
      const snippet = `## Study results summary\n\n- Participants: ${summary.participantCount}\n- Layouts: ${summary.layoutCount}\n- Warnings: ${summary.warnings.length}\n\nGenerated by the study analysis tool.\n`;
      downloadFile("report_snippet.md", snippet);
    });
  }

  function renderTemplates(templates) {
    const container = $("studySections");
    container.innerHTML = "";

    for (const key of ns.studyTemplates.TEMPLATE_ORDER) {
      const meta = ns.studyTemplates.TEMPLATE_META[key];
      const value = templates[key] ?? "";

      const section = document.createElement("div");
      section.className = "studySection";
      section.dataset.templateId = key;
      section.innerHTML = `
        <div class="studyHeader">
          <div>
            <div class="studyTitle">${meta.title}</div>
            <div class="hint">${meta.description}</div>
          </div>
          <div class="studyButtons">
            <button class="btn btnSecondary" data-action="copy">Copy</button>
            <button class="btn btnSecondary" data-action="download">Download</button>
            <button class="btn btnDanger" data-action="reset">Reset</button>
          </div>
        </div>
        <textarea class="studyTextarea" rows="10">${escapeHtml(value)}</textarea>
      `;

      container.appendChild(section);
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function readTemplatesFromUi() {
    const templates = {};
    const sections = document.querySelectorAll(".studySection");
    sections.forEach((section) => {
      const id = section.dataset.templateId;
      const textarea = section.querySelector("textarea");
      if (id && textarea) templates[id] = textarea.value;
    });
    return templates;
  }

  function getTemplateFilename(id) {
    const meta = ns.studyTemplates.TEMPLATE_META[id];
    return meta ? meta.filename : `${id}.txt`;
  }

  function initTemplateEvents() {
    $("studySections").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const section = e.target.closest(".studySection");
      if (!section) return;
      const id = section.dataset.templateId;
      const textarea = section.querySelector("textarea");
      if (!id || !textarea) return;

      const action = btn.dataset.action;
      if (action === "copy") {
        copyToClipboard(textarea.value);
      } else if (action === "download") {
        downloadFile(getTemplateFilename(id), textarea.value);
      } else if (action === "reset") {
        const defaults = ns.studyTemplates.getDefaultTemplates();
        textarea.value = defaults[id] ?? "";
        persistTemplates();
      }
    });

    $("studySections").addEventListener("input", (e) => {
      if (e.target.tagName === "TEXTAREA") {
        persistTemplates();
        refreshProtocolText();
      }
    });
  }

  function persistTemplates() {
    const templates = readTemplatesFromUi();
    saveTemplateState(templates);
  }

  function initProtocolFlow() {
    const steps = [
      { id: "consent", title: "Consent", templateKey: "consent" },
      { id: "device", title: "Device check", templateKey: "device_check" },
      { id: "practice", title: "Practice", templateKey: "participant_instructions" },
      { id: "main", title: "Main trials", templateKey: "participant_instructions" },
      { id: "debrief", title: "Debrief", templateKey: "participant_instructions" },
    ];
    const container = $("protocolFlow");
    container.innerHTML = "";
    steps.forEach((step) => {
      const card = document.createElement("details");
      card.className = "protocolStep";
      card.dataset.protocolId = step.id;
      card.innerHTML = `
        <summary class="protocolSummary">${step.title}</summary>
        <div class="protocolBody">
          <div class="studyButtons">
            <button class="btn btnSecondary" data-protocol-copy="${step.templateKey}">Copy text</button>
            <button class="btn btnSecondary" data-protocol-open="${step.templateKey}">Open in new window</button>
          </div>
          <div class="protocolText" data-protocol-text="${step.templateKey}"></div>
        </div>
      `;
      container.appendChild(card);
    });

    container.addEventListener("click", (e) => {
      const copyBtn = e.target.closest("button[data-protocol-copy]");
      const openBtn = e.target.closest("button[data-protocol-open]");
      if (!copyBtn && !openBtn) return;
      const key = copyBtn ? copyBtn.dataset.protocolCopy : openBtn.dataset.protocolOpen;
      const templates = readTemplatesFromUi();
      const text = templates[key] ?? "";
      if (copyBtn) {
        copyToClipboard(text);
      } else if (openBtn) {
        const win = window.open("", "_blank");
        if (win) {
          win.document.write(`<pre style="white-space: pre-wrap; font-family: sans-serif;">${escapeHtml(text)}</pre>`);
          win.document.close();
        }
      }
    });

    refreshProtocolText();
  }

  function refreshProtocolText() {
    const templates = readTemplatesFromUi();
    document.querySelectorAll("[data-protocol-text]").forEach((el) => {
      const key = el.dataset.protocolText;
      el.textContent = templates[key] ?? "";
    });
  }

  function initSessionNotes() {
    const el = $("sessionNotes");
    el.value = loadNotesState();
    el.addEventListener("input", () => saveNotesState(el.value));
  }

  function buildZipBundle() {
    if (!window.fflate) throw new Error("fflate library not loaded");
    const templates = readTemplatesFromUi();
    const analysis = loadAnalysisState();
    const thresholds = loadThresholds();
    const notes = loadNotesState();

    const zipData = {};
    for (const id of ns.studyTemplates.TEMPLATE_ORDER) {
      const filename = getTemplateFilename(id);
      zipData[filename] = new TextEncoder().encode(templates[id] ?? "");
    }
    zipData["study/session_notes.txt"] = new TextEncoder().encode(notes || "");
    zipData["analysis/summary.json"] = new TextEncoder().encode(JSON.stringify(analysis ?? {}, null, 2));
    zipData["analysis/qc_thresholds.json"] = new TextEncoder().encode(JSON.stringify(thresholds ?? {}, null, 2));

    const zip = window.fflate.zipSync(zipData, { level: 6 });
    return zip;
  }

  function initBundleExport() {
    $("downloadBundleBtn").addEventListener("click", () => {
      try {
        const zip = buildZipBundle();
        const blob = new Blob([zip], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `study_assets_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 500);
        $("bundleStatus").textContent = "Bundle downloaded.";
      } catch (err) {
        $("bundleStatus").textContent = `Bundle failed: ${err instanceof Error ? err.message : err}`;
      }
    });
  }

  function init() {
    const storedTemplates = loadTemplateState();
    const templates = storedTemplates || ns.studyTemplates.getDefaultTemplates();
    renderTemplates(templates);
    initTemplateEvents();
    initProtocolFlow();
    initSessionNotes();
    initBundleExport();
    initAnalysis();
    updateStudyProgress();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
