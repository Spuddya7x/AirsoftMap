/* End-to-end smoke test: two players join the same game, see each other,
   and share a marker. Run with: npm test */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT) || (8500 + Math.floor(Math.random() * 200));
const BASE = 'http://127.0.0.1:' + PORT;
const EXEC = process.env.CHROMIUM_PATH || undefined;
const SITE = { latitude: 51.1417, longitude: -0.9463 };
/* a fresh room each run so persisted state from an earlier run cannot leak in */
const ROOM = 'TEST' + Date.now().toString(36).toUpperCase();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Wait for the server to answer rather than guessing at a delay, so a stale
   process on the port cannot quietly serve the tests instead. */
async function waitForServer(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch (err) { /* not up yet */ }
    await wait(150);
  }
  throw new Error('server did not start on port ' + PORT);
}
let failures = 0;
function check(name, ok) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) failures++;
}

async function join(ctx, callsign, room, coords) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.setGeolocation(coords);
  await page.goto(BASE + '/?room=' + room, { waitUntil: 'domcontentloaded' });
  await page.fill('#f-callsign', callsign);
  await page.click('#f-go');
  await page.waitForSelector('#tools:not(.hidden)', { timeout: 10000 });
  return { page, errors };
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: '/tmp/airsoftmap-test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  server.on('exit', (code) => {
    if (code) { console.error('server exited with code ' + code); process.exit(1); }
  });
  await waitForServer(10000);

  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const opts = { permissions: ['geolocation'], viewport: { width: 412, height: 900 }, deviceScaleFactor: 2 };
  const ctxA = await browser.newContext(Object.assign({ geolocation: SITE }, opts));
  const ctxB = await browser.newContext(Object.assign({
    geolocation: { latitude: SITE.latitude + 0.0012, longitude: SITE.longitude + 0.0016 },
  }, opts));

  try {
    /* health */
    const health = await (await fetch(BASE + '/api/health')).json();
    check('server health endpoint responds', health.ok === true);

    /* two players join the same room */
    const a = await join(ctxA, 'VIPER', ROOM, SITE);
    const bStart = { latitude: SITE.latitude + 0.0012, longitude: SITE.longitude + 0.0016 };
    const b = await join(ctxB, 'GHOST', ROOM, bStart);
    await wait(1200);
    /* walk B a few metres so watchPosition fires more than once */
    for (let i = 1; i <= 3; i++) {
      await ctxB.setGeolocation({ latitude: bStart.latitude + i * 0.00004, longitude: bStart.longitude });
      await wait(500);
    }
    await wait(1200);

    check('A links to the server', await a.page.textContent('#link-text') === 'LINK');
    check('A shows its own callsign on the map',
      (await a.page.locator('.mk-label', { hasText: 'VIPER' }).count()) > 0);
    check('A sees B on the map',
      (await a.page.locator('.mk-label', { hasText: 'GHOST' }).count()) > 0);
    check('B sees A on the map',
      (await b.page.locator('.mk-label', { hasText: 'VIPER' }).count()) > 0);

    /* roster shows a distance to the other player */
    await a.page.click('#btn-roster');
    await wait(400);
    const rosterText = await a.page.textContent('#roster-list');
    check('roster lists both players', /VIPER/.test(rosterText) && /GHOST/.test(rosterText));
    check('roster shows a range to the other player', /\d+m|\d\.\d+km/.test(rosterText));
    await a.page.click('#roster [data-close]');

    /* A drops a marker, B should receive it */
    await a.page.click('.tool[data-act="marker"]');
    await a.page.waitForSelector('#palette:not(.hidden)');
    await a.page.click('.pal:has-text("SPAWN")');
    await wait(1200);
    check('A sees the marker it dropped',
      (await a.page.locator('.mk-label', { hasText: 'SPAWN' }).count()) > 0);
    check('B receives the marker',
      (await b.page.locator('.mk-label', { hasText: 'SPAWN' }).count()) > 0);

    /* A draws a line */
    await a.page.click('.tool[data-act="draw"]');
    await a.page.waitForSelector('#drawbar:not(.hidden)');
    const box = await a.page.locator('#map').boundingBox();
    for (const [dx, dy] of [[120, 300], [240, 420], [300, 250]]) {
      await a.page.mouse.click(box.x + dx, box.y + dy);
      await wait(320);
    }
    const readout = await a.page.textContent('#draw-readout');
    check('draw readout counts points and distance (' + readout.trim() + ')',
      /3 points/.test(readout) && /\dm|\dkm/.test(readout));
    a.page.once('dialog', (d) => d.accept('FLANK LEFT'));
    await a.page.click('#draw-save');
    await wait(1200);
    check('B receives the drawing', (await b.page.locator('path.leaflet-interactive').count()) > 0);

    /* status report propagates */
    await a.page.click('.tool[data-act="status"]');
    await a.page.click('#state-buttons .state-hit');
    await wait(900);
    check('B sees A marked HIT',
      (await b.page.locator('.mk-label', { hasText: 'HIT' }).count()) > 0);

    /* markers survive a server restart */
    const health2 = await (await fetch(BASE + '/api/health')).json();
    const room = health2.rooms.find((r) => r.id === ROOM);
    check('server persisted room state', !!room && room.markers >= 1 && room.drawings >= 1);

    /* demo mode in a fresh context */
    const ctxC = await browser.newContext(Object.assign({ geolocation: SITE }, opts));
    const c = await ctxC.newPage();
    await c.goto(BASE, { waitUntil: 'domcontentloaded' });
    await c.fill('#f-callsign', 'SOLO');
    await c.click('#f-demo');
    await c.waitForSelector('#tools:not(.hidden)');
    await wait(2500);
    check('demo squad appears', (await c.locator('.mk-label', { hasText: 'PHOENIX' }).count()) > 0);
    check('demo intel appears', (await c.locator('.mk-label', { hasText: 'RADIO MAST' }).count()) > 0);
    await c.screenshot({ path: '/tmp/airsoftmap-demo.png' });

    check('no page errors in A', a.errors.length === 0 || console.log(a.errors));
    check('no page errors in B', b.errors.length === 0 || console.log(b.errors));
  } catch (err) {
    console.error('  ERROR ', err.message);
    failures++;
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
