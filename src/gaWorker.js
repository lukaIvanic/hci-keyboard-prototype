/* global importScripts, self */
(function () {
  "use strict";

  // Provide a window alias for shared scripts.
  self.window = self;

  // Load shared modules (relative to this worker script).
  importScripts("layouts.js", "metrics.js", "theoryDistanceLinear.js", "../corpus/gutenberg/pg1342_bigrams.js");

  const ns = self.KbdStudy;

  const INTEGER_SIZE_RANGE = { min: 1, max: 5 };

  let keys = null;
  let target = null;
  let sizePenalty = { refDim: 0.85, strengthMs: 55, eps: 1e-6 };

  function clampInt(x, min, max) {
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function quantizeSizeArray(arr, min, max) {
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = clampInt(Math.round(arr[i]), min, max);
    return out;
  }

  function buildSpec(genome, sizesMode) {
    const spec = {
      id: "sp_candidate",
      name: "Candidate",
      keys,
      seqA: genome.seqA,
      seqB: genome.seqB,
    };

    if (sizesMode === "random") {
      spec.wRaw = genome.wRaw;
      spec.hRaw = genome.hRaw;
    } else if (sizesMode === "integer") {
      spec.wRaw = quantizeSizeArray(genome.wRaw, INTEGER_SIZE_RANGE.min, INTEGER_SIZE_RANGE.max);
      spec.hRaw = quantizeSizeArray(genome.hRaw, INTEGER_SIZE_RANGE.min, INTEGER_SIZE_RANGE.max);
    }

    return spec;
  }

  self.addEventListener("message", (e) => {
    const data = e.data || {};
    if (data.type === "init") {
      keys = data.keys || null;
      target = data.target || null;
      if (data.sizePenalty) sizePenalty = data.sizePenalty;
      return;
    }

    if (data.type === "evaluate") {
      const id = data.id;
      const genomes = Array.isArray(data.genomes) ? data.genomes : [];
      const sizesMode = String(data.sizesMode || "fixed");
      const theoryParams = data.theoryParams || {};

      const out = [];
      for (const genome of genomes) {
        if (!genome) {
          out.push(null);
          continue;
        }

        let layout = null;
        try {
          const spec = buildSpec(genome, sizesMode);
          layout = ns.layouts.compileSequencePair(spec, target);
        } catch {
          out.push(null);
          continue;
        }

        const base = ns.theory.distanceLinear.estimateLayoutFromBigramCountsFitts(layout, ns.corpus.gutenberg, theoryParams);
        if (!base || !Number.isFinite(base.avgMsPerChar)) {
          out.push(null);
          continue;
        }
        let minDim = Infinity;
        for (const k of layout.keys) minDim = Math.min(minDim, Math.min(k.w, k.h));
        if (!Number.isFinite(minDim)) minDim = 0;

        let penaltyMs = 0;
        if (minDim > 0 && minDim < sizePenalty.refDim) {
          const inv = 1 / Math.max(minDim, sizePenalty.eps);
          const invRef = 1 / sizePenalty.refDim;
          penaltyMs = sizePenalty.strengthMs * Math.max(0, inv - invRef);
        }

        const avgMsPerChar = base.avgMsPerChar + penaltyMs;
        const predictedWpm = ns.metrics.computeWpm(1, avgMsPerChar);

        out.push({ predictedWpm, avgMsPerChar, layout, genome });
      }

      self.postMessage({ type: "evaluated", id, evaluations: out });
    }
  });
})();
