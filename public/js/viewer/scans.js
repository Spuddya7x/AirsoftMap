/* ------------------------------------------------------------------ *
 * Photoreal scans.
 *
 * LIDAR gives the ground and the trees, but it cannot give you the
 * cabin, or a bank you want to put sandbags on, or anything you would
 * rather look at than walk on. Those come off a phone: a slow walk
 * around the thing, processed into a Gaussian splat on the handset
 * itself, and dropped in here.
 *
 * Two things follow from that, and they shape all of this:
 *
 *   A scan need not be anywhere. One of a bedroom, taken to find out
 *   whether the idea works at all, has no position and never gets one.
 *   So placement is optional, and a scan with none opens on its own.
 *
 *   The export off the phone is enormous - a quarter of a gigabyte of
 *   PLY is normal - and almost all of that is spherical harmonics for
 *   view-dependent shine that a wood does not need. So the conversion
 *   happens here, in the browser, on the machine that already has the
 *   file, and only the compact result is uploaded.
 * ------------------------------------------------------------------ */

import * as THREE from 'three';
import * as GS from '/lib/splats/gaussian-splats-3d.module.js';

/* Everything the phone apps export, and the renderer's own format. */
export const ACCEPTS = '.spz,.ply,.splat,.ksplat';

const LOADERS = {
  spz: GS.SpzLoader,
  ply: GS.PlyLoader,
  splat: GS.SplatLoader,
  ksplat: GS.KSplatLoader,
};

/* Drop splats fainter than this: they are haze, and there are millions
   of them. Out of 255. */
const MIN_ALPHA = 5;
/* 0 none, 1 is the useful one: half the size, no visible difference. */
const COMPRESSION = 1;

export const extensionOf = (name) => String(name).toLowerCase().split('.').pop();

export function readableSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

/* ------------------------------------------------------------------ *
 * Getting one in
 * ------------------------------------------------------------------ */

/**
 * Turn whatever came off the phone into the compact format, without a
 * round trip to the server. Reports progress, because a large PLY takes
 * a while and silence looks like a hang.
 */
export async function convert(file, onProgress) {
  const ext = extensionOf(file.name);
  const Loader = LOADERS[ext];
  if (!Loader) {
    throw new Error('Cannot read a .' + ext + ' file. Export .spz or .ply from the scanning app.');
  }

  /* The loaders fetch by URL, so hand them the local file as one. */
  const url = URL.createObjectURL(file);
  try {
    const report = (pct) => onProgress && onProgress(Math.max(0, Math.min(100, pct || 0)));
    let buffer;
    if (ext === 'ksplat') {
      buffer = await Loader.loadFromURL(url, report);
    } else if (ext === 'spz') {
      buffer = await Loader.loadFromURL(url, report, MIN_ALPHA, COMPRESSION, true);
    } else {
      /* Ply and Splat take the progressive-load pair before the rest.
         Non-progressive, because the whole point is to get one finished
         buffer out the other side. */
      buffer = await Loader.loadFromURL(url, report, false, null, MIN_ALPHA, COMPRESSION, true, 0);
    }
    if (!buffer || !buffer.bufferData) throw new Error('nothing came out of that file');
    return buffer;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Send the converted scan to the room, so every viewer gets it. */
export async function upload(room, name, buffer) {
  const splats = typeof buffer.getSplatCount === 'function' ? buffer.getSplatCount() : 0;
  const res = await fetch('/api/room/' + encodeURIComponent(room) + '/scan'
    + '?name=' + encodeURIComponent(name)
    + '&splats=' + splats, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buffer.bufferData,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'the server would not take that scan');
  return body.scan;
}

/* ------------------------------------------------------------------ *
 * Showing one
 * ------------------------------------------------------------------ */

/**
 * Holds at most one splat scene at a time. Splats are expensive enough
 * that showing several at once on a laptop is not worth it, and looking
 * at one place is what this is for.
 */
export class Scans {
  constructor(scene) {
    this.scene = scene;
    this.viewer = null;
    this.showing = null;     // the scan record currently rendered
    this.busy = false;
  }

  get id() {
    return this.showing ? this.showing.id : null;
  }

  /**
   * Put a scan in the scene. Placement is optional: with one, it is
   * pinned to the ground at real coordinates; without, it sits at the
   * origin to be looked at on its own.
   */
  async show(scan, terrain) {
    await this.clear();
    this.busy = true;
    try {
      const viewer = new GS.DropInViewer({
        gpuAcceleratedSort: false,
        sharedMemoryForWorkers: false,   // needs headers we do not set
        /* Reveal it at once. The gradual fade counts frames through the
           renderer's own loop, and this scene is drawn by ours, so the
           count never advances and the splats never appear. */
        sceneRevealMode: GS.SceneRevealMode.Instant,
      });
      const options = { path: scan.url, splatAlphaRemovalThreshold: MIN_ALPHA };
      Object.assign(options, this.transformFor(scan, terrain));
      await viewer.addSplatScenes([options], false);
      this.viewer = viewer;
      this.showing = scan;
      this.scene.add(viewer);
      return viewer;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Where the scan sits in the world. A placed scan goes to its own
   * coordinates on the terrain; an unplaced one to the origin, which is
   * where a lone scan gets looked at.
   *
   * Splat files follow the convention the research code set, with y
   * pointing down, so by default they are turned over on the way in -
   * without that a bedroom arrives on its ceiling. Files that are
   * already the right way up can say so and skip it.
   */
  transformFor(scan, terrain) {
    const flip = scan.upsideDown === false
      ? new THREE.Quaternion()
      : new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));
    const p = scan.placed;
    if (!p || !terrain) {
      return { position: [0, 0, 0], rotation: flip.toArray(), scale: [1, 1, 1] };
    }
    const { x, z } = terrain.toWorld(p.lat, p.lng);
    const turn = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, -(p.rot || 0) * Math.PI / 180, 0)
    );
    const tilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((p.tilt || 0) * Math.PI / 180, 0, 0)
    );
    const s = p.scale || 1;
    return {
      position: [x, terrain.heightAt(x, z) + (p.lift || 0), z],
      rotation: turn.multiply(tilt).multiply(flip).toArray(),
      scale: [s, s, s],
    };
  }

  /**
   * The scan's real extent in world units. The group's own bounding box
   * is useless here - it measures an invisible marker sphere the
   * renderer keeps in the frustum to drive its sort - so ask the splat
   * mesh, which has to walk the centres to answer.
   */
  bounds() {
    const mesh = this.viewer && this.viewer.splatMesh;
    if (!mesh || !mesh.getSplatCount || !mesh.getSplatCount()) return null;
    try {
      const box = mesh.computeBoundingBox(true);
      return box && !box.isEmpty() ? box : null;
    } catch (err) {
      return null;
    }
  }

  async clear() {
    if (!this.viewer) return;
    const viewer = this.viewer;
    this.viewer = null;
    this.showing = null;
    this.scene.remove(viewer);
    try {
      await viewer.dispose();
    } catch (err) {
      /* Disposing mid-load throws; the scene is already rid of it. */
    }
  }
}
