/* ------------------------------------------------------------------ *
 * The site viewer.
 *
 * A laptop-side companion to the phone app: the same room, the same
 * structures, but the ground as it actually is rather than flattened
 * onto a map. Fly it, stand in it at eye height, and put buildings on
 * it before building them.
 *
 * It joins the room as an observer, so nothing here appears as a
 * player, moves a blip, or lands in the game log.
 * ------------------------------------------------------------------ */

import * as THREE from 'three';
import { OrbitControls } from '/lib/three/OrbitControls.js';
import { Terrain } from './terrain.js';
import { buildTrees } from './trees.js';
import { KINDS, kindOf, buildStructure, place, groundFall } from './structures.js';

const $ = (sel) => document.querySelector(sel);
const EYE_HEIGHT = 1.7;

const params = new URLSearchParams(location.search);
const ROOM = (params.get('room') || 'LOBBY').toUpperCase();
const SITE = params.get('site') || 'green-wood';

const state = {
  terrain: null,
  structures: new Map(),      // id -> { data, mesh }
  selected: null,
  placing: null,              // kind key armed for the next ground click
  walking: false,
  dragging: null,
};

/* ------------------------------------------------------------------ *
 * Scene
 * ------------------------------------------------------------------ */

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: $('#stage') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fb4c2');
/* Set once the site's size is known - a fixed range either swallows a
   small site whole or never touches a large one. */
scene.fog = new THREE.Fog('#9fb4c2', 400, 1600);

const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI / 2 - 0.02;   // never below the horizon
controls.minDistance = 2;
controls.maxDistance = 1200;

/* Generous ambient on purpose: under a closed canopy the direct light
   is mostly blocked, and a physically honest scene at eye level is a
   dark green murk you cannot plan a shed in. */
scene.add(new THREE.HemisphereLight('#cfe0ea', '#454b3a', 2.4));
const sun = new THREE.DirectionalLight('#fff4e0', 1.4);
sun.position.set(-220, 320, -190);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 900;
for (const [k, v] of [['left', -220], ['right', 220], ['top', 220], ['bottom', -220]]) {
  sun.shadow.camera[k] = v;
}
scene.add(sun, sun.target);

