(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  function computeWpm(charCount, elapsedMs) {
    if (!Number.isFinite(charCount) || !Number.isFinite(elapsedMs)) return 0;
    if (elapsedMs <= 0) return 0;
    const minutes = elapsedMs / 1000 / 60;
    return (charCount / 5) / minutes;
  }

  // Levenshtein edit distance (character-level).
  function editDistance(a, b) {
    const s = String(a ?? "");
    const t = String(b ?? "");
    const n = s.length;
    const m = t.length;
    if (n === 0) return m;
    if (m === 0) return n;

    // Use two rows to keep it small.
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

  function roundTo(value, decimals) {
    const p = Math.pow(10, decimals);
    return Math.round(value * p) / p;
  }

  ns.metrics = {
    computeWpm,
    editDistance,
    roundTo,
  };
})();

