// Procedural textures and models. Everything is generated at load time from
// noise, so the game ships without image or model files.
(function (root) {
  const TR = root.TR;
  const A = (TR.Assets = {});
  const lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  A.lin = lin;

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
  }
  function tex(c, opts) {
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    if (opts && opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }

  // Value noise whose lattice wraps with period p, for seamless tiles.
  function pnoise(seed) {
    const r = TR.rng(seed);
    const N = 4096;
    const tab = new Float32Array(N);
    for (let i = 0; i < N; i++) tab[i] = r() * 2 - 1;
    const at = (i, j, p) => {
      i = ((i % p) + p) % p; j = ((j % p) + p) % p;
      return tab[(i * 1619 + j * 31337 + ((i * j) & 255) * 7) & (N - 1)];
    };
    return function (x, y, p) {
      const i = Math.floor(x), j = Math.floor(y);
      const fx = TR.smooth(x - i), fy = TR.smooth(y - j);
      const a = at(i, j, p), b = at(i + 1, j, p), c = at(i, j + 1, p), d = at(i + 1, j + 1, p);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
  }
  // seamless fbm over a size×size tile, u,v in [0,1)
  function tileFbm(n, u, v, base, oct) {
    let s = 0, a = 1, norm = 0, p = base;
    for (let i = 0; i < oct; i++) {
      s += n(u * p, v * p, p) * a;
      norm += a; a *= 0.55; p *= 2;
    }
    return s / norm;
  }

  // ---------- terrain layer textures ----------
  const PALETTE = {
    grass: { a: '#4f6b2a', b: '#7a8f3e', c: '#3a5223', speck: '#a7a055' },
    dirt: { a: '#6e5640', b: '#8a6e50', c: '#4f3c2b', speck: '#a89070' },
    granite: { a: '#77756f', b: '#9a978e', c: '#55534e', speck: '#c2beb2' },
    darkrock: { a: '#4d5157', b: '#6b6f75', c: '#33363a', speck: '#8d9196' },
    basalt: { a: '#2c2a2b', b: '#423e3d', c: '#1c1a1b', speck: '#5a5250' },
    sandstone: { a: '#a5583a', b: '#c4744c', c: '#7f3f2a', speck: '#dc9a6a' },
    moonrock: { a: '#5a5a5e', b: '#757579', c: '#3e3e42', speck: '#9a9a9e' },
    snow: { a: '#dfe6ef', b: '#f7faff', c: '#b9c7d8', speck: '#ffffff' },
    icysnow: { a: '#d4e2f0', b: '#eef4fb', c: '#b8cbe0', speck: '#ffffff' },
    sand: { a: '#d8a86e', b: '#e8bd84', c: '#b88a55', speck: '#f2d4a2' },
    redsand: { a: '#c27a4a', b: '#d48f5c', c: '#9c5c36', speck: '#e6a878' },
    ash: { a: '#353233', b: '#48443f', c: '#232122', speck: '#6a625c' },
    scoria: { a: '#5a3428', b: '#74463a', c: '#3c221a', speck: '#8a5a48' },
    regolith: { a: '#8a8a8e', b: '#a2a2a6', c: '#6c6c70', speck: '#c4c4c8' },
    brightregolith: { a: '#a8a8ac', b: '#bdbdc1', c: '#8c8c90', speck: '#dcdce0' },
  };
  const cache = {};
  A.layer = function (type) {
    if (cache[type]) return cache[type];
    const S = 512;
    const [c, g] = canvas(S, S);
    const P = PALETTE[type];
    const ca = lin(P.a), cb = lin(P.b), cc = lin(P.c);
    const n = pnoise(type.length * 131 + type.charCodeAt(0));
    const n2 = pnoise(type.length * 17 + 5);
    const img = g.createImageData(S, S);
    const rockish = /rock|granite|basalt|sandstone/.test(type);
    const tmp = new THREE.Color();
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        let f = tileFbm(n, u, v, 4, 6) * 0.5 + 0.5;
        const fine = tileFbm(n2, u, v, 64, 2);
        if (rockish) {
          // layered strata and sharp cracks
          const strata = Math.sin((v + tileFbm(n2, u, v, 4, 3) * 0.08) * Math.PI * (type === 'sandstone' ? 18 : 7));
          f = f * 0.75 + strata * 0.12 + 0.12;
          const crack = Math.abs(tileFbm(n, u + 0.37, v + 0.11, 8, 3));
          if (crack < 0.035) f *= 0.55 + crack * 8;
        }
        if (type === 'sand' || type === 'redsand') f += Math.sin((u * 2 + tileFbm(n2, u, v, 4, 2) * 0.15) * Math.PI * 28) * 0.06;
        tmp.copy(cc).lerp(ca, TR.clamp(f * 1.6, 0, 1)).lerp(cb, TR.clamp(f * 1.6 - 0.8, 0, 1));
        const k = 1 + fine * (type.includes('snow') ? 0.07 : 0.14);
        const i = (y * S + x) * 4;
        // back to sRGB bytes
        img.data[i] = Math.pow(TR.clamp(tmp.r * k, 0, 1), 1 / 2.2) * 255;
        img.data[i + 1] = Math.pow(TR.clamp(tmp.g * k, 0, 1), 1 / 2.2) * 255;
        img.data[i + 2] = Math.pow(TR.clamp(tmp.b * k, 0, 1), 1 / 2.2) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const R = TR.rng(type.length * 7);
    const dot = (x, y, r, col, a) => {
      g.globalAlpha = a;
      g.fillStyle = col;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        g.beginPath(); g.arc(x + ox, y + oy, r, 0, 6.283); g.fill();
      }
    };
    if (type === 'grass') {
      // tiny blades and clover give the top-down grass its grain
      for (let i = 0; i < 9000; i++) {
        const x = R() * S, y = R() * S, l = 2 + R() * 5, a = R() * 6.283;
        g.globalAlpha = 0.25 + R() * 0.3;
        g.strokeStyle = R() < 0.5 ? P.speck : P.c;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
    } else if (type.includes('snow')) {
      for (let i = 0; i < 2500; i++) dot(R() * S, R() * S, 0.6, '#ffffff', 0.5 + R() * 0.5);
    } else {
      for (let i = 0; i < 2200; i++) dot(R() * S, R() * S, 0.5 + R() * (rockish ? 1.4 : 2.2), R() < 0.5 ? P.speck : P.c, 0.15 + R() * 0.35);
    }
    g.globalAlpha = 1;
    return (cache[type] = tex(c, { repeat: true }));
  };

  // ---------- vegetation textures ----------
  A.barkTex = function (light) {
    const key = 'bark' + light;
    if (cache[key]) return cache[key];
    const [c, g] = canvas(128, 512);
    const R = TR.rng(light ? 9 : 8);
    if (light) {
      // birch: white bark with dark lenticels
      g.fillStyle = '#e8e4da'; g.fillRect(0, 0, 128, 512);
      for (let i = 0; i < 70; i++) {
        g.fillStyle = `rgba(30,28,25,${0.4 + R() * 0.5})`;
        const y = R() * 512, w = 10 + R() * 50;
        g.fillRect(R() * 128 - w / 2, y, w, 1.5 + R() * 4);
      }
    } else {
      g.fillStyle = '#5a4433'; g.fillRect(0, 0, 128, 512);
      for (let i = 0; i < 260; i++) {
        g.strokeStyle = `rgba(${R() < 0.5 ? '25,18,12' : '120,98,78'},${0.3 + R() * 0.4})`;
        g.lineWidth = 1 + R() * 3;
        const x = R() * 128;
        g.beginPath(); g.moveTo(x, R() * 512);
        g.lineTo(x + (R() - 0.5) * 8, R() * 512); g.stroke();
      }
    }
    return (cache[key] = tex(c, { repeat: true }));
  };

  // A branch card: a stem along v with needles/leaves either side, on transparency.
  A.foliageTex = function (kind) {
    if (cache['fol' + kind]) return cache['fol' + kind];
    const S = 256;
    const [c, g] = canvas(S, S);
    const R = TR.rng(kind.length * 31 + 3);
    const snow = kind.includes('Snow');
    if (kind === 'birch' || kind === 'shrub') {
      const cols = kind === 'birch' ? ['#5f8a2e', '#7aa23a', '#4a7224', '#9cb84a'] : ['#7a7240', '#8f8650', '#5f5a34', '#a59a62'];
      for (let i = 0; i < (kind === 'birch' ? 420 : 300); i++) {
        const a = R() * 6.283, r = Math.sqrt(R()) * 110;
        const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
        g.fillStyle = cols[Math.floor(R() * cols.length)];
        g.save(); g.translate(x, y); g.rotate(R() * 6.283);
        g.beginPath(); g.ellipse(0, 0, kind === 'birch' ? 6 : 3, kind === 'birch' ? 3.6 : 1.6, 0, 0, 6.283); g.fill();
        g.restore();
      }
    } else {
      // conifer branch: stem along the card, needle sprays either side
      const dark = kind.startsWith('fir') ? ['#1f3a22', '#2a4a2a', '#183020'] : ['#2c4a26', '#3a5a2e', '#22401f'];
      g.lineCap = 'round';
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < 520; i++) {
          const t = R();
          const x0 = 128 + (R() - 0.5) * 6, y0 = 250 - t * 240;
          const spread = (1 - t) * 105 + 18;
          const len = spread * (0.5 + R() * 0.5);
          const ang = (side ? 1 : -1) * (0.45 + R() * 0.9) - Math.PI / 2;
          g.strokeStyle = dark[Math.floor(R() * dark.length)];
          g.lineWidth = 1.2 + R() * 1.4;
          g.beginPath(); g.moveTo(x0, y0);
          g.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len * 0.55); g.stroke();
        }
      }
      g.strokeStyle = '#3a2c1e'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(128, 255); g.lineTo(128, 10); g.stroke();
      if (snow) {
        for (let i = 0; i < 260; i++) {
          const t = R();
          const x = 128 + (R() - 0.5) * ((1 - t) * 190 + 20), y = 250 - t * 230;
          g.fillStyle = 'rgba(250,252,255,0.95)';
          g.beginPath(); g.ellipse(x, y, 4 + R() * 7, 2 + R() * 3, 0, 0, 6.283); g.fill();
        }
      }
    }
    return (cache['fol' + kind] = tex(c));
  };

  A.grassTex = function (base, tip) {
    const key = 'grass' + base + tip;
    if (cache[key]) return cache[key];
    const [c, g] = canvas(256, 256);
    const R = TR.rng(77);
    for (let i = 0; i < 140; i++) {
      const x = 10 + R() * 236, h = 120 + R() * 130, bend = (R() - 0.5) * 70;
      const gr = g.createLinearGradient(0, 256, 0, 256 - h);
      gr.addColorStop(0, '#2a3a18');
      gr.addColorStop(0.35, base);
      gr.addColorStop(1, tip);
      g.strokeStyle = gr;
      g.lineWidth = 2 + R() * 2.5;
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, 256);
      g.quadraticCurveTo(x + bend * 0.3, 256 - h * 0.6, x + bend, 256 - h); g.stroke();
    }
    return (cache[key] = tex(c));
  };

  A.softDot = function () {
    if (cache.dot) return cache.dot;
    const [c, g] = canvas(64, 64);
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    return (cache.dot = t);
  };

  A.cloud = function (seed) {
    const [c, g] = canvas(512, 256);
    const R = TR.rng(seed);
    for (let i = 0; i < 60; i++) {
      const x = 80 + R() * 352, y = 120 + (R() - 0.5) * 70 - Math.abs(x - 256) * 0.12;
      const rad = 20 + R() * 60;
      const gr = g.createRadialGradient(x, y - rad * 0.3, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,0.75)');
      gr.addColorStop(0.7, 'rgba(240,244,250,0.35)');
      gr.addColorStop(1, 'rgba(230,236,245,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, rad, 0, 6.283); g.fill();
    }
    g.globalCompositeOperation = 'source-atop';
    const sh = g.createLinearGradient(0, 80, 0, 220);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(90,100,120,0.4)');
    g.fillStyle = sh; g.fillRect(0, 0, 512, 256);
    return tex(c);
  };

  A.smoke = function () {
    const [c, g] = canvas(256, 256);
    const R = TR.rng(4);
    for (let i = 0; i < 40; i++) {
      const x = 128 + (R() - 0.5) * 120, y = 128 + (R() - 0.5) * 120, rad = 30 + R() * 50;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 6.283); g.fill();
    }
    return tex(c);
  };

  A.earth = function () {
    const [c, g] = canvas(1024, 512);
    const n = TR.noise2(3), n2 = TR.noise2(4);
    const img = g.createImageData(1024, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 1024; x++) {
      const a = (x / 1024) * Math.PI * 2, lat = y / 512;
      const v = n(Math.cos(a) * 2.5 + 5, Math.sin(a) * 2.5 + lat * 5) * 0.7 + n2(Math.cos(a) * 7, Math.sin(a) * 7 + lat * 14) * 0.3;
      const cl = n2(Math.cos(a) * 6 + 30, Math.sin(a) * 6 + lat * 11) + n(Math.cos(a) * 14, lat * 30) * 0.3;
      let col;
      if (lat < 0.07 || lat > 0.93) col = [235, 240, 248];
      else if (v > 0.1) col = v > 0.32 ? [150, 128, 92] : [72, 112, 58];
      else col = [22, 58, 120];
      if (cl > 0.2) col = col.map((k) => k + (250 - k) * TR.clamp((cl - 0.2) * 3, 0, 0.9));
      const i = (y * 1024 + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return tex(c);
  };

  // ---------- geometry ----------
  function quad(pos, nor, uv, a, b, c, d, n) {
    // a-b-c-d counter-clockwise; n = normal per vertex (array of 4) or single
    const P = [a, b, c, a, c, d];
    const U = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    const NI = [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < 6; i++) {
      pos.push(P[i].x, P[i].y, P[i].z);
      const nn = Array.isArray(n) ? n[NI[i]] : n;
      nor.push(nn.x, nn.y, nn.z);
      uv.push(U[i][0], U[i][1]);
    }
  }
  function geom(pos, nor, uv) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // Conifer foliage: tiers of drooping branch cards around the trunk.
  A.coniferFoliage = function (opts) {
    const pos = [], nor = [], uv = [];
    const R = TR.rng(opts.seed || 1);
    const H = opts.height, base = opts.base, tiers = opts.tiers, per = opts.per;
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      const y = base + (H - base) * Math.pow(t, 0.92);
      const L = opts.radius * Math.pow(1 - t, 0.85) + 0.35;
      for (let i = 0; i < per; i++) {
        const a = k * 0.73 + (i / per) * Math.PI * 2 + (R() - 0.5) * 0.4;
        const droop = -0.25 - R() * 0.25 - (1 - t) * 0.15;
        const dir = V(Math.cos(a), 0, Math.sin(a));
        const side = V(-dir.z, 0, dir.x).multiplyScalar(L * 0.42);
        const root = V(0, y, 0).addScaledVector(dir, 0.1);
        const tip = root.clone().addScaledVector(dir, L).add(V(0, droop * L, 0));
        const a0 = root.clone().sub(side.clone().multiplyScalar(0.35)), b0 = root.clone().add(side.clone().multiplyScalar(0.35));
        const c0 = tip.clone().add(side), d0 = tip.clone().sub(side);
        // soft "volume" normals: outward from the crown axis and up
        const nIn = V(dir.x * 0.3, 1, dir.z * 0.3).normalize(), nOut = V(dir.x, 0.6, dir.z).normalize();
        // u runs across the card, v from the stem base (0) to the tip (1)
        quad(pos, nor, uv, a0, b0, c0, d0, [nIn, nIn, nOut, nOut]);
      }
    }
    // top spire: two crossed vertical cards
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI / 2;
      const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
      const y0 = H - 1.4, y1 = H + 0.6;
      quad(pos, nor, uv, V(-dx, y0, -dz), V(dx, y0, dz), V(dx * 0.2, y1, dz * 0.2), V(-dx * 0.2, y1, -dz * 0.2), V(0, 1, 0));
    }
    return geom(pos, nor, uv);
  };

  // Leafy crown: clusters of leaf cards with spherical normals.
  A.leafCrown = function (opts) {
    const pos = [], nor = [], uv = [];
    const R = TR.rng(opts.seed || 2);
    const c = V(0, opts.cy, 0);
    for (let i = 0; i < opts.cards; i++) {
      const p = V((R() - 0.5) * 2, (R() - 0.5) * 2, (R() - 0.5) * 2).normalize().multiplyScalar(Math.pow(R(), 0.4));
      p.x *= opts.rx; p.z *= opts.rx; p.y *= opts.ry;
      p.add(c);
      const s = opts.size * (0.7 + R() * 0.5);
      const ax = V(R() - 0.5, R() - 0.5, R() - 0.5).normalize();
      const bx = V(R() - 0.5, R() - 0.5, R() - 0.5).normalize().cross(ax).normalize();
      ax.multiplyScalar(s); bx.multiplyScalar(s);
      const n = p.clone().sub(c).normalize().add(V(0, 0.35, 0)).normalize();
      quad(pos, nor, uv, p.clone().sub(ax).sub(bx), p.clone().add(ax).sub(bx), p.clone().add(ax).add(bx), p.clone().sub(ax).add(bx), n);
    }
    return geom(pos, nor, uv);
  };

  A.grassClump = function () {
    const pos = [], nor = [], uv = [];
    const up = V(0, 1, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const dx = Math.cos(a) * 0.55, dz = Math.sin(a) * 0.55;
      quad(pos, nor, uv, V(-dx, 0, -dz), V(dx, 0, dz), V(dx, 0.7, dz), V(-dx, 0.7, -dz), up);
    }
    return geom(pos, nor, uv);
  };

  // Branching dead tree / bare branches as merged cylinders.
  A.branches = function (seed, height) {
    const R = TR.rng(seed);
    const parts = [];
    function limb(start, dir, len, rad, depth) {
      const g = new THREE.CylinderGeometry(rad * 0.6, rad, len, 7, 1, true);
      g.translate(0, len / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.clone().normalize());
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      g.translate(start.x, start.y, start.z);
      parts.push(g);
      if (depth <= 0) return;
      const end = start.clone().addScaledVector(dir.clone().normalize(), len);
      const n = 2 + Math.floor(R() * 2);
      for (let i = 0; i < n; i++) {
        const d = dir.clone().normalize().add(V((R() - 0.5) * 1.6, R() * 0.5, (R() - 0.5) * 1.6)).normalize();
        const from = start.clone().lerp(end, 0.55 + R() * 0.45);
        limb(from, d, len * (0.45 + R() * 0.2), rad * 0.55, depth - 1);
      }
    }
    limb(V(0, -0.3, 0), V(0, 1, 0), height, height * 0.035, 2);
    return mergeGeos(parts);
  };

  function mergeGeos(list) {
    const pos = [], nor = [], uv = [];
    for (let g of list) {
      g = g.index ? g.toNonIndexed() : g;
      pos.push(...g.attributes.position.array);
      nor.push(...g.attributes.normal.array);
      uv.push(...g.attributes.uv.array);
    }
    return geom(pos, nor, uv);
  }
  A.mergeGeos = mergeGeos;

  A.trunk = function (height, r0, r1) {
    const g = new THREE.CylinderGeometry(r1, r0, height, 10, 4, true);
    g.translate(0, height / 2 - 0.3, 0);
    const uvA = g.attributes.uv;
    for (let i = 0; i < uvA.count; i++) uvA.setY(i, uvA.getY(i) * height * 0.4);
    return g;
  };

  A.saguaro = function () {
    const parts = [];
    const col = (r, h, x, y, z) => {
      const g = new THREE.CylinderGeometry(r, r * 1.05, h, 16, 3, true);
      g.translate(x, y + h / 2, z);
      parts.push(g);
      const cap = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.translate(x, y + h, z);
      parts.push(cap);
    };
    col(0.4, 6.5, 0, -0.3, 0);
    const arm = (side, y, out, up) => {
      // elbow from the trunk outwards, then the arm grows straight up
      const e = new THREE.TorusGeometry(out, 0.28, 10, 12, Math.PI / 2);
      e.rotateZ(-Math.PI / 2);
      e.rotateY(side > 0 ? 0 : Math.PI);
      e.translate(side * out, y + out, 0);
      parts.push(e);
      col(0.28, up, side * out, y + out, 0);
    };
    arm(1, 2.2, 0.9, 2.2);
    arm(-1, 3.0, 0.8, 1.7);
    const g = mergeGeos(parts);
    const uvA = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, Math.atan2(p.getZ(i), p.getX(i)) * 2.5, p.getY(i) * 0.5);
    return g;
  };
  A.cactusTex = function () {
    if (cache.cactus) return cache.cactus;
    const [c, g] = canvas(256, 128);
    for (let x = 0; x < 256; x++) {
      const k = 0.65 + 0.35 * Math.cos((x / 256) * Math.PI * 2 * 6);
      g.fillStyle = `rgb(${Math.round(70 * k)},${Math.round(110 * k)},${Math.round(68 * k)})`;
      g.fillRect(x, 0, 1, 128);
    }
    const R = TR.rng(3);
    for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(240,230,200,0.6)'; g.fillRect(R() * 256, R() * 128, 1, 1); }
    return (cache.cactus = tex(c, { repeat: true }));
  };

  // Smooth boulder: a displaced sphere.
  A.rockGeo = function (seed) {
    const g = new THREE.SphereGeometry(1, 28, 18);
    const n = TR.noise2(seed * 13 + 1), n2 = TR.noise2(seed * 13 + 2);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const d = 1 + n(v.x * 1.6 + v.y * 0.7, v.z * 1.6 - v.y * 0.5) * 0.28 + n2(v.x * 4 + v.z, v.y * 4 - v.z) * 0.07;
      v.multiplyScalar(d);
      // flatten the bottom and one facet so rocks look broken, not blobby
      if (v.y < -0.25) v.y = -0.25 + (v.y + 0.25) * 0.3;
      if (v.x > 0.7) v.x = 0.7 + (v.x - 0.7) * 0.4;
      p.setXYZ(i, v.x, v.y * 0.72, v.z);
    }
    g.computeVertexNormals();
    return g;
  };

  // ---------- the tire ----------
  A.sidewall = function () {
    const [c, g] = canvas(1024, 64);
    g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 64);
    g.font = '600 34px "Archivo", Arial, sans-serif';
    g.fillStyle = '#d8d8d8';
    g.textBaseline = 'middle';
    g.fillText('ROADMASTER  A/T   225/65 R17   102H', 30, 34);
    g.fillText('ROADMASTER  A/T   225/65 R17   102H', 542, 34);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  };

  A.buildTire = function (envMap) {
    const G = THREE;
    const r = TR.TIRE_R, W = 0.21;
    const root = new G.Group(), lean = new G.Group(), spin = new G.Group();
    root.add(lean); lean.add(spin);

    const prof = [];
    const rin = 0.37, rout = r - 0.03;
    prof.push(new G.Vector2(rin, -W * 0.85), new G.Vector2(rin + 0.04, -W));
    for (let i = 0; i <= 8; i++) {
      const a = -Math.PI / 2 + (i / 8) * (Math.PI / 2);
      prof.push(new G.Vector2(rout - 0.07 + Math.cos(a) * 0.07, -W + 0.07 + Math.sin(a) * 0.07));
    }
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      prof.push(new G.Vector2(rout - 0.07 + Math.cos(a) * 0.07, W - 0.07 + Math.sin(a) * 0.07));
    }
    prof.push(new G.Vector2(rin + 0.04, W), new G.Vector2(rin, W * 0.85));
    const rubber = new G.MeshStandardMaterial({ color: lin('#202022'), roughness: 0.82, side: G.DoubleSide, envMap, envMapIntensity: 0.3 });
    const body = new G.Mesh(new G.LatheGeometry(prof, 96), rubber);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    spin.add(body);

    // tread: two staggered rows of angled lugs plus a center rib
    const lug = new G.BoxGeometry(0.16, 0.045, 0.11);
    const nLug = 36;
    const treads = new G.InstancedMesh(lug, new G.MeshStandardMaterial({ color: lin('#1b1b1d'), roughness: 0.9, envMap, envMapIntensity: 0.2 }), nLug * 2);
    const m = new G.Matrix4(), q = new G.Quaternion(), p = new G.Vector3(), s = new G.Vector3(1, 1, 1);
    let k = 0;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < nLug; i++) {
        const a = ((i + row * 0.5) / nLug) * Math.PI * 2;
        p.set((row ? 1 : -1) * 0.1, Math.cos(a) * (rout + 0.012), Math.sin(a) * (rout + 0.012));
        q.setFromEuler(new G.Euler(a, 0, 0)).multiply(new G.Quaternion().setFromEuler(new G.Euler(0, (row ? 1 : -1) * 0.45, 0)));
        m.compose(p, q, s);
        treads.setMatrixAt(k++, m);
      }
    }
    treads.castShadow = true;
    spin.add(treads);

    const swTex = A.sidewall();
    const swMat = new G.MeshStandardMaterial({ map: swTex, alphaMap: swTex, transparent: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1 });
    for (const side of [-1, 1]) {
      const ring = new G.RingGeometry(0.44, 0.52, 96, 1);
      const uvA = ring.attributes.uv, pos = ring.attributes.position;
      for (let i = 0; i < uvA.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        uvA.setXY(i, (Math.atan2(y, x) / (Math.PI * 2) + 0.5) * 2 * side, (Math.hypot(x, y) - 0.44) / 0.08);
      }
      const rm = new G.Mesh(ring, swMat);
      rm.rotation.y = (side * Math.PI) / 2;
      rm.position.x = side * (W + 0.003);
      spin.add(rm);
    }

    const alloy = new G.MeshStandardMaterial({ color: lin('#c9ccd1'), metalness: 1, roughness: 0.28, envMap, envMapIntensity: 1.1 });
    const dark = new G.MeshStandardMaterial({ color: lin('#3a3c41'), metalness: 0.8, roughness: 0.45, envMap });
    const barrel = new G.Mesh(new G.CylinderGeometry(0.372, 0.372, W * 1.7, 48, 1, true), dark);
    barrel.rotation.z = Math.PI / 2;
    spin.add(barrel);
    for (const side of [-1, 1]) {
      const lip = new G.Mesh(new G.TorusGeometry(0.372, 0.02, 10, 64), alloy);
      lip.rotation.y = Math.PI / 2;
      lip.position.x = side * W * 0.85;
      spin.add(lip);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const sp = new G.Mesh(new G.BoxGeometry(0.05, 0.28, 0.06), alloy);
        sp.position.set(side * 0.1, Math.cos(a) * 0.2, Math.sin(a) * 0.2);
        sp.rotation.x = -a;
        sp.castShadow = true;
        spin.add(sp);
      }
      const hub = new G.Mesh(new G.CylinderGeometry(0.09, 0.11, 0.07, 24), alloy);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = side * 0.11;
      spin.add(hub);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.6;
        const nut = new G.Mesh(new G.CylinderGeometry(0.014, 0.014, 0.03, 6), dark);
        nut.rotation.z = Math.PI / 2;
        nut.position.set(side * 0.15, Math.cos(a) * 0.06, Math.sin(a) * 0.06);
        spin.add(nut);
      }
    }
    const disc = new G.Mesh(new G.CylinderGeometry(0.33, 0.33, 0.015, 48), dark);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = 0.06;
    spin.add(disc);
    root.userData = { lean, spin };
    return root;
  };
})(typeof window !== 'undefined' ? window : globalThis);