const overlays = new THREE.Group();
const structureLayer = new THREE.Group();
const markerLayer = new THREE.Group();
scene.add(overlays, structureLayer, markerLayer);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let ground = null;

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function boot() {
  let terrain;
  try {
    terrain = await Terrain.load(SITE);
  } catch (err) {
    $('#loading').innerHTML =
      '<h1>No ground model for &ldquo;' + escapeHtml(SITE) + '&rdquo;</h1>' +
      '<p>' + escapeHtml(err.message) + '</p>' +
      '<p>Build one from Environment Agency LIDAR - free, England only, ' +
      'one metre - by pointing the script at your boundary:</p>' +
      '<pre>node scripts/fetch-terrain.js \\\n  --name ' + escapeHtml(SITE) +
      ' \\\n  --boundary your-site.geojson</pre>';
    return;
  }
  state.terrain = terrain;

  ground = terrain.build();
  scene.add(ground);

  const reach = Math.max(terrain.spanX, terrain.spanZ);
  scene.fog.near = reach * 1.1;
  scene.fog.far = reach * 4;
  /* Light the site from over its own north-west shoulder, and size the
     shadow camera to the site rather than to a guess. */
  sun.position.set(-reach * 0.8, reach * 1.1, -reach * 0.7);
  const half = reach * 0.72;
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.far = reach * 4;
  sun.shadow.camera.updateProjectionMatrix();

  const trees = buildTrees(terrain, terrain.site.trees);
  trees.visible = true;
  scene.add(trees);
  state.trees = trees;

  /* Frame the whole site on first sight, from over the low corner
     looking up the hill. High enough to read the landform: from a
     shallow angle a hillside foreshortens into a flat sheet and the
     one thing worth seeing is the one thing you cannot see. */
  const cx = terrain.spanX / 2;
  const cz = terrain.spanZ / 2;
  controls.target.set(cx, terrain.heightAt(cx, cz), cz);
  camera.position.set(
    cx + terrain.spanX * 0.62,
    terrain.heightAt(cx, cz) + reach * 0.78,
    cz - terrain.spanZ * 0.72
  );
  sun.target.position.copy(controls.target);

  $('#site-name').textContent = terrain.site.name.replace(/-/g, ' ').toUpperCase();
  $('#stat-fall').textContent = (terrain.grid.max - terrain.grid.min).toFixed(1) + ' m';
  $('#stat-trees').textContent = terrain.site.trees.length;
  $('#stat-extent').textContent = Math.round(terrain.spanX) + ' x ' + Math.round(terrain.spanZ) + ' m';
  $('#loading').classList.add('gone');

  buildPalette();
  connect();
  resize();
  renderer.setAnimationLoop(tick);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ *
 * Overlays: the boundary, and intel already on the map
 * ------------------------------------------------------------------ */

function drapeLine(points, colour, lift) {
  const t = state.terrain;
  const pts = [];
  for (let i = 0; i < points.length; i++) {
    const [lng, lat] = points[i];
    const { x, z } = t.toWorld(lat, lng);
    /* Follow the ground rather than cutting through it: a straight line
       between two corners of a wood on a hillside disappears. */
    if (i > 0) {
      const prev = t.toWorld(points[i - 1][1], points[i - 1][0]);
      const span = Math.hypot(x - prev.x, z - prev.z);
      const steps = Math.max(1, Math.round(span / 4));
      for (let s = 1; s < steps; s++) {
        const px = prev.x + (x - prev.x) * (s / steps);
        const pz = prev.z + (z - prev.z) * (s / steps);
        pts.push(new THREE.Vector3(px, t.heightAt(px, pz) + lift, pz));
      }
    }
    pts.push(new THREE.Vector3(x, t.heightAt(x, z) + lift, z));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: colour })
  );
}

async function loadParcels(url) {
  let gj;
  try {
    gj = await fetch(url).then((r) => r.json());
  } catch (err) {
    return;
  }
  overlays.clear();
  for (const f of gj.features || []) {
    const owned = f.properties && f.properties.zone === 'boundary';
    const colour = owned ? '#ff5a5a' : '#b6ff3a';
    const polys = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) overlays.add(drapeLine(ring, colour, 1.4));
    }
  }
  $('#stat-parcels').textContent = (gj.features || []).length;
}

const MARKER_COLOUR = {
  spawn: '#b6ff3a', objective: '#a78bfa', safe: '#22d3ee', station: '#b6ff3a',
  hazard: '#ef4444', nogo: '#ef4444', poi: '#e5e7eb',
};

function drawMarker(m) {
  const t = state.terrain;
  const { x, z } = t.toWorld(m.lat, m.lng);
  if (x < 0 || z < 0 || x > t.spanX || z > t.spanZ) return;
  const colour = MARKER_COLOUR[m.kind] || '#fbbf24';
  const pin = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 2.4, 6),
    new THREE.MeshBasicMaterial({ color: colour })
  );
  post.position.y = 1.2;
  const head = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.5),
    new THREE.MeshBasicMaterial({ color: colour })
  );
  head.position.y = 2.7;
  pin.add(post, head);
  pin.position.set(x, t.heightAt(x, z), z);
  markerLayer.add(pin);
}

/* ------------------------------------------------------------------ *
 * Structures
 * ------------------------------------------------------------------ */

function upsertStructure(s) {
  const existing = state.structures.get(s.id);
  if (existing) structureLayer.remove(existing.mesh);
  const mesh = buildStructure(state.terrain, s);
  structureLayer.add(mesh);
  state.structures.set(s.id, { data: s, mesh });
  if (state.selected === s.id) showSelection();
  refreshList();
}

