// node tools/trace.js <mapId> <s0> <s1> — print tire state along a stretch
const path = require('path');
for (const f of ['util', 'maps', 'level', 'course', 'sim']) require(path.join(__dirname, '..', 'js', f + '.js'));
const TR = globalThis.TR;
const [id, a, b] = process.argv.slice(2);
const C = TR.buildCourse(TR.MAPS.find((m) => m.id === id));
const sim = new TR.Sim(C);
let i = 0;
while (sim.time < 300 && !sim.settled) {
  sim.step(1 / 240); i++;
  const t = sim.tire, s = -t.z;
  if (s >= +a && s <= +b && i % 24 === 0) {
    const u = t.x - C.xc(s);
    console.log(`s=${s.toFixed(0)} u=${u.toFixed(1)} spd=${sim.speed().toFixed(1)} yawErr=${TR.wrapAngle(t.yaw - C.heading(s)).toFixed(2)} trackHead=${C.heading(s).toFixed(2)} air=${t.grounded > 0 ? 0 : 1} hAbove=${(t.y - t.r - C.terrain(t.x, t.z)).toFixed(1)}`);
  }
  if (s > +b) break;
}
