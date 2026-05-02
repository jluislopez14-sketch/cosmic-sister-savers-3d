// Scenery.js — Per-mission environment props.
//
// Each builder returns a THREE.Group anchored at world origin with its own
// internal animation hook (group.userData.tick(dt) if present). Game.js shows
// one group at a time and ticks the active group's animation.

import * as THREE from 'three';

// =====================================================================
// Mission 1 — Earth from above + distant planets
// =====================================================================
function buildSpaceScenery() {
  const g = new THREE.Group();

  // Earth — big sphere far below the play plane, slowly rotating
  const earthMat = new THREE.MeshStandardMaterial({
    color: 0x2a72d6, emissive: 0x0a2845, emissiveIntensity: 0.4, roughness: 0.8,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(28, 36, 28), earthMat);
  earth.position.set(0, -34, -36);
  g.add(earth);

  // Continents — random green patches via plane decals on the surface
  const contMat = new THREE.MeshStandardMaterial({ color: 0x3aaa5a, emissive: 0x1f6033, emissiveIntensity: 0.3, roughness: 0.9 });
  for (let i = 0; i < 7; i++) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(28.15, 16, 12,
      Math.random() * Math.PI * 2, 0.4 + Math.random() * 0.5,
      Math.random() * Math.PI, 0.3 + Math.random() * 0.4), contMat);
    c.position.copy(earth.position);
    g.add(c);
  }

  // Atmospheric halo (additive cyan glow)
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(29.5, 32, 24),
    new THREE.MeshBasicMaterial({ color: 0x55c8ff, transparent: true, opacity: 0.18, side: THREE.BackSide })
  );
  halo.position.copy(earth.position);
  g.add(halo);

  // Distant planets / nebula clouds
  const planetMats = [0xff66cc, 0xffd24c, 0x66ff77];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(2 + Math.random() * 2, 18, 12),
      new THREE.MeshStandardMaterial({ color: planetMats[i], emissive: planetMats[i], emissiveIntensity: 0.45, roughness: 0.8 })
    );
    p.position.set(THREE.MathUtils.randFloatSpread(40), 6 + Math.random() * 6, -45 - Math.random() * 15);
    g.add(p);
  }

  // Floating debris specks — small static rocks
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.95 });
  for (let i = 0; i < 14; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3 + Math.random() * 0.4, 0), rockMat);
    r.position.set(THREE.MathUtils.randFloatSpread(28), -2 + Math.random() * 8, -22 - Math.random() * 14);
    g.add(r);
  }

  g.userData.tick = (dt) => { earth.rotation.y += 0.015 * dt; };
  return g;
}

// =====================================================================
// Mission 2 — Atmospheric Re-Entry: fire streaks, plasma trails
// =====================================================================
function buildReEntryScenery() {
  const g = new THREE.Group();

  // Glowing orange/red fire streaks streaming up past the camera
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xff6622, transparent: true, opacity: 0.55 });
  const streaks = [];
  for (let i = 0; i < 60; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 2.5), streakMat.clone());
    s.material.color.setHex([0xff6622, 0xff9933, 0xffd24c, 0xff3344][Math.floor(Math.random()*4)]);
    s.position.set(THREE.MathUtils.randFloatSpread(20), THREE.MathUtils.randFloatSpread(8), -30 + Math.random() * 36);
    s._spd = 22 + Math.random() * 22;
    streaks.push(s); g.add(s);
  }

  // Distant glowing planet surface (target)
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(20, 28, 20),
    new THREE.MeshStandardMaterial({ color: 0xff7755, emissive: 0x88331a, emissiveIntensity: 0.6, roughness: 0.85 })
  );
  planet.position.set(0, -22, -38);
  g.add(planet);

  // Hot atmospheric haze
  const haze = new THREE.Mesh(
    new THREE.SphereGeometry(21, 24, 18),
    new THREE.MeshBasicMaterial({ color: 0xff8855, transparent: true, opacity: 0.25, side: THREE.BackSide })
  );
  haze.position.copy(planet.position);
  g.add(haze);

  g.userData.tick = (dt) => {
    for (const s of streaks) {
      s.position.z += s._spd * dt;
      if (s.position.z > 12) {
        s.position.z = -28;
        s.position.x = THREE.MathUtils.randFloatSpread(20);
        s.position.y = THREE.MathUtils.randFloatSpread(8);
      }
    }
    planet.rotation.y += 0.02 * dt;
  };
  return g;
}

