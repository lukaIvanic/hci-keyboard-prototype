(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  function nowMs() {
    return Date.now();
  }

  function createTrialLog({ trialId, layoutId, phraseId, target }) {
    return {
      trialId,
      layoutId,
      phraseId,
      target,

      typed: "",
      events: [],

      startTimeMs: null,
      endTimeMs: null,
      elapsedMs: null,

      keypressCount: 0,
      backspaceCount: 0,

      _startPerfMs: null,

      startIfNeeded() {
        if (this._startPerfMs != null) return;
        this._startPerfMs = performance.now();
        this.startTimeMs = nowMs();
      },

      logKey(keyId, kind) {
        this.startIfNeeded();
        const tMs = performance.now() - this._startPerfMs;
        this.events.push({ tMs, keyId, kind });
        if (kind !== "miss") this.keypressCount += 1;
        if (kind === "backspace") this.backspaceCount += 1;
      },

      finish(finalTyped) {
        if (this._startPerfMs == null) return false; // nothing happened
        this.endTimeMs = nowMs();
        this.elapsedMs = performance.now() - this._startPerfMs;
        this.typed = String(finalTyped ?? "");
        return true;
      },
    };
  }

  function createSession() {
    return {
      trials: [],
      addTrial(trialLog) {
        this.trials.push(trialLog);
      },
      clear() {
        this.trials = [];
      },
    };
  }

  ns.logger = {
    createTrialLog,
    createSession,
  };
})();

