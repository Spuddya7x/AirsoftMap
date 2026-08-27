/* ------------------------------------------------------------------ *
 * A Gaussian splat scene, built rather than captured.
 *
 * The scan pipeline needs something to chew on that behaves like a real
 * phone capture: the layout the research code established, binary
 * little-endian, spherical-harmonic colour, log scales, inverse-sigmoid
 * opacity, and y pointing down. Generating one keeps the test suite off
 * the network and out of the business of storing a binary fixture.
 *
 * The scene is a small room, because a room is what someone trying this
 * for the first time will scan.
 * ------------------------------------------------------------------ */

'use strict';

const SH_C0 = 0.28209479177387814;

/** Colour to the zeroth spherical-harmonic coefficient. */
const toSH = (c) => (c - 0.5) / SH_C0;
/** Opacity to what the format stores, which is put through a sigmoid. */
const toLogit = (a) => Math.log(a / (1 - a));

const PROPERTIES = [
  'x', 'y', 'z', 'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
];

/**
 * A room 5 m x 4 m x 2.5 m: floor, ceiling, four walls, a window hole
 * and two blocks, so that up, down and which-way-round are all
 * decidable from the result.
 */
function room(step) {
  const splats = [];
  const put = (x, y, z, r, g, b, size) => splats.push({ x, y, z, r, g, b, size });

  for (let x = -2.5; x <= 2.5; x += step) {
    for (let z = -2; z <= 2; z += step) {
      put(x, 0, z, 0.42, 0.35, 0.30, 0.05);
      put(x, 2.5, z, 0.80, 0.79, 0.76, 0.06);
    }
  }
  for (let x = -2.5; x <= 2.5; x += step) {
    for (let y = 0; y <= 2.5; y += step) {
      put(x, y, -2, 0.72, 0.70, 0.64, 0.05);
      put(x, y, 2, 0.70, 0.68, 0.62, 0.05);
    }
  }
  for (let z = -2; z <= 2; z += step) {
    for (let y = 0; y <= 2.5; y += step) {
      put(-2.5, y, z, 0.66, 0.64, 0.60, 0.05);
      const window = y > 0.9 && y < 1.9 && z > -0.7 && z < 0.7;
      if (!window) put(2.5, y, z, 0.68, 0.66, 0.61, 0.05);
    }
  }
  for (let x = -2.4; x <= -0.6; x += step) {
    for (let z = -1.8; z <= -0.3; z += step) put(x, 0.55, z, 0.30, 0.36, 0.52, 0.04);
  }
  for (let y = 0; y <= 1.9; y += step) {
    for (let z = 0.6; z <= 1.8; z += step) put(2.1, y, z, 0.48, 0.33, 0.22, 0.04);
  }
  return splats;
}

/**
 * @param {number} step spacing in metres; coarser makes a smaller file.
 * @returns {{buffer: Buffer, count: number, extent: object}}
 */
function makeSplatPly(step = 0.12) {
  const splats = room(step);
  const header = 'ply\nformat binary_little_endian 1.0\n'
    + 'element vertex ' + splats.length + '\n'
    + PROPERTIES.map((p) => 'property float ' + p).join('\n')
    + '\nend_header\n';

  const body = Buffer.alloc(splats.length * PROPERTIES.length * 4);
  let at = 0;
  const put = (v) => { body.writeFloatLE(v, at); at += 4; };
  for (const s of splats) {
    /* Y down, which is the convention every splat file follows. */
    put(s.x); put(-s.y); put(s.z);
    put(0); put(0); put(1);
    put(toSH(s.r)); put(toSH(s.g)); put(toSH(s.b));
    put(toLogit(0.92));
    put(Math.log(s.size)); put(Math.log(s.size)); put(Math.log(s.size));
    put(1); put(0); put(0); put(0);
  }

  return {
    buffer: Buffer.concat([Buffer.from(header, 'ascii'), body]),
    count: splats.length,
    /* What it should measure once the viewer has turned it upright. */
    extent: { x: [-2.5, 2.5], y: [0, 2.5], z: [-2, 2] },
  };
}

module.exports = { makeSplatPly };
