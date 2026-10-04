// node tools/screenshot.js <url> <out.png> [waitMs] [clickSelector]
// Takes a screenshot of the game in headless Chromium (software WebGL).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const [url, out, wait = '4000', click] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  if (click) { await page.waitForTimeout(1500); for (const sel of click.split(',')) { await page.click(sel); await page.waitForTimeout(400); } }
  await page.waitForTimeout(+wait);
  await page.screenshot({ path: out });
  console.log(logs.filter((l) => !l.includes('GPU stall')).slice(0, 20).join('\n'));
  await browser.close();
})();
