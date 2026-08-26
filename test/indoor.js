/* Tests for the no-signal features: station check-ins, dead reckoning from
   synthetic motion events, team-only visibility, and site plans.
   Run with: npm run test:indoor */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.TEST_PORT) || (8700 + Math.floor(Math.random() * 200));
const BASE = 'http://127.0.0.1:' + PORT;
const EXEC = process.env.CHROMIUM_PATH || undefined;
const SITE = { latitude: 51.1417, longitude: -0.9463 };
const ROOM = 'DEEP' + Date.now().toString(36).toUpperCase();

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

async function join(ctx, callsign, room, team, role) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); failures++; });
  await page.goto(BASE + '/?room=' + room, { waitUntil: 'domcontentloaded' });
  await page.fill('#f-callsign', callsign);
  if (team) await page.click('#f-team-picker button:has-text("' + team + '")');
  if (role) await page.selectOption('#f-role', role);
  await page.click('#f-go');
  await page.waitForSelector('#tools:not(.hidden)', { timeout: 10000 });
  await wait(800);
  return page;
}

/* Walk the phone: a sine wave on the accelerometer is a stream of steps. */
async function walk(page, steps, headingDeg) {
  await page.evaluate(async ({ steps, headingDeg }) => {
    const SAMPLE_MS = 20;
    const STEP_MS = 320;
    const samples = Math.round(STEP_MS / SAMPLE_MS);
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', {
      alpha: (360 - headingDeg) % 360, beta: 0, gamma: 0, absolute: true,
    }));
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < samples; i++) {
        const phase = (i / samples) * Math.PI * 2;
        const mag = 9.81 + 3.2 * Math.sin(phase);
        window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
          accelerationIncludingGravity: { x: 0, y: 0, z: mag },
        }));
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
      }
    }
  }, { steps, headingDeg });
}

/* Answer a run of window.prompt() calls in order. */
function answerPrompts(page, answers) {
  const queue = answers.slice();
  const handler = (d) => d.accept(queue.length ? queue.shift() : '');
  page.on('dialog', handler);
  return () => page.off('dialog', handler);
}

const myFix = (page) => page.evaluate(() => {
  const s = window.AM.state;
  return { fix: s.nav.fix, dr: s.nav.drDistance, steps: window.AM.pdr ? window.AM.pdr.steps : 0 };
});

