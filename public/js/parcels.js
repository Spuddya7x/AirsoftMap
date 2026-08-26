/* ------------------------------------------------------------------ *
 * Land parcels.
 *
 * A title plan is a picture with no coordinates on it, so working out
 * where your boundary actually runs on the ground is guesswork. The
 * registered extent of every freehold title in England and Wales is
 * open data, though (HM Land Registry INSPIRE Index Polygons), and
 * scripts/inspire-to-geojson.js turns a district of it into GeoJSON.
 *
 * This puts that layer on the map: pan to your wood, tap the plots that
 * are yours, and adopt them as the site boundary that everyone in the
 * game can see.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  const { $ } = U;

  function Parcels(ctx) {
    this.ctx = ctx;
    this.meta = null;
    this.data = null;
    this.layer = null;
    this.selected = new Set();
    this.renderer = L.canvas({ padding: 0.2 });
    ctx.map.createPane('parcels');
    ctx.map.getPane('parcels').style.zIndex = 275;
  }

  const STYLE = {
    plain: { color: '#ff8a5a', weight: 1.5, opacity: 0.75, fill: true, fillOpacity: 0.03, fillColor: '#ff8a5a' },
    picked: { color: '#b6ff3a', weight: 3, opacity: 1, fill: true, fillOpacity: 0.2, fillColor: '#b6ff3a' },
  };

  Parcels.prototype.apply = async function (meta) {
    this.meta = meta;
    this.selected.clear();
    if (this.layer) { this.ctx.map.removeLayer(this.layer); this.layer = null; }
    this.refreshControls();
    if (!meta) { this.data = null; return; }

    try {
      const res = await fetch(meta.url);
      if (!res.ok) throw new Error('could not load the parcel layer');
      this.data = await res.json();
    } catch (err) {
      U.toast('PARCELS FAILED TO LOAD: ' + err.message, 4000);
      return;
    }
    if (this.ctx.state.opts.parcels !== false) this.show();
    this.refreshControls();
  };

  Parcels.prototype.show = function () {
    if (!this.data || this.layer) return;
    this.layer = L.geoJSON(this.data, {
      pane: 'parcels',
      renderer: this.renderer,
      style: () => STYLE.plain,
      onEachFeature: (feature, layer) => {
        layer.on('click', (ev) => {
          L.DomEvent.stop(ev);
          this.pick(feature, layer);
        });
      },
    }).addTo(this.ctx.map);
  };

  Parcels.prototype.hide = function () {
    if (this.layer) { this.ctx.map.removeLayer(this.layer); this.layer = null; }
    this.selected.clear();
    this.refreshSheet();
  };

  Parcels.prototype.setVisible = function (on) {
    if (on) this.show(); else this.hide();
  };

  /** Tap toggles a plot in or out of the selection. */
  Parcels.prototype.pick = function (feature, layer) {
    const id = feature.properties.id;
    if (this.selected.has(id)) {
      this.selected.delete(id);
      layer.setStyle(STYLE.plain);
    } else {
      this.selected.add(id);
      layer.setStyle(STYLE.picked);
      layer.bringToFront();
    }
    this.refreshSheet();
  };

  Parcels.prototype.selectedFeatures = function () {
    if (!this.data) return [];
    return this.data.features.filter((f) => this.selected.has(f.properties.id));
  };

  Parcels.prototype.totalArea = function () {
    return this.selectedFeatures().reduce((sum, f) => sum + (f.properties.areaM2 || 0), 0);
  };

  Parcels.prototype.refreshSheet = function () {
    const sheet = $('#parcelsheet');
    if (!this.selected.size) { sheet.classList.add('hidden'); return; }
    const m2 = this.totalArea();
    $('#parcel-count').textContent = this.selected.size + (this.selected.size === 1 ? ' plot' : ' plots');
    $('#parcel-area').textContent =
      (m2 / 10000).toFixed(2) + ' ha  /  ' + (m2 / 4046.856).toFixed(2) + ' acres';
    sheet.classList.remove('hidden');
  };

  /**
   * Turn the picked plots into zones everyone can see.
   * shape 'boundary' is land you own; 'permit' is land you are allowed
   * to play on but do not own.
   */
  Parcels.prototype.adopt = function (shape) {
    const features = this.selectedFeatures();
    if (!features.length) return;
    const fallback = ICONS.SHAPES.find((s) => s.key === (shape || 'boundary')) ||
                     ICONS.SHAPES.find((s) => s.key === 'boundary');
    let sent = 0;
    for (const f of features) {
      /* A parcel file can carry its own zoning ("zone": "permit"), in
         which case it wins over the button that was pressed - so a file
         marked up elsewhere can be adopted in one go. */
      const zoned = f.properties && f.properties.zone;
      const kind = ICONS.SHAPES.find((s) => s.key === zoned) || fallback;
      const rings = f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates.map((poly) => poly[0])
        : [f.geometry.coordinates[0]];
      for (const ring of rings) {
        const points = ring.map(([lng, lat]) => ({ lat, lng }));
        if (points.length < 3) continue;
        this.ctx.net.send({
          t: 'draw:add',
          shape: kind.key,
          color: kind.color,
          label: kind.name,
          points: points.slice(0, 400),
        });
        sent++;
      }
    }
    U.toast(sent + ' PLOT' + (sent === 1 ? '' : 'S') + ' MARKED', 3500);
    this.clearSelection();
  };

  Parcels.prototype.clearSelection = function () {
    this.selected.clear();
    if (this.layer) this.layer.setStyle(STYLE.plain);
    this.refreshSheet();
  };

  /* --- upload --------------------------------------------------------- */

  Parcels.prototype.upload = async function (file) {
    if (!file) return;
    if (file.size > 22 * 1024 * 1024) return U.toast('PARCEL FILE IS TOO BIG (22MB MAX)');
    U.toast('UPLOADING PARCELS...');
    const room = encodeURIComponent(this.ctx.state.me.room);
    try {
      const res = await fetch('/api/room/' + room + '/parcels?name=' +
        encodeURIComponent(file.name.slice(0, 40)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/geo+json' },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'upload failed');
      await this.apply(body.parcels);
      U.toast(body.parcels.count + ' PARCELS LOADED - TAP YOURS', 4000);
    } catch (err) {
      U.toast('UPLOAD FAILED: ' + err.message, 4000);
    }
  };

  Parcels.prototype.remove = function () {
    if (!this.meta) return;
    if (!confirm('Remove the parcel layer for everyone?')) return;
    this.ctx.net.send({ t: 'parcels:clear' });
    this.apply(null);
  };

  Parcels.prototype.refreshControls = function () {
    const has = !!this.meta;
    $('#parcel-name').textContent = has
      ? this.meta.name + ' (' + this.meta.count + ' plots)'
      : 'no parcel layer loaded';
    $('#btn-parcels-clear').disabled = !has;
    $('#opt-parcels').disabled = !has;
  };

  Parcels.prototype.bind = function () {
    $('#parcel-file').addEventListener('change', (ev) => {
      this.upload(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });
    $('#btn-parcels-clear').addEventListener('click', () => this.remove());
    $('#btn-parcel-mine').addEventListener('click', () => this.adopt('boundary'));
    $('#btn-parcel-play').addEventListener('click', () => this.adopt('permit'));
    $('#btn-parcel-cancel').addEventListener('click', () => this.clearSelection());
    this.refreshControls();
  };

  global.Parcels = Parcels;
})(window);
