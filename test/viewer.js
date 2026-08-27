/* The 3D site viewer, and the LIDAR pipeline that feeds it.
   Run with: npm run test:viewer */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { bngToWgs84, wgs84ToBng } = require('../scripts/lib/bng.js');
const { readElevation } = require('../scripts/lib/geotiff.js');

const PORT = Number(process.env.TEST_PORT) || (9300 + Math.floor(Math.random() * 90));
const BASE = 'http://127.0.0.1:' + PORT;
const EXEC = process.env.CHROMIUM_PATH || undefined;
const ROOM = 'VIEW' + Date.now().toString(36).toUpperCase();
const SITE = 'green-wood';

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

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ *
 * The parts that need no browser
 * ------------------------------------------------------------------ */

function testProjection() {
  console.log('\nBritish National Grid');

  /* A published control point: the Ordnance Survey pillar at Caister
     water tower, TG 51409 13177, is 52.6588 N 1.7160 E. Five metres is
     the documented accuracy of a Helmert shift, and is far finer than
     anything this is used for. */
  const ll = bngToWgs84(651409, 313177);
  check('a known grid reference lands in the right place',
    near(ll.lat, 52.6588, 0.002) && near(ll.lng, 1.7160, 0.002));

  let worst = 0;
  for (const [lat, lng] of [[50.9673, 0.3279], [51.5, -0.12], [54.97, -1.61]]) {
    const grid = wgs84ToBng(lat, lng);
    const back = bngToWgs84(grid.E, grid.N);
    worst = Math.max(worst, Math.hypot((back.lat - lat) * 111320,
      (back.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180)));
  }
  check('it round-trips to under a millimetre (' + (worst * 1000).toFixed(2) + ' mm)',
    worst < 0.001);
}

