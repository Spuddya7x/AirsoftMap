#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Build a 3D site model from Environment Agency LIDAR.
 *
 * England is surveyed from the air at one metre, bare-earth and first
 * return, and the whole thing is open data. That is better ground truth
 * than anyone is going to get by walking a wood with a phone: the bare
 * earth model sees through the canopy, and the difference between the
 * two models is the canopy itself, which is enough to find and measure
 * every tree on the site.
 *
 * So this takes a boundary and produces what the viewer needs:
 *
 *   <name>.heights.bin   the ground, as a grid of 16-bit centimetres
 *   <name>.site.json     everything else - extent, the mapping from
 *                        latitude and longitude into the grid, and one
 *                        entry per tree with its position and height
 *
 * Coverage is England only. Elsewhere the viewer still works, but the
 * terrain has to come from somewhere else.
 *
 * Usage:
 *   node scripts/fetch-terrain.js --boundary site.geojson --name green-wood
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const path = require('path');
const { bngToWgs84, wgs84ToBng } = require('./lib/bng.js');
const { readElevation } = require('./lib/geotiff.js');

const WCS = 'https://environment.data.gov.uk/spatialdata';

/* The two coverages, and the identifiers their service insists on. */
const DTM = {
  slug: 'lidar-composite-digital-terrain-model-dtm-1m',
  id: '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m',
  what: 'bare earth',
};
const DSM = {
  slug: 'lidar-composite-digital-surface-model-first-return-dsm-1m',
  id: 'df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m',
  what: 'first return',
};

/* A stem has to be this tall to be worth drawing; below it is scrub. */
const MIN_TREE_M = 6;
/* Anything taller than this is a decoding mistake, not a tree. */
const MAX_TREE_M = 60;

/* --- arguments ------------------------------------------------------ */

function parseArgs(argv) {
  const args = { out: 'public/data', pad: 25 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--boundary') args.boundary = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--pad') args.pad = Number(argv[++i]);
    else if (a === '--bbox') args.bbox = argv[++i];
    else {
      console.error('unknown option: ' + a);
      process.exit(2);
    }
  }
  if (!args.name || (!args.boundary && !args.bbox)) {
    console.error(
      'usage: fetch-terrain.js --name SITE (--boundary FILE.geojson | --bbox w,s,e,n) [--out DIR] [--pad m]'
    );
    process.exit(2);
  }
  return args;
}

/* --- the area we want ----------------------------------------------- */

/** Every coordinate in a GeoJSON geometry, however deeply nested. */
function* coords(node) {
  if (typeof node[0] === 'number') {
    yield node;
    return;
  }
  for (const child of node) yield* coords(child);
}

function boundsOf(args) {
  if (args.bbox) {
    const p = args.bbox.split(',').map(Number);
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) {
      throw new Error('--bbox wants west,south,east,north');
    }
    return { west: p[0], south: p[1], east: p[2], north: p[3] };
  }
  const gj = JSON.parse(fs.readFileSync(args.boundary, 'utf8'));
  const features = gj.type === 'FeatureCollection' ? gj.features
    : gj.type === 'Feature' ? [gj] : [{ geometry: gj }];
  let west = Infinity; let south = Infinity;
  let east = -Infinity; let north = -Infinity;
  for (const f of features) {
    if (!f.geometry) continue;
    for (const [lng, lat] of coords(f.geometry.coordinates)) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (!Number.isFinite(west)) throw new Error('no coordinates in ' + args.boundary);
  return { west, south, east, north };
}

/* --- fetching ------------------------------------------------------- */

async function coverage(source, box) {
  const url = WCS + '/' + source.slug + '/wcs?service=WCS&version=2.0.1'
    + '&request=GetCoverage&coverageId=' + source.id + '&format=image/tiff'
    + '&subset=E(' + box.minE + ',' + box.maxE + ')'
    + '&subset=N(' + box.minN + ',' + box.maxN + ')';

  process.stdout.write('  ' + source.what.padEnd(13) + ' ');
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(source.what + ': the coverage service said ' + res.status
      + '. Outside England, or the service is down.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(source.what + ': response was too small to be a coverage');
  const grid = readElevation(buf);
  console.log(grid.width + ' x ' + grid.height + ' at ' + grid.pixel + ' m');
  return grid;
}

/* --- trees ---------------------------------------------------------- */

/**
 * A crown gets wider as it gets taller, so the window that decides
 * "is this the top of a tree" has to grow with the height it is
 * testing. One fixed window either merges neighbouring oaks or splits
 * a single one into five.
 */
const crownRadius = (h) => Math.max(2, Math.round(1.2 + 0.14 * h));

function findTrees(canopy, width, height) {
  const trees = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const h = canopy[y * width + x];
      if (!(h >= MIN_TREE_M) || h > MAX_TREE_M) continue;
      const r = crownRadius(h);
      let peak = true;
      for (let dy = -r; dy <= r && peak; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || (dx === 0 && dy === 0)) continue;
          const v = canopy[yy * width + xx];
          /* Ties go to whichever pixel comes first, so a flat crown
             yields one stem rather than a cluster of them. */
          if (v > h || (v === h && (yy < y || (yy === y && xx < x)))) {
            peak = false;
            break;
          }
        }
      }
      if (peak) trees.push({ x, y, h });
    }
  }
  return trees;
}

/* --- main ----------------------------------------------------------- */

