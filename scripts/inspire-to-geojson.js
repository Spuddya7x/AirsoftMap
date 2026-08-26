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

/* --- British National Grid -> WGS84 --------------------------------- */

const DEG = Math.PI / 180;

/** Inverse transverse Mercator: BNG easting/northing -> OSGB36 lat/lon. */
function bngToOsgb36(E, N) {
  const a = 6377563.396;          // Airy 1830 semi-major
  const b = 6356256.909;          // Airy 1830 semi-minor
  const F0 = 0.9996012717;        // central meridian scale factor
  const lat0 = 49 * DEG;
  const lon0 = -2 * DEG;
  const N0 = -100000;
  const E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;

  let lat = lat0;
  let M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dLat = lat - lat0;
    const sLat = lat + lat0;
    const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * dLat;
    const Mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dLat) * Math.cos(sLat);
    const Mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const Md = (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const tanLat = Math.tan(lat);
  const t2 = tanLat * tanLat;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu;
  const nu5 = nu3 * nu * nu;
  const nu7 = nu5 * nu * nu;

  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tanLat / (720 * rho * nu5)) * (61 + 90 * t2 + 45 * t4);
  const X = secLat / nu;
  const XI = (secLat / (6 * nu3)) * (nu / rho + 2 * t2);
  const XII = (secLat / (120 * nu5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (secLat / (5040 * nu7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  const dE = E - E0;
  const dE2 = dE * dE;
  const dE3 = dE2 * dE;
  const dE4 = dE2 * dE2;
  const dE5 = dE3 * dE2;
  const dE6 = dE4 * dE2;
  const dE7 = dE5 * dE2;

  return {
    lat: lat - VII * dE2 + VIII * dE4 - IX * dE6,
    lon: lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7,
  };
}

/** Helmert datum shift, OSGB36 -> WGS84 (about 5 metres of accuracy). */
function osgb36ToWgs84(lat, lon) {
  const toCartesian = (phi, lambda, h, a, f) => {
    const e2 = 2 * f - f * f;
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    return [
      (nu + h) * Math.cos(phi) * Math.cos(lambda),
      (nu + h) * Math.cos(phi) * Math.sin(lambda),
      ((1 - e2) * nu + h) * Math.sin(phi),
    ];
  };

  const airy = { a: 6377563.396, f: 1 / 299.3249646 };
  const wgs = { a: 6378137.0, f: 1 / 298.257223563 };
  const [x, y, z] = toCartesian(lat, lon, 0, airy.a, airy.f);

  /* Inverse of the OS "WGS84 to OSGB36" parameters. */
  const tx = 446.448;
  const ty = -125.157;
  const tz = 542.060;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * DEG;
  const ry = (0.2470 / 3600) * DEG;
  const rz = (0.8421 / 3600) * DEG;

  const x2 = tx + x * (1 + s) - y * rz + z * ry;
  const y2 = ty + x * rz + y * (1 + s) - z * rx;
  const z2 = tz - x * ry + y * rx + z * (1 + s);

  const e2 = 2 * wgs.f - wgs.f * wgs.f;
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let phi = Math.atan2(z2, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = wgs.a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const next = Math.atan2(z2 + e2 * nu * Math.sin(phi), p);
    if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
    phi = next;
  }
  return { lat: phi / DEG, lng: Math.atan2(y2, x2) / DEG };
}

const bngToWgs84 = (E, N) => {
  const os = bngToOsgb36(E, N);
  return osgb36ToWgs84(os.lat, os.lon);
};

/** Forward direction, needed only to turn a search centre into BNG. */
function wgs84ToBng(lat, lng) {
  /* Cheap and sufficient: nudge the inverse until it lands on target. */
  let E = 400000;
  let N = 300000;
  for (let i = 0; i < 60; i++) {
    const got = bngToWgs84(E, N);
    const dLat = lat - got.lat;
    const dLng = lng - got.lng;
    if (Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9) break;
    N += dLat * 111320;
    E += dLng * 111320 * Math.cos(lat * DEG);
  }
  return { E, N };
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
