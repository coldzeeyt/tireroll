// Particle effects: dust/snow kicked up by the tire, and ambient weather.
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
    constructor(scene, n, additive) {
      this.n = n;
      this.p = [];
      for (let i = 0; i < n; i++) this.p.push({ life: 0 });
      this.pos = new Float32Array(n * 3);
      this.size = new Float32Array(n);
      this.alpha = new Float32Array(n);
      this.tint = new Float32Array(n * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
      g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
      g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
      this.geo = g;
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: { tex: { value: TR.Assets.softDot() }, scale: { value: 600 } },
      });
      this.points = new THREE.Points(g, mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
      this.cursor = 0;
    }
    spawn(o) {
      const p = this.p[this.cursor];
      this.cursor = (this.cursor + 1) % this.n;
      Object.assign(p, { grav: 0, drag: 0.5, grow: 0, fade: 1 }, o);
      p.max = p.life;
      return p;
    }
    update(dt, ground) {
      for (let i = 0; i < this.n; i++) {
        const p = this.p[i];
        if (p.life > 0) {
          p.life -= dt;
          p.vy -= p.grav * dt;
          const k = Math.exp(-p.drag * dt);
          p.vx *= k; p.vy *= k; p.vz *= k;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.wrap) p.wrap(p);
          p.s += p.grow * dt;
          const f = p.life / p.max;
          this.alpha[i] = p.a * (p.fadeIn ? Math.min(1, (1 - f) * 6) : 1) * Math.min(1, f * 2.5);
          this.size[i] = p.s;
          this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
          this.tint[i * 3] = p.c.r; this.tint[i * 3 + 1] = p.c.g; this.tint[i * 3 + 2] = p.c.b;
        } else {
          this.alpha[i] = 0;
        }
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.size.needsUpdate = true;
      this.geo.attributes.alpha.needsUpdate = true;
      this.geo.attributes.tint.needsUpdate = true;
    }
  }

  class FX {
    constructor(scene, map) {
      this.map = map;
      this.dust = new Pool(scene, 900, false);
      this.glow = new Pool(scene, 500, true);
      this.weather = new Pool(scene, 1400, map.weather === 'embers');
      this.dustCol = TR.Assets.lin(map.dustColor);
      this.weatherT = 0;
      this.R = TR.rng(9);
    }

    // continuous trail of dust while rolling fast on the ground
    trail(sim, dt) {
      const t = sim.tire;
      const sp = sim.speed();
      if (t.grounded <= 0 || sp < 6 || sim.settled) return;
      const rate = sp * (this.map.id === 'snow' ? 3 : 1.6);
      let n = rate * dt + this.R();
      const R = this.R;
      while (n-- > 1) {
        this.dust.spawn({
          x: t.x + (R() - 0.5) * 0.4, y: t.y - t.r + 0.1, z: t.z + (R() - 0.5) * 0.4,
          vx: -t.vx * 0.15 + (R() - 0.5) * 2, vy: R() * 2 + 0.5, vz: -t.vz * 0.15 + (R() - 0.5) * 2,
          life: 0.8 + R() * 0.8, s: 0.6 + R() * 0.6, grow: 1.6, a: 0.35, c: this.dustCol, drag: 2, grav: this.map.id === 'snow' ? 3 : -0.3,
        });
      }
    }

    burst(x, y, z, v) {
      const R = this.R;
      const n = Math.min(80, 10 + v * 3);
      for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2, s = R() * v * 0.35;
        this.dust.spawn({
          x, y: y + 0.1, z, vx: Math.cos(a) * s, vy: R() * v * 0.25 + 1, vz: Math.sin(a) * s,
          life: 0.8 + R() * 1.2, s: 0.8 + R() * 1.2, grow: 2.2, a: 0.45, c: this.dustCol, drag: 2.5, grav: 1,
        });
      }
    }

    sparkle(x, y, z) {
      const R = this.R;
      const cols = ['#ffd23a', '#ff5a7a', '#5ad1ff', '#7aff8a', '#ffffff'].map(TR.Assets.lin);
      for (let i = 0; i < 120; i++) {
        const a = R() * Math.PI * 2, s = 3 + R() * 7;
        this.glow.spawn({ x, y: y + 1, z, vx: Math.cos(a) * s, vy: 4 + R() * 9, vz: Math.sin(a) * s, life: 1.5 + R(), s: 0.35, a: 1, c: cols[i % cols.length], drag: 1, grav: 6 });
      }
    }

    updateWeather(dt, cam) {
      const w = this.map.weather;
      if (w === 'none') return;
      const R = this.R;
      const rate = { snow: 260, leaves: 14, dust: 40, embers: 70 }[w] || 0;
      this.weatherT += rate * dt;
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      while (this.weatherT > 1) {
        this.weatherT--;
        const x = cx + (R() - 0.5) * 70, z = cz + (R() - 0.5) * 70 - 20;
        if (w === 'snow') this.weather.spawn({ x, y: cy + 14 + R() * 10, z, vx: 1.5, vy: -3 - R() * 2, vz: 0, life: 7, s: 0.25 + R() * 0.25, a: 0.9, c: TR.Assets.lin('#ffffff'), drag: 0, fadeIn: true });
        if (w === 'leaves') this.weather.spawn({ x, y: cy + 10 + R() * 8, z, vx: 2 + R(), vy: -1.2, vz: R() - 0.5, life: 9, s: 0.3, a: 0.95, c: TR.Assets.lin(R() < 0.5 ? '#e8a23a' : '#9acd4a'), drag: 0, fadeIn: true });
        if (w === 'dust') this.weather.spawn({ x, y: cy - 4 + R() * 10, z, vx: 3 + R() * 2, vy: R() * 0.4, vz: 0, life: 5, s: 0.2, a: 0.5, c: TR.Assets.lin('#ffe0b0'), drag: 0, fadeIn: true });
        if (w === 'embers') this.weather.spawn({ x, y: cy - 10 + R() * 6, z, vx: (R() - 0.5), vy: 2 + R() * 2, vz: (R() - 0.5), life: 6, s: 0.22, a: 1, c: TR.Assets.lin(R() < 0.6 ? '#ff7a2a' : '#ffd060'), drag: 0, fadeIn: true });
      }
    }

    update(dt, cam) {
      this.updateWeather(dt, cam);
      this.dust.update(dt);
      this.glow.update(dt);
      this.weather.update(dt);
    }
  }

  TR.FX = FX;
})(typeof window !== 'undefined' ? window : globalThis);
