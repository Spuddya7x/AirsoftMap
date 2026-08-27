/* ------------------------------------------------------------------ *
 * British National Grid <-> WGS84.
 *
 * Every free dataset worth having for an English site - Land Registry
 * parcels, Environment Agency LIDAR - is published in EPSG:27700, and
 * every consumer of it here wants WGS84. So the conversion lives in one
 * place: inverse transverse Mercator off the Airy 1830 spheroid, then a
 * Helmert shift onto WGS84. Good to about five metres, which is well
 * inside the accuracy of the things being converted.
 * ------------------------------------------------------------------ */

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

module.exports = { DEG, bngToOsgb36, osgb36ToWgs84, bngToWgs84, wgs84ToBng };
