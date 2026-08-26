/* ------------------------------------------------------------------ *
 * Terrain.
 *
 * Satellite imagery of woodland is a green blanket: it tells you nothing
 * about the shape of the ground, which is most of what matters when you
 * are planning where people can move, see and hold. So rather than
 * hunting for a contour map, this builds one.
 *
 * Elevation comes from the AWS Terrain Tiles open dataset (SRTM and
 * national surveys, packed into "terrarium" PNGs where the height in
 * metres is (R * 256 + G + B / 256) - 32768). From that grid we derive:
 *
 *   - contour lines, by marching squares
 *   - hillshade, so the ground reads as shape rather than colour
 *   - the height under any point
 *   - a ground profile between two points, for line of sight
 *
 * Tiles are ~30m resolution: honest for the shape of the ground, no
 * substitute for LIDAR. If you have LIDAR for your site, export a
 * contour or hillshade image from QGIS and load it as a site plan -
 * that path already exists and needs no reprojection code here.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_SIZE = 256;
  const MAX_DEM_ZOOM = 15;      // the dataset stops here
  const MIN_DEM_ZOOM = 10;
  const MAX_TILES = 30;         // per refresh, so a wide view cannot stall
  const CACHE_LIMIT = 48;       // decoded tiles kept in memory
  const MAX_GRID = 420;         // grid nodes per side before we stride

  function Terrain(opts) {
    this.map = opts.map;
    /* Overridable so a site can point at its own elevation tile server
       (and so the tests can serve a known surface). */
    this.tileUrl = opts.tileUrl || TILE_URL;
    this.tiles = new Map();       // "z/x/y" -> Float32Array | null (missing)
    this.grid = null;             // last grid built, reused for lookups
    this.opts = {
      contours: false, hillshade: false, interval: 10, opacity: 0.55,
    };
    this.layer = L.layerGroup();
    this.renderer = L.canvas({ padding: 0.3 });
    this.shade = null;
    this.busy = false;
    this.pending = false;

    this.map.createPane('terrain');
    this.map.getPane('terrain').style.zIndex = 260;
    this.map.createPane('contours');
    this.map.getPane('contours').style.zIndex = 270;
    this.map.getPane('contours').style.pointerEvents = 'none';
  }

  /* ------------------------------------------------------------------ *
   * Elevation tiles
   * ------------------------------------------------------------------ */

  Terrain.prototype.demZoom = function () {
    return Math.max(MIN_DEM_ZOOM, Math.min(MAX_DEM_ZOOM, Math.round(this.map.getZoom())));
  };

  Terrain.prototype.tileKey = (z, x, y) => z + '/' + x + '/' + y;

  Terrain.prototype.loadTile = async function (z, x, y) {
    const key = this.tileKey(z, x, y);
    if (this.tiles.has(key)) return this.tiles.get(key);

    const url = this.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    let heights = null;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) {
        const bitmap = await createImageBitmap(await res.blob());
        const canvas = document.createElement('canvas');
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
        const px = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
        heights = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
          heights[i] = (px[p] * 256 + px[p + 1] + px[p + 2] / 256) - 32768;
        }
        if (bitmap.close) bitmap.close();
      }
    } catch (err) {
      heights = null;   // offline, or the tile does not exist
    }

    /* Simple bounded cache: elevation does not change, so anything we
       have decoded is worth keeping until we need the memory. */
    if (this.tiles.size >= CACHE_LIMIT) {
      this.tiles.delete(this.tiles.keys().next().value);
    }
    this.tiles.set(key, heights);
    return heights;
  };

  /** Every tile URL covering these bounds, for offline pre-caching. */
  Terrain.prototype.tileUrls = function (bounds, zoom) {
    const z = zoom || this.demZoom();
    const nw = this.map.project(bounds.getNorthWest(), z).divideBy(TILE_SIZE).floor();
    const se = this.map.project(bounds.getSouthEast(), z).divideBy(TILE_SIZE).floor();
    const urls = [];
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        urls.push(this.tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
    return urls;
  };

  /* ------------------------------------------------------------------ *
   * Sampling a grid over the current view
   * ------------------------------------------------------------------ */

  Terrain.prototype.buildGrid = async function (bounds) {
    const z = this.demZoom();
    const nw = this.map.project(bounds.getNorthWest(), z);
    const se = this.map.project(bounds.getSouthEast(), z);
    const x0 = Math.floor(nw.x);
    const y0 = Math.floor(nw.y);
    const spanX = Math.max(2, Math.ceil(se.x - nw.x));
    const spanY = Math.max(2, Math.ceil(se.y - nw.y));
    const step = Math.max(1, Math.ceil(Math.max(spanX, spanY) / MAX_GRID));
    const cols = Math.floor(spanX / step) + 1;
    const rows = Math.floor(spanY / step) + 1;

    const tx0 = Math.floor(x0 / TILE_SIZE);
    const ty0 = Math.floor(y0 / TILE_SIZE);
    const tx1 = Math.floor((x0 + spanX) / TILE_SIZE);
    const ty1 = Math.floor((y0 + spanY) / TILE_SIZE);
    const wanted = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) wanted.push([tx, ty]);
    }
    if (wanted.length > MAX_TILES) return null;    // zoom in first
    await Promise.all(wanted.map(([tx, ty]) => this.loadTile(z, tx, ty)));

    const data = new Float32Array(cols * rows);
    let min = Infinity;
    let max = -Infinity;
    let known = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const px = x0 + i * step;
        const py = y0 + j * step;
        const tile = this.tiles.get(this.tileKey(z, Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE)));
        let h = NaN;
        if (tile) {
          const ix = ((px % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
          const iy = ((py % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
          h = tile[iy * TILE_SIZE + ix];
          if (h > -400 && h < 9000) {
            known++;
            if (h < min) min = h;
            if (h > max) max = h;
          } else {
            h = NaN;
          }
        }
        data[j * cols + i] = h;
      }
    }
    if (!known) return null;

    const metresPerPixel = 156543.03392 * Math.cos(bounds.getCenter().lat * Math.PI / 180) / Math.pow(2, z);
    return {
      z, x0, y0, step, cols, rows, data, min, max,
      cell: metresPerPixel * step,
      at: (i, j) => data[j * cols + i],
      latLng: (i, j) => this.map.unproject(L.point(x0 + i * step, y0 + j * step), z),
    };
  };

  /* ------------------------------------------------------------------ *
   * Contours (marching squares)
   * ------------------------------------------------------------------ */

  function contourSegments(grid, level) {
    const segs = [];
    const { cols, rows, at } = grid;
    const cross = (v1, v2) => (level - v1) / (v2 - v1);

    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const tl = at(i, j);
        const tr = at(i + 1, j);
        const br = at(i + 1, j + 1);
        const bl = at(i, j + 1);
        if (Number.isNaN(tl) || Number.isNaN(tr) || Number.isNaN(br) || Number.isNaN(bl)) continue;

        let code = 0;
        if (tl > level) code |= 8;
        if (tr > level) code |= 4;
        if (br > level) code |= 2;
        if (bl > level) code |= 1;
        if (code === 0 || code === 15) continue;

        /* Edge crossing points, in grid coordinates. */
        const top = () => [i + cross(tl, tr), j];
        const right = () => [i + 1, j + cross(tr, br)];
        const bottom = () => [i + cross(bl, br), j + 1];
        const left = () => [i, j + cross(tl, bl)];

        switch (code) {
          case 1: case 14: segs.push([left(), bottom()]); break;
          case 2: case 13: segs.push([bottom(), right()]); break;
          case 3: case 12: segs.push([left(), right()]); break;
          case 4: case 11: segs.push([top(), right()]); break;
          case 6: case 9: segs.push([top(), bottom()]); break;
          case 7: case 8: segs.push([left(), top()]); break;
          case 5:   /* saddle: resolve with the cell average */
            if ((tl + tr + br + bl) / 4 > level) {
              segs.push([left(), top()], [bottom(), right()]);
            } else {
              segs.push([left(), bottom()], [top(), right()]);
            }
            break;
          case 10:
            if ((tl + tr + br + bl) / 4 > level) {
              segs.push([left(), bottom()], [top(), right()]);
            } else {
              segs.push([left(), top()], [bottom(), right()]);
            }
            break;
          default: break;
        }
      }
    }
    return segs;
  }

  /** Chain loose segments into polylines so they can be styled and labelled. */
  function joinSegments(segs) {
    const key = (p) => p[0].toFixed(3) + ',' + p[1].toFixed(3);
    const ends = new Map();
    for (const seg of segs) {
      for (const end of [0, 1]) {
        const k = key(seg[end]);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(seg);
      }
    }
    const used = new Set();
    const lines = [];

    for (const seg of segs) {
      if (used.has(seg)) continue;
      used.add(seg);
      const line = [seg[0], seg[1]];

      /* Walk forwards, then backwards, from this seed segment. */
      for (const dir of [1, 0]) {
        let grow = true;
        while (grow) {
          grow = false;
          const tip = dir ? line[line.length - 1] : line[0];
          for (const cand of ends.get(key(tip)) || []) {
            if (used.has(cand)) continue;
            const next = key(cand[0]) === key(tip) ? cand[1] : cand[0];
            used.add(cand);
            if (dir) line.push(next); else line.unshift(next);
            grow = true;
            break;
          }
        }
      }
      if (line.length > 1) lines.push(line);
    }
    return lines;
  }

  Terrain.prototype.drawContours = function (grid) {
    const interval = this.opts.interval;
    const first = Math.ceil(grid.min / interval) * interval;
    const levels = [];
    for (let l = first; l <= grid.max; l += interval) levels.push(l);
    if (levels.length > 120) return { levels: 0 };   // interval far too fine

    let labelled = 0;
    for (const level of levels) {
      const index = Math.abs(level % (interval * 5)) < 1e-6;   // every 5th, drawn heavier
      const lines = joinSegments(contourSegments(grid, level));
      for (const line of lines) {
        if (line.length < 3) continue;
        const latlngs = line.map(([i, j]) => grid.latLng(i, j));
        const poly = L.polyline(latlngs, {
          color: index ? '#f0b060' : '#c98a4b',
          weight: index ? 1.8 : 1,
          opacity: index ? 0.85 : 0.6,
          interactive: false,
          pane: 'contours',
          renderer: this.renderer,
          smoothFactor: 1.2,
        });
        this.layer.addLayer(poly);

        if (index && line.length > 24 && labelled < 24) {
          labelled++;
          poly.bindTooltip(Math.round(level) + 'm', {
            permanent: true,
            direction: 'center',
            className: 'contour-label',
            offset: [0, 0],
          });
        }
      }
    }
    return { levels: levels.length };
  };

  /* ------------------------------------------------------------------ *
   * Hillshade
   * ------------------------------------------------------------------ */

  Terrain.prototype.drawHillshade = function (grid, bounds) {
    const { cols, rows, at, cell } = grid;
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(cols, rows);

    const azimuth = (315 * Math.PI) / 180;
    const zenith = (45 * Math.PI) / 180;
    const zFactor = 1.6;   // a little vertical exaggeration; woodland is subtle

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const o = (j * cols + i) * 4;
        const c = at(i, j);
        if (Number.isNaN(c)) { img.data[o + 3] = 0; continue; }

        const l = at(Math.max(i - 1, 0), j);
        const r = at(Math.min(i + 1, cols - 1), j);
        const u = at(i, Math.max(j - 1, 0));
        const d = at(i, Math.min(j + 1, rows - 1));
        if (Number.isNaN(l) || Number.isNaN(r) || Number.isNaN(u) || Number.isNaN(d)) {
          img.data[o + 3] = 0;
          continue;
        }

        const dzdx = ((r - l) / (2 * cell)) * zFactor;
        const dzdy = ((d - u) / (2 * cell)) * zFactor;
        const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        let shade = Math.cos(zenith) * Math.cos(slope) +
                    Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect);
        shade = Math.max(0, Math.min(1, shade));

        /* Paint the shadows only, so imagery underneath still shows. */
        img.data[o] = 0;
        img.data[o + 1] = 0;
        img.data[o + 2] = 0;
        img.data[o + 3] = Math.round((1 - shade) * 255 * this.opts.opacity);
      }
    }
    ctx.putImageData(img, 0, 0);

    if (this.shade) this.map.removeLayer(this.shade);
    this.shade = L.imageOverlay(canvas.toDataURL('image/png'), bounds, {
      opacity: 1, interactive: false, pane: 'terrain', className: 'hillshade-image',
    }).addTo(this.map);
  };

  /* ------------------------------------------------------------------ *
   * Refresh
   * ------------------------------------------------------------------ */

  Terrain.prototype.setOptions = function (patch) {
    Object.assign(this.opts, patch);
    return this.refresh();
  };

  Terrain.prototype.clear = function () {
    this.layer.clearLayers();
    if (this.shade) { this.map.removeLayer(this.shade); this.shade = null; }
  };

  Terrain.prototype.refresh = async function () {
    if (!this.opts.contours && !this.opts.hillshade) {
      this.clear();
      if (this.map.hasLayer(this.layer)) this.map.removeLayer(this.layer);
      return { off: true };
    }
    if (this.busy) { this.pending = true; return { busy: true }; }
    this.busy = true;

    let result = { ok: false };
    try {
      const bounds = this.map.getBounds().pad(0.1);
      const grid = await this.buildGrid(bounds);
      this.clear();
      if (!grid) {
        result = { ok: false, reason: this.map.getZoom() < MIN_DEM_ZOOM ? 'zoom in' : 'no elevation data here' };
      } else {
        this.grid = grid;
        if (!this.map.hasLayer(this.layer)) this.layer.addTo(this.map);
        if (this.opts.hillshade) this.drawHillshade(grid, bounds);
        const drawn = this.opts.contours ? this.drawContours(grid) : { levels: 0 };
        result = {
          ok: true,
          min: grid.min, max: grid.max, levels: drawn.levels,
          resolution: Math.round(grid.cell),
        };
      }
    } catch (err) {
      result = { ok: false, reason: err.message };
    } finally {
      this.busy = false;
      if (this.pending) { this.pending = false; setTimeout(() => this.refresh(), 50); }
    }
    return result;
  };

  /* ------------------------------------------------------------------ *
   * Point and profile queries
   * ------------------------------------------------------------------ */

  /** Height in metres under a point, or null if we have no data for it. */
  Terrain.prototype.elevationAt = function (latlng) {
    const z = this.demZoom();
    const p = this.map.project(L.latLng(latlng.lat, latlng.lng), z);
    const tile = this.tiles.get(this.tileKey(z, Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE)));
    if (!tile) return null;
    const ix = Math.floor(((p.x % TILE_SIZE) + TILE_SIZE) % TILE_SIZE);
    const iy = Math.floor(((p.y % TILE_SIZE) + TILE_SIZE) % TILE_SIZE);
    const h = tile[iy * TILE_SIZE + ix];
    return (h > -400 && h < 9000) ? h : null;
  };

  /** Make sure the tiles under a point are loaded, then read the height. */
  Terrain.prototype.elevationAtAsync = async function (latlng) {
    const z = this.demZoom();
    const p = this.map.project(L.latLng(latlng.lat, latlng.lng), z);
    await this.loadTile(z, Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE));
    return this.elevationAt(latlng);
  };

  /**
   * Ground profile between two points.
   * Returns { samples: [{ d, elev, lat, lng }], ok } with d in metres.
   */
  Terrain.prototype.profile = async function (from, to, count) {
    const n = Math.max(16, Math.min(300, count || 120));
    const total = this.map.distance(L.latLng(from.lat, from.lng), L.latLng(to.lat, to.lng));
    const z = this.demZoom();

    /* Load every tile the line passes over before sampling. */
    const a = this.map.project(L.latLng(from.lat, from.lng), z);
    const b = this.map.project(L.latLng(to.lat, to.lng), z);
    const needed = new Set();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = Math.floor((a.x + (b.x - a.x) * t) / TILE_SIZE);
      const y = Math.floor((a.y + (b.y - a.y) * t) / TILE_SIZE);
      needed.add(x + ',' + y);
    }
    await Promise.all([...needed].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return this.loadTile(z, x, y);
    }));

    const samples = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const at = this.map.unproject(L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), z);
      samples.push({ d: total * t, elev: this.elevationAt(at), lat: at.lat, lng: at.lng });
    }
    return { samples, total, ok: samples.some((s) => s.elev != null) };
  };

  /**
   * Can someone standing at `from` see `to`?
   * eyeHeight / targetHeight are metres above the ground (default 1.6m,
   * i.e. someone standing up).
   */
  Terrain.prototype.lineOfSight = async function (from, to, eyeHeight, targetHeight) {
    const prof = await this.profile(from, to);
    if (!prof.ok) return { ok: false };
    const eye = (prof.samples[0].elev || 0) + (eyeHeight == null ? 1.6 : eyeHeight);
    const target = (prof.samples[prof.samples.length - 1].elev || 0) +
                   (targetHeight == null ? 1.6 : targetHeight);
    const total = prof.total || 1;

    let blocked = null;
    let worst = 0;
    for (const s of prof.samples.slice(1, -1)) {
      if (s.elev == null) continue;
      const sightLine = eye + ((target - eye) * s.d) / total;
      const clearance = sightLine - s.elev;
      if (clearance < 0 && (blocked === null || clearance < worst)) {
        if (blocked === null) blocked = s;
        if (clearance < worst) { worst = clearance; }
      }
    }
    return {
      ok: true,
      visible: blocked === null,
      blockedAt: blocked,
      byMetres: Math.abs(Math.round(worst * 10) / 10),
      profile: prof,
      eye,
      target,
    };
  };

  Terrain.TILE_URL = TILE_URL;
  global.Terrain = Terrain;
})(window);
