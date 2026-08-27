/* ------------------------------------------------------------------ *
 * The wood.
 *
 * Every stem here was found by subtracting the bare-earth model from
 * the first-return model and looking for the local peaks of what is
 * left, so the positions and the heights are measured rather than
 * scattered about. Five hundred-odd trees on seven acres, which is
 * what a mature Wealden broadleaf stand actually looks like.
 *
 * They are drawn as two instanced meshes - trunks and crowns - because
 * five hundred separate objects is five hundred draw calls, and this
 * has to stay smooth on a laptop in a shed with no mains power.
 * ------------------------------------------------------------------ */

import * as THREE from 'three';

const TRUNK = new THREE.Color('#4a3f33');
const CANOPY_LOW = new THREE.Color('#42502e');
const CANOPY_HIGH = new THREE.Color('#6d8047');

/**
 * Deterministic jitter. Trees drawn from a grid look like an orchard,
 * and the same tree has to look the same on every reload, so the
 * variation comes from the position rather than from a random number.
 */
function wobble(x, y, salt) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

export function buildTrees(terrain, trees) {
  const group = new THREE.Group();
  group.name = 'trees';
  if (!trees.length) return group;

  /* Low-poly on purpose: the shape of the stand is the information,
     and a hundred thousand leaves would only cost frames. */
  const trunkGeom = new THREE.CylinderGeometry(0.16, 0.26, 1, 5, 1, true);
  const crownGeom = new THREE.IcosahedronGeometry(1, 0);

  const trunks = new THREE.InstancedMesh(
    trunkGeom,
    new THREE.MeshLambertMaterial({ color: TRUNK, side: THREE.DoubleSide }),
    trees.length
  );
  /* The per-instance colour multiplies the material's, so the material
     stays white and every crown gets its own shade from setColorAt.
     Turning on vertexColors here instead would look for an attribute
     the geometry does not have, and every tree would come out black. */
  const crowns = new THREE.InstancedMesh(
    crownGeom,
    new THREE.MeshLambertMaterial({ flatShading: true }),
    trees.length
  );

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tint = new THREE.Color();

  trees.forEach((t, i) => {
    const ground = terrain.heightAt(t.x, t.y);
    const h = t.h;
    /* Roughly two-thirds crown, one-third clear trunk, which is what a
       closed-canopy broadleaf does as it reaches for the light. */
    const trunkH = h * 0.38;
    const crownH = h - trunkH;
    const spread = crownH * (0.34 + 0.10 * wobble(t.x, t.y, 3));

    pos.set(t.x, ground + trunkH / 2, t.y);
    scale.set(1, trunkH, 1);
    m.compose(pos, q, scale);
    trunks.setMatrixAt(i, m);

    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), wobble(t.x, t.y, 7) * Math.PI * 2);
    pos.set(t.x, ground + trunkH + crownH / 2, t.y);
    scale.set(spread, crownH / 2, spread);
    m.compose(pos, q, scale);
    crowns.setMatrixAt(i, m);
    q.identity();

    /* Taller trees sit in more light, so they read lighter. */
    tint.copy(CANOPY_LOW).lerp(CANOPY_HIGH, Math.min(1, (h - 6) / 24))
      .offsetHSL(0, 0, (wobble(t.x, t.y, 11) - 0.5) * 0.06);
    crowns.setColorAt(i, tint);
  });

  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  trunks.frustumCulled = false;
  crowns.frustumCulled = false;

  group.add(trunks, crowns);
  group.userData.count = trees.length;
  return group;
}
