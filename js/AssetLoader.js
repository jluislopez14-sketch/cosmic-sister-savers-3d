// AssetLoader.js — GLB pipeline with animation, materials, and collision support.
//
//   const loader = new AssetLoader();
//   await loader.loadAll();
//
//   // Static prop → just a clone:
//   const prop = loader.get('asteroid');
//
//   // Animated/rigged model → instance with mixer + actions:
//   const inst = loader.getInstance('player_rigged');
//   inst.actions.Idle?.play();
//   // each frame: inst.mixer.update(dt)
//
// Design notes:
//   * Each GLB is loaded once into a "prototype" cache (scene + clips).
//   * `get(key)` returns a deep clone of the scene only — no mixer.
//     Use this for static props (ships, asteroids, hearts).
//   * `getInstance(key)` returns a fresh clone WITH its own AnimationMixer
//     and an actions map keyed by animation clip name. Each instance owns
//     its own playback state — vital for crowds of enemies all running
//     the same Idle clip at different phases.
//   * COL_-prefixed meshes inside a scene are interpreted as invisible
//     collision proxies. They're hidden at instantiation, but their
//     world-space AABBs are returned in `collisionBoxes`. Use these
//     instead of running raycasts against high-poly visual meshes.
//   * Missing GLBs → colored placeholder mesh (game still runs).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';

/**
 * ASSETS map — edit this to swap files in/out. The loader requests these
 * paths; missing files (404) become placeholders, so the game still runs
 * during asset iteration.
 *
 * `*_rigged` and `env_*` keys are slots for the new animated/environment
 * GLBs. If your high-fidelity export isn't ready yet, the loader will fall
 * back to a colored placeholder (or, where wired, an alias to an existing
 * primitive asset — see `_aliases`).
 */
export const ASSETS = {
  // Heroes
  alaia:        'models/alaia.glb',
  lisabel:      'models/lisabel.glb',
  jose:         'models/jose.glb',
  mom:          'models/mom.glb',
  greeny:       'models/greeny.glb',

  // Vehicles & props (static, no animation)
  player_ship:  'models/player_ship.glb',
  enemy:        'models/enemy_fighter.glb',
  asteroid:     'models/asteroid.glb',
  mothership:   'models/mothership.glb',
  heart:        'models/powerup_heart.glb',

  // High-fidelity rigged characters (slots — drop in when ready)
  player_rigged: 'models/player_rigged.glb',
  enemy_drone:   'models/enemy_drone.glb',
  mech_rigged:   'models/mech_rigged.glb',
  boss_grump:    'models/boss_grump.glb',

  // Environments (slots)
  env_space_track: 'models/env_space_track.glb',
  env_boss_arena:  'models/env_boss_arena.glb',
};

/** When a rigged file isn't present, use these primitive assets as visual
    fallbacks so the game stays playable. */
const FALLBACK_ALIAS = {
  player_rigged: 'player_ship',
  enemy_drone:   'enemy',
  mech_rigged:   'player_ship',
  boss_grump:    'mothership',
};

const PLACEHOLDER_COLORS = {
  alaia: 0xff66cc, lisabel: 0xffd24c, jose: 0x4488ff, mom: 0xff8be0, greeny: 0x66ff77,
  player_ship: 0xa050ff, enemy: 0x9933cc, asteroid: 0x999999, mothership: 0xff3344, heart: 0xff66aa,
  player_rigged: 0xff66cc, enemy_drone: 0xb04fcc, mech_rigged: 0xffd24c, boss_grump: 0xff3344,
  env_space_track: 0x150633, env_boss_arena: 0x3a0820,
};
const ROUND_KEYS = new Set(['alaia','lisabel','jose','mom','greeny','asteroid','heart','enemy_drone']);

export class AssetLoader {
  constructor(assets = ASSETS) {
    this.urls = { ...assets };
    /** prototypes keyed by asset name → { scene, clips, mixerOK } */
    this.cache = {};
    this._loader = new GLTFLoader();
  }

  /** Load every asset in parallel. Returns when all promises settle. */
  async loadAll() {
    const t0 = performance.now();
    const tasks = Object.entries(this.urls).map(([k, url]) => this._loadOne(k, url));
    await Promise.all(tasks);

    // Wire fallback aliases for any rigged slot that came in as a placeholder.
    for (const [k, aliasKey] of Object.entries(FALLBACK_ALIAS)) {
      const proto = this.cache[k];
      if (proto?.placeholder && this.cache[aliasKey] && !this.cache[aliasKey].placeholder) {
        console.log(`[AssetLoader] alias "${k}" → "${aliasKey}" (rigged file missing)`);
        this.cache[k] = { ...this.cache[aliasKey], _aliasOf: aliasKey };
      }
    }

    const animatedCount = Object.values(this.cache).filter((p) => p.clips?.length).length;
    console.log(`[AssetLoader] loaded ${Object.keys(this.cache).length} assets (${animatedCount} animated) in ${(performance.now()-t0).toFixed(0)}ms`);
    return this.cache;
  }

