/* Terrain (contours, hillshade, line of sight) and land parcels.

   Elevation normally comes from the AWS Terrain Tiles open dataset. Here
   the tile source is pointed at a synthetic surface generated in the
   browser - a ridge running north to south - so the maths can be checked
   against a shape we already know the answer for, offline and repeatably.

   Run with: npm run test:terrain */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.TEST_PORT) || (8900 + Math.floor(Math.random() * 90));
const BASE = 'http://127.0.0.1:' + PORT;
const EXEC = process.env.CHROMIUM_PATH || undefined;
const SITE = { latitude: 51.1417, longitude: -0.9463 };
const ROOM = 'TERR' + Date.now().toString(36).toUpperCase();

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

/* A terrarium tile whose height is a ridge down the middle: low at the
   western and eastern edges, 60m higher along the centre line. */
const SYNTH_TILE = () => new Promise((resolve) => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const height = 100 + 60 * Math.sin((x / 255) * Math.PI);
      const v = Math.round((height + 32768) * 256);
      const o = (y * 256 + x) * 4;
      img.data[o] = (v >> 16) & 255;
      img.data[o + 1] = (v >> 8) & 255;
      img.data[o + 2] = v & 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/png');
});

const PARCELS = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { id: 'test-plot-1', areaM2: 40000, areaAcres: 9.88 },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-0.9473, 51.1407], [-0.9453, 51.1407],
        [-0.9453, 51.1427], [-0.9473, 51.1427], [-0.9473, 51.1407],
      ]],
    },
  }],
};