function removeStructure(id) {
  const entry = state.structures.get(id);
  if (!entry) return;
  structureLayer.remove(entry.mesh);
  state.structures.delete(id);
  if (state.selected === id) select(null);
  refreshList();
}

function select(id) {
  state.selected = id;
  for (const [key, entry] of state.structures) {
    entry.mesh.traverse((o) => {
      if (o.isMesh && o.material.emissive) {
        o.material.emissive.set(key === id ? '#3a5a20' : '#000000');
      }
    });
  }
  showSelection();
  refreshList();
}

function showSelection() {
  const panel = $('#selection');
  const entry = state.selected && state.structures.get(state.selected);
  if (!entry) {
    panel.classList.add('gone');
    return;
  }
  const s = entry.data;
  panel.classList.remove('gone');
  $('#sel-kind').textContent = kindOf(s.kind).name;
  $('#sel-label').value = s.label || '';
  $('#sel-w').value = s.w;
  $('#sel-d').value = s.d;
  $('#sel-h').value = s.h;
  $('#sel-rot').value = Math.round(s.rot || 0);
  $('#sel-rot-out').textContent = Math.round(s.rot || 0) + '°';
  $('#sel-status').checked = s.status === 'planned';

  const t = state.terrain;
  const { x, z } = t.toWorld(s.lat, s.lng);
  const fall = groundFall(t, s);
  $('#sel-ground').textContent =
    t.elevationAt(x, z).toFixed(1) + ' m above sea level, '
    + t.slopeAt(x, z).toFixed(0) + '° slope';
  const level = $('#sel-level');
  level.textContent = fall < 0.15
    ? 'Ground under it is level to within ' + Math.round(fall * 100) + ' cm.'
    : 'Ground falls ' + fall.toFixed(2) + ' m across the footprint'
      + (fall > 1 ? ' - that is a platform, not a base.' : '.');
  level.className = fall > 1 ? 'warn' : fall > 0.4 ? 'note' : '';
}

function refreshList() {
  const list = $('#structure-list');
  list.innerHTML = '';
  const all = [...state.structures.values()].map((e) => e.data)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'built' ? -1 : 1));
  $('#stat-built').textContent = all.filter((s) => s.status === 'built').length;
  $('#stat-planned').textContent = all.filter((s) => s.status === 'planned').length;
  for (const s of all) {
    const li = document.createElement('li');
    li.className = (s.status === 'planned' ? 'planned' : '') +
      (s.id === state.selected ? ' on' : '');
    li.innerHTML = '<b>' + escapeHtml(s.label || kindOf(s.kind).name) + '</b>'
      + '<span>' + s.w + ' x ' + s.d + ' m</span>';
    li.addEventListener('click', () => { select(s.id); lookAt(s); });
    list.appendChild(li);
  }
}

function lookAt(s) {
  const { x, z } = state.terrain.toWorld(s.lat, s.lng);
  const y = state.terrain.heightAt(x, z);
  controls.target.set(x, y + s.h / 2, z);
  const back = Math.max(12, s.w * 3);
  camera.position.set(x + back, y + back * 0.7, z + back);
}

function edit(patch) {
  const entry = state.selected && state.structures.get(state.selected);
  if (!entry) return;
  net.send(Object.assign({ t: 'struct:update', id: entry.data.id }, patch));
}

/* ------------------------------------------------------------------ *
 * Pointer
 * ------------------------------------------------------------------ */

