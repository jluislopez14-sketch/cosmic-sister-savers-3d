// Game.js — Cosmic Sister Savers Three.js engine.
//
// Owns: WebGL renderer, scene, dynamic camera, lighting, starfield, runners
// + player ship, asset loading, audio, input. Delegates per-mission logic
// to LevelManager. Exposes shared helpers (_updateShip, _spawnEnemy, etc.)
// that Mission classes call so per-mode code stays tight.
//
// State machine:  boot → menu → story → mission → (merge?) → victory|gameover.
// Camera modes:   TOP_DOWN, TOP_DOWN_SHAKE, ANGLED_FOLLOW, WIDE_ARENA.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'; // (kept for parity; real loading lives in AssetLoader)
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LEVELS, LevelManager } from './LevelManager.js';
import { STORY }        from './StoryData.js';
import { InputManager } from './InputManager.js';
import { AudioManager } from './AudioManager.js';
import { AssetLoader }  from './AssetLoader.js';
import { Particles }    from './Particles.js';
import { buildAllScenery } from './Scenery.js';
import { SaveData }     from './SaveData.js';
import { AchievementsManager, ACHIEVEMENTS } from './Achievements.js';
import { RemoteLeaderboard } from './RemoteLeaderboard.js';
import { UPGRADES } from './SaveData.js';

// ---------- World tunables ----------
const BOUNDS = { xMin: -7, xMax: 7, zMin: -8, zMax: 5.5 };
const PLAYER_RADIUS = 0.9;
const ENEMY_RADIUS  = 0.7;
const HEART_RADIUS  = 0.6;
const BEAM_RADIUS   = 0.35;
const BEAM_SPEED    = 28;
const BEAM_LIFE     = 1.5;
const BOSS_BULLET_SPEED  = 8;
const BOSS_BULLET_RADIUS = 0.4;

// ---------- Camera presets per mode ----------
const CAMERA_PRESETS = {
  TOP_DOWN:        { pos: [0, 16,  6], look: [0, 0, -2], fov: 50 },
  TOP_DOWN_SHAKE:  { pos: [0, 16,  6], look: [0, 0, -2], fov: 52 },
  ANGLED_FOLLOW:   { pos: [0,  6.5, 9], look: [0, 1, -3], fov: 55 },
  WIDE_ARENA:      { pos: [0, 11, 13], look: [0, 1, -4], fov: 60 },
};

// ---------- Helpers ----------
function fitToHeight(obj, h) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); box.getSize(size);
  if (size.y > 0) obj.scale.multiplyScalar(h / size.y);
}

