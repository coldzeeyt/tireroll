// Procedural textures and low-poly model builders for the 3D world.
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
  function tex(c, srgb, repeat) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.encoding = THREE.sRGBEncoding;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    t.anisotropy = 4;
    return t;
  }

  // Grain texture multiplied over terrain vertex colors.
  A.groundDetail = function () {
    const [c, g] = canvas(256, 256);
    const img = g.createImageData(256, 256);
    const n1 = TR.noise2(11), n2 = TR.noise2(12);
    const r = TR.rng(5);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        // tileable by sampling on a torus-ish wrap (periodic noise via mod)
        const v = 0.86 + n1((x % 256) / 16, (y % 256) / 16) * 0.06 + n2(x / 5, y / 5) * 0.05 + (r() - 0.5) * 0.08;
        const k = Math.max(0, Math.min(255, v * 255));
        const i = (y * 256 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // pebbles
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.05 + r() * 0.08})`;
      g.beginPath();
      g.arc(r() * 256, r() * 256, 0.6 + r() * 2.2, 0, Math.PI * 2);
      g.fill();
    }
    return tex(c, false, true);
  };

  A.banner = function (text, bg, fg, checker) {
    const [c, g] = canvas(1024, 160);
    if (checker) {
      const s = 40;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 26; x++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
        g.fillRect(x * s, y * s, s, s);
      }
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(250, 18, 524, 124);
    } else {
      const gr = g.createLinearGradient(0, 0, 0, 160);
      gr.addColorStop(0, bg);
      gr.addColorStop(1, TR.mix(bg, '#000000', 0.35));
      g.fillStyle = gr;
      g.fillRect(0, 0, 1024, 160);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, 0, 1024, 10);
    }
    g.font = '900 104px "Bungee", "Arial Black", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = fg;
    g.fillText(text, 512, 86);
    return tex(c, true, false);
  };

  A.sidewall = function () {
    const [c, g] = canvas(1024, 64);
    g.fillStyle = '#000';
    g.fillRect(0, 0, 1024, 64);
    g.font = 'bold 40px "Bungee", "Arial Black", sans-serif';
    g.fillStyle = '#e8e8e8';
    g.textBaseline = 'middle';
    g.fillText('TIRE ROLL  •  ALL-TERRAIN  •  R17', 30, 34);
    g.fillText('TIRE ROLL  •  ALL-TERRAIN  •  R17', 542, 34);
    return tex(c, true, true);
  };

  A.softDot = function () {
    const [c, g] = canvas(64, 64);
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return tex(c, false, false);
  };

  A.cloud = function (seed) {
    const [c, g] = canvas(256, 128);
    const r = TR.rng(seed);
    for (let i = 0; i < 22; i++) {
      const x = 40 + r() * 176, y = 50 + r() * 40 - Math.abs(x - 128) * 0.15;
      const rad = 18 + r() * 34;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,0.9)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.45)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    // shade bottom
    g.globalCompositeOperation = 'source-atop';
    const sh = g.createLinearGradient(0, 40, 0, 128);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(60,70,90,0.35)');
    g.fillStyle = sh;
    g.fillRect(0, 0, 256, 128);
    return tex(c, true, false);
  };

  A.earth = function () {
    const [c, g] = canvas(512, 256);
    const n = TR.noise2(3), n2 = TR.noise2(4);
    const img = g.createImageData(512, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
      const a = (x / 512) * Math.PI * 2;
      const lat = y / 256;
      const v = n(Math.cos(a) * 2.5 + 5, Math.sin(a) * 2.5 + lat * 5) * 0.7 + n2(Math.cos(a) * 7, Math.sin(a) * 7 + lat * 14) * 0.3;
      const cl = n2(Math.cos(a) * 5 + 30, Math.sin(a) * 5 + lat * 9);
      const i = (y * 512 + x) * 4;
      let col;
      if (lat < 0.08 || lat > 0.92) col = [240, 245, 255];
      else if (v > 0.12) col = v > 0.35 ? [150, 130, 90] : [70, 140, 70];
      else col = [30, 80, 170];
      if (cl > 0.25) col = col.map((k) => k + (255 - k) * 0.8);
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return tex(c, true, false);
  };

  // ---------- geometry helpers ----------
  const V3 = THREE.Vector3;
  A.M = function (x, y, z, rx, ry, rz, sx, sy, sz) {
    const m = new THREE.Matrix4();
    m.compose(new V3(x || 0, y || 0, z || 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
      new V3(sx || 1, sy || sx || 1, sz || sx || 1));
    return m;
  };
  function jitter(geo, amt, seed) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
      const f = h - Math.floor(h);
      const h2 = Math.sin(x * 93.989 + y * 67.345 + z * 12.345 + seed) * 24634.6345;
      const f2 = h2 - Math.floor(h2);
      const k = 1 + (f - 0.5) * amt;
      p.setXYZ(i, x * k, y * (1 + (f2 - 0.5) * amt), z * k);
    }
    return geo;
  }
  A.jitter = jitter;
  A.part = function (geo, color, m) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    const col = lin(color);
    for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  A.merge = function (parts) {
    let total = 0;
    for (const p of parts) total += p.attributes.position.count;
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3);
    let o = 0;
    for (const p of parts) {
      pos.set(p.attributes.position.array, o * 3);
      col.set(p.attributes.color.array, o * 3);
      o += p.attributes.position.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  };

  // Low-poly decor models. Each returns a merged geometry with vertex colors.
  A.decorGeo = function (type, map) {
    const P = A.part, M = A.M;
    const parts = [];
    const G = THREE;
    switch (type) {
      case 'tree': {
        parts.push(P(new G.CylinderGeometry(0.22, 0.32, 3, 6), '#6b4a2b', M(0, 1.5, 0)));
        parts.push(P(jitter(new G.IcosahedronGeometry(1.9, 0), 0.35, 1), '#4f9e3a', M(0, 4.1, 0)));
        parts.push(P(jitter(new G.IcosahedronGeometry(1.4, 0), 0.35, 2), '#5cb444', M(0.9, 5.2, 0.3)));
        parts.push(P(jitter(new G.IcosahedronGeometry(1.2, 0), 0.35, 3), '#468f33', M(-0.8, 4.9, -0.4)));
        break;
      }
      case 'pine':
      case 'pineSnow': {
        const snow = type === 'pineSnow';
        parts.push(P(new G.CylinderGeometry(0.2, 0.28, 2, 6), '#5a3d24', M(0, 1, 0)));
        const cols = snow ? ['#2f5d4a', '#356a54', '#3c765e'] : ['#2f6b3a', '#377a43', '#3f874b'];
        for (let i = 0; i < 3; i++) {
          const r = 2.2 - i * 0.55, y = 2.4 + i * 1.6;
          parts.push(P(jitter(new G.ConeGeometry(r, 2.6, 7), 0.12, i), cols[i], M(0, y, 0)));
          if (snow) parts.push(P(new G.ConeGeometry(r * 0.72, 1.2, 7), '#f6fbff', M(0, y + 0.75, 0)));
        }
        break;
      }
      case 'bush':
      case 'bushSnow':
      case 'bushDry': {
        const c = type === 'bushSnow' ? '#f2f7fc' : type === 'bushDry' ? '#9a8048' : '#4a9a38';
        parts.push(P(jitter(new G.IcosahedronGeometry(0.9, 0), 0.4, 4), c, M(0, 0.6, 0)));
        parts.push(P(jitter(new G.IcosahedronGeometry(0.7, 0), 0.4, 5), c, M(0.8, 0.45, 0.2)));
        parts.push(P(jitter(new G.IcosahedronGeometry(0.6, 0), 0.4, 6), c, M(-0.7, 0.4, -0.2)));
        break;
      }
      case 'flower': {
        for (let i = 0; i < 5; i++) {
          const a = i * 1.3, r = 0.35 + (i % 2) * 0.3;
          parts.push(P(new G.CylinderGeometry(0.03, 0.03, 0.6, 3), '#3f8a2a', M(Math.cos(a) * r, 0.3, Math.sin(a) * r)));
          parts.push(P(new G.IcosahedronGeometry(0.16, 0), '#ffffff', M(Math.cos(a) * r, 0.65, Math.sin(a) * r)));
        }
        break;
      }
      case 'rock':
      case 'rockSnow':
      case 'rockMoon': {
        const c = type === 'rockMoon' ? '#8a8c96' : type === 'rockSnow' ? '#6c7a8c' : map.ground.rock;
        parts.push(P(jitter(new G.DodecahedronGeometry(1, 0), 0.5, 7), c, M(0, 0.4, 0, 0, 0, 0, 1.2, 0.8, 1)));
        if (type === 'rockSnow') parts.push(P(jitter(new G.DodecahedronGeometry(0.85, 0), 0.4, 8), '#ffffff', M(0, 0.85, 0, 0, 0, 0, 1.15, 0.45, 0.95)));
        break;
      }
      case 'cactus': {
        const c = '#3f8a4a';
        parts.push(P(new G.CylinderGeometry(0.42, 0.48, 5, 8), c, M(0, 2.5, 0)));
        parts.push(P(new G.SphereGeometry(0.42, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), c, M(0, 5, 0)));
        parts.push(P(new G.CylinderGeometry(0.28, 0.28, 1.2, 7), c, M(0.75, 2.2, 0, 0, 0, Math.PI / 2)));
        parts.push(P(new G.CylinderGeometry(0.28, 0.28, 1.8, 7), c, M(1.3, 3.0, 0)));
        parts.push(P(new G.CylinderGeometry(0.26, 0.26, 1.0, 7), c, M(-0.65, 3.0, 0, 0, 0, Math.PI / 2)));
        parts.push(P(new G.CylinderGeometry(0.26, 0.26, 1.4, 7), c, M(-1.1, 3.6, 0)));
        break;
      }
      case 'cactusSmall': {
        parts.push(P(jitter(new G.SphereGeometry(0.6, 8, 6), 0.1, 9), '#4f9a52', M(0, 0.5, 0, 0, 0, 0, 1, 1.2, 1)));
        parts.push(P(new G.IcosahedronGeometry(0.16, 0), '#ff5fa0', M(0, 1.2, 0)));
        break;
      }
      case 'skull': {
        parts.push(P(jitter(new G.DodecahedronGeometry(0.45, 0), 0.2, 10), '#efe6d2', M(0, 0.35, 0)));
        parts.push(P(new G.ConeGeometry(0.1, 0.7, 5), '#e2d6bc', M(0.45, 0.6, 0, 0, 0, -1.0)));
        parts.push(P(new G.ConeGeometry(0.1, 0.7, 5), '#e2d6bc', M(-0.45, 0.6, 0, 0, 0, 1.0)));
        break;
      }
      case 'deadTree': {
        const c = '#2a1e1a';
        parts.push(P(new G.CylinderGeometry(0.12, 0.3, 4.5, 5), c, M(0, 2.25, 0, 0, 0, 0.05)));
        parts.push(P(new G.CylinderGeometry(0.05, 0.12, 2, 4), c, M(0.6, 3.4, 0, 0, 0, -0.8)));
        parts.push(P(new G.CylinderGeometry(0.05, 0.1, 1.6, 4), c, M(-0.5, 2.8, 0.2, 0.2, 0, 0.9)));
        parts.push(P(new G.CylinderGeometry(0.04, 0.08, 1.2, 4), c, M(0.2, 4.4, -0.3, -0.5, 0, -0.3)));
        break;
      }
      case 'basalt': {
        const hs = [2.4, 3.6, 1.6, 2.9, 1.1];
        for (let i = 0; i < 5; i++) {
          const a = i * 1.25;
          parts.push(P(new G.CylinderGeometry(0.5, 0.5, hs[i], 6), i % 2 ? '#2a2226' : '#332a2e', M(Math.cos(a) * 0.8 * (i > 0), hs[i] / 2, Math.sin(a) * 0.8 * (i > 0))));
        }
        break;
      }
      case 'vent': {
        parts.push(P(jitter(new G.ConeGeometry(1.6, 1.8, 7, 1, true), 0.2, 11), '#2a2020', M(0, 0.9, 0)));
        parts.push(P(new G.CircleGeometry(0.55, 7), '#ff7a2a', M(0, 1.55, 0, -Math.PI / 2)));
        break;
      }
      case 'crystalSmall': {
        for (let i = 0; i < 4; i++) {
          const a = i * 1.7;
          parts.push(P(new G.OctahedronGeometry(0.4 + (i % 2) * 0.3, 0), i % 2 ? '#7fe8ff' : '#b28cff',
            M(Math.cos(a) * 0.5, 0.6 + (i % 2) * 0.3, Math.sin(a) * 0.5, 0.3 * i, 0, 0.2, 1, 2, 1)));
        }
        break;
      }
      case 'antenna': {
        parts.push(P(new G.CylinderGeometry(0.06, 0.08, 4, 5), '#cfd2da', M(0, 2, 0)));
        parts.push(P(new G.SphereGeometry(0.9, 10, 4, 0, Math.PI * 2, 0, 1.0), '#e8eaf0', M(0, 4.1, 0, -2.2, 0, 0)));
        parts.push(P(new G.BoxGeometry(1.2, 0.3, 1.2), '#9a9caa', M(0, 0.15, 0)));
        break;
      }
      case 'flag': {
        parts.push(P(new G.CylinderGeometry(0.04, 0.04, 3, 5), '#dddddd', M(0, 1.5, 0)));
        parts.push(P(new G.BoxGeometry(1.4, 0.8, 0.02), '#d8343a', M(0.72, 2.55, 0)));
        parts.push(P(new G.BoxGeometry(0.6, 0.4, 0.03), '#2a4aa8', M(0.32, 2.75, 0)));
        break;
      }
      default:
        parts.push(P(new G.BoxGeometry(1, 1, 1), '#ff00ff', M(0, 0.5, 0)));
    }
    return A.merge(parts);
  };

  // The hero: a detailed tire built from a lathe profile, tread blocks and a chrome rim.
  A.buildTire = function (envMap) {
    const G = THREE;
    const r = TR.TIRE_R;
    const W = 0.21; // half width
    const root = new G.Group();
    const lean = new G.Group();
    const spin = new G.Group();
    root.add(lean);
    lean.add(spin);

    // rubber body (lathe around Y, then turn so the axle is X)
    const prof = [];
    const rin = 0.37, rout = r - 0.035;
    prof.push(new G.Vector2(rin, -W * 0.85));
    prof.push(new G.Vector2(rin + 0.04, -W));
    for (let i = 0; i <= 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
      prof.push(new G.Vector2(rout - 0.06 + Math.cos(a) * 0.06, -W + 0.06 + Math.sin(a) * 0.06 + 0.0));
    }
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      prof.push(new G.Vector2(rout - 0.06 + Math.cos(a) * 0.06, W - 0.06 + Math.sin(a) * 0.06));
    }
    prof.push(new G.Vector2(rin + 0.04, W));
    prof.push(new G.Vector2(rin, W * 0.85));
    // fix the profile so it runs outward→inward properly (lathe needs monotonic order)
    const rubber = new G.MeshStandardMaterial({ color: A.lin('#1c1c1f'), roughness: 0.88, metalness: 0.0 });
    const body = new G.Mesh(new G.LatheGeometry(prof, 64), rubber);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    spin.add(body);

    // tread blocks: two staggered rows of angled lugs
    const lug = new G.BoxGeometry(0.17, 0.07, 0.13);
    const nLug = 30;
    const treads = new G.InstancedMesh(lug, new G.MeshStandardMaterial({ color: A.lin('#232326'), roughness: 0.95 }), nLug * 2);
    const m = new G.Matrix4(), q = new G.Quaternion(), e = new G.Euler(), s = new G.Vector3(1, 1, 1), p = new G.Vector3();
    let k = 0;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < nLug; i++) {
        const a = ((i + row * 0.5) / nLug) * Math.PI * 2;
        const x = (row ? 1 : -1) * 0.095;
        p.set(x, Math.cos(a) * (rout + 0.01), Math.sin(a) * (rout + 0.01));
        e.set(-a, (row ? 1 : -1) * 0.45, 0);
        // orient: local Y outward
        q.setFromEuler(new G.Euler(a, 0, 0));
        const tilt = new G.Quaternion().setFromEuler(new G.Euler(0, (row ? 1 : -1) * 0.5, 0));
        q.multiply(tilt);
        m.compose(p, q, s);
        treads.setMatrixAt(k++, m);
      }
    }
    treads.castShadow = true;
    spin.add(treads);

    // sidewall lettering rings
    const swTex = A.sidewall();
    const swMat = new G.MeshStandardMaterial({ map: swTex, color: 0xffffff, roughness: 0.8, transparent: true, alphaMap: swTex, polygonOffset: true, polygonOffsetFactor: -1 });
    for (const side of [-1, 1]) {
      const ring = new G.RingGeometry(0.43, 0.52, 64, 1);
      // remap UVs to wrap text around the ring
      const uv = ring.attributes.uv, pos = ring.attributes.position;
      for (let i = 0; i < uv.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const ang = Math.atan2(y, x);
        const rad = Math.hypot(x, y);
        uv.setXY(i, (ang / (Math.PI * 2) + 0.5) * 2 * side, (rad - 0.43) / 0.09);
      }
      const rm = new G.Mesh(ring, swMat);
      rm.rotation.y = side * Math.PI / 2;
      rm.position.x = side * (W + 0.002);
      spin.add(rm);
    }

    // chrome rim
    const chrome = new G.MeshStandardMaterial({ color: A.lin('#d9dde3'), metalness: 1, roughness: 0.22, envMap, envMapIntensity: 1.2 });
    const darkMetal = new G.MeshStandardMaterial({ color: A.lin('#3a3d44'), metalness: 0.8, roughness: 0.4, envMap });
    const barrel = new G.Mesh(new G.CylinderGeometry(0.375, 0.375, W * 1.7, 40, 1, true), darkMetal);
    barrel.rotation.z = Math.PI / 2;
    spin.add(barrel);
    const lipG = new G.TorusGeometry(0.375, 0.022, 8, 48);
    for (const side of [-1, 1]) {
      const lip = new G.Mesh(lipG, chrome);
      lip.rotation.y = Math.PI / 2;
      lip.position.x = side * W * 0.85;
      spin.add(lip);
    }
    const dish = new G.Mesh(new G.CylinderGeometry(0.34, 0.34, 0.02, 40), darkMetal);
    dish.rotation.z = Math.PI / 2;
    dish.position.x = 0.07;
    spin.add(dish);
    // spokes on the outer face (both sides so it looks right from any angle)
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const sp = new G.Mesh(new G.BoxGeometry(0.06, 0.27, 0.075), chrome);
        sp.position.set(side * 0.11, Math.cos(a) * 0.2, Math.sin(a) * 0.2);
        sp.rotation.x = -a;
        sp.castShadow = true;
        spin.add(sp);
      }
      const hub = new G.Mesh(new G.CylinderGeometry(0.1, 0.12, 0.08, 20), chrome);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = side * 0.12;
      spin.add(hub);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.6;
        const nut = new G.Mesh(new G.CylinderGeometry(0.016, 0.016, 0.03, 6), darkMetal);
        nut.rotation.z = Math.PI / 2;
        nut.position.set(side * 0.165, Math.cos(a) * 0.065, Math.sin(a) * 0.065);
        spin.add(nut);
      }
      const cap = new G.Mesh(new G.SphereGeometry(0.045, 12, 8), new G.MeshStandardMaterial({ color: A.lin('#e8343a'), metalness: 0.3, roughness: 0.3 }));
      cap.position.x = side * 0.17;
      spin.add(cap);
    }
    root.userData = { lean, spin };
    return root;
  };
})(typeof window !== 'undefined' ? window : globalThis);
