(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  function resolveDistanceMode(params) {
    const useCenter = params?.useCenter !== undefined ? !!params.useCenter : true;
    const useEdge = params?.useEdge !== undefined ? !!params.useEdge : true;
    // Defensive fallback: callers/UI should prevent this, but avoid returning null everywhere.
    if (!useCenter && !useEdge) return { useCenter: true, useEdge: false };
    return { useCenter, useEdge };
  }

  function distanceBetweenKeys(aKey, bKey, params) {
    const { useCenter, useEdge } = resolveDistanceMode(params);
    if (useCenter && useEdge) return ns.layouts.mixedDistance(aKey, bKey);
    if (useCenter) return ns.layouts.centerDistance(aKey, bKey);
    return ns.layouts.rectDistance(aKey, bKey);
  }

  function charToKeyId(ch) {
    if (ch === " ") return "space";
    const lower = String(ch).toLowerCase();
    if (lower.length !== 1) return null;
    const code = lower.charCodeAt(0);
    if (code >= 97 && code <= 122) return lower; // a-z
    return null;
  }

  /**
   * Total time model:
   * - + tapTimeMs per character
   * - + moveMsPerUnit * distance(prevKey, nextKey) per transition
   *
   * distance(prevKey, nextKey) is controlled by params:
   * - useCenter: include center-to-center Euclidean distance (default: true)
   * - useEdge: include edge-to-edge Euclidean distance between key rectangles (0 if touching/overlapping) (default: true)
   * If both are enabled, distance = average(center, edge).
   */
  function estimatePhraseTime(layout, phrase, params) {
    const tapTimeMs = params?.tapTimeMs ?? 140;
    const moveMsPerUnit = params?.moveMsPerUnit ?? 35;

    let totalMs = 0;
    let totalChars = 0;
    let prevKeyId = null;

    for (const ch of String(phrase ?? "")) {
      const keyId = charToKeyId(ch);
      if (!keyId) continue;

      totalMs += tapTimeMs;
      totalChars += 1;

      if (prevKeyId != null) {
        const a = ns.layouts.getKey(layout, prevKeyId);
        const b = ns.layouts.getKey(layout, keyId);
        const d = distanceBetweenKeys(a, b, params);
        if (d != null) totalMs += moveMsPerUnit * d;
      }

      prevKeyId = keyId;
    }

    return { totalMs, totalChars };
  }

  function estimateLayout(layout, phrases, params) {
    let sumMs = 0;
    let sumChars = 0;
    for (const p of phrases) {
      const { totalMs, totalChars } = estimatePhraseTime(layout, p, params);
      sumMs += totalMs;
      sumChars += totalChars;
    }
    const predictedWpm = ns.metrics.computeWpm(sumChars, sumMs);
    const avgMsPerChar = sumChars > 0 ? sumMs / sumChars : 0;
    return { predictedWpm, avgMsPerChar, sumMs, sumChars };
  }

  /**
   * Estimate layout speed from a bigram model (letters + space).
   *
   * corpus:
   * - { alphabet: string, countsFlat: number[], totalBigrams: number }
   *
   * Interpretation:
   * - We compute expected movement distance over bigrams (prevChar -> nextChar)
   * - Time per character ~= tapTimeMs + moveMsPerUnit * E[distance]
   * - Convert ms/char to WPM using the same 5-chars-per-word convention.
   */
  function estimateLayoutFromBigramCounts(layout, corpus, params) {
    const tapTimeMs = params?.tapTimeMs ?? 140;
    const moveMsPerUnit = params?.moveMsPerUnit ?? 35;

    const alphabet = String(corpus?.alphabet ?? "");
    const countsFlat = corpus?.countsFlat;
    const totalBigrams = Number(corpus?.totalBigrams ?? 0);

    if (!alphabet || !Array.isArray(countsFlat) || alphabet.length * alphabet.length !== countsFlat.length) {
      throw new Error("Invalid bigram corpus: expected {alphabet, countsFlat} with K*K entries");
    }
    if (!Number.isFinite(totalBigrams) || totalBigrams <= 0) {
      throw new Error("Invalid bigram corpus: totalBigrams must be > 0");
    }

    const K = alphabet.length;
    const keys = new Array(K);
    for (let i = 0; i < K; i++) {
      const ch = alphabet[i];
      const keyId = ch === " " ? "space" : ch;
      keys[i] = ns.layouts.getKey(layout, keyId);
    }

    let distSum = 0;
    let usedCount = 0;

    for (let a = 0; a < K; a++) {
      const ka = keys[a];
      if (!ka) continue;
      for (let b = 0; b < K; b++) {
        const c = countsFlat[a * K + b] || 0;
        if (c <= 0) continue;
        const kb = keys[b];
        if (!kb) continue;
        const d = distanceBetweenKeys(ka, kb, params);
        if (d == null) continue;
        distSum += c * d;
        usedCount += c;
      }
    }

    const expDist = usedCount > 0 ? distSum / usedCount : 0;
    const avgMsPerChar = tapTimeMs + moveMsPerUnit * expDist;
    const predictedWpm = ns.metrics.computeWpm(1, avgMsPerChar);

    return {
      predictedWpm,
      avgMsPerChar,
      expDist,
      usedBigrams: usedCount,
      totalBigrams,
      coverage: usedCount / totalBigrams,
    };
  }

  /**
   * Estimate layout speed from a bigram model (letters + space) using Shannon Fitts' Law.
   *
   * corpus:
   * - { alphabet: string, countsFlat: number[], totalBigrams: number }
   *
   * Movement time per bigram (a -> b):
   * - D = selected distance metric (center, edge, or average of both)
   * - W_eff = |dx|/D * w_b + |dy|/D * h_b (directional projection for rectangular target)
   * - ID = log2(D / W_eff + 1)
   * - MT = fittsAms + fittsBms * ID
   *
   * Avg time per char ~= tapTimeMs + E[MT]
   */
  function estimateLayoutFromBigramCountsFitts(layout, corpus, params) {
    const tapTimeMs = params?.tapTimeMs ?? 140;
    const fittsAms = params?.fittsAms ?? 50;
    const fittsBms = params?.fittsBms ?? 100;
    const eps = params?.eps ?? 1e-6;

    const alphabet = String(corpus?.alphabet ?? "");
    const countsFlat = corpus?.countsFlat;
    const totalBigrams = Number(corpus?.totalBigrams ?? 0);

    if (!alphabet || !Array.isArray(countsFlat) || alphabet.length * alphabet.length !== countsFlat.length) {
      throw new Error("Invalid bigram corpus: expected {alphabet, countsFlat} with K*K entries");
    }
    if (!Number.isFinite(totalBigrams) || totalBigrams <= 0) {
      throw new Error("Invalid bigram corpus: totalBigrams must be > 0");
    }
    if (!Number.isFinite(eps) || eps <= 0) {
      throw new Error("Invalid params: eps must be > 0");
    }

    const { useCenter, useEdge } = resolveDistanceMode(params);

    const K = alphabet.length;
    const keys = new Array(K);
    const centers = new Array(K);
    for (let i = 0; i < K; i++) {
      const ch = alphabet[i];
      const keyId = ch === " " ? "space" : ch;
      const k = ns.layouts.getKey(layout, keyId);
      keys[i] = k;
      centers[i] = k ? { cx: k.x + k.w / 2, cy: k.y + k.h / 2 } : null;
    }

    let mtSum = 0;
    let usedCount = 0;

    for (let a = 0; a < K; a++) {
      const ca = centers[a];
      const ka = keys[a];
      if (!ca || !ka) continue;
      for (let b = 0; b < K; b++) {
        const c = countsFlat[a * K + b] || 0;
        if (c <= 0) continue;
        const cb = centers[b];
        const kb = keys[b];
        if (!cb || !kb) continue;

        const dx = cb.cx - ca.cx;
        const dy = cb.cy - ca.cy;
        const Dcenter = Math.sqrt(dx * dx + dy * dy);

        let Dedge = 0;
        if (useEdge) {
          Dedge = ns.layouts.rectDistance(ka, kb);
          if (Dedge == null) continue;
        }

        let D = 0;
        if (useCenter && useEdge) D = 0.5 * (Dcenter + Dedge);
        else if (useCenter) D = Dcenter;
        else D = Dedge;

        let wEff = 0;
        if (Dcenter > eps) {
          wEff = (Math.abs(dx) / Dcenter) * kb.w + (Math.abs(dy) / Dcenter) * kb.h;
        } else {
          wEff = Math.sqrt(kb.w * kb.h);
        }
        wEff = Math.max(wEff, eps);

        const id = Math.log2(D / wEff + 1);
        const mt = fittsAms + fittsBms * id;

        mtSum += c * mt;
        usedCount += c;
      }
    }

    const expMt = usedCount > 0 ? mtSum / usedCount : 0;
    const avgMsPerChar = tapTimeMs + expMt;
    const predictedWpm = ns.metrics.computeWpm(1, avgMsPerChar);

    return {
      predictedWpm,
      avgMsPerChar,
      expMt,
      usedBigrams: usedCount,
      totalBigrams,
      coverage: usedCount / totalBigrams,
    };
  }

  ns.theory = ns.theory || {};
  ns.theory.distanceLinear = {
    estimatePhraseTime,
    estimateLayout,
    estimateLayoutFromBigramCounts,
    estimateLayoutFromBigramCountsFitts,
  };
})();

