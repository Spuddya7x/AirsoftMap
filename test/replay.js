/* Recording a game and playing it back.
   Run with: npm run test:replay */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.TEST_PORT) || (9100 + Math.floor(Math.random() * 90));
const BASE = 'http://127.0.0.1:' + PORT;
const EXEC = process.env.CHROMIUM_PATH || undefined;
const SITE = { latitude: 51.1417, longitude: -0.9463 };
const ROOM = 'REPLAY' + Date.now().toString(36).toUpperCase();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function join(ctx, callsign, team) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); failures++; });
  await page.goto(BASE + '/?room=' + ROOM, { waitUntil: 'domcontentloaded' });
  await page.fill('#f-callsign', callsign);
  if (team) await page.click('#f-team-picker button:has-text("' + team + '")');
  await page.click('#f-go');
  await page.waitForSelector('#tools:not(.hidden)');
  return page;
}

(async () => {
  const dataDir = '/tmp/airsoftmap-replay-' + Date.now().toString(36);
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
  const opts = { permissions: ['geolocation'], geolocation: SITE, viewport: { width: 900, height: 900 } };
  const ctxA = await browser.newContext(opts);
  const ctxB = await browser.newContext(Object.assign({}, opts, {
    geolocation: { latitude: SITE.latitude + 0.0004, longitude: SITE.longitude },
  }));

  try {
    const a = await join(ctxA, 'VIPER', 'RED');
    const b = await join(ctxB, 'GHOST', 'BLUE');
    await wait(1200);

    /* --- walk them about, so there is a game to record --------------- */
    for (let i = 1; i <= 6; i++) {
      await ctxA.setGeolocation({ latitude: SITE.latitude + i * 0.00012, longitude: SITE.longitude + i * 0.00008 });
      await ctxB.setGeolocation({ latitude: SITE.latitude + 0.0004 - i * 0.00009, longitude: SITE.longitude + i * 0.00014 });
      await wait(1700);
    }

    /* a named landmark, dropped mid-game */
    a.once('dialog', (d) => d.accept('THE DONUT'));
    await a.click('.tool[data-act="marker"]');
    await a.click('.pal:has-text("POINT")');
    await wait(1200);
    check('a point of interest can be given a name',
      (await a.locator('.mk-label', { hasText: 'THE DONUT' }).count()) > 0);

    /* --- the log --------------------------------------------------- */
    const sessions = await (await fetch(BASE + '/api/room/' + ROOM + '/sessions')).json();
    check('the game shows up as one session (' + sessions.sessions.length + ')',
      sessions.sessions.length === 1);
    const session = sessions.sessions[0];
    check('it recorded both players', session.players === 2);
    check('it recorded a run of fixes (' + session.samples + ')', session.samples >= 8);
    check('it recorded the marker', session.markers >= 1);

    const data = await (await fetch(BASE + '/api/room/' + ROOM +
      '/replay?from=' + session.start + '&to=' + session.end)).json();
    check('tracks come back per player', Object.keys(data.tracks).length === 2);
    check('callsigns come back with them',
      Object.values(data.players).some((p) => p.callsign === 'VIPER') &&
      Object.values(data.players).some((p) => p.callsign === 'GHOST'));

    /* --- playback in the app ---------------------------------------- */
    await a.click('#btn-menu');
    await a.click('#btn-replay');
    await a.waitForSelector('#replaysheet:not(.hidden)');
    await wait(900);
    check('the session is listed to pick from',
      (await a.locator('#session-list li').count()) >= 1);

    await a.click('#session-list li');
    await wait(1500);
    check('playback starts', await a.evaluate(() => window.AM.replay.active()));
    check('the replay chip appears', await a.isVisible('#chip-replay'));
    check('both players are on the map as ghosts',
      await a.evaluate(() => window.AM.replay.blips.size) === 2);

    const roster = await a.evaluate(() => window.AM.replay.roster().map((r) => ({
      callsign: r.callsign, metres: Math.round(r.metres), fixes: r.fixes,
    })));
    check('the roster totals the ground each player covered (' +
      roster.map((r) => r.callsign + ' ' + r.metres + 'm').join(', ') + ')',
      roster.length === 2 && roster.every((r) => r.metres > 20 && r.fixes >= 4));

    /* scrub back to the start: the marker was dropped later, so it goes */
    await a.evaluate(() => {
      window.AM.replay.pause();
      window.AM.replay.seek(window.AM.replay.session.start);
    });
    await wait(300);
    const atStart = await a.evaluate(() => window.AM.replay.markers.size);
    await a.evaluate(() => window.AM.replay.seek(window.AM.replay.session.end));
    await wait(300);
    const atEnd = await a.evaluate(() => window.AM.replay.markers.size);
    check('intel appears at the moment it was dropped, not before (' +
      atStart + ' then ' + atEnd + ')', atStart === 0 && atEnd >= 1);

    /* positions differ across the game: the blips actually move */
    const moved = await a.evaluate(() => {
      const r = window.AM.replay;
      const id = Object.keys(r.data.tracks)[0];
      const first = r.sampleAt(r.data.tracks[id], r.session.start);
      const last = r.sampleAt(r.data.tracks[id], r.session.end);
      return window.AM.U.distance(first, last);
    });
    check('a blip is somewhere different at the end (' + Math.round(moved) + 'm)', moved > 20);

    /* interpolation lands between two fixes, not on top of one */
    const between = await a.evaluate(() => {
      const r = window.AM.replay;
      const id = Object.keys(r.data.tracks)[0];
      const track = r.data.tracks[id];
      const mid = (track[0][0] + track[1][0]) / 2;
      const s = r.sampleAt(track, mid);
      return { lat: s.lat, a: track[0][1], b: track[1][1] };
    });
    check('positions are interpolated between fixes',
      (between.lat > Math.min(between.a, between.b)) &&
      (between.lat < Math.max(between.a, between.b)));

    await a.click('#rp-exit');
    await wait(600);
    check('leaving replay returns to live',
      !(await a.evaluate(() => window.AM.replay.active())) &&
      !(await a.isVisible('#chip-replay')));

    /* live tracking still works afterwards */
    await ctxA.setGeolocation({ latitude: SITE.latitude + 0.002, longitude: SITE.longitude });
    await wait(1500);
    check('live positions resume after a replay', await a.evaluate(() => {
      const me = window.AM.state.players.get(window.AM.state.me.id);
      return !!me && me.lat > 51.1430;
    }));
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
