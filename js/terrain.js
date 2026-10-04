// Natural terrain shared by physics and rendering. No paths, no tracks,
// nothing man-made: just landforms.
//
// Two shapes:
//  - 'mountain': a single peak whose face runs down -z into a broad valley
//    and a bowl where the tire eventually comes to rest.
//  - 'endless':  a mountainside that keeps descending along -z forever.
//
// Three.js axes: y up, the slope faces -z, s = -z is distance downhill.
// Trees and rocks are generated per 128 m chunk from a hash of the chunk
// coordinates, so the world can be streamed in any direction indefinitely.
(function (root) {
  const TR = root.TR;

  TR.TIRE_R = 0.62;
  TR.CHUNK = 128;
  TR.WORLD = { x0: -950, x1: 950, s0: -300, s1: 2800 }; // mountain mode extent

  function hash3(a, b, c) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  TR.hash3 = hash3;

  TR.buildTerrain = function (map, mode) {
    const T = map.terrain;
    const endless = mode === 'endless';
    const W = { map, mode, endless };
    const nA = TR.noise2(map.seed), nB = TR.noise2(map.seed + 1), nC = TR.noise2(map.seed + 2), nD = TR.noise2(map.seed + 3);
    const nE = TR.noise2(map.seed + 4), nG = TR.noise2(map.seed + 6), nH = TR.noise2(map.seed + 7);

    const fbm = (n, x, y, oct) => {
      let s = 0, a = 1, f = 1, norm = 0;
      for (let i = 0; i < oct; i++) {
        s += n(x * f + i * 17.3, y * f - i * 9.1) * a;
        norm += a; a *= 0.5; f *= 2.02;
      }
      return s / norm;
    };
    const ridged = (x, y) => {
      let s = 0, a = 1, f = 1, norm = 0;
      for (let i = 0; i < 4; i++) {
        const v = 1 - Math.abs(nB(x * f + i * 31.7, y * f + i * 7.3));
        s += v * v * a;
        norm += a; a *= 0.5; f *= 2.1;
      }
      return s / norm;
    };

    // Impact craters, hashed per 220 m cell so they exist everywhere.
    const CC = 220;
    const craterCell = new Map();
    function cratersIn(cx, cs) {
      const k = cx * 100003 + cs;
      let list = craterCell.get(k);
      if (list) return list;
      list = [];
      const r = TR.rng(hash3(map.seed, cx, cs));
      const n = Math.floor(r() * 3.2);
      for (let i = 0; i < n; i++) {
        const big = r() < 0.15;
        const c = { x: (cx + r()) * CC, s: (cs + r()) * CC, R: big ? 40 + r() * 60 : 7 + r() * 30 };
        c.d = c.R * (0.12 + r() * 0.08);
        list.push(c);
      }
      craterCell.set(k, list);
      return list;
    }
    function craters(x, s) {
      let y = 0;
      const cx = Math.floor(x / CC), cs = Math.floor(s / CC);
      for (let a = cx - 1; a <= cx + 1; a++) for (let b = cs - 1; b <= cs + 1; b++) {
        for (const c of cratersIn(a, b)) {
          const d = Math.hypot(x - c.x, s - c.s) / c.R;
          if (d < 1.6) {
            if (d < 1) y += c.d * (d * d - 1);
            y += c.d * 0.35 * Math.exp(-Math.pow((d - 1) / 0.22, 2));
          }
        }
      }
      return y;
    }

    // Shared small/medium relief: gullies that run downhill, hummocks that
    // make the tire bounce, and patchy rock bands that drop it off ledges.
    // stretch: how much landforms are elongated down the fall line. The
    // endless slope uses more so it never forms hollows the tire can't leave.
    const stretch = endless ? 4 : 2.2;
    function relief(x, s, strength) {
      let y = 0;
      // anisotropic ridges: stretched along the fall line, like real erosion
      y += T.ridge * (ridged(x / T.ridgeScale, s / (T.ridgeScale * stretch)) - 0.45) * 2 * strength;
      y += T.medium * fbm(nC, x / 85, s / (50 * stretch), 3);
      y += T.bumps * nD(x / 19, s / 21);
      // hummocks: rounded mounds 10-16 m across
      y += T.hummock * (nE(x / 11, s / 13) + 0.45 * nE(x / 5.5 + 40, s / 6.5 - 20));
      // rock bands: wavy, patchy steps down the slope
      const u = s / 95 + nA(x / 170, s / 300) * 3.2;
      const fr = u - Math.floor(u);
      const patch = TR.clamp(nG(x / 140, s / 200) * 2.6 - 0.55, 0, 1) * TR.clamp(nG(x / 47 + 9, s / 61) + 0.6, 0, 1);
      y -= T.ledge * patch * (TR.smooth(TR.clamp((fr - 0.86) / 0.05, 0, 1)) - fr);
      if (T.dunes) {
        // longitudinal (seif) dunes: crests run down the slope
        const ph = x * 0.03 + s * 0.003 + nA(x / 160, s / 400) * 3;
        const crest = 1 - Math.abs(Math.sin(ph));
        y += T.dunes * crest * crest;
      }
      if (T.craters) y += craters(x, s);
      return y;
    }

    // Distant ranges that frame the view (never reachable).
    function ranges(x, s, mask) {
      if (mask <= 0) return 0;
      return mask * (320 * ridged(x / 700, s / 700) + 180 * fbm(nH, x / 1500, s / 1500, 3));
    }

    if (!endless) {
      W.height = function (x, z) {
        const s = -z;
        const r = Math.hypot(x * 0.85, s);
        let y = T.peak * Math.exp(-r / T.falloff);
        const vs = TR.smooth(TR.clamp((s - 100) / 900, 0, 1));
        y += T.valley * (1 - Math.exp(-(x * x) / (T.valleyWidth * T.valleyWidth))) * vs;
        y += 170 * TR.smooth(TR.clamp((s - 2200) / 700, 0, 1));
        const rw = (1 - Math.exp(-r / 120)) * (0.35 + 0.65 * Math.exp(-r / 1400));
        y += relief(x, s, rw) * (0.4 + 0.6 * Math.min(1, r / 150));
        if (T.crater && r < 170) {
          const k = 1 - r / 170;
          y -= 95 * k * k;
        }
        const out = Math.max(Math.abs(x) - 1050, s - 3000, -s - 500);
        y += ranges(x, s, TR.smooth(TR.clamp(out / 900, 0, 1)));
        return y;
      };
      W.elevation = (x, z, y) => y; // snow line / tree line use absolute height
    } else {
      const base = T.endlessSlope;
      // average descent with long, gentle variations in steepness
      const trend = (s) => -(base * s) - 35 * fbm(nA, s / 1500 + 50, 3.7, 2);
      W.height = function (x, z) {
        const s = -z;
        let y = trend(s);
        y += relief(x, s, 0.8);
        y += ranges(x, s, TR.smooth(TR.clamp((Math.abs(x) - 1300) / 1000, 0, 1)));
        // the far sides rise so the slope reads as one mountainside
        y += Math.max(0, Math.abs(x) - 900) * 0.25;
        return y;
      };
      // detrended height, so snow sits on ridge tops and trees thin out there
      W.elevation = (x, z, y) => y - trend(-z) + 200;
    }

    const nrm = { x: 0, y: 1, z: 0 };
    W.normalAt = function (x, z) {
      const e = 0.5;
      const nx = W.height(x - e, z) - W.height(x + e, z);
      const nz = W.height(x, z - e) - W.height(x, z + e);
      const ny = 2 * e;
      const l = Math.hypot(nx, ny, nz);
      nrm.x = nx / l; nrm.y = ny / l; nrm.z = nz / l;
      return nrm;
    };

    W.fallLine = function (x, z) {
      const e = 3;
      const gx = (W.height(x + e, z) - W.height(x - e, z)) / (2 * e);
      const gz = (W.height(x, z + e) - W.height(x, z - e)) / (2 * e);
      return Math.atan2(gx, gz);
    };

    // A fresh, random release point for each roll.
    W.randomStart = function (rng) {
      const s = endless ? 30 + rng() * 30 : T.crater ? 190 + rng() * 40 : 55 + rng() * 40;
      const x = (rng() - 0.5) * 70;
      const z = -s;
      return { x, z, yaw: W.fallLine(x, z) + (rng() - 0.5) * 0.6, push: 0.8 + rng() * 2.4 };
    };

    // ---------- per-chunk trees and rocks ----------
    const nF = TR.noise2(map.seed + 50);
    const clearStart = (x, s) => s < 170 && s > -60 && Math.abs(x) < 90;
    const trunkR = { pine: 0.28, fir: 0.3, birch: 0.18, firSnow: 0.3, pineSnow: 0.28, saguaro: 0.35, deadTree: 0.22, shrub: 0 };
    const chunkCache = new Map();
    W.chunk = function (cx, cz) {
      const key = cx + ',' + cz;
      let c = chunkCache.get(key);
      if (c) return c;
      const R = TR.rng(hash3(map.seed + 911, cx, cz));
      const x0 = cx * TR.CHUNK, z0 = cz * TR.CHUNK;
      c = { cx, cz, trees: [], rocks: [], obstacles: [] };
      if (map.trees) {
        const step = 8;
        for (let a = 0; a < TR.CHUNK; a += step) for (let b = 0; b < TR.CHUNK; b += step) {
          const px = x0 + a + R() * step, pz = z0 + b + R() * step, ps = -pz;
          const r1 = R(), r2 = R(), r3 = R(), r4 = R();
          if (clearStart(px, ps)) continue;
          const y = W.height(px, pz);
          const elev = W.elevation(px, pz, y);
          const line = map.trees.line + nF(px / 60, ps / 60) * 40;
          if (elev > line) continue;
          const n = W.normalAt(px, pz);
          if (n.y < 0.8) continue;
          const forest = nF(px / 220, ps / 220) * 0.5 + 0.5;
          const edge = TR.clamp((line - elev) / 60, 0, 1);
          if (r1 > Math.pow(forest, 2.2) * 0.5 * edge * map.trees.density) continue;
          const kind = map.trees.kinds[Math.floor(r2 * map.trees.kinds.length)];
          const scale = 0.75 + r3 * 0.6;
          c.trees.push({ x: px, y, z: pz, kind, scale, rot: r4 * 6.283, seed: r3 });
          if (trunkR[kind]) c.obstacles.push({ type: 'trunk', x: px, y, z: pz, r: trunkR[kind] * scale, h: 8 * scale });
        }
      }
      const rs = 11;
      for (let a = 0; a < TR.CHUNK; a += rs) for (let b = 0; b < TR.CHUNK; b += rs) {
        const px = x0 + a + R() * rs, pz = z0 + b + R() * rs, ps = -pz;
        const r1 = R(), r2 = R(), r3 = R(), r4 = R();
        if (clearStart(px, ps)) continue;
        const n = W.normalAt(px, pz);
        const steep = TR.clamp((0.92 - n.y) * 5, 0, 1);
        if (r1 > (0.02 + steep * 0.12) * map.rocks) continue;
        const big = r2 < 0.12;
        const size = big ? 1.6 + r3 * 2.2 : 0.25 + r3 * 0.85;
        const rock = { x: px, y: W.height(px, pz), z: pz, size, rot: r4 * 6.283, tilt: r2, kind: Math.floor(r4 * 4) };
        c.rocks.push(rock);
        if (size > 0.9) c.obstacles.push({ type: 'rock', x: px, y: rock.y + size * 0.15, z: pz, r: size * 0.85, h: size * 1.2 });
      }
      chunkCache.set(key, c);
      return c;
    };
    W.dropChunk = (cx, cz) => chunkCache.delete(cx + ',' + cz);

    // obstacles within ~20 m of (x,z)
    W.nearObstacles = function (x, z, out) {
      out.length = 0;
      const C = TR.CHUNK;
      const cx0 = Math.floor((x - 20) / C), cx1 = Math.floor((x + 20) / C);
      const cz0 = Math.floor((z - 20) / C), cz1 = Math.floor((z + 20) / C);
      for (let a = cx0; a <= cx1; a++) for (let b = cz0; b <= cz1; b++) {
        for (const o of W.chunk(a, b).obstacles) {
          if (Math.abs(o.x - x) < 20 && Math.abs(o.z - z) < 20) out.push(o);
        }
      }
      return out;
    };
    return W;
  };
})(typeof window !== 'undefined' ? window : globalThis);
