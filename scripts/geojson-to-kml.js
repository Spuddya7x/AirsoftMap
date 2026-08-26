#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * GeoJSON -> KML.
 *
 * Handy for checking a boundary against imagery you trust: Google Earth
 * and Google My Maps both import KML, so you can lay the registered
 * parcels over Google's aerial photography at full zoom rather than
 * squinting at a baked screenshot.
 *
 *   node scripts/geojson-to-kml.js --input parcels.geojson --out parcels.kml
 *
 * Options:
 *   --name    document name shown in Google Earth
 *   --colour  outline colour as #rrggbb (default the Land Registry red)
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = { out: 'out.kml', name: 'Parcels', colour: '#c8102e' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'input') args.input = value;
    else if (key === 'out') args.out = value;
    else if (key === 'name') args.name = value;
    else if (key === 'colour' || key === 'color') args.colour = value;
    else { console.error('unknown option: ' + argv[i]); process.exit(2); }
  }
  if (!args.input) {
    console.error('usage: geojson-to-kml.js --input FILE.geojson [--out FILE.kml]');
    process.exit(2);
  }
  return args;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** KML wants aabbggrr, not #rrggbb. */
function kmlColour(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 'ff2e10c8';
  return (alpha || 'ff') + m[3] + m[2] + m[1];
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

const args = parseArgs(process.argv);
const gj = JSON.parse(fs.readFileSync(args.input, 'utf8'));
const features = gj.type === 'FeatureCollection' ? gj.features : [gj];

const out = [];
out.push('<?xml version="1.0" encoding="UTF-8"?>');
out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
out.push('<name>' + esc(args.name) + '</name>');
out.push('<Style id="parcel"><LineStyle><color>' + kmlColour(args.colour) +
         '</color><width>2.2</width></LineStyle>' +
         '<PolyStyle><color>' + kmlColour(args.colour, '1a') + '</color><fill>1</fill><outline>1</outline></PolyStyle></Style>');

let written = 0;
for (const f of features) {
  const props = f.properties || {};
  const acres = props.areaAcres != null
    ? props.areaAcres
    : (props.areaM2 != null ? (props.areaM2 / 4046.856).toFixed(2) : null);
  const label = acres != null ? acres + ' acres' : (props.id || 'parcel');

  for (const poly of ringsOf(f.geometry)) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 4) continue;
    const coords = (ring) => ring.map(([lng, lat]) => lng + ',' + lat + ',0').join(' ');

    out.push('<Placemark><name>' + esc(label) + '</name>');
    if (props.id) out.push('<description>' + esc(props.id) + '</description>');
    out.push('<styleUrl>#parcel</styleUrl><Polygon><tessellate>1</tessellate>');
    out.push('<outerBoundaryIs><LinearRing><coordinates>' + coords(outer) +
             '</coordinates></LinearRing></outerBoundaryIs>');
    for (const hole of holes) {
      out.push('<innerBoundaryIs><LinearRing><coordinates>' + coords(hole) +
               '</coordinates></LinearRing></innerBoundaryIs>');
    }
    out.push('</Polygon></Placemark>');
    written++;
  }
}
out.push('</Document></kml>');

fs.writeFileSync(args.out, out.join('\n'));
console.error('wrote ' + written + ' polygons to ' + args.out +
  ' (' + Math.round(fs.statSync(args.out).size / 1024) + ' KB)');
