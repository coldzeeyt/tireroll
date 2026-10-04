// Game shell: menus, camera, HUD, main loop.
(function (root) {
  const TR = root.TR;
  const $ = (id) => document.getElementById(id);
  const STEP = 1 / 240;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tireroll.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tireroll.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const CAMS = ['Chase', 'Trackside', 'Low', 'Orbit'];

  class Game {
    constructor() {
      const canvas = $('scene');
      const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
      this.world = new TR.World3D(renderer);
      this.audio = new TR.Audio();
      this.mapIndex = store.get('map', 0);
      this.camMode = store.get('cam', 0);
      this.state = 'title';
      this.courses = {};
      this.camPos = new THREE.Vector3();
      this.camLook = new THREE.Vector3();
      this.shake = 0;
      this.time = 0;
      this.acc = 0;
      this.paused = false;
      this.resize();
      addEventListener('resize', () => this.resize());
      this.bindUI();
      this.load(this.mapIndex, true);
      this.showScreen('title');
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }

    course(i) {
      if (!this.courses[i]) this.courses[i] = TR.buildCourse(TR.MAPS[i]);
      return this.courses[i];
    }

    load(i, attract) {
      this.mapIndex = i;
      const course = this.course(i);
      const scene = this.world.build(course);
      this.scene = scene;
      this.fx = new TR.FX(scene, course.map);
      this.sim = new TR.Sim(course);
      this.attract = !!attract;
      this.hold = attract ? 0 : 1.6;
      this.snapCamera();
      if (this.audio.ctx) this.audio.setMusic(course.map.music);
      document.documentElement.style.setProperty('--map-accent', course.map.sky.mid);
      $('hud-map').textContent = course.map.name;
      $('title-map').textContent = course.map.name;
      this.popup = [];
    }

    resize() {
      const w = innerWidth, h = innerHeight;
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    // ---------------- UI ----------------
    bindUI() {
      const click = (id, fn) => $(id).addEventListener('click', (e) => { this.audio.init(); this.audio.resume(); if (this.audio.ctx && !this.audio.music) this.audio.setMusic(this.sim.map.music); fn(e); });
      click('btn-roll', () => this.startRoll(this.mapIndex));
      click('btn-hills', () => this.openSelect());
      click('btn-back', () => this.toTitle());
      click('btn-again', () => this.startRoll(this.mapIndex));
      click('btn-next', () => this.startRoll((this.mapIndex + 1) % TR.MAPS.length));
      click('btn-menu', () => this.toTitle());
      click('btn-cam', () => this.cycleCam());
      click('btn-pause', () => this.setPaused(!this.paused));
      click('btn-resume', () => this.setPaused(false));
      click('btn-restart', () => this.startRoll(this.mapIndex));
      click('btn-quit', () => this.toTitle());
      for (const id of ['btn-sound', 'btn-sound2']) click(id, () => { this.audio.setMuted(!this.audio.muted); this.syncSound(); });
      this.syncSound();

      addEventListener('keydown', (e) => {
        if (e.repeat) return;
        if (e.key === 'c' || e.key === 'C') this.cycleCam();
        if (e.key === 'm' || e.key === 'M') { this.audio.setMuted(!this.audio.muted); this.syncSound(); }
        if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
          if (this.state === 'rolling') this.setPaused(!this.paused);
          else if (this.state === 'select') this.toTitle();
        }
        if ((e.key === 'Enter' || e.key === ' ') && this.state === 'title') { this.audio.init(); this.startRoll(this.mapIndex); }
        if ((e.key === 'r' || e.key === 'R') && (this.state === 'rolling' || this.state === 'results')) this.startRoll(this.mapIndex);
      });

      // map cards
      const list = $('cards');
      TR.MAPS.forEach((m, i) => {
        const b = document.createElement('button');
        b.className = 'card';
        b.id = 'card-' + m.id;
        b.style.setProperty('--sky-top', m.sky.top);
        b.style.setProperty('--sky-mid', m.sky.mid);
        b.style.setProperty('--sky-hor', m.fog.color);
        b.style.setProperty('--ground', m.ground.bank);
        b.style.setProperty('--ground2', m.ground.track);
        b.innerHTML = `
          <span class="card-art" aria-hidden="true"><span class="card-sun"></span><span class="card-hill"></span><span class="card-track"></span></span>
          <span class="card-body">
            <span class="card-name">${m.name}</span>
            <span class="card-blurb">${m.blurb}</span>
            <span class="card-meta">
              <span>${Math.round(TR.buildCourseLength(m))} m</span>
              <span>${(m.gravity / 9.81).toFixed(1)} g</span>
              <span class="card-best" data-best="${m.id}"></span>
            </span>
          </span>`;
        b.addEventListener('mouseenter', () => this.previewMap(i));
        b.addEventListener('focus', () => this.previewMap(i));
        b.addEventListener('click', () => { this.audio.init(); this.audio.resume(); this.startRoll(i); });
        list.appendChild(b);
      });
    }

    syncSound() {
      for (const id of ['btn-sound', 'btn-sound2']) {
        $(id).setAttribute('aria-pressed', String(!this.audio.muted));
        $(id).querySelector('span').textContent = this.audio.muted ? 'Sound off' : 'Sound on';
      }
    }

    showScreen(name) {
      for (const s of document.querySelectorAll('.screen')) s.hidden = s.dataset.screen !== name;
      $('hud').hidden = !(name === 'hud' || name === 'pause');
      document.body.dataset.state = name;
    }

    refreshBests() {
      for (const el of document.querySelectorAll('[data-best]')) {
        const b = store.get('best.' + el.dataset.best, null);
        el.textContent = b ? `Best ${TR.fmtTime(b.time)}` : 'Not rolled yet';
      }
    }

    toTitle() {
      this.state = 'title';
      this.paused = false;
      if (!this.attract) this.load(this.mapIndex, true);
      this.showScreen('title');
    }

    openSelect() {
      this.state = 'select';
      this.refreshBests();
      this.showScreen('select');
      const c = $('card-' + TR.MAPS[this.mapIndex].id);
      if (c) c.focus();
    }

    previewMap(i) {
      if (i === this.mapIndex && this.attract) return;
      clearTimeout(this._prev);
      this._prev = setTimeout(() => this.load(i, true), 120);
    }

    startRoll(i) {
      store.set('map', i);
      this.load(i, false);
      this.state = 'rolling';
      this.paused = false;
      this.showScreen('hud');
      $('intro-name').textContent = this.sim.map.name;
      $('intro').classList.remove('show');
      void $('intro').offsetWidth;
      $('intro').classList.add('show');
    }

    setPaused(p) {
      if (this.state !== 'rolling') return;
      this.paused = p;
      this.showScreen(p ? 'pause' : 'hud');
    }

    cycleCam() {
      this.camMode = (this.camMode + 1) % CAMS.length;
      store.set('cam', this.camMode);
      $('btn-cam').querySelector('span').textContent = CAMS[this.camMode];
      this.toast(`Camera: ${CAMS[this.camMode]}`);
    }

    toast(text) {
      const el = $('toast');
      el.textContent = text;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }

    showResults() {
      const s = this.sim, m = s.map;
      const key = 'best.' + m.id;
      const prev = store.get(key, null);
      const rec = { time: s.rollTime, top: s.maxSpeed, air: s.maxAir };
      const isBest = !prev || rec.time < prev.time;
      if (isBest) store.set(key, rec);
      $('res-map').textContent = m.name;
      $('res-time').textContent = TR.fmtTime(s.rollTime);
      $('res-best').textContent = isBest ? (prev ? 'New fastest roll' : 'First roll on this hill') : `Fastest: ${TR.fmtTime(prev.time)}`;
      $('res-top').textContent = `${Math.round(s.maxSpeed * 3.6)}`;
      $('res-air').textContent = s.maxAir.toFixed(2);
      $('res-jumps').textContent = String(s.jumps);
      $('res-drop').textContent = `${Math.round(s.maxDrop)}`;
      $('btn-next').querySelector('span').textContent = `Next: ${TR.MAPS[(this.mapIndex + 1) % TR.MAPS.length].name}`;
      this.state = 'results';
      this.showScreen('results');
      this.audio.chime();
    }

    // ---------------- camera ----------------
    camTarget(dt) {
      const t = this.sim.tire, C = this.sim.course;
      const sp = Math.hypot(t.vx, t.vz);
      let dx, dz;
      if (sp > 2) { dx = t.vx / sp; dz = t.vz / sp; }
      else { dx = -Math.sin(t.yaw); dz = -Math.cos(t.yaw); }
      if (!this.camDir) this.camDir = { x: dx, z: dz };
      const k = 1 - Math.exp(-dt * 3);
      this.camDir.x += (dx - this.camDir.x) * k;
      this.camDir.z += (dz - this.camDir.z) * k;
      const l = Math.hypot(this.camDir.x, this.camDir.z) || 1;
      const fx = this.camDir.x / l, fz = this.camDir.z / l;
      const pos = new THREE.Vector3(), look = new THREE.Vector3(t.x, t.y + 0.3, t.z);
      let mode = this.attract ? 3 : this.camMode;
      const time = this.time;
      if (this.sim.settled || (this.sim.toppling && mode === 0)) mode = 4;
      if (mode === 0) {
        const dist = 7 + Math.min(sp, 40) * 0.06;
        pos.set(t.x - fx * dist, t.y + 2.6 + Math.min(sp, 40) * 0.02, t.z - fz * dist);
        look.set(t.x + fx * 6, t.y + 0.6, t.z + fz * 6);
      } else if (mode === 1) {
        // trackside: fixed spots every 60 m, cut when the tire passes
        const s = -t.z;
        const slot = Math.floor((s + 25) / 60);
        const cs = slot * 60 + 25;
        const side = slot % 2 ? 1 : -1;
        const cx = C.xc(cs) + side * (C.hw + 7), cz = -cs;
        pos.set(cx, C.terrain(cx, cz) + 3.5, cz);
        this.snapNext = this.lastSlot !== slot;
        this.lastSlot = slot;
      } else if (mode === 2) {
        // low and to the side, looking across the tire
        const sx = -fz, sz = fx;
        pos.set(t.x + sx * 4.5 - fx * 2.5, t.y + 0.5, t.z + sz * 4.5 - fz * 2.5);
        look.set(t.x + fx * 1.5, t.y + 0.35, t.z + fz * 1.5);
      } else if (mode === 3) {
        // high, slowly sweeping view from behind: the whole valley opens up below
        const sx = -fz, sz = fx;
        const sweep = Math.sin(time * 0.15) * 7;
        pos.set(t.x - fx * 11 + sx * sweep, t.y + 5 + Math.sin(time * 0.23), t.z - fz * 11 + sz * sweep);
        look.set(t.x + fx * 14, t.y - 1.5, t.z + fz * 14);
      } else {
        // resting shot: slow orbit close to the toppled tire
        const a = time * 0.25;
        pos.set(t.x + Math.sin(a) * 5, t.y + 2.2, t.z + Math.cos(a) * 5);
        look.set(t.x, t.y, t.z);
      }
      const g = C.terrain(pos.x, pos.z) + 0.8;
      if (pos.y < g) pos.y = g;
      return { pos, look };
    }

    snapCamera() {
      this.camDir = null;
      const { pos, look } = this.camTarget(0.016);
      this.camPos.copy(pos);
      this.camLook.copy(look);
    }

    updateCamera(dt) {
      const { pos, look } = this.camTarget(dt);
      if (this.snapNext) { this.camPos.copy(pos); this.snapNext = false; }
      const kp = 1 - Math.exp(-dt * (this.camMode === 1 && !this.attract ? 30 : 6));
      const kl = 1 - Math.exp(-dt * 10);
      this.camPos.lerp(pos, kp);
      this.camLook.lerp(look, kl);
      const cam = this.camera;
      cam.position.copy(this.camPos);
      if (this.shake > 0) {
        cam.position.x += (Math.random() - 0.5) * this.shake;
        cam.position.y += (Math.random() - 0.5) * this.shake;
        this.shake *= Math.exp(-dt * 8);
      }
      cam.lookAt(this.camLook);
      const sp = this.sim.speed();
      const fov = 58 + Math.min(sp, 45) * 0.4;
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 2);
      cam.updateProjectionMatrix();
    }

    // ---------------- loop ----------------
    frame(now) {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused) {
        this.time += dt;
        if (this.hold > 0) this.hold -= dt;
        else {
          this.acc += dt;
          while (this.acc >= STEP) {
            this.sim.step(STEP);
            this.acc -= STEP;
          }
        }
        this.handleEvents();
        if (this.attract && this.sim.settled) this.load(this.mapIndex, true);
        this.fx.trail(this.sim, dt);
        this.updateCamera(dt);
        this.fx.update(dt, this.camera);
        this.audio.update(this.state === 'rolling' || this.attract ? this.sim : null);
        if (this.state === 'rolling') this.updateHUD();
      }
      this.world.update(this.sim, this.camera, this.time);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame((t) => this.frame(t));
    }

    handleEvents() {
      const s = this.sim;
      for (const e of s.events) {
        if (e.type === 'land') {
          this.fx.burst(e.x, e.y, e.z, e.v);
          if (!this.attract) this.audio.thud(e.v);
          if (e.v > 8) this.shake = Math.min(0.6, e.v * 0.03);
        } else if (e.type === 'air' && this.state === 'rolling') {
          this.toast(`Air ${e.time.toFixed(2)} s`);
        } else if (e.type === 'thud') {
          this.fx.burst(e.x, e.y - 0.5, e.z, 6);
          if (!this.attract) this.audio.thud(e.v * 4);
        } else if (e.type === 'finish' && this.state === 'rolling') {
          this.toast(`Bottom of the hill in ${TR.fmtTime(e.time)}`);
          this.fx.sparkle(s.tire.x, s.tire.y, s.tire.z);
        } else if (e.type === 'settled' && this.state === 'rolling') {
          setTimeout(() => { if (this.state === 'rolling') this.showResults(); }, 1200);
        }
      }
      s.events.length = 0;
    }

    updateHUD() {
      const s = this.sim;
      $('hud-speed').textContent = String(Math.round(s.speed() * 3.6));
      $('hud-time').textContent = TR.fmtTime(s.rollTime);
      $('hud-dist').textContent = `${Math.round(s.distance())} m`;
      $('hud-bar').style.setProperty('--p', s.progress().toFixed(4));
      const air = s.tire.grounded <= 0 && s.airTime > 0.25;
      $('hud-air').classList.toggle('on', air);
      $('hud-air').textContent = air ? `Airborne ${s.airTime.toFixed(1)} s` : '';
    }
  }

  // course length without building the full 3D course
  TR.buildCourseLength = function (map) {
    return TR.generateLevel(map).finishX;
  };

  TR.Game = Game;
  addEventListener('DOMContentLoaded', () => {
    try {
      TR.game = new Game();
    } catch (err) {
      console.error(err);
      document.body.dataset.state = 'error';
      document.getElementById('fatal').hidden = false;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
