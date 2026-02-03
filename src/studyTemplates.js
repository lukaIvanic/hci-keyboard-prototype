(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  const TEMPLATE_ORDER = [
    "consent",
    "participant_instructions",
    "session_checklist",
    "device_check",
    "analysis_guide",
    "summary_template",
    "package_checklist",
    "memorandum_template",
  ];

  const TEMPLATE_META = {
    consent: { title: "Consent", description: "Consent script for participants.", filename: "study/consent.md", type: "markdown" },
    participant_instructions: {
      title: "Participant Instructions",
      description: "Instructions shown or read to participants.",
      filename: "study/participant_instructions.md",
      type: "markdown",
    },
    session_checklist: {
      title: "Session Checklist",
      description: "Operator checklist before/during/after a session.",
      filename: "study/session_checklist.md",
      type: "markdown",
    },
    device_check: {
      title: "Device Check",
      description: "Device readiness and optional calibration guidance.",
      filename: "study/device_check.md",
      type: "markdown",
    },
    analysis_guide: {
      title: "Analysis Guide",
      description: "Recommended metrics and analysis workflow.",
      filename: "analysis/analysis_guide.md",
      type: "markdown",
    },
    summary_template: {
      title: "Summary Template",
      description: "CSV template for recording analysis summary metrics.",
      filename: "analysis/summary_template.csv",
      type: "csv",
    },
    package_checklist: {
      title: "Package Checklist",
      description: "Checklist aligned to project submission requirements.",
      filename: "package_checklist.md",
      type: "markdown",
    },
    memorandum_template: {
      title: "Project Memorandum",
      description: "One-page memorandum template for submission.",
      filename: "project_package/memorandum_template.md",
      type: "markdown",
    },
  };

  const DEFAULT_TEMPLATES = {
    consent: `# Consent Script (Template)\n\n## Summary\nYou are invited to take part in a study evaluating on-screen keyboard layouts. The task involves copy-typing short phrases on a virtual keyboard. The session takes about 10-15 minutes.\n\n## What you will do\n- Read a short set of instructions.\n- Complete a few practice trials.\n- Type phrases on multiple keyboard layouts.\n- Finish the session and confirm any questions.\n\n## Risks and privacy\n- There are no known risks beyond normal computer use.\n- We record typing performance metrics (speed, errors) and timing.\n- We do not collect personally identifying information unless you choose to provide a participant code.\n\n## Voluntary participation\n- Your participation is voluntary and you may stop at any time.\n\n## Consent statement\nBy proceeding, you confirm that you understand the task and agree to participate.\n`,
    participant_instructions: `# Participant Instructions (Template)\n\n## Overview\nYou will copy-type short phrases using an on-screen keyboard. Accuracy is more important than speed, but try to type naturally.\n\n## During the session\n- Use the on-screen keys only (do not use a physical keyboard).\n- If you make a mistake, use the backspace key to correct it.\n- Complete the practice trials to get familiar with the layout.\n- Continue until the session is finished.\n\n## After the session\n- Complete a short NASA-TLX workload questionnaire (about 2-4 minutes).\n\n## Tips\n- Focus on accuracy; speed will follow.\n- Keep a consistent posture and distance from the screen.\n\n## Questions\nIf you are unsure about anything, ask the study operator before starting.\n`,
    session_checklist: `# Session Checklist (Operator)\n\n## Before the session\n- Confirm participant code and condition label.\n- Verify device and browser version.\n- Confirm layout order and seed (if seeded).\n- Confirm practice trial count and trials per layout.\n\n## During the session\n- Start the experiment and observe that practice trials appear first.\n- Ensure the participant understands how to correct errors.\n- Monitor for fatigue and allow short breaks if needed.\n\n## After the session\n- Administer NASA-TLX and confirm it was saved.\n- Export CSV and JSON.\n- Record any anomalies or interruptions.\n- Save files in the designated project package folders.\n`,
    device_check: `# Device Check and Calibration (Template)\n\n## Device check\n- Use a modern browser (Chrome, Edge, or Firefox).\n- Ensure the viewport is at least 1024px wide for consistent layout.\n- Disable zoom (set to 100%).\n- Lock device orientation if using a tablet.\n\n## Optional calibration step\n- Ask the participant to tap each corner key once (Q, P, Z, M).\n- Confirm the touch target size feels comfortable and no key overlaps occur.\n- If taps are difficult, note the device and adjust later in analysis.\n`,
    analysis_guide: `# Analysis Guide (Template)\n\n## Inputs\nUse the exported CSV file from the app. The CSV contains trial rows with session metadata.\n\nKey fields:\n- \`participantId\`, \`condition\`, \`layoutId\`, \`layoutIndex\`\n- \`isPractice\` (filter out practice trials for main analysis)\n- \`wpm\`, \`editDistance\`, \`elapsedMs\`\n\n## Recommended metrics\n- Mean WPM per layout (exclude practice).\n- Mean edit distance per layout (exclude practice).\n- Error rate: editDistance / charCount.\n- Trial completion time in seconds.\n\n## Suggested workflow\n1. Filter \`isPractice = false\`.\n2. Group by \`participantId\` and \`layoutId\`.\n3. Compute mean WPM and mean error rate.\n4. Compare layouts using paired tests if the same participants completed all layouts.\n\n## Quick summary script\nUse the included script to generate a simple session summary:\n\n\`\`\`\npython analysis/compute_summary.py path/to/export.csv --output summary_out.csv\n\`\`\`\n\n## Quality checks\n- Flag unusually short \`elapsedMs\` (possible accidental submissions).\n- Flag sessions missing a layout or with very few trials.\n`,
    summary_template: `metric,value,note\nmean_wpm,,\nmean_edit_distance,,\nmean_error_rate,,\nmean_elapsed_seconds,,\noutlier_trials,,\n`,
    package_checklist: `# Project Package Checklist\n\nThis checklist mirrors the professor's submission requirements.\n\nRequired contents (single ZIP archive):\n- Project code (zipped).\n- Raw data from experiments (CSV/JSON exports).\n- Analysis outputs (spreadsheets or scripts and results).\n- Report in English (PDF + source, e.g., DOCX/LaTeX).\n- Presentation slides (PPTX/PDF).\n- Any demo media (screenshots/video) if live demo is difficult.\n- A one-page project memorandum (template included).\n\nNaming suggestions:\n- Use clear folder names (code/, data_raw/, analysis/, report/, slides/, media/).\n- Include dates in filenames for traceability.\n`,
    memorandum_template: `# Project Memorandum (Template)\n\n## Project title\n\n## Team members\n- Name, role\n- Name, role\n\n## Environment and setup\n- Hardware: (laptop model, screen size, input device)\n- Software: (OS, browser version)\n- Required files: (e.g., \`index.html\`, \`generator.html\`)\n\n## How to run the experiment\n1. Open \`index.html\` in a browser.\n2. Set participant ID and condition.\n3. Choose layout order and trial counts.\n4. Start the experiment and complete all trials.\n5. Export CSV and JSON.\n\n## Notes\n- Any known limitations or special instructions.\n`,
  };

  function getDefaultTemplates() {
    return JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
  }

  function applyFormData(templates, formData) {
    const data = { ...formData };
    const title = data.projectTitle ? String(data.projectTitle) : "";
    const members = data.teamMembers ? String(data.teamMembers) : "";
    const hardware = data.hardware ? String(data.hardware) : "";
    const software = data.software ? String(data.software) : "";
    const sessionLength = data.sessionLength ? String(data.sessionLength) : "";
    const contact = data.contact ? String(data.contact) : "";

    if (title) {
      templates.memorandum_template = templates.memorandum_template.replace("## Project title", `## Project title\n${title}`);
    }
    if (members) {
      templates.memorandum_template = templates.memorandum_template.replace(
        "## Team members\n- Name, role\n- Name, role",
        `## Team members\n${members
          .split(",")
          .map((m) => `- ${m.trim()}`)
          .filter(Boolean)
          .join("\n")}`
      );
    }
    if (hardware || software) {
      const lines = [
        "## Environment and setup",
        `- Hardware: ${hardware || "(laptop model, screen size, input device)"}`,
        `- Software: ${software || "(OS, browser version)"}`,
        "- Required files: (e.g., `index.html`, `generator.html`)",
      ];
      templates.memorandum_template = templates.memorandum_template.replace(
        "## Environment and setup\n- Hardware: (laptop model, screen size, input device)\n- Software: (OS, browser version)\n- Required files: (e.g., `index.html`, `generator.html`)",
        lines.join("\n")
      );
    }

    if (sessionLength || contact) {
      const summary = `The session takes about ${sessionLength || "10-15 minutes"}.`;
      templates.consent = templates.consent.replace(
        "The session takes about 10-15 minutes.",
        summary
      );
      if (contact) {
        templates.consent += `\n## Contact\nIf you have questions, contact: ${contact}\n`;
      }
    }

    return templates;
  }

  ns.studyTemplates = {
    TEMPLATE_ORDER,
    TEMPLATE_META,
    DEFAULT_TEMPLATES,
    getDefaultTemplates,
    applyFormData,
  };
})();
