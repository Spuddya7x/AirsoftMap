/* AirsoftMap - main application. */
(function () {
  'use strict';

  const { $, $$, el, store, toast } = U;

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
    opts: store.get('opts', { trails: false, accuracy: true, labels: true, lock: false, wake: true }),
  };

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
    for (const p of msg.players) upsertPlayer(p);
    for (const m of msg.markers) upsertMarker(m);
    for (const d of msg.drawings) upsertDrawing(d);
    renderRoster();
    sendPosition(true);
    toast('JOINED ' + msg.room);
  });

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
    if (state.opts.accuracy && p.acc != null && p.acc > 5) {
      const color = mine ? '#b6ff3a' : ICONS.teamColor(p.team);
      if (!ring) {
        ring = L.circle(ll, { radius: p.acc, color, weight: 1, opacity: 0.5, fillColor: color, fillOpacity: 0.06, interactive: false });
        ring.addTo(map);
        state.layers.accuracy.set(p.id, ring);
      } else {
        ring.setLatLng(ll);
        ring.setRadius(p.acc);
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
  }

  function removeMarker(id) {
    const rec = state.markers.get(id);
    if (!rec) return;
    map.removeLayer(rec.layer);
    state.markers.delete(id);
    if (state.detailId === id) closeSheets();
  }

  /** Where a "map centre" action actually lands: the middle of the map area
   *  that is still visible above whatever sheet is open. */
  function aimLatLng() {
    const size = map.getSize();
    const sheet = $$('.sheet').find((n) => !n.classList.contains('hidden'));
    const covered = sheet ? Math.max(0, size.y - sheet.getBoundingClientRect().top) : 0;
    return map.containerPointToLatLng([size.x / 2, (size.y - covered) / 2]);
  }

  function positionCrosshair() {
    const size = map.getSize();
    const sheet = $$('.sheet').find((n) => !n.classList.contains('hidden'));
    const covered = sheet ? Math.max(0, size.y - sheet.getBoundingClientRect().top) : 0;
    $('#crosshair').style.top = ((size.y - covered) / 2) + 'px';
  }

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
    $('#gps-dot').className = 'dot ' + (acc == null ? 'warn' : acc <= 12 ? 'ok' : acc <= 30 ? 'warn' : 'bad');
    $('#gps-text').textContent = acc == null ? 'GPS' : acc + 'm';

    if (!state.me) return;
    const mine = Object.assign(state.players.get(state.me.id) || {}, {
      id: state.me.id, callsign: state.me.callsign, team: state.me.team, role: state.me.role,
      lat: fix.lat, lng: fix.lng, acc, hdg, spd: c.speed || 0,
      batt: state.battery, ts: Date.now(), online: true, stale: false,
    });
    state.players.set(state.me.id, mine);
    drawPlayer(mine);

    state.lastPayload = {
      t: 'pos', lat: fix.lat, lng: fix.lng, acc, hdg,
      spd: c.speed || 0, batt: state.battery,
    };
    sendPosition(false);

    if (state.opts.lock) map.panTo([fix.lat, fix.lng], { animate: true, duration: 0.4 });
    if (!state.centredOnce) {
      state.centredOnce = true;
      map.setView([fix.lat, fix.lng], 17);
    }
    renderRoster();
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
    $('#gps-dot').className = 'dot bad';
    $('#gps-text').textContent = err.code === 1 ? 'GPS BLOCKED' : 'NO FIX';
    if (err.code === 1) toast('LOCATION PERMISSION DENIED - OTHERS CANNOT SEE YOU', 5000);
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
    for (const id of ['#palette', '#drawbar', '#statesheet', '#detail']) $(id).classList.add('hidden');
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
    $('#crosshair').classList.toggle('hidden', mode !== 'marker');
    if (mode === 'marker') setTimeout(positionCrosshair, 0);
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

    if (state.mode === act) { setMode(null); return; }
    setMode(act);
    if (act === 'marker') {
      $('#palette-hint').textContent = state.pendingLatLng ? 'placed where you held' : 'placed at the crosshair';
      openSheet('#palette');
      positionCrosshair();
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
  const OPT_KEYS = ['trails', 'accuracy', 'labels', 'lock', 'wake'];
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
    if (!state.opts.trails) {
      for (const [id, layer] of state.layers.trails) { map.removeLayer(layer); state.layers.trails.delete(id); }
    }
    for (const p of state.players.values()) drawPlayer(p);
    if (state.opts.wake) requestWakeLock();
    else if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  }

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

  function join(demoMode) {
    const callsign = ($('#f-callsign').value || '').trim().toUpperCase() ||
      'PLAYER' + Math.floor(Math.random() * 90 + 10);
    const room = ($('#f-room').value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') ||
      (demoMode ? 'DEMO' : 'LOBBY');
    const role = $('#f-role').value;
    const id = saved.id || U.uid();

    state.me = { id, callsign, team: chosenTeam, role, room };
    store.set('session', { id, callsign, team: chosenTeam, role, room });

    $('#join').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    $('#tools').classList.remove('hidden');
    $('#chip-room').textContent = room;
    $('#share-readout').textContent = location.origin + '/?room=' + encodeURIComponent(room);
    applyOptions();
    setTimeout(() => map.invalidateSize(), 50);

    state.players.set(id, {
      id, callsign, team: chosenTeam, role, status: 'ok',
      lat: null, lng: null, online: true, stale: true, ts: 0,
    });

    net.connect({ id, callsign, team: chosenTeam, role, room });
    startTracking();
    requestWakeLock();
    renderRoster();

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
  window.AM = { state, map, net, ICONS, U };

  /* service worker */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
