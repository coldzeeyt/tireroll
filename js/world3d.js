// Builds and updates the Three.js scene for a course.
(function (root) {
  const TR = root.TR;
  const A = TR.Assets;
  const lin = A.lin;

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
      vec3 c = mix(mid, top, smoothstep(0.05, 0.75, y));
      c = mix(hor, c, smoothstep(-0.05, 0.22, y));
      float sd = max(dot(d, sunDir), 0.0);
      c += sunCol * (pow(sd, 6.0) * 0.25 + pow(sd, 60.0) * 0.6);
      float ang = acos(clamp(dot(d, sunDir), -1.0, 1.0));
      c += sunCol * smoothstep(sunSize, sunSize * 0.7, ang) * 3.0;
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;

  class World3D {
    constructor(renderer) {
      this.renderer = renderer;
      this.scene = null;
      this.quality = 'high';
    }

    dispose() {
      if (!this.scene) return;
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) {
            if (m.map) m.map.dispose();
            m.dispose();
          }
        }
      });
      if (this.envRT) this.envRT.dispose();
      this.scene = null;
    }

    build(course) {
      this.dispose();
      const map = course.map;
      this.course = course;
      this.map = map;
      const scene = (this.scene = new THREE.Scene());
      const sunDir = new THREE.Vector3(Math.sin(map.sun.azim) * Math.cos(map.sun.elev), Math.sin(map.sun.elev), -Math.cos(map.sun.azim) * Math.cos(map.sun.elev)).normalize();
      this.sunDir = sunDir;
      scene.fog = new THREE.Fog(lin(map.fog.color), map.fog.near, map.fog.far);
      scene.background = lin(map.fog.color);

      // ---- sky
      const skyMat = new THREE.ShaderMaterial({
        vertexShader: SKY_VS,
        fragmentShader: SKY_FS,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: lin(map.sky.top) },
          mid: { value: lin(map.sky.mid) },
          hor: { value: lin(map.fog.color) },
          sunDir: { value: sunDir },
          sunCol: { value: lin(map.sun.color) },
          sunSize: { value: map.sun.size },
        },
      });
      this.sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), skyMat);
      this.sky.renderOrder = -10;
      this.sky.frustumCulled = false;
      scene.add(this.sky);

      // environment map for chrome, rendered from the sky
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat.clone()));
      envScene.children[0].material.uniforms = skyMat.uniforms;
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envRT = pm.fromScene(envScene, 0.04);
      pm.dispose();
      const env = this.envRT.texture;

      // ---- lights
      const hemi = new THREE.HemisphereLight(lin(map.hemi.sky), lin(map.hemi.ground), map.hemi.intensity);
      scene.add(hemi);
      const sun = (this.sunLight = new THREE.DirectionalLight(lin(map.sun.color), map.sun.intensity * 1.6));
      sun.castShadow = this.quality === 'high';
      sun.shadow.mapSize.set(2048, 2048);
      const sc = sun.shadow.camera;
      sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 400;
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.04;
      scene.add(sun);
      scene.add(sun.target);

      if (map.stars) this.buildStars(map.stars);
      if (map.earth) this.buildEarth(sunDir);
      if (map.id === 'volcano') {
        const glow = new THREE.PointLight(lin('#ff5a1a'), 0, 0);
        this.volcanoGlow = glow;
      }

      this.buildTerrain(course);
      this.buildMountains(course);
      this.buildDecor(course);
      this.buildClouds(course);
      this.buildMarkers(course);

      // ---- the tire
      this.tire = A.buildTire(env);
      scene.add(this.tire);
      return scene;
    }

    buildTerrain(course) {
      const map = this.map, hw = course.hw;
      const gr = map.ground;
      const U = [];
      for (let u = -130; u < -hw - 22; u += 6) U.push(u);
      for (let u = -hw - 22; u < -hw - 2; u += 2) U.push(u);
      for (let u = -hw - 2; u <= hw + 2; u += 1) U.push(u);
      for (let u = hw + 4; u <= hw + 22; u += 2) U.push(u);
      for (let u = hw + 28; u <= 130; u += 6) U.push(u);
      const cols = U.length;
      const sStart = -120, sEnd = course.endS + 120;
      const chunk = 80;
      const detail = A.groundDetail();
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: map.id === 'snow' ? 0.75 : 0.95, metalness: 0 });
      const noise = TR.noise2(map.seed + 3);
      const c = new THREE.Color(), cTrack = lin(gr.track), cTrack2 = lin(gr.trackDark), cBank = lin(gr.bank), cBank2 = lin(gr.bankDark), cRock = lin(gr.rock), cEdge = lin(gr.edge);
      for (let s0 = sStart; s0 < sEnd; s0 += chunk) {
        const rows = chunk + 1;
        const pos = new Float32Array(rows * cols * 3), nor = new Float32Array(rows * cols * 3), col = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
        for (let j = 0; j < rows; j++) {
          const s = s0 + j;
          const xc = course.xc(s);
          for (let i = 0; i < cols; i++) {
            const u = U[i];
            const x = xc + u, z = -s;
            const y = course.terrain(x, z);
            const k = j * cols + i;
            pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
            const n = course.normalAt(x, z);
            nor[k * 3] = n.x; nor[k * 3 + 1] = n.y; nor[k * 3 + 2] = n.z;
            uv[k * 2] = x * 0.18; uv[k * 2 + 1] = z * 0.18;
            const d = Math.abs(u) - hw;
            const nv = noise(x * 0.12, z * 0.12) * 0.5 + 0.5;
            if (d < 0) {
              c.copy(cTrack).lerp(cTrack2, nv * 0.8);
              // worn grooves where things roll
              const groove = Math.exp(-Math.pow(Math.abs(u) - 2.5, 2) * 0.8);
              c.lerp(cTrack2, groove * 0.35);
            } else if (d < 1.4) {
              c.copy(cEdge).lerp(cBank, d / 1.4);
            } else {
              c.copy(cBank).lerp(cBank2, nv);
              const steep = TR.clamp((0.5 - n.y) * 3, 0, 0.85);
              c.lerp(cRock, steep);
              if (map.id === 'snow') c.lerp(lin('#ffffff'), TR.clamp((y - course.profile(s) - 25) / 30, 0, 0.6));
            }
            col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
          }
        }
        const idx = [];
        for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
          const a = j * cols + i, b = a + 1, d = a + cols, e = d + 1;
          idx.push(a, b, d, b, e, d);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = true;
        this.scene.add(m);
      }
    }

    buildMountains(course) {
      const map = this.map, R = TR.rng(map.seed + 404);
      const mt = map.mountains;
      const parts = [];
      const base = lin(mt.color), cap = mt.cap ? lin(mt.cap) : null;
      for (let i = 0; i < mt.count * 2; i++) {
        const s = TR.range(R, -300, course.endS + 400);
        const side = i % 2 ? 1 : -1;
        const h = TR.range(R, mt.height[0], mt.height[1]);
        const rad = h * TR.range(R, 0.9, 1.6);
        const u = side * (rad + 150 + TR.range(R, 0, 300));
        const x = course.xc(TR.clamp(s, 0, course.endS)) + u, z = -s;
        let geo;
        if (mt.mesa) geo = new THREE.CylinderGeometry(rad * 0.55, rad, h * 0.55, 9, 2);
        else geo = new THREE.ConeGeometry(rad, h, 9, 4);
        geo = A.jitter(geo.toNonIndexed(), 0.18, i);
        const y0 = course.profile(TR.clamp(s, 0, course.endS)) - 20;
        geo.translate(x, y0 + (mt.mesa ? h * 0.275 : h / 2), z);
        const n = geo.attributes.position.count;
        const colA = new Float32Array(n * 3);
        const cc = new THREE.Color();
        for (let k = 0; k < n; k++) {
          const yy = geo.attributes.position.getY(k) - y0;
          const t = yy / (mt.mesa ? h * 0.55 : h);
          cc.copy(base).multiplyScalar(0.75 + t * 0.4);
          if (cap && t > 0.62) cc.copy(cap);
          if (mt.volcano && t > 0.9) cc.set(lin('#ff6a2a'));
          colA[k * 3] = cc.r; colA[k * 3 + 1] = cc.g; colA[k * 3 + 2] = cc.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
        geo.deleteAttribute('uv');
        geo.deleteAttribute('normal');
        parts.push(geo);
      }
      const merged = A.merge(parts);
      const m = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
      this.scene.add(m);
    }

    buildDecor(course) {
      const map = this.map;
      const byType = {};
      for (const d of course.decor) (byType[d.type] = byType[d.type] || []).push(d);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
      const glowMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.4, emissive: lin('#3a8cff'), emissiveIntensity: 0.5 });
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
      const flowerCols = ['#ff5a7a', '#ffd23a', '#ffffff', '#b86bff', '#ff8a3a'].map(lin);
      for (const type in byType) {
        const list = byType[type];
        const geo = A.decorGeo(type, map);
        const im = new THREE.InstancedMesh(geo, type === 'crystalSmall' ? glowMat : mat, list.length);
        list.forEach((d, i) => {
          p.set(d.x, d.y - 0.15, d.z);
          q.setFromAxisAngle(up, d.rot);
          sc.setScalar(d.scale);
          m4.compose(p, q, sc);
          im.setMatrixAt(i, m4);
          if (type === 'flower') c.copy(flowerCols[Math.floor(d.seed * flowerCols.length)]);
          else c.setRGB(1, 1, 1).multiplyScalar(0.85 + d.seed * 0.3);
          im.setColorAt(i, c);
        });
        im.castShadow = type !== 'flower';
        im.receiveShadow = true;
        this.scene.add(im);
      }
    }

    buildClouds(course) {
      const map = this.map;
      if (!map.clouds || !map.clouds.count) return;
      const R = TR.rng(map.seed + 9);
      const texs = [A.cloud(1), A.cloud(2), A.cloud(3)];
      const n = Math.round(map.clouds.count * (course.endS / 500));
      for (let i = 0; i < n; i++) {
        const mat = new THREE.SpriteMaterial({ map: texs[i % 3], color: lin(map.clouds.color), transparent: true, opacity: map.clouds.opacity, depthWrite: false, fog: true });
        const sp = new THREE.Sprite(mat);
        const s = TR.range(R, -200, course.endS + 300);
        const u = TR.range(R, -500, 500);
        sp.position.set(course.xc(TR.clamp(s, 0, course.endS)) + u, course.profile(TR.clamp(s, 0, course.endS)) + TR.range(R, 70, 170), -s);
        const w = TR.range(R, 90, 200);
        sp.scale.set(w, w * 0.45, 1);
        this.scene.add(sp);
      }
    }

    buildStars(n) {
      const R = TR.rng(77);
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const th = R() * Math.PI * 2, ph = Math.acos(R() * 1.6 - 0.6);
        const v = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)).multiplyScalar(1500);
        pos.set([v.x, v.y, v.z], i * 3);
        const b = 0.4 + R() * 0.6;
        col.set([b, b, b * (0.9 + R() * 0.2)], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
      this.stars.frustumCulled = false;
      this.scene.add(this.stars);
    }

    buildEarth(sunDir) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(70, 48, 32), new THREE.MeshStandardMaterial({ map: A.earth(), roughness: 1, fog: false }));
      m.rotation.z = 0.4;
      this.earth = m;
      this.scene.add(m);
    }

    buildMarkers(course) {
      // small roadside distance signs every 250 m
      for (const s of course.markers) {
        const tex = A.banner(`${s} m`, '#f2f2f2', '#1a1a1a');
        const g = new THREE.Group();
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 6), new THREE.MeshStandardMaterial({ color: lin('#777'), metalness: 0.5, roughness: 0.5 }));
        post.position.y = 1.1;
        const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide }));
        board.position.y = 2.1;
        g.add(post, board);
        const u = course.hw + 2.2;
        const x = course.xc(s) + u, z = -s;
        g.position.set(x, course.terrain(x, z), z);
        g.rotation.y = course.heading(s);
        post.castShadow = true;
        this.scene.add(g);
      }
    }

    // Per-frame sync with the simulation.
    update(sim, camera, time) {
      const t = sim.tire;
      const tire = this.tire;
      const ud = tire.userData;
      tire.position.set(t.x, t.y, t.z);
      tire.rotation.set(0, t.yaw, 0);
      ud.lean.rotation.z = -t.lean;
      ud.lean.scale.set(1 + t.squash * 0.4, 1 - t.squash, 1 + t.squash * 0.4);
      ud.spin.rotation.x = -t.spin;

      // shadow camera follows the tire
      const sl = this.sunLight;
      sl.target.position.set(t.x, t.y, t.z);
      sl.position.copy(sl.target.position).addScaledVector(this.sunDir, 150);

      this.sky.position.copy(camera.position);
      if (this.stars) this.stars.position.copy(camera.position);
      if (this.earth) {
        this.earth.position.copy(camera.position).add(new THREE.Vector3(-380, 260, -900));
        this.earth.rotation.y = time * 0.01;
      }
    }
  }

  TR.World3D = World3D;
})(typeof window !== 'undefined' ? window : globalThis);
