/* ------------------------------------------------------------------ *
 * Just enough GeoTIFF to read an elevation grid.
 *
 * The Environment Agency's coverage service hands back single-band
 * 32-bit float TIFFs, uncompressed, usually tiled. That is a small
 * corner of the format, and reading it directly avoids a dependency
 * that would otherwise exist only to parse six tags.
 * ------------------------------------------------------------------ */

'use strict';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };

const TAG = {
  WIDTH: 256,
  HEIGHT: 257,
  BITS: 258,
  COMPRESSION: 259,
  SAMPLES: 277,
  STRIP_OFFSETS: 273,
  ROWS_PER_STRIP: 278,
  STRIP_BYTES: 279,
  SAMPLE_FORMAT: 339,
  TILE_WIDTH: 322,
  TILE_HEIGHT: 323,
  TILE_OFFSETS: 324,
  TILE_BYTES: 325,
  MODEL_TRANSFORM: 34264,
  MODEL_TIEPOINT: 33922,
  MODEL_SCALE: 33550,
  NODATA: 42113,
};

/**
 * Read a single-band float32 GeoTIFF.
 *
 * Returns the grid as one flat Float32Array in row order from the
 * north-west corner, with nodata replaced by NaN, plus enough
 * georeferencing to turn a pixel back into an easting and northing.
 */
function readElevation(buf) {
  const little = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f32 = (o) => (little ? buf.readFloatLE(o) : buf.readFloatBE(o));
  const f64 = (o) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));

  if (u16(2) !== 42) throw new Error('not a TIFF (bad magic)');

  const ifd = u32(4);
  const count = u16(ifd);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    tags.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), at: entry + 8 });
  }

  function values(tag) {
    const t = tags.get(tag);
    if (!t) return null;
    const size = TYPE_SIZE[t.type];
    if (!size) throw new Error('unsupported TIFF field type ' + t.type);
    const total = size * t.count;
    /* Four bytes or fewer live in the directory entry itself. */
    const base = total <= 4 ? t.at : u32(t.at);
    if (t.type === 2) return buf.toString('ascii', base, base + t.count).replace(/\0+$/, '');
    const out = [];
    for (let i = 0; i < t.count; i++) {
      const o = base + i * size;
      out.push(t.type === 3 ? u16(o) : t.type === 4 ? u32(o)
        : t.type === 11 ? f32(o) : t.type === 12 ? f64(o) : buf[o]);
    }
    return out;
  }

  const first = (tag, fallback) => {
    const v = values(tag);
    return v && v.length ? v[0] : fallback;
  };

  const width = first(TAG.WIDTH);
  const height = first(TAG.HEIGHT);
  if (!width || !height) throw new Error('TIFF has no dimensions');
  if (first(TAG.COMPRESSION, 1) !== 1) throw new Error('compressed TIFFs are not supported');
  if (first(TAG.SAMPLES, 1) !== 1) throw new Error('expected a single band');
  if (first(TAG.BITS, 32) !== 32 || first(TAG.SAMPLE_FORMAT, 3) !== 3) {
    throw new Error('expected 32-bit float samples');
  }

  const nodataText = values(TAG.NODATA);
  const nodata = nodataText === null ? null : Number(nodataText);

  const grid = new Float32Array(width * height);
  grid.fill(NaN);

  const tileW = first(TAG.TILE_WIDTH);
  if (tileW) {
    const tileH = first(TAG.TILE_HEIGHT);
    const offsets = values(TAG.TILE_OFFSETS);
    const bytes = values(TAG.TILE_BYTES);
    const across = Math.ceil(width / tileW);
    for (let i = 0; i < offsets.length; i++) {
      const x0 = (i % across) * tileW;
      const y0 = Math.floor(i / across) * tileH;
      for (let r = 0; r < tileH; r++) {
        const y = y0 + r;
        if (y >= height) break;
        for (let c = 0; c < tileW; c++) {
          const x = x0 + c;
          if (x >= width) continue;
          const at = offsets[i] + (r * tileW + c) * 4;
          if (at + 4 > offsets[i] + bytes[i]) continue;
          grid[y * width + x] = f32(at);
        }
      }
    }
  } else {
    const offsets = values(TAG.STRIP_OFFSETS);
    const perStrip = first(TAG.ROWS_PER_STRIP, height);
    for (let s = 0; s < offsets.length; s++) {
      for (let r = 0; r < perStrip; r++) {
        const y = s * perStrip + r;
        if (y >= height) break;
        for (let x = 0; x < width; x++) {
          grid[y * width + x] = f32(offsets[s] + (r * width + x) * 4);
        }
      }
    }
  }

  if (nodata !== null && Number.isFinite(nodata)) {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === nodata) grid[i] = NaN;
    }
  }

  /* Georeferencing: either a full 4x4 model transform, or the more
     common tiepoint-plus-scale pair. Both reduce to an origin at the
     north-west pixel corner and a pixel size. */
  let originE;
  let originN;
  let pixel = 1;
  const transform = values(TAG.MODEL_TRANSFORM);
  if (transform) {
    pixel = Math.abs(transform[0]);
    originE = transform[3];
    originN = transform[7];
  } else {
    const tie = values(TAG.MODEL_TIEPOINT);
    const scale = values(TAG.MODEL_SCALE);
    if (!tie || !scale) throw new Error('TIFF has no georeferencing');
    pixel = Math.abs(scale[0]);
    originE = tie[3] - tie[0] * scale[0];
    originN = tie[4] + tie[1] * scale[1];
  }

  return { width, height, grid, originE, originN, pixel };
}

module.exports = { readElevation, TAG };