// ---------- Game ----------
export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state  = 'boot';
    this.lives  = 3;
    this.score  = 0;
    this.resonance = 0;

    this.assetLoader = new AssetLoader();
    this.audio       = new AudioManager();
    this.levels      = new LevelManager(this);
    this.particles   = null;          // populated in _initThree (needs scene)
    this.save        = new SaveData();
    this.hardMode    = !!this.save.hardModePreferred && this.save.hardModeUnlocked;
    this.achievements = new AchievementsManager(this.save, (a) => {
      this._toast('UNLOCKED', a.label, a.icon);
      this.audio.sfx('combo');
    });
    this.remote = new RemoteLeaderboard();
    // Mission-complete tracking
    this._missionLivesAtStart = 3;

    // Combo + transient FX state
    this.combo = 0;
    this._comboT = 0;
    this._comboTimeout = 2.5;     // seconds since last kill before combo resets
    this._engineTrailT = 0;
    this._missionElapsed = 0;
    this._invuln = 0;              // i-frames after hit (seconds)
    this._shieldT = 0;             // active shield power-up timer
    this._tripleBeamT = 0;         // active triple-beam power-up timer
    this._paused = false;
    this._mechMode = false;        // true after merge — player gets mech visual + screen-clear
    this._coopMode = false;        // 2-player local co-op
    this._p2Keys = { up: false, down: false, left: false, right: false };
    // Dynamic difficulty
    this._lastDamageT = -999;
    this._noDamageT   = 0;
    // Animation system: registry of model instances + active mixers
    this._modelInstances = {};     // name → { scene, mixer, actions, collisionBoxes }
    this._mixers = new Set();      // every active AnimationMixer to tick each frame
    this._cinematicCam = null;     // overrides the live camera while non-null
    // Daily challenge / seeded RNG
    this._rng = Math.random;
    this._dailyMode = false;
    this._dailySeed = 0;

    // Camera management
    this._currentPos  = new THREE.Vector3();
    this._currentLook = new THREE.Vector3();
    this._targetPos   = new THREE.Vector3();
    this._targetLook  = new THREE.Vector3();
    this._shakeOffset = new THREE.Vector3();
    this._cameraMode  = null;

    // Game-wide projectile pools
    this.beams = [];
    this.bossBullets = [];
  }

  // ============ LIFECYCLE ============
  async boot() {
    console.log('[Game] boot');
    this._initThree();
    this._wireUI();
    await this.assetLoader.loadAll();
    this._buildScene();
    this.input = new InputManager(this.canvas, this.camera);
    this._enterMenu();
    document.getElementById('loading')?.classList.add('hidden');
    console.log('[Game] ready');
  }

  start() {
    let last = performance.now() / 1000;
    const loop = () => {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, now - last);
      last = now;
      this._tick(dt);
      // If a cinematic camera is engaged (e.g. boss intro), render through it.
      if (this._cinematicCam) {
        // EffectComposer's RenderPass uses scene+camera bound at construction;
        // swap it temporarily for the cinematic shot.
        const passes = this.composer.passes;
        const renderPass = passes.find((p) => p.constructor.name === 'RenderPass');
        if (renderPass) {
          const saved = renderPass.camera;
          renderPass.camera = this._cinematicCam;
          this.composer.render();
          renderPass.camera = saved;
        } else {
          this.renderer.render(this.scene, this._cinematicCam);
        }
      } else {
        this.composer.render();
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  // ============ THREE SETUP ============
  _initThree() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x05021a, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x05021a, 18, 55);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 220);
    this._applyCameraPreset(CAMERA_PRESETS.TOP_DOWN, /*instant*/ true);

    // Post-processing: bloom for emissive materials, beams, eyes, etc.
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this._bloom = new UnrealBloomPass(new THREE.Vector2(640, 800), 0.65, 0.4, 0.85);
    this.composer.addPass(this._bloom);

    const onResize = () => {
      const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
      const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
      renderer.setSize(w, h, false);
      this.composer.setSize(w, h);
      this._bloom.resolution.set(w, h);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
    };
    onResize();
    window.addEventListener('resize', onResize);

    // Lights — three-point with kid-friendly warm color
    this.scene.add(new THREE.AmbientLight(0xb39ad6, 0.7));
    const sun = new THREE.DirectionalLight(0xfff0e0, 1.2);
    sun.position.set(4, 14, 6);     this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x80c8ff, 0.6);
    fill.position.set(-6, 6, 2);    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xff66cc, 0.7);
    rim.position.set(0, 5, -10);    this.scene.add(rim);

    // Background tint (level-specific)
    this.bgTint = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 80),
      new THREE.MeshBasicMaterial({ color: 0x150633, transparent: true, opacity: 0.55, depthWrite: false }));
    this.bgTint.position.set(0, 0, -45);
    this.scene.add(this.bgTint);

    // Starfield
    this.stars = this._makeStars(900, 90);
    this.scene.add(this.stars);

    // Particle system (after scene exists)
    this.particles = new Particles(this.scene);
  }

  _makeStars(count, radius) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = radius * (0.4 + Math.random() * 0.6);
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      positions[i*3+0] = r * Math.sin(p) * Math.cos(t);
      positions[i*3+1] = r * Math.sin(p) * Math.sin(t) * 0.5;
      positions[i*3+2] = r * Math.cos(p);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.20, sizeAttenuation: true, opacity: 0.85, transparent: true,
    }));
  }

  _buildScene() {
    // Player ship
    this.playerShip = new THREE.Group();
    const ship = this.assetLoader.get('player_ship');
    fitToHeight(ship, 1.6);
    ship.rotation.y = Math.PI; // Blender forward (-Y) → world -Z
    ship.position.y = 0.5;
    this.playerShip.add(ship);
    this.playerShip.position.set(0, 0, 4);
    this.scene.add(this.playerShip);

    // Visible companions in the cockpit row + Greeny on top
    this._mountCompanion('alaia',   -0.45, 0.92, -0.10, 0.55);
    this._mountCompanion('lisabel',  0.00, 0.95, -0.10, 0.60);
    this._mountCompanion('jose',     0.45, 0.96, -0.10, 0.65);
    this._mountCompanion('greeny',   0.00, 1.20,  0.30, 0.45);

    // 3D resonance gauge — glowing torus orbiting the player ship
    const ringGeom = new THREE.TorusGeometry(1.4, 0.10, 12, 48);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x55c8ff, emissive: 0x55c8ff, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.5,
      transparent: true, opacity: 0.85,
    });
    this.resoRing = new THREE.Mesh(ringGeom, ringMat);
    this.resoRing.rotation.x = Math.PI / 2;
    this.resoRing.position.y = 0.4;
    this.playerShip.add(this.resoRing);

    // A second smaller filling ring that scales with resonance %
    const fillGeom = new THREE.TorusGeometry(1.4, 0.18, 12, 48);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0xffd24c, transparent: true, opacity: 0.75 });
    this.resoFillRing = new THREE.Mesh(fillGeom, fillMat);
    this.resoFillRing.rotation.x = Math.PI / 2;
    this.resoFillRing.position.y = 0.4;
    this.resoFillRing.scale.set(0.01, 0.01, 0.01);
    this.playerShip.add(this.resoFillRing);

    // Runners (Lisabel + Alaia side by side, on-foot mission)
    this.runners = new THREE.Group();
    const lis = this.assetLoader.get('lisabel'); fitToHeight(lis, 1.55); lis.position.x = -0.7; lis.rotation.y = Math.PI;
    const ala = this.assetLoader.get('alaia');   fitToHeight(ala, 1.30); ala.position.x =  0.7; ala.rotation.y = Math.PI;
    this.runners.add(lis); this.runners.add(ala);
    this.runners.position.set(0, 0, 4);
    this.runners.visible = false;
    this.scene.add(this.runners);

    // Procedural cave ground (only visible during mission 3)
    this.cave = this._makeCaveGround();
    this.cave.visible = false;
    this.scene.add(this.cave);

    // Per-mission scenery groups (one visible at a time)
    this.scenery = buildAllScenery();
    for (const key of Object.keys(this.scenery)) {
      this.scenery[key].visible = false;
      this.scene.add(this.scenery[key]);
    }
    this._activeScenery = null;

    // Menu showcase: all 5 family avatars in a slow-rotating row
    this._buildMenuShowcase();
  }

  _buildMenuShowcase() {
    this.menuShowcase = new THREE.Group();
    const lineup = [
      ['greeny',  -4.0, 0.95],
      ['alaia',   -2.0, 1.20],
      ['lisabel',  0.0, 1.45],
      ['jose',     2.0, 1.55],
      ['mom',      4.0, 1.50],
    ];
    for (const [key, x, h] of lineup) {
      const a = this.assetLoader.get(key);
      fitToHeight(a, h);
      a.position.set(x, 0, 0);
      a.rotation.y = Math.PI;
      a.userData.bobOffset = Math.random() * Math.PI * 2;
      this.menuShowcase.add(a);
    }
    this.menuShowcase.position.set(0, 0.6, 1);
    this.menuShowcase.visible = false;
    this.scene.add(this.menuShowcase);
  }

  _setActiveScenery(name) {
    if (this._activeScenery === name) return;
    for (const k of Object.keys(this.scenery)) this.scenery[k].visible = (k === name);
    this._activeScenery = name;
    // Activate matching env-GLB if loaded
    this._setActiveEnvGLB(name === 'space' ? 'env_space_track'
                          : name === 'boss' ? 'env_boss_arena'
                          : null);
    console.log(`[Scenery] active → ${name}`);
  }

  /** Show/hide loaded environment GLBs by key. */
  _setActiveEnvGLB(envKey) {
    // First, hide every env we previously instanced
    for (const k of Object.keys(this._envInstances || {})) {
      const inst = this._envInstances[k];
      if (inst?.scene) inst.scene.visible = false;
    }
    if (!envKey) return;
    if (!this._envInstances) this._envInstances = {};
    let inst = this._envInstances[envKey];
    if (!inst) {
      const proto = this.assetLoader.cache[envKey];
      if (!proto || proto.placeholder) return;   // nothing to show
      // Build an infinite-scroll setup for the space track: 2 clones placed sequentially on -Z
      if (envKey === 'env_space_track') {
        const grp = new THREE.Group();
        const a = this.assetLoader.get(envKey);
        const b = this.assetLoader.get(envKey);
        // Measure track length on Z
        const box = new THREE.Box3().setFromObject(a);
        const len = Math.max(20, box.max.z - box.min.z);
        a.position.set(0, 0, 0);
        b.position.set(0, 0, -len);
        grp.add(a); grp.add(b);
        grp.userData.scrollLen = len;
        grp.userData.tiles = [a, b];
        this.scene.add(grp);
        inst = { scene: grp, key: envKey };
      } else {
        // Static env: just clone + position
        const g = this.assetLoader.get(envKey);
        this.scene.add(g);
        inst = { scene: g, key: envKey };
        // Boss arena: detect cinematic camera
        const cached = this.assetLoader.cache[envKey];
        if (cached && cached.embeddedCamera) {
          // Attach a clone of the camera so it follows the env transform
          inst.cinematicCamera = cached.embeddedCamera.clone();
          this.scene.add(inst.cinematicCamera);
        }
      }
      this._envInstances[envKey] = inst;
    }
    inst.scene.visible = true;
  }

  /** Called each frame in mission mode to scroll the space track infinitely. */
  _tickEnvScroll(dt) {
    const inst = this._envInstances?.env_space_track;
    if (!inst || !inst.scene.visible) return;
    const speed = 8;   // units/sec scrolling toward camera (+Z)
    const len = inst.scene.userData.scrollLen || 20;
    for (const tile of inst.scene.userData.tiles) {
      tile.position.z += speed * dt;
      if (tile.position.z > len) tile.position.z -= 2 * len;
    }
  }

  _makeCaveGround() {
    const group = new THREE.Group();
    const matRock    = new THREE.MeshStandardMaterial({ color: 0x3a1c5f, emissive: 0x150633, emissiveIntensity: 0.4, roughness: 0.85 });
    const matCrystal = new THREE.MeshStandardMaterial({ color: 0xa050ff, emissive: 0xa050ff, emissiveIntensity: 0.6, roughness: 0.4 });
    for (let i = -2; i <= 6; i++) {
      const tile = new THREE.Mesh(new THREE.BoxGeometry(8, 0.2, 4), matRock);
      tile.position.set(0, -0.1, -i*4);
      tile.userData.tile = true;
      group.add(tile);
    }
    for (let i = -2; i <= 6; i++) {
      const x = (i % 2 === 0) ? -3.5 : 3.5;
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 5), matCrystal);
      c.position.set(x, 0.6, -i*4 - 1);
      c.rotation.z = (Math.random() - 0.5) * 0.4;
      c.userData.tile = true;
      group.add(c);
    }
    return group;
  }

  /** Attach an avatar to the player-ship group, sized for visibility from the top-down camera. */
  _mountCompanion(key, x, y, z, height = 0.55) {
    const av = this.assetLoader.get(key);
    if (!av) return;
    fitToHeight(av, height);
    av.position.set(x, y, z);
    av.rotation.y = Math.PI;
    av.userData.companion = key;
    this.playerShip.add(av);
  }

  _showShip(flag)    {
    this.playerShip.visible = flag;
    if (this.playerShip2) this.playerShip2.visible = flag && this._coopMode;
  }
  _showRunners(flag) { this.runners.visible = flag; this.cave.visible = flag; }
  _setBgTint(hex)    { this.bgTint.material.color.setHex(hex); }
  _showMenuShowcase(flag) { if (this.menuShowcase) this.menuShowcase.visible = flag; }

  // ============ CAMERA ============
  setCameraMode(name) {
    if (name === this._cameraMode) return;
    const preset = CAMERA_PRESETS[name];
    if (!preset) { console.warn('[Camera] unknown mode', name); return; }
    console.log(`[Camera] mode → ${name}`);
    this._cameraMode = name;
    this._applyCameraPreset(preset, /*instant*/ false);
  }

  _applyCameraPreset(preset, instant) {
    this._targetPos.set(...preset.pos);
    this._targetLook.set(...preset.look);
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (instant) {
      this._currentPos.copy(this._targetPos);
      this._currentLook.copy(this._targetLook);
      this.camera.position.copy(this._currentPos);
      this.camera.lookAt(this._currentLook);
    }
  }

  _cameraShake(x, y) { this._shakeOffset.set(x, y, 0); }

  /** Dynamic Difficulty Adjustment multiplier.
      Returns >1 when player is doing well (no damage) and <1 right after a hit.
      Bounded to [0.8, 1.4] so missions stay playable in either direction. */
  _ddaMultiplier() {
    const since = this._missionElapsed - this._lastDamageT;
    if (since < 12) return 0.85;          // recent hit — ease off
    if (this._noDamageT > 25) return 1.30; // long no-damage — crank up
    if (this._noDamageT > 12) return 1.15;
    return 1.0;
  }

  /** Trigger a randomized burst shake of given intensity for `ms`. */
  _kickShake(intensity = 0.6, ms = 280) {
    if (this._kickShakeUntil && performance.now() < this._kickShakeUntil) {
      this._kickShakeAmp = Math.max(this._kickShakeAmp || 0, intensity);
      this._kickShakeUntil = Math.max(this._kickShakeUntil, performance.now() + ms);
    } else {
      this._kickShakeAmp = intensity;
      this._kickShakeUntil = performance.now() + ms;
    }
    this._kickShakeMs = ms;
  }

  // ============ ANIMATION SYSTEM ============

  /** Register an instanced rigged model so its mixer updates each frame. */
  registerInstance(name, instance) {
    this._modelInstances[name] = instance;
    if (instance.mixer) this._mixers.add(instance.mixer);
  }
  unregisterInstance(name) {
    const inst = this._modelInstances[name];
    if (!inst) return;
    if (inst.mixer) this._mixers.delete(inst.mixer);
    delete this._modelInstances[name];
  }

  /**
   * Crossfade-play an animation on a registered rigged model.
   *   game.playAnimation('player', 'Run');
   *   game.playAnimation('boss',   'Attack', { fade: 0.5, loop: false });
   * Returns the AnimationAction or null if the model/clip isn't loaded.
   */
  playAnimation(modelName, actionName, { fade = 0.20, loop = true } = {}) {
    const inst = this._modelInstances[modelName];
    if (!inst || !inst.actions) {
      console.warn(`[Anim] no instance "${modelName}"`);
      return null;
    }
    const next = inst.actions[actionName];
    if (!next) {
      console.warn(`[Anim] "${modelName}" has no action "${actionName}" — available: ${Object.keys(inst.actions).join(', ')}`);
      return null;
    }
    const prev = inst._currentAction;
    if (prev === next) return next;
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (!loop) next.clampWhenFinished = true;
    next.fadeIn(fade);
    next.play();
    if (prev && prev !== next) prev.fadeOut(fade);
    inst._currentAction = next;
    return next;
  }

  /** Tick all registered AnimationMixers. */
  _tickMixers(dt) {
    for (const m of this._mixers) m.update(dt);
  }

  /** Override the live camera with a cinematic camera (e.g. one embedded in
      a boss-arena GLB). Pass null to release. */
  setCinematicCamera(cam) {
    this._cinematicCam = cam;
    if (cam) console.log('[Camera] cinematic camera engaged');
    else     console.log('[Camera] cinematic camera released');
  }

  /** AABB-vs-point check against a world-space Box3 array.
      Used for COL_ collision boxes returned by AssetLoader. */
  static aabbContainsPoint(boxes, point) {
    for (const b of boxes) if (b.containsPoint(point)) return true;
    return false;
  }

  // ============ DETERMINISTIC RNG ============

  /** Mulberry32 — 32-bit, fast, fine for cosmetic spawns. Same seed → same stream. */
  _makeSeededRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Hash today's UTC date (YYYYMMDD) into a 32-bit seed. */
  _dailySeedFor(date = new Date()) {
    const ymd = `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,'0')}${String(date.getUTCDate()).padStart(2,'0')}`;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < ymd.length; i++) {
      h ^= ymd.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  /** Public getter — code that wants deterministic randomness uses this. */
  get rng() { return this._rng; }

  _updateCamera(dt) {
    this._currentPos.lerp(this._targetPos, Math.min(1, dt * 4));
    this._currentLook.lerp(this._targetLook, Math.min(1, dt * 4));
    // Composite: persistent shake offset + decaying random kick
    let kickX = 0, kickY = 0;
    if (this._kickShakeUntil && performance.now() < this._kickShakeUntil) {
      const remaining = (this._kickShakeUntil - performance.now()) / (this._kickShakeMs || 280);
      const amp = (this._kickShakeAmp || 0) * Math.max(0, remaining);
      kickX = (Math.random() - 0.5) * amp;
      kickY = (Math.random() - 0.5) * amp;
    }
    this.camera.position
      .copy(this._currentPos)
      .add(this._shakeOffset)
      .add(new THREE.Vector3(kickX, kickY, 0));
    this.camera.lookAt(this._currentLook);
    this._shakeOffset.multiplyScalar(0.85);
  }

  // ============ TICK ============
  _tick(dt) {
    if (this.stars) this.stars.rotation.y += 0.005 * dt;
    // Active scenery animation
    if (this._activeScenery) {
      const g = this.scenery[this._activeScenery];
      if (g?.userData?.tick) g.userData.tick(dt);
    }
    if (this.state === 'menu') {
      // Slow turntable rotation for the family showcase
      if (this.menuShowcase && this.menuShowcase.visible) {
        this.menuShowcase.rotation.y += 0.30 * dt;
        const t = performance.now() * 0.002;
        for (const child of this.menuShowcase.children) {
          child.position.y = Math.sin(t + (child.userData.bobOffset || 0)) * 0.10;
        }
      }
    } else if (this.state === 'mission') {
      if (this._paused) { this._updateCamera(dt); return; }
      this._missionElapsed += dt;
      this.levels.tick(dt);
      this._tickCombo(dt);
      this._tickEngineTrail(dt);
      this._tickRunnerAnimation(dt);
      this._tickInvulnAndPowerUps(dt);
      this._tickMechAura(dt);
      this._tickShipRainbow(dt);
      this._tickEnvScroll(dt);
      this._updatePlayer2(dt);
      this._noDamageT += dt;
      this._renderHUD();
    }
    if (this.particles) this.particles.tick(dt);
    this._tickMixers(dt);
    this._updateCamera(dt);
  }

  // ============ FX TICKS ============
  _tickMechAura(dt) {
    if (!this.mechAura) return;
    const t = performance.now() * 0.001 - (this.mechAura.userData.tStart || 0);
    this.mechAura.rotation.y += this.mechAura.userData.spin * dt;
    // Cycle color through hues
    const hue = (t * 0.4) % 1;
    this.mechAura.material.color.setHSL(hue, 0.85, 0.6);
    // Pulse opacity
    this.mechAura.material.opacity = 0.18 + 0.10 * Math.sin(t * 4);
  }

  _despawnMech() {
    if (this.mechAura) { this.playerShip.remove(this.mechAura); this.mechAura = null; }
    if (this.playerShip) this.playerShip.scale.setScalar(1.0);
    this._mechMode = false;
  }

  /** Player-2 hazard collision (shared lives, separate spatial check). */
  _checkP2Hazards(mission) {
    if (!this._coopMode || !this.playerShip2 || !this.playerShip2.visible || this._invuln > 0) return;
    for (let i = mission.entities.length - 1; i >= 0; i--) {
      const e = mission.entities[i];
      if (e.kind !== 'enemy' && e.kind !== 'debris' && e.kind !== 'bomb' && e.kind !== 'drone') continue;
      const r = (e.kind === 'bomb') ? 0.4 : (e.kind === 'drone' ? 0.45 : ENEMY_RADIUS);
      if (this.playerShip2.position.distanceTo(e.mesh.position) < PLAYER_RADIUS + r) {
        this._onPlayerHit(e.kind);
        this.particles.burst(e.mesh.position.clone(), { count: 10, color: 0x66ccff, speed: 4, life: 0.5 });
        this.scene.remove(e.mesh);
        mission.entities.splice(i, 1);
        return;
      }
    }
  }

  _tickInvulnAndPowerUps(dt) {
    if (this._invuln > 0) {
      this._invuln -= dt;
      // Flash the player while invulnerable
      const visible = Math.floor(performance.now() / 80) % 2 === 0;
      if (this.playerShip?.visible) {
        for (const c of this.playerShip.children) c.visible = visible || (c === this.resoRing) || (c === this.resoFillRing);
      }
      if (this._invuln <= 0) {
        if (this.playerShip) for (const c of this.playerShip.children) c.visible = true;
      }
    }
    if (this._shieldT > 0) {
      this._shieldT -= dt;
      if (this._shieldT <= 0 && this.shieldBubble) {
        this.shieldBubble.visible = false;
        this._toast('SHIELD', 'Faded', '💧');
      } else if (this.shieldBubble) {
        // Pulse and rotate the bubble
        const t = performance.now() * 0.004;
        this.shieldBubble.rotation.y = t;
        const pulse = 1 + 0.04 * Math.sin(t * 4);
        this.shieldBubble.scale.set(pulse, pulse, pulse);
      }
    }
    if (this._tripleBeamT > 0) {
      this._tripleBeamT -= dt;
      if (this._tripleBeamT <= 0) this._toast('TRIPLE', 'Beams reset', '✨');
    }
  }

  _tickCombo(dt) {
    if (this.combo > 0) {
      this._comboT -= dt;
      if (this._comboT <= 0) {
        this.combo = 0;
        const el = document.getElementById('hud-combo');
        if (el) el.classList.add('hidden');
      }
    }
  }

  _tickEngineTrail(dt) {
    if (!this.playerShip || !this.playerShip.visible) return;
    this._engineTrailT += dt;
    if (this._engineTrailT > 0.04) {
      this._engineTrailT = 0;
      const p = this.playerShip.position;
      this.particles.trail(new THREE.Vector3(p.x - 0.45, p.y + 0.25, p.z + 0.6),
        { color: 0x80c8ff, scale: 0.5, life: 0.3 });
      this.particles.trail(new THREE.Vector3(p.x + 0.45, p.y + 0.25, p.z + 0.6),
        { color: 0xff66cc, scale: 0.5, life: 0.3 });
    }
    // 3D resonance gauge animation
    if (this.resoRing && this.resoFillRing) {
      const r = this.resonance / 100;
      // Color ramps cyan → magenta → gold
      const col = new THREE.Color();
      if (r < 0.5) col.setRGB(0.33 + r * 1.34, 0.78 - r * 0.6, 1.0 - r * 0.30);
      else         col.setRGB(1.0, 0.5 + (r - 0.5) * 0.84, 0.85 - (r - 0.5) * 1.40);
      this.resoRing.material.emissive.copy(col);
      this.resoRing.material.color.copy(col);
      // Fill ring tube radius scales with resonance
      const s = 0.01 + r * 0.99;
      this.resoFillRing.scale.set(s, 1, s);
      this.resoFillRing.material.opacity = 0.30 + r * 0.55;
      const spin = (r >= 1.0 ? 4 : 0.6 + r * 1.6);
      this.resoRing.rotation.z += spin * dt;
      this.resoFillRing.rotation.z -= spin * 0.7 * dt;
      // 100% pulse
      if (r >= 1.0) {
        const pulse = 1 + 0.10 * Math.sin(performance.now() * 0.012);
        this.resoRing.scale.set(pulse, pulse, 1);
      } else {
        this.resoRing.scale.set(1, 1, 1);
      }
    }
  }

  _tickRunnerAnimation(dt) {
    if (!this.runners || !this.runners.visible) return;
    const t = performance.now() * 0.012;
    const grounded = this.runners.position.y < 0.05;
    const amp = grounded ? 1.0 : 0.3;
    let i = 0;
    for (const child of this.runners.children) {
      // Bob each runner with offset phase + slight roll for swagger
      child.position.y = Math.abs(Math.sin(t + i * Math.PI)) * 0.10 * amp;
      child.rotation.z = Math.sin(t + i * Math.PI) * 0.08 * amp;
      child.rotation.x = Math.sin(t * 1.7 + i) * 0.04 * amp;
      i++;
    }
  }

  // ============ UI / HUD ============
  _wireUI() {
    const $ = (id) => document.getElementById(id);
    $('btn-start')      ?.addEventListener('click', () => this._startRun());
    $('btn-story-next') ?.addEventListener('click', () => this._exitStoryToPlay());
    $('btn-story-skip') ?.addEventListener('click', () => this._exitStoryToPlay());
    $('btn-merge')      ?.addEventListener('click', () => this._completeMerge());
    $('btn-vic-menu')   ?.addEventListener('click', () => this._enterMenu());
    $('btn-retry')      ?.addEventListener('click', () => this._startRun());
    $('btn-go-menu')    ?.addEventListener('click', () => this._enterMenu());
    $('btn-hard')       ?.addEventListener('click', () => this._toggleHardMode());
    $('btn-mute')       ?.addEventListener('click', () => this._toggleMute());
    $('btn-ship')       ?.addEventListener('click', () => this._cycleShipVariant());
    $('btn-leaderboard')?.addEventListener('click', () => this._openLeaderboard());
    $('btn-achievements')?.addEventListener('click', () => this._openAchievements());
    $('btn-coop')       ?.addEventListener('click', () => this._toggleCoop());
    $('btn-shop')       ?.addEventListener('click', () => this._openShop());
    $('btn-daily')      ?.addEventListener('click', () => this._toggleDaily());
    // Player 2 keyboard input
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp')    this._p2Keys.up = true;
      if (e.key === 'ArrowDown')  this._p2Keys.down = true;
      if (e.key === 'ArrowLeft')  this._p2Keys.left = true;
      if (e.key === 'ArrowRight') this._p2Keys.right = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowUp')    this._p2Keys.up = false;
      if (e.key === 'ArrowDown')  this._p2Keys.down = false;
      if (e.key === 'ArrowLeft')  this._p2Keys.left = false;
      if (e.key === 'ArrowRight') this._p2Keys.right = false;
    });
    // Pause: P key (desktop) and a tap-target in the corner
    window.addEventListener('keydown', (e) => {
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') this._togglePause();
    });
    this._installPauseButton();
    this._installPauseScreen();
    // Apply persisted mute on boot
    if (this.save.muted) {
      this.audio.setMuted(true);
      const m = $('btn-mute'); if (m) m.textContent = '🔇 SOUND OFF';
    }
  }

  _toggleDaily() {
    this._dailyMode = !this._dailyMode;
    if (this._dailyMode) {
      this._dailySeed = this._dailySeedFor();
      this._rng = this._makeSeededRng(this._dailySeed);
      console.log(`[Daily] enabled — seed ${this._dailySeed.toString(16)}`);
    } else {
      this._rng = Math.random;
    }
    const btn = document.getElementById('btn-daily');
    if (btn) btn.textContent = this._dailyMode
      ? `📅 DAILY: ${new Date().toISOString().slice(0,10)}`
      : '📅 DAILY: OFF';
    this.audio.sfx('combo');
    this._toast('DAILY', this._dailyMode ? 'Same run for everyone today' : 'Off', '📅');
  }

  _toggleCoop() {
    this._coopMode = !this._coopMode;
    const btn = document.getElementById('btn-coop');
    if (btn) btn.textContent = this._coopMode ? '👯 CO-OP: ON' : '👯 CO-OP: OFF';
    if (this._coopMode) this._spawnPlayer2();
    else this._despawnPlayer2();
    console.log(`[Game] co-op ${this._coopMode ? 'ON' : 'OFF'}`);
    this.audio.sfx('combo');
    this._toast('CO-OP', this._coopMode ? 'Wingman engaged!' : 'Solo flight', '👯');
  }

  _spawnPlayer2() {
    if (this.playerShip2) { this.playerShip2.visible = true; return; }
    this.playerShip2 = new THREE.Group();
    const ship = this.assetLoader.get('player_ship');
    fitToHeight(ship, 1.4);
    ship.rotation.y = Math.PI;
    ship.position.y = 0.5;
    // Tint the wingman cyan to differentiate
    ship.traverse((c) => {
      if (c.isMesh && c.material) {
        c.material = c.material.clone();
        if (c.material.color)    c.material.color.multiply(new THREE.Color(0x66ccff));
        if (c.material.emissive) c.material.emissive.multiply(new THREE.Color(0x66ccff));
      }
    });
    this.playerShip2.add(ship);
    this.playerShip2.position.set(2, 0, 4);
    this.scene.add(this.playerShip2);
  }

  _despawnPlayer2() {
    if (!this.playerShip2) return;
    this.scene.remove(this.playerShip2);
    this.playerShip2 = null;
  }

  _updatePlayer2(dt) {
    if (!this.playerShip2 || !this._coopMode) return;
    if (!this.playerShip.visible) { this.playerShip2.visible = false; return; }
    this.playerShip2.visible = true;
    const k = this._p2Keys;
    const v = 6;
    if (k.left)  this.playerShip2.position.x -= v * dt;
    if (k.right) this.playerShip2.position.x += v * dt;
    if (k.up)    this.playerShip2.position.z -= v * dt;
    if (k.down)  this.playerShip2.position.z += v * dt;
    // No keys pressed → drift to mirror P1 with offset
    const anyKey = k.left || k.right || k.up || k.down;
    if (!anyKey) {
      const tx = this.playerShip.position.x + 2;
      const tz = this.playerShip.position.z;
      this.playerShip2.position.x += (tx - this.playerShip2.position.x) * Math.min(1, dt * 5);
      this.playerShip2.position.z += (tz - this.playerShip2.position.z) * Math.min(1, dt * 5);
    }
    // Clamp
    this.playerShip2.position.x = THREE.MathUtils.clamp(this.playerShip2.position.x, -7, 7);
    this.playerShip2.position.z = THREE.MathUtils.clamp(this.playerShip2.position.z, -6, 5.5);
    // Slight bank
    const targetBank = THREE.MathUtils.clamp((k.right ? -0.4 : 0) + (k.left ? 0.4 : 0), -0.4, 0.4);
    this.playerShip2.rotation.z += (targetBank - this.playerShip2.rotation.z) * Math.min(1, dt * 6);
  }

  _toggleHardMode() {
    this.hardMode = !this.hardMode;
    this.save.setHardModePreferred(this.hardMode);
    const btn = document.getElementById('btn-hard');
    if (btn) btn.textContent = this.hardMode ? '🔥 HARD MODE: ON' : '🔥 HARD MODE: OFF';
    console.log(`[Game] hard mode ${this.hardMode ? 'ON' : 'OFF'}`);
    this.audio.sfx('combo');
  }

  _toggleMute() {
    const muted = !this.audio._muted;
    this.audio.setMuted(muted);
    this.save.setMuted(muted);
    const btn = document.getElementById('btn-mute');
    if (btn) btn.textContent = muted ? '🔇 SOUND OFF' : '🔊 SOUND ON';
    console.log(`[Game] mute ${muted ? 'ON' : 'OFF'}`);
  }

  _installPauseButton() {
    const hud = document.getElementById('hud');
    if (!hud || document.getElementById('btn-pause-hud')) return;
    const b = document.createElement('button');
    b.id = 'btn-pause-hud';
    b.textContent = '⏸';
    b.style.cssText = `
      position:absolute;top:48px;left:14px;width:36px;height:36px;
      border-radius:18px;border:2px solid rgba(255,255,255,0.4);
      background:rgba(0,0,0,0.4);color:#fff;font-size:18px;
      font-weight:900;cursor:pointer;pointer-events:auto;z-index:11;`;
    b.addEventListener('click', () => this._togglePause());
    hud.appendChild(b);
  }

  _installPauseScreen() {
    if (document.getElementById('screen-pause')) return;
    const div = document.createElement('div');
    div.id = 'screen-pause';
    div.className = 'screen hidden';
    div.innerHTML = `
      <div class="menu-card">
        <div class="big-emoji">⏸</div>
        <div class="title-mini">PAUSED</div>
        <button id="btn-resume" class="big-btn">RESUME</button>
        <button id="btn-pause-restart" class="ghost-btn">RESTART RUN</button>
        <button id="btn-pause-menu" class="ghost-btn">QUIT TO MENU</button>
      </div>`;
    document.getElementById('game-frame').appendChild(div);
    div.querySelector('#btn-resume').addEventListener('click', () => this._togglePause());
    div.querySelector('#btn-pause-restart').addEventListener('click', () => { this._togglePause(); this._startRun(); });
    div.querySelector('#btn-pause-menu').addEventListener('click', () => { this._paused = false; this._enterMenu(); });
  }

  _togglePause() {
    if (this.state !== 'mission' && !this._paused) return;
    this._paused = !this._paused;
    const ps = document.getElementById('screen-pause');
    if (ps) ps.classList.toggle('hidden', !this._paused);
    if (this._paused) {
      this.audio.stopAllSpeech();
      console.log('[Game] PAUSED');
    } else {
      console.log('[Game] resumed');
    }
  }

  _refreshMenuStats() {
    const stats = document.getElementById('menu-stats');
    if (!stats) return;
    const hasAny = this.save.highScore > 0 || this.save.victories > 0 || (this.save.achievements && Object.keys(this.save.achievements).length);
    stats.classList.toggle('hidden', !hasAny);
    document.getElementById('ms-score').textContent = this.save.highScore;
    document.getElementById('ms-combo').textContent = '×' + this.save.bestCombo;
    document.getElementById('ms-vict').textContent  = this.save.victories;
    const ach = this.achievements.progress();
    const achEl = document.getElementById('ms-achs');
    if (achEl) achEl.textContent = `${ach.unlocked}/${ach.total}`;
    // Reveal hard-mode button after first victory
    const hardBtn = document.getElementById('btn-hard');
    if (hardBtn) {
      hardBtn.style.display = this.save.hardModeUnlocked ? '' : 'none';
      hardBtn.textContent = this.hardMode ? '🔥 HARD MODE: ON' : '🔥 HARD MODE: OFF';
    }
    // Ship picker visible only when 2+ variants unlocked
    const variants = this.save.unlockedShipVariants();
    const shipBtn = document.getElementById('btn-ship');
    if (shipBtn) {
      shipBtn.style.display = variants.length > 1 ? '' : 'none';
      shipBtn.textContent = `🚀 SHIP: ${this.save.shipVariant.toUpperCase()}`;
    }
  }

  _cycleShipVariant() {
    const variants = this.save.unlockedShipVariants();
    const cur = this.save.shipVariant;
    const idx = variants.indexOf(cur);
    const next = variants[(idx + 1) % variants.length];
    this.save.setShipVariant(next);
    console.log(`[Ship] variant → ${next}`);
    this._applyShipVariant(next);
    document.getElementById('btn-ship').textContent = `🚀 SHIP: ${next.toUpperCase()}`;
    this.audio.sfx('combo');
    this._toast('SHIP', next, '🚀');
  }

  _applyShipVariant(name) {
    if (!this.playerShip) return;
    // Walk the ship's child meshes (the loaded GLB scene) and tint material colors.
    const tints = {
      default: null,                          // restore originals
      gold:    { mul: new THREE.Color(0xffe066), brighten: 0.15 },
      rainbow: { rainbow: true },
      mech:    { mul: new THREE.Color(0xff5e5e), brighten: 0.10 },
    };
    const cfg = tints[name] || tints.default;
    // Cache originals once
    if (!this._shipOrigMats) {
      this._shipOrigMats = new Map();
      this.playerShip.traverse((c) => {
        if (c.isMesh && c.material && !c.userData._customCompanion) {
          this._shipOrigMats.set(c, c.material);
        }
      });
    }
    this._shipVariantName = name;
    this.playerShip.traverse((c) => {
      if (!c.isMesh || !this._shipOrigMats.has(c)) return;
      const orig = this._shipOrigMats.get(c);
      if (!cfg) { c.material = orig; return; }
      const m = orig.clone();
      if (cfg.mul && m.color) {
        m.color.multiply(cfg.mul);
        if (m.emissive) m.emissive.multiply(cfg.mul).multiplyScalar(1 + cfg.brighten);
      }
      c.material = m;
    });
    if (cfg && cfg.rainbow) {
      // Tag for the tick to cycle hue
      this._shipRainbow = true;
    } else {
      this._shipRainbow = false;
    }
  }

  _tickShipRainbow(dt) {
    if (!this._shipRainbow || !this._shipOrigMats) return;
    const t = performance.now() * 0.001;
    let i = 0;
    for (const [mesh] of this._shipOrigMats) {
      const hue = (t * 0.15 + i * 0.07) % 1;
      if (mesh.material && mesh.material.color) mesh.material.color.setHSL(hue, 0.85, 0.55);
      if (mesh.material && mesh.material.emissive) mesh.material.emissive.setHSL(hue, 0.85, 0.45);
      i++;
    }
  }

  _openLeaderboard() {
    // Tabbed view: LOCAL (always available) | GLOBAL (RemoteLeaderboard) | DAILY
    const localRows = this.save.scores.length
      ? this.save.scores.map((s, i) => {
          const d = new Date(s.date);
          const date = `${d.getMonth() + 1}/${d.getDate()}`;
          return `<div class="stats-row"><span class="k">${i + 1}. ${date} ${s.hard ? '🔥' : ''}</span><span class="v">${s.score}</span></div>`;
        }).join('')
      : `<div style="color:#c5b3ff;text-align:center;font-size:13px">No runs yet — go save the universe!</div>`;
    const html = `
      <div style="display:flex;gap:6px;margin-bottom:8px;justify-content:center">
        <button class="ghost-btn lb-tab" data-tab="local"  style="padding:4px 10px;font-size:11px">LOCAL</button>
        <button class="ghost-btn lb-tab" data-tab="global" style="padding:4px 10px;font-size:11px">🌍 GLOBAL</button>
        <button class="ghost-btn lb-tab" data-tab="daily"  style="padding:4px 10px;font-size:11px">📅 DAILY</button>
      </div>
      <div id="lb-pane-local"  class="lb-pane">${localRows}</div>
      <div id="lb-pane-global" class="lb-pane hidden"><div style="text-align:center;color:#c5b3ff;font-size:13px">Loading…</div></div>
      <div id="lb-pane-daily"  class="lb-pane hidden"><div style="text-align:center;color:#c5b3ff;font-size:13px">Loading…</div></div>`;
    this._showOverlay('🏆 LEADERBOARD', html);
    setTimeout(() => {
      const ov = document.getElementById('screen-overlay');
      if (!ov) return;
      ov.querySelectorAll('.lb-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tab = btn.getAttribute('data-tab');
          ov.querySelectorAll('.lb-pane').forEach((p) => p.classList.add('hidden'));
          ov.querySelector(`#lb-pane-${tab}`)?.classList.remove('hidden');
          if (tab === 'global') this._loadGlobalLeaderboard(ov.querySelector('#lb-pane-global'));
          if (tab === 'daily')  this._loadDailyLeaderboard(ov.querySelector('#lb-pane-daily'));
          this.audio.sfx('combo');
        });
      });
    }, 0);
  }

  async _loadGlobalLeaderboard(el) {
    if (!el) return;
    if (!this.remote?.enabled) {
      el.innerHTML = `<div style="text-align:center;color:#c5b3ff;font-size:13px;line-height:1.5">Online leaderboard isn't configured yet.<br><br>Deploy this game to Vercel<br>to enable the global rankings.</div>`;
      return;
    }
    el.innerHTML = `<div style="text-align:center;color:#c5b3ff;font-size:13px">Fetching top 25…</div>`;
    const data = await this.remote.fetch();
    if (!data?.top) {
      el.innerHTML = `<div style="text-align:center;color:#ff8b8b;font-size:13px">Couldn't reach the server.</div>`;
      return;
    }
    el.innerHTML = data.top.length
      ? data.top.map((s, i) => {
          const d = new Date(s.ts || Date.now());
          const date = `${d.getMonth() + 1}/${d.getDate()}`;
          const name = s.name || 'Anonymous';
          return `<div class="stats-row"><span class="k">${i + 1}. ${name} ${s.hard ? '🔥' : ''}</span><span class="v">${s.score}</span></div>`;
        }).join('')
      : `<div style="text-align:center;color:#c5b3ff">Be the first to score!</div>`;
  }

  async _loadDailyLeaderboard(el) {
    if (!el) return;
    if (!this.remote?.enabled) {
      el.innerHTML = `<div style="text-align:center;color:#c5b3ff;font-size:13px;line-height:1.5">Daily challenge: <b>${new Date().toISOString().slice(0,10)}</b><br><br>Toggle "📅 DAILY" on the menu and play.<br><br>Online ranking requires Vercel deploy.</div>`;
      return;
    }
    // Same fetch call — server is expected to filter/return today's runs.
    // For now we reuse the global fetch and render with a daily tag.
    el.innerHTML = `<div style="text-align:center;color:#c5b3ff;font-size:13px">Fetching today's ranks…</div>`;
    const data = await this.remote.fetch();
    if (!data?.top) {
      el.innerHTML = `<div style="text-align:center;color:#ff8b8b">No data.</div>`;
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const todays = data.top.filter((s) => (new Date(s.ts || 0)).toISOString().startsWith(today));
    el.innerHTML = todays.length
      ? todays.map((s, i) => {
          const name = s.name || 'Anonymous';
          return `<div class="stats-row"><span class="k">${i + 1}. ${name}</span><span class="v">${s.score}</span></div>`;
        }).join('')
      : `<div style="text-align:center;color:#c5b3ff">No daily runs submitted yet — be the first!</div>`;
  }

  _openAchievements() {
    const html = this.achievements.renderHTML();
    this._showOverlay('🏅 ACHIEVEMENTS', `<div style="display:flex;flex-direction:column;gap:8px;text-align:left;max-height:60vh;overflow:auto">${html}</div>`);
  }

  _openShop() {
    const sp = this.save.smilePoints;
    let html = `<div style="text-align:center;font-weight:800;color:#ffd24c;margin-bottom:8px">😄 ${sp} Smile Points</div>`;
    html += `<div style="display:flex;flex-direction:column;gap:6px">`;
    for (const u of UPGRADES) {
      const lvl  = this.save.upgradeLevel(u.id);
      const max  = u.max;
      const cost = lvl >= max ? '✓' : u.cost(lvl);
      const canAfford = (lvl < max) && (sp >= u.cost(lvl));
      const dots = '●'.repeat(lvl) + '○'.repeat(max - lvl);
      html += `<div data-uid="${u.id}" class="shop-row" style="display:flex;flex-direction:column;gap:2px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:8px 10px;">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:800;font-size:13px;color:#ffe45e">${u.label}</span>
          <button class="ghost-btn" data-buy="${u.id}" ${canAfford ? '' : 'disabled'} style="padding:4px 12px;font-size:12px;${canAfford ? '' : 'opacity:0.4;'}">${typeof cost === 'number' ? `BUY · ${cost}` : 'MAX'}</button>
        </div>
        <div style="font-size:11px;color:#c5b3ff">${u.desc}</div>
        <div style="font-size:13px;letter-spacing:3px;color:#ff8be0">${dots}</div>
      </div>`;
    }
    html += `</div>`;
    html += `<div style="font-size:11px;color:#888;margin-top:6px;text-align:center">Earn 1 Smile Point per 100 score (run finished)</div>`;
    this._showOverlay('🛒 SMILE SHOP', html);
    // Wire up buy handlers
    setTimeout(() => {
      const ov = document.getElementById('screen-overlay');
      if (!ov) return;
      ov.querySelectorAll('button[data-buy]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-buy');
          const u = UPGRADES.find((x) => x.id === id);
          if (!u) return;
          if (this.save.buyUpgrade(u)) {
            this.audio.sfx('pickup');
            this._toast('UPGRADE', u.label, '⭐');
            this._openShop();    // refresh
          } else {
            this.audio.sfx('hurt');
            this._toast('NEED', `${u.cost(this.save.upgradeLevel(id))} pts`, '😞');
          }
        });
      });
    }, 0);
  }

  _showOverlay(title, innerHTML) {
    let ov = document.getElementById('screen-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'screen-overlay';
      ov.className = 'screen';
      ov.innerHTML = `<div class="menu-card">
        <div id="ov-title" class="title-mini"></div>
        <div id="ov-body" class="stats-block" style="text-align:left;max-width:380px;width:100%"></div>
        <button id="ov-close" class="big-btn">CLOSE</button>
      </div>`;
      document.getElementById('game-frame').appendChild(ov);
      ov.querySelector('#ov-close').addEventListener('click', () => ov.classList.add('hidden'));
    }
    ov.querySelector('#ov-title').textContent = title;
    ov.querySelector('#ov-body').innerHTML = innerHTML;
    ov.classList.remove('hidden');
  }

  /** Apply hardMode multipliers to a level def shallow copy. */
  _applyHardMode(def) {
    if (!this.hardMode) return def;
    const d = JSON.parse(JSON.stringify(def));
    if (d.enemy)    { d.enemy.speed *= 1.30; d.enemy.interval = Math.round(d.enemy.interval * 0.75); d.enemy.hp += 0; }
    if (d.asteroid) { d.asteroid.speed *= 1.30; d.asteroid.interval = Math.round(d.asteroid.interval * 0.75); }
    if (d.boss)     d.boss.hp = Math.round(d.boss.hp * 1.50);
    if (d.runner)   d.runner.speed *= 1.20;
    return d;
  }

  _showScreen(name) {
    const ids = ['menu','story','merge','victory','gameover'];
    for (const k of ids) {
      const el = document.getElementById(`screen-${k}`);
      if (el) el.classList.toggle('hidden', k !== name);
    }
    document.getElementById('hud')?.classList.toggle('hidden', name !== 'play');
  }

  _renderHUD() {
    const heart = document.getElementById('hud-hearts');
    if (heart) heart.textContent = '❤️'.repeat(Math.max(0, this.lives)) + '🤍'.repeat(Math.max(0, 3 - this.lives));
    const sc = document.getElementById('hud-score'); if (sc) sc.textContent = this.score;
    const lv = document.getElementById('hud-level'); if (lv) lv.textContent = `LVL ${(this.levels.idx >= 0 ? this.levels.idx : 0) + 1}`;
    const res = document.getElementById('hud-res-fill'); if (res) res.style.width = `${this.resonance}%`;
    const bossWrap = document.getElementById('hud-boss');
    const m = this.levels.current;
    if (bossWrap) {
      if (m && m.boss) {
        bossWrap.classList.remove('hidden');
        const bf = document.getElementById('hud-boss-fill');
        if (bf) bf.style.width = `${100 * (m.boss.hp / m.boss.maxHp)}%`;
      } else {
        bossWrap.classList.add('hidden');
      }
    }
  }

  _toast(top, name, icon = '✨') {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="ti">${icon}</span><span class="tt"><span class="ttop">${top}</span><span class="tname">${name}</span></span>`;
    stack.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  // ============ HIGH-LEVEL STATE TRANSITIONS ============
  _enterMenu() {
    console.log('[State] → menu');
    this.state = 'menu';
    this._paused = false;
    this.levels.exit();
    this.audio.stopAllSpeech();
    this.audio.stopMusic();
    this._despawnMech();
    if (this.shieldBubble) this.shieldBubble.visible = false;
    this._showShip(false);
    this._showRunners(false);
    this._showMenuShowcase(true);
    this._setActiveScenery('space');
    this.setCameraMode('TOP_DOWN');
    this._refreshMenuStats();
    this._showScreen('menu');
    // Hide pause overlay if it was up
    document.getElementById('screen-pause')?.classList.add('hidden');
  }

  _startRun() {
    console.log(`[State] start run — hardMode=${this.hardMode}`);
    // Apply permanent upgrades
    const baseLives = this.hardMode ? 2 : 3;
    const extraLives = this.save.upgradeLevel('extraLife');
    this.lives = Math.min(5, baseLives + extraLives);
    this.score = 0;
    this.resonance = 0;
    this.combo = 0;
    const bonusMult = 1.0 + 0.25 * this.save.upgradeLevel('bonusMultiplier');
    this._scoreMultiplier = (this.hardMode ? 2.0 : 1.0) * bonusMult;
    this._comboTimeout = 2.5 + 0.5 * this.save.upgradeLevel('slowerCombo');
    this._shieldDurationBonus = 1.5 * this.save.upgradeLevel('longerShield');
    this._beamWidthBonus = 2 * this.save.upgradeLevel('widerBeam');
    console.log(`[Upgrades] lives=${this.lives} mult=${this._scoreMultiplier.toFixed(2)} comboT=${this._comboTimeout.toFixed(1)}s shieldBonus=${this._shieldDurationBonus.toFixed(1)}s beamBonus=${this._beamWidthBonus}`);
    this.achievements.resetRun();
    this._renderHUD();
    this._enterStory(0);
  }

  _enterStory(missionIdx) {
    console.log(`[State] → story (mission ${missionIdx + 1})`);
    this.state = 'story';
    this._pendingIdx = missionIdx;
    // Pre-load scenery so the story screen has the new backdrop
    const def = LEVELS[missionIdx];
    if (def) {
      const sceneryKey = ({ FLYING_MODE: 'space', RE_ENTRY_MODE: 'reentry', ON_FOOT_MODE: 'cave', BOSS_MODE: 'boss' })[def.mode] || 'space';
      this._setActiveScenery(sceneryKey);
    }
    const def = LEVELS[missionIdx];
    const story = STORY[def.key];

    document.getElementById('comic-title').textContent = story?.title ?? def.title;
    const panels = document.getElementById('comic-panels');
    panels.innerHTML = '';
    for (const p of (story?.panels ?? [])) {
      const div = document.createElement('div');
      div.className = `comic-panel ${p.side === 'right' ? 'right' : ''}`;
      const emojiMatch = p.who.match(/(\p{Extended_Pictographic}+)/u);
      const emoji = emojiMatch ? emojiMatch[1] : '✨';
      const who = p.who.replace(/\s*\p{Extended_Pictographic}+\s*$/u, '').trim();
      div.innerHTML =
        `<div class="comic-emoji">${emoji}</div>` +
        `<div class="comic-bubble"><span class="who">${who}</span>${p.text}</div>`;
      panels.appendChild(div);
    }
    this._showScreen('story');
  }

  _exitStoryToPlay() {
    console.log('[State] → mission');
    this.state = 'mission';
    this._showMenuShowcase(false);
    this._showScreen('play');
    // Pick scenery for the mission about to start
    const def = LEVELS[this._pendingIdx];
    const sceneryKey = ({ FLYING_MODE: 'space', RE_ENTRY_MODE: 'reentry', ON_FOOT_MODE: 'cave', BOSS_MODE: 'boss' })[def.mode] || 'space';
    this._setActiveScenery(sceneryKey);
    // Apply chosen ship variant (in case it changed since last run)
    this._applyShipVariant(this.save.shipVariant);
    this.levels.start(this._pendingIdx);
    this._missionLivesAtStart = this.lives;
    this._renderHUD();
    // First-mission tutorial
    if (this._pendingIdx === 0 && !this.save.tutorialDone) {
      this._showTutorial();
    }
  }

  _showTutorial() {
    const tips = [
      { icon: '🖱️', text: 'Drag to fly your ship around the play area' },
      { icon: '🌸', text: 'Auto-fires Smile Beams toward enemies' },
      { icon: '💖', text: 'Collect hearts → fill Resonance → unlock the Mech' },
    ];
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    let i = 0;
    const showNext = () => {
      if (i >= tips.length) { this.save.setTutorialDone(); return; }
      const t = tips[i++];
      const el = document.createElement('div');
      el.className = 'toast';
      el.style.background = 'linear-gradient(90deg,#5effd1,#5e9bff)';
      el.innerHTML = `<span class="ti">${t.icon}</span><span class="tt"><span class="ttop">TIP</span><span class="tname">${t.text}</span></span>`;
      stack.appendChild(el);
      setTimeout(() => el.remove(), 3500);
      setTimeout(showNext, 2200);
    };
    showNext();
  }

  _enterMergeOverlay(mission) {
    console.log('[State] → merge overlay');
    this.state = 'merge';
    this._pausedMission = mission;
    this._showScreen('merge');
    this.audio.speakSequence(STORY.merge.voice, 250);
  }

  _completeMerge() {
    console.log('[State] merge → continue (DUO-DRIVE MECH ACTIVATED)');
    this.achievements.fire('merge');
    this._showScreen('play');
    this.state = 'mission';
    this._mechMode = true;
    this.audio.sfx('mergeBlast');
    this._spawnMechAura();
    this._flashScreen('#ffffff', 0.7, 380);
    this._kickShake(1.5, 600);

    if (this._pausedMission) {
      const m = this._pausedMission;
      // Heavy boss damage + screen-clear
      if (m.boss) {
        const dmg = Math.ceil(m.boss.maxHp * 0.55);
        m.boss.hp = Math.max(0, m.boss.hp - dmg);
        this.particles.flash(m.boss.mesh.position.clone(), { color: 0xffffff, scale: 6.0, life: 0.4 });
        this.particles.burst(m.boss.mesh.position.clone(), { count: 60, color: 0xff66cc, speed: 10, life: 1.2 });
        this.particles.burst(m.boss.mesh.position.clone(), { count: 40, color: 0xffd24c, speed: 7, life: 1.0 });
        if (m.boss.hp <= 0) {
          this.scene.remove(m.boss.mesh);
          m.boss = null;
          this.score += 200;
          this._toast('VICTORY', 'Lord Grump defeated!', '🌟');
        } else {
          this._toast('MECH BEAM', `-${dmg} boss HP`, '⚡');
        }
      }
      this._mergeBlast();
    }
  }

  /** Screen-clearing particle beam: removes all enemies/bullets, score them. */
  _mergeBlast() {
    const m = this.levels.current;
    if (!m) return;
    for (let i = m.entities.length - 1; i >= 0; i--) {
      const e = m.entities[i];
      if (e.kind === 'enemy') { this.score += 10; m.kills = (m.kills||0) + 1; }
      this.scene.remove(e.mesh);
      m.entities.splice(i, 1);
    }
    for (const b of this.bossBullets) this.scene.remove(b.mesh);
    this.bossBullets.length = 0;
    // Brief flash via large white plane
    const flash = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    flash.position.set(0, 4, -2);
    flash.lookAt(this.camera.position);
    this.scene.add(flash);
    let t = 0;
    const fade = () => {
      t += 0.05;
      flash.material.opacity = Math.max(0, 0.85 - t);
      if (flash.material.opacity > 0) requestAnimationFrame(fade);
      else this.scene.remove(flash);
    };
    fade();
  }

  /** Snapshot the current canvas + render a stats overlay. Returns a data URL. */
  async _captureShareCard({ outcome = 'VICTORY' } = {}) {
    // Force one render of the current scene composited via composer
    try { this.composer?.render(); } catch {}
    const sourceCanvas = this.canvas;
    const w = 720, h = 1280;
    const dest = document.createElement('canvas');
    dest.width = w; dest.height = h;
    const ctx = dest.getContext('2d');
    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#2a1a5e'); grad.addColorStop(1, '#0a0210');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    // Source canvas snapshot (cropped to top region)
    const srcW = sourceCanvas.width, srcH = sourceCanvas.height;
    const targetH = Math.round(w * (srcH / srcW));
    ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 80, w, targetH);
    // Title bar
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, w, 80);
    ctx.fillStyle = '#ffd24c';
    ctx.font = 'bold 36px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('COSMIC SISTER SAVERS', 24, 40);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff66cc';
    ctx.fillText(outcome, w - 24, 40);
    // Stats panel below image
    const py = 80 + targetH + 40;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(40, py, w - 80, 360);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.lineWidth = 2;
    ctx.strokeRect(40, py, w - 80, 360);
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    const rows = [
      ['SCORE',     this.score],
      ['BEST COMBO','×' + this.combo],
      ['LIVES',     this.lives],
      ['RESONANCE', Math.round(this.resonance) + '%'],
      ['SHIP',      this.save.shipVariant.toUpperCase()],
      ['MODE',      this.hardMode ? '🔥 HARD' : 'NORMAL'],
    ];
    rows.forEach(([k, v], i) => {
      const ry = py + 30 + i * 50;
      ctx.fillStyle = '#c5b3ff';
      ctx.fillText(k, 70, ry);
      ctx.fillStyle = '#ffe45e';
      ctx.textAlign = 'right';
      ctx.fillText(String(v), w - 70, ry);
      ctx.textAlign = 'left';
    });
    // Footer
    ctx.fillStyle = '#c5b3ff';
    ctx.font = '600 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('THE FAMILY REUNION SAGA · 3D', w / 2, h - 30);
    return dest.toDataURL('image/png');
  }

  _attachShareButtons(stageEl, dataUrl) {
    if (!stageEl || !dataUrl) return;
    let row = stageEl.querySelector('.share-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'share-row';
      row.style.cssText = 'display:flex;gap:8px;margin-top:10px;justify-content:center';
      stageEl.appendChild(row);
    }
    row.innerHTML = '';
    // Preview thumbnail
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'width:96px;height:auto;border-radius:8px;border:2px solid #fff';
    row.appendChild(img);
    // Download button
    const dl = document.createElement('a');
    dl.href = dataUrl;
    dl.download = `cosmic-sisters-${Date.now()}.png`;
    dl.className = 'ghost-btn';
    dl.textContent = '💾 SAVE PNG';
    row.appendChild(dl);
    // Share button (Web Share API if available)
    if (navigator.canShare && navigator.share) {
      const sh = document.createElement('button');
      sh.className = 'ghost-btn';
      sh.textContent = '📤 SHARE';
      sh.addEventListener('click', async () => {
        try {
          const blob = await (await fetch(dataUrl)).blob();
          const file = new File([blob], 'cosmic-sisters.png', { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'Cosmic Sister Savers',
              text: `I scored ${this.score} in Cosmic Sister Savers!` });
          }
        } catch (e) { console.warn('[Share] failed:', e); }
      });
      row.appendChild(sh);
    }
  }

  _enterVictory() {
    console.log('[State] → victory');
    this.state = 'victory';
    this.audio.stopMusic();
    // Persist progress
    const newHigh   = this.save.recordScore(this.score);
    const newCombo  = this.save.recordCombo(this.combo);
    const wasFirst  = !this.save.hardModeUnlocked;
    this.save.recordVictory();
    const rank = this.save.recordRunResult({ score: this.score, combo: this.combo, hard: this.hardMode, won: true });
    this.achievements.fire('victory', { score: this.score, hard: this.hardMode });
    if (newHigh)  this._toast('NEW', 'High Score!', '🏆');
    if (newCombo) this._toast('NEW', 'Best Combo!', '🔥');
    if (wasFirst) this._toast('UNLOCKED', 'Hard Mode!', '🌶️');
    if (rank) this._toast('LEADERBOARD', `#${rank}!`, '🏆');
    // Award Smile Points (currency for the upgrade shop)
    const earnedSmiles = this.save.awardSmilePoints(this.score);
    if (earnedSmiles > 0) this._toast('SMILE', `+${earnedSmiles} pts`, '😄');
    // Generate share card asynchronously
    this._captureShareCard({ outcome: 'VICTORY' }).then((url) => {
      const card = document.querySelector('#screen-victory .menu-card');
      if (card) this._attachShareButtons(card, url);
    });
    // Online leaderboard submit (no-op if not configured)
    this.remote?.submit({ score: this.score, combo: this.combo, hard: this.hardMode })
      .then((r) => { if (r?.rank) this._toast('ONLINE', `#${r.rank} globally`, '🌍'); })
      .catch(() => {});

    document.getElementById('vic-stats').innerHTML = `
      <div class="stats-row"><span class="k">SCORE</span><span class="v">${this.score}${newHigh ? ' 🏆' : ''}</span></div>
      <div class="stats-row"><span class="k">BEST COMBO</span><span class="v">×${this.combo}${newCombo ? ' 🔥' : ''}</span></div>
      <div class="stats-row"><span class="k">LIVES</span><span class="v">${this.lives}</span></div>
      <div class="stats-row"><span class="k">RESONANCE</span><span class="v">${Math.round(this.resonance)}%</span></div>
      ${this.hardMode ? '<div class="stats-row"><span class="k">DIFFICULTY</span><span class="v">🔥 HARD</span></div>' : ''}`;
    this._showScreen('victory');
  }

  _enterGameOver() {
    console.log('[State] → gameover');
    this.state = 'gameover';
    this.audio.stopMusic();
    this._captureShareCard({ outcome: 'GAME OVER' }).then((url) => {
      const card = document.querySelector('#screen-gameover .menu-card');
      if (card) this._attachShareButtons(card, url);
    });
    const idx = Math.max(0, this.levels.idx);
    document.getElementById('go-stats').innerHTML = `
      <div class="stats-row"><span class="k">MISSION</span><span class="v">${idx + 1}</span></div>
      <div class="stats-row"><span class="k">SCORE</span><span class="v">${this.score}</span></div>`;
    this.levels.exit();
    this._showScreen('gameover');
  }

  // ============ SHARED MISSION HELPERS ============
  _updateShip(dt) {
    const t = this.input.target;
    if (this.input.hasTarget) {
      this.playerShip.position.x += (t.x - this.playerShip.position.x) * Math.min(1, dt * 8);
      this.playerShip.position.z += (t.z - this.playerShip.position.z) * Math.min(1, dt * 8);
    }
    this.playerShip.position.x = THREE.MathUtils.clamp(this.playerShip.position.x, BOUNDS.xMin, BOUNDS.xMax);
    this.playerShip.position.z = THREE.MathUtils.clamp(this.playerShip.position.z, BOUNDS.zMin + 2, BOUNDS.zMax);
    const bank = THREE.MathUtils.clamp((t.x - this.playerShip.position.x) * 0.25, -0.4, 0.4);
    this.playerShip.rotation.z += (bank - this.playerShip.rotation.z) * Math.min(1, dt * 6);
  }

  _spawnEnemy(mission) {
    // Variant roll: 60% Borg, 30% Swooper, 10% Bomber.
    const r = Math.random();
    const variant = r < 0.6 ? 'borg' : r < 0.9 ? 'swooper' : 'bomber';

    const m = this.assetLoader.get('enemy');
    const baseHeight = variant === 'bomber' ? 1.6 : 1.0;
    fitToHeight(m, baseHeight);
    const x = THREE.MathUtils.randFloatSpread(BOUNDS.xMax * 1.6);
    m.position.set(x, 0.4, -16);
    m.rotation.y = 0; // nose toward +Z (player)

    // Tint the enemy by variant so the player can read incoming threats.
    const tint = { borg: null, swooper: 0x55c8ff, bomber: 0xffd24c }[variant];
    if (tint) {
      m.traverse((c) => {
        if (c.isMesh && !c.userData.placeholder && c.material) {
          c.material = c.material.clone();
          if (c.material.color) c.material.color.setHex(tint);
          if (c.material.emissive) c.material.emissive.setHex(tint);
          if (c.material.emissiveIntensity != null) c.material.emissiveIntensity = 0.4;
        }
      });
    }

    const speed = mission.def.enemy.speed * (variant === 'bomber' ? 0.55 : 1.0);
    const hp    = variant === 'bomber' ? 2 : mission.def.enemy.hp;
    const props = { speed, hp, variant, _phase: Math.random() * Math.PI * 2, _baseX: x };
    if (variant === 'bomber') props._fireT = 1.2 + Math.random() * 1.4;
    if (variant === 'swooper') props._sweepAmp = 2.8 + Math.random() * 1.8;
    mission.spawn(m, 'enemy', props);
    console.log(`[Enemy] spawn ${variant} hp=${hp} speed=${speed.toFixed(1)}`);
  }

  _spawnDebris(mission, speed) {
    const m = this.assetLoader.get('asteroid');
    const sc = 1.2 + Math.random() * 1.4;
    fitToHeight(m, sc);
    m.position.set(THREE.MathUtils.randFloatSpread(BOUNDS.xMax * 1.7), 0.5 + Math.random() * 1.6, -16);
    mission.spawn(m, 'debris', {
      speed,
      spin: new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3),
    });
  }

  _spawnBoss(mission, hp) {
    const m = this.assetLoader.get('mothership');
    fitToHeight(m, 4.5);
    m.position.set(0, 1.6, -10);
    m.rotation.y = Math.PI;
    this.scene.add(m);
    mission.boss = { mesh: m, hp, maxHp: hp, sway: 0 };
    console.log(`[Boss] spawned with ${hp} HP`);
  }

  _spawnHeart(mission, atVec) {
    // Random power-up roll: 60% heart, 18% shield, 14% triple-beam, 8% gem
    const r = Math.random();
    let kind;
    if      (r < 0.60) kind = 'heart';
    else if (r < 0.78) kind = 'shield';
    else if (r < 0.92) kind = 'triple';
    else               kind = 'gem';

    let mesh;
    if (kind === 'heart') {
      mesh = this.assetLoader.get('heart');
      fitToHeight(mesh, 0.7);
    } else if (kind === 'shield') {
      mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.32, 0),
        new THREE.MeshStandardMaterial({ color: 0x55c8ff, emissive: 0x55c8ff, emissiveIntensity: 1.5, transparent: true, opacity: 0.85 }));
    } else if (kind === 'triple') {
      mesh = new THREE.Group();
      const cs = [0xff5599, 0xffd24c, 0x55c8ff];
      for (let i = -1; i <= 1; i++) {
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 10, 8),
          new THREE.MeshBasicMaterial({ color: cs[i + 1] }));
        s.position.x = i * 0.30;
        mesh.add(s);
      }
    } else {
      mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.30, 0),
        new THREE.MeshStandardMaterial({ color: 0xffd24c, emissive: 0xffd24c, emissiveIntensity: 1.4, metalness: 0.6, roughness: 0.2 }));
    }
    mesh.position.copy(atVec); mesh.position.y = 0.7;
    // Use a single 'powerup' kind tag with a sub-kind on the entity record so collision handling
    // can read either the legacy 'heart' kind or e._powerKind.
    mission.spawn(mesh, 'powerup', { _powerKind: kind, vz: 4, life: 8 });
  }

  _applyPowerUp(kind, pos) {
    this.achievements.fire('powerup', { kind });
    if (kind === 'heart') {
      this.resonance = Math.min(100, this.resonance + 25);
      this._toast('SMILE BEAM', '+25% Resonance', '💖');
      this.particles.heartPickup(pos);
      this.particles.scorePopup(pos, this.camera, this.canvas, '+25% RES', '#ff8be0');
      this.audio.sfx('pickup');
    } else if (kind === 'shield') {
      this._shieldT = 5.0 + (this._shieldDurationBonus || 0);
      this._toast('SHIELD', `${this._shieldT.toFixed(1)}s invulnerable`, '💧');
      this.particles.burst(pos, { count: 18, color: 0x55c8ff, speed: 5, life: 0.7 });
      this.particles.scorePopup(pos, this.camera, this.canvas, '+SHIELD 5s', '#55c8ff');
      this.audio.sfx('pickup');
      this._ensureShieldBubble();
      this.shieldBubble.visible = true;
    } else if (kind === 'triple') {
      this._tripleBeamT = 8.0;
      this._toast('TRIPLE BEAM', '8s rainbow fire', '🌈');
      this.particles.burst(pos, { count: 18, color: 0xff66cc, speed: 6, life: 0.7 });
      this.particles.scorePopup(pos, this.camera, this.canvas, '+TRIPLE 8s', '#ff66cc');
      this.audio.sfx('combo');
    } else if (kind === 'gem') {
      const points = Math.round(50 * (this._scoreMultiplier || 1));
      this.score += points;
      this._toast('GEM', `+${points} score`, '💎');
      this.particles.burst(pos, { count: 14, color: 0xffd24c, speed: 5, life: 0.6 });
      this.particles.scorePopup(pos, this.camera, this.canvas, `+${points}`, '#ffd24c');
      this.audio.sfx('combo');
    }
  }

  _ensureShieldBubble() {
    if (this.shieldBubble) return;
    const bubble = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.3, 1),
      new THREE.MeshBasicMaterial({
        color: 0x55c8ff, transparent: true, opacity: 0.22,
        side: THREE.DoubleSide, wireframe: false }));
    bubble.position.y = 0.5;
    bubble.visible = false;
    this.shieldBubble = bubble;
    this.playerShip.add(bubble);
  }

  // ---- Mission 3 ground / obstacles ----
  _scrollGround(distance) {
    if (!this.cave) return;
    for (const tile of this.cave.children) {
      tile.position.z += distance;
      if (tile.position.z > 8) tile.position.z -= 32;
    }
  }
  _spawnCaveObstacle(mission) {
    const lanes = mission.def.runner.lanes;
    const lane = lanes[Math.floor(Math.random() * lanes.length)];
    // 25% chance to spawn a smile-crystal collectible instead of an obstacle
    if (Math.random() < 0.25) {
      const cluster = new THREE.Group();
      // Floating glowing smile crystal
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.30, 0),
        new THREE.MeshStandardMaterial({ color: 0xffd24c, emissive: 0xff66cc, emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.2 }));
      cluster.add(core);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.50, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff66cc, transparent: true, opacity: 0.30 }));
      cluster.add(halo);
      cluster.position.set(lane, 1.0, -22);
      this.scene.add(cluster);
      mission.obstacles.push({ mesh: cluster, kind: 'crystal' });
      return;
    }
    const isPit = Math.random() < 0.35;
    let mesh;
    if (isPit) {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 0.06, 1.6),
        new THREE.MeshStandardMaterial({ color: 0x05010a, emissive: 0x000000 }));
      mesh.position.set(lane, -0.05, -22);
    } else {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 1.0, 0.18, 16),
        new THREE.MeshStandardMaterial({ color: 0xa050ff, emissive: 0xa050ff, emissiveIntensity: 0.7 }));
      mesh.position.set(lane, 0.10, -22);
    }
    this.scene.add(mesh);
    mission.obstacles.push({ mesh, kind: isPit ? 'chasm' : 'puddle' });
  }

  // ---- Projectiles ----
  _fireBeams(mission) {
    if (mission.def.shootingAllowed === false) return;
    this.audio.sfx('shoot');
    let dxs, colors;
    if (this._tripleBeamT > 0) {
      const extra = this._beamWidthBonus || 0;
      const totalBeams = 6 + extra;
      dxs = []; colors = [];
      const palette = [0xff5599, 0xff8833, 0xffd24c, 0x55c8ff, 0x66ff77, 0xb65eff, 0xff66ff, 0x44ffff];
      for (let i = 0; i < totalBeams; i++) {
        const t = (i / (totalBeams - 1) - 0.5) * 2;   // -1..1
        dxs.push(t * 1.0);
        colors.push(palette[i % palette.length]);
      }
    } else {
      dxs = [-0.5, 0.5];
      colors = [0xff66cc, 0xff66cc];
    }
    const sources = [this.playerShip];
    if (this._coopMode && this.playerShip2 && this.playerShip2.visible) sources.push(this.playerShip2);
    for (const src of sources) {
      for (let i = 0; i < dxs.length; i++) {
        const dx = dxs[i];
        const beamColor = colors[i] || (src === this.playerShip2 ? 0x66ccff : 0xff66cc);
        const g = new THREE.SphereGeometry(0.18, 8, 6);
        const m = new THREE.MeshBasicMaterial({ color: beamColor });
        const mesh = new THREE.Mesh(g, m);
        mesh.position.copy(src.position);
        mesh.position.x += dx;
        mesh.position.y += 0.5;
        mesh.position.z -= 1;
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(0.32, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffd24c, transparent: true, opacity: 0.45 }));
        mesh.add(halo);
        this.scene.add(mesh);
        this.beams.push({ mesh, vz: -BEAM_SPEED, life: BEAM_LIFE });
      }
    }
  }

  _fireBossBullet(mission) {
    if (!mission.boss) return;
    for (const dx of [-0.6, -0.3, 0, 0.3, 0.6]) {
      const g = new THREE.SphereGeometry(0.32, 8, 6);
      const m = new THREE.MeshBasicMaterial({ color: 0xff3344 });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(mission.boss.mesh.position.x, 1.2, mission.boss.mesh.position.z + 2.5);
      this.scene.add(mesh);
      this.bossBullets.push({ mesh, vx: dx * 4, vz: BOSS_BULLET_SPEED, life: 6 });
    }
  }

  // ============ Boss attack patterns ============
  _bossAttack(mission, phase) {
    const colors = { 1: 0xff3344, 2: 0xffa033, 3: 0xff66cc, 4: 0xffffff };
    const color = colors[phase] || 0xff3344;
    if (phase === 1) this._bossFan(mission, [-0.6, -0.3, 0, 0.3, 0.6], color, 0);
    else if (phase === 2) {
      this._bossFan(mission, [-0.7, -0.35, 0.35, 0.7], color, 0);
      this._bossAimedShot(mission, color);
    } else if (phase === 3) {
      this._bossFan(mission, [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9], color, 0);
      this._bossAimedShot(mission, color);
    } else {
      // phase 4: rapid 9-shot fan
      this._bossFan(mission, [-1.0, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1.0], color, 0.5);
    }
  }

  _bossFan(mission, dxs, color, extraSpeed = 0) {
    const speed = BOSS_BULLET_SPEED + extraSpeed * 4;
    for (const dx of dxs) {
      const g = new THREE.SphereGeometry(0.32, 8, 6);
      const m = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(mission.boss.mesh.position.x, 1.2, mission.boss.mesh.position.z + 2.5);
      this.scene.add(mesh);
      this.bossBullets.push({ mesh, vx: dx * 4, vz: speed, life: 6 });
    }
  }

  _bossAimedShot(mission, color) {
    if (!mission.boss) return;
    const bx = mission.boss.mesh.position.x;
    const bz = mission.boss.mesh.position.z + 2.5;
    const dx = this.playerShip.position.x - bx;
    const dz = this.playerShip.position.z - bz;
    const len = Math.hypot(dx, dz) || 1;
    const sp = 12;
    const g = new THREE.SphereGeometry(0.40, 10, 8);
    const m = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(bx, 1.2, bz);
    this.scene.add(mesh);
    this.bossBullets.push({ mesh, vx: dx / len * sp, vz: dz / len * sp, life: 4 });
  }

  _bossSpiralBurst(mission) {
    if (!mission.boss) return;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const g = new THREE.SphereGeometry(0.28, 8, 6);
      const m = new THREE.MeshBasicMaterial({ color: 0xff66cc });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(mission.boss.mesh.position.x, 1.2, mission.boss.mesh.position.z + 2);
      this.scene.add(mesh);
      this.bossBullets.push({ mesh, vx: Math.cos(a) * 6, vz: Math.sin(a) * 6, life: 3.5 });
    }
    this.audio.sfx('hit');
    this._toast('BOSS', 'Spiral burst!', '💢');
  }

  _spawnBossLaser(mission) {
    if (!mission.boss) return;
    // A long thin elongated box that origins at the boss and rotates around Y.
    const g = new THREE.BoxGeometry(0.4, 0.4, 22);
    const m = new THREE.MeshBasicMaterial({ color: 0xff66cc, transparent: true, opacity: 0.9 });
    const beam = new THREE.Mesh(g, m);
    beam.position.copy(mission.boss.mesh.position);
    beam.position.z += 11;  // anchor end at boss; extends forward
    this.scene.add(beam);
    mission.laser = { mesh: beam, anchor: new THREE.Vector3() };
    console.log('[Boss] LASER ACTIVATED (phase 4)');
    this._toast('PHASE 4', 'Rainbow Laser!', '🌈');
  }

  _tickBossLaser(mission, dt) {
    if (!mission.laser || !mission.boss) return;
    mission._laserAngle += 0.6 * dt;     // rotation rate
    const beam = mission.laser.mesh;
    const ax = mission.boss.mesh.position.x;
    const az = mission.boss.mesh.position.z;
    const angle = mission._laserAngle;
    // Rotate around vertical axis; box centered along its long axis (Z).
    beam.rotation.set(0, angle, 0);
    beam.position.set(ax + Math.sin(angle) * 11, 1.4, az + Math.cos(angle) * 11);

    // Collision: project player onto the laser's local Z axis and check distance
    const player = this.playerShip;
    const lx = player.position.x - ax;
    const lz = player.position.z - az;
    // Distance from player to the line through (ax,az) in direction (sin a, cos a)
    const proj = lx * Math.sin(angle) + lz * Math.cos(angle);
    if (proj > 0 && proj < 22) {
      const perpX = lx - proj * Math.sin(angle);
      const perpZ = lz - proj * Math.cos(angle);
      const perpDist = Math.hypot(perpX, perpZ);
      if (perpDist < 0.7 && this._invuln <= 0) {
        this._onPlayerHit('laser');
        this._invuln = 1.4;
      }
    }
    // Pulse opacity
    beam.material.opacity = 0.65 + 0.30 * Math.sin(performance.now() * 0.012);
  }

  _onBossPhase(mission, phase) {
    console.log(`[Boss] phase → ${phase} (HP ${mission.boss.hp}/${mission.boss.maxHp})`);
    this.audio.sfx('combo');
    this._flashScreen(['', '#ffffff', '#ffa033', '#ff66cc', '#ff3344'][phase] || '#ffffff', 0.45, 280);
    this.particles.burst(mission.boss.mesh.position.clone(),
      { count: 20, color: [0,0xffffff,0xffa033,0xff66cc,0xff3344][phase], speed: 5, life: 0.6 });
    this._toast('BOSS', `Phase ${phase}!`, '⚡');
    this._kickShake(0.6 + phase * 0.25, 320 + phase * 40);
  }

  _updateBeams(mission, dt) {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.mesh.position.z += b.vz * dt;
      b.life -= dt;
      if (b.life <= 0 || b.mesh.position.z < BOUNDS.zMin - 4) {
        this.scene.remove(b.mesh); this.beams.splice(i, 1);
      }
    }
  }

  _updateBossBullets(mission, dt) {
    for (let i = this.bossBullets.length - 1; i >= 0; i--) {
      const b = this.bossBullets[i];
      b.mesh.position.x += b.vx * dt;
      b.mesh.position.z += b.vz * dt;
      b.life -= dt;
      if (b.life <= 0 || b.mesh.position.z > BOUNDS.zMax + 4) {
        this.scene.remove(b.mesh); this.bossBullets.splice(i, 1);
      }
    }
  }

  /** Move enemies/debris/hearts/bombs forward per their kind. */
  _updateEntities(mission, dt) {
    const tNow = performance.now() * 0.001;
    for (let i = mission.entities.length - 1; i >= 0; i--) {
      const e = mission.entities[i];

      if (e.kind === 'enemy') {
        e.mesh.position.z += e.speed * dt;
        // Variant-specific motion
        if (e.variant === 'swooper') {
          e.mesh.position.x = e._baseX + Math.sin(tNow * 2.5 + e._phase) * (e._sweepAmp || 3);
          e.mesh.rotation.z = Math.cos(tNow * 2.5 + e._phase) * 0.5;
        } else {
          e.mesh.rotation.x = Math.sin(this._wobblePhase(e) + tNow * 4) * 0.08;
        }
        // Bomber drops bombs on a timer
        if (e.variant === 'bomber') {
          e._fireT -= dt;
          if (e._fireT <= 0) {
            e._fireT = 1.4 + Math.random() * 0.8;
            this._spawnBomb(mission, e.mesh.position);
          }
        }
      } else if (e.kind === 'bomb') {
        e.mesh.position.z += e.speed * dt;
        e.mesh.rotation.x += 5 * dt;
        e.mesh.rotation.y += 3 * dt;
      } else if (e.kind === 'drone') {
        // Home in on the player (XZ plane)
        const target = (this._coopMode && this.playerShip2 && this.playerShip2.visible
          ? (Math.random() < 0.5 ? this.playerShip2 : this.playerShip)
          : this.playerShip);
        const dx = target.position.x - e.mesh.position.x;
        const dz = target.position.z - e.mesh.position.z;
        const len = Math.hypot(dx, dz) || 1;
        e.mesh.position.x += (dx / len) * e.speed * dt;
        e.mesh.position.z += (dz / len) * e.speed * dt;
        e.mesh.rotation.y += 4 * dt;
      } else if (e.kind === 'debris') {
        e.mesh.position.z += e.speed * dt;
        if (e.spin) {
          e.mesh.rotation.x += e.spin.x * dt;
          e.mesh.rotation.y += e.spin.y * dt;
          e.mesh.rotation.z += e.spin.z * dt;
        }
      } else if (e.kind === 'heart' || e.kind === 'powerup') {
        e.mesh.position.z += (e.vz || 0) * dt;
        e.mesh.rotation.y += 2 * dt;
        e.mesh.position.y = 0.7 + Math.sin(performance.now() * 0.005 + e.mesh.position.x) * 0.18;
        e.life -= dt;
      }

      // Despawn off-field / expired
      if (e.mesh.position.z > BOUNDS.zMax + 4 || (e.life !== undefined && e.life <= 0)) {
        this.scene.remove(e.mesh); mission.entities.splice(i, 1);
      }
    }
  }

  /** Boss-spawned homing drone — small, tracks player, takes 1 hit, +5 score. */
  _spawnDrone(mission) {
    if (!mission.boss) return;
    const body = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.30, 0),
      new THREE.MeshStandardMaterial({ color: 0xff66cc, emissive: 0xff66cc, emissiveIntensity: 0.9, metalness: 0.6, roughness: 0.3 }));
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3344 }));
    eye.position.z = -0.30;
    body.add(eye);
    const trail = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.5 }));
    trail.position.z = 0.4;
    body.add(trail);
    const bp = mission.boss.mesh.position;
    body.position.set(bp.x + (Math.random() - 0.5) * 4, 1.5, bp.z + 1.5);
    mission.spawn(body, 'drone', { hp: 1, speed: 4.5 });
    console.log('[Boss] drone dispatched');
  }

  _spawnBomb(mission, fromPos) {
    const g = new THREE.SphereGeometry(0.30, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd24c });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.copy(fromPos); mesh.position.y = 0.5;
    // Small spike ring for visibility
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.40, 0.06, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xff6622 }));
    ring.rotation.x = Math.PI / 2;
    mesh.add(ring);
    mission.spawn(mesh, 'bomb', { speed: 12 });
  }

  _wobblePhase(e) { return e._phase || (e._phase = Math.random() * Math.PI * 2); }

  _checkBeamHits(mission) {
    if (mission.def.shootingAllowed === false) return;
    for (let bi = this.beams.length - 1; bi >= 0; bi--) {
      const b = this.beams[bi];
      let hit = false;
      // Enemies + drones
      for (let ei = mission.entities.length - 1; ei >= 0; ei--) {
        const e = mission.entities[ei];
        if (e.kind !== 'enemy' && e.kind !== 'drone') continue;
        const radius = e.kind === 'drone' ? 0.45 : ENEMY_RADIUS;
        if (b.mesh.position.distanceTo(e.mesh.position) < radius + BEAM_RADIUS) {
          e.hp -= 1;
          this.particles.flash(b.mesh.position, { color: 0xffffff, scale: 1.5, life: 0.10 });
          if (e.hp <= 0) {
            if (e.kind === 'drone') {
              this.score += Math.round(5 * (this._scoreMultiplier || 1));
              this.particles.burst(e.mesh.position.clone(), { count: 10, color: 0xff66cc, speed: 5, life: 0.5 });
              this.audio.sfx('kill');
            } else {
              this._registerKill(e.mesh.position);
              mission.kills = (mission.kills || 0) + 1;
              if (Math.random() < (mission.def.powerUpChance || 0)) this._spawnHeart(mission, e.mesh.position);
              this.particles.burst(e.mesh.position.clone(), { count: 14, color: 0xff66cc, speed: 6, life: 0.7 });
              this.particles.burst(e.mesh.position.clone(), { count: 8, color: 0xffd24c, speed: 4, life: 0.5, scale: 0.7 });
              this.audio.sfx('kill');
            }
            this.scene.remove(e.mesh);
            mission.entities.splice(ei, 1);
          } else {
            this.audio.sfx('hit');
          }
          hit = true; break;
        }
      }
      if (!hit && mission.boss) {
        if (b.mesh.position.distanceTo(mission.boss.mesh.position) < 2.6) {
          mission.boss.hp = Math.max(0, mission.boss.hp - 1);
          hit = true;
          this.particles.flash(b.mesh.position, { color: 0xff3344, scale: 2.0, life: 0.12 });
          this.audio.sfx('hit');
          if (mission.boss.hp <= 0) {
            // Big boss explosion
            const bp = mission.boss.mesh.position.clone();
            this.particles.burst(bp, { count: 40, color: 0xff3344, speed: 10, life: 1.2 });
            this.particles.burst(bp, { count: 30, color: 0xffd24c, speed: 7,  life: 1.0, scale: 1.2 });
            this.particles.burst(bp, { count: 20, color: 0xff66cc, speed: 5,  life: 0.9, scale: 0.9 });
            this.particles.flash(bp, { color: 0xffffff, scale: 4.0, life: 0.30 });
            this.audio.sfx('mergeBlast');
            this.scene.remove(mission.boss.mesh);
            mission.boss = null;
            this.score += 200;
            this._toast('VICTORY', 'Lord Grump defeated!', '🌟');
          }
        }
      }
      if (hit) { this.scene.remove(b.mesh); this.beams.splice(bi, 1); }
    }
  }

  _checkPlayerHits(mission) {
    const player = (mission.def.mode === 'ON_FOOT_MODE') ? this.runners : this.playerShip;
    // Power-ups (legacy heart kind too)
    for (let i = mission.entities.length - 1; i >= 0; i--) {
      const e = mission.entities[i];
      if (e.kind !== 'heart' && e.kind !== 'powerup') continue;
      if (player.position.distanceTo(e.mesh.position) > PLAYER_RADIUS + HEART_RADIUS) continue;
      const pos = e.mesh.position.clone();
      const realKind = (e.kind === 'heart') ? 'heart' : (e._powerKind || 'heart');
      this._applyPowerUp(realKind, pos);
      this.scene.remove(e.mesh);
      mission.entities.splice(i, 1);
    }
    // Hazards
    for (let i = mission.entities.length - 1; i >= 0; i--) {
      const e = mission.entities[i];
      if (e.kind !== 'enemy' && e.kind !== 'debris' && e.kind !== 'bomb' && e.kind !== 'drone') continue;
      const r = (e.kind === 'bomb') ? 0.4 : (e.kind === 'drone' ? 0.45 : ENEMY_RADIUS);
      if (player.position.distanceTo(e.mesh.position) < PLAYER_RADIUS + r) {
        this._onPlayerHit(e.kind);
        this.particles.burst(e.mesh.position.clone(),
          { count: 10, color: e.kind === 'bomb' ? 0xffd24c : 0xff5555, speed: 4, life: 0.5 });
        this.scene.remove(e.mesh); mission.entities.splice(i, 1);
        return;
      }
    }
    // Boss bullets
    for (let i = this.bossBullets.length - 1; i >= 0; i--) {
      const b = this.bossBullets[i];
      if (player.position.distanceTo(b.mesh.position) < PLAYER_RADIUS + BOSS_BULLET_RADIUS) {
        this._onPlayerHit('bullet');
        this.scene.remove(b.mesh); this.bossBullets.splice(i, 1);
        return;
      }
    }
  }

  _onPlayerHit(kind) {
    if (this._invuln > 0) return;
    if (this._shieldT > 0) {
      this.achievements.fire('shielded_hit');
      this._toast('SHIELD', 'Absorbed!', '💧');
      this.audio.sfx('hit');
      return;
    }
    this.achievements.fire('damaged');
    this.lives -= 1;
    this._lastDamageT = this._missionElapsed;
    this._noDamageT = 0;
    this.combo = 0;
    this._invuln = 1.4;       // i-frames so player isn't gang-killed
    const el = document.getElementById('hud-combo');
    if (el) el.classList.add('hidden');
    this._toast('OUCH', `Hit by ${kind}`, '💔');
    console.log(`[Game] hit by ${kind} → lives ${this.lives}`);
    this.audio.sfx('hurt');
    this._flashScreen('#ff3344', 0.45);
    this._kickShake(0.7, 240);
    this._kickShake(0.7, 240);
    if (this.playerShip?.visible) {
      this.particles.burst(this.playerShip.position.clone(), { count: 12, color: 0xff5555, speed: 4, life: 0.5 });
    } else if (this.runners?.visible) {
      this.particles.burst(this.runners.position.clone().setY(0.8), { count: 10, color: 0xff5555, speed: 3, life: 0.5 });
    }
  }

  /** Brief full-screen color flash (CSS overlay). */
  _flashScreen(color, opacity = 0.5, ms = 220) {
    let overlay = document.getElementById('hit-flash');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hit-flash';
      overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:15;opacity:0;transition:opacity 200ms ease-out';
      this.canvas.parentElement.appendChild(overlay);
    }
    overlay.style.background = color;
    overlay.style.opacity = String(opacity);
    setTimeout(() => { overlay.style.opacity = '0'; }, ms);
  }

  /** Called when a mission successfully completes (before story/victory). */
  _onMissionComplete(def) {
    console.log(`[Game] mission complete: ${def.id} — ${def.title}`);
    this.audio.sfx('missionComplete');
    this._toast(`MISSION ${def.id} CLEAR`, def.title, '🌟');
    this._flashScreen('#5effd1', 0.35, 320);
    this._kickShake(1.0, 380);
    const lostLives = (this._missionLivesAtStart - this.lives);
    this.achievements.fire('mission_complete', { id: def.id, lostLives });
    // Track lives at start of next mission
    this._missionLivesAtStart = this.lives;
  }

  /** Boss-mission intro cinematic. ~3.5 s fly-by + voiceover, then resumes gameplay. */
  _playBossIntro(mission) {
    if (!mission || !mission.boss) return;
    console.log('[Cinematic] ▶ Boss intro');
    mission._introUntil = performance.now() + 3500;
    // If the boss arena GLB shipped a cinematic camera, take it over for the intro
    const arenaInst = this._envInstances?.env_boss_arena;
    if (arenaInst?.cinematicCamera) {
      this.setCinematicCamera(arenaInst.cinematicCamera);
      setTimeout(() => this.setCinematicCamera(null), 3300);
    }
    // Push camera into a dramatic angle anchored on the mothership
    const bossPos = mission.boss.mesh.position;
    this._currentPos.set(bossPos.x - 2, bossPos.y + 5, bossPos.z + 8);
    this._currentLook.copy(bossPos);
    this.setCameraMode('WIDE_ARENA');
    // Flash + shake + voice
    this._flashScreen('#ff3344', 0.5, 320);
    this._kickShake(1.4, 600);
    this.audio.sfx('mergeBlast');
    this.audio.speak('Foolish heroes, witness your end!', 'narrator');
    // Particle "engines igniting" on the boss
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        if (!mission.boss) return;
        this.particles.burst(mission.boss.mesh.position.clone(),
          { count: 14, color: 0xff3344, speed: 5, life: 0.6 });
        this._kickShake(0.5 + i * 0.1, 220);
      }, i * 350);
    }
    // Boss banner overlay
    let banner = document.getElementById('boss-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'boss-banner';
      banner.style.cssText = `
        position:absolute;left:0;right:0;top:38%;z-index:18;text-align:center;
        font-weight:900;letter-spacing:6px;color:#fff;
        text-shadow:0 0 18px #ff3344, 0 4px 0 #000;
        pointer-events:none;opacity:0;transition:opacity 250ms ease;`;
      this.canvas.parentElement.appendChild(banner);
    }
    banner.innerHTML = `
      <div style="font-size:13px;letter-spacing:8px;color:#ff8b8b">⚠ FINAL BOSS ⚠</div>
      <div style="font-size:36px;line-height:1.05;margin-top:8px">LORD GRUMP</div>`;
    banner.style.opacity = '1';
    setTimeout(() => { banner.style.opacity = '0'; }, 3000);
    setTimeout(() => banner.remove(), 3500);
  }

  /** Mini-cutscene before the next story screen. Pans the camera around new scenery
      while a big banner shows the next mission title. ~2.5 s. */
  _playCutscene(nextIdx, onDone) {
    const def = LEVELS[nextIdx];
    if (!def) { onDone?.(); return; }
    console.log(`[Cutscene] ▶ mission ${def.id}: ${def.title}`);
    this.state = 'cutscene';
    // Show the next mission's scenery now
    const sceneryKey = ({ FLYING_MODE: 'space', RE_ENTRY_MODE: 'reentry', ON_FOOT_MODE: 'cave', BOSS_MODE: 'boss' })[def.mode] || 'space';
    this._setActiveScenery(sceneryKey);
    this._showShip(false); this._showRunners(false); this._showMenuShowcase(false);
    this._showScreen('play');                 // hide overlays during pan
    document.getElementById('hud')?.classList.add('hidden');

    // Force the camera to a dramatic angle, then lerp through to mission preset
    const dramaticPos = new THREE.Vector3(8, 4.5, 4);
    const dramaticLook = new THREE.Vector3(0, 1, -8);
    this._currentPos.copy(dramaticPos);
    this._currentLook.copy(dramaticLook);
    const targetPreset = ({ TOP_DOWN: 'TOP_DOWN', TOP_DOWN_SHAKE: 'TOP_DOWN_SHAKE', ANGLED_FOLLOW: 'ANGLED_FOLLOW', WIDE_ARENA: 'WIDE_ARENA' })[def.cameraMode] || 'TOP_DOWN';
    this.setCameraMode(targetPreset);

    // Banner overlay
    let banner = document.getElementById('cutscene-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'cutscene-banner';
      banner.style.cssText = `
        position:absolute;left:0;right:0;top:35%;z-index:18;text-align:center;
        font-weight:900;letter-spacing:4px;color:#fff;
        text-shadow:0 0 16px rgba(255,200,80,0.8),0 4px 0 #000;
        pointer-events:none;opacity:0;transition:opacity 250ms ease;`;
      this.canvas.parentElement.appendChild(banner);
    }
    banner.innerHTML = `
      <div style="font-size:13px;letter-spacing:6px;color:#ffd24c">MISSION ${def.id}</div>
      <div style="font-size:30px;line-height:1.05;margin-top:6px">${def.title}</div>`;
    banner.style.opacity = '1';
    this.audio.sfx('missionComplete');

    setTimeout(() => { banner.style.opacity = '0'; }, 1900);
    setTimeout(() => {
      banner.remove();
      onDone?.();
    }, 2400);
  }

  /** Award kill points + handle combo multiplier + score popup. */
  _registerKill(worldPos) {
    this.combo += 1;
    this._comboT = this._comboTimeout;
    const mult = Math.min(5, 1 + Math.floor(this.combo / 3));
    const points = Math.round(10 * mult * (this._scoreMultiplier || 1));
    this.score += points;
    this.achievements.fire('kill');
    this.achievements.fire('combo', { combo: this.combo, mult });
    this.particles.scorePopup(worldPos.clone(), this.camera, this.canvas,
      mult > 1 ? `+${points} ×${mult}` : `+${points}`,
      mult > 1 ? '#ff8be0' : '#ffe45e');
    if (mult > 1 && this.combo % 3 === 0) {
      this.audio.sfx('combo');
      this._toast('COMBO', `×${mult}`, '🔥');
    }
    // HUD combo badge
    let el = document.getElementById('hud-combo');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hud-combo';
      el.style.cssText =
        'position:absolute;top:74px;left:14px;font-weight:900;font-size:14px;letter-spacing:1.5px;color:#ff8be0;text-shadow:0 0 8px rgba(255,100,200,0.7),0 2px 3px #000;';
      document.getElementById('hud')?.appendChild(el);
    }
    if (this.combo >= 2) {
      el.classList.remove('hidden');
      el.textContent = `COMBO ×${mult}  (${this.combo})`;
    } else {
      el.classList.add('hidden');
    }
  }
}