function pick(ev, objects) {
  pointer.x = (ev.clientX / innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(objects, true);
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const hit = pick(ev, [structureLayer])[0];
  if (hit) {
    const id = hit.object.userData.id;
    if (id) {
      select(id);
      /* Grabbing an already-selected structure moves it. */
      if (state.dragCandidate === id) {
        state.dragging = id;
        controls.enabled = false;
      }
      state.dragCandidate = id;
      return;
    }
  }
  state.dragCandidate = null;

  if (state.placing) {
    const spot = pick(ev, [ground])[0];
    if (spot) {
      const kind = kindOf(state.placing);
      const ll = state.terrain.toLatLng(spot.point.x, spot.point.z);
      net.send({
        t: 'struct:add', kind: kind.key, label: '', status: $('#place-planned').checked
          ? 'planned' : 'built',
        lat: ll.lat, lng: ll.lng, rot: 0, w: kind.w, d: kind.d, h: kind.h,
      });
      if (!$('#place-sticky').checked) armPlacement(null);
    }
    return;
  }
  if (!hit) select(null);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (state.dragging) {
    const spot = pick(ev, [ground])[0];
    if (spot) {
      const entry = state.structures.get(state.dragging);
      const ll = state.terrain.toLatLng(spot.point.x, spot.point.z);
      entry.data.lat = ll.lat;
      entry.data.lng = ll.lng;
      place(state.terrain, entry.mesh, entry.data);
      showSelection();
    }
    return;
  }
  const spot = pick(ev, [ground])[0];
  if (!spot) return;
  const t = state.terrain;
  $('#readout').textContent =
    t.elevationAt(spot.point.x, spot.point.z).toFixed(1) + ' m  /  '
    + t.slopeAt(spot.point.x, spot.point.z).toFixed(0) + '°';
});

addEventListener('pointerup', () => {
  if (!state.dragging) return;
  const entry = state.structures.get(state.dragging);
  state.dragging = null;
  controls.enabled = true;
  if (entry) net.send({ t: 'struct:update', id: entry.data.id, lat: entry.data.lat, lng: entry.data.lng });
});

/* ------------------------------------------------------------------ *
 * Moving about
 * ------------------------------------------------------------------ */

const keys = new Set();
addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  keys.add(ev.key.toLowerCase());
  if (ev.key === 'Escape') { armPlacement(null); select(null); }
  if (ev.key === 'Delete' && state.selected) {
    net.send({ t: 'struct:del', id: state.selected });
  }
});
addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const forward = new THREE.Vector3();
const right = new THREE.Vector3();

function move(dt) {
  const speed = (keys.has('shift') ? 46 : 16) * dt;
  let dx = 0;
  let dz = 0;
  let dy = 0;
  if (keys.has('w') || keys.has('arrowup')) dz += 1;
  if (keys.has('s') || keys.has('arrowdown')) dz -= 1;
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
  if (keys.has('d') || keys.has('arrowright')) dx += 1;
  if (keys.has('e')) dy += 1;
  if (keys.has('q')) dy -= 1;
  if (!dx && !dz && !dy) return;

  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  right.crossVectors(forward, camera.up).normalize();

  const step = new THREE.Vector3()
    .addScaledVector(forward, dz * speed)
    .addScaledVector(right, dx * speed);
  step.y = dy * speed;
  camera.position.add(step);
  controls.target.add(step);

  if (state.walking) stand();
}