  _loadOne(key, url) {
    return new Promise((resolve) => {
      this._loader.load(url,
        (gltf) => {
          const proto = this._buildPrototype(gltf, key);
          this.cache[key] = proto;
          if (proto.clips.length) console.log(`[AssetLoader] ${key}: ${proto.clips.length} animation clip(s) — ${proto.clips.map(c => c.name).join(', ')}`);
          if (proto.embeddedCamera) console.log(`[AssetLoader] ${key}: embedded camera detected`);
          resolve();
        },
        undefined,
        (err) => {
          console.warn(`[AssetLoader] missing "${key}" (${url}) — placeholder.`, err?.message || '');
          this.cache[key] = this._placeholderPrototype(key);
          resolve();
        });
    });
  }

  /** Convert a parsed glTF into our prototype shape. */
  _buildPrototype(gltf, key) {
    const scene = gltf.scene || gltf.scenes?.[0] || new THREE.Group();
    const clips = gltf.animations || [];
    // Pluck out any embedded camera before we strip it from the scene
    let embeddedCamera = null;
    scene.traverse((o) => {
      if (o.isCamera && !embeddedCamera) embeddedCamera = o;
    });
    return {
      scene,                  // shared prototype — clone before adding to live scene
      clips,                  // shared AnimationClip array
      embeddedCamera,         // optional (used for cinematic shots)
      placeholder: false,
    };
  }

  /** Build a synthetic placeholder prototype matching our prototype shape. */
  _placeholderPrototype(key) {
    const color = PLACEHOLDER_COLORS[key] ?? 0xff66cc;
    const round = ROUND_KEYS.has(key);
    const isEnv = key.startsWith('env_');
    let geom, mat;
    if (isEnv) {
      // Environment placeholder: a darkly-tinted plane far behind the action
      geom = new THREE.PlaneGeometry(60, 60);
      mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false });
      const m = new THREE.Mesh(geom, mat);
      m.position.set(0, 0, -38);
      m.userData.placeholder = true;
      const g = new THREE.Group();
      g.add(m);
      return { scene: g, clips: [], embeddedCamera: null, placeholder: true };
    }
    geom = round ? new THREE.SphereGeometry(0.6, 16, 12) : new THREE.BoxGeometry(1.0, 1.4, 1.0);
    mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.30, roughness: 0.6, metalness: 0.05,
    });
    const m = new THREE.Mesh(geom, mat);
    m.userData.placeholder = true;
    const wrap = new THREE.Group(); wrap.add(m);
    return { scene: wrap, clips: [], embeddedCamera: null, placeholder: true };
  }

  /** Cheap clone for static props (no animation). Returns an Object3D. */
  get(key) {
    const proto = this.cache[key];
    if (!proto) {
      console.warn(`[AssetLoader] unknown asset "${key}"`);
      return this._placeholderPrototype(key).scene.clone(true);
    }
    return proto.scene.clone(true);
  }

  /**
   * Rich instance for animated/rigged models.
   *   const inst = loader.getInstance('player_rigged');
   *   inst.actions.Idle?.play();
   *   // tick: inst.mixer.update(dt);
   *
   * Returns: {
   *   scene:           Object3D    — the deep clone you add to scene
   *   mixer:           AnimationMixer | null  (null if no clips on prototype)
   *   actions:         { [name]: AnimationAction }
   *   collisionBoxes:  Box3[]      — world-space AABBs from COL_-prefixed meshes
   *                                   (already hidden so they don't render)
   *   embeddedCamera:  Camera|null — convenience pointer to any cinematic cam
   * }
   */
  getInstance(key) {
    const proto = this.cache[key];
    if (!proto) return { scene: new THREE.Group(), mixer: null, actions: {}, collisionBoxes: [], embeddedCamera: null };
    // Use SkeletonUtils.clone so that skinned meshes share their original
    // skeleton bones correctly. Falls back to .clone(true) for static GLBs.
    const cloned = (proto.clips.length || this._isSkinned(proto.scene))
      ? SkeletonUtils.clone(proto.scene)
      : proto.scene.clone(true);
    // Find collision boxes; hide their meshes; collect Box3s in world space
    const collisionBoxes = this._extractCollisionBoxes(cloned);
    // Fish out any cloned camera node (rare but cheap to look)
    let embeddedCamera = null;
    cloned.traverse((o) => { if (o.isCamera && !embeddedCamera) embeddedCamera = o; });

    let mixer = null;
    const actions = {};
    if (proto.clips.length) {
      mixer = new THREE.AnimationMixer(cloned);
      for (const clip of proto.clips) {
        actions[clip.name] = mixer.clipAction(clip);
      }
    }
    return { scene: cloned, mixer, actions, collisionBoxes, embeddedCamera };
  }

  _isSkinned(root) {
    let found = false;
    root.traverse((o) => { if (o.isSkinnedMesh) found = true; });
    return found;
  }

  /**
   * Walk a scene, hide any mesh whose name starts with "COL_" (treated as
   * an invisible collision proxy), and return a world-space Box3 for each.
   * Boxes are recomputed once at instantiation; if your collision proxy
   * needs to follow an animated bone, recompute its Box3 each frame.
   */
  _extractCollisionBoxes(root) {
    const boxes = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (typeof o.name !== 'string' || !o.name.startsWith('COL_')) return;
      o.visible = false;
      o.userData.isCollisionProxy = true;
      const box = new THREE.Box3().setFromObject(o);
      boxes.push(box);
    });
    return boxes;
  }
}
