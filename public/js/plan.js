/* ------------------------------------------------------------------ *
 * Site plans.
 *
 * Satellite imagery stops at the surface. For an indoor or underground
 * site the basemap has to be your own drawing: a survey PDF exported to
 * PNG, a hand sketch, a photo of a whiteboard. This module lays that
 * image over the map, lets one person scale, rotate and place it, and
 * pushes the placement to everyone else.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  const { $, el } = U;

  /* Leaflet's ImageOverlay cannot rotate, and site plans are almost never
     drawn north-up, so bolt rotation on after it positions the image. */
  const RotatedImage = L.ImageOverlay.extend({
    _reset() {
      L.ImageOverlay.prototype._reset.call(this);
      const deg = this.options.rotation || 0;
      if (deg && this._image) {
        this._image.style.transformOrigin = '50% 50%';
        this._image.style.transform += ' rotate(' + deg + 'deg)';
      }
    },
  });

  function SitePlan(ctx) {
    this.ctx = ctx;
    this.plan = null;
    this.layer = null;
    this.handle = null;
    this.placing = false;
    ctx.map.createPane('siteplan');
    ctx.map.getPane('siteplan').style.zIndex = 250;
  }

  SitePlan.prototype.bounds = function (plan) {
    const centre = { lat: plan.lat, lng: plan.lng };
    const halfW = plan.widthM / 2;
    const halfH = (plan.widthM * plan.aspect) / 2;
    const n = U.destination(centre, 0, halfH).lat;
    const s = U.destination(centre, 180, halfH).lat;
    const e = U.destination(centre, 90, halfW).lng;
    const w = U.destination(centre, 270, halfW).lng;
    return L.latLngBounds([[s, w], [n, e]]);
  };

  /** Show (or update, or remove) the plan everyone shares. */
  SitePlan.prototype.apply = function (plan) {
    this.plan = plan;
    if (this.layer) { this.ctx.map.removeLayer(this.layer); this.layer = null; }
    if (!plan) { this.stopPlacing(); this.refreshControls(); return; }

    this.layer = new RotatedImage(plan.url, this.bounds(plan), {
      opacity: plan.opacity != null ? plan.opacity : 1,
      rotation: plan.rotation || 0,
      interactive: false,
      pane: 'siteplan',
      className: 'site-plan-image',
    }).addTo(this.ctx.map);

    if (this.placing) this.moveHandle();
    this.refreshControls();
  };

  SitePlan.prototype.fit = function () {
    if (this.plan) this.ctx.map.fitBounds(this.bounds(this.plan), { padding: [20, 20] });
  };

  /* --- upload --------------------------------------------------------- */

  SitePlan.prototype.upload = async function (file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) return U.toast('PLAN IMAGE IS TOO BIG (15MB MAX)');

    const dims = await imageSize(file).catch(() => null);
    if (!dims) return U.toast('COULD NOT READ THAT IMAGE');

    const map = this.ctx.map;
    const centre = map.getCenter();
    const view = map.getBounds();
    /* Start it roughly the width of the current view, so it is visible
       straight away and only needs nudging. */
    const widthM = Math.max(20, Math.round(map.distance(
      L.latLng(centre.lat, view.getWest()), L.latLng(centre.lat, view.getEast())
    ) * 0.8));

    U.toast('UPLOADING PLAN...');
    const room = encodeURIComponent(this.ctx.state.me.room);
    const params = new URLSearchParams({
      lat: centre.lat, lng: centre.lng, widthM,
      aspect: dims.height / dims.width,
      name: file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40),
    });

    try {
      const res = await fetch('/api/room/' + room + '/plan?' + params, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'upload failed');
      this.apply(body.plan);
      this.startPlacing();
      U.toast('PLAN UPLOADED - NOW SCALE AND PLACE IT');
    } catch (err) {
      U.toast('UPLOAD FAILED: ' + err.message, 4000);
    }
  };

  function imageSize(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth || 1000, height: img.naturalHeight || 1000 });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  /* --- placement ------------------------------------------------------ */

  SitePlan.prototype.startPlacing = function () {
    if (!this.plan) return U.toast('NO SITE PLAN UPLOADED YET');
    this.placing = true;
    $('#plansheet').classList.remove('hidden');
    this.moveHandle();
    this.refreshControls();
  };

  SitePlan.prototype.stopPlacing = function () {
    this.placing = false;
    $('#plansheet').classList.add('hidden');
    if (this.handle) { this.ctx.map.removeLayer(this.handle); this.handle = null; }
  };

  SitePlan.prototype.moveHandle = function () {
    if (!this.plan) return;
    const at = [this.plan.lat, this.plan.lng];
    if (!this.handle) {
      this.handle = L.marker(at, {
        draggable: true,
        zIndexOffset: 2000,
        icon: L.divIcon({
          className: 'mk',
          iconSize: [40, 40],
          iconAnchor: [20, 20],
          html: '<svg width="40" height="40" viewBox="0 0 40 40">' +
                '<circle cx="20" cy="20" r="16" fill="rgba(4,10,6,.6)" stroke="#b6ff3a" stroke-width="2" stroke-dasharray="4 3"/>' +
                '<path d="M20 6v28M6 20h28" stroke="#b6ff3a" stroke-width="1.5"/></svg>',
        }),
      }).addTo(this.ctx.map);
      this.handle.on('drag', () => {
        const ll = this.handle.getLatLng();
        this.plan.lat = ll.lat;
        this.plan.lng = ll.lng;
        if (this.layer) this.layer.setBounds(this.bounds(this.plan));
      });
      this.handle.on('dragend', () => this.push());
    } else {
      this.handle.setLatLng(at);
    }
  };

  /** Send the current placement to everyone. */
  SitePlan.prototype.push = function () {
    if (!this.plan) return;
    this.ctx.net.send({
      t: 'site:set',
      lat: this.plan.lat, lng: this.plan.lng,
      widthM: this.plan.widthM, rotation: this.plan.rotation,
      opacity: this.plan.opacity,
    });
  };

  SitePlan.prototype.update = function (patch) {
    if (!this.plan) return;
    Object.assign(this.plan, patch);
    this.apply(this.plan);
    this.push();
  };

  SitePlan.prototype.clear = function () {
    if (!this.plan) return;
    if (!confirm('Remove the site plan for everyone?')) return;
    this.ctx.net.send({ t: 'site:clear' });
    this.stopPlacing();
    this.apply(null);
  };

  SitePlan.prototype.refreshControls = function () {
    const has = !!this.plan;
    $('#plan-name').textContent = has ? this.plan.name : 'no site plan loaded';
    $('#btn-plan-place').disabled = !has;
    $('#btn-plan-fit').disabled = !has;
    $('#btn-plan-clear').disabled = !has;
    if (!has) return;
    $('#plan-width').value = Math.round(this.plan.widthM);
    $('#plan-width-out').textContent = Math.round(this.plan.widthM) + ' m wide';
    $('#plan-rot').value = Math.round(this.plan.rotation || 0);
    $('#plan-rot-out').textContent = Math.round(this.plan.rotation || 0) + '°';
    $('#plan-op').value = Math.round((this.plan.opacity != null ? this.plan.opacity : 1) * 100);
  };

  /** Wire the settings + placement controls once at startup. */
  SitePlan.prototype.bind = function () {
    $('#plan-file').addEventListener('change', (ev) => {
      this.upload(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });
    $('#btn-plan-place').addEventListener('click', () => {
      if (this.placing) this.stopPlacing(); else this.startPlacing();
    });
    $('#btn-plan-fit').addEventListener('click', () => this.fit());
    $('#btn-plan-clear').addEventListener('click', () => this.clear());
    $('#plan-width').addEventListener('input', (ev) => {
      const v = Number(ev.target.value);
      $('#plan-width-out').textContent = v + ' m wide';
      if (this.plan) { this.plan.widthM = v; if (this.layer) this.layer.setBounds(this.bounds(this.plan)); }
    });
    $('#plan-width').addEventListener('change', () => this.push());
    $('#plan-rot').addEventListener('input', (ev) => {
      const v = Number(ev.target.value);
      $('#plan-rot-out').textContent = v + '°';
      if (this.plan) { this.plan.rotation = v; this.apply(this.plan); }
    });
    $('#plan-rot').addEventListener('change', () => this.push());
    $('#plan-op').addEventListener('input', (ev) => {
      const v = Number(ev.target.value) / 100;
      if (this.plan) { this.plan.opacity = v; if (this.layer) this.layer.setOpacity(v); }
    });
    $('#plan-op').addEventListener('change', () => this.push());
    $('#btn-plan-done').addEventListener('click', () => this.stopPlacing());
    this.refreshControls();
  };

  global.SitePlan = SitePlan;
})(window);
