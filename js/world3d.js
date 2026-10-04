// The 3D world: sky, streamed terrain chunks with LOD, vegetation, rocks,
// grass and the tire. Terrain, trees and rocks are rebuilt around the tire as
// it travels, so endless mode can go on forever.
(function (root) {
  const TR = root.TR;
  const A = TR.Assets;
  const lin = A.lin;
  const CH = TR.CHUNK;

  const QUALITY = {
    high: { radius: 1150, lods: [[190, 2], [460, 4], [820, 8], [1e9, 16]], treeRadius: 700, treeCap: 7000, rockRadius: 480, grass: 14000, grassR: 46, shadow: 2048, pixel: 2 },
    low: { radius: 720, lods: [[150, 4], [420, 8], [1e9, 16]], treeRadius: 360, treeCap: 2400, rockRadius: 260, grass: 3500, grassR: 28, shadow: 1024, pixel: 1.5 },
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
    uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunSize; uniform float atmo;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float y = d.y;
      vec3 c = mix(mid, top, pow(smoothstep(0.0, 0.9, y), 0.75));
      c = mix(hor, c, smoothstep(-0.04, 0.3, y));
      float sd = max(dot(d, sunDir), 0.0);
      // forward scattering: a warm glow low around the sun, a tight halo, the disc
      c += sunCol * atmo * (pow(sd, 3.0) * 0.18 * (1.0 - smoothstep(0.0, 0.5, y)) + pow(sd, 40.0) * 0.45 + pow(sd, 700.0) * 2.0);
      float ang = acos(clamp(dot(d, sunDir), -1.0, 1.0));
      c += sunCol * smoothstep(sunSize, sunSize * 0.75, ang) * 18.0;
      // the ground below the horizon fades to haze
      c = mix(c, hor * 0.92, smoothstep(0.0, -0.25, y));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;

  // ---- shader patching -------------------------------------------------
  // Each material gets a list of patches and an explicit program cache key,
  // so differently patched materials never share a compiled program.
  function patch(mat, key, fns) {
    mat.onBeforeCompile = (sh) => { for (const f of fns) f(sh); };
    mat.customProgramCacheKey = () => key;
    return mat;
  }

  // Height fog with sunlit in-scattering (replaces three's distance fog).
  function fogPatch(U) {
    return (sh) => {
      Object.assign(sh.uniforms, { uFogDensity: U.uFogDensity, uFogFalloff: U.uFogFalloff, uFogBase: U.uFogBase, uSunDir: U.uSunDir, uSunFog: U.uSunFog });
      sh.vertexShader = 'varying vec3 vFogW;\n' + sh.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
        #ifdef USE_INSTANCING
          vFogW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vFogW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
      sh.fragmentShader = 'varying vec3 vFogW;\nuniform float uFogDensity; uniform float uFogFalloff; uniform float uFogBase; uniform vec3 uSunDir; uniform vec3 uSunFog;\n' +
        sh.fragmentShader.replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          vec3 fr = vFogW - cameraPosition;
          float fd = length(fr);
          vec3 frd = fr / max(fd, 0.001);
          float k = frd.y * uFogFalloff;
          float base = uFogDensity * exp(-(cameraPosition.y - uFogBase) * uFogFalloff);
          float amt = abs(k) < 1e-4 ? base * fd : base * (1.0 - exp(-fd * k)) / k;
          amt = 1.0 - exp(-max(amt, 0.0));
          float sa = pow(max(dot(frd, uSunDir), 0.0), 6.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(fogColor, uSunFog, sa * 0.7), amt);
        #endif`);
    };
  }

  // Wind sway for instanced foliage and grass; strength grows with height.
  function windPatch(U, amount) {
    return (sh) => {
      sh.uniforms.uTime = U.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ph = ip.x * 0.21 + ip.z * 0.17;
        float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.01);
        float sway = (sin(uTime * 1.6 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.4) * ${amount.toFixed(3)} * gust * max(0.0, transformed.y);
        transformed.x += sway;
        transformed.z += sway * 0.6;`);
    };
  }

  // Cards (leaves, grass) are lit with the soft volume normals baked into the
  // geometry on both sides, instead of three's flipped back-face normal.
  function cardLightPatch(sh) {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
      normal = normalize(vNormal);`);
  }

  class World3D {
    constructor(renderer) {
      this.renderer = renderer;
      this.scene = null;
      this.U = {
        uTime: { value: 0 },
        uFogDensity: { value: 0.0004 }, uFogFalloff: { value: 1 / 300 }, uFogBase: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunFog: { value: new THREE.Color() },
        uCloudShadow: { value: 0 },
      };
    }

    dispose() {
      if (!this.scene) return;
      this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of this.materials || []) m.dispose();
      if (this.envRT) this.envRT.dispose();
      this.scene = null;
    }

    build(terrain, qualityName) {
      this.dispose();
      const map = terrain.map;
      this.W = terrain;
      this.map = map;
      this.qualityName = qualityName;
      this.Q = QUALITY[qualityName] || QUALITY.high;
      this.materials = [];
      const U = this.U;
      const scene = (this.scene = new THREE.Scene());
      const sunDir = new THREE.Vector3(Math.sin(map.sun.azim) * Math.cos(map.sun.elev), Math.sin(map.sun.elev), -Math.cos(map.sun.azim) * Math.cos(map.sun.elev)).normalize();
      this.sunDir = sunDir;
      this.sunColor = lin(map.sun.color);
      // three's own distance fog is effectively off (huge range); patched materials use height fog
      scene.fog = new THREE.Fog(lin(map.fog.color), 1e6, 2e6);
      scene.background = lin(map.fog.color);
      U.uSunDir.value.copy(sunDir);
      U.uSunFog.value.copy(lin(map.fog.sun || map.sun.color));
      U.uFogDensity.value = map.fog.density;
      U.uFogFalloff.value = 1 / map.fog.height;
      U.uCloudShadow.value = map.clouds ? 0.38 : 0;

      // ---- sky + image-based lighting from it
      const skyU = {
        top: { value: lin(map.sky.top) }, mid: { value: lin(map.sky.mid) }, hor: { value: lin(map.fog.color) },
        sunDir: { value: sunDir }, sunCol: { value: lin(map.sun.color) }, sunSize: { value: map.sun.size },
        atmo: { value: map.air === 0 ? 0 : 1 }, // no air, no glow around the sun
      };
      const skyMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, uniforms: skyU });
      this.materials.push(skyMat);
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), skyMat);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -10;
      scene.add(this.sky);
      const envScene = new THREE.Scene();
      const envSky = skyMat.clone();
      envSky.uniforms = skyU;
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), envSky));
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envRT = pm.fromScene(envScene, 0.04);
      pm.dispose();
      envSky.dispose();
      const env = this.envRT.texture;

      // ---- lights
      scene.add(new THREE.HemisphereLight(lin(map.hemi.sky), lin(map.hemi.ground), map.hemi.intensity));
      const sun = (this.sunLight = new THREE.DirectionalLight(lin(map.sun.color), map.sun.intensity * 2.0));
      sun.castShadow = true;
      sun.shadow.mapSize.set(this.Q.shadow, this.Q.shadow);
      const sc = sun.shadow.camera;
      sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 600;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.06;
      scene.add(sun, sun.target);

      this.terrainMat = this.makeTerrainMaterial(map);
      this.chunks = new Map();
      this.nSplat = TR.noise2(map.seed + 300);
      this.nSnow = TR.noise2(map.seed + 301);
      this.nMacro = TR.noise2(map.seed + 302);

      this.makeVegetation(map);
      this.makeRocks(map);
      this.makeGrass(map);
      this.makeSkyExtras(map);

      this.tire = A.buildTire(env);
      scene.add(this.tire);
      this.vegDirty = true;
      this.vegTimer = 0;
      this.backdropCenter = null;
      this.lastVegAt = null;
      return scene;
    }

    fogPatch() { return fogPatch(this.U); }

    makeTerrainMaterial(map) {
      const L = map.layers;
      const U = this.U;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: map.id === 'snow' ? 0.72 : 0.95, metalness: 0 });
      mat.extensions = { derivatives: true };
      const tex = [A.layer(L.ground), A.layer(L.rock), A.layer(L.top), A.layer(L.patch)];
      const cloudTex = A.noiseTex();
      patch(mat, 'terrain', [(sh) => {
        Object.assign(sh.uniforms, { tL0: { value: tex[0] }, tL1: { value: tex[1] }, tL2: { value: tex[2] }, tL3: { value: tex[3] }, tCloud: { value: cloudTex }, uTime: U.uTime, uCloudShadow: U.uCloudShadow });
        sh.vertexShader = 'attribute vec4 splat;\nattribute vec2 shade;\nvarying vec4 vSplat;\nvarying vec2 vShade;\nvarying vec3 vWPos;\nvarying vec3 vWN;\n' +
          sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
            vSplat = splat;
            vShade = shade;
            vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
            vWN = normalize(mat3(modelMatrix) * objectNormal);`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', `#include <common>
            uniform sampler2D tL0; uniform sampler2D tL1; uniform sampler2D tL2; uniform sampler2D tL3; uniform sampler2D tCloud;
            uniform float uTime; uniform float uCloudShadow;
            varying vec4 vSplat; varying vec2 vShade; varying vec3 vWPos; varying vec3 vWN;
            vec3 texL(sampler2D t, vec2 uv) { return pow(texture2D(t, uv).rgb, vec3(2.2)); }
            // three scales, the larger two rotated, so no repeat lines up
            vec3 layerS(sampler2D t, float farMix) {
              vec2 p = vWPos.xz;
              vec3 a = texL(t, p * 0.11);
              vec3 b = texL(t, mat2(0.8, -0.6, 0.6, 0.8) * p * 0.0137 + 0.37);
              vec3 c = texL(t, mat2(0.28, 0.96, -0.96, 0.28) * p * 0.0029 + 0.71);
              vec3 far = mix(b, c, 0.5);
              return mix(mix(a, far, 0.3), far, farMix);
            }
            vec3 bumpN(vec3 p, vec3 n, float h, float k) {
              vec3 sx = dFdx(p), sy = dFdy(p);
              vec3 r1 = cross(sy, n), r2 = cross(n, sx);
              float det = dot(sx, r1);
              vec3 grad = sign(det) * (dFdx(h) * k * r1 + dFdy(h) * k * r2);
              vec3 r = abs(det) * n - grad;
              return dot(r, r) > 1e-14 ? normalize(r) : n;
            }`)
          .replace('#include <map_fragment>', `
            float dist = length(vWPos - cameraPosition);
            float farMix = smoothstep(25.0, 260.0, dist);
            vec4 w = vSplat / max(0.0001, dot(vSplat, vec4(1.0)));
            vec3 g = layerS(tL0, farMix);
            vec3 tp = layerS(tL2, farMix);
            vec3 pt = layerS(tL3, farMix);
            vec3 bw = pow(abs(vWN), vec3(4.0));
            bw /= (bw.x + bw.y + bw.z);
            float rs = mix(0.08, 0.016, farMix);
            vec3 r = texL(tL1, vWPos.zy * rs) * bw.x + texL(tL1, vWPos.xz * rs) * bw.y + texL(tL1, vWPos.xy * rs) * bw.z;
            // drier, yellower ground in places; occlusion in hollows
            g = mix(g, g * vec3(1.18, 1.02, 0.72), vShade.y);
            vec3 col = g * w.x + r * w.y + tp * w.z + pt * w.w;
            col *= vShade.x;
            // drifting cloud shadows
            float cs = smoothstep(0.5, 0.78, texture2D(tCloud, vWPos.xz * 0.0009 + uTime * vec2(0.0035, 0.0012)).r);
            col *= 1.0 - cs * uCloudShadow;
            diffuseColor.rgb *= col;
            float bumpH = dot(sqrt(g * w.x + r * w.y + tp * w.z + pt * w.w), vec3(0.33)) * (1.0 - farMix);
            float bumpK = 0.45 + w.z * 0.9 + w.y * 0.7;`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            normal = bumpN(-vViewPosition, normal, bumpH, bumpK);`);
      }, this.fogPatch()]);
      this.materials.push(mat);
      return mat;
    }

    // ---------- terrain chunks ----------
    lodFor(d) {
      for (const [r, step] of this.Q.lods) if (d < r) return step;
      return 16;
    }

    // layer weights from broad slope (ny), elevation and noise
    splatAt(x, z, y, ny) {
      const map = this.map, W = this.W;
      const elev = W.elevation(x, z, y);
      const rock = TR.clamp((0.8 - ny) / 0.18, 0, 1);
      const line = map.terrain.snowLine + this.nSnow(x / 70, z / 70) * 35 + this.nSnow(x / 13, z / 13) * 6;
      let snow = TR.clamp((elev - line + 25) / 45, 0, 1);
      if (map.layers.top === map.layers.ground) snow = 0;
      snow *= 1 - rock * 0.8;
      let patch = TR.clamp((this.nSplat(x / 60, z / 60) * 0.5 + this.nSplat(x / 14, z / 14) * 0.25 - 0.32) * 2.2, 0, 1) * (1 - rock) * (1 - snow);
      let ground = Math.max(0, 1 - rock - snow - patch * 0.7);
      if (map.id === 'snow') { ground = Math.max(0, 1 - rock); patch *= 0.4; snow = 0; }
      return [ground, rock, snow, patch * 0.7];
    }

    buildChunkMesh(cx, cz, step) {
      const W = this.W;
      const n = CH / step + 1;
      const x0 = cx * CH, z0 = cz * CH;
      const B = Math.max(1, Math.ceil(10 / step)); // border for broad slope + cavity
      const N2 = n + 2 * B;
      const H = new Float32Array(N2 * N2);
      for (let j = 0; j < N2; j++) for (let i = 0; i < N2; i++) H[j * N2 + i] = W.height(x0 + (i - B) * step, z0 + (j - B) * step);
      const edgeN = 4 * (n - 1);
      const vcount = n * n + edgeN * 2;
      const pos = new Float32Array(vcount * 3), nor = new Float32Array(vcount * 3), spl = new Float32Array(vcount * 4), shd = new Float32Array(vcount * 2);
      let v = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = (j + B) * N2 + (i + B);
        const y = H[k];
        const x = x0 + i * step, z = z0 + j * step;
        const nx = H[k - 1] - H[k + 1], nz = H[k - N2] - H[k + N2], ny = 2 * step;
        const l = Math.hypot(nx, ny, nz);
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = nz / l;
        // broad slope over ~2B cells, so small ledges don't paint streaks of rock
        const bx = H[k - B] - H[k + B], bz = H[k - B * N2] - H[k + B * N2], by = 2 * B * step;
        const bl = Math.hypot(bx, by, bz);
        spl.set(this.splatAt(x, z, y, by / bl), v * 4);
        // cavity: hollows darker, crests a touch brighter
        const avg = (H[k - B] + H[k + B] + H[k - B * N2] + H[k + B * N2]) * 0.25;
        const cav = TR.clamp((avg - y) / (B * step), -0.4, 0.6);
        const macro = this.nMacro(x / 340, z / 340);
        shd[v * 2] = TR.clamp(1 - cav * 0.55 + macro * 0.07, 0.62, 1.12);
        shd[v * 2 + 1] = TR.clamp(this.nMacro(x / 180 + 50, z / 180) * 0.9 + 0.1, 0, 0.6) * (this.map.id === 'alpine' || this.map.id === 'desert' ? 1 : 0.3);
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
          nor.set(nor.subarray(src * 3, src * 3 + 3), v * 3);
          spl.set(spl.subarray(src * 4, src * 4 + 4), v * 4);
          shd.set(shd.subarray(src * 2, src * 2 + 2), v * 2);
          v++;
        }
      }
      for (let e = 0; e < edge.length; e++) {
        const a = base + e * 2, b = base + ((e + 1) % edge.length) * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1, a, b, a + 1, b, b + 1, a + 1);
      }
      return this.terrainMesh(pos, nor, spl, shd, idx, true);
    }

    terrainMesh(pos, nor, spl, shd, idx, receive) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
      g.setAttribute('shade', new THREE.BufferAttribute(shd, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.terrainMat);
      m.receiveShadow = receive;
      return m;
    }

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
        if (old) { this.scene.remove(old.mesh); old.mesh.geometry.dispose(); } else this.vegDirty = true;
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
      const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), spl = new Float32Array(n * n * 4), shd = new Float32Array(n * n * 2);
      const H = new Float32Array(n * n);
      const inner = this.Q.radius - 220;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = cxp - span / 2 + i * step, z = czp - span / 2 + j * step;
        let y = this.W.height(x, z);
        y -= Math.hypot(x - fx, z - fz) < inner ? 80 : 4; // tuck under the detailed chunks
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
        shd.set([1, 0.2], k * 2);
      }
      const idx = [];
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
      this.backdrop = this.terrainMesh(pos, nor, spl, shd, idx, false);
      this.scene.add(this.backdrop);
    }

    // ---------- vegetation ----------
    makeVegetation(map) {
      this.veg = [];
      if (!map.trees) return;
      const U = this.U;
      const kinds = [...new Set(map.trees.kinds)];
      const mk = (opts, key) => patch(new THREE.MeshStandardMaterial(opts), key, [this.fogPatch()]);
      const barkMat = mk({ map: A.barkTex(false), roughness: 0.95 }, 'bark');
      const birchMat = mk({ map: A.barkTex(true), roughness: 0.9 }, 'bark');
      const deadMat = mk({ map: A.barkTex(false), color: lin('#9a8f86'), roughness: 1 }, 'bark');
      this.materials.push(barkMat, birchMat, deadMat);
      const foliage = (kind) => {
        const t = A.foliageTex(kind);
        const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.82, vertexColors: true });
        m.alphaToCoverage = this.qualityName === 'high'; // smooth cut-out edges with MSAA
        const amt = kind === 'shrub' ? 0.01 : 0.008;
        patch(m, 'foliage' + amt, [windPatch(U, amt), this.fogPatch(), cardLightPatch]);
        const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: 0.38, side: THREE.DoubleSide });
        patch(dm, 'foliageDepth' + amt, [windPatch(U, amt)]);
        this.materials.push(m, dm);
        return { m, dm };
      };
      const cap = this.Q.treeCap;
      for (const kind of kinds) {
        const parts = [];
        if (kind === 'pine' || kind === 'pineSnow') {
          parts.push({ geo: A.trunk(16, 0.42, 0.06), mat: barkMat });
          const f = foliage(kind);
          parts.push({ geo: A.coniferFoliage({ height: 16.5, base: 4.5, tiers: 12, per: 6, radius: 3.6, seed: 3 }), mat: f.m, depth: f.dm, tint: true });
        } else if (kind === 'fir' || kind === 'firSnow') {
          parts.push({ geo: A.trunk(13, 0.45, 0.06), mat: barkMat });
          const f = foliage(kind);
          parts.push({ geo: A.coniferFoliage({ height: 13.5, base: 1.2, tiers: 15, per: 7, radius: 3.3, seed: 5 }), mat: f.m, depth: f.dm, tint: true });
        } else if (kind === 'birch') {
          const br = A.branches(11, 4.5);
          br.translate(0, 6, 0);
          parts.push({ geo: A.mergeGeos([A.trunk(12, 0.25, 0.06), br]), mat: birchMat });
          const f = foliage('birch');
          parts.push({ geo: A.leafCrown({ cy: 9, rx: 3.2, ry: 3.8, cards: 60, size: 1.3, seed: 7 }), mat: f.m, depth: f.dm, tint: true });
        } else if (kind === 'deadTree') {
          parts.push({ geo: A.branches(21, 7), mat: deadMat });
        } else if (kind === 'saguaro') {
          const cm = mk({ map: A.cactusTex(), roughness: 0.7 }, 'cactus');
          this.materials.push(cm);
          parts.push({ geo: A.saguaro(), mat: cm });
        } else if (kind === 'shrub') {
          const f = foliage('shrub');
          parts.push({ geo: A.leafCrown({ cy: 0.8, rx: 1.3, ry: 0.8, cards: 22, size: 0.65, seed: 9 }), mat: f.m, depth: f.dm, tint: true });
        }
        const meshes = parts.map((p) => {
          const im = new THREE.InstancedMesh(p.geo, p.mat, cap);
          im.count = 0;
          im.castShadow = true;
          im.receiveShadow = true;
          if (p.depth) im.customDepthMaterial = p.depth;
          im.frustumCulled = false;
          im.userData.tint = !!p.tint;
          this.scene.add(im);
          return im;
        });
        this.veg.push({ kind, meshes });
      }
    }

    makeRocks(map) {
      const mat = patch(new THREE.MeshStandardMaterial({ map: A.layer(map.layers.rock), roughness: 0.9 }), 'rock', [this.fogPatch()]);
      this.materials.push(mat);
      this.rockMeshes = [];
      for (let k = 0; k < 4; k++) {
        const im = new THREE.InstancedMesh(A.rockGeo(k + (map.seed % 7)), mat, 3500);
        im.count = 0;
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        this.scene.add(im);
        this.rockMeshes.push(im);
      }
    }

    refreshVegetation(fx, fz) {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), e = new THREE.Euler(), col = new THREE.Color();
      const TRr = this.Q.treeRadius, RRr = this.Q.rockRadius;
      const trees = {}, rocks = [[], [], [], []];
      for (const c of this.chunks.values()) {
        const d = Math.hypot((c.cx + 0.5) * CH - fx, (c.cz + 0.5) * CH - fz);
        const data = (d < TRr + CH || d < RRr + CH) ? this.W.chunk(c.cx, c.cz) : null;
        if (!data) continue;
        if (d < TRr + CH) for (const t of data.trees) (trees[t.kind] = trees[t.kind] || []).push(t);
        if (d < RRr + CH) for (const r of data.rocks) rocks[r.kind].push(r);
      }
      for (const v of this.veg) {
        let list = (trees[v.kind] || []).filter((t) => Math.hypot(t.x - fx, t.z - fz) < TRr);
        if (list.length > this.Q.treeCap) {
          list.sort((a, b) => Math.hypot(a.x - fx, a.z - fz) - Math.hypot(b.x - fx, b.z - fz));
          list.length = this.Q.treeCap;
        }
        for (const im of v.meshes) {
          list.forEach((t, i) => {
            p.set(t.x, t.y - 0.3, t.z);
            q.setFromEuler(e.set((t.seed - 0.5) * 0.06, t.rot, (t.seed - 0.5) * 0.06));
            sc.set(t.scale, t.scale * (0.85 + t.seed * 0.3), t.scale);
            m4.compose(p, q, sc);
            im.setMatrixAt(i, m4);
            if (im.userData.tint) {
              // each tree a slightly different green
              const h = (t.rot * 1000) % 1;
              col.setRGB(0.82 + h * 0.3, 0.88 + t.seed * 0.22, 0.78 + (1 - h) * 0.25);
              im.setColorAt(i, col);
            }
          });
          im.count = list.length;
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
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
      const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9 });
      patch(m, 'grass', [windPatch(this.U, 0.12), this.fogPatch(), cardLightPatch, (sh) => {
        // never let a tuft fill the screen: fade out right in front of the camera
        sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
          if (length(vFogW - cameraPosition) < 2.6 + fract(sin(dot(floor(vFogW.xz * 3.0), vec2(12.9898, 78.233))) * 43758.5) * 1.6) discard;`);
      }]);
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
      const cell = 0.75, R = this.Q.grassR;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const i0 = Math.floor((fx - R) / cell), i1 = Math.floor((fx + R) / cell);
      const j0 = Math.floor((fz - R) / cell), j1 = Math.floor((fz + R) / cell);
      let n = 0;
      const cap = this.Q.grass, dens = map.grass.density;
      const cells = [];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cell, z = (j + 0.5) * cell;
        const d2 = (x - fx) * (x - fx) + (z - fz) * (z - fz);
        if (d2 < R * R) cells.push([i, j, d2]);
      }
      cells.sort((a, b) => a[2] - b[2]); // nearest first, so the cap trims the far edge
      for (const [i, j] of cells) {
        if (n >= cap) break;
        const h = TR.hash3(map.seed, i, j);
        const r1 = (h & 1023) / 1024, r2 = ((h >>> 10) & 1023) / 1024, r3 = ((h >>> 20) & 1023) / 1024;
        if (r1 > dens * 0.9) continue;
        const x = (i + r2) * cell, z = (j + r3) * cell;
        const y = W.height(x, z);
        const hx = W.height(x + 2, z) - y, hz = W.height(x, z + 2) - y;
        const ny = 2 / Math.hypot(hx, 2, hz);
        const s = this.splatAt(x, z, y, ny);
        if (s[0] < 0.5 || r2 > s[0] + 0.1) continue;
        p.set(x, y - 0.06, z);
        q.setFromAxisAngle(up, r3 * 6.283);
        const k = 0.55 + r1 * 0.5;
        sc.set(k, k * (0.55 + r2 * 0.5), k);
        m4.compose(p, q, sc);
        this.grass.setMatrixAt(n++, m4);
      }
      this.grass.count = n;
      this.grass.instanceMatrix.needsUpdate = true;
    }

    makeSkyExtras(map) {
      const scene = this.scene;
      this.clouds = [];
      if (map.clouds) {
        const texs = [A.cloud(1), A.cloud(2), A.cloud(3), A.cloud(4)];
        const R = TR.rng(map.seed + 9);
        for (let i = 0; i < map.clouds; i++) {
          const mat = new THREE.SpriteMaterial({ map: texs[i % 4], color: map.id === 'volcano' ? lin('#8a7a74') : lin('#ffffff'), transparent: true, opacity: 0.9, depthWrite: false, fog: false });
          this.materials.push(mat);
          const sp = new THREE.Sprite(mat);
          const w = 420 + R() * 600;
          sp.scale.set(w, w * 0.42, 1);
          sp.userData = { ox: (R() - 0.5) * 5000, oz: -R() * 5000 + 1000, h: 420 + R() * 420, drift: 2 + R() * 3 };
          scene.add(sp);
          this.clouds.push(sp);
        }
      }
      this.stars = null;
      if (map.stars) {
        const R = TR.rng(77);
        const pos = new Float32Array(map.stars * 3), col = new Float32Array(map.stars * 3);
        for (let i = 0; i < map.stars; i++) {
          const th = R() * Math.PI * 2, ph = Math.acos(R() * 1.7 - 0.7);
          pos.set([Math.sin(ph) * Math.cos(th) * 2800, Math.cos(ph) * 2800, Math.sin(ph) * Math.sin(th) * 2800], i * 3);
          const b = 0.4 + Math.pow(R(), 3) * 3;
          col.set([b, b, b * (0.9 + R() * 0.2)], i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const sm = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false });
        this.materials.push(sm);
        this.stars = new THREE.Points(g, sm);
        this.stars.frustumCulled = false;
        scene.add(this.stars);
      }
      this.earth = null;
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
        for (let i = 0; i < 16; i++) {
          const m = new THREE.SpriteMaterial({ map: t, color: lin('#6a625e'), transparent: true, opacity: 0.6, depthWrite: false });
          this.materials.push(m);
          const sp = new THREE.Sprite(m);
          sp.userData.phase = i / 16;
          scene.add(sp);
          this.smoke.push(sp);
        }
      }
    }

    prime(x, z) {
      this.stream(x, z);
      this.updateBackdrop(x, z);
      this.refreshVegetation(x, z);
      this.grassAt = null;
      this.refreshGrass(x, z);
      this.vegDirty = false;
      this.lastVegAt = [x, z];
    }

    update(sim, camera, time, dt) {
      this.U.uTime.value = time;
      this.U.uFogBase.value = camera.position.y - 60;
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
      if (!this.lastVegAt || Math.hypot(t.x - this.lastVegAt[0], t.z - this.lastVegAt[1]) > 60) {
        this.lastVegAt = [t.x, t.z];
        this.vegDirty = true;
      }
      if (this.vegDirty && this.vegTimer <= 0) {
        this.refreshVegetation(t.x, t.z);
        this.vegDirty = false;
        this.vegTimer = 0.6;
      }
      this.refreshGrass(t.x, t.z);

      const sl = this.sunLight;
      sl.target.position.set(t.x, t.y, t.z);
      sl.position.copy(sl.target.position).addScaledVector(this.sunDir, 250);

      this.sky.position.copy(camera.position);
      if (this.stars) this.stars.position.copy(camera.position);
      if (this.earth) {
        this.earth.position.copy(camera.position).add(new THREE.Vector3(-650, 360, -1900));
        this.earth.rotation.y = time * 0.005;
      }
      for (const c of this.clouds) {
        const u = c.userData;
        u.ox += u.drift * dt;
        const wx = (((u.ox - camera.position.x) % 5000) + 7500) % 5000 - 2500;
        const wz = (((u.oz - camera.position.z) % 5000) + 7500) % 5000 - 3500;
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
