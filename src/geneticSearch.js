(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  function clamp(x, min, max) {
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function randInt(minInclusive, maxExclusive) {
    return minInclusive + Math.floor(Math.random() * (maxExclusive - minInclusive));
  }

  function range1(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i + 1;
    return out;
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(0, i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function randomPermutation(n) {
    return shuffleInPlace(range1(n));
  }

  // Order crossover (OX1) for permutations of 1..n.
  function orderCrossover(p1, p2) {
    const n = p1.length;
    const a = randInt(0, n);
    const b = randInt(0, n);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    const child = new Array(n).fill(0);
    const used = new Array(n + 1).fill(false);

    for (let i = lo; i <= hi; i++) {
      const v = p1[i];
      child[i] = v;
      used[v] = true;
    }

    let write = 0;
    for (let i = 0; i < n; i++) {
      const v = p2[i];
      if (used[v]) continue;
      while (write >= lo && write <= hi) write = hi + 1;
      child[write] = v;
      write += 1;
    }

    return child;
  }

  function mutateSwap(seq) {
    const n = seq.length;
    if (n < 2) return seq;
    const i = randInt(0, n);
    let j = randInt(0, n);
    if (j === i) j = (j + 1) % n;
    const t = seq[i];
    seq[i] = seq[j];
    seq[j] = t;
    return seq;
  }

  function mutateInvert(seq) {
    const n = seq.length;
    if (n < 3) return mutateSwap(seq);
    const a = randInt(0, n);
    const b = randInt(0, n);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let i = lo;
    let j = hi;
    while (i < j) {
      const t = seq[i];
      seq[i] = seq[j];
      seq[j] = t;
      i += 1;
      j -= 1;
    }
    return seq;
  }

  function uniformCrossoverNumbers(a, b) {
    const n = a.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.random() < 0.5 ? a[i] : b[i];
    return out;
  }

  function randomNumberArray(n, minInclusive, maxInclusive) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = minInclusive + Math.random() * (maxInclusive - minInclusive);
    }
    return out;
  }

  function mutateNumberArray(arr, mutationRate, minInclusive, maxInclusive, stepScale) {
    for (let i = 0; i < arr.length; i++) {
      if (Math.random() > mutationRate) continue;
      // Small symmetric perturbation.
      const delta = (Math.random() * 2 - 1) * stepScale;
      arr[i] = clamp(arr[i] + delta, minInclusive, maxInclusive);
    }
    return arr;
  }

  function genomeKey(genome, includeSizes) {
    // Compact-enough stable signature for memoization.
    // - permutations are integers, join is fine for n~28
    // - sizes are rounded to 4 decimals to avoid floating noise exploding cache keys
    const a = genome.seqA.join(",");
    const b = genome.seqB.join(",");
    if (!includeSizes) return `A:${a}|B:${b}`;
    const w = genome.wRaw.map((x) => Math.round(x * 10000)).join(",");
    const h = genome.hRaw.map((x) => Math.round(x * 10000)).join(",");
    return `A:${a}|B:${b}|W:${w}|H:${h}`;
  }

  function deepCopyGenome(genome, includeSizes) {
    const out = {
      seqA: genome.seqA.slice(),
      seqB: genome.seqB.slice(),
    };
    if (includeSizes) {
      out.wRaw = genome.wRaw.slice();
      out.hRaw = genome.hRaw.slice();
    }
    return out;
  }

  function hammingDistance(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1;
    return d;
  }

  /**
   * Steady-state GA for sequence-pair genomes.
   *
   * Returned individual objects are immutable (treat as read-only).
   */
  function createSequencePairGA(options) {
    if (!options || typeof options !== "object") throw new Error("createSequencePairGA(options): options is required");
    const n = Number(options.n);
    if (!Number.isInteger(n) || n <= 0) throw new Error("createSequencePairGA: options.n must be a positive integer");

    const includeSizes = !!options.includeSizes;
    const sizeMin = Number.isFinite(options.sizeMin) ? options.sizeMin : 0.8;
    const sizeMax = Number.isFinite(options.sizeMax) ? options.sizeMax : 1.6;
    const populationSize = Number.isInteger(options.populationSize) ? options.populationSize : 160;
    let eliteCount = Number.isInteger(options.eliteCount) ? options.eliteCount : 8;
    let tournamentK = Number.isInteger(options.tournamentK) ? options.tournamentK : 3;
    let crossoverRate = Number.isFinite(options.crossoverRate) ? options.crossoverRate : 0.9;
    let mutationRate = Number.isFinite(options.mutationRate) ? options.mutationRate : 0.35;
    let sizeMutationRate = Number.isFinite(options.sizeMutationRate) ? options.sizeMutationRate : 0.15;
    let immigrantRate = Number.isFinite(options.immigrantRate) ? options.immigrantRate : 0.03;
    const maxCacheSize = Number.isInteger(options.maxCacheSize) ? options.maxCacheSize : 1500;
    let replacementStrategy = options.replacementStrategy === "worst" ? "worst" : "rtr";
    let rtrWindow = Number.isInteger(options.rtrWindow) ? options.rtrWindow : 12;

    let population = []; // sorted desc by fitness
    let populationKeys = new Set(); // genomeKey(...) to prevent duplicates occupying population slots
    let evalCache = new Map(); // key -> { predictedWpm, avgMsPerChar, layout }
    let evaluations = 0;

    function eliteFloor() {
      return clamp(Math.round(eliteCount), 0, populationSize);
    }

    function getParams() {
      return {
        includeSizes,
        sizeMin,
        sizeMax,
        populationSize,
        eliteCount: eliteFloor(),
        tournamentK: clamp(Math.round(tournamentK), 1, 50),
        crossoverRate: clamp(crossoverRate, 0, 1),
        mutationRate: clamp(mutationRate, 0, 1),
        sizeMutationRate: clamp(sizeMutationRate, 0, 1),
        immigrantRate: clamp(immigrantRate, 0, 1),
        replacementStrategy,
        rtrWindow: clamp(Math.round(rtrWindow), 1, 200),
        maxCacheSize,
      };
    }

    function setParams(next) {
      if (!next || typeof next !== "object") return getParams();

      if (next.eliteCount != null) eliteCount = clamp(Math.round(next.eliteCount), 0, populationSize);
      if (next.tournamentK != null) tournamentK = clamp(Math.round(next.tournamentK), 1, 50);
      if (next.crossoverRate != null) crossoverRate = clamp(Number(next.crossoverRate), 0, 1);
      if (next.mutationRate != null) mutationRate = clamp(Number(next.mutationRate), 0, 1);
      if (next.sizeMutationRate != null) sizeMutationRate = clamp(Number(next.sizeMutationRate), 0, 1);
      if (next.immigrantRate != null) immigrantRate = clamp(Number(next.immigrantRate), 0, 1);

      if (next.replacementStrategy != null) {
        replacementStrategy = next.replacementStrategy === "worst" ? "worst" : "rtr";
      }
      if (next.rtrWindow != null) rtrWindow = clamp(Math.round(next.rtrWindow), 1, populationSize);

      return getParams();
    }

    function clear() {
      population = [];
      populationKeys = new Set();
      evalCache = new Map();
      evaluations = 0;
    }

    function randomGenome() {
      const g = {
        seqA: randomPermutation(n),
        seqB: randomPermutation(n),
      };
      if (includeSizes) {
        g.wRaw = randomNumberArray(n, sizeMin, sizeMax);
        g.hRaw = randomNumberArray(n, sizeMin, sizeMax);
      }
      return g;
    }

    function tournamentSelect() {
      // Assumes population is non-empty.
      const k = Math.min(tournamentK, population.length);
      let best = null;
      for (let i = 0; i < k; i++) {
        const idx = randInt(0, population.length);
        const cand = population[idx];
        if (!best || cand.predictedWpm > best.predictedWpm) best = cand;
      }
      return best;
    }

    function makeChildGenome(p1, p2) {
      const useCrossover = Math.random() < crossoverRate;
      const g = {};
      const g1 = p1.genome;
      const g2 = p2.genome;

      if (useCrossover) {
        g.seqA = orderCrossover(g1.seqA, g2.seqA);
        g.seqB = orderCrossover(g1.seqB, g2.seqB);
      } else {
        g.seqA = g1.seqA.slice();
        g.seqB = g1.seqB.slice();
      }

      if (Math.random() < mutationRate) {
        (Math.random() < 0.5 ? mutateSwap : mutateInvert)(g.seqA);
      }
      if (Math.random() < mutationRate) {
        (Math.random() < 0.5 ? mutateSwap : mutateInvert)(g.seqB);
      }

      if (includeSizes) {
        if (useCrossover) {
          g.wRaw = uniformCrossoverNumbers(g1.wRaw, g2.wRaw);
          g.hRaw = uniformCrossoverNumbers(g1.hRaw, g2.hRaw);
        } else {
          g.wRaw = g1.wRaw.slice();
          g.hRaw = g1.hRaw.slice();
        }

        // Mutate numeric genes slightly (bounded).
        mutateNumberArray(g.wRaw, sizeMutationRate, sizeMin, sizeMax, 0.12);
        mutateNumberArray(g.hRaw, sizeMutationRate, sizeMin, sizeMax, 0.12);
      }

      return g;
    }

    function cacheSet(key, value) {
      evalCache.set(key, value);
      // Cap cache size (FIFO eviction using Map insertion order).
      while (evalCache.size > maxCacheSize) {
        const oldestKey = evalCache.keys().next().value;
        evalCache.delete(oldestKey);
      }
    }

    function evaluateGenome(genome, evaluateFn) {
      const key = genomeKey(genome, includeSizes);
      const cached = evalCache.get(key);
      if (cached) return { ...cached, genome: deepCopyGenome(genome, includeSizes), cached: true, key };

      const res = evaluateFn(genome);
      if (!res) return null;
      if (!Number.isFinite(res.predictedWpm)) return null;

      const stored = {
        predictedWpm: res.predictedWpm,
        avgMsPerChar: res.avgMsPerChar,
        layout: res.layout,
      };
      cacheSet(key, stored);
      return { ...stored, genome: deepCopyGenome(genome, includeSizes), cached: false, key };
    }

    function generateGenomes(count) {
      if (!Number.isInteger(count) || count <= 0) throw new Error("ga.generateGenomes({count}): count must be a positive integer");
      const out = [];
      const maxAttempts = count * 6;
      let attempts = 0;

      while (out.length < count && attempts < maxAttempts) {
        attempts += 1;

        let genome = null;
        if (population.length < 2 || population.length < Math.min(12, populationSize)) {
          genome = randomGenome();
        } else if (Math.random() < immigrantRate) {
          genome = randomGenome();
        } else {
          const p1 = tournamentSelect();
          const p2 = tournamentSelect();
          genome = makeChildGenome(p1, p2);
        }

        out.push(deepCopyGenome(genome, includeSizes));
      }

      return { genomes: out, stats: { evaluations, populationSize: population.length, cacheSize: evalCache.size, params: getParams() } };
    }

    function ingestEvaluations(evaluatedList) {
      if (!Array.isArray(evaluatedList)) return { evaluations: [], stats: getStats() };
      const out = [];

      for (const ev of evaluatedList) {
        if (!ev || !Number.isFinite(ev.predictedWpm)) continue;
        const key = genomeKey(ev.genome, includeSizes);
        const cached = evalCache.get(key);

        let stored = cached;
        if (!stored) {
          stored = {
            predictedWpm: ev.predictedWpm,
            avgMsPerChar: ev.avgMsPerChar,
            layout: ev.layout,
          };
          cacheSet(key, stored);
        }

        const individual = { ...stored, genome: deepCopyGenome(ev.genome, includeSizes), cached: !!cached, key };
        evaluations += 1;
        considerReplacement(individual);
        out.push(individual);
      }

      return { evaluations: out, stats: { evaluations, populationSize: population.length, cacheSize: evalCache.size, params: getParams() } };
    }

    function insertIndividual(individual) {
      // Insert into sorted population (desc by predictedWpm) with capped size.
      const key = String(individual?.key ?? genomeKey(individual.genome, includeSizes));
      if (populationKeys.has(key)) return false;
      individual.key = key;
      populationKeys.add(key);
      population.push(individual);
      population.sort((a, b) => b.predictedWpm - a.predictedWpm);
      if (population.length > populationSize) {
        const removed = population.splice(populationSize);
        for (const it of removed) populationKeys.delete(it.key);
      }
      return populationKeys.has(key);
    }

    function genomeDistance(g1, g2) {
      // Light-weight distance for RTR:
      // - permutations: normalized Hamming distance for seqA + seqB
      // - sizes (if enabled): average absolute difference over wRaw/hRaw
      const denom = g1.seqA.length > 0 ? g1.seqA.length : 1;
      let d = hammingDistance(g1.seqA, g2.seqA) / denom + hammingDistance(g1.seqB, g2.seqB) / denom;
      if (includeSizes) {
        let sum = 0;
        for (let i = 0; i < denom; i++) {
          sum += Math.abs(g1.wRaw[i] - g2.wRaw[i]);
          sum += Math.abs(g1.hRaw[i] - g2.hRaw[i]);
        }
        d += sum / (2 * denom);
      }
      return d;
    }

    function considerReplacementWorst(individual) {
      if (population.length < populationSize) {
        return insertIndividual(individual);
      }
      if (population.length === 0) {
        return insertIndividual(individual);
      }

      // Do not replace elites.
      const replaceIndex = eliteFloor();
      const worstIndex = population.length - 1;
      if (replaceIndex > worstIndex) return false;

      const worstNonElite = population[worstIndex];
      if (individual.predictedWpm <= worstNonElite.predictedWpm) return false;

      // Replace the worst non-elite and re-sort.
      const key = String(individual?.key ?? genomeKey(individual.genome, includeSizes));
      if (populationKeys.has(key)) return false;
      populationKeys.delete(worstNonElite.key);
      populationKeys.add(key);
      individual.key = key;
      population[worstIndex] = individual;
      population.sort((a, b) => b.predictedWpm - a.predictedWpm);
      return true;
    }

    function considerReplacementRTR(individual) {
      if (population.length < populationSize) {
        return insertIndividual(individual);
      }
      if (population.length === 0) {
        return insertIndividual(individual);
      }

      // Do not replace elites.
      const start = eliteFloor();
      const end = population.length;
      if (start >= end) return false;

      const key = String(individual?.key ?? genomeKey(individual.genome, includeSizes));
      if (populationKeys.has(key)) return false;

      const window = clamp(rtrWindow, 1, end - start);
      let bestIdx = randInt(start, end);
      let bestDist = genomeDistance(population[bestIdx].genome, individual.genome);

      for (let t = 1; t < window; t++) {
        const idx = randInt(start, end);
        const d = genomeDistance(population[idx].genome, individual.genome);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      }

      const competitor = population[bestIdx];
      if (individual.predictedWpm <= competitor.predictedWpm) return false;

      populationKeys.delete(competitor.key);
      populationKeys.add(key);
      individual.key = key;
      population[bestIdx] = individual;
      population.sort((a, b) => b.predictedWpm - a.predictedWpm);
      return true;
    }

    function considerReplacement(individual) {
      return replacementStrategy === "worst" ? considerReplacementWorst(individual) : considerReplacementRTR(individual);
    }

    function step({ count, evaluate }) {
      if (!Number.isInteger(count) || count <= 0) throw new Error("ga.step({count}): count must be a positive integer");
      if (typeof evaluate !== "function") throw new Error("ga.step({evaluate}): evaluate must be a function");

      const out = [];
      const maxAttempts = count * 6;
      let attempts = 0;

      while (out.length < count && attempts < maxAttempts) {
        attempts += 1;

        let genome = null;
        if (population.length < 2 || population.length < Math.min(12, populationSize)) {
          genome = randomGenome();
        } else if (Math.random() < immigrantRate) {
          genome = randomGenome();
        } else {
          const p1 = tournamentSelect();
          const p2 = tournamentSelect();
          genome = makeChildGenome(p1, p2);
        }

        const evaluated = evaluateGenome(genome, evaluate);
        if (!evaluated) continue;

        evaluations += 1;

        // Add to population (steady-state replacement).
        considerReplacement(evaluated);
        out.push(evaluated);
      }

      return { evaluations: out, stats: { evaluations, populationSize: population.length, cacheSize: evalCache.size, params: getParams() } };
    }

    function getBest() {
      return population.length ? population[0] : null;
    }

    function getStats() {
      return { evaluations, populationSize: population.length, cacheSize: evalCache.size, params: getParams() };
    }

    return {
      n,
      includeSizes,
      sizeMin,
      sizeMax,
      populationSize,
      clear,
      step,
      generateGenomes,
      ingestEvaluations,
      getBest,
      getStats,
      getParams,
      setParams,
    };
  }

  ns.geneticSearch = {
    createSequencePairGA,
  };
})();