function testSiteData() {
  console.log('\nThe built site model');
  const dir = path.join(__dirname, '..', 'public', 'data');
  const site = JSON.parse(fs.readFileSync(path.join(dir, SITE + '.site.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, SITE + '.heights.bin'));
  const heights = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const g = site.grid;

  check('the height grid matches the declared size',
    heights.length === g.width * g.height);
  check('heights start at zero and reach the stated fall',
    Math.min(...heights) === 0
      && near(Math.max(...heights) / 100, g.max - g.min, 0.02));
  check('every tree is inside the tile', site.trees.every((t) =>
    t.x >= 0 && t.x <= g.width * g.pixel && t.y >= 0 && t.y <= g.height * g.pixel));
  check('every tree has a plausible height (' + site.trees.length + ' of them)',
    site.trees.length > 0 && site.trees.every((t) => t.h >= 6 && t.h <= 60));

  /* The viewer places things by latitude and longitude but draws in
     grid metres, using the derivatives shipped in the file rather than
     the whole projection. That shortcut has to hold across the tile. */
  const f = site.frame;
  const affine = (lat, lng) => ({
    E: f.E + (lat - f.lat) * f.dEdLat + (lng - f.lng) * f.dEdLng,
    N: f.N + (lat - f.lat) * f.dNdLat + (lng - f.lng) * f.dNdLng,
  });
  let drift = 0;
  for (const [lng, lat] of site.outline) {
    const a = affine(lat, lng);
    const b = wgs84ToBng(lat, lng);
    drift = Math.max(drift, Math.hypot(a.E - b.E, a.N - b.N));
  }
  check('the shipped frame matches the real projection at every corner ('
    + (drift * 1000).toFixed(1) + ' mm)', drift < 0.05);
}

function testGeoTiff() {
  console.log('\nGeoTIFF reader');
  /* Hand-built, so the test does not need the network: one strip of
     float32 samples with a tiepoint and a scale. */
  const W = 4;
  const H = 3;
  const tags = [
    [256, 3, 1, W], [257, 3, 1, H], [258, 3, 1, 32], [259, 3, 1, 1],
    [277, 3, 1, 1], [339, 3, 1, 3], [278, 3, 1, H],
  ];
  const headerLen = 8 + 2 + (tags.length + 3) * 12 + 4;
  const scaleAt = headerLen;
  const tieAt = scaleAt + 24;
  const pixelAt = tieAt + 48;
  const buf = Buffer.alloc(pixelAt + W * H * 4);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  const all = tags.concat([[33550, 12, 3, scaleAt], [33922, 12, 6, tieAt],
    [273, 4, 1, pixelAt]]).sort((a, b) => a[0] - b[0]);
  buf.writeUInt16LE(all.length, 8);
  all.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    buf.writeUInt16LE(tag, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(count, at + 4);
    buf.writeUInt32LE(value, at + 8);
  });
  [2, 2, 0].forEach((v, i) => buf.writeDoubleLE(v, scaleAt + i * 8));
  [0, 0, 0, 1000, 5000, 0].forEach((v, i) => buf.writeDoubleLE(v, tieAt + i * 8));
  for (let i = 0; i < W * H; i++) buf.writeFloatLE(10 + i, pixelAt + i * 4);

  const got = readElevation(buf);
  check('it reads the grid size', got.width === W && got.height === H);
  check('it reads the samples in row order',
    got.grid[0] === 10 && got.grid[W * H - 1] === 10 + W * H - 1);
  check('it reads tiepoint georeferencing',
    got.originE === 1000 && got.originN === 5000 && got.pixel === 2);
  check('a compressed file is refused rather than misread', (() => {
    const bad = Buffer.from(buf);
    /* Flip the compression tag to something not supported. */
    const idx = all.findIndex(([t]) => t === 259);
    bad.writeUInt32LE(5, 10 + idx * 12 + 8);
    try { readElevation(bad); return false; } catch (err) { return true; }
  })());
}

/* ------------------------------------------------------------------ *
 * The viewer itself
 * ------------------------------------------------------------------ */

(async () => {
  testProjection();
  testSiteData();
  testGeoTiff();

  const dataDir = '/tmp/airsoftmap-viewer-' + Date.now().toString(36);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitForServer(10000);

  const browser = await chromium.launch(Object.assign(
    { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
    EXEC ? { executablePath: EXEC } : {}
  ));
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); failures++; });

  try {
    console.log('\nLoading');
    await page.goto(BASE + '/viewer.html?room=' + ROOM + '&site=' + SITE,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.AMV && window.AMV.state.terrain, null,
      { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#link').textContent === 'connected',
      null, { timeout: 10000 });

    check('the ground loads and the loading screen goes',
      await page.$eval('#loading', (el) => el.classList.contains('gone')));
    check('the scene has a ground mesh',
      await page.evaluate(() => !!window.AMV.scene.getObjectByName('ground')));
    check('the wood is instanced, not five hundred objects',
      await page.evaluate(() => {
        const t = window.AMV.scene.getObjectByName('trees');
        return t.children.length === 2 && t.children.every((c) => c.isInstancedMesh);
      }));

    console.log('\nThe ground model');
    const geo = await page.evaluate(() => {
      const t = window.AMV.state.terrain;
      const g = window.AMV.scene.getObjectByName('ground');
      const p = g.geometry.attributes.position;
      const y = (c, r) => p.getY(r * t.width + c);
      let spike = 0;
      for (let r = 1; r < t.height - 1; r++) {
        for (let c = 1; c < t.width - 1; c++) {
          const v = y(c, r);
          const mean = (y(c, r - 1) + y(c, r + 1) + y(c - 1, r) + y(c + 1, r)) / 4;
          spike = Math.max(spike, Math.abs(v - mean));
        }
      }
      return {
        verts: p.count,
        cells: t.width * t.height,
        nw: y(0, 0), ne: y(t.width - 1, 0), sw: y(0, t.height - 1),
        spike,
        /* Sampling between grid points must interpolate, not snap. */
        mid: t.heightAt(0.5 * t.pixel + t.pixel / 2, 0.5 * t.pixel),
        a: t.cell(0, 0),
        b: t.cell(1, 0),
      };
    });
    check('one vertex per LIDAR sample', geo.verts === geo.cells);
    check('no spikes: the worst vertex is within a metre of its neighbours ('
      + geo.spike.toFixed(2) + ' m)', geo.spike < 1.5);
    check('the site falls from the south-west corner to the north-east ('
      + geo.sw.toFixed(1) + ' m to ' + geo.ne.toFixed(1) + ' m)',
    geo.sw > geo.nw && geo.nw > geo.ne);

    console.log('\nPutting things on it');
    const round = (v) => Math.round(v * 1e6) / 1e6;
    const placed = await page.evaluate(() => {
      const t = window.AMV.state.terrain;
      const ll = t.toLatLng(120, 150);
      window.AMV.net.send({
        t: 'struct:add', kind: 'cabin', label: 'THE CABIN',
        lat: ll.lat, lng: ll.lng, rot: 30, w: 5, d: 4, h: 3,
      });
      return ll;
    });
    await page.waitForFunction(() => window.AMV.state.structures.size === 1, null,
      { timeout: 5000 });

    const back = await page.evaluate(() => {
      const [entry] = [...window.AMV.state.structures.values()];
      const t = window.AMV.state.terrain;
      const world = t.toWorld(entry.data.lat, entry.data.lng);
      return {
        world,
        y: entry.mesh.position.y,
        ground: t.heightAt(world.x, world.z),
        listed: document.querySelector('#structure-list b').textContent,
        built: document.querySelector('#stat-built').textContent,
        lat: entry.data.lat,
        lng: entry.data.lng,
      };
    });
    check('a structure round-trips through the room to the right spot',
      near(back.world.x, 120, 0.05) && near(back.world.z, 150, 0.05));
    check('it sits on the ground rather than through it',
      near(back.y, back.ground, 0.001));
    check('it is listed by the name it was given', back.listed === 'THE CABIN');
    check('it counts as built, not proposed', back.built === '1');
    check('the latitude the server stored is the one we sent',
      round(placed.lat) === round(back.lat) && round(placed.lng) === round(back.lng));

    console.log('\nProposals');
    await page.evaluate(() => {
      const [entry] = [...window.AMV.state.structures.values()];
      window.AMV.net.send({ t: 'struct:update', id: entry.data.id, status: 'planned' });
    });
    await page.waitForFunction(
      () => document.querySelector('#stat-planned').textContent === '1',
      null, { timeout: 5000 }
    );
    check('a built thing can become a proposal',
      await page.$eval('#stat-built', (el) => el.textContent) === '0');
    check('a proposal is drawn see-through', await page.evaluate(() => {
      const [entry] = [...window.AMV.state.structures.values()];
      let transparent = false;
      entry.mesh.traverse((o) => { if (o.isMesh && o.material.transparent) transparent = true; });
      return transparent;
    }));

    console.log('\nGround under a footprint');
    /* Selecting it is what fills the panel, and the panel is the whole
       point: a five-metre cabin on a one-in-six slope is a platform,
       and the viewer has to say so before anyone buys timber. */
    const footing = await page.evaluate(() => {
      const [entry] = [...window.AMV.state.structures.values()];
      window.AMV.state.selected = entry.data.id;
      return { id: entry.data.id, data: entry.data };
    });
    await page.evaluate((id) => {
      const list = [...document.querySelectorAll('#structure-list li')];
      if (list[0]) list[0].click();
      return id;
    }, footing.id);
    await wait(300);
    const panel = await page.evaluate(() => ({
      ground: document.querySelector('#sel-ground').textContent,
      level: document.querySelector('#sel-level').textContent,
      slope: window.AMV.state.terrain.slopeAt(120, 150),
    }));
    check('it reports height above sea level and steepness ("' + panel.ground + '")',
      /m above sea level/.test(panel.ground) && /\d+° slope/.test(panel.ground));
    check('it reports the drop across the footprint ("'
      + panel.level.slice(0, 46) + '...")',
    /level to within|falls [\d.]+ m across/.test(panel.level));

    console.log('\nRemoving');
    await page.evaluate(() => {
      const [entry] = [...window.AMV.state.structures.values()];
      window.AMV.net.send({ t: 'struct:del', id: entry.data.id });
    });
    await page.waitForFunction(() => window.AMV.state.structures.size === 0, null,
      { timeout: 5000 });
    check('deleting one takes it off the scene as well as the list',
      await page.evaluate(() => window.AMV.scene.getObjectByName('structure') === undefined));

    console.log('\nObservers are not players');
    const snapshot = await fetch(BASE + '/api/room/' + ROOM).then((r) => r.json());
    check('the viewer left no player behind in the room',
      !snapshot.players || snapshot.players.length === 0);
    const sessions = await fetch(BASE + '/api/room/' + ROOM + '/sessions').then((r) => r.json());
    check('and nothing in the game log', (sessions.sessions || []).length === 0);

    console.log('\nEye level');
    await page.click('#view-walk');
    await wait(400);
    check('it drops the camera to head height on the slope', await page.evaluate(() => {
      const t = window.AMV.state.terrain;
      const c = window.AMV.camera.position;
      return Math.abs(c.y - (t.heightAt(c.x, c.z) + 1.7)) < 0.6;
    }));
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
