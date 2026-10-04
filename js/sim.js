// Tire physics on the open mountain. No player input: gravity does everything.
// No rendering here, so it also runs headless (see tools/test-levels.js).
//
// Model (real-world units, SI):
//  - The tire is a rolling disc: mass m, moment of inertia 0.75·m·r² (most of
//    the mass is in the tread and sidewalls).
//  - Ground contact uses impulses: restitution for bounces, Coulomb friction
//    couples spin to forward speed, finite lateral grip lets it skid sideways.
//  - Rolling resistance: torque crr·N·r opposing the spin.
//  - Quadratic air drag (zero on the Moon).
//  - Gyroscopic steering: a rolling wheel on a side slope leans downhill and
//    turns with yaw rate g·tan(lean)/v — the reason real tires curve downhill.
//  - Below walking pace the gyroscopic effect can no longer hold it up, so it
//    wobbles, spirals and falls flat.
//  - Tree trunks and boulders are solid.
(function (root) {
  const TR = root.TR;
  const HALF_W = 0.21;
  const MASS = 11; // kg, a car tire on a steel rim
  const DRAG_K = 0.0055; // 0.5·rho·Cd·A / m  (A ≈ 0.18 m², Cd ≈ 0.55)

  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  TR.wrapAngle = wrapAngle;

  class Sim {
    constructor(mountain, rollSeed) {
      this.mt = mountain;
      this.map = mountain.map;
      this.rollSeed = rollSeed >>> 0;
      this.events = [];
      this.time = 0;
      this.toppling = false;
      this.settled = false;
      this.airTime = 0;
      this.maxAir = 0;
      this.jumps = 0;
      this.hits = 0;
      this.maxSpeed = 0;
      this.distance = 0;
      const rng = TR.rng(this.rollSeed);
      const st = mountain.randomStart(rng);
      const r = TR.TIRE_R;
      const t = (this.tire = {
        x: st.x, y: 0, z: st.z, vx: 0, vy: 0, vz: 0,
        yaw: st.yaw, spin: 0, w: 0, lean: 0, leanV: 0, r, m: MASS, I: 0.75 * MASS * r * r,
        grounded: 0, nx: 0, ny: 1, nz: 0, impact: 0, slide: 0, yawRate: 0, squash: 0,
      });
      t.y = mountain.height(t.x, t.z) + r;
      this.startY = t.y;
      this.minY = t.y;
      t.vx = -Math.sin(t.yaw) * st.push;
      t.vz = -Math.cos(t.yaw) * st.push;
      t.w = st.push / r;
      this.fallSide = rng() < 0.5 ? -1 : 1;
      this._near = [];
    }

    // Endless mode: pick the tire back up where it lies and let it go again.
    rerelease() {
      const t = this.tire, M = this.mt;
      const rng = TR.rng(this.rollSeed + Math.floor(this.time * 1000));
      t.lean = 0; t.leanV = 0; t.squash = 0;
      // if it keeps stopping in the same place (a hollow, a tree), carry it a
      // little further down the fall line each time before letting go
      const here = Math.hypot(t.x - (this._relX || 1e9), t.z - (this._relZ || 1e9)) < 25;
      this._relN = here ? (this._relN || 0) + 1 : 0;
      t.yaw = M.fallLine(t.x, t.z) + (rng() - 0.5) * 0.4;
      const carry = this._relN * 6;
      t.x += -Math.sin(t.yaw) * carry; t.z += -Math.cos(t.yaw) * carry;
      this._relX = t.x; this._relZ = t.z;
      const push = 2 + rng() * 2 + this._relN;
      t.vx = -Math.sin(t.yaw) * push; t.vz = -Math.cos(t.yaw) * push; t.vy = 0;
      t.w = push / t.r;
      t.y = M.height(t.x, t.z) + t.r;
      this.toppling = false;
      this.settled = false;
      this.releases = (this.releases || 0) + 1;
      this._prog = undefined;
      this.restTime = this.time;
    }

    // Endless mode: true when the tire has stopped making progress downhill
    // (resting, or rocking back and forth in a hollow) for a while.
    stalled() {
      const s = -this.tire.z;
      if (this._prog === undefined || s > this._prog + 6) {
        this._prog = s;
        this._progT = this.time;
      }
      return this.time - this._progT > 20;
    }

    emit(type, data) {
      this.events.push(Object.assign({ type }, data));
    }

    centerHeight() {
      const a = Math.abs(this.tire.lean);
      return this.tire.r * Math.cos(a) + HALF_W * Math.sin(a);
    }

    speed() {
      const t = this.tire;
      return Math.hypot(t.vx, t.vy, t.vz);
    }

    drop() {
      return this.startY - this.tire.y;
    }

    step(dt) {
      const M = this.mt, t = this.tire, map = this.map, g = map.gravity;
      this.time += dt;
      if (this.settled) return;

      const speed = this.speed();
      const grounded = t.grounded > 0;
      if (!grounded) this.airTime += dt;

      // ---- integrate
      const px = t.x, pz = t.z;
      t.vy -= g * dt;
      const drag = DRAG_K * map.air * speed * dt;
      t.vx -= t.vx * drag; t.vy -= t.vy * drag; t.vz -= t.vz * drag;
      t.x += t.vx * dt; t.y += t.vy * dt; t.z += t.vz * dt;
      t.spin += t.w * dt;
      this.distance += Math.hypot(t.x - px, t.z - pz);

      // ---- ground contact
      t.impact = 0;
      let hit = false;
      let yawRate = 0;
      const ch = this.centerHeight();
      const gy = M.height(t.x, t.z);
      if (t.y - ch < gy) {
        t.y = gy + ch;
        const n = M.normalAt(t.x, t.z);
        const nx = n.x, ny = n.y, nz = n.z;
        const mu = map.friction;
        const vn = t.vx * nx + t.vy * ny + t.vz * nz;
        let jn = 0; // normal impulse per unit mass
        if (vn < 0) {
          const e = vn < -2 ? map.restitution : 0;
          jn = -(1 + e) * vn;
          t.vx += jn * nx; t.vy += jn * ny; t.vz += jn * nz;
          t.impact = -vn;
        }
        hit = true;
        t.nx = nx; t.ny = ny; t.nz = nz;

        // rolling direction on the surface, and lateral (left)
        let fx = -Math.sin(t.yaw), fy = 0, fz = -Math.cos(t.yaw);
        const fd = fx * nx + fz * nz;
        fx -= fd * nx; fy -= fd * ny; fz -= fd * nz;
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        const lx = ny * fz - nz * fy, ly = nz * fx - nx * fz, lz = nx * fy - ny * fx;
        const N = Math.max(jn, g * ny * dt);

        if (!this.toppling) {
          // lateral grip
          const vl = t.vx * lx + t.vy * ly + t.vz * lz;
          const dvl = TR.clamp(-vl, -mu * N, mu * N);
          t.vx += lx * dvl; t.vy += ly * dvl; t.vz += lz * dvl;
          t.slide = Math.abs(vl) - Math.abs(dvl);

          // friction couples spin and forward speed
          const vf = t.vx * fx + t.vy * fy + t.vz * fz;
          const k = 1 + (t.m * t.r * t.r) / t.I; // per unit mass
          const jt = (t.w * t.r - vf) / k;
          const jtc = TR.clamp(jt, -mu * N, mu * N);
          t.vx += fx * jtc; t.vy += fy * jtc; t.vz += fz * jtc;
          t.w -= (jtc * t.m * t.r) / t.I;

          // rolling resistance torque crr·N·r
          const dw = (map.crr * N * t.m * t.r) / t.I;
          t.w = Math.abs(t.w) <= dw ? 0 : t.w - Math.sign(t.w) * dw;

          // gyroscopic steering on side slopes: lean ≈ side-slope angle,
          // steady turn rate g·tan(lean)/v
          const sinSide = -ly;
          const tanSide = sinSide / Math.sqrt(Math.max(0.05, 1 - sinSide * sinSide));
          yawRate = (g * tanSide) / Math.max(2.5, Math.abs(vf)) * (vf < 0 ? -1 : 1);
          t.yaw += yawRate * dt;
        } else {
          // falling over / lying down: the tread and sidewall scrub
          const damp = Math.min(1, dt * (Math.abs(t.lean) > 1.2 ? 5 : 1.2));
          t.vx -= t.vx * damp; t.vz -= t.vz * damp;
          t.w -= t.w * damp;
        }
      }
      if (hit) t.grounded = 0.06;
      else t.grounded -= dt;

      if (hit && this.airTime > 0) {
        if (this.airTime > 0.4) {
          this.jumps++;
          this.maxAir = Math.max(this.maxAir, this.airTime);
          this.emit('air', { time: this.airTime });
        }
        this.airTime = 0;
      }
      if (t.impact > 2) {
        t.squash = Math.min(0.2, t.squash + t.impact * 0.012);
        this.emit('land', { v: t.impact, x: t.x, y: t.y - ch, z: t.z });
      }
      t.squash *= Math.exp(-dt * 9);

      this.collide(t);

      // ---- lean: matches the turn while rolling; falls over when too slow
      const sp = this.speed();
      if (!this.toppling) {
        const leanTarget = TR.clamp(Math.atan((yawRate * Math.min(sp, 40)) / g), -0.7, 0.7);
        t.lean += (leanTarget - t.lean) * Math.min(1, dt * 5);
        if (this.time - (this.restTime || 0) > 2 && sp < 1.4 && grounded) {
          this.toppling = true;
          t.leanV = this.fallSide * 0.2 + t.lean;
          this.emit('topple', {});
        }
      } else {
        const a = t.lean;
        if (Math.abs(a) < Math.PI / 2) {
          // inverted pendulum about the contact patch
          t.leanV += ((g / (t.r * 1.4)) * Math.sin(a) + this.fallSide * 0.05) * dt;
          t.leanV *= 1 - 0.4 * dt;
          t.yaw += a * Math.min(6, Math.abs(t.w)) * 0.3 * dt; // spiral while going down
        }
        t.lean += t.leanV * dt;
        const flat = Math.PI / 2;
        if (Math.abs(t.lean) >= flat) {
          t.lean = Math.sign(t.lean) * flat;
          if (Math.abs(t.leanV) > 0.6) {
            this.emit('thud', { v: Math.abs(t.leanV), x: t.x, y: t.y, z: t.z });
            t.leanV *= -0.3;
          } else t.leanV = 0;
        }
        if (Math.abs(t.lean) >= flat - 1e-3 && t.leanV === 0 && Math.hypot(t.vx, t.vz) < 0.1) {
          this.settled = true;
          this.emit('settled', {});
        }
      }
      t.yawRate = yawRate;
      if (!this.toppling) this.maxSpeed = Math.max(this.maxSpeed, sp);
      this.minY = Math.min(this.minY, t.y);
    }

    // trunks are vertical cylinders, boulders are spheres
    collide(t) {
      const near = this.mt.nearObstacles(t.x, t.z, this._near);
      for (const o of near) {
        let dx = t.x - o.x, dy = 0, dz = t.z - o.z;
        let rr;
        if (o.type === 'trunk') {
          if (t.y - t.r > o.y + o.h) continue;
          rr = o.r + HALF_W + 0.05;
        } else {
          dy = t.y - o.y;
          rr = o.r + t.r * 0.8;
        }
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-4;
        dx /= d; dy /= d; dz /= d;
        t.x = o.x + dx * rr; t.z = o.z + dz * rr;
        if (o.type === 'rock') t.y = o.y + dy * rr;
        const vn = t.vx * dx + t.vy * dy + t.vz * dz;
        if (vn < 0) {
          const e = o.type === 'trunk' ? 0.3 : 0.4;
          t.vx -= (1 + e) * vn * dx; t.vy -= (1 + e) * vn * dy; t.vz -= (1 + e) * vn * dz;
          // the impact also knocks the heading toward the new direction of travel
          const sp = Math.hypot(t.vx, t.vz);
          if (sp > 0.5) t.yaw = Math.atan2(-t.vx, -t.vz);
          t.w = Math.sign(t.w) * Math.min(Math.abs(t.w), sp / t.r);
          if (-vn > 1.5) {
            this.hits++;
            this.emit('hit', { v: -vn, kind: o.type, x: t.x - dx * t.r, y: t.y, z: t.z - dz * t.r });
          }
        }
      }
    }
  }

  TR.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
