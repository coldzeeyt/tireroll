// Procedural hill profile. World units are meters; this profile is y-DOWN
// (positive slope = descending) and gets wrapped into 3D by course.js.
(function (root) {
  const TR = root.TR;
  const DX = 1; // heightfield resolution (m)

  TR.TIRE_R = 0.62;

  TR.generateLevel = function (map) {
    const R = TR.rng(map.seed);
    const pts = [0];
    const L = { map, pts, kickers: [], straight: [], finishX: 0, endX: 0 };

    let x = 0, y = 0, slope = 0;

    // Advance the heightfield, blending from the current slope over `blend`
    // meters so there are no sharp kinks.
    function run(len, targetFn, blend) {
      const s0 = slope;
      const n = Math.max(1, Math.round(len / DX));
      for (let i = 1; i <= n; i++) {
        const b = blend > 0 ? TR.smooth(Math.min(1, (i * DX) / blend)) : 1;
        slope = TR.lerp(s0, targetFn(i / n, i * DX), b);
        x += DX;
        y += slope * DX;
        pts.push(y);
      }
    }
    const base = () => map.baseSlope * TR.range(R, 0.85, 1.25);

    // start: a short ledge that tips over the edge
    run(10, () => 0.05, 0);
    run(16, () => map.baseSlope * 0.8, 10);

    const keys = Object.keys(map.features);
    const totalW = keys.reduce((s, k) => s + map.features[k], 0);
    const choose = () => {
      let r = R() * totalW;
      for (const k of keys) if ((r -= map.features[k]) <= 0) return k;
      return keys[0];
    };

    let last = '';
    while (x < map.length) {
      let f = choose();
      if (f === last && f !== 'hills') f = 'hills';
      if (x < 60 && f !== 'hills') f = 'hills';
      if (f === 'hills') {
        const bs = base(), A = TR.range(R, 0.12, 0.3), w = TR.range(R, 24, 44), ph = R() * 6.28;
        run(TR.range(R, 60, 110), (t, d) => bs + A * Math.cos(ph + (d / w) * Math.PI * 2), 12);
      } else if (f === 'drop') {
        const b0 = base(), s = TR.range(R, 0.7, 1.05), len = TR.range(R, 14, 26), b1 = base();
        run(8, () => b0, 6);
        run(len, () => s, 8);
        run(24, () => b1, 14);
      } else if (f === 'kicker') {
        // a natural lip that throws the tire into the air, landing on a steep slope
        const b0 = base() * 1.25, ang = TR.range(R, 0.25, 0.42), land = TR.range(R, 0.55, 0.75);
        const k0 = x;
        run(18, () => b0, 8);
        run(6, () => -Math.tan(ang), 5);
        L.kickers.push(x);
        run(45, () => land, 2);
        L.straight.push([k0 - 4, x]);
      } else if (f === 'moguls') {
        const bs = base(), w = TR.range(R, 7, 10);
        run(TR.range(R, 40, 60), (t, d) => bs + 0.4 * Math.sin((d / w) * Math.PI * 2), 5);
      } else if (f === 'roller') {
        // a gentle rise the tire carries over on momentum
        const b0 = base() * 1.5, b1 = base() * 1.3;
        run(14, () => b0, 8);
        run(TR.range(R, 8, 14), () => -0.16, 8);
        run(26, () => b1, 10);
      }
      last = f;
    }

    // finish line, then a long flat meadow where the tire slows and topples
    run(30, () => map.baseSlope * 0.5, 12);
    L.finishX = x;
    run(40, () => 0.05, 25);
    run(160, () => 0.0, 20);
    run(30, () => -0.35, 15);
    L.endX = x;

    L.heightAt = function (qx) {
      const f = qx / DX;
      const i = Math.floor(f);
      if (i < 0) return pts[0];
      if (i >= pts.length - 1) return pts[pts.length - 1];
      return pts[i] + (pts[i + 1] - pts[i]) * (f - i);
    };
    return L;
  };
})(typeof window !== 'undefined' ? window : globalThis);
