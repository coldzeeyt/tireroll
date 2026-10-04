// The 3D world: sky, streamed terrain chunks with LOD, vegetation, rocks,
// grass and the tire. Terrain, trees and rocks are rebuilt around the tire as
// it travels, so the endless mode can go on forever.
(function (root) {
  const TR = root.TR;
  const A = TR.Assets;
  const lin = A.lin;
  const CH = TR.CHUNK;

  const QUALITY = {
    high: { radius: 1150, lods: [[190, 2], [460, 4], [820, 8], [1e9, 16]], treeRadius: 650, treeCap: 7000, rockRadius: 480, grass: 7000, grassR: 40, shadow: 2048, pixel: 2 },
    low: { radius: 720, lods: [[150, 4], [420, 8], [1e9, 16]], treeRadius: 330, treeCap: 2200, rockRadius: 260, grass: 2200, grassR: 26, shadow: 1024, pixel: 1.5 },
  };
  TR.QUALITY = QUALITY;

  const SKY_VS = `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = p.xyww;
    }`;
  const SKY_FS = `
    uniform vec3 top; uniform vec3 mid; uniform vec3 hor;
    uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunSize;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float y = d.y;
      vec3 c = mix(mid, top, pow(smoothstep(0.0, 0.85, y), 0.8));
      c = mix(hor, c, smoothstep(-0.03, 0.28, y));
      float sd = max(dot(d, sunDir), 0.0);
      // forward scattering haze and a soft halo around the sun
      c += sunCol * (pow(sd, 4.0) * 0.12 * (1.0 - smoothstep(0.0, 0.6, y)) + pow(sd, 48.0) * 0.35 + pow(sd, 900.0) * 1.2);
      float ang = acos(clamp(dot(d, sunDir), -1.0, 1.0));
      c += sunCol * smoothstep(sunSize, sunSize * 0.8, ang) * 4.0;
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;

  // Wind sway for foliage and grass (instanced). Strength grows with height.
  function addWind(mat, uniforms, amount) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uniforms.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float ph = ip.x * 0.21 + ip.z * 0.17;
        float sway = (sin(uTime * 1.6 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.4) * ${amount.toFixed(3)} * max(0.0, transformed.y);
        transformed.x += sway;
        transformed.z += sway * 0.6;`);
    };
  }

  class World3D {
    constructor(renderer) {
      this.renderer = renderer;
      this.scene = null;
      this.uniforms = { uTime: { value: 0 } };
    }

    dispose() {
      if (!this.scene) return;
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      for (const m of this.materials || []) m.dispose();
      if (this.envRT) this.envRT.dispose();
      this.scene = null;
    }

    build(terrain, qualityName) {
      this.dispose();
      const map = terrain.map;
      this.W = terrain;
      this.map = map;
      this.Q = QUALITY[qualityName] || QUALITY.high;
      this.materials = [];
      const scene = (this.scene = new THREE.Scene());
      const sunDir = new THREE.Vector3(Math.sin(map.sun.azim) * Math.cos(map.sun.elev), Math.sin(map.sun.elev), -Math.cos(map.sun.azim) * Math.cos(map.sun.elev)).normalize();
      this.sunDir = sunDir;
      scene.fog = new THREE.Fog(lin(map.fog.color), map.fog.near, map.fog.far);
      scene.background = lin(map.fog.color);

      // ---- sky + image-based lighting from it
      const skyU = {
        top: { value: lin(map.sky.top) }, mid: { value: lin(map.sky.mid) }, hor: { value: lin(map.fog.color) },
        sunDir: { value: sunDir }, sunCol: { value: lin(map.sun.color) }, sunSize: { value: map.sun.size },
      };
      const skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, uniforms: skyU });
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), skyMat);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -10;
      scene.add(this.sky);
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, uniforms: skyU })));
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envRT = pm.fromScene(envScene, 0.04);
      pm.dispose();
      const env = this.envRT.texture;

      // ---- lights
      scene.add(new THREE.HemisphereLight(lin(map.hemi.sky), lin(map.hemi.ground), map.hemi.intensity));
      const sun = (this.sunLight = new THREE.DirectionalLight(lin(map.sun.color), map.sun.intensity * 1.7));
      sun.castShadow = true;
      sun.shadow.mapSize.set(this.Q.shadow, this.Q.shadow);
      const sc = sun.shadow.camera;
      sc.left = -55; sc.right = 55; sc.top = 55; sc.bottom = -55; sc.near = 1; sc.far = 500;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.05;
      scene.add(sun, sun.target);

      // ---- terrain material: four texture layers blended per vertex
      this.terrainMat = this.makeTerrainMaterial(map);
      this.materials.push(this.terrainMat);
      this.chunks = new Map();
      this.queue = [];
      this.nSplat = TR.noise2(map.seed + 300);
      this.nSnow = TR.noise2(map.seed + 301);

      this.makeVegetation(map);
      this.makeRocks(map);
      this.makeGrass(map);
      this.makeSkyExtras(map, env);

      this.tire = A.buildTire(env);
      scene.add(this.tire);
      this.vegDirty = true;
      this.vegTimer = 0;
      this.backdropCenter = null;
      return scene;
    }

    makeTerrainMaterial(map) {
      const L = map.layers;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: map.id === 'snow' ? 0.72 : 0.95, metalness: 0 });
      mat.extensions = { derivatives: true };
      const tex = [A.layer(L.ground), A.layer(L.rock), A.layer(L.top), A.layer(L.patch)];
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.tL0 = { value: tex[0] };
        sh.uniforms.tL1 = { value: tex[1] };
        sh.uniforms.tL2 = { value: tex[2] };
        sh.uniforms.tL3 = { value: tex[3] };
        sh.vertexShader = 'attribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vWPos;\nvarying vec3 vWN;\n' +
          sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
            vSplat = splat;
            vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
            vWN = normalize(mat3(modelMatrix) * objectNormal);`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', `#include <common>
            uniform sampler2D tL0; uniform sampler2D tL1; uniform sampler2D tL2; uniform sampler2D tL3;
            varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWN;
            vec3 texL(sampler2D t, vec2 uv) { return pow(texture2D(t, uv).rgb, vec3(2.2)); }
            // bump from a height value using screen-space derivatives
            vec3 bumpN(vec3 p, vec3 n, float h, float k) {
              vec3 sx = dFdx(p), sy = dFdy(p);
              vec3 r1 = cross(sy, n), r2 = cross(n, sx);
              float det = dot(sx, r1);
              vec3 grad = sign(det) * (dFdx(h) * k * r1 + dFdy(h) * k * r2);
              return normalize(abs(det) * n - grad);
            }
            vec3 layerS(sampler2D t, float farMix) {
              // two scales blended by distance hide tiling
              vec3 a = texL(t, vWPos.xz * 0.11);
              vec3 b = texL(t, vWPos.xz * 0.0137 + 0.37);
              return mix(mix(a, b, 0.25), b, farMix);
            }`)
          .replace('#include <map_fragment>', `
            float dist = length(vWPos - cameraPosition);
            float farMix = smoothstep(25.0, 260.0, dist);
            vec4 w = vSplat / max(0.0001, dot(vSplat, vec4(1.0)));
            vec3 g = layerS(tL0, farMix);
            vec3 tp = layerS(tL2, farMix);
            vec3 pt = layerS(tL3, farMix);
            // rock is projected from three sides so cliffs don't smear
            vec3 bw = pow(abs(vWN), vec3(4.0));
            bw /= (bw.x + bw.y + bw.z);
            float rs = mix(0.08, 0.016, farMix);
            vec3 r = texL(tL1, vWPos.zy * rs) * bw.x + texL(tL1, vWPos.xz * rs) * bw.y + texL(tL1, vWPos.xy * rs) * bw.z;
            vec3 col = g * w.x + r * w.y + tp * w.z + pt * w.w;
            // large-scale brightness variation
            col *= 0.82 + 0.36 * texL(tL3, vWPos.xz * 0.0019 + 0.71).g / max(0.05, texL(tL3, vec2(0.5)).g);
            diffuseColor.rgb *= col;
            float bumpH = dot(sqrt(g * w.x + r * w.y + tp * w.z + pt * w.w), vec3(0.33)) * (1.0 - farMix);
            float bumpK = 0.45 + w.z * 0.25 + w.y * 0.7;`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            normal = bumpN(-vViewPosition, normal, bumpH, bumpK);`);
      };
      return mat;
    }

    // ---------- terrain chunks ----------
    lodFor(d) {
      for (const [r, step] of this.Q.lods) if (d < r) return step;
      return 16;
    }

    splatAt(x, z, y, ny) {
      const map = this.map, W = this.W;
      const elev = W.elevation(x, z, y);
      let rock = TR.clamp((0.86 - ny) / 0.16, 0, 1);
      const line = map.terrain.snowLine + this.nSnow(x / 70, z / 70) * 35;
      let snow = TR.clamp((elev - line + 25) / 50, 0, 1);
      if (map.id === 'alpine' || map.id === 'snow') snow *= 1 - rock * 0.75;
      else snow = 0;
      let patch = TR.clamp((this.nSplat(x / 45, z / 45) * 0.5 + this.nSplat(x / 9, z / 9) * 0.25 - 0.18) * 3, 0, 1) * (1 - rock);
      if (map.layers.top === map.layers.ground) snow = 0;
      let ground = Math.max(0, 1 - rock - snow - patch * 0.8);
      if (map.id === 'snow') { ground = Math.max(0, 1 - rock) * 0.8; patch *= 0.5; }
      return [ground, rock, snow, patch * 0.8];
    }

    buildChunkMesh(cx, cz, step) {
      const W = this.W;
      const n = CH / step + 1;
      const x0 = cx * CH, z0 = cz * CH;
      const N2 = n + 2;
      const H = new Float32Array(N2 * N2);
      for (let j = 0; j < N2; j++) for (let i = 0; i < N2; i++) H[j * N2 + i] = W.height(x0 + (i - 1) * step, z0 + (j - 1) * step);
      const skirt = 4 * (n - 1);
      const vcount = n * n + skirt * 2;
      const pos = new Float32Array(vcount * 3), nor = new Float32Array(vcount * 3), spl = new Float32Array(vcount * 4);
      let v = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = (j + 1) * N2 + (i + 1);
        const y = H[k];
        const x = x0 + i * step, z = z0 + j * step;
        const nx = H[k - 1] - H[k + 1], nz = H[k - N2] - H[k + N2], ny = 2 * step;
        const l = Math.hypot(nx, ny, nz);
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = nz / l;
        const s = this.splatAt(x, z, y, ny / l);
        spl.set(s, v * 4);
        v++;
      }
      const idx = [];
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      // skirts hide cracks between neighbouring LODs
      const edge = [];
      for (let i = 0; i < n - 1; i++) edge.push(i);
      for (let j = 0; j < n - 1; j++) edge.push(j * n + n - 1);
      for (let i = n - 1; i > 0; i--) edge.push((n - 1) * n + i);
      for (let j = n - 1; j > 0; j--) edge.push(j * n);
      const drop = step * 1.5 + 2;
      const base = v;
      for (let e = 0; e < edge.length; e++) {
        const src = edge[e];
        for (let q = 0; q < 2; q++) {
          pos[v * 3] = pos[src * 3]; pos[v * 3 + 1] = pos[src * 3 + 1] - (q ? drop : 0); pos[v * 3 + 2] = pos[src * 3 + 2];
          nor[v * 3] = nor[src * 3]; nor[v * 3 + 1] = nor[src * 3 + 1]; nor[v * 3 + 2] = nor[src * 3 + 2];
          spl.set(spl.subarray(src * 4, src * 4 + 4), v * 4);
          v++;
        }
      }
      for (let e = 0; e < edge.length; e++) {
        const a = base + e * 2, b = base + ((e + 1) % edge.length) * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1, a, b, a + 1, b, b + 1, a + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.terrainMat);
      m.receiveShadow = true;
      return m;
    }

    // Decide which chunks should exist and at what detail.
    plan(fx, fz) {
      const R = this.Q.radius;
      const want = new Map();
      const c0x = Math.floor((fx - R) / CH), c1x = Math.floor((fx + R) / CH);
      const c0z = Math.floor((fz - R) / CH), c1z = Math.floor((fz + R) / CH);
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
        const mx = (cx + 0.5) * CH, mz = (cz + 0.5) * CH;
        const d = Math.max(0, Math.hypot(mx - fx, mz - fz) - CH * 0.7);
        if (d > R) continue;
        want.set(cx + ',' + cz, { cx, cz, step: this.lodFor(d), d });
      }
      return want;
    }

    stream(fx, fz, budgetMs) {
      const want = this.plan(fx, fz);
      for (const [k, c] of this.chunks) {
        if (!want.has(k)) {
          this.scene.remove(c.mesh);
          c.mesh.geometry.dispose();
          this.chunks.delete(k);
          this.W.dropChunk(c.cx, c.cz);
          this.vegDirty = true;
        }
      }
      const todo = [];
      for (const [k, w] of want) {
        const c = this.chunks.get(k);
        if (!c || c.step !== w.step) todo.push(Object.assign({ k }, w));
      }
      todo.sort((a, b) => a.d - b.d);
      const t0 = performance.now();
      for (const w of todo) {
        if (budgetMs !== undefined && performance.now() - t0 > budgetMs) break;
        const old = this.chunks.get(w.k);
        const mesh = this.buildChunkMesh(w.cx, w.cz, w.step);
        this.scene.add(mesh);
        if (old) { this.scene.remove(old.mesh); old.mesh.geometry.dispose(); }
        else this.vegDirty = true;
        this.chunks.set(w.k, { cx: w.cx, cz: w.cz, step: w.step, mesh });
      }
      return todo.length;
    }

    // Distant skyline: one coarse mesh, rebuilt as the tire travels.
    updateBackdrop(fx, fz) {
      const span = 11000, cells = 150;
      const cxp = Math.round(fx / 1000) * 1000, czp = Math.round(fz / 1000) * 1000;
      if (this.backdropCenter && Math.hypot(cxp - this.backdropCenter[0], czp - this.backdropCenter[1]) < 1500) return;
      this.backdropCenter = [cxp, czp];
      if (this.backdrop) { this.scene.remove(this.backdrop); this.backdrop.geometry.dispose(); }
      const n = cells + 1, step = span / cells;
      const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), spl = new Float32Array(n * n * 4);
      const H = new Float32Array(n * n);
      const inner = this.Q.radius - 220;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = cxp - span / 2 + i * step, z = czp - span / 2 + j * step;
        let y = this.W.height(x, z);
        // tuck it under the detailed chunks
        if (Math.hypot(x - fx, z - fz) < inner) y -= 80;
        else y -= 4;
        H[j * n + i] = y;
      }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = cxp - span / 2 + i * step, z = czp - span / 2 + j * step;
        const hl = H[j * n + Math.max(0, i - 1)], hr = H[j * n + Math.min(n - 1, i + 1)];
        const hd = H[Math.max(0, j - 1) * n + i], hu = H[Math.min(n - 1, j + 1) * n + i];
        const nx = hl - hr, nz = hd - hu, ny = 2 * step;
        const l = Math.hypot(nx, ny, nz);
        pos.set([x, H[k], z], k * 3);
        nor.set([nx / l, ny / l, nz / l], k * 3);
        spl.set(this.splatAt(x, z, H[k], ny / l), k * 4);
      }
      const idx = [];
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
      g.setIndex(idx);
      g.computeBoundingSphere();
      this.backdrop = new THREE.Mesh(g, this.terrainMat);
      this.scene.add(this.backdrop);
    }

    // ---------- vegetation ----------
    makeVegetation(map) {
      this.veg = [];
      if (!map.trees) return;
      const U = this.uniforms;
      const kinds = [...new Set(map.trees.kinds)];
      const barkMat = new THREE.MeshStandardMaterial({ map: A.barkTex(false), roughness: 0.95 });
      const birchMat = new THREE.MeshStandardMaterial({ map: A.barkTex(true), roughness: 0.9 });
      const deadMat = new THREE.MeshStandardMaterial({ map: A.barkTex(false), color: lin('#9a8f86'), roughness: 1 });
      this.materials.push(barkMat, birchMat, deadMat);
      const foliage = (kind) => {
        const t = A.foliageTex(kind);
        const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85 });
        addWind(m, U, kind === 'shrub' ? 0.01 : 0.012);
        const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: 0.42, side: THREE.DoubleSide });
        this.materials.push(m, dm);
        return { m, dm };
      };
      const cap = this.Q.treeCap;
      for (const kind of kinds) {
        const parts = [];
        if (kind === 'pine' || kind === 'pineSnow') {
          parts.push({ geo: A.trunk(11, 0.32, 0.05), mat: barkMat });
          const f = foliage(kind);
          parts.push({ geo: A.coniferFoliage({ height: 11.5, base: 3, tiers: 9, per: 5, radius: 3.0, seed: 3 }), mat: f.m, depth: f.dm });
        } else if (kind === 'fir' || kind === 'firSnow') {
          parts.push({ geo: A.trunk(9, 0.34, 0.05), mat: barkMat });
          const f = foliage(kind);
          parts.push({ geo: A.coniferFoliage({ height: 9.5, base: 1.0, tiers: 11, per: 6, radius: 2.7, seed: 5 }), mat: f.m, depth: f.dm });
        } else if (kind === 'birch') {
          const br = A.branches(11, 3.5);
          br.translate(0, 4.5, 0);
          parts.push({ geo: A.mergeGeos([A.trunk(9, 0.2, 0.05), br]), mat: birchMat });
          const f = foliage('birch');
          parts.push({ geo: A.leafCrown({ cy: 7, rx: 2.6, ry: 3.0, cards: 40, size: 1.15, seed: 7 }), mat: f.m, depth: f.dm });
        } else if (kind === 'deadTree') {
          parts.push({ geo: A.branches(21, 6), mat: deadMat });
        } else if (kind === 'saguaro') {
          const cm = new THREE.MeshStandardMaterial({ map: A.cactusTex(), roughness: 0.75 });
          this.materials.push(cm);
          parts.push({ geo: A.saguaro(), mat: cm });
        } else if (kind === 'shrub') {
          const f = foliage('shrub');
          parts.push({ geo: A.leafCrown({ cy: 0.7, rx: 1.2, ry: 0.7, cards: 18, size: 0.6, seed: 9 }), mat: f.m, depth: f.dm });
        }
        const meshes = parts.map((p) => {
          const im = new THREE.InstancedMesh(p.geo, p.mat, cap);
          im.count = 0;
          im.castShadow = true;
          im.receiveShadow = true;
          if (p.depth) im.customDepthMaterial = p.depth;
          im.frustumCulled = false;
          this.scene.add(im);
          return im;
        });
        this.veg.push({ kind, meshes });
      }
    }

    makeRocks(map) {
      const mat = new THREE.MeshStandardMaterial({ map: A.layer(map.layers.rock), roughness: 0.92 });
      this.materials.push(mat);
      this.rockMeshes = [];
      for (let k = 0; k < 4; k++) {
        const im = new THREE.InstancedMesh(A.rockGeo(k + map.seed % 7), mat, 3500);
        im.count = 0;
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.scene.add(im);
        this.rockMeshes.push(im);
      }
    }

    refreshVegetation(fx, fz) {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), e = new THREE.Euler();
      const TRr = this.Q.treeRadius, RRr = this.Q.rockRadius;
      const trees = {}, rocks = [[], [], [], []];
      for (const c of this.chunks.values()) {
        const data = this.W.chunk(c.cx, c.cz);
        const mx = (c.cx + 0.5) * CH, mz = (c.cz + 0.5) * CH;
        const d = Math.hypot(mx - fx, mz - fz);
        if (d < TRr + CH) for (const t of data.trees) (trees[t.kind] = trees[t.kind] || []).push(t);
        if (d < RRr + CH) for (const r of data.rocks) rocks[r.kind].push(r);
      }
      for (const v of this.veg) {
        let list = trees[v.kind] || [];
        list = list.filter((t) => Math.hypot(t.x - fx, t.z - fz) < TRr);
        if (list.length > this.Q.treeCap) {
          list.sort((a, b) => Math.hypot(a.x - fx, a.z - fz) - Math.hypot(b.x - fx, b.z - fz));
          list.length = this.Q.treeCap;
        }
        for (const im of v.meshes) {
          list.forEach((t, i) => {
            p.set(t.x, t.y - 0.25, t.z);
            q.setFromEuler(e.set((t.seed - 0.5) * 0.06, t.rot, (t.seed - 0.5) * 0.06));
            sc.set(t.scale, t.scale * (0.9 + t.seed * 0.2), t.scale);
            m4.compose(p, q, sc);
            im.setMatrixAt(i, m4);
          });
          im.count = list.length;
          im.instanceMatrix.needsUpdate = true;
        }
      }
      rocks.forEach((list, k) => {
        const im = this.rockMeshes[k];
        list = list.filter((r) => Math.hypot(r.x - fx, r.z - fz) < RRr).slice(0, 3500);
        list.forEach((r, i) => {
          p.set(r.x, r.y - r.size * 0.22, r.z);
          q.setFromEuler(e.set((r.tilt - 0.5) * 0.4, r.rot, (r.tilt - 0.3) * 0.3));
          sc.set(r.size, r.size, r.size * (0.8 + r.tilt * 0.4));
          m4.compose(p, q, sc);
          im.setMatrixAt(i, m4);
        });
        im.count = list.length;
        im.instanceMatrix.needsUpdate = true;
      });
    }

    // Grass tufts on a world-aligned jittered grid around the tire.
    makeGrass(map) {
      this.grass = null;
      if (!map.grass) return;
      const t = A.grassTex(map.grass.color, map.grass.tip);
      const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 });
      addWind(m, this.uniforms, 0.09);
      this.materials.push(m);
      const im = new THREE.InstancedMesh(A.grassClump(), m, this.Q.grass);
      im.count = 0;
      im.frustumCulled = false;
      im.receiveShadow = true;
      this.scene.add(im);
      this.grass = im;
      this.grassAt = null;
    }

    refreshGrass(fx, fz) {
      if (!this.grass) return;
      if (this.grassAt && Math.hypot(fx - this.grassAt[0], fz - this.grassAt[1]) < 5) return;
      this.grassAt = [fx, fz];
      const W = this.W, map = this.map;
      const cell = 0.9, R = this.Q.grassR;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const i0 = Math.floor((fx - R) / cell), i1 = Math.floor((fx + R) / cell);
      const j0 = Math.floor((fz - R) / cell), j1 = Math.floor((fz + R) / cell);
      let n = 0;
      const cap = this.Q.grass, dens = map.grass.density;
      for (let j = j0; j <= j1 && n < cap; j++) {
        for (let i = i0; i <= i1 && n < cap; i++) {
          const h = TR.hash3(map.seed, i, j);
          const r1 = (h & 1023) / 1024, r2 = ((h >>> 10) & 1023) / 1024, r3 = ((h >>> 20) & 1023) / 1024;
          if (r1 > dens * 0.85) continue;
          const x = (i + r2) * cell, z = (j + r3) * cell;
          if ((x - fx) * (x - fx) + (z - fz) * (z - fz) > R * R) continue;
          const y = W.height(x, z);
          const hx = W.height(x + 1, z) - y, hz = W.height(x, z + 1) - y;
          const ny = 1 / Math.hypot(hx, 1, hz);
          const s = this.splatAt(x, z, y, ny);
          if (s[0] < 0.55 || r2 > s[0]) continue;
          p.set(x, y - 0.05, z);
          q.setFromAxisAngle(up, r3 * 6.283);
          const k = 0.7 + r1 * 0.8;
          sc.set(k, k * (0.8 + r2 * 0.6), k);
          m4.compose(p, q, sc);
          this.grass.setMatrixAt(n++, m4);
        }
      }
      this.grass.count = n;
      this.grass.instanceMatrix.needsUpdate = true;
    }

    makeSkyExtras(map, env) {
      const scene = this.scene;
      this.clouds = [];
      if (map.clouds) {
        const texs = [A.cloud(1), A.cloud(2), A.cloud(3)];
        const R = TR.rng(map.seed + 9);
        for (let i = 0; i < map.clouds; i++) {
          const mat = new THREE.SpriteMaterial({ map: texs[i % 3], color: map.id === 'volcano' ? lin('#8a7a74') : 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, fog: false });
          this.materials.push(mat);
          const sp = new THREE.Sprite(mat);
          const w = 350 + R() * 500;
          sp.scale.set(w, w * 0.4, 1);
          sp.userData = { ox: (R() - 0.5) * 5000, oz: -R() * 5000 + 1000, h: 380 + R() * 380, drift: 2 + R() * 3 };
          scene.add(sp);
          this.clouds.push(sp);
        }
      }
      if (map.stars) {
        const R = TR.rng(77);
        const pos = new Float32Array(map.stars * 3), col = new Float32Array(map.stars * 3);
        for (let i = 0; i < map.stars; i++) {
          const th = R() * Math.PI * 2, ph = Math.acos(R() * 1.7 - 0.7);
          pos.set([Math.sin(ph) * Math.cos(th) * 2800, Math.cos(ph) * 2800, Math.sin(ph) * Math.sin(th) * 2800], i * 3);
          const b = 0.35 + R() * 0.65;
          col.set([b, b, b], i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const sm = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false });
        this.materials.push(sm);
        this.stars = new THREE.Points(g, sm);
        this.stars.frustumCulled = false;
        scene.add(this.stars);
      }
      if (map.earth) {
        const em = new THREE.MeshStandardMaterial({ map: A.earth(), roughness: 1, fog: false });
        this.materials.push(em);
        this.earth = new THREE.Mesh(new THREE.SphereGeometry(120, 64, 32), em);
        this.earth.rotation.z = 0.4;
        scene.add(this.earth);
      }
      this.smoke = [];
      if (map.terrain.crater && this.W.mode === 'mountain') {
        const t = A.smoke();
        for (let i = 0; i < 14; i++) {
          const m = new THREE.SpriteMaterial({ map: t, color: lin('#6a625e'), transparent: true, opacity: 0.6, depthWrite: false });
          this.materials.push(m);
          const sp = new THREE.Sprite(m);
          sp.userData.phase = i / 14;
          scene.add(sp);
          this.smoke.push(sp);
        }
      }
    }

    // Build everything near (x,z) right away (used behind the loading fade).
    prime(x, z) {
      this.stream(x, z);
      this.updateBackdrop(x, z);
      this.refreshVegetation(x, z);
      this.refreshGrass(x, z);
      this.vegDirty = false;
    }

    update(sim, camera, time, dt) {
      this.uniforms.uTime.value = time;
      const t = sim.tire;
      const tire = this.tire, ud = tire.userData;
      tire.position.set(t.x, t.y, t.z);
      tire.rotation.set(0, t.yaw, 0);
      ud.lean.rotation.z = -t.lean;
      ud.lean.scale.set(1 + t.squash * 0.4, 1 - t.squash, 1 + t.squash * 0.4);
      ud.spin.rotation.x = -t.spin;

      this.stream(t.x, t.z, 5);
      this.updateBackdrop(t.x, t.z);
      this.vegTimer -= dt;
      if (this.vegDirty && this.vegTimer <= 0) {
        this.refreshVegetation(t.x, t.z);
        this.vegDirty = false;
        this.vegTimer = 0.6;
      }
      if (!this.lastVegAt || Math.hypot(t.x - this.lastVegAt[0], t.z - this.lastVegAt[1]) > 60) {
        this.lastVegAt = [t.x, t.z];
        this.vegDirty = true;
      }
      this.refreshGrass(t.x, t.z);

      const sl = this.sunLight;
      sl.target.position.set(t.x, t.y, t.z);
      sl.position.copy(sl.target.position).addScaledVector(this.sunDir, 220);

      this.sky.position.copy(camera.position);
      if (this.stars) this.stars.position.copy(camera.position);
      if (this.earth) {
        this.earth.position.copy(camera.position).add(new THREE.Vector3(-700, 520, -1900));
        this.earth.rotation.y = time * 0.005;
      }
      for (const c of this.clouds) {
        const u = c.userData;
        u.ox += u.drift * dt;
        // clouds wrap around the camera so they never run out
        const wx = ((u.ox - camera.position.x) % 5000 + 7500) % 5000 - 2500;
        const wz = ((u.oz - camera.position.z) % 5000 + 7500) % 5000 - 3500;
        c.position.set(camera.position.x + wx, camera.position.y + u.h, camera.position.z + wz);
      }
      for (const s of this.smoke) {
        const ph = (s.userData.phase + time * 0.025) % 1;
        const top = this.W.height(0, 0);
        s.position.set(Math.sin(ph * 5 + s.userData.phase * 9) * 20 + ph * 140, top + 10 + ph * 420, -ph * 60);
        const w = 60 + ph * 260;
        s.scale.set(w, w, 1);
        s.material.opacity = 0.55 * Math.sin(ph * Math.PI);
      }
    }
  }

  TR.World3D = World3D;
})(typeof window !== 'undefined' ? window : globalThis);