(async () => {
  const dataDir = '/tmp/airsoftmap-terrain-' + Date.now().toString(36);
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
  const ctx = await browser.newContext({
    permissions: ['geolocation'], geolocation: SITE,
    viewport: { width: 900, height: 900 },
  });

  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); failures++; });
    await page.goto(BASE + '/?room=' + ROOM, { waitUntil: 'domcontentloaded' });
    await page.fill('#f-callsign', 'SURVEY');
    await page.click('#f-go');
    await page.waitForSelector('#tools:not(.hidden)');
    await wait(1500);

    /* --- point the elevation source at the synthetic ridge ---------- */
    await page.evaluate(async (fn) => {
      const make = new Function('return (' + fn + ')')();
      window.AM.terrain.tileUrl = await make();
      window.AM.map.setView([51.1417, -0.9463], 15);
    }, SYNTH_TILE.toString());
    await wait(500);

    const elev = await page.evaluate(() =>
      window.AM.terrain.elevationAtAsync(window.AM.map.getCenter()));
    check('elevation decodes from a terrarium tile (' + Math.round(elev) + 'm)',
      elev != null && elev >= 99 && elev <= 161);

    /* --- contours ---------------------------------------------------- */
    const result = await page.evaluate(() =>
      window.AM.terrain.setOptions({ contours: true, hillshade: true, interval: 10 }));
    check('a contour pass reports a height range (' +
      Math.round(result.min) + '-' + Math.round(result.max) + 'm)',
      result.ok === true && result.max - result.min > 20);
    check('contour levels are computed (' + result.levels + ')', result.levels >= 3);

    await wait(600);
    const drawn = await page.evaluate(() => ({
      polylines: window.AM.terrain.layer.getLayers().length,
      hillshade: !!window.AM.terrain.shade,
      labels: document.querySelectorAll('.contour-label').length,
    }));
    check('contours reach the map (' + drawn.polylines + ' polylines)', drawn.polylines > 0);
    check('index contours are labelled', drawn.labels > 0);
    check('hillshade is rendered', drawn.hillshade);

    /* --- line of sight ------------------------------------------------ */
    const los = await page.evaluate(async () => {
      const U = window.AM.U;
      const t = window.AM.terrain;
      const c = window.AM.map.getCenter();
      const centre = { lat: c.lat, lng: c.lng };

      /* The ridges run north to south. Scan east-west to find the crest,
         then put an observer either side of it: that is the case the
         answer is known for, wherever the map happens to be sitting. */
      const scanFrom = U.destination(centre, 270, 500);
      const scanTo = U.destination(centre, 90, 500);
      const scan = await t.profile(scanFrom, scanTo, 200);
      let crest = null;
      for (const s of scan.samples) {
        if (s.elev != null && (!crest || s.elev > crest.elev)) crest = s;
      }
      const west = U.destination(crest, 270, 200);
      const east = U.destination(crest, 90, 200);
      const north = U.destination(crest, 0, 260);
      const across = await t.lineOfSight(west, east, 1.6, 1.6);
      const along = await t.lineOfSight(crest, north, 1.6, 1.6);
      return {
        crest: Math.round(crest.elev),
        across: { ok: across.ok, visible: across.visible, by: across.byMetres },
        along: { ok: along.ok, visible: along.visible },
        samples: across.profile.samples.length,
      };
    });
    check('a profile is sampled along the ground (' + los.samples + ' points)', los.samples > 50);
    check('sight across the crest (' + los.crest + 'm) is blocked by it (' + los.across.by + 'm)',
      los.across.ok && los.across.visible === false && los.across.by > 1);
    check('sight along the ridge is clear', los.along.ok && los.along.visible === true);

    /* --- land parcels -------------------------------------------------- */
    const res = await fetch(BASE + '/api/room/' + ROOM + '/parcels?name=TEST', {
      method: 'POST',
      headers: { 'Content-Type': 'application/geo+json' },
      body: JSON.stringify(PARCELS),
    });
    const body = await res.json();
    check('a parcel layer can be uploaded', res.ok && !!body.parcels && body.parcels.count === 1);
    await wait(1200);
    check('parcels reach the map', await page.evaluate(() =>
      !!window.AM.parcels.layer && window.AM.parcels.data.features.length === 1));

    await page.evaluate(() => {
      const p = window.AM.parcels;
      let node = null;
      p.layer.eachLayer((l) => { node = l; });
      p.pick(p.data.features[0], node);
    });
    await wait(300);
    check('picking a plot totals its area (' + (await page.textContent('#parcel-area')) + ')',
      /9\.8[0-9]/.test(await page.textContent('#parcel-area')));

    await page.click('#btn-parcel-mine');
    await wait(1200);
    const boundaries = await page.evaluate(() =>
      [...window.AM.state.drawings.values()].filter((r) => r.data.shape === 'boundary').length);
    check('a picked plot becomes land you own', boundaries === 1);

    /* a second plot, marked as permitted rather than owned */
    await page.evaluate(async () => {
      const res = await fetch(location.origin + '/api/room/' + window.AM.state.me.room + '/parcels?name=TEST2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/geo+json' },
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { id: 'test-plot-2', areaM2: 20000, areaAcres: 4.94 },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [-0.9453, 51.1407], [-0.9433, 51.1407],
                [-0.9433, 51.1427], [-0.9453, 51.1427], [-0.9453, 51.1407],
              ]],
            },
          }],
        }),
      });
      return res.ok;
    });
    await wait(1400);
    await page.evaluate(() => {
      const p = window.AM.parcels;
      let node = null;
      p.layer.eachLayer((l) => { node = l; });
      p.pick(p.data.features[0], node);
    });
    await wait(300);
    await page.click('#btn-parcel-play');
    await wait(1200);
    const permits = await page.evaluate(() =>
      [...window.AM.state.drawings.values()].filter((r) => r.data.shape === 'permit').length);
    check('a picked plot can instead be marked playable', permits === 1);

    /* --- three-state boundary warning ----------------------------------- */
    const fence = await page.evaluate(() => {
      const chip = document.getElementById('chip-fence');
      const state = window.AM.state;
      state.opts.fence = true;
      const at = (lat, lng) => {
        state.nav.fix = { lat, lng, acc: 5, src: 'gps', ts: Date.now() };
        window.AM.checkBoundary();
        return {
          where: window.AM.whereAmI(state.nav.fix),
          hidden: chip.classList.contains('hidden'),
          text: chip.textContent,
        };
      };
      const owned = at(51.1417, -0.9463);      // inside the plot marked MY LAND
      const permitted = at(51.1417, -0.9443);  // inside the plot marked PLAYABLE
      const off = at(51.1500, -0.9463);        // outside both
      state.opts.fence = false;
      window.AM.checkBoundary();
      const muted = chip.classList.contains('hidden');
      return { owned, permitted, off, muted };
    });
    check('on your own land: no warning',
      fence.owned.where === 'owned' && fence.owned.hidden === true);
    check('on permitted land: told so, not warned (' + fence.permitted.text + ')',
      fence.permitted.where === 'playable' && fence.permitted.hidden === false &&
      /PERMITTED/.test(fence.permitted.text));
    check('off the site altogether: warned (' + fence.off.text + ')',
      fence.off.where === 'off' && /OFF SITE/.test(fence.off.text));
    check('the warning can be switched off', fence.muted === true);
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
