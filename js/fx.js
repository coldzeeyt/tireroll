// Particles: dust or snow thrown up by the tire, and falling snow/ash.
(function (root) {
  const TR = root.TR;

  const VS = `
    attribute float size; attribute float alpha; attribute vec3 tint;
    varying float vAlpha; varying vec3 vTint;
    uniform float scale;
    void main() {
      vAlpha = alpha; vTint = tint;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * scale / max(0.1, -mv.z);
      gl_Position = projectionMatrix * mv;
    }`;
  const FS = `
    uniform sampler2D tex;
    varying float vAlpha; varying vec3 vTint;
    void main() {
      vec4 t = texture2D(tex, gl_PointCoord);
      gl_FragColor = vec4(vTint, t.a * vAlpha);
      #include <encodings_fragment>
    }`;

  class Pool {
    constructor(scene, n) {
      this.n = n;
      this.p = [];
      for (let i = 0; i < n; i++) this.p.push({ life: 0 });
      this.pos = new Float32Array(n * 3);
      this.size = new Float32Array(n);
      this.alpha = new Float32Array(n);
      this.tint = new Float32Array(n * 3);
      const g = (this.geo = new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
      g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
      g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
      this.mat = new THREE.ShaderMaterial({
        vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false,
        uniforms: { tex: { value: TR.Assets.softDot() }, scale: { value: 600 } },
      });
      this.points = new THREE.Points(g, this.mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
      this.cursor = 0;
    }
    spawn(o) {
      const p = this.p[this.cursor];
      this.cursor = (this.cursor + 1) % this.n;
      Object.assign(p, { grav: 0, drag: 0.5, grow: 0, fadeIn: false }, o);
      p.max = p.life;
    }
    update(dt, H) {
      for (let i = 0; i < this.n; i++) {
        const p = this.p[i];
        if (p.life > 0) {
          p.life -= dt;
          p.vy -= p.grav * dt;
          const k = Math.exp(-p.drag * dt);
          p.vx *= k; p.vy *= k; p.vz *= k;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          p.s += p.grow * dt;
          const f = p.life / p.max;
          this.alpha[i] = p.a * (p.fadeIn ? Math.min(1, (1 - f) * 5) : 1) * Math.min(1, f * 2.5);
          this.size[i] = p.s;
          this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
          this.tint[i * 3] = p.c.r; this.tint[i * 3 + 1] = p.c.g; this.tint[i * 3 + 2] = p.c.b;
        } else this.alpha[i] = 0;
      }
      for (const k of ['position', 'size', 'alpha', 'tint']) this.geo.attributes[k].needsUpdate = true;
    }
  }

  class FX {
    constructor(scene, map, pixelScale) {
      this.map = map;
      this.dust = new Pool(scene, 900);
      this.weather = new Pool(scene, 1500);
      this.dust.mat.uniforms.scale.value = this.weather.mat.uniforms.scale.value = 600 * (pixelScale || 1);
      this.dustCol = TR.Assets.lin(map.dustColor);
      this.white = TR.Assets.lin('#ffffff');
      this.ash = TR.Assets.lin('#5a5450');
      this.wT = 0;
      this.R = TR.rng(9);
      // the Moon has no air: dust flies on ballistic arcs and doesn't billow
      this.vac = map.air === 0;
    }

    trail(sim, dt) {
      const t = sim.tire, sp = sim.speed();
      if (t.grounded <= 0 || sp < 5 || sim.settled) return;
      const R = this.R;
      let n = sp * (this.map.id === 'snow' ? 2.2 : 1.2) * dt + R();
      const g = this.map.gravity;
      while (n-- > 1) {
        this.dust.spawn({
          x: t.x + (R() - 0.5) * 0.4, y: t.y - t.r + 0.1, z: t.z + (R() - 0.5) * 0.4,
          vx: -t.vx * 0.12 + (R() - 0.5) * 2, vy: R() * 2 + 0.6, vz: -t.vz * 0.12 + (R() - 0.5) * 2,
          life: this.vac ? 2.2 : 0.9 + R() * 0.9, s: this.vac ? 0.25 : 0.6 + R() * 0.6, grow: this.vac ? 0 : 1.5, a: 0.35, c: this.dustCol,
          drag: this.vac ? 0 : 2, grav: this.vac ? g : this.map.id === 'snow' ? 3 : -0.2,
        });
      }
    }

    burst(x, y, z, v) {
      const R = this.R, g = this.map.gravity;
      const n = Math.min(90, 10 + v * 6);
      for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2, s = R() * v * 0.5;
        this.dust.spawn({
          x, y: y + 0.1, z, vx: Math.cos(a) * s, vy: R() * v * 0.4 + 1, vz: Math.sin(a) * s,
          life: this.vac ? 3 : 0.9 + R() * 1.3, s: this.vac ? 0.3 : 0.8 + R() * 1.2, grow: this.vac ? 0 : 2, a: 0.45, c: this.dustCol,
          drag: this.vac ? 0 : 2.5, grav: this.vac ? g : 1,
        });
      }
    }

    weatherTick(dt, cam) {
      const w = this.map.weather;
      if (w === 'none') return;
      const R = this.R;
      this.wT += (w === 'snow' ? 300 : 120) * dt;
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      while (this.wT > 1) {
        this.wT--;
        const x = cx + (R() - 0.5) * 80, z = cz + (R() - 0.5) * 80;
        if (w === 'snow') this.weather.spawn({ x, y: cy + 15 + R() * 10, z, vx: 1.2, vy: -2.2 - R() * 1.5, vz: 0.3, life: 9, s: 0.12 + R() * 0.14, a: 0.95, c: this.white, drag: 0, fadeIn: true });
        else this.weather.spawn({ x, y: cy + 12 + R() * 10, z, vx: 0.8, vy: -1 - R(), vz: 0, life: 10, s: 0.12 + R() * 0.1, a: 0.8, c: this.ash, drag: 0, fadeIn: true });
      }
    }

    update(dt, cam) {
      this.weatherTick(dt, cam);
      this.dust.update(dt);
      this.weather.update(dt);
    }
  }

  TR.FX = FX;
})(typeof window !== 'undefined' ? window : globalThis);