/** Keep the camera at eye height over whatever it is standing on. */
function stand() {
  const t = state.terrain;
  const y = t.heightAt(camera.position.x, camera.position.z) + EYE_HEIGHT;
  const drop = camera.position.y - y;
  camera.position.y = y;
  controls.target.y -= drop;
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function buildPalette() {
  const wrap = $('#palette');
  for (const k of KINDS) {
    const b = document.createElement('button');
    b.textContent = k.name;
    b.dataset.kind = k.key;
    b.addEventListener('click', () => armPlacement(state.placing === k.key ? null : k.key));
    wrap.appendChild(b);
  }
}

function armPlacement(kind) {
  state.placing = kind;
  document.body.classList.toggle('placing', !!kind);
  for (const b of $('#palette').children) b.classList.toggle('on', b.dataset.kind === kind);
  $('#hint').textContent = kind
    ? 'Click the ground to put a ' + kindOf(kind).name.toLowerCase() + ' there.'
    : '';
}

$('#sel-label').addEventListener('change', (ev) => edit({ label: ev.target.value }));
$('#sel-status').addEventListener('change', (ev) => edit({ status: ev.target.checked ? 'planned' : 'built' }));
$('#sel-del').addEventListener('click', () => {
  if (state.selected) net.send({ t: 'struct:del', id: state.selected });
});
for (const dim of ['w', 'd', 'h']) {
  $('#sel-' + dim).addEventListener('input', (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v) && v > 0) edit({ [dim]: v });
  });
}
$('#sel-rot').addEventListener('input', (ev) => {
  $('#sel-rot-out').textContent = ev.target.value + '°';
  edit({ rot: Number(ev.target.value) });
});

$('#view-walk').addEventListener('click', () => {
  state.walking = !state.walking;
  $('#view-walk').classList.toggle('on', state.walking);
  if (state.walking) {
    controls.maxDistance = 30;
    /* Stand where you were looking, facing the way you were. */
    const t = state.terrain;
    const look = controls.target.clone();
    camera.position.set(look.x, t.heightAt(look.x, look.z) + EYE_HEIGHT, look.z);
    controls.target.copy(look).add(forward.setFromMatrixColumn(camera.matrix, 0)
      .cross(camera.up).multiplyScalar(-12));
    stand();
  } else {
    controls.maxDistance = 1200;
  }
  $('#hint').textContent = state.walking
    ? 'Eye height. W A S D to walk, drag to look.' : '';
});

$('#view-top').addEventListener('click', () => {
  const t = state.terrain;
  const cx = t.spanX / 2;
  const cz = t.spanZ / 2;
  state.walking = false;
  $('#view-walk').classList.remove('on');
  controls.maxDistance = 1200;
  controls.target.set(cx, t.heightAt(cx, cz), cz);
  camera.position.set(cx, t.heightAt(cx, cz) + Math.max(t.spanX, t.spanZ) * 1.25, cz + 0.1);
});

for (const [id, layer] of [['layer-trees', () => state.trees],
  ['layer-parcels', () => overlays], ['layer-intel', () => markerLayer]]) {
  $('#' + id).addEventListener('change', (ev) => {
    const l = layer();
    if (l) l.visible = ev.target.checked;
  });
}

/* ------------------------------------------------------------------ *
 * The room
 * ------------------------------------------------------------------ */

const net = new Net();

net.on('welcome', (msg) => {
  $('#link').textContent = 'connected';
  $('#link').className = 'up';
  structureLayer.clear();
  state.structures.clear();
  markerLayer.clear();
  for (const s of msg.structures || []) upsertStructure(s);
  for (const m of msg.markers || []) drawMarker(m);
  if (msg.parcels && msg.parcels.url) loadParcels(msg.parcels.url);
  refreshList();
});
net.on('struct', (msg) => upsertStructure(msg.structure));
net.on('struct:del', (msg) => removeStructure(msg.id));
net.on('marker', (msg) => drawMarker(msg.marker));
net.on('parcels', (msg) => msg.parcels && loadParcels(msg.parcels.url));
net.on('link', (msg) => {
  $('#link').textContent = msg.up ? 'connected' : 'offline';
  $('#link').className = msg.up ? 'up' : 'down';
});

function connect() {
  $('#room-name').textContent = ROOM;
  net.connect({ room: ROOM, observer: true });
}

/* ------------------------------------------------------------------ *
 * Frame
 * ------------------------------------------------------------------ */

let lastFrame = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  move(dt);
  controls.update();
  sun.target.position.copy(controls.target);
  renderer.render(scene, camera);
}

boot();

/* Handy from the console when something looks wrong on the ground. */
window.AMV = { state, scene, camera, controls, net, THREE };