(async () => {
  const dataDir = '/tmp/airsoftmap-indoor-' + Date.now().toString(36);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  server.on('exit', (code) => {
    if (code) { console.error('server exited with code ' + code); process.exit(1); }
  });
  await waitForServer(10000);

  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const opts = {
    permissions: ['geolocation'], geolocation: SITE,
    viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true,
  };
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(opts);
  const ctxM = await browser.newContext(opts);

  try {
    const a = await join(ctxA, 'DIGGER', ROOM, 'RED');

    /* --- indoor mode ignores GPS entirely --------------------------- */
    await a.click('#btn-menu');
    await a.click('#posmode-buttons button:has-text("INDOOR")');
    await a.click('#settings [data-close]');
    await wait(300);

    let st = await myFix(a);
    const beforeMove = st.fix;
    await ctxA.setGeolocation({ latitude: SITE.latitude + 0.002, longitude: SITE.longitude });
    await wait(1800);
    st = await myFix(a);
    check('indoor mode ignores satellite fixes',
      !st.fix || !beforeMove || st.fix.lat === beforeMove.lat);

    /* --- stations --------------------------------------------------- */
    await a.click('.tool[data-act="fix"]');
    await a.waitForSelector('#stationsheet:not(.hidden)');
    check('station list explains itself when empty',
      /No stations yet/.test(await a.textContent('#station-list')));

    let done = answerPrompts(a, ['J1', 'Bottom of the shaft']);
    await a.click('#btn-station-new');
    await wait(1200);
    done();
    check('station appears on the map',
      (await a.locator('.mk-label', { hasText: 'J1' }).count()) > 0);

    await a.click('.station-list li:has-text("J1")');
    await wait(500);
    st = await myFix(a);
    check('checking in gives a position with a small error',
      !!st.fix && st.fix.src === 'anchor' && st.fix.acc <= 6);
    const start = st.fix;

    /* --- dead reckoning --------------------------------------------- */
    await a.click('#btn-menu');
    await a.click('#btn-pdr-enable');
    await a.click('#settings [data-close]');
    await wait(300);

    await walk(a, 22, 90);   // 22 steps due east
    await wait(400);
    st = await myFix(a);

    check('steps are detected from motion (' + st.steps + ' counted)', st.steps >= 15);
    const moved = await a.evaluate(([from, to]) => window.AM.U.distance(from, to),
      [start, st.fix]);
    const bearing = await a.evaluate(([from, to]) => window.AM.U.bearing(from, to),
      [start, st.fix]);
    check('the blip moved a plausible distance (' + Math.round(moved) + 'm for ' + st.steps + ' steps)',
      moved > 5 && moved < 45);
    check('it moved in the direction the phone was pointing (' + Math.round(bearing) + ' deg)',
      Math.abs(bearing - 90) < 25);
    check('dead reckoning is flagged as such', st.fix.src === 'dr');
    check('uncertainty grew with the distance walked (' + Math.round(st.fix.acc) + 'm)',
      st.fix.acc > 6 && st.fix.acc < 60);

    /* --- a second check-in collapses the error ---------------------- */
    done = answerPrompts(a, ['J2', 'Pump room door']);
    await a.click('.tool[data-act="fix"]');
    await a.waitForSelector('#stationsheet:not(.hidden)');
    await a.click('#btn-station-new');
    await wait(1200);
    done();
    await a.click('.tool[data-act="fix"]');
    await a.click('.station-list li:has-text("J2")');
    await wait(500);
    st = await myFix(a);
    check('checking in again resets the drift',
      st.fix.src === 'anchor' && st.fix.acc <= 6 && st.dr === 0);

    /* --- the printable tag sheet ------------------------------------ */
    const print = await ctxA.newPage();
    await print.goto(BASE + '/print.html?room=' + ROOM);
    await wait(900);
    check('station tag sheet renders a QR code per station',
      (await print.locator('.tag-card img').count()) >= 2);
    check('tag sheet shows the station codes',
      /J1/.test(await print.textContent('#tags')) && /J2/.test(await print.textContent('#tags')));
    await print.close();

    /* --- team-only visibility ---------------------------------------- */
    const b = await join(ctxB, 'BLUEBOY', ROOM, 'BLUE');
    const marshal = await join(ctxM, 'CONTROL', ROOM, 'GOLD', 'MARSHAL');
    await wait(1200);
    check('with team lock off, the other team is visible',
      (await b.locator('.mk-label', { hasText: 'DIGGER' }).count()) > 0);

    await a.click('#btn-menu');
    await a.click('#opt-teamlock');
    await a.click('#settings [data-close]');
    await wait(1500);

    check('team lock hides the other team',
      (await b.locator('.mk-label', { hasText: 'DIGGER' }).count()) === 0);
    check('team lock hides the other team from the roster',
      !/DIGGER/.test(await b.textContent('#roster-list')));
    check('marshals still see everyone',
      (await marshal.locator('.mk-label', { hasText: 'DIGGER' }).count()) > 0);
    check('station markers stay visible to everyone (site safety info)',
      (await b.locator('.mk-label', { hasText: 'J1' }).count()) > 0);

    /* tactical markers made under team lock stay with the team */
    await a.click('.tool[data-act="marker"]');
    await a.click('.pal:has-text("CONTACT")');
    await wait(1200);
    check('a tactical marker is not shared with the other team',
      (await b.locator('.mk-label', { hasText: 'CONTACT' }).count()) === 0);
    check('the marshal sees the tactical marker',
      (await marshal.locator('.mk-label', { hasText: 'CONTACT' }).count()) > 0);

    /* --- site plan ---------------------------------------------------- */
    const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'));
    const res = await fetch(BASE + '/api/room/' + ROOM + '/plan?lat=' + SITE.latitude +
      '&lng=' + SITE.longitude + '&widthM=120&aspect=1&name=TUNNELS', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
    });
    const planBody = await res.json();
    check('a site plan can be uploaded', res.ok && !!planBody.plan && planBody.plan.widthM === 120);
    await wait(1200);
    check('the site plan appears for players', (await a.locator('img.site-plan-image').count()) > 0);
    check('the plan image is served back', (await (await fetch(BASE + planBody.plan.url)).status) === 200);

    /* --- crosshair aiming -------------------------------------------- */
    check('the crosshair is on screen', await a.isVisible('#crosshair'));

    /* One finger drags the reticle; the map itself must not move. */
    const dragged = await a.evaluate(async () => {
      const box = window.AM.map.getContainer();
      const centreBefore = window.AM.map.getCenter();
      const touch = (x, y) => [new Touch({ identifier: 1, target: box, clientX: x, clientY: y })];
      const fire = (type, list) => box.dispatchEvent(
        new TouchEvent(type, { touches: list, targetTouches: list, changedTouches: list, bubbles: true, cancelable: true })
      );
      fire('touchstart', touch(200, 600));
      await new Promise((r) => setTimeout(r, 30));
      fire('touchmove', touch(120, 400));
      await new Promise((r) => setTimeout(r, 30));
      fire('touchmove', touch(118, 398));
      await new Promise((r) => setTimeout(r, 30));
      fire('touchend', []);
      const node = document.getElementById('crosshair');
      const centreAfter = window.AM.map.getCenter();
      return {
        left: parseFloat(node.style.left),
        top: parseFloat(node.style.top),
        panned: Math.abs(centreAfter.lat - centreBefore.lat) + Math.abs(centreAfter.lng - centreBefore.lng),
        readout: document.getElementById('aim-readout').textContent,
      };
    });
    check('one finger drags the crosshair (' + dragged.left + ',' + dragged.top + ')',
      Math.abs(dragged.left - 118) < 3 && Math.abs(dragged.top - (398 - 64)) < 3);
    check('dragging the crosshair does not pan the map', dragged.panned < 1e-9);
    check('the crosshair reads out range and bearing (' + dragged.readout + ')',
      /\d/.test(dragged.readout));

    /* Two fingers still move the map, which is the other half of the deal. */
    const panned = await a.evaluate(async () => {
      const box = window.AM.map.getContainer();
      const before = window.AM.map.getCenter();
      const t = (id, x, y) => new Touch({ identifier: id, target: box, clientX: x, clientY: y });
      const fire = (type, list) => box.dispatchEvent(new TouchEvent(type, {
        touches: list, targetTouches: list, changedTouches: list, bubbles: true, cancelable: true,
      }));
      fire('touchstart', [t(1, 150, 400), t(2, 250, 500)]);
      await new Promise((r) => setTimeout(r, 40));
      for (let i = 1; i <= 5; i++) {
        fire('touchmove', [t(1, 150, 400 - i * 20), t(2, 250, 500 - i * 20)]);
        await new Promise((r) => setTimeout(r, 40));
      }
      fire('touchend', []);
      await new Promise((r) => setTimeout(r, 300));
      const after = window.AM.map.getCenter();
      return window.AM.map.distance(before, after);
    });
    check('two fingers pan the map (' + Math.round(panned) + 'm)', panned > 5);

    /* Anything dropped lands under the crosshair, not at the screen centre. */
    await a.click('.tool[data-act="marker"]');
    await a.click('.pal:has-text("RALLY")');
    await wait(1000);
    const placed = await a.evaluate(() => {
      const rally = [...window.AM.state.markers.values()].map((r) => r.data)
        .filter((m) => m.kind === 'rally').pop();
      const aimed = window.AM.map.containerPointToLatLng(window.L.point(118, 398 - 64));
      return rally ? window.AM.U.distance(rally, aimed) : null;
    });
    check('a dropped marker lands under the crosshair (' +
      (placed == null ? 'missing' : Math.round(placed) + 'm off') + ')',
      placed != null && placed < 2);
  } catch (err) {
    console.error('  ERROR ', err.stack || err.message);
    failures++;
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
