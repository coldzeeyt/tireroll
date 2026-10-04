// 3D tire physics. No player input: gravity does everything. No rendering here
// so it also runs headless (see tools/test-levels.js).
//
// The tire is an upright rolling disc with a heading (yaw), a spin rate coupled
// to the ground by Coulomb friction, finite lateral grip, and gyroscopic
// "lean steering": on banked ground it leans and turns downhill, which is what
// keeps a real rolling tire in a valley. When it finally slows down it wobbles,
// spirals and falls over onto its side.
(function (root) {
  const TR = root.TR;

  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  TR.wrapAngle = wrapAngle;

  const HALF_W = 0.21; // tire half width

  class Sim {
    constructor(course) {
      this.course = course;
      this.map = course.map;
      this.events = [];
      this.time = 0;
      this.rollTime = 0;
      this.finished = false;
      this.toppling = false;
      this.settled = false;
      this.airTime = 0;
      this.maxAir = 0;
      this.totalAir = 0;
      this.jumps = 0;
      this.maxSpeed = 0;
      this.maxDrop = 0;
      const r = TR.TIRE_R;
      const s0 = course.startS;
      this.tire = {
        x: course.xc(s0), y: 0, z: -s0, vx: 0, vy: 0, vz: 0,
        yaw: course.heading(s0), spin: 0, w: 0, lean: 0, leanV: 0, r, m: 1, I: 0.75 * r * r,
        grounded: 0, nx: 0, ny: 1, nz: 0, impact: 0, slide: 0, slip: 0, yawRate: 0, squash: 0,
      };
      const t = this.tire;
      t.y = course.terrain(t.x, t.z) + r;
      this.startY = t.y;
      // a gentle nudge over the ledge
      const v0 = 2.5;
      t.vx = -Math.sin(t.yaw) * v0; t.vz = -Math.cos(t.yaw) * v0; t.w = v0 / r;
      this.wobbleSeed = (course.map.seed % 2) ? 1 : -1;
    }

    emit(type, data) {
      this.events.push(Object.assign({ type }, data));
    }

    // Height of the tire center above the contact point for the current lean.
    centerHeight() {
      const a = Math.abs(this.tire.lean);
      return this.tire.r * Math.cos(a) + HALF_W * Math.sin(a);
    }

    step(dt) {
      const C = this.course, t = this.tire, g = this.map.gravity;
      this.time += dt;
      if (!this.finished) this.rollTime += dt;
      if (this.settled) return;

      const speed = Math.hypot(t.vx, t.vy, t.vz);
      const grounded = t.grounded > 0;
      if (!grounded) {
        this.airTime += dt;
      }

      // ---- integrate
      t.vy -= g * dt;
      const drag = 0.0025 * speed * dt;
      t.vx -= t.vx * drag; t.vy -= t.vy * drag; t.vz -= t.vz * drag;
      t.x += t.vx * dt; t.y += t.vy * dt; t.z += t.vz * dt;
      t.spin += t.w * dt;

      // ---- ground contact
      t.impact = 0;
      let hit = false;
      const ch = this.centerHeight();
      const gy = C.terrain(t.x, t.z);
      let yawRate = 0;
      if (t.y - ch < gy) {
        t.y = gy + ch;
        const n = C.normalAt(t.x, t.z);
        const nx = n.x, ny = n.y, nz = n.z;
        const mu = this.map.friction;
        const vn = t.vx * nx + t.vy * ny + t.vz * nz;
        let jn = 0;
        if (vn < 0) {
          const e = vn < -4 ? this.map.restitution : 0;
          jn = -(1 + e) * vn;
          t.vx += jn * nx; t.vy += jn * ny; t.vz += jn * nz;
          t.impact = -vn;
        }
        hit = true;
        t.nx = nx; t.ny = ny; t.nz = nz;

        // forward direction on the surface, and lateral (left)
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
          const gripMax = mu * N * 1.5;
          const dvl = TR.clamp(-vl, -gripMax, gripMax);
          t.vx += lx * dvl; t.vy += ly * dvl; t.vz += lz * dvl;
          t.slide = Math.abs(vl) - Math.abs(dvl);

          // rolling: friction couples spin and forward speed
          const vf = t.vx * fx + t.vy * fy + t.vz * fz;
          const k = 1 / t.m + (t.r * t.r) / t.I;
          const jt = (t.w * t.r - vf) / k;
          const jtc = TR.clamp(jt, -mu * N, mu * N);
          t.vx += fx * jtc; t.vy += fy * jtc; t.vz += fz * jtc;
          t.w -= (jtc * t.r) / t.I;
          t.slip = Math.abs(jt - jtc) * k;

          // gyroscopic lean-steering: on a side slope the tire leans and turns downhill
          const gLat = -g * ly;
          yawRate = (gLat * 4) / Math.max(5, Math.abs(vf)) * (vf < 0 ? -1 : 1);
          // slight self-centering toward the direction of travel
          if (speed > 1) {
            const vh = Math.atan2(-t.vx, -t.vz);
            yawRate += wrapAngle(vh - t.yaw) * 2.0;
          }
          t.yaw += yawRate * dt;
          // rolling resistance; the grass run-out after the finish is soft
          t.w *= 1 - (this.finished ? 0.45 : 0.035) * dt;
        } else {
          // lying down / falling over: heavy friction scrubs everything
          const damp = Math.min(1, dt * (Math.abs(t.lean) > 1.2 ? 6 : 1.2));
          t.vx -= t.vx * damp; t.vz -= t.vz * damp;
          t.w -= t.w * damp;
        }
      }
      if (hit) t.grounded = 0.08;
      else t.grounded -= dt;

      if (hit && this.airTime > 0) {
        if (this.airTime > 0.45) {
          this.jumps++;
          this.totalAir += this.airTime;
          this.maxAir = Math.max(this.maxAir, this.airTime);
          this.emit('air', { time: this.airTime, x: t.x, y: t.y, z: t.z });
        }
        this.airTime = 0;
      }
      if (t.impact > 2.5) {
        t.squash = Math.min(0.22, t.squash + t.impact * 0.012);
        this.emit('land', { v: t.impact, x: t.x, y: t.y - ch, z: t.z });
      }
      t.squash *= Math.exp(-dt * 9);

      // ---- lean: follows the turn while rolling, falls over when slow
      if (!this.toppling) {
        const leanTarget = TR.clamp((yawRate * Math.min(speed, 40)) / g, -0.5, 0.5);
        t.lean += (leanTarget - t.lean) * Math.min(1, dt * 6);
        // start falling over once the race is done and it has slowed right down
        if (this.finished && speed < 2.6 && grounded) {
          this.toppling = true;
          t.leanV = this.wobbleSeed * 0.25 + t.lean;
          this.emit('topple', {});
        }
      } else {
        // inverted pendulum: gravity tips it further; the spinning tire
        // precesses (spirals) while it goes down.
        const a = t.lean;
        if (Math.abs(a) < Math.PI / 2) {
          t.leanV += (g / (t.r * 1.4)) * Math.sin(a) * dt * 0.55;
          t.leanV *= 1 - 0.5 * dt;
          t.yaw += a * Math.min(6, Math.abs(t.w)) * 0.35 * dt;
        }
        t.lean += t.leanV * dt;
        const flat = Math.PI / 2;
        if (Math.abs(t.lean) >= flat) {
          t.lean = Math.sign(t.lean) * flat;
          if (Math.abs(t.leanV) > 0.6) {
            this.emit('thud', { v: Math.abs(t.leanV), x: t.x, y: t.y, z: t.z });
            t.leanV *= -0.32;
          } else {
            t.leanV = 0;
          }
        }
        if (Math.abs(t.lean) >= flat - 1e-3 && t.leanV === 0 && Math.hypot(t.vx, t.vz) < 0.15 && !this.settled) {
          this.settled = true;
          this.emit('settled', {});
        }
      }
      t.yawRate = yawRate;

      // ---- progress
      const s = -t.z;
      if (!this.finished && s >= C.finishS) {
        this.finished = true;
        this.emit('finish', { time: this.rollTime });
      }
      // safety: never leave the world
      if (s > C.endS - 3) { t.z = -(C.endS - 3); t.vz = Math.max(0, t.vz); }
      if (t.y < C.terrain(t.x, t.z) - 3) t.y = C.terrain(t.x, t.z) + ch;

      if (!this.finished) {
        this.maxSpeed = Math.max(this.maxSpeed, speed);
        this.maxDrop = Math.max(this.maxDrop, this.startY - t.y);
      }
    }

    distance() {
      return Math.max(0, -this.tire.z - this.course.startS);
    }
    progress() {
      return TR.clamp(-this.tire.z / this.course.finishS, 0, 1);
    }
    speed() {
      const t = this.tire;
      return Math.hypot(t.vx, t.vy, t.vz);
    }
  }

  TR.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
