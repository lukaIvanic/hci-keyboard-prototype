(function () {
  "use strict";

  window.KbdStudy = window.KbdStudy || {};
  const ns = window.KbdStudy;

  /**
   * Key: { id, label, x, y, w, h, type }
   * Layout: { id, name, keys: Key[] }
   *
   * Coordinates are in abstract units (not pixels). Rendering scales units -> px.
   */

  function makeKey({ id, label, x, y, w, h, type }) {
    return { id, label, x, y, w, h, type };
  }

  function buildLetterRow(letters, rowY, offsetX) {
    const keys = [];
    for (let i = 0; i < letters.length; i++) {
      const ch = letters[i];
      keys.push(
        makeKey({
          id: ch,
          label: ch.toUpperCase(),
          x: offsetX + i,
          y: rowY,
          w: 1,
          h: 1,
          type: "char",
        })
      );
    }
    return keys;
  }

  function buildStandardSpecialKeys(rowY) {
    return [
      makeKey({
        id: "space",
        label: "Space",
        x: 2,
        y: rowY,
        w: 6,
        h: 1,
        type: "space",
      }),
      makeKey({
        id: "backspace",
        label: "⌫",
        x: 8.5,
        y: rowY,
        w: 2,
        h: 1,
        type: "backspace",
      }),
    ];
  }

  function addEnterKeyToKeys(keys, options = {}) {
    if (!Array.isArray(keys)) return keys;
    if (keys.some((k) => k && k.id === "enter")) return keys;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const k of keys) {
      if (!k) continue;
      const x = Number(k.x);
      const y = Number(k.y);
      const w = Number(k.w);
      const h = Number(k.h);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return keys;
    }

    const gap = Number.isFinite(options.gap) ? options.gap : 0.3;
    const width = Number.isFinite(options.width) ? options.width : 2;
    const height = Number.isFinite(options.height) ? options.height : Math.max(1, maxY - minY);

    const enterKey = makeKey({
      id: "enter",
      label: "Enter",
      x: maxX + gap,
      y: minY,
      w: width,
      h: height,
      type: "enter",
    });

    return keys.concat(enterKey);
  }

  // Compiler seam: build a Layout from row strings + offsets.
  function compileRowLayout({ id, name, rows, offsets, specialRowY }) {
    const keys = [];
    const rowOffsets = offsets ?? [];
    for (let i = 0; i < rows.length; i++) {
      keys.push(...buildLetterRow(rows[i], i, rowOffsets[i] ?? 0));
    }
    keys.push(...buildStandardSpecialKeys(specialRowY ?? rows.length));
    return finalizeLayout({ id, name, keys: addEnterKeyToKeys(keys) });
  }

  function range1(n) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push(i);
    return out;
  }

  function isPermutation(seq, n) {
    if (!Array.isArray(seq)) return false;
    if (seq.length !== n) return false;
    const seen = new Array(n + 1).fill(false);
    for (const v of seq) {
      if (!Number.isInteger(v)) return false;
      if (v < 1 || v > n) return false;
      if (seen[v]) return false;
      seen[v] = true;
    }
    return true;
  }

  function assertUniqueKeyIds(keys) {
    const seen = new Set();
    for (const k of keys) {
      const id = String(k?.id ?? "");
      if (!id) throw new Error("SequencePairSpec.keys must include non-empty key.id values");
      if (seen.has(id)) throw new Error(`Duplicate key.id in SequencePairSpec.keys: ${id}`);
      seen.add(id);
    }
  }

  /**
   * Compile a sequence-pair floorplan into a runtime Layout.
   *
   * SequencePairSpec:
   * - { id, name, keys, seqA, seqB, wRaw?, hRaw? }
   * - keys[] order defines indices 1..n.
   * - seqA/seqB are permutations of 1..n.
   * - wRaw/hRaw default to 1 for all keys (no special cases).
   *
   * options:
   * - { targetW, targetH } (optional). If provided, pack is globally scaled to fit these bounds.
   */
  function compileSequencePair(spec, options) {
    if (!spec || typeof spec !== "object") throw new Error("compileSequencePair(spec): spec is required");
    const id = String(spec.id ?? "");
    const name = String(spec.name ?? id ?? "SequencePair");
    const keysSpec = spec.keys;
    if (!Array.isArray(keysSpec) || keysSpec.length === 0) throw new Error("SequencePairSpec.keys must be a non-empty array");
    assertUniqueKeyIds(keysSpec);

    const n = keysSpec.length;
    const seqA = spec.seqA ?? range1(n);
    const seqB = spec.seqB ?? range1(n);
    if (!isPermutation(seqA, n)) throw new Error("SequencePairSpec.seqA must be a permutation of [1..n]");
    if (!isPermutation(seqB, n)) throw new Error("SequencePairSpec.seqB must be a permutation of [1..n]");

    const w = new Array(n + 1);
    const h = new Array(n + 1);
    const wRaw = spec.wRaw;
    const hRaw = spec.hRaw;
    for (let idx = 1; idx <= n; idx++) {
      const wi = Array.isArray(wRaw) ? wRaw[idx - 1] : 1;
      const hi = Array.isArray(hRaw) ? hRaw[idx - 1] : 1;
      if (!Number.isFinite(wi) || wi <= 0) throw new Error("SequencePairSpec.wRaw must contain finite values > 0");
      if (!Number.isFinite(hi) || hi <= 0) throw new Error("SequencePairSpec.hRaw must contain finite values > 0");
      w[idx] = wi;
      h[idx] = hi;
    }

    const posB = new Array(n + 1);
    for (let p = 0; p < n; p++) posB[seqB[p]] = p;

    const x = new Array(n + 1).fill(0);
    const y = new Array(n + 1).fill(0);

    // O(n^2) relax edges in topological order (seqA is a topological order for both graphs).
    for (let ai = 0; ai < n; ai++) {
      const i = seqA[ai];
      for (let aj = ai + 1; aj < n; aj++) {
        const j = seqA[aj];
        if (posB[i] < posB[j]) {
          // i left of j
          x[j] = Math.max(x[j], x[i] + w[i]);
        } else {
          // i above j (j is below i)
          y[j] = Math.max(y[j], y[i] + h[i]);
        }
      }
    }

    let packedW = 0;
    let packedH = 0;
    for (let idx = 1; idx <= n; idx++) {
      packedW = Math.max(packedW, x[idx] + w[idx]);
      packedH = Math.max(packedH, y[idx] + h[idx]);
    }

    const targetW = Number.isFinite(options?.targetW) ? options.targetW : packedW;
    const targetH = Number.isFinite(options?.targetH) ? options.targetH : packedH;
    const sx = packedW > 0 ? targetW / packedW : 1;
    const sy = packedH > 0 ? targetH / packedH : 1;

    const outKeys = [];
    for (let idx = 1; idx <= n; idx++) {
      const k = keysSpec[idx - 1];
      outKeys.push(
        makeKey({
          id: k.id,
          label: k.label,
          type: k.type,
          x: x[idx] * sx,
          y: y[idx] * sy,
          w: w[idx] * sx,
          h: h[idx] * sy,
        })
      );
    }

    // Sanity check: ensure rectangles do not overlap in unit-space.
    // (n is small; O(n^2) is fine, and it catches any future packing bugs.)
    //
    // Use a small epsilon because we scale x/w and y/h separately, which can introduce tiny
    // floating-point discrepancies for rectangles that should exactly touch.
    const EPS = 1e-9;
    for (let a = 0; a < outKeys.length; a++) {
      const ka = outKeys[a];
      for (let b = a + 1; b < outKeys.length; b++) {
        const kb = outKeys[b];
        const overlapX = ka.x < kb.x + kb.w - EPS && ka.x + ka.w > kb.x + EPS;
        const overlapY = ka.y < kb.y + kb.h - EPS && ka.y + ka.h > kb.y + EPS;
        if (overlapX && overlapY) {
          throw new Error(`Sequence-pair overlap detected: ${ka.id} overlaps ${kb.id}`);
        }
      }
    }

    const keysWithEnter = addEnterKeyToKeys(outKeys);
    return finalizeLayout({ id, name, keys: keysWithEnter });
  }

  function finalizeLayout({ id, name, keys }) {
    const byId = Object.create(null);
    for (const k of keys) byId[k.id] = k;
    return { id, name, keys, _byId: byId };
  }

  function getKey(layout, keyId) {
    return layout && layout._byId ? layout._byId[keyId] : null;
  }

  function getKeyCenter(layout, keyId) {
    const k = getKey(layout, keyId);
    if (!k) return null;
    return { cx: k.x + k.w / 2, cy: k.y + k.h / 2 };
  }

  // Distance between the edges of two axis-aligned key rectangles in unit-space.
  // Returns 0 if the rectangles touch or overlap.
  function rectDistance(aKey, bKey) {
    if (!aKey || !bKey) return null;
    const ax1 = Number(aKey.x);
    const ay1 = Number(aKey.y);
    const aw = Number(aKey.w);
    const ah = Number(aKey.h);
    const bx1 = Number(bKey.x);
    const by1 = Number(bKey.y);
    const bw = Number(bKey.w);
    const bh = Number(bKey.h);
    if (![ax1, ay1, aw, ah, bx1, by1, bw, bh].every(Number.isFinite)) return null;

    // Be robust to any future negative widths/heights by normalizing endpoints.
    const ax2 = ax1 + aw;
    const ay2 = ay1 + ah;
    const bx2 = bx1 + bw;
    const by2 = by1 + bh;
    const aMinX = Math.min(ax1, ax2);
    const aMaxX = Math.max(ax1, ax2);
    const aMinY = Math.min(ay1, ay2);
    const aMaxY = Math.max(ay1, ay2);
    const bMinX = Math.min(bx1, bx2);
    const bMaxX = Math.max(bx1, bx2);
    const bMinY = Math.min(by1, by2);
    const bMaxY = Math.max(by1, by2);

    const dx = Math.max(0, bMinX - aMaxX, aMinX - bMaxX);
    const dy = Math.max(0, bMinY - aMaxY, aMinY - bMaxY);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function centerDistance(aKey, bKey) {
    if (!aKey || !bKey) return null;
    const ax = Number(aKey.x);
    const ay = Number(aKey.y);
    const aw = Number(aKey.w);
    const ah = Number(aKey.h);
    const bx = Number(bKey.x);
    const by = Number(bKey.y);
    const bw = Number(bKey.w);
    const bh = Number(bKey.h);
    if (![ax, ay, aw, ah, bx, by, bw, bh].every(Number.isFinite)) return null;
    const acx = ax + aw / 2;
    const acy = ay + ah / 2;
    const bcx = bx + bw / 2;
    const bcy = by + bh / 2;
    const dx = acx - bcx;
    const dy = acy - bcy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Requested metric: average of center-to-center and edge-to-edge distance.
  function mixedDistance(aKey, bKey) {
    const dCenter = centerDistance(aKey, bKey);
    const dEdge = rectDistance(aKey, bKey);
    if (dCenter == null || dEdge == null) return null;
    return 0.5 * (dCenter + dEdge);
  }

  function getLayoutBounds(layout) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const k of layout.keys) {
      minX = Math.min(minX, k.x);
      minY = Math.min(minY, k.y);
      maxX = Math.max(maxX, k.x + k.w);
      maxY = Math.max(maxY, k.y + k.h);
    }

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  // --- Built-in layouts ---

  const qwerty = compileRowLayout({
    id: "qwerty",
    name: "QWERTY (control)",
    rows: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
    offsets: [0, 0.5, 1.5],
    specialRowY: 3,
  });

  const veryGood = finalizeLayout({
    id: "very_good",
    name: "Very good",
    keys: addEnterKeyToKeys([
      makeKey({ id: "a", label: "A", type: "char", x: 1.3491857855575489, y: 1.9988058448867336, w: 1.7007226186357707, h: 0.8623351498632212 }),
      makeKey({ id: "b", label: "B", type: "char", x: 5.6009923321469754, y: 0, w: 0.8503613093178853, h: 0.970583418003457 }),
      makeKey({ id: "c", label: "C", type: "char", x: 7.101510326213068, y: 1.8409198867552081, w: 1.7007226186357707, h: 0.8511873447261947 }),
      makeKey({ id: "d", label: "D", type: "char", x: 6.451353641464861, y: 0.9739307764828259, w: 1.7007226186357707, h: 0.8658313269066652 }),
      makeKey({ id: "e", label: "E", type: "char", x: 4.750730022862788, y: 1.8462494467836124, w: 0.8503613093178853, h: 1.0655671819534793 }),
      makeKey({ id: "f", label: "F", type: "char", x: 1.3491857855575489, y: 1.147254561387061, w: 1.7007226186357707, h: 0.8515512834996726 }),
      makeKey({ id: "g", label: "G", type: "char", x: 6.451353641464861, y: 0, w: 1.7007226186357707, h: 0.9739307764828259 }),
      makeKey({ id: "h", label: "H", type: "char", x: 3.900368713544903, y: 2.696726151143898, w: 0.8503613093178853, h: 1.3009834394041235 }),
      makeKey({ id: "i", label: "I", type: "char", x: 5.6010913321806735, y: 1.8419136590223788, w: 1.5004189940323955, h: 0.8510385196987282 }),
      makeKey({ id: "j", label: "J", type: "char", x: 1.3491857855575489, y: 0, w: 0.8503613093178853, h: 1.1445684273004468 }),
      makeKey({ id: "k", label: "K", type: "char", x: 8.152076260100632, y: 0.9739307764828259, w: 1.7007226186357707, h: 0.8669891102723819 }),
      makeKey({ id: "l", label: "L", type: "char", x: 3.900269713511205, y: 0, w: 0.8503613093178853, h: 0.9837161629987522 }),
      makeKey({ id: "m", label: "M", type: "char", x: 5.6010913321806735, y: 2.692952178721107, w: 1.7007226186357707, h: 1.2903556366322482 }),
      makeKey({ id: "n", label: "N", type: "char", x: 5.6009923321469754, y: 0.9720964816260368, w: 0.8503613093178853, h: 0.869817177396342 }),
      makeKey({ id: "o", label: "O", type: "char", x: 2.199547094875434, y: 0, w: 1.7007226186357707, h: 1.147254561387061 }),
      makeKey({ id: "p", label: "P", type: "char", x: 1.7007226186357707, y: 2.861140994749955, w: 1.349284785591247, h: 1.1351482550615062 }),
      makeKey({ id: "q", label: "Q", type: "char", x: 0, y: 1.9988058448867336, w: 1.344733679846982, h: 0.8557389040588396 }),
      makeKey({ id: "r", label: "R", type: "char", x: 3.0499084041933195, y: 1.147254561387061, w: 0.8503613093178853, h: 0.8671290158045974 }),
      makeKey({ id: "s", label: "S", type: "char", x: 3.900368713544903, y: 1.8462494467836124, w: 0.8503613093178853, h: 0.8504767043602856 }),
      makeKey({ id: "t", label: "T", type: "char", x: 3.050007404227018, y: 2.0143835771916585, w: 0.8503613093178853, h: 1.382443514552771 }),
      makeKey({ id: "u", label: "U", type: "char", x: 0, y: 2.861140994749955, w: 1.7007226186357707, h: 1.138859005250045 }),
      makeKey({ id: "v", label: "V", type: "char", x: 0, y: 0.8589832175937914, w: 1.3491857855575489, h: 1.125607976877953 }),
      makeKey({ id: "w", label: "W", type: "char", x: 4.750730022862788, y: 2.911816628737092, w: 0.8503613093178853, h: 1.085993438131686 }),
      makeKey({ id: "x", label: "X", type: "char", x: 0, y: 0, w: 1.3413522300873288, h: 0.8589832175937914 }),
      makeKey({ id: "y", label: "Y", type: "char", x: 4.750631022829091, y: 0, w: 0.8503613093178853, h: 0.9720964816260368 }),
      makeKey({ id: "z", label: "Z", type: "char", x: 8.152076260100632, y: 0, w: 1.7007226186357707, h: 0.9709203751222835 }),
      makeKey({ id: "space", label: "Space", type: "space", x: 3.900269713511205, y: 0.9837161629987522, w: 1.7007226186357707, h: 0.8625332837848602 }),
      makeKey({ id: "backspace", label: "⌫", type: "backspace", x: 8.802232944848837, y: 1.8409198867552081, w: 1.6977670551511623, h: 1.379125530673299 }),
    ]),
  });

  const prettyGood = finalizeLayout({
    id: "pretty_good",
    name: "Pretty Good",
    keys: addEnterKeyToKeys([
      makeKey({ id: "a", label: "A", type: "char", x: 4.5375110564360055, y: 0.8, w: 2.106022601866128, h: 0.8 }),
      makeKey({ id: "b", label: "B", type: "char", x: 6.643533658302133, y: 0, w: 1.675322843169103, h: 1.0741174756525689 }),
      makeKey({ id: "c", label: "C", type: "char", x: 2.6565341641963007, y: 3.2, w: 1.197196573466351, h: 0.8 }),
      makeKey({ id: "d", label: "D", type: "char", x: 6.643533658302133, y: 1.957729458725868, w: 1.4403964613932443, h: 0.8202924961748623 }),
      makeKey({ id: "e", label: "E", type: "char", x: 3.853730737662652, y: 3.2, w: 2.106022601866128, h: 0.8 }),
      makeKey({ id: "f", label: "F", type: "char", x: 1.053011300933064, y: 0, w: 1.3784771536368137, h: 1.6 }),
      makeKey({ id: "g", label: "G", type: "char", x: 7.696544959235197, y: 1.0741174756525689, w: 1.6924159532538916, h: 0.8697703146007855 }),
      makeKey({ id: "h", label: "H", type: "char", x: 2.4314884545698776, y: 0.8, w: 1.053011300933064, h: 0.8 }),
      makeKey({ id: "i", label: "I", type: "char", x: 4.5375110564360055, y: 0, w: 2.106022601866128, h: 0.8 }),
      makeKey({ id: "j", label: "J", type: "char", x: 9.38896091248909, y: 1.0741174756525689, w: 1.053011300933064, h: 0.8 }),
      makeKey({ id: "k", label: "K", type: "char", x: 8.083930119695378, y: 1.957729458725868, w: 1.139162067945427, h: 0.8216482256718985 }),
      makeKey({ id: "l", label: "L", type: "char", x: 1.053011300933064, y: 1.6, w: 1.3773966193336424, h: 1.0246235321125838 }),
      makeKey({ id: "m", label: "M", type: "char", x: 1.053011300933064, y: 2.624623532112584, w: 1.6035228632632368, h: 1.3407413720670063 }),
      makeKey({ id: "n", label: "N", type: "char", x: 5.59052235736907, y: 1.6, w: 1.053011300933064, h: 1.1980407465966512 }),
      makeKey({ id: "o", label: "O", type: "char", x: 3.7095454651293642, y: 2.4000000000000004, w: 1.877661146631581, h: 0.8 }),
      makeKey({ id: "p", label: "P", type: "char", x: 0, y: 0, w: 1.053011300933064, h: 1.5950325098072335 }),
      makeKey({ id: "q", label: "Q", type: "char", x: 9.223092187640805, y: 2.946087022329049, w: 1.2769078123591941, h: 0.8769198695228726 }),
      makeKey({ id: "r", label: "R", type: "char", x: 5.959753339528779, y: 2.7980407465966515, w: 1.053011300933064, h: 1.1836447802848207 }),
      makeKey({ id: "s", label: "S", type: "char", x: 3.4844997555029416, y: 0.8, w: 1.053011300933064, h: 0.8 }),
      makeKey({ id: "t", label: "T", type: "char", x: 2.4314884545698776, y: 0, w: 2.106022601866128, h: 0.8 }),
      makeKey({ id: "u", label: "U", type: "char", x: 6.643533658302133, y: 1.0741174756525689, w: 1.053011300933064, h: 0.8836119830732992 }),
      makeKey({ id: "v", label: "V", type: "char", x: 2.6565341641963007, y: 2.4000000000000004, w: 1.053011300933064, h: 0.8 }),
      makeKey({ id: "w", label: "W", type: "char", x: 2.4314884545698776, y: 1.6, w: 1.053011300933064, h: 0.8 }),
      makeKey({ id: "x", label: "X", type: "char", x: 8.318856501471236, y: 0, w: 1.053011300933064, h: 1.0425567255086488 }),
      makeKey({ id: "y", label: "Y", type: "char", x: 7.012764640461843, y: 2.7980407465966515, w: 2.106022601866128, h: 1.0978357322946417 }),
      makeKey({ id: "z", label: "Z", type: "char", x: 9.223092187640805, y: 1.9438877902533545, w: 1.053011300933064, h: 1.002199232075695 }),
      makeKey({ id: "space", label: "Space", type: "space", x: 3.4844997555029416, y: 1.6, w: 2.106022601866128, h: 0.8 }),
      makeKey({ id: "backspace", label: "⌫", type: "backspace", x: 9.38896091248909, y: 0, w: 1.053011300933064, h: 0.8073394862545854 }),
    ]),
  });

  // Canonical unit-space bounds for normalizing generated layouts.
  // Note: renderer maps unit-space -> #keyboardContainer size; keeping bounds constant keeps visuals consistent.
  const CANONICAL_BOUNDS = getLayoutBounds(qwerty);
  const CANONICAL_TARGET = { targetW: CANONICAL_BOUNDS.width, targetH: CANONICAL_BOUNDS.height };

  const DEFAULT_SP_KEYS = (function () {
    const keys = [];
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      keys.push({ id: ch, label: ch.toUpperCase(), type: "char" });
    }
    keys.push({ id: "space", label: "Space", type: "space" });
    keys.push({ id: "backspace", label: "⌫", type: "backspace" });
    keys.push({ id: "enter", label: "Enter", type: "enter" });
    return keys;
  })();

  function interleaveOddsEvens(n) {
    const odds = [];
    const evens = [];
    for (let i = 1; i <= n; i++) (i % 2 === 1 ? odds : evens).push(i);
    return odds.concat(evens);
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function shuffledRange1(n) {
    return shuffleInPlace(range1(n));
  }

  function randomArray(n, minInclusive, maxExclusive) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = minInclusive + Math.random() * (maxExclusive - minInclusive);
    return out;
  }

  // --- Sequence-pair test layouts (same keys/sizes, only ordering differs) ---
  const spN = DEFAULT_SP_KEYS.length;
  const spIdentity = compileSequencePair(
    {
      id: "sp_identity",
      name: "SeqPair: Identity (A=1..n,B=1..n)",
      keys: DEFAULT_SP_KEYS,
      seqA: range1(spN),
      seqB: range1(spN),
    },
    CANONICAL_TARGET
  );

  const spReverseB = compileSequencePair(
    {
      id: "sp_reverse_b",
      name: "SeqPair: Reverse-B (A=1..n,B=n..1)",
      keys: DEFAULT_SP_KEYS,
      seqA: range1(spN),
      seqB: range1(spN).reverse(),
    },
    CANONICAL_TARGET
  );

  const spMixed = compileSequencePair(
    {
      id: "sp_mixed",
      name: "SeqPair: Mixed (A=1..n,B=odds+evens)",
      keys: DEFAULT_SP_KEYS,
      seqA: range1(spN),
      seqB: interleaveOddsEvens(spN),
    },
    CANONICAL_TARGET
  );

  // --- Sequence-pair random layouts (re-roll on each page load) ---
  const spRandomPermFixedSizes = compileSequencePair(
    {
      id: "sp_rand_perm",
      name: "SeqPair: Random perms (fixed sizes)",
      keys: DEFAULT_SP_KEYS,
      seqA: shuffledRange1(spN),
      seqB: shuffledRange1(spN),
      // No wRaw/hRaw: all keys default to 1x1 (space/backspace included).
    },
    CANONICAL_TARGET
  );

  const spRandomPermRandomSizes = compileSequencePair(
    {
      id: "sp_rand_perm_sizes",
      name: "SeqPair: Random perms + random sizes",
      keys: DEFAULT_SP_KEYS,
      seqA: shuffledRange1(spN),
      seqB: shuffledRange1(spN),
      wRaw: randomArray(spN, 0.8, 1.6),
      hRaw: randomArray(spN, 0.8, 1.6),
    },
    CANONICAL_TARGET
  );

  const ALL_LAYOUTS = [qwerty, veryGood, prettyGood];

  // --- User-saved layouts (localStorage) ---

  const USER_LAYOUTS_STORAGE_KEY = "KbdStudy.userLayouts.v1";
  const MAX_USER_LAYOUTS = 80;
  const USER_LAYOUT_ID_MIGRATIONS = new Map([
    ["user_1770153167095", "clancy_custom"],
    ["user_1770153329211", "fits_or_something"],
    ["user_1770153448244", "fake_qwerty"],
  ]);
  const USER_LAYOUT_NAME_MIGRATIONS = new Map([
    ["clancy (custom)", "clancy_custom"],
    ["clancy(custom)", "clancy_custom"],
    ["fittsorsomething", "fits_or_something"],
    ["fakeqwerty", "fake_qwerty"],
  ]);

  function hasLocalStorage() {
    try {
      if (typeof localStorage === "undefined") return false;
      const k = "__kbdstudy_ls_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  function safeParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function isPlainObject(x) {
    return x != null && typeof x === "object" && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
  }

  function normalizeKeyForStorage(k) {
    if (!isPlainObject(k)) return null;
    const id = String(k.id ?? "");
    if (!id) return null;
    const label = String(k.label ?? id);
    const type = String(k.type ?? "char");
    const x = Number(k.x);
    const y = Number(k.y);
    const w = Number(k.w);
    const h = Number(k.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    if (w <= 0 || h <= 0) return null;
    return { id, label, type, x, y, w, h };
  }

  function normalizeLayoutRecord(rec) {
    if (!isPlainObject(rec)) return null;
    const id = String(rec.id ?? "");
    const name = String(rec.name ?? id);
    const createdAtMs = Number(rec.createdAtMs ?? 0);
    const keysRaw = rec.keys;
    if (!id || !name) return null;
    if (!Array.isArray(keysRaw) || keysRaw.length === 0) return null;
    const keys = [];
    for (const k of keysRaw) {
      const nk = normalizeKeyForStorage(k);
      if (!nk) return null;
      keys.push(nk);
    }
    return { id, name, createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0, keys };
  }

  function loadBakedLayouts() {
    const baked = Array.isArray(ns.bakedLayouts) ? ns.bakedLayouts : [];
    let count = 0;
    for (const rec of baked) {
      const normalized = normalizeLayoutRecord(rec);
      if (!normalized) continue;
      try {
        const keys = normalized.keys.map((k) => makeKey(k));
        registerLayout({ id: normalized.id, name: normalized.name, keys }, { createdAtMs: normalized.createdAtMs });
        count += 1;
      } catch {
        // Skip invalid baked entries.
      }
    }
    return count;
  }

  function normalizeLayoutName(name) {
    return String(name ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function migrateUserLayoutRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return records;
    const used = new Set(records.map((rec) => rec.id));
    let changed = false;
    for (const rec of records) {
      if (!rec) continue;
      const nameKey = normalizeLayoutName(rec.name);
      const desiredId = USER_LAYOUT_ID_MIGRATIONS.get(rec.id) ?? USER_LAYOUT_NAME_MIGRATIONS.get(nameKey);
      if (!desiredId || rec.id === desiredId) continue;
      if (used.has(desiredId)) {
        console.warn(`User layout id migration skipped (conflict): ${rec.id} -> ${desiredId}`);
        continue;
      }
      used.delete(rec.id);
      rec.id = desiredId;
      used.add(desiredId);
      changed = true;
    }
    if (changed) {
      try {
        writeUserLayoutRecords(records);
      } catch (err) {
        console.warn("Failed to persist migrated user layout IDs:", err);
      }
    }
    return records;
  }

  function readUserLayoutRecords() {
    if (!hasLocalStorage()) return [];
    const raw = localStorage.getItem(USER_LAYOUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const it of parsed) {
      const rec = normalizeLayoutRecord(it);
      if (rec) out.push(rec);
    }
    return out;
  }

  function writeUserLayoutRecords(records) {
    if (!hasLocalStorage()) throw new Error("localStorage is unavailable; cannot save layouts");
    const trimmed = records.slice(-MAX_USER_LAYOUTS);
    localStorage.setItem(USER_LAYOUTS_STORAGE_KEY, JSON.stringify(trimmed));
  }

  function uniqueLayoutId(preferredId) {
    const base = String(preferredId ?? "").trim() || "user_layout";
    let id = base;
    let i = 1;
    while (getLayoutById(id)) {
      id = `${base}_${i}`;
      i += 1;
      if (i > 9999) id = `${base}_${Date.now()}`;
    }
    return id;
  }

  function registerLayout(layout, { isUser = false, createdAtMs = 0 } = {}) {
    const id = String(layout?.id ?? "");
    if (!id) throw new Error("registerLayout(layout): layout.id is required");
    if (getLayoutById(id)) return getLayoutById(id);
    const keysWithEnter = addEnterKeyToKeys(layout.keys);
    const finalized = finalizeLayout({ id, name: String(layout?.name ?? id), keys: keysWithEnter });
    if (isUser) {
      finalized._user = true;
      finalized._createdAtMs = createdAtMs;
    }
    ALL_LAYOUTS.push(finalized);
    return finalized;
  }

  function loadUserLayouts() {
    const records = migrateUserLayoutRecords(readUserLayoutRecords());
    for (const rec of records) {
      try {
        const keys = rec.keys.map((k) => makeKey(k));
        registerLayout({ id: rec.id, name: rec.name, keys }, { isUser: true, createdAtMs: rec.createdAtMs });
      } catch {
        // Skip invalid stored entries.
      }
    }
    return records.length;
  }

  function saveUserLayout(layout, options) {
    const name = String(options?.name ?? "").trim() || "Saved layout";
    const createdAtMs = Date.now();
    const preferredId = String(options?.id ?? "").trim() || `user_${createdAtMs}`;
    const id = uniqueLayoutId(preferredId);

    if (!layout || !Array.isArray(layout.keys)) throw new Error("saveUserLayout(layout): layout.keys must be an array");
    const keys = [];
    for (const k of layout.keys) {
      const nk = normalizeKeyForStorage(k);
      if (!nk) throw new Error("saveUserLayout(layout): layout has invalid key data");
      keys.push(nk);
    }

    const record = { id, name, createdAtMs, keys };
    const records = readUserLayoutRecords();
    records.push(record);
    writeUserLayoutRecords(records);

    // Also register in the current runtime so it appears immediately in dropdowns on this page.
    registerLayout({ id, name, keys: keys.map((k) => makeKey(k)) }, { isUser: true, createdAtMs });
    return { id, name, createdAtMs };
  }

  function exportUserLayouts() {
    return readUserLayoutRecords();
  }

  function clearUserLayouts() {
    if (!hasLocalStorage()) return;
    localStorage.removeItem(USER_LAYOUTS_STORAGE_KEY);

    // Remove user layouts from runtime list.
    for (let i = ALL_LAYOUTS.length - 1; i >= 0; i--) {
      const l = ALL_LAYOUTS[i];
      if (l && l._user) ALL_LAYOUTS.splice(i, 1);
    }
  }

  function getAllLayouts() {
    return ALL_LAYOUTS.slice();
  }

  function getLayoutById(layoutId) {
    for (const l of ALL_LAYOUTS) if (l.id === layoutId) return l;
    return null;
  }

  ns.layouts = {
    compileRowLayout,
    compileSequencePair,
    getAllLayouts,
    getLayoutById,
    getKey,
    getKeyCenter,
    rectDistance,
    centerDistance,
    mixedDistance,
    getLayoutBounds,
    // User-saved layouts (persisted via localStorage)
    loadUserLayouts,
    saveUserLayout,
    exportUserLayouts,
    clearUserLayouts,
  };

  // Auto-load saved layouts (best effort).
  try {
    loadBakedLayouts();
    loadUserLayouts();
  } catch (err) {
    console.warn("Failed to load user layouts:", err);
  }
})();

