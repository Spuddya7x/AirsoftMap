/* AirsoftMap - main application. */
(function () {
  'use strict';

  const { $, $$, el, store, toast } = U;
  const PLUSMINUS = String.fromCharCode(177);

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const state = {
    me: null,                 // { id, callsign, team, role, room }
    joined: false,
    players: new Map(),       // id -> player data (mine included)
    layers: { players: new Map(), accuracy: new Map(), trails: new Map() },
    markers: new Map(),       // id -> { data, layer }
    drawings: new Map(),      // id -> { data, layer[] }
    mode: null,               // null | 'marker' | 'draw'
    pendingLatLng: null,      // long-press position for the next marker
    draft: { shape: 'line', points: [], layer: null },
    detailId: null,
    lastFix: null,
    lastSent: 0,
    battery: null,
    wakeLock: null,
    demo: null,
    /* Defaults merged with whatever was stored, so options added in a later
       version still appear for players who used an earlier one. */
    opts: Object.assign({
      trails: false, accuracy: true, labels: true, lock: false, wake: true,
      snap: false, nobase: false, pdrEnabled: false, aim: true,
    }, store.get('opts', {})),
    /* How we currently believe we know where we are. */
    nav: {
      mode: store.get('posmode', 'auto'),  // auto | indoor | manual
      fix: null,        // { lat, lng, acc, src, ts }
      anchor: null,     // last position we actually trusted
      drDistance: 0,    // metres dead reckoned since that anchor
    },
  };

  /* Motion sensors: only useful where there is no satellite fix. */
  const pdr = PDR.supported() ? new PDR() : null;
  if (pdr) pdr.k = store.get('pdrK', pdr.k);

  /* ------------------------------------------------------------------ *
   * Map + base layers
   * ------------------------------------------------------------------ */

  const map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    tap: true,
    zoomSnap: 0.5,
    worldCopyJump: false,
  }).setView([51.5, -1.5], 5);

  L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);

  const BASES = {
    SATELLITE: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 19, maxZoom: 22, attribution: 'Imagery &copy; Esri' }
    ),
    TOPO: L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png',
      { maxNativeZoom: 17, maxZoom: 20, attribution: '&copy; OpenTopoMap (CC-BY-SA)' }),
    STREET: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxNativeZoom: 19, maxZoom: 21, attribution: '&copy; OpenStreetMap contributors' }),
  };
  const LABELS = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxNativeZoom: 19, maxZoom: 22, opacity: 0.8 }
  );

  let baseName = store.get('base', 'SATELLITE');
  if (!BASES[baseName]) baseName = 'SATELLITE';
  BASES[baseName].addTo(map);
  let labelsOn = store.get('labels-layer', false);
  if (labelsOn) LABELS.addTo(map);

  function setBase(name) {
    if (!BASES[name] || name === baseName) return;
    map.removeLayer(BASES[baseName]);
    baseName = name;
    BASES[name].addTo(map);
    store.set('base', name);
    renderLayerButtons();
    if (labelsOn) LABELS.bringToFront();
  }

  function renderLayerButtons() {
    const box = $('#layer-buttons');
    box.innerHTML = '';
    for (const name of Object.keys(BASES)) {
      box.appendChild(el('button', {
        class: 'btn' + (name === baseName ? ' on' : ''),
        text: name,
        onclick: () => setBase(name),
      }));
    }
    box.appendChild(el('button', {
      class: 'btn' + (labelsOn ? ' on' : ''),
      text: 'PLACE NAMES',
      onclick: () => {
        labelsOn = !labelsOn;
        if (labelsOn) LABELS.addTo(map); else map.removeLayer(LABELS);
        store.set('labels-layer', labelsOn);
        renderLayerButtons();
      },
    }));
  }

  /* Panes so players always sit above intel markers. */
  map.createPane('intel');   map.getPane('intel').style.zIndex = 620;
  map.createPane('players'); map.getPane('players').style.zIndex = 640;

  /* ------------------------------------------------------------------ *
   * Network
   * ------------------------------------------------------------------ */

  const net = new Net();
  const sitePlan = new SitePlan({ map, net, state });

  net.on('link', ({ up }) => {
    $('#link-dot').className = 'dot ' + (up ? 'ok' : 'bad');
    $('#link-text').textContent = up ? 'LINK' : 'NO LINK';
    // A fix taken before the socket opened (or during a dropout) would
    // otherwise be lost, leaving us invisible until we next move.
    if (up) sendPosition(true);
  });

  net.on('welcome', (msg) => {
    state.joined = true;
    $('#chip-room').textContent = msg.room;
    applySnapshot(msg);
    applyPendingFix();
    sendPosition(true);
    toast('JOINED ' + msg.room + (msg.teamLock ? ' (TEAM ONLY)' : ''));
  });

  /** Wipe everything the server owns, keeping anything local to demo mode. */
  function clearWorld() {
    for (const [id, p] of [...state.players]) {
      if (!p.demo && !isMe(id)) removePlayer(id);
    }
    for (const [id, rec] of [...state.markers]) if (!rec.data.demo) removeMarker(id);
    for (const [id, rec] of [...state.drawings]) if (!rec.data.demo) removeDrawing(id);
  }

  function applySnapshot(msg) {
    for (const p of msg.players || []) upsertPlayer(p);
    for (const m of msg.markers || []) upsertMarker(m);
    for (const d of msg.drawings || []) upsertDrawing(d);
    sitePlan.apply(msg.plan || null);
    $('#opt-teamlock').checked = !!msg.teamLock;
    renderRoster();
    refreshStationsIfOpen();
  }

  net.on('player', (msg) => { upsertPlayer(msg.player); renderRoster(); });
  net.on('pos', (msg) => {
    const p = state.players.get(msg.id);
    if (!p) return;
    Object.assign(p, msg, { stale: false, online: true });
    drawPlayer(p);
    renderRoster();
  });
  net.on('leave', (msg) => { removePlayer(msg.id); renderRoster(); });
  net.on('marker', (msg) => upsertMarker(msg.marker));
  net.on('marker:del', (msg) => removeMarker(msg.id));
  net.on('draw', (msg) => upsertDrawing(msg.drawing));
  net.on('draw:del', (msg) => removeDrawing(msg.id));
  net.on('ping:map', (msg) => {
    showPing(msg);
    if (msg.by && msg.by !== (state.me && state.me.callsign)) toast(msg.by + ' PINGED THE MAP');
  });
  net.on('msg', (msg) => toast(msg.by + ': ' + msg.text, 4000));
  net.on('resync', (msg) => {
    clearWorld();
    applySnapshot(msg);
    toast(msg.teamLock ? 'TEAM ONLY: OTHER TEAMS ARE NOW HIDDEN' : 'ALL TEAMS VISIBLE', 3500);
  });

  net.on('site', (msg) => {
    sitePlan.apply(msg.plan);
    if (msg.plan) toast('SITE PLAN UPDATED');
  });

  /* ------------------------------------------------------------------ *
   * Players
   * ------------------------------------------------------------------ */

  const isMe = (id) => state.me && id === state.me.id;

  function upsertPlayer(p) {
    const existing = state.players.get(p.id);
    const merged = Object.assign({}, existing || {}, p);
    state.players.set(p.id, merged);
    drawPlayer(merged);
  }

  function removePlayer(id) {
    state.players.delete(id);
    for (const group of ['players', 'accuracy', 'trails']) {
      const layer = state.layers[group].get(id);
      if (layer) { map.removeLayer(layer); state.layers[group].delete(id); }
    }
  }

  function drawPlayer(p) {
    if (p.lat == null || p.lng == null) return;
    const mine = isMe(p.id);
    const ll = [p.lat, p.lng];

    let marker = state.layers.players.get(p.id);
    if (!marker) {
      marker = L.marker(ll, { icon: ICONS.playerIcon(p, mine), pane: 'players', zIndexOffset: mine ? 1000 : 0 });
      marker.on('click', (ev) => {
        if (state.mode === 'draw') return addDraftPoint(ev.latlng);
        focusPlayer(p.id);
      });
      marker.addTo(map);
      state.layers.players.set(p.id, marker);
    } else {
      marker.setLatLng(ll);
      marker.setIcon(ICONS.playerIcon(p, mine));
    }

    /* accuracy ring */
    let ring = state.layers.accuracy.get(p.id);
    if (state.opts.accuracy && p.acc != null && p.acc > 4) {
      const color = mine ? '#b6ff3a' : ICONS.teamColor(p.team);
      const dashed = p.src === 'dr' ? '5 6' : null;
      if (!ring) {
        ring = L.circle(ll, {
          radius: p.acc, color, weight: 1, opacity: 0.5, dashArray: dashed,
          fillColor: color, fillOpacity: 0.06, interactive: false,
        });
        ring.addTo(map);
        state.layers.accuracy.set(p.id, ring);
      } else {
        ring.setLatLng(ll);
        ring.setRadius(p.acc);
        ring.setStyle({ color, dashArray: dashed });
      }
    } else if (ring) {
      map.removeLayer(ring);
      state.layers.accuracy.delete(p.id);
    }

    /* movement trail */
    if (state.opts.trails) {
      let trail = state.layers.trails.get(p.id);
      if (!trail) {
        trail = L.polyline([ll], {
          color: mine ? '#b6ff3a' : ICONS.teamColor(p.team),
          weight: 2, opacity: 0.45, interactive: false, dashArray: '4 5',
        }).addTo(map);
        state.layers.trails.set(p.id, trail);
      } else {
        const pts = trail.getLatLngs();
        const last = pts[pts.length - 1];
        if (!last || map.distance(last, ll) > 4) {
          pts.push(L.latLng(ll));
          if (pts.length > 300) pts.shift();
          trail.setLatLngs(pts);
        }
      }
    }
  }

  function focusPlayer(id) {
    const p = state.players.get(id);
    if (!p || p.lat == null) return toast('NO FIX FOR THAT PLAYER');
    map.panTo([p.lat, p.lng]);
    const me = state.players.get(state.me.id);
    const d = U.distance(me, p);
    if (d != null) toast(p.callsign + '  ' + U.fmtDist(d) + '  ' + U.compass(U.bearing(me, p)));
  }

  /* Age players out visually even when nothing arrives. */
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const p of state.players.values()) {
      const stale = !p.ts || now - p.ts > 90000;
      if (stale !== !!p.stale) { p.stale = stale; drawPlayer(p); changed = true; }
    }
    if (changed || state.players.size) renderRoster();
  }, 10000);

  /* ------------------------------------------------------------------ *
   * Markers
   * ------------------------------------------------------------------ */

  function upsertMarker(m) {
    const existing = state.markers.get(m.id);
    if (existing) {
      existing.data = m;
      existing.layer.setLatLng([m.lat, m.lng]);
      existing.layer.setIcon(ICONS.markerIcon(m));
      return;
    }
    const layer = L.marker([m.lat, m.lng], {
      icon: ICONS.markerIcon(m),
      pane: 'intel',
      draggable: !m.demo,
    });
    layer.on('click', (ev) => {
      if (state.mode === 'draw') return addDraftPoint(ev.latlng);
      openDetail(m.id);
    });
    layer.on('dragend', () => {
      const ll = layer.getLatLng();
      const rec = state.markers.get(m.id);
      if (!rec) return;
      rec.data.lat = ll.lat;
      rec.data.lng = ll.lng;
      if (!rec.data.demo) net.send({ t: 'marker:update', id: m.id, lat: ll.lat, lng: ll.lng });
    });
    layer.addTo(map);
    state.markers.set(m.id, { data: m, layer });
    if (m.kind === 'station') refreshStationsIfOpen();
  }

  function refreshStationsIfOpen() {
    if (!$('#stationsheet').classList.contains('hidden')) renderStations();
  }

  function removeMarker(id) {
    const rec = state.markers.get(id);
    if (!rec) return;
    map.removeLayer(rec.layer);
    state.markers.delete(id);
    if (state.detailId === id) closeSheets();
  }

  /* ------------------------------------------------------------------ *
   * The crosshair
   *
   * On a phone, one finger drags the crosshair and two fingers move the
   * map. That way you can put the crosshair exactly where you mean -
   * on a doorway, on the treeline - without your thumb covering it, and
   * every "drop it here" action uses that point.
   * ------------------------------------------------------------------ */

  const aim = { point: null, dragging: false, startedAt: null };
  const FINGER_OFFSET = 64;   // px above the fingertip, so you can see it

  /** Default crosshair position: middle of the map still visible above a sheet. */
  function defaultAimPoint() {
    const size = map.getSize();
    const sheet = $$('.sheet').find((n) => !n.classList.contains('hidden'));
    const covered = sheet ? Math.max(0, size.y - sheet.getBoundingClientRect().top) : 0;
    return L.point(size.x / 2, (size.y - covered) / 2);
  }

  function aimLatLng() {
    if (state.pendingLatLng) return state.pendingLatLng;
    const pt = (state.opts.aim && aim.point) ? aim.point : defaultAimPoint();
    return map.containerPointToLatLng(pt);
  }

  function positionCrosshair(pt) {
    const p = pt || (state.opts.aim && aim.point) || defaultAimPoint();
    aim.point = p;
    const node = $('#crosshair');
    node.style.left = p.x + 'px';
    node.style.top = p.y + 'px';
    updateAimReadout();
  }

  function updateAimReadout() {
    const node = $('#aim-readout');
    if (!node || $('#crosshair').classList.contains('hidden')) return;
    const at = aimLatLng();
    const me = state.nav.fix;
    const d = U.distance(me, at);
    node.textContent = d == null ? '--'
      : U.fmtDist(d) + ' ' + U.compass(U.bearing(me, at));
  }

  function crosshairVisible() {
    return !!state.opts.aim || state.mode === 'marker';
  }

  function refreshCrosshair() {
    const show = state.joined && crosshairVisible();
    $('#crosshair').classList.toggle('hidden', !show);
    if (show) positionCrosshair(state.mode === 'marker' && !state.opts.aim ? defaultAimPoint() : null);
  }

  function setAimMode(on) {
    state.opts.aim = on;
    store.set('opts', state.opts);
    if (on && L.Browser.touch) map.dragging.disable();
    else map.dragging.enable();
    refreshCrosshair();
  }

  /* One finger drags the crosshair; anything with two fingers falls through
     to Leaflet, which pans and zooms the map together. */
  (function bindAimTouch() {
    const box = map.getContainer();
    let startX = 0;
    let startY = 0;

    box.addEventListener('touchstart', (ev) => {
      if (!state.opts.aim || ev.touches.length !== 1) { aim.dragging = false; return; }
      startX = ev.touches[0].clientX;
      startY = ev.touches[0].clientY;
      aim.startedAt = Date.now();
      aim.dragging = false;
    }, { passive: true });

    box.addEventListener('touchmove', (ev) => {
      if (!state.opts.aim || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      if (!aim.dragging && Math.hypot(t.clientX - startX, t.clientY - startY) < 8) return;
      aim.dragging = true;
      ev.preventDefault();
      const box2 = box.getBoundingClientRect();
      const x = Math.max(12, Math.min(box2.width - 12, t.clientX - box2.left));
      const y = Math.max(12, Math.min(box2.height - 12, t.clientY - box2.top - FINGER_OFFSET));
      positionCrosshair(L.point(x, y));
    }, { passive: false });

    box.addEventListener('touchend', () => {
      /* A tap is not a drag: let it reach the map so drawing still works. */
      setTimeout(() => { aim.dragging = false; }, 0);
    }, { passive: true });
  })();

  map.on('move zoom', updateAimReadout);

  function dropMarker(kindKey, latlng) {
    const k = ICONS.kind(kindKey);
    const at = latlng || state.pendingLatLng || aimLatLng();
    net.send({ t: 'marker:add', kind: k.key, label: k.name, lat: at.lat, lng: at.lng });
    state.pendingLatLng = null;
    toast(k.name + ' DROPPED');
  }

  /* ------------------------------------------------------------------ *
   * Drawings
   * ------------------------------------------------------------------ */

  function upsertDrawing(d) {
    removeDrawing(d.id, true);
    const pts = d.points.map((p) => [p.lat, p.lng]);
    const layers = [];

    if (d.shape === 'area' || d.shape === 'boundary') {
      layers.push(L.polygon(pts, {
        color: d.color,
        weight: d.shape === 'boundary' ? 3 : 2,
        dashArray: d.shape === 'boundary' ? '10 8' : null,
        fillOpacity: d.shape === 'boundary' ? 0.04 : 0.14,
        fillColor: d.color,
        pane: 'intel',
      }));
    } else {
      layers.push(L.polyline(pts, { color: d.color, weight: 4, opacity: 0.9, pane: 'intel' }));
      if (d.shape === 'arrow' && pts.length >= 2) {
        const a = d.points[d.points.length - 2];
        const b = d.points[d.points.length - 1];
        const brg = U.bearing(a, b) || 0;
        layers.push(L.marker(pts[pts.length - 1], {
          pane: 'intel',
          interactive: false,
          icon: L.divIcon({
            className: 'mk',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            html: '<svg width="22" height="22" viewBox="0 0 22 22" style="transform:rotate(' + brg + 'deg)">' +
                  '<polygon points="11,1 19,19 11,14 3,19" fill="' + d.color + '"/></svg>',
          }),
        }));
      }
    }

    const label = d.label || d.shape.toUpperCase();
    layers[0].bindTooltip(label, { permanent: false, direction: 'top', className: 'mk-label' });
    if (!d.demo) {
      layers[0].on('click', (ev) => {
        L.DomEvent.stop(ev);
        if (state.mode === 'draw') return addDraftPoint(ev.latlng);
        const km = U.fmtDist(U.pathLength(d.points));
        const popup = el('div', {}, [
          el('div', { text: label + '  (' + km + ')', style: 'margin-bottom:6px' }),
          el('button', {
            class: 'btn danger',
            text: 'DELETE',
            onclick: () => { net.send({ t: 'draw:del', id: d.id }); map.closePopup(); },
          }),
        ]);
        L.popup({ className: 'am-popup' }).setLatLng(ev.latlng).setContent(popup).openOn(map);
      });
    }

    for (const layer of layers) layer.addTo(map);
    state.drawings.set(d.id, { data: d, layers });
  }

  function removeDrawing(id, quiet) {
    const rec = state.drawings.get(id);
    if (!rec) return;
    for (const layer of rec.layers) map.removeLayer(layer);
    state.drawings.delete(id);
    if (!quiet) return;
  }

  /* --- draft drawing -------------------------------------------------- */

  function draftShapeDef() {
    return ICONS.SHAPES.find((s) => s.key === state.draft.shape) || ICONS.SHAPES[0];
  }

  function redrawDraft() {
    const d = state.draft;
    if (d.layer) { map.removeLayer(d.layer); d.layer = null; }
    const def = draftShapeDef();
    if (d.points.length >= 2) {
      const pts = d.points.map((p) => [p.lat, p.lng]);
      d.layer = (d.shape === 'area' || d.shape === 'boundary')
        ? L.polygon(pts, { color: def.color, weight: 2, dashArray: '6 6', fillOpacity: 0.1, interactive: false })
        : L.polyline(pts, { color: def.color, weight: 4, dashArray: '8 6', opacity: 0.95, interactive: false });
      d.layer.addTo(map);
    } else if (d.points.length === 1) {
      d.layer = L.circleMarker([d.points[0].lat, d.points[0].lng], {
        radius: 5, color: def.color, interactive: false,
      }).addTo(map);
    }
    const len = U.fmtDist(U.pathLength(d.points));
    $('#draw-readout').textContent = d.points.length + ' points  ' +
      (d.points.length > 1 ? ('/ ' + len + (d.shape === 'area' || d.shape === 'boundary' ? ' perimeter' : '')) : '');
  }

  function saveDraft() {
    const d = state.draft;
    if (d.points.length < 2) return toast('NEED AT LEAST 2 POINTS');
    const def = draftShapeDef();
    const label = prompt('Label for this ' + def.name.toLowerCase() + ' (optional)') || '';
    net.send({ t: 'draw:add', shape: d.shape, color: def.color, label, points: d.points });
    clearDraft();
    setMode(null);
    toast(def.name + ' SAVED');
  }

  function addDraftPoint(latlng) {
    state.draft.points.push({ lat: latlng.lat, lng: latlng.lng });
    redrawDraft();
  }

  function clearDraft() {
    if (state.draft.layer) map.removeLayer(state.draft.layer);
    state.draft.layer = null;
    state.draft.points = [];
    redrawDraft();
  }

  /* ------------------------------------------------------------------ *
   * Map pings
   * ------------------------------------------------------------------ */

  function showPing(at) {
    const ring = L.marker([at.lat, at.lng], {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [40, 40], iconAnchor: [20, 20], html: '<div class="ping-ring" style="width:40px;height:40px"></div>' }),
    }).addTo(map);
    setTimeout(() => map.removeLayer(ring), 5200);
  }

  /* ------------------------------------------------------------------ *
   * Geolocation
   * ------------------------------------------------------------------ */

  let watchId = null;

  function startTracking() {
    if (!navigator.geolocation) {
      $('#gps-dot').className = 'dot bad';
      $('#gps-text').textContent = 'NO GPS';
      return toast('THIS DEVICE HAS NO GPS');
    }
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 20000,
    });
  }

  function onFix(pos) {
    const c = pos.coords;
    const fix = { lat: c.latitude, lng: c.longitude };
    let hdg = (c.heading != null && !Number.isNaN(c.heading) && (c.speed || 0) > 0.4) ? c.heading : null;
    if (hdg == null && state.lastFix && (U.distance(state.lastFix, fix) || 0) > 4) {
      hdg = U.bearing(state.lastFix, fix);
    }
    if (hdg == null && state.me) {
      const prev = state.players.get(state.me.id);
      hdg = prev ? prev.hdg : null;
    }
    state.lastFix = fix;
    const acc = c.accuracy != null ? Math.round(c.accuracy) : null;
    state.gnss = { lat: fix.lat, lng: fix.lng, acc, ts: Date.now() };

    if (!state.me) return;
    /* Indoors and underground a satellite fix is either absent or a lie.
       In those modes we ignore it entirely; in auto we drop obvious junk. */
    if (state.nav.mode !== 'auto') return refreshFixChip();
    if (acc != null && acc > 60) return refreshFixChip();
    setFix({ lat: fix.lat, lng: fix.lng, acc, hdg, spd: c.speed || 0, src: 'gps' });
  }

  /** Push our position to the server, at most once a second. */
  function sendPosition(force) {
    if (!state.lastPayload || !state.me) return;
    const now = Date.now();
    if (!force && now - state.lastSent < 1000) return;
    state.lastSent = now;
    net.send(Object.assign({}, state.lastPayload, { batt: state.battery }));
  }

  function onFixError(err) {
    state.gnss = null;
    refreshFixChip();
    if (err.code === 1) toast('LOCATION PERMISSION DENIED - OTHERS CANNOT SEE YOU', 5000);
  }

  /* ------------------------------------------------------------------ *
   * Position engine
   *
   * Everything that can say where a player is funnels through setFix: a
   * satellite fix, a check-in at a known station, a dead-reckoned step,
   * or a position placed by hand. Each carries an honest accuracy, so
   * the map can show how much of it to believe.
   * ------------------------------------------------------------------ */

  function setFix(f) {
    if (!state.me) return;
    const now = Date.now();
    const trusted = f.src !== 'dr';

    state.nav.fix = { lat: f.lat, lng: f.lng, acc: f.acc, src: f.src, ts: now };
    if (trusted) {
      state.nav.anchor = { lat: f.lat, lng: f.lng, ts: now, src: f.src };
      state.nav.drDistance = 0;
      if (pdr) pdr.beginLeg();
    }

    const mine = Object.assign(state.players.get(state.me.id) || {}, {
      id: state.me.id, callsign: state.me.callsign, team: state.me.team, role: state.me.role,
      lat: f.lat, lng: f.lng, acc: f.acc,
      hdg: f.hdg != null ? f.hdg : (pdr && pdr.heading != null ? pdr.heading : null),
      spd: f.spd || 0, src: f.src, batt: state.battery,
      ts: now, online: true, stale: false,
    });
    state.players.set(state.me.id, mine);
    drawPlayer(mine);

    state.lastPayload = {
      t: 'pos', lat: f.lat, lng: f.lng, acc: f.acc, hdg: mine.hdg,
      spd: mine.spd, src: f.src, batt: state.battery,
    };
    sendPosition(false);

    if (state.opts.lock) map.panTo([f.lat, f.lng], { animate: true, duration: 0.4 });
    if (!state.centredOnce) {
      state.centredOnce = true;
      map.setView([f.lat, f.lng], 18);
    }
    refreshFixChip();
    renderRoster();
  }

  /** One detected step: move the estimate along, and widen the error. */
  function advanceDR(metres, heading) {
    const fix = state.nav.fix;
    if (!fix || !state.me || state.nav.mode === 'manual') return;

    state.nav.drDistance += metres;
    let next = fix;
    /* No compass reading means we know they moved but not which way, so
       the blip stays put and only the uncertainty grows. */
    if (heading != null) {
      next = U.destination(fix, heading, metres);
      if (state.opts.snap) next = snapToRoutes(next) || next;
    }
    setFix({
      lat: next.lat, lng: next.lng, src: 'dr', hdg: heading, spd: 0,
      acc: Math.round(PDR.uncertainty(state.nav.drDistance, pdr ? pdr.headingJitter : 0)),
    });
  }

  /** Pull a dead-reckoned position onto the nearest drawn route, if close.
   *  In a tunnel you are on the tunnel, which kills most of the drift. */
  function snapToRoutes(at) {
    let best = null;
    let bestDist = 25;    // metres; past this, trust the sensors instead
    for (const rec of state.drawings.values()) {
      const d = rec.data;
      if (d.shape !== 'line' && d.shape !== 'arrow') continue;
      for (let i = 1; i < d.points.length; i++) {
        const hit = nearestOnSegment(at, d.points[i - 1], d.points[i]);
        if (hit && hit.dist < bestDist) { bestDist = hit.dist; best = hit.point; }
      }
    }
    return best;
  }

  /** Closest point on segment a-b to p, worked in local metres. */
  function nearestOnSegment(p, a, b) {
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(U.rad(p.lat));
    const px = (p.lng - a.lng) * mPerDegLng;
    const py = (p.lat - a.lat) * mPerDegLat;
    const bx = (b.lng - a.lng) * mPerDegLng;
    const by = (b.lat - a.lat) * mPerDegLat;
    const len2 = bx * bx + by * by;
    if (!len2) return null;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
    const cx = bx * t;
    const cy = by * t;
    return {
      dist: Math.hypot(px - cx, py - cy),
      point: { lat: a.lat + cy / mPerDegLat, lng: a.lng + cx / mPerDegLng },
    };
  }

  function refreshFixChip() {
    const f = state.nav.fix;
    const dot = $('#gps-dot');
    const text = $('#gps-text');
    if (!f) {
      dot.className = 'dot bad';
      text.textContent = state.gnss ? 'GPS ' + (state.gnss.acc || '?') + 'm' : 'NO FIX';
      return;
    }
    const age = Date.now() - f.ts;
    if (f.src === 'dr') {
      dot.className = 'dot warn';
      text.textContent = 'DR ' + PLUSMINUS + Math.round(f.acc) + 'm';
    } else if (f.src === 'anchor' || f.src === 'manual') {
      dot.className = 'dot ' + (age > 240000 ? 'warn' : 'ok');
      text.textContent = (f.src === 'anchor' ? 'FIX ' : 'SET ') + U.fmtAge(age);
    } else {
      const acc = f.acc;
      dot.className = 'dot ' + (acc == null ? 'warn' : acc <= 12 ? 'ok' : acc <= 30 ? 'warn' : 'bad');
      text.textContent = acc == null ? 'GPS' : 'GPS ' + acc + 'm';
    }
  }

  /* ------------------------------------------------------------------ *
   * Stations: known points you stand on to reset the drift
   * ------------------------------------------------------------------ */

  function stations() {
    return [...state.markers.values()].map((r) => r.data).filter((m) => m.kind === 'station');
  }

  function renderStations() {
    const list = $('#station-list');
    list.innerHTML = '';
    const from = state.nav.fix;
    const found = stations().sort((a, b) => {
      const da = U.distance(from, a);
      const db = U.distance(from, b);
      return (da == null ? 1e9 : da) - (db == null ? 1e9 : db);
    });

    if (!found.length) {
      list.appendChild(el('li', {
        html: '<span class="station-name">No stations yet. Walk the site once and drop a' +
              ' STATION marker at every junction, doorway and landmark. Those are the points' +
              ' people check in at when there is no GPS.</span>',
      }));
      return;
    }

    for (const st of found) {
      const d = U.distance(from, st);
      const li = el('li', { onclick: () => { checkIn(st); closeSheets(); setMode(null); } });
      li.innerHTML =
        '<span class="station-code">' + U.escapeHtml((st.label || 'ST').slice(0, 6)) + '</span>' +
        '<span class="station-name">' + U.escapeHtml(st.note || st.label || 'STATION') + '</span>' +
        '<span class="station-range">' + (d == null ? '' : U.fmtDist(d)) + '</span>';
      list.appendChild(li);
    }
  }

  /** Standing at a known point: snap there, and learn this player's stride. */
  function checkIn(st) {
    const prev = state.nav.anchor;
    let extra = '';
    if (pdr && pdr.running && prev && prev.src === 'anchor') {
      const k = pdr.calibrate(U.distance(prev, st));
      if (k) {
        store.set('pdrK', k);
        extra = ' / STRIDE CALIBRATED';
      }
    }
    setFix({ lat: st.lat, lng: st.lng, acc: PDR.DRIFT_FLOOR, src: 'anchor' });
    toast('FIXED AT ' + (st.label || 'STATION') + extra, 3000);
  }

  /** A ?fix=CODE link, i.e. a QR code printed and stuck to a wall. */
  function applyPendingFix() {
    const code = params.get('fix');
    if (!code) return;
    const st = stations().find((m) => (m.label || '').toUpperCase() === code.toUpperCase());
    if (st) checkIn(st);
    else toast('STATION ' + code.toUpperCase() + ' IS NOT ON THIS MAP', 4000);
  }

  async function scanNfc() {
    if (!('NDEFReader' in window)) {
      return toast('THIS PHONE CANNOT READ NFC TAGS FROM THE BROWSER', 4000);
    }
    try {
      const reader = new NDEFReader();
      await reader.scan();
      toast('HOLD THE PHONE AGAINST THE TAG', 5000);
      reader.onreading = (ev) => {
        const decoder = new TextDecoder();
        for (const rec of ev.message.records) {
          let text = '';
          try { text = decoder.decode(rec.data); } catch (err) { continue; }
          const code = (text.match(/fix=([A-Za-z0-9-]+)/) || [null, text.trim()])[1];
          const st = stations().find((m) => (m.label || '').toUpperCase() === String(code).toUpperCase());
          if (st) { checkIn(st); closeSheets(); return; }
        }
        toast('TAG DOES NOT MATCH A STATION ON THIS MAP', 4000);
      };
    } catch (err) {
      toast('NFC UNAVAILABLE: ' + err.message, 4000);
    }
  }

  /* battery, for the roster readout */
  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const read = () => { state.battery = b.level; };
      read();
      b.addEventListener('levelchange', read);
    }).catch(() => {});
  }

  /* keep the screen on during a game */
  async function requestWakeLock() {
    if (!state.opts.wake || !('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch { /* denied or unsupported */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!state.wakeLock) requestWakeLock();
      if (state.joined) net.open();
    }
  });

  /* ------------------------------------------------------------------ *
   * Roster
   * ------------------------------------------------------------------ */

  function renderRoster() {
    const list = $('#roster-list');
    const me = state.me ? state.players.get(state.me.id) : null;
    const players = [...state.players.values()].sort((a, b) => {
      if (isMe(a.id)) return -1;
      if (isMe(b.id)) return 1;
      if (a.team !== b.team) return String(a.team).localeCompare(String(b.team));
      return String(a.callsign).localeCompare(String(b.callsign));
    });

    $('#roster-count').textContent = players.filter((p) => p.online !== false).length;
    list.innerHTML = '';

    for (const p of players) {
      const mine = isMe(p.id);
      const color = mine ? '#b6ff3a' : ICONS.teamColor(p.team);
      const dist = mine ? null : U.distance(me, p);
      const brg = mine ? null : U.bearing(me, p);
      const tags = [];
      if (p.status && p.status !== 'ok') tags.push('<i class="tag ' + p.status + '">' + p.status.toUpperCase() + '</i>');
      if (p.src === 'dr') tags.push('<i class="tag hit">DR ' + PLUSMINUS + Math.round(p.acc || 0) + 'm</i>');
      if (p.src === 'anchor' || p.src === 'manual') tags.push('<i class="tag respawn">CHECKED IN</i>');
      if (p.online === false) tags.push('<i class="tag stale">OFFLINE</i>');
      else if (p.stale) tags.push('<i class="tag stale">STALE</i>');

      const li = el('li', {
        class: p.online === false ? 'r-off' : '',
        onclick: () => { focusPlayer(p.id); closePanels(); },
      });
      li.innerHTML =
        '<span class="r-swatch" style="background:' + color + ';color:' + color + '"></span>' +
        '<span class="r-main">' +
          '<span class="r-name">' + U.escapeHtml(p.callsign || '?') + (mine ? ' <small>(you)</small>' : '') + tags.join('') + '</span>' +
          '<span class="r-sub">' + U.escapeHtml(p.team || '') + ' / ' + U.escapeHtml(p.role || '') +
          ' / ' + U.fmtAge(p.ts ? Date.now() - p.ts : null) +
          (p.batt != null ? ' / ' + Math.round(p.batt * 100) + '%' : '') + '</span>' +
        '</span>' +
        (mine ? '' : '<span class="r-dist">' + U.fmtDist(dist) + '<small>' + U.compass(brg) +
          (brg == null ? '' : ' ' + Math.round(brg) + '&deg;') + '</small></span>');
      list.appendChild(li);
    }

    if (!players.length) list.appendChild(el('li', { html: '<span class="r-sub">No one else has joined yet. Share the game code.</span>' }));
  }

  /* ------------------------------------------------------------------ *
   * UI plumbing
   * ------------------------------------------------------------------ */

  function closeSheets() {
    /* Every bottom sheet except the site-plan one, which SitePlan owns and
       closes itself when you finish placing. */
    for (const node of $$('.sheet')) {
      if (node.id !== 'plansheet') node.classList.add('hidden');
    }
    state.detailId = null;
  }
  function closePanels() {
    $('#roster').classList.add('hidden');
    $('#settings').classList.add('hidden');
  }
  function openSheet(sel) {
    closeSheets();
    $(sel).classList.remove('hidden');
  }

  function setMode(mode) {
    state.mode = mode;
    for (const btn of $$('.tool')) btn.classList.toggle('on', btn.dataset.act === mode);
    setTimeout(refreshCrosshair, 0);
    if (mode !== 'draw') clearDraft();
    if (mode !== 'marker') state.pendingLatLng = null;
    if (!mode) closeSheets();
  }

  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => {
    closeSheets(); closePanels(); setMode(null);
  }));

  $$('.tool').forEach((btn) => btn.addEventListener('click', () => {
    const act = btn.dataset.act;
    closePanels();

    if (act === 'locate') {
      const me = state.me && state.players.get(state.me.id);
      if (me && me.lat != null) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17));
      else toast('WAITING FOR A GPS FIX');
      return;
    }
    if (act === 'ping') {
      const at = aimLatLng();
      net.send({ t: 'ping:map', lat: at.lat, lng: at.lng });
      showPing(at);
      toast('PING SENT');
      return;
    }
    if (act === 'status') { openSheet('#statesheet'); return; }
    if (act === 'fix') {
      renderStations();
      $('#fix-readout').textContent = fixSummary();
      openSheet('#stationsheet');
      return;
    }

    if (state.mode === act) { setMode(null); return; }
    setMode(act);
    if (act === 'marker') {
      $('#palette-hint').textContent = state.pendingLatLng ? 'placed where you held' : 'placed at the crosshair';
      openSheet('#palette');
      refreshCrosshair();
    }
    if (act === 'draw') { openSheet('#drawbar'); }
  }));

  /* palette */
  function buildPalette() {
    const grid = $('#palette-grid');
    grid.innerHTML = '';
    for (const k of ICONS.KINDS) {
      const btn = el('button', { class: 'pal', style: 'color:' + k.color, onclick: () => { dropMarker(k.key); setMode(null); } });
      btn.innerHTML = '<span class="glyph"><span>' + k.glyph + '</span></span><span style="color:var(--text)">' + k.name + '</span>';
      grid.appendChild(btn);
    }
  }

  /* draw shapes */
  function buildDrawShapes() {
    const row = $('#draw-shapes');
    row.innerHTML = '';
    for (const s of ICONS.SHAPES) {
      row.appendChild(el('button', {
        class: 'btn' + (s.key === state.draft.shape ? ' on' : ''),
        text: s.name,
        onclick: () => { state.draft.shape = s.key; buildDrawShapes(); redrawDraft(); },
      }));
    }
  }

  $('#draw-undo').addEventListener('click', () => { state.draft.points.pop(); redrawDraft(); });
  $('#draw-clear').addEventListener('click', () => { clearDraft(); setMode(null); });
  $('#draw-save').addEventListener('click', saveDraft);

  /* status */
  $$('#state-buttons .btn').forEach((btn) => btn.addEventListener('click', () => {
    const s = btn.dataset.state;
    net.send({ t: 'status', status: s });
    const me = state.me && state.players.get(state.me.id);
    if (me) { me.status = s; drawPlayer(me); renderRoster(); }
    toast('STATUS: ' + btn.textContent);
    setMode(null);
    closeSheets();
  }));

  /* map interactions */
  map.on('click', (ev) => {
    if (state.mode === 'draw') addDraftPoint(ev.latlng);
  });

  map.on('contextmenu', (ev) => {
    state.pendingLatLng = { lat: ev.latlng.lat, lng: ev.latlng.lng };
    setMode('marker');
    $('#palette-hint').textContent = 'placed where you held';
    openSheet('#palette');
  });

  /* marker detail */
  function openDetail(id) {
    const rec = state.markers.get(id);
    if (!rec) return;
    state.detailId = id;
    const k = ICONS.kind(rec.data.kind);
    $('#detail-title').textContent = k.name;
    $('#detail-label').value = rec.data.label || '';
    $('#detail-note').value = rec.data.note || '';
    const me = state.me && state.players.get(state.me.id);
    const d = U.distance(me, rec.data);
    $('#detail-meta').textContent =
      'by ' + (rec.data.byName || '?') + '  ' + U.fmtAge(Date.now() - rec.data.ts) +
      (d != null ? '  /  ' + U.fmtDist(d) + ' ' + U.compass(U.bearing(me, rec.data)) : '');
    openSheet('#detail');
  }

  $('#detail-save').addEventListener('click', () => {
    if (!state.detailId) return;
    net.send({
      t: 'marker:update', id: state.detailId,
      label: $('#detail-label').value, note: $('#detail-note').value,
    });
    closeSheets();
    toast('MARKER UPDATED');
  });
  $('#detail-del').addEventListener('click', () => {
    if (!state.detailId) return;
    const rec = state.markers.get(state.detailId);
    if (rec && rec.data.demo) { removeMarker(state.detailId); closeSheets(); return; }
    net.send({ t: 'marker:del', id: state.detailId });
    closeSheets();
  });

  /* station check-in sheet */
  $('#btn-nfc').addEventListener('click', scanNfc);

  $('#btn-here').addEventListener('click', () => {
    const at = aimLatLng();
    setFix({ lat: at.lat, lng: at.lng, acc: 8, src: 'manual' });
    toast('POSITION SET BY HAND');
    closeSheets();
    setMode(null);
  });

  $('#btn-station-new').addEventListener('click', () => {
    const code = (prompt('Short code for this station (e.g. J1, SHAFT, DOOR-3)') || '').trim().toUpperCase();
    if (!code) return;
    const name = (prompt('Description (optional)') || '').trim();
    const at = aimLatLng();
    net.send({ t: 'marker:add', kind: 'station', label: code.slice(0, 12), note: name, lat: at.lat, lng: at.lng });
    toast('STATION ' + code + ' ADDED');
    setTimeout(renderStations, 500);
  });

  function fixSummary() {
    const f = state.nav.fix;
    if (!f) return 'no position yet - check in at a station or set one by hand';
    const bits = ['source: ' + f.src.toUpperCase(), 'error ' + PLUSMINUS + Math.round(f.acc || 0) + 'm'];
    if (state.nav.drDistance > 0) bits.push(U.fmtDist(state.nav.drDistance) + ' since last check-in');
    if (pdr && pdr.running) bits.push(pdr.legSteps + ' steps');
    return bits.join('  /  ');
  }

  /* positioning mode */
  const POS_MODES = [
    { key: 'auto', name: 'AUTO', note: 'Use GPS while it is any good, and dead reckon from the last known point when it is not. Best for outdoor sites with patchy cover.' },
    { key: 'indoor', name: 'INDOOR', note: 'Ignore GPS completely. Position comes from checking in at stations, and dead reckoning between them. For buildings, tunnels and underground sites.' },
    { key: 'manual', name: 'MANUAL', note: 'Nothing moves your blip except you. Drag the crosshair and press I AM AT THE CROSSHAIR, or check in at a station.' },
  ];

  function renderPosModes() {
    const box = $('#posmode-buttons');
    box.innerHTML = '';
    for (const m of POS_MODES) {
      box.appendChild(el('button', {
        class: 'btn' + (m.key === state.nav.mode ? ' on' : ''),
        text: m.name,
        onclick: () => {
          state.nav.mode = m.key;
          store.set('posmode', m.key);
          renderPosModes();
          if (m.key !== 'auto' && pdr && !pdr.running && state.opts.pdrEnabled) enablePdr();
          toast('POSITIONING: ' + m.name);
        },
      }));
    }
    const mode = POS_MODES.find((m) => m.key === state.nav.mode);
    $('#posmode-note').textContent = mode ? mode.note : '';
  }

  async function enablePdr() {
    if (!pdr) return toast('THIS DEVICE HAS NO MOTION SENSORS');
    const ok = await pdr.start();
    if (!ok) return toast('MOTION SENSOR PERMISSION REFUSED', 4000);
    pdr.onStep = advanceDR;
    state.opts.pdrEnabled = true;
    store.set('opts', state.opts);
    toast('MOTION SENSORS ON - CHECK IN AT TWO STATIONS TO CALIBRATE YOUR STRIDE', 5000);
  }

  $('#btn-pdr-enable').addEventListener('click', enablePdr);

  setInterval(() => {
    const node = $('#pdr-readout');
    if (!node) return;
    if (!pdr) { node.textContent = 'no motion sensors on this device'; return; }
    if (!pdr.running) { node.textContent = 'dead reckoning off'; return; }
    const stride = (pdr.k * Math.pow(9, 0.25)).toFixed(2);
    node.textContent =
      pdr.steps + ' steps  /  stride ~' + stride + 'm  /  ' +
      (pdr.heading == null ? 'no compass' : 'heading ' + Math.round(pdr.heading) + String.fromCharCode(176)) +
      (pdr.headingJitter > 12 ? '  /  COMPASS UNSTABLE (steel nearby?)' : '');
    if ($('#stationsheet').classList.contains('hidden')) return;
    $('#fix-readout').textContent = fixSummary();
  }, 1000);

  /* panels */
  $('#btn-roster').addEventListener('click', () => {
    const panel = $('#roster');
    const show = panel.classList.contains('hidden');
    closePanels();
    if (show) { renderRoster(); panel.classList.remove('hidden'); }
  });
  $('#btn-menu').addEventListener('click', () => {
    const panel = $('#settings');
    const show = panel.classList.contains('hidden');
    closePanels();
    if (show) panel.classList.remove('hidden');
  });

  /* options */
  const OPT_KEYS = ['trails', 'accuracy', 'labels', 'lock', 'wake', 'snap', 'nobase', 'aim'];
  function bindOptions() {
    for (const key of OPT_KEYS) {
      const box = $('#opt-' + key);
      box.checked = !!state.opts[key];
      box.addEventListener('change', () => {
        state.opts[key] = box.checked;
        store.set('opts', state.opts);
        applyOptions();
      });
    }
  }
  function applyOptions() {
    document.body.classList.toggle('no-labels', !state.opts.labels);
    setAimMode(!!state.opts.aim);
    if (state.opts.nobase) {
      if (map.hasLayer(BASES[baseName])) map.removeLayer(BASES[baseName]);
      if (map.hasLayer(LABELS)) map.removeLayer(LABELS);
    } else if (!map.hasLayer(BASES[baseName])) {
      BASES[baseName].addTo(map);
      if (labelsOn) LABELS.addTo(map);
    }
    if (!state.opts.trails) {
      for (const [id, layer] of state.layers.trails) { map.removeLayer(layer); state.layers.trails.delete(id); }
    }
    for (const p of state.players.values()) drawPlayer(p);
    if (state.opts.wake) requestWakeLock();
    else if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  }

  /* team-only visibility is a property of the game, not of this phone */
  $('#opt-teamlock').addEventListener('change', (ev) => {
    net.send({ t: 'room:set', teamLock: ev.target.checked });
  });

  /* share */
  $('#btn-share').addEventListener('click', async () => {
    const url = location.origin + '/?room=' + encodeURIComponent(state.me ? state.me.room : '');
    try {
      if (navigator.share) await navigator.share({ title: 'AirsoftMap', text: 'Join the game map', url });
      else { await navigator.clipboard.writeText(url); toast('LINK COPIED'); }
    } catch { $('#share-readout').textContent = url; }
  });

  $('#btn-leave').addEventListener('click', () => {
    if (!confirm('Leave the game? Your position stops being shared.')) return;
    net.disconnect();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    store.del('session');
    location.href = '/';
  });

  /* demo toggle from settings */
  $('#btn-demo-toggle').addEventListener('click', () => {
    if (state.demo) stopDemo(); else startDemo(map.getCenter());
  });

  /* ------------------------------------------------------------------ *
   * Demo
   * ------------------------------------------------------------------ */

  function startDemo(center) {
    stopDemo();
    state.demo = new Demo();
    const seeded = state.demo.seed({ lat: center.lat, lng: center.lng });
    for (const p of seeded.players) upsertPlayer(p);
    for (const m of seeded.markers) upsertMarker(m);
    for (const d of seeded.drawings) upsertDrawing(d);
    state.demo.start((bots) => {
      for (const b of bots) upsertPlayer(b);
      renderRoster();
    });
    renderRoster();
    toast('DEMO SQUAD DEPLOYED');
  }

  function stopDemo() {
    if (!state.demo) return;
    for (const id of state.demo.stop()) removePlayer(id);
    for (const [id, rec] of [...state.markers]) if (rec.data.demo) removeMarker(id);
    for (const [id, rec] of [...state.drawings]) if (rec.data.demo) removeDrawing(id);
    state.demo = null;
    renderRoster();
    toast('DEMO SQUAD CLEARED');
  }

  /* ------------------------------------------------------------------ *
   * Offline tile caching
   * ------------------------------------------------------------------ */

  function tileUrls(layer, bounds, zFrom, zTo, cap) {
    const urls = [];
    const template = layer._url;
    for (let z = zFrom; z <= zTo; z++) {
      const nw = project(bounds.getNorthWest(), z);
      const se = project(bounds.getSouthEast(), z);
      for (let x = nw.x; x <= se.x; x++) {
        for (let y = nw.y; y <= se.y; y++) {
          urls.push(template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a'));
          if (urls.length >= cap) return urls;
        }
      }
    }
    return urls;
  }

  function project(latlng, z) {
    const n = Math.pow(2, z);
    const lat = Math.max(-85.05, Math.min(85.05, latlng.lat));
    const x = Math.floor(((latlng.lng + 180) / 360) * n);
    const rad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    return { x, y };
  }

  $('#btn-cache').addEventListener('click', async () => {
    const readout = $('#cache-readout');
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      readout.textContent = 'offline cache needs HTTPS (or localhost) - reload once and retry';
      return;
    }
    const layer = BASES[baseName];
    const z = Math.round(map.getZoom());
    const maxZ = Math.min(layer.options.maxNativeZoom || 19, z + 3);
    const urls = tileUrls(layer, map.getBounds().pad(0.15), Math.max(z - 1, 1), maxZ, 2500);
    readout.textContent = 'caching ' + urls.length + ' tiles...';
    let done = 0;
    let failed = 0;
    const workers = new Array(6).fill(0).map(async () => {
      while (urls.length) {
        const url = urls.pop();
        try { await fetch(url, { mode: 'no-cors', cache: 'reload' }); } catch { failed++; }
        done++;
        if (done % 25 === 0) readout.textContent = 'cached ' + done + ' tiles...';
      }
    });
    await Promise.all(workers);
    readout.textContent = 'cached ' + (done - failed) + ' tiles for ' + baseName.toLowerCase() +
      ' around this view' + (failed ? ' (' + failed + ' failed)' : '');
  });

  /* ------------------------------------------------------------------ *
   * Join flow
   * ------------------------------------------------------------------ */

  function buildTeamPicker(selected) {
    const box = $('#f-team-picker');
    box.innerHTML = '';
    for (const t of ICONS.TEAM_ORDER) {
      const color = ICONS.teamColor(t);
      const on = t === selected;
      box.appendChild(el('button', {
        type: 'button',
        class: on ? 'on' : '',
        text: t,
        style: on ? 'background:' + color + ';border-color:' + color : 'border-color:' + color + ';color:' + color,
        onclick: () => { chosenTeam = t; buildTeamPicker(t); },
      }));
    }
  }

  const params = new URLSearchParams(location.search);
  const saved = store.get('session', {});
  let chosenTeam = saved.team || 'BLUE';

  $('#f-callsign').value = saved.callsign || '';
  $('#f-role').value = saved.role || 'RIFLE';
  $('#f-room').value = (params.get('room') || saved.room || '').toUpperCase();
  buildTeamPicker(chosenTeam);
  buildPalette();
  buildDrawShapes();
  renderLayerButtons();
  bindOptions();
  renderPosModes();
  sitePlan.bind();

  function join(demoMode) {
    const callsign = ($('#f-callsign').value || '').trim().toUpperCase() ||
      'PLAYER' + Math.floor(Math.random() * 90 + 10);
    const room = ($('#f-room').value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') ||
      (demoMode ? 'DEMO' : 'LOBBY');
    const role = $('#f-role').value;
    const id = saved.id || U.uid();

    state.me = { id, callsign, team: chosenTeam, role, room };
    store.set('session', { id, callsign, team: chosenTeam, role, room });

    state.joined = true;
    $('#join').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    $('#tools').classList.remove('hidden');
    $('#chip-room').textContent = room;
    $('#share-readout').textContent = location.origin + '/?room=' + encodeURIComponent(room);
    applyOptions();
    $('#btn-print').href = '/print.html?room=' + encodeURIComponent(room);
    setTimeout(() => { map.invalidateSize(); refreshCrosshair(); }, 50);

    state.players.set(id, {
      id, callsign, team: chosenTeam, role, status: 'ok',
      lat: null, lng: null, online: true, stale: true, ts: 0,
    });

    net.connect({ id, callsign, team: chosenTeam, role, room });
    startTracking();
    requestWakeLock();
    renderRoster();
    refreshFixChip();

    /* Motion sensors need a user gesture on iOS, and this click is one. */
    if (pdr && state.opts.pdrEnabled) {
      pdr.onStep = advanceDR;
      pdr.start().then((ok) => { if (!ok) toast('MOTION SENSORS BLOCKED'); });
    }

    if (demoMode) {
      // Drop the demo squad wherever we are (or a default patch of woodland).
      const centre = state.lastFix || { lat: 51.1417, lng: -0.9463 };
      map.setView([centre.lat, centre.lng], 17);
      state.centredOnce = true;
      startDemo(map.getCenter());
    }
  }

  $('#f-go').addEventListener('click', () => join(false));
  $('#f-demo').addEventListener('click', () => join(true));
  $('#f-room').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') join(false); });
  $('#f-callsign').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') join(false); });

  /* Exposed for debugging from the browser console (and for the tests). */
  window.AM = { state, map, net, pdr, sitePlan, ICONS, U };

  /* service worker */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
