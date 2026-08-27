/* ------------------------------------------------------------------ *
 * The ground.
 *
 * Built from the file scripts/fetch-terrain.js writes: a grid of
 * 16-bit centimetres over England's 1 m LIDAR, which resolves anything
 * about two metres across and a hand's breadth high. Banks, ditches,
 * holloways, the stream channel, the old boundary bank - all of it is
 * in there, and none of it is visible on an aerial photograph of a
 * wood.
 *
 * World axes are the national grid, in metres from the north-west
 * corner of the tile: x runs east, z runs south, y is height above the
 * lowest point on the site. Working in the grid rather than a local
 * frame matters here - at this longitude grid north is nearly two
 * degrees off true north, which is nine metres of skew across a site
 * this size.
 * ------------------------------------------------------------------ */

import * as THREE from 'three';

export class Terrain {
  constructor(site, heights) {
    this.site = site;
    this.grid = site.grid;
    this.heights = heights;              // Int16Array, centimetres above base
    this.width = this.grid.width;
    this.height = this.grid.height;
    this.pixel = this.grid.pixel;
    this.base = this.grid.base;
    this.spanX = this.width * this.pixel;
    this.spanZ = this.height * this.pixel;

    const f = site.frame;
    /* Inverse of the 2x2 that takes degrees to grid metres. */
    const det = f.dEdLat * f.dNdLng - f.dEdLng * f.dNdLat;
    this.inverse = {
      dLatdE: f.dNdLng / det,
      dLatdN: -f.dEdLng / det,
      dLngdE: -f.dNdLat / det,
      dLngdN: f.dEdLat / det,
    };
  }

  static async load(name) {
    const [site, bin] = await Promise.all([
      fetch('/data/' + name + '.site.json').then((r) => {
        if (!r.ok) throw new Error('no terrain built for "' + name + '"');
        return r.json();
      }),
      fetch('/data/' + name + '.heights.bin').then((r) => {
        if (!r.ok) throw new Error('the height grid for "' + name + '" is missing');
        return r.arrayBuffer();
      }),
    ]);
    const expected = site.grid.width * site.grid.height;
    const heights = new Int16Array(bin);
    if (heights.length !== expected) {
      throw new Error('height grid is ' + heights.length + ' cells, expected ' + expected);
    }
    return new Terrain(site, heights);
  }

  /* --- coordinates ---------------------------------------------------- */

  /** Latitude and longitude to world metres. */
  toWorld(lat, lng) {
    const f = this.site.frame;
    const dLat = lat - f.lat;
    const dLng = lng - f.lng;
    const E = f.E + dLat * f.dEdLat + dLng * f.dEdLng;
    const N = f.N + dLat * f.dNdLat + dLng * f.dNdLng;
    return { x: E - this.grid.originE, z: this.grid.originN - N };
  }

  /** World metres back to latitude and longitude. */
  toLatLng(x, z) {
    const f = this.site.frame;
    const dE = (x + this.grid.originE) - f.E;
    const dN = (this.grid.originN - z) - f.N;
    const i = this.inverse;
    return {
      lat: f.lat + dE * i.dLatdE + dN * i.dLatdN,
      lng: f.lng + dE * i.dLngdE + dN * i.dLngdN,
    };
  }

  /** Raw grid height in metres above the site's lowest point. */
  cell(col, row) {
    const c = Math.max(0, Math.min(this.width - 1, col));
    const r = Math.max(0, Math.min(this.height - 1, row));
    return this.heights[r * this.width + c] / 100;
  }

  /**
   * Ground height at any point, interpolated. Everything that sits on
   * the terrain - a tree, a cabin, the camera in walk mode - asks this
   * rather than the grid, so nothing floats or sinks between samples.
   */
  heightAt(x, z) {
    const fx = x / this.pixel - 0.5;
    const fz = z / this.pixel - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = this.cell(x0, z0);
    const h10 = this.cell(x0 + 1, z0);
    const h01 = this.cell(x0, z0 + 1);
    const h11 = this.cell(x0 + 1, z0 + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Height above sea level, for anything that has to be labelled. */
  elevationAt(x, z) {
    return this.base + this.heightAt(x, z);
  }

  /** Steepness in degrees, which is what decides where you can build. */
  slopeAt(x, z) {
    const d = this.pixel;
    const dx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const dz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
  }

  /* --- mesh ----------------------------------------------------------- */

  /**
   * One vertex per LIDAR sample, shaded by aspect and steepness so the
   * landform reads without any imagery draped over it. Under a canopy
   * there is no useful imagery anyway - every aerial photograph of this
   * place is a picture of the tops of trees.
   */
  build() {
    const { width: W, height: H, pixel } = this;
    const verts = new Float32Array(W * H * 3);
    const colours = new Float32Array(W * H * 3);

    /* Horn's operator over the eight neighbours, lit from the north-west
       out of habit: it is the convention every printed relief map uses,
       and reading a hill the wrong way round is a real and easy mistake. */
    const sun = new THREE.Vector3(-0.5, 0.75, -0.43).normalize();
    const low = new THREE.Color('#4a5442');
    const high = new THREE.Color('#8d9678');
    const scratch = new THREE.Color();
    const span = Math.max(1, (this.grid.max - this.grid.min));

    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        const h = this.cell(c, r);
        verts[i * 3] = (c + 0.5) * pixel;
        verts[i * 3 + 1] = h;
        verts[i * 3 + 2] = (r + 0.5) * pixel;

        const dzdx = ((this.cell(c + 1, r - 1) + 2 * this.cell(c + 1, r) + this.cell(c + 1, r + 1))
          - (this.cell(c - 1, r - 1) + 2 * this.cell(c - 1, r) + this.cell(c - 1, r + 1)))
          / (8 * pixel);
        const dzdy = ((this.cell(c - 1, r + 1) + 2 * this.cell(c, r + 1) + this.cell(c + 1, r + 1))
          - (this.cell(c - 1, r - 1) + 2 * this.cell(c, r - 1) + this.cell(c + 1, r - 1)))
          / (8 * pixel);
        const nx = -dzdx;
        const nz = -dzdy;
        const len = Math.hypot(nx, 1, nz);
        /* Stretched hard on purpose. The real range of shading over a
           one-in-six slope is narrow, and a faithful version of it is a
           flat green rectangle: this is a relief map, and it has to
           show relief. */
        const raw = (nx * sun.x + sun.y + nz * sun.z) / len;
        const lit = Math.max(0.30, Math.min(1.35, 0.5 + (raw - 0.5) * 2.6));

        scratch.copy(low).lerp(high, Math.min(1, h / span)).multiplyScalar(lit);
        colours[i * 3] = scratch.r;
        colours[i * 3 + 1] = scratch.g;
        colours[i * 3 + 2] = scratch.b;
      }
    }

    const quads = (W - 1) * (H - 1);
    const index = quads * 6 > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    let n = 0;
    for (let r = 0; r < H - 1; r++) {
      for (let c = 0; c < W - 1; c++) {
        const a = r * W + c;
        const b = a + 1;
        const d = a + W;
        const e = d + 1;
        index[n++] = a; index[n++] = d; index[n++] = b;
        index[n++] = b; index[n++] = d; index[n++] = e;
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geom.setIndex(new THREE.BufferAttribute(index, 1));
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    }));
    mesh.name = 'ground';
    mesh.receiveShadow = true;
    return mesh;
  }
}
