// InputManager.js — Pointer input with two modes.
//
//   STEER     (default): drag to set a world-space target on the XZ play plane.
//                        The ship eases toward `this.target`.
//   LANE_TAP  : single tap → onTap();   horizontal swipe → onSwipe(±1).
//                        Used by the on-foot mission for jump + lane-switch.
//
// Mobile-friendly: passive-disabled touch listeners, gesture preventDefault.

import * as THREE from 'three';

const SWIPE_THRESHOLD_PX = 30;
const TAP_MAX_TRAVEL_PX  = 12;
const TAP_MAX_DURATION_MS = 220;

export class InputManager {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.mode = 'STEER';
    this.callbacks = { onTap: null, onSwipe: null };

    // STEER state
    this.active = false;
    this.target = new THREE.Vector3();
    this.hasTarget = false;

    // Tap/swipe state
    this._touchStart = null;
    this._touchStartT = 0;
    this._touchLast = null;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._intersect = new THREE.Vector3();

    this._bind();
  }

  /**
   * Switch input mode. Optional callbacks for LANE_TAP:
   *   setMode('LANE_TAP', { onTap: () => {}, onSwipe: (dir) => {} });
   */
  setMode(mode, opts = {}) {
    if (mode === this.mode && !opts.onTap && !opts.onSwipe) return;
    this.mode = mode;
    this.callbacks.onTap   = opts.onTap   || this.callbacks.onTap;
    this.callbacks.onSwipe = opts.onSwipe || this.callbacks.onSwipe;
    this.hasTarget = false;
    this.active = false;
    console.log(`[Input] mode → ${mode}`);
  }

  _project(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this._ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._ndc, this.camera);
    if (this._raycaster.ray.intersectPlane(this._plane, this._intersect)) {
      this.target.copy(this._intersect);
      this.hasTarget = true;
    }
  }

  _onDown(x, y) {
    this.active = true;
    this._touchStart = { x, y };
    this._touchStartT = performance.now();
    this._touchLast = { x, y };
    if (this.mode === 'STEER') this._project(x, y);
  }

  _onMove(x, y) {
    this._touchLast = { x, y };
    if (this.mode === 'STEER' && this.active) this._project(x, y);
  }

  _onUp() {
    if (!this.active) return;
    this.active = false;
    if (this.mode === 'LANE_TAP' && this._touchStart && this._touchLast) {
      const dx = this._touchLast.x - this._touchStart.x;
      const dy = this._touchLast.y - this._touchStart.y;
      const dt = performance.now() - this._touchStartT;
      const travel = Math.hypot(dx, dy);
      if (travel < TAP_MAX_TRAVEL_PX && dt < TAP_MAX_DURATION_MS) {
        this.callbacks.onTap?.();
      } else if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
        this.callbacks.onSwipe?.(dx > 0 ? 1 : -1);
      }
    }
  }

  _bind() {
    const c = this.canvas;
    // Touch
    c.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0]; if (!t) return;
      this._onDown(t.clientX, t.clientY);
    }, { passive: false });
    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0]; if (!t) return;
      this._onMove(t.clientX, t.clientY);
    }, { passive: false });
    const end = (e) => { e?.preventDefault?.(); this._onUp(); };
    c.addEventListener('touchend', end, { passive: false });
    c.addEventListener('touchcancel', end, { passive: false });

    // Mouse
    let mouseDown = false;
    c.addEventListener('mousedown', (e) => { mouseDown = true; this._onDown(e.clientX, e.clientY); });
    c.addEventListener('mousemove', (e) => { if (mouseDown) this._onMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; this._onUp(); } });

    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
