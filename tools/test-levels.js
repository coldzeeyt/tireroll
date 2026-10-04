// Headless physics check.
//  Mountain mode: several random releases per map all roll down, take
//  different paths and come to rest lying on their side.
//  Endless mode: the tire keeps travelling downhill for 10 simulated minutes.
// Usage: node tools/test-levels.js [rollsPerMountain]
const path = require('path');
for (const f of ['util', 'maps', 'terrain', 'sim']) require(path.join(__dirname, '..', 'js', f + '.js'));
const TR = globalThis.TR;
const rolls = +(process.argv[2] || 4);
let ok = true;
for (const map of TR.MAPS) {
  const t0 = Date.now();
  const W = TR.buildTerrain(map, 'mountain');
  const ends = [];
  const lines = [];
  for (let i = 0; i < rolls; i++) {
    const sim = new TR.Sim(W, 1000 + i * 7919);
    while (!sim.settled && sim.time < 900) sim.step(1 / 240);
    const t = sim.tire;
    if (!sim.settled) ok = false;
    ends.push([t.x, -t.z]);
    lines.push(`   roll ${i}: ${sim.settled ? 'rest' : 'STILL MOVING'} after ${sim.time.toFixed(0)}s, ${(sim.distance / 1000).toFixed(2)} km, drop ${sim.drop().toFixed(0)} m, ` +
      `top ${(sim.maxSpeed * 3.6).toFixed(0)} km/h, air ${sim.maxAir.toFixed(1)}s, jumps ${sim.jumps}, hits ${sim.hits}`);
  }
  let spread = 0;
  for (const a of ends) for (const b of ends) spread = Math.max(spread, Math.hypot(a[0] - b[0], a[1] - b[1]));
  if (spread < 20) ok = false;

  // endless
  const E = TR.buildTerrain(map, 'endless');
  const es = new TR.Sim(E, 42);
  let releases = 0;
  while (es.time < 600) {
    es.step(1 / 240);
    if (es.settled || es.stalled()) { es.rerelease(); releases++; }
  }
  const eOk = es.distance > 3000;
  if (!eOk) ok = false;
  console.log(`${map.id}: mountain spread ${spread.toFixed(0)} m | endless 10 min: ${(es.distance / 1000).toFixed(1)} km, drop ${es.drop().toFixed(0)} m, ` +
    `top ${(es.maxSpeed * 3.6).toFixed(0)} km/h, re-releases ${releases}, jumps ${es.jumps} ${eOk ? '' : 'TOO SHORT'} [${Date.now() - t0} ms]`);
  console.log(lines.join('\n'));
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