// =====================================================================
// Mission 3 — Crystal Caves: glow rocks, stalactites
// =====================================================================
function buildCaveScenery() {
  const g = new THREE.Group();

  const matCrystal = new THREE.MeshStandardMaterial({ color: 0xa050ff, emissive: 0xa050ff, emissiveIntensity: 0.65, roughness: 0.4 });
  const matCrystalCool = new THREE.MeshStandardMaterial({ color: 0x55c8ff, emissive: 0x55c8ff, emissiveIntensity: 0.6, roughness: 0.4 });
  const matRockBack = new THREE.MeshStandardMaterial({ color: 0x281648, roughness: 0.95 });

  // Side walls (long rectangular slabs)
  for (const sx of [-5.2, 5.2]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 60), matRockBack);
    wall.position.set(sx, 1.7, -22);
    g.add(wall);
  }

  // Stalactites hanging from above
  for (let i = 0; i < 12; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 6), matCrystal.clone());
    c.material.emissiveIntensity = 0.4 + Math.random() * 0.4;
    c.position.set(THREE.MathUtils.randFloatSpread(8), 4 + Math.random() * 1.2, -2 - i * 4);
    c.rotation.x = Math.PI;
    g.add(c);
  }

  // Floor crystals along the path edges
  for (let i = 0; i < 18; i++) {
    const big = Math.random() < 0.4;
    const mat = (Math.random() < 0.5 ? matCrystal : matCrystalCool).clone();
    mat.emissiveIntensity = 0.5 + Math.random() * 0.3;
    const c = new THREE.Mesh(new THREE.ConeGeometry(big ? 0.6 : 0.30, big ? 1.6 : 0.9, 5), mat);
    const sideX = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 1.8);
    c.position.set(sideX, big ? 0.8 : 0.45, 2 - i * 3);
    c.rotation.z = (Math.random() - 0.5) * 0.3;
    g.add(c);
  }

  g.userData.tick = (dt) => {
    // Subtle pulsing
    const p = 0.5 + 0.3 * Math.sin(performance.now() * 0.002);
    for (const c of g.children) {
      if (c.material && c.material.emissiveIntensity != null && c.material.color.getHex() !== 0x281648) {
        c.material.emissiveIntensity = p * 1.2;
      }
    }
  };
  return g;
}

// =====================================================================
// Mission 4 — Boss Arena: platform, glowing pillars, distant horizon
// =====================================================================
function buildBossScenery() {
  const g = new THREE.Group();

  // Big circular platform under the action
  const plat = new THREE.Mesh(
    new THREE.CylinderGeometry(14, 14, 0.4, 32),
    new THREE.MeshStandardMaterial({ color: 0x1a0830, emissive: 0x140626, emissiveIntensity: 0.4, roughness: 0.8 })
  );
  plat.position.set(0, -0.4, -4);
  g.add(plat);

  // Inset rim — glowing ring
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(13, 0.25, 14, 64),
    new THREE.MeshStandardMaterial({ color: 0xff3344, emissive: 0xff3344, emissiveIntensity: 0.9 })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, -0.18, -4);
  g.add(rim);

  // Glowing pillars at the back corners
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6633aa, emissive: 0x6633aa, emissiveIntensity: 0.7, roughness: 0.5 });
  const pillarPositions = [[-9, -10], [9, -10], [-7, -16], [7, -16]];
  for (const [x, z] of pillarPositions) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.8, 5, 0.8), pillarMat);
    p.position.set(x, 2.3, z);
    g.add(p);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 14, 8),
      new THREE.MeshBasicMaterial({ color: 0xff66cc })
    );
    cap.position.set(x, 5.2, z);
    g.add(cap);
  }

  // Distant ominous horizon
  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 25),
    new THREE.MeshBasicMaterial({ color: 0x3a0820, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  horizon.position.set(0, 8, -34);
  g.add(horizon);

  g.userData.tick = (dt) => {
    rim.rotation.z += 0.5 * dt;
  };
  return g;
}

// =====================================================================
// Public — build all four scenery groups (lazy)
// =====================================================================
export function buildAllScenery() {
  return {
    space:   buildSpaceScenery(),
    reentry: buildReEntryScenery(),
    cave:    buildCaveScenery(),
    boss:    buildBossScenery(),
  };
}
