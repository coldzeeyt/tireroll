// 3D course: wraps the longitudinal hill profile into a winding, banked valley.
// Three.js axes: y is up, the course runs along -z. "s" is distance down the
// course (s = -z) and "u" is the lateral offset from the valley centerline.
(function (root) {
  const TR = root.TR;

  TR.buildCourse = function (map) {
    const L = TR.generateLevel(map);
    const R = TR.rng(map.seed * 7 + 13);
    const N = L.pts.length;
    const hw = map.halfWidth;
    const C = { map, level: L, hw, N };

    // ---- centerline: heading angle per meter, kept straight around jumps
    const mask = new Float32Array(N).fill(1);
    const calm = (a, b) => {
      for (let s = Math.max(0, Math.floor(a - 35)); s < Math.min(N, Math.ceil(b + 35)); s++) {
        const d = s < a ? a - s : s > b ? s - b : 0;
        mask[s] = Math.min(mask[s], TR.smooth(TR.clamp(d / 35, 0, 1)));
      }
    };
    calm(0, 30);
    for (const r of L.straight) calm(r[0], r[1]);
    calm(L.finishX - 20, N);
    const f1 = TR.fbm(map.seed + 5, 3);
    const p1 = R() * 6.28, p2 = R() * 6.28;
    const alpha = new Float32Array(N);
    const xcA = new Float32Array(N);
    for (let s = 0; s < N; s++) {
      alpha[s] = map.curvy * (Math.sin(s / 61 + p1) * 0.75 + Math.sin(s / 143 + p2) * 0.5 + f1(s / 45) * 0.6) * mask[s];
      if (s > 0) xcA[s] = xcA[s - 1] + Math.tan(alpha[s - 1]);
    }
    const sample = (arr, s) => {
      if (s <= 0) return arr[0];
      if (s >= N - 1) return arr[N - 1];
      const i = Math.floor(s), t = s - i;
      return arr[i] + (arr[i + 1] - arr[i]) * t;
    };
    C.xc = (s) => sample(xcA, s);
    C.slopeX = (s) => Math.tan(sample(alpha, s));
    C.heading = (s) => Math.atan2(-C.slopeX(s), 1); // yaw facing down the hill
    C.profile = (s) => -L.heightAt(s);

    // ---- terrain height: valley floor + rising banks + rolling noise outside
    const n2 = TR.noise2(map.seed + 99);
    // steep enough near the floor to keep the tire in, then easing into open hillside
    const bankH = (d) => (d < 12 ? 0.09 * d * d + 0.4 * d : 17.76 + (d - 12) * 0.75);
    C.terrain = function (x, z) {
      const s = -z;
      const u = x - C.xc(s);
      const d = Math.abs(u) - hw;
      let y = C.profile(s);
      // behind the start, rise up into the mountain
      if (s < 0) y += -s * 0.6;
      if (d > 0) {
        y += bankH(d);
        const k = Math.min(1, d / 14);
        y += (n2(x * 0.045, z * 0.045) * 5 + n2(x * 0.16, z * 0.16) * 1.2) * k;
      } else {
        y += n2(x * 0.3, z * 0.3) * 0.05; // a little surface texture
      }
      return y;
    };
    const nrm = { x: 0, y: 1, z: 0 };
    C.normalAt = function (x, z) {
      const e = 0.3;
      const nx = C.terrain(x - e, z) - C.terrain(x + e, z);
      const nz = C.terrain(x, z - e) - C.terrain(x, z + e);
      const ny = 2 * e;
      const l = Math.hypot(nx, ny, nz);
      nrm.x = nx / l; nrm.y = ny / l; nrm.z = nz / l;
      return nrm;
    };

    C.finishS = L.finishX;
    C.endS = L.endX;
    C.startS = 3;
    C.kickers = L.kickers;
    // distance signs every 250 m
    C.markers = [];
    for (let s = 250; s < C.finishS - 40; s += 250) C.markers.push(s);

    // ---- decor on the banks (purely visual)
    C.decor = [];
    const total = map.decor.reduce((a, d) => a + d[1], 0);
    const chooseDecor = () => {
      let r = R() * total;
      for (const d of map.decor) if ((r -= d[1]) <= 0) return d[0];
      return map.decor[0][0];
    };
    for (let s = -40; s < C.endS + 60; s += 1.5) {
      for (let k = 0; k < 2; k++) {
        const side = R() < 0.5 ? -1 : 1;
        const dist = hw + 3.5 + Math.pow(R(), 1.5) * 80;
        if (R() > 0.5 + 0.45 * (1 - (dist - hw) / 80)) continue;
        const x = C.xc(s) + side * dist, z = -(s + R() * 1.5);
        C.decor.push({ x, y: C.terrain(x, z), z, type: chooseDecor(), scale: TR.range(R, 0.75, 1.35), rot: R() * Math.PI * 2, seed: R() });
      }
    }
    return C;
  };
})(typeof window !== 'undefined' ? window : globalThis);