(async function main() {
  const args = parseArgs(process.argv);
  const wgs = boundsOf(args);

  /* Work in the grid the LIDAR is published on. The alternative is
     resampling it into a local frame, which throws away precision for
     no gain: at this longitude grid north is nearly two degrees off
     true north, and a site plan wants the grid. */
  const sw = wgs84ToBng(wgs.south, wgs.west);
  const ne = wgs84ToBng(wgs.north, wgs.east);
  const pad = Math.max(0, args.pad);
  const box = {
    minE: Math.floor(Math.min(sw.E, ne.E) - pad),
    maxE: Math.ceil(Math.max(sw.E, ne.E) + pad),
    minN: Math.floor(Math.min(sw.N, ne.N) - pad),
    maxN: Math.ceil(Math.max(sw.N, ne.N) + pad),
  };
  console.log('site  ' + (box.maxE - box.minE) + ' x ' + (box.maxN - box.minN)
    + ' m around ' + box.minE + ',' + box.minN + ' (British National Grid)');

  const [ground, surface] = [await coverage(DTM, box), await coverage(DSM, box)];
  if (ground.width !== surface.width || ground.height !== surface.height) {
    throw new Error('the two models came back on different grids');
  }

  const { width, height, pixel, originE, originN } = ground;
  const cells = width * height;

  /* Canopy is the gap between what the laser hit first and the ground
     underneath it. Negative values are noise; clamp them away. */
  const canopy = new Float32Array(cells);
  let missing = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < cells; i++) {
    const g = ground.grid[i];
    if (Number.isNaN(g)) {
      missing++;
    } else {
      if (g < lowest) lowest = g;
      if (g > highest) highest = g;
    }
    const s = surface.grid[i];
    canopy[i] = Number.isNaN(g) || Number.isNaN(s) ? 0 : Math.max(0, s - g);
  }
  if (!Number.isFinite(lowest)) throw new Error('the ground model is empty here');

  /* Centimetres in a 16-bit integer: 655 m of range, which is more
     than any English hillside needs, at a precision far finer than the
     survey itself. Gaps become the floor rather than a hole. */
  const heights = new Int16Array(cells);
  for (let i = 0; i < cells; i++) {
    const g = ground.grid[i];
    heights[i] = Math.round(((Number.isNaN(g) ? lowest : g) - lowest) * 100);
  }

  const trees = findTrees(canopy, width, height).map((t) => ({
    /* Pixel centres, as metres east and north of the grid origin. */
    x: Math.round((t.x + 0.5) * pixel * 10) / 10,
    y: Math.round((t.y + 0.5) * pixel * 10) / 10,
    h: Math.round(t.h * 10) / 10,
  }));

  /* The viewer places things by latitude and longitude but draws in
     grid metres. Over a few hundred metres the conversion is linear to
     well under a centimetre, so ship the derivatives about the centre
     rather than the whole projection. */
  const centre = {
    lat: (wgs.south + wgs.north) / 2,
    lng: (wgs.west + wgs.east) / 2,
  };
  const step = 0.001;
  const at = wgs84ToBng(centre.lat, centre.lng);
  const dLat = wgs84ToBng(centre.lat + step, centre.lng);
  const dLng = wgs84ToBng(centre.lat, centre.lng + step);
  const frame = {
    lat: centre.lat,
    lng: centre.lng,
    E: at.E,
    N: at.N,
    dEdLat: (dLat.E - at.E) / step,
    dEdLng: (dLng.E - at.E) / step,
    dNdLat: (dLat.N - at.N) / step,
    dNdLng: (dLng.N - at.N) / step,
  };

  const corner = (e, n) => {
    const ll = bngToWgs84(e, n);
    return [Math.round(ll.lng * 1e7) / 1e7, Math.round(ll.lat * 1e7) / 1e7];
  };
  const south = originN - height * pixel;
  const east = originE + width * pixel;

  const site = {
    name: args.name,
    built: new Date().toISOString(),
    source: 'Environment Agency LIDAR Composite 1 m (DTM and first return DSM), '
      + 'Open Government Licence v3.0',
    crs: 'EPSG:27700',
    grid: {
      width,
      height,
      pixel,
      originE,
      originN,
      /* Ground heights are centimetres above this, in the .bin file. */
      base: Math.round(lowest * 100) / 100,
      min: Math.round(lowest * 100) / 100,
      max: Math.round(highest * 100) / 100,
      missing,
    },
    frame,
    /* The four corners in WGS84, so a 2D map can show the same extent. */
    outline: [
      corner(originE, originN), corner(east, originN),
      corner(east, south), corner(originE, south),
    ],
    trees,
  };

  fs.mkdirSync(args.out, { recursive: true });
  const stem = path.join(args.out, args.name);
  fs.writeFileSync(stem + '.heights.bin', Buffer.from(heights.buffer));
  fs.writeFileSync(stem + '.site.json', JSON.stringify(site));

  const hectares = (cells * pixel * pixel) / 10000;
  console.log('ground  ' + lowest.toFixed(1) + ' to ' + highest.toFixed(1)
    + ' m  (' + (highest - lowest).toFixed(1) + ' m of fall)'
    + (missing ? '  ' + missing + ' cells with no data' : ''));
  console.log('trees   ' + trees.length + ' stems over ' + hectares.toFixed(2)
    + ' ha  =  ' + Math.round(trees.length / hectares) + ' per hectare');
  console.log('wrote   ' + stem + '.heights.bin ('
    + Math.round(heights.byteLength / 1024) + ' KB) and ' + stem + '.site.json');
})().catch((err) => {
  console.error('failed: ' + err.message);
  process.exit(1);
});
