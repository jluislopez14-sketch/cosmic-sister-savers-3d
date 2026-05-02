// Particles.js — Lightweight particle effects for explosions, trails,
// pickups, and floating score text. Designed for mobile: max ~120 active
// particles total, tiny Mesh primitives (sphere instances of a shared geom).

import * as THREE from 'three';

const SHARED_GEOM = new THREE.SphereGeometry(0.12, 6, 5);

class Particle {
  constructor(scene) {
    this.mesh = new THREE.Mesh(
      SHARED_GEOM,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 })
    );
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.alive = false;
  }

  spawn({ pos, vel, color, life, scale = 1, gravity = 0, fade = true }) {
    this.mesh.position.copy(pos);
    this.mesh.scale.setScalar(scale);
    this.mesh.material.color.setHex(color);
    this.mesh.material.opacity = 1.0;
    this.mesh.visible = true;
    this.vel = vel.clone();
    this.life = life;
    this._maxLife = life;
    this.gravity = gravity;
    this.fade = fade;
    this.alive = true;
  }

  tick(dt) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) { this.kill(); return; }
    this.vel.y -= this.gravity * dt;
    this.mesh.position.x += this.vel.x * dt;
    this.mesh.position.y += this.vel.y * dt;
    this.mesh.position.z += this.vel.z * dt;
    if (this.fade) this.mesh.material.opacity = Math.max(0, this.life / this._maxLife);
  }

  kill() { this.alive = false; this.mesh.visible = false; }
}

export class Particles {
  constructor(scene, max = 120) {
    this.scene = scene;
    this.pool = Array.from({ length: max }, () => new Particle(scene));
    this._scoreEls = [];        // floating score popups (DOM)
    this._scoreContainer = null;
  }

  _take() {
    for (const p of this.pool) if (!p.alive) return p;
    return null;
  }

  /** Generic burst: N particles flying outward from a point. */
  burst(pos, { count = 14, color = 0xff66cc, speed = 6, life = 0.8, scale = 1, gravity = 0, spread = 1.0 } = {}) {
    for (let i = 0; i < count; i++) {
      const p = this._take();
      if (!p) return;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const v = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi)
      ).multiplyScalar(speed * (0.5 + Math.random() * 0.5) * spread);
      p.spawn({ pos, vel: v, color, life: life * (0.7 + Math.random() * 0.6), scale, gravity });
    }
  }

  /** Engine trail: a couple of small fading particles. */
  trail(pos, { color = 0x80c8ff, scale = 0.6, life = 0.35 } = {}) {
    const p = this._take();
    if (!p) return;
    const v = new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 4 + Math.random() * 2);
    p.spawn({ pos, vel: v, color, life, scale });
  }

  /** Sparkle: bright tiny particles with no gravity. */
  sparkle(pos, { count = 8, color = 0xffd24c, speed = 3, life = 0.6, scale = 0.8 } = {}) {
    this.burst(pos, { count, color, speed, life, scale, gravity: 0, spread: 0.7 });
  }

  /** Heart pickup ring: bright pink ring of particles. */
  heartPickup(pos) {
    for (let i = 0; i < 12; i++) {
      const p = this._take();
      if (!p) return;
      const a = (i / 12) * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * 4, 2 + Math.random() * 1, Math.sin(a) * 4);
      p.spawn({ pos, vel: v, color: 0xff66cc, life: 0.7, scale: 0.9 });
    }
  }

  /** Hit-flash: a big bright pop, fades fast. */
  flash(pos, { color = 0xffffff, scale = 2.5, life = 0.18 } = {}) {
    const p = this._take();
    if (!p) return;
    p.spawn({ pos, vel: new THREE.Vector3(), color, life, scale });
  }

  /** Floating score text (DOM-based, follows projected world position). */
  scorePopup(worldPos, camera, canvas, text = '+10', color = '#ffe45e') {
    if (!this._scoreContainer) {
      this._scoreContainer = document.createElement('div');
      this._scoreContainer.id = 'score-popups';
      this._scoreContainer.style.cssText =
        'position:absolute;inset:0;pointer-events:none;z-index:25;overflow:hidden';
      canvas.parentElement.appendChild(this._scoreContainer);
    }
    const projected = worldPos.clone().project(camera);
    const rect = canvas.getBoundingClientRect();
    const x = (projected.x * 0.5 + 0.5) * rect.width;
    const y = (-projected.y * 0.5 + 0.5) * rect.height;
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `
      position:absolute;left:${x}px;top:${y}px;
      transform:translate(-50%,-50%);
      color:${color};font-weight:900;font-size:16px;
      letter-spacing:1px;text-shadow:0 2px 4px #000, 0 0 8px ${color};
      transition:transform 0.7s ease-out, opacity 0.7s ease-out;
      will-change:transform,opacity;`;
    this._scoreContainer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(-50%, calc(-50% - 40px))`;
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 750);
  }

  tick(dt) {
    for (const p of this.pool) p.tick(dt);
  }
}
