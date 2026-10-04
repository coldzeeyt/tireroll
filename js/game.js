// Game shell: menus, modes, camera, HUD and the main loop.
(function (root) {
  const TR = root.TR;
  const $ = (id) => document.getElementById(id);
  const STEP = 1 / 240;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tireroll.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tireroll.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const CAMS = ['Follow', 'Low', 'Trackside', 'Drone'];
  const isPhone = () => matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;

  class Game {
    constructor() {
      const canvas = $('scene');
      const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.2, 9000);
      this.world = new TR.World3D(renderer);
      this.audio = new TR.Audio();
      this.quality = store.get('quality', isPhone() ? 'low' : 'high');
      this.mapIndex = store.get('map', 0);
      this.mode = store.get('mode', 'mountain');
      this.camMode = store.get('cam', 0);
      this.state = 'title';
      this.terrains = {};
      this.camPos = new THREE.Vector3();
      this.camLook = new THREE.Vector3();
      this.shake = 0;
      this.time = 0;
      this.acc = 0;
      this.paused = false;
      this.resize();
      addEventListener('resize', () => this.resize());
      this.bindUI();
      this.load(this.mapIndex, 'mountain', true);
      this.showScreen('title');
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }

    terrain(i, mode) {
      const k = i + mode;
      if (!this.terrains[k]) this.terrains[k] = TR.buildTerrain(TR.MAPS[i], mode);
      return this.terrains[k];
    }

    load(i, mode, attract) {
      this.mapIndex = i;
      this.runMode = mode;
      const W = this.terrain(i, mode);
      const seed = (Math.random() * 2 ** 31) >>> 0;
      this.sim = new TR.Sim(W, seed);
      this.scene = this.world.build(W, this.quality);
      this.world.prime(this.sim.tire.x, this.sim.tire.z);
      this.fx = new TR.FX(this.scene, W.map, this.renderer.getPixelRatio());
      this.attract = !!attract;
      this.hold = attract ? 0 : 1.2;
      this.snapCamera();
      if (this.audio.ctx) this.audio.setMusic(W.map.music);
      $('hud-place').textContent = W.map.name;
      $('hud-mode').textContent = mode === 'endless' ? 'Endless' : 'Mountain';
      $('title-place').textContent = W.map.name;
      this.lastHudAir = 0;
    }

    resize() {
      const w = innerWidth, h = innerHeight;
      const maxPR = TR.QUALITY[this.quality || 'high'].pixel;
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, maxPR));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.portrait = h > w * 1.1;
      document.body.classList.toggle('portrait', this.portrait);
      this.camera.updateProjectionMatrix();
    }

    // ---------------- UI ----------------
    bindUI() {
      const wake = () => {
        this.audio.init();
        this.audio.resume();
        if (this.audio.ctx && !this.audio.music) this.audio.setMusic(this.sim.map.music);
      };
      const click = (id, fn) => $(id).addEventListener('click', (e) => { wake(); fn(e); });
      click('m-mountain', () => this.openPlaces('mountain'));
      click('m-endless', () => this.openPlaces('endless'));
      click('m-quality', () => this.setQuality(this.quality === 'high' ? 'low' : 'high'));
      click('places-back', () => this.toTitle());
      click('r-again', () => this.start(this.mapIndex, this.runMode));
      click('r-places', () => this.openPlaces(this.runMode));
      click('r-menu', () => this.toTitle());
      click('h-cam', () => this.cycleCam());
      click('h-pause', () => this.setPaused(!this.paused));
      click('p-resume', () => this.setPaused(false));
      click('p-again', () => this.start(this.mapIndex, this.runMode));
      click('p-end', () => { this.paused = false; this.showResults(true); });
      click('p-menu', () => this.toTitle());
      for (const id of ['m-sound', 'h-sound']) click(id, () => { this.audio.setMuted(!this.audio.muted); this.syncLabels(); });
      this.syncLabels();

      addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const k = e.key.toLowerCase();
        if (k === 'c') this.cycleCam();
        if (k === 'm') { this.audio.setMuted(!this.audio.muted); this.syncLabels(); }
        if (k === 'escape' || k === 'p') {
          if (this.state === 'rolling') this.setPaused(!this.paused);
          else if (this.state === 'places') this.toTitle();
        }
        if (k === 'r' && (this.state === 'rolling' || this.state === 'results')) this.start(this.mapIndex, this.runMode);
      });

      const list = $('places-list');
      TR.MAPS.forEach((m, i) => {
        const b = document.createElement('button');
        b.className = 'place';
        b.id = 'place-' + m.id;
        b.innerHTML = `<span class="place-name">${m.name}</span><span class="place-blurb">${m.blurb}</span><span class="place-best" data-best="${m.id}"></span>`;
        b.addEventListener('click', () => { wake(); this.start(i, this.placesMode); });
        list.appendChild(b);
      });
    }

    syncLabels() {
      const s = this.audio.muted ? 'Sound off' : 'Sound on';
      $('m-sound').textContent = s;
      $('h-sound').textContent = this.audio.muted ? 'Unmute' : 'Mute';
      $('m-quality').textContent = this.quality === 'high' ? 'Graphics: high' : 'Graphics: battery saver';
      $('h-cam').textContent = CAMS[this.camMode];
    }

    setQuality(q) {
      this.quality = q;
      store.set('quality', q);
      this.syncLabels();
      this.resize();
      this.load(this.mapIndex, this.runMode, this.attract);
    }

    showScreen(name) {
      for (const s of document.querySelectorAll('.screen')) s.hidden = s.dataset.screen !== name;
      $('hud').hidden = !(name === 'hud' || name === 'pause');
      document.body.dataset.state = name;
    }

    fade(fn) {
      const f = $('fade');
      f.classList.add('on');
      setTimeout(() => {
        fn();
        requestAnimationFrame(() => f.classList.remove('on'));
      }, 260);
    }

    toTitle() {
      this.paused = false;
      this.fade(() => {
        this.state = 'title';
        if (!this.attract) this.load(this.mapIndex, 'mountain', true);
        this.showScreen('title');
      });
    }

    openPlaces(mode) {
      this.placesMode = mode;
      this.state = 'places';
      $('places-title').textContent = mode === 'endless' ? 'Endless slope' : 'Choose a mountain';
      $('places-note').textContent = mode === 'endless'
        ? 'The slope never ends. The tire is picked up and let go again if it ever stops.'
        : 'Let go near the summit and watch where it ends up. Every release takes a different line.';
      for (const el of document.querySelectorAll('[data-best]')) {
        const b = store.get(`best.${mode}.${el.dataset.best}`, null);
        el.textContent = b ? `Longest roll ${(b / 1000).toFixed(2)} km` : '';
      }
      this.showScreen('places');
      const c = $('place-' + TR.MAPS[this.mapIndex].id);
      if (c) c.focus({ preventScroll: true });
    }

    start(i, mode) {
      store.set('map', i);
      store.set('mode', mode);
      this.paused = false;
      $('loading').hidden = false;
      this.fade(() => {
        this.load(i, mode, false);
        $('loading').hidden = true;
        this.state = 'rolling';
        this.showScreen('hud');
      });
    }

    setPaused(p) {
      if (this.state !== 'rolling') return;
      this.paused = p;
      $('p-end').hidden = this.runMode !== 'endless';
      this.showScreen(p ? 'pause' : 'hud');
    }

    cycleCam() {
      this.camMode = (this.camMode + 1) % CAMS.length;
      store.set('cam', this.camMode);
      this.syncLabels();
      this.note(`${CAMS[this.camMode]} camera`);
    }

    note(text) {
      const el = $('note');
      el.textContent = text;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }

    showResults(ended) {
      const s = this.sim, m = s.map;
      const key = `best.${this.runMode}.${m.id}`;
      const prev = store.get(key, 0);
      const isBest = s.distance > prev;
      if (isBest) store.set(key, s.distance);
      $('res-title').textContent = this.runMode === 'endless' ? 'Run over' : 'Came to rest';
      $('res-place').textContent = m.name;
      $('res-dist').textContent = (s.distance / 1000).toFixed(2);
      $('res-best').textContent = isBest ? (prev ? 'Your longest roll here' : 'First roll here') : `Longest here: ${(prev / 1000).toFixed(2)} km`;
      $('res-time').textContent = TR.fmtTime(s.time);
      $('res-drop').textContent = `${Math.round(s.startY - s.minY)} m`;
      $('res-top').textContent = `${Math.round(s.maxSpeed * 3.6)} km/h`;
      $('res-air').textContent = `${s.maxAir.toFixed(1)} s`;
      $('res-jumps').textContent = String(s.jumps);
      $('res-hits').textContent = String(s.hits);
      this.state = 'results';
      this.showScreen('results');
      if (!ended) this.audio.chime();
    }

    // ---------------- camera ----------------
    camTarget(dt) {
      const t = this.sim.tire, W = this.sim.mt;
      const sp = Math.hypot(t.vx, t.vz);
      let dx, dz;
      if (sp > 1.5) { dx = t.vx / sp; dz = t.vz / sp; }
      else { dx = -Math.sin(t.yaw); dz = -Math.cos(t.yaw); }
      if (!this.camDir) this.camDir = { x: dx, z: dz };
      const k = 1 - Math.exp(-dt * 2.5);
      this.camDir.x += (dx - this.camDir.x) * k;
      this.camDir.z += (dz - this.camDir.z) * k;
      const l = Math.hypot(this.camDir.x, this.camDir.z) || 1;
      const fx = this.camDir.x / l, fz = this.camDir.z / l;
      const pos = new THREE.Vector3(), look = new THREE.Vector3(t.x, t.y + 0.3, t.z);
      let mode = this.attract ? 4 : this.camMode;
      const time = this.time;
      if (this.sim.settled || this.sim.toppling) mode = 5;
      const P = this.portrait;
      if (mode === 0) {
        const dist = (P ? 10 : 7.5) + Math.min(sp, 40) * 0.06;
        pos.set(t.x - fx * dist, t.y + (P ? 4.6 : 2.8) + Math.min(sp, 40) * 0.025, t.z - fz * dist);
        look.set(t.x + fx * (P ? 9 : 6), t.y - (P ? 1.2 : 0), t.z + fz * (P ? 9 : 6));
      } else if (mode === 1) {
        const sx = -fz, sz = fx;
        pos.set(t.x + sx * 4.2 - fx * 3, t.y + 0.55, t.z + sz * 4.2 - fz * 3);
        look.set(t.x + fx * 2, t.y + 0.3, t.z + fz * 2);
      } else if (mode === 2) {
        // a fixed spot ahead of the tire; jump to a new one when it passes
        if (!this.spot || Math.hypot(t.x - this.spot.x, t.z - this.spot.z) > 70 || ((t.x - this.spot.x) * fx + (t.z - this.spot.z) * fz) > 25) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const sx = t.x + fx * 45 - fz * side * 9, sz = t.z + fz * 45 + fx * side * 9;
          this.spot = { x: sx, z: sz, y: W.height(sx, sz) + 1.7 };
          this.snapNext = true;
        }
        pos.set(this.spot.x, this.spot.y, this.spot.z);
      } else if (mode === 3) {
        pos.set(t.x - fx * 22, t.y + 16, t.z - fz * 22);
        look.set(t.x + fx * 10, t.y - 3, t.z + fz * 10);
      } else if (mode === 4) {
        // menu: high, slowly sweeping view from behind and above
        const sx = -fz, sz = fx;
        const sweep = Math.sin(time * 0.12) * 9;
        pos.set(t.x - fx * 13 + sx * sweep, t.y + 6 + Math.sin(time * 0.2), t.z - fz * 13 + sz * sweep);
        look.set(t.x + fx * 18, t.y - 3, t.z + fz * 18);
      } else {
        const a = time * 0.22;
        pos.set(t.x + Math.sin(a) * 5.5, t.y + 2.4, t.z + Math.cos(a) * 5.5);
        look.set(t.x, t.y, t.z);
      }
      const g = W.height(pos.x, pos.z) + 0.9;
      if (pos.y < g) pos.y = g;
      return { pos, look };
    }

    snapCamera() {
      this.camDir = null;
      this.spot = null;
      const { pos, look } = this.camTarget(0.016);
      this.camPos.copy(pos);
      this.camLook.copy(look);
    }

    updateCamera(dt) {
      const { pos, look } = this.camTarget(dt);
      if (this.snapNext) { this.camPos.copy(pos); this.snapNext = false; }
      const fixed = this.camMode === 2 && !this.attract;
      this.camPos.lerp(pos, 1 - Math.exp(-dt * (fixed ? 40 : 5)));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 9));
      const cam = this.camera;
      cam.position.copy(this.camPos);
      if (this.shake > 0) {
        cam.position.x += (Math.random() - 0.5) * this.shake;
        cam.position.y += (Math.random() - 0.5) * this.shake;
        this.shake *= Math.exp(-dt * 8);
      }
      cam.lookAt(this.camLook);
      const sp = this.sim.speed();
      const base = this.portrait ? 72 : 55;
      const fov = base + Math.min(sp, 40) * 0.3;
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 2);
      cam.updateProjectionMatrix();
    }

    // ---------------- loop ----------------
    frame(now) {
      if (this.frozen) { requestAnimationFrame((t) => this.frame(t)); return; } // used by tools/screenshot.js
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused) {
        this.time += dt;
        if (this.hold > 0) this.hold -= dt;
        else {
          this.acc += dt;
          let n = 0;
          while (this.acc >= STEP && n++ < 60) {
            this.sim.step(STEP);
            this.acc -= STEP;
          }
          if (n >= 60) this.acc = 0;
        }
        this.rules(dt);
        this.handleEvents();
        this.fx.trail(this.sim, dt);
        this.updateCamera(dt);
        this.fx.update(dt, this.camera);
        this.audio.update(this.state === 'rolling' || this.attract ? this.sim : null);
        if (this.state === 'rolling') this.updateHUD();
      }
      this.world.update(this.sim, this.camera, this.time, dt);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame((t) => this.frame(t));
    }

    rules(dt) {
      const s = this.sim;
      if (this.runMode === 'endless' || this.attract) {
        // endless: if it stops, stand it back up and let it go again
        if ((s.settled && s.time - (s.settledAt || s.time) > 1.5) || (!s.toppling && s.stalled())) {
          s.rerelease();
          if (!this.attract) this.note('Picked up and let go again');
        }
        if (s.settled && !s.settledAt) s.settledAt = s.time;
        if (!s.settled) s.settledAt = 0;
      } else if (!s.toppling) {
        // rocking slowly back and forth in a hollow for a long time counts as stopped
        this.slowT = s.speed() < 2.5 ? (this.slowT || 0) + dt : 0;
        if (this.slowT > 25) {
          s.toppling = true;
          s.tire.leanV = 0.3;
          this.slowT = 0;
        }
      }
    }

    handleEvents() {
      const s = this.sim;
      for (const e of s.events) {
        if (e.type === 'land') {
          this.fx.burst(e.x, e.y, e.z, e.v);
          if (!this.attract) this.audio.thud(e.v);
          if (e.v > 7) this.shake = Math.min(0.5, e.v * 0.03);
        } else if (e.type === 'hit') {
          this.fx.burst(e.x, e.y, e.z, e.v * 0.6);
          if (!this.attract) this.audio.thud(e.v * 1.5);
          this.shake = Math.min(0.6, e.v * 0.05);
        } else if (e.type === 'thud') {
          this.fx.burst(e.x, e.y - 0.5, e.z, 5);
          if (!this.attract) this.audio.thud(e.v * 4);
        } else if (e.type === 'settled' && this.state === 'rolling' && this.runMode === 'mountain') {
          setTimeout(() => { if (this.state === 'rolling') this.showResults(false); }, 1500);
        }
      }
      s.events.length = 0;
    }

    updateHUD() {
      const s = this.sim;
      $('hud-speed').textContent = String(Math.round(s.speed() * 3.6));
      $('hud-dist').textContent = s.distance < 1000 ? `${Math.round(s.distance)} m` : `${(s.distance / 1000).toFixed(2)} km`;
      $('hud-drop').textContent = `${Math.max(0, Math.round(s.startY - s.tire.y))} m`;
      $('hud-time').textContent = TR.fmtTime(s.time);
      const air = s.tire.grounded <= 0 && s.airTime > 0.3;
      $('hud-air').textContent = air ? `${s.airTime.toFixed(1)} s in the air` : '';
    }
  }

  TR.Game = Game;
  addEventListener('DOMContentLoaded', () => {
    try {
      TR.game = new Game();
    } catch (err) {
      console.error(err);
      document.getElementById('fatal').hidden = false;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
