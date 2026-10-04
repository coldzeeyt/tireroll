// Headless check: on every map the tire rolls from top to bottom on its own,
// stays inside the valley, and falls over at the end.
// Usage: node tools/test-levels.js
const path = require('path');
for (const f of ['util', 'maps', 'level', 'course', 'sim']) require(path.join(__dirname, '..', 'js', f + '.js'));
const TR = globalThis.TR;
let ok = true;
for (const map of TR.MAPS) {
  const C = TR.buildCourse(map);
  const sim = new TR.Sim(C);
  let maxU = 0, worstS = 0, stall = 0, finishT = null, settleT = null;
  while (sim.time < 400 && !sim.settled) {
    sim.step(1 / 240);
    const t = sim.tire, s = -t.z;
    const u = Math.abs(t.x - C.xc(s)) - C.hw;
    if (u > maxU) { maxU = u; worstS = s; }
    if (!sim.finished && sim.speed() < 0.5) stall += 1 / 240; else stall = 0;
    if (stall > 3) break;
    for (const e of sim.events) {
      if (e.type === 'finish') finishT = e.time;
      if (e.type === 'settled') settleT = sim.time;
    }
    sim.events.length = 0;
  }
  const pass = finishT !== null && settleT !== null && maxU < 10;
  if (!pass) ok = false;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${map.id.padEnd(8)} len=${C.finishS}m finish=${finishT ? finishT.toFixed(1) + 's' : 'no (stalled @' + (-sim.tire.z).toFixed(0) + ')'} ` +
    `settled=${settleT ? settleT.toFixed(1) + 's' : 'no'} top=${(sim.maxSpeed * 3.6).toFixed(0)}km/h air=${sim.maxAir.toFixed(2)}s jumps=${sim.jumps} ` +
    `furthestUpBank=${maxU.toFixed(1)}m@s=${worstS.toFixed(0)}`);
}
process.exit(ok ? 0 : 1);
