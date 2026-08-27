#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Turn HM Land Registry INSPIRE Index Polygons into GeoJSON.
 *
 * The INSPIRE Index Polygons show the indicative extent of every
 * registered freehold title in England and Wales. They are open data
 * under the Open Government Licence, published per local authority as
 * GML in British National Grid, and they are the closest thing there is
 * to a free map of "which plot is which" - far better than guessing
 * where your boundary runs from a title plan with no coordinates on it.
 *
 *   1. Download your district from
 *      https://use-land-property-data.service.gov.uk/datasets/inspire/download
 *   2. Unzip it, then:
 *
 *      node scripts/inspire-to-geojson.js \
 *        --input Land_Registry_Cadastral_Parcels.gml \
 *        --centre 50.9604,0.3037 --radius 3000 \
 *        --out parcels.geojson
 *
 *   3. Load parcels.geojson in the app (Settings -> LAND PARCELS) and
 *      tap your plot to adopt it as the site boundary.
 *
 * Coordinates are converted from British National Grid (OSGB36, Airy
 * 1830) to WGS84 with the standard Helmert transform, which is good to
 * about 5 metres. That is fine for a boundary you are going to walk
 * anyway; if you need survey accuracy, reproject with OSTN15 instead.
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');
const { DEG, bngToWgs84, wgs84ToBng } = require('./lib/bng.js');

/* --- arguments ------------------------------------------------------ */

function parseArgs(argv) {
  const args = { radius: 3000, out: 'parcels.geojson', simplify: 0.5 };
  for (let i = 2; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'input') args.input = value;
    else if (key === 'out') args.out = value;
    else if (key === 'centre' || key === 'center') args.centre = value;
    else if (key === 'radius') args.radius = Number(value);
    else if (key === 'simplify') args.simplify = Number(value);
    else if (key === 'bbox') args.bbox = value;
    else {
      console.error('unknown option: ' + argv[i]);
      process.exit(2);
    }
  }
  if (!args.input) {
    console.error('usage: inspire-to-geojson.js --input FILE.gml [--centre lat,lng --radius m] [--out FILE]');
    process.exit(2);
  }
  return args;
}

/* --- geometry ------------------------------------------------------- */

/** Douglas-Peucker in metres, to keep the output small. */
function simplify(points, tolerance) {
  if (tolerance <= 0 || points.length < 3) return points;
  const sqTol = tolerance * tolerance;

  const sqSegDist = (p, a, b) => {
    let x = a[0];
    let y = a[1];
    let dx = b[0] - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
  };

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1;
    let maxSq = sqTol;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(points[i], points[first], points[last]);
      if (sq > maxSq) { index = i; maxSq = sq; }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum / 2);
}

/* --- streaming GML reader ------------------------------------------- */

function readMembers(file, onMember) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let buffer = '';
    let count = 0;
    stream.on('data', (chunk) => {
      buffer += chunk;
      let start = buffer.indexOf('<wfs:member>');
      while (start !== -1) {
        const end = buffer.indexOf('</wfs:member>', start);
        if (end === -1) break;
        onMember(buffer.slice(start, end));
        count++;
        buffer = buffer.slice(end + 13);
        start = buffer.indexOf('<wfs:member>');
      }
      if (buffer.length > 8 << 20) buffer = buffer.slice(-(4 << 20));
    });
    stream.on('end', () => resolve(count));
    stream.on('error', reject);
  });
}

/* --- main ----------------------------------------------------------- */

(async function main() {
  const args = parseArgs(process.argv);

  let filter = null;
  if (args.centre) {
    const [lat, lng] = args.centre.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error('--centre must be "lat,lng"');
      process.exit(2);
    }
    const c = wgs84ToBng(lat, lng);
    filter = { E: c.E, N: c.N, r: args.radius };
    console.error('centre ' + lat + ',' + lng + ' is BNG ' +
      Math.round(c.E) + ' ' + Math.round(c.N) + ', keeping parcels within ' + args.radius + 'm');
  }

  const features = [];
  let scanned = 0;
  let kept = 0;

  await readMembers(args.input, (member) => {
    scanned++;
    /* INSPIREID is the stable national identifier; the gml:id is only
       unique within one authority's file, so titles that straddle a
       district boundary cannot be de-duplicated by it. */
    const inspireMatch = member.match(/<LR:INSPIREID>([^<]+)<\/LR:INSPIREID>/);
    const idMatch = inspireMatch || member.match(/gml:id="([^"]+)"/);
    const rings = [];
    const posRe = /<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g;
    let m;
    while ((m = posRe.exec(member)) !== null) {
      const nums = m[1].trim().split(/\s+/);
      const ring = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        ring.push([Number(nums[i]), Number(nums[i + 1])]);   // easting, northing
      }
      if (ring.length > 3) rings.push(ring);
    }
    if (!rings.length) return;

    if (filter) {
      const [E, N] = rings[0][0];
      if (Math.hypot(E - filter.E, N - filter.N) > filter.r) return;
    }

    const outer = rings[0];
    const areaM2 = ringArea(outer);
    const coordinates = rings.map((ring) => {
      const thin = simplify(ring, args.simplify);
      const out = thin.map(([E, N]) => {
        const ll = bngToWgs84(E, N);
        return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
      });
      /* GeoJSON rings must close. */
      const first = out[0];
      const last = out[out.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
      return out;
    });

    kept++;
    features.push({
      type: 'Feature',
      properties: {
        id: idMatch ? idMatch[1] : 'parcel-' + kept,
        areaM2: Math.round(areaM2),
        areaAcres: Number((areaM2 / 4046.856).toFixed(3)),
      },
      geometry: { type: 'Polygon', coordinates },
    });
  });

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      source: 'HM Land Registry INSPIRE Index Polygons',
      licence: 'Open Government Licence v3.0',
      note: 'Indicative extents of registered freehold titles. Converted from ' +
            'British National Grid with a Helmert transform (about 5m accuracy).',
    },
    features,
  };

  fs.writeFileSync(args.out, JSON.stringify(geojson));
  const bytes = fs.statSync(args.out).size;
  console.error('scanned ' + scanned + ' parcels, wrote ' + kept + ' to ' + args.out +
    ' (' + Math.round(bytes / 1024) + ' KB)');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
