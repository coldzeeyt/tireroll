// Shared helpers: seeded RNG, noise, math and color utilities.
(function (root) {
  const TR = (root.TR = root.TR || {});

  TR.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  TR.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  TR.lerp = (a, b, t) => a + (b - a) * t;
  TR.smooth = (t) => t * t * (3 - 2 * t);
  TR.range = (r, a, b) => a + (b - a) * r();
  TR.pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  // Smooth 1D value noise in [-1, 1].
  TR.noise1 = function (seed) {
    const r = TR.rng(seed);
    const N = 512;
    const tab = new Float32Array(N);
    for (let i = 0; i < N; i++) tab[i] = r() * 2 - 1;
    return function (x) {
      const i = Math.floor(x);
      const f = x - i;
      const a = tab[((i % N) + N) % N];
      const b = tab[(((i + 1) % N) + N) % N];
      return a + (b - a) * TR.smooth(f);
    };
  };

  // Fractal noise with a few octaves.
  TR.fbm = function (seed, octaves) {
    const ns = [];
    for (let i = 0; i < octaves; i++) ns.push(TR.noise1(seed + i * 101));
    return function (x) {
      let s = 0, amp = 1, f = 1, norm = 0;
      for (let i = 0; i < octaves; i++) {
        s += ns[i](x * f) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2.03;
      }
      return s / norm;
    };
  };

  // Smooth 2D value noise in [-1, 1].
  TR.noise2 = function (seed) {
    const r = TR.rng(seed);
    const N = 256;
    const tab = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) tab[i] = r() * 2 - 1;
    const at = (i, j) => tab[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
    return function (x, y) {
      const i = Math.floor(x), j = Math.floor(y);
      const fx = TR.smooth(x - i), fy = TR.smooth(y - j);
      const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
  };

  TR.hexToRgb = function (hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  TR.mix = function (a, b, t, alpha) {
    const A = TR.hexToRgb(a), B = TR.hexToRgb(b);
    const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
    return alpha === undefined ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  };

  TR.rgba = function (hex, a) {
    const c = TR.hexToRgb(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  };

  TR.fmtTime = function (t) {
    if (!isFinite(t)) return '--:--.--';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
