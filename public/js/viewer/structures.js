/* ------------------------------------------------------------------ *
 * Things on the ground, and things that might be.
 *
 * A structure is a box with a position, a footprint and a status. The
 * status is the whole point: "built" is the cabin and the firepit that
 * are already there, "planned" is the one you are arguing about. They
 * are the same object drawn two ways, so a plan can be walked around
 * at eye height on the real slope before anyone buys timber.
 *
 * Sizes are metres. The defaults are ordinary sizes for each thing, so
 * dropping one gives something sensible to nudge rather than a blank.
 * ------------------------------------------------------------------ */

import * as THREE from 'three';

export const KINDS = [
  { key: 'cabin',    name: 'CABIN',     w: 4,   d: 3,   h: 2.6, roof: 'gable',  colour: '#8a6a44' },
  { key: 'firepit',  name: 'FIREPIT',   w: 1.8, d: 1.8, h: 0.4, roof: 'round',  colour: '#7c4a3a' },
  { key: 'shed',     name: 'SHED',      w: 2.4, d: 1.8, h: 2.2, roof: 'lean',   colour: '#7d7361' },
  { key: 'container',name: 'CONTAINER', w: 6.1, d: 2.4, h: 2.6, roof: 'flat',   colour: '#4a6670' },
  { key: 'tower',    name: 'TOWER',     w: 2,   d: 2,   h: 5,   roof: 'deck',   colour: '#6b6250' },
  { key: 'hide',     name: 'HIDE',      w: 2.2, d: 2.2, h: 1.3, roof: 'flat',   colour: '#59614a' },
  { key: 'store',    name: 'STORE',     w: 3,   d: 2.5, h: 2.3, roof: 'gable',  colour: '#77685a' },
  { key: 'bridge',   name: 'BRIDGE',    w: 4,   d: 1.2, h: 0.4, roof: 'flat',   colour: '#6a5a48' },
  { key: 'gate',     name: 'GATE',      w: 3,   d: 0.3, h: 1.8, roof: 'flat',   colour: '#5f5647' },
  { key: 'other',    name: 'OTHER',     w: 3,   d: 3,   h: 2.5, roof: 'flat',   colour: '#6e6e6e' },
];

export const kindOf = (key) => KINDS.find((k) => k.key === key) || KINDS[KINDS.length - 1];

const PLANNED = '#4db6ff';

/* --- geometry -------------------------------------------------------- */

/**
 * The body of one structure. Nothing here is architecture - it is the
 * footprint, the height and enough of a roof to tell a cabin from a
 * container at fifty metres.
 */
function bodyFor(kind, s) {
  const g = new THREE.Group();
  const w = s.w;
  const d = s.d;
  const h = s.h;

  if (kind.roof === 'round') {
    /* A firepit is a ring you look into, not a solid. */
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(w / 2, w / 2 * 1.08, h, 16, 1, true),
      new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
    );
    ring.position.y = h / 2;
    const ash = new THREE.Mesh(
      new THREE.CircleGeometry(w / 2 * 0.92, 16),
      new THREE.MeshLambertMaterial({ color: '#2e2723' })
    );
    ash.rotation.x = -Math.PI / 2;
    ash.position.y = h * 0.35;
    ash.name = 'trim';
    g.add(ring, ash);
    return g;
  }

  const wallH = kind.roof === 'gable' ? h * 0.68 : h;
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(w, wallH, d),
    new THREE.MeshLambertMaterial()
  );
  walls.position.y = wallH / 2;
  g.add(walls);

  if (kind.roof === 'gable') {
    /* A prism, rotated so its ridge runs along the long side. */
    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(d * 0.72, d * 0.72, w, 3, 1),
      new THREE.MeshLambertMaterial({ color: '#4b4238' })
    );
    roof.rotation.z = Math.PI / 2;
    roof.rotation.y = Math.PI / 2;
    roof.position.y = wallH + (h - wallH) * 0.15;
    roof.name = 'trim';
    g.add(roof);
  } else if (kind.roof === 'lean') {
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w * 1.08, 0.1, d * 1.15),
      new THREE.MeshLambertMaterial({ color: '#4b4238' })
    );
    roof.position.y = wallH;
    roof.rotation.x = -0.16;
    roof.name = 'trim';
    g.add(roof);
  } else if (kind.roof === 'deck') {
    /* A tower is legs and a platform: you can see under it. */
    walls.scale.set(0.22, 1, 0.22);
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = walls.clone();
      leg.position.set(ox * w * 0.38, wallH / 2, oz * d * 0.38);
      g.add(leg);
    }
    g.remove(walls);
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.18, d),
      new THREE.MeshLambertMaterial({ color: '#4b4238' })
    );
    deck.position.y = wallH;
    deck.name = 'trim';
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.9, d),
      new THREE.MeshLambertMaterial({ wireframe: true, color: '#4b4238' })
    );
    rail.position.y = wallH + 0.54;
    rail.name = 'trim';
    g.add(deck, rail);
  }
  return g;
}

/* --- one structure --------------------------------------------------- */

export function buildStructure(terrain, s) {
  const kind = kindOf(s.kind);
  const group = bodyFor(kind, s);
  group.name = 'structure';
  group.userData.id = s.id;

  const planned = s.status === 'planned';
  const colour = new THREE.Color(planned ? PLANNED : kind.colour);
  group.traverse((o) => {
    if (!o.isMesh) return;
    /* Trim keeps its own colour when built, so a roof reads as a roof;
       a proposal is all one colour, because it is all one idea. */
    if (planned || o.name !== 'trim') o.material.color.copy(colour);
    if (planned) {
      o.material.transparent = true;
      o.material.opacity = 0.42;
      o.material.depthWrite = false;
    }
    o.castShadow = !planned;
    o.userData.id = s.id;
  });

  if (planned) {
    /* An outline, so a ghost still has edges to judge a corner by. */
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
      new THREE.LineBasicMaterial({ color: PLANNED })
    );
    edges.position.copy(centre);
    edges.userData.id = s.id;
    group.add(edges);
  }

  place(terrain, group, s);
  return group;
}

/**
 * Sit it on the ground and turn it to face the right way. Rotation is
 * degrees clockwise from grid north, the way a bearing is written; the
 * scene's y axis turns the other way, hence the sign.
 */
export function place(terrain, group, s) {
  const { x, z } = terrain.toWorld(s.lat, s.lng);
  group.position.set(x, terrain.heightAt(x, z), z);
  group.rotation.y = -(s.rot || 0) * Math.PI / 180;
  group.userData.lat = s.lat;
  group.userData.lng = s.lng;
}

/**
 * How level the ground under a footprint is. A cabin on a one-in-six
 * slope needs to know that before it is drawn, not after it is built,
 * so the viewer reports the drop across the footprint corners.
 */
export function groundFall(terrain, s) {
  const { x, z } = terrain.toWorld(s.lat, s.lng);
  const a = -(s.rot || 0) * Math.PI / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let low = Infinity;
  let high = -Infinity;
  for (const [ox, oz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
    const dx = ox * s.w;
    const dz = oz * s.d;
    const h = terrain.heightAt(x + dx * cos - dz * sin, z + dx * sin + dz * cos);
    if (h < low) low = h;
    if (h > high) high = h;
  }
  return high - low;
}
