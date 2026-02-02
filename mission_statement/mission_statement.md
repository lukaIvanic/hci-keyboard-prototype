# Mission Statement

## Project goal
Build a lightweight, no-build, browser-based HCI prototype that lets researchers and designers:
- Compare keyboard layouts through repeatable copy-typing trials.
- Measure performance and errors in a way that is simple to export and analyze.
- Generate candidate layouts using a transparent, explainable model.
- Run studies quickly in the field without setup complexity or backend dependencies.

## What success looks like
- A participant can complete a session end-to-end in a single browser tab.
- The operator can configure experiment parameters, run the session, and export data without external tools.
- The system makes layout evaluation reproducible (fixed or seeded order) and records enough context to interpret results later.
- The generator and theoretical models are clearly connected to how layouts are scored, so results are interpretable.

## How the current app follows the mission
- **Low friction:** Everything runs as static HTML/JS, works from `file://`, and needs no build step.
- **Study-ready flow:** There is a dedicated experiment panel with configurable practice/trial counts, layout order modes, and a running status.
- **Measurable outcomes:** Trials capture WPM, edit distance, backspaces, timings, and event logs.
- **Reproducibility:** Session metadata (participant, condition, order mode/seed, layout order) is exported for analysis.
- **Generator integration:** A GA generator scores layouts using a clear Fitts-based model and exports candidate layouts for testing.

## Where we only partially meet the mission
- **Participant guidance:** The UI includes controls but does not yet provide rich in-context explanations beyond info icons.
- **Analysis workflow:** Exports are detailed, but there are no in-app summaries, charts, or post-session QA checks.
- **Protocol support:** The app does not yet include consent language, standardized instructions, or time-on-task checkpoints.
- **Cross-device reliability:** Mobile input constraints are handled, but there are no device calibration steps or adaptive UI for small screens.

## High-level gaps to close
- Add clearer operator guidance and standardized study instructions.
- Provide lightweight in-app summaries (session averages, error rates, outliers).
- Offer optional protocol steps (consent, break reminders, device checks).
- Improve small-screen layout and tooltip behavior for touch devices.
