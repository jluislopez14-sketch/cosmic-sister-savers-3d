// AssetLoader.js — Fault-tolerant GLB pipeline.
//
//   Design principles:
//   1. _loadOne ALWAYS resolves — never rejects. A failed asset becomes a
//      magenta `BoxGeometry` placeholder so the game keeps booting.
//   2. Each load is wrapped in Promise.race against a per-asset timeout,
//      defaulting to 10 s, after which we abandon the request and substitute
//      the magenta box.
//   3. The loader exposes a `forceFinish()` escape hatch. When invoked
//      (e.g. by the FORCE START button), `loadAll()` resolves immediately
//      with whatever has loaded; any missing keys are filled with placeholders.
//   4. Verbose progress callbacks let the UI display the current file being
//      fetched and a real fill bar.
//
//   Public API:
//     const loader = new AssetLoader(undefined, {
//       timeoutMs: 10_000,
//       onProgress: (info) => { ... }     // info: { key, url, status, completed, total }
//     });
//     await loader.loadAll();
//     loader.get(key)          → cheap clone for static props
//     loader.getInstance(key)  → { scene, mixer, actions, collisionBoxes, embeddedCamera }
//     loader.forceFinish()     → unblock loadAll(); fill any missing keys
//
// Magenta-cube convention: any time you see a hot-pink wireframe-ish cube in
// the game world, an asset failed to load. Open the dev console — the exact
// failed URL will be there.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';

// ---- Asset registry ----
//
// Edit ASSETS to swap files in/out. Missing files (404 / network error /
// timeout) become magenta cubes — they don't block boot.
export const ASSETS = {
  // Heroes
  alaia:        'models/alaia.glb',
  lisabel:      'models/lisabel.glb',
  jose:         'models/jose.glb',
  mom:          'models/mom.glb',
  greeny:       'models/greeny.glb',

  // Vehicles & props (static)
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

/** When a rigged file is missing, alias to the corresponding primitive so the
    game stays visually coherent. Applied AFTER all loads settle. */
const FALLBACK_ALIAS = {
  player_rigged: 'player_ship',
  enemy_drone:   'enemy',
  mech_rigged:   'player_ship',
  boss_grump:    'mothership',
};

// Magenta material — bright, unmistakable, easy to spot in console + scene.
const MAGENTA_MAT_PARAMS = {
  color:            0xff00ff,
  emissive:         0xff00ff,
  emissiveIntensity: 0.55,
  roughness:        0.4,
  metalness:        0.0,
};

export class AssetLoader {
  constructor(assets = ASSETS, options = {}) {
    // Accept either format:
    //   1. Object map:    { name1: url1, name2: url2, ... }
    //   2. Array of pairs: [ { name: 'foo', url: 'models/foo.glb' }, ... ]
    // Array form is preferred — easier to scan and reorder.
    if (Array.isArray(assets)) {
      this.urls = {};
      for (const entry of assets) {
        if (!entry || !entry.name || !entry.url) {
          console.warn('[AssetLoader] manifest entry missing name/url:', entry);
          continue;
        }
        this.urls[entry.name] = entry.url;
      }
    } else if (assets && typeof assets === 'object') {
      this.urls = { ...assets };
    } else {
      console.error('[AssetLoader] manifest is not an array or object:', assets);
      this.urls = {};
    }

    const count = Object.keys(this.urls).length;
    if (count === 0) {
      console.error('[AssetLoader] WARNING: empty manifest — no GLBs will be loaded.');
    } else {
      console.log(`[AssetLoader] manifest accepted: ${count} entries — ${Object.keys(this.urls).join(', ')}`);
    }

    this.cache = {};
    this._loader = new GLTFLoader();

    /** Per-asset timeout in ms. Anything slower is abandoned + replaced. */
    this.timeoutMs = options.timeoutMs ?? 10_000;
    /** UI hook: ({ key, url, status, completed, total }) => void
        statuses: 'loading' | 'done' | 'error' | 'timeout' | 'forced' */
    this.onProgress = options.onProgress || (() => {});

    /** Set to true by forceFinish() — loadAll() will short-circuit. */
    this._forced = false;
    /** Promise.all() may finish before the force flag flips; we guard with
        this resolved flag so onProgress doesn't double-emit. */
    this._loadAllResolved = false;
  }

  /** Unblock loadAll() right now, regardless of pending requests. */
  forceFinish() {
    if (this._forced) return;
    this._forced = true;
    console.warn('[AssetLoader] FORCE FINISH triggered');
  }

  /** Load every asset in parallel. NEVER throws. */
  async loadAll() {
    const entries = Object.entries(this.urls);
    const total = entries.length;
    let completed = 0;

    const tasks = entries.map(([key, url]) => {
      // Tell the UI we're starting this one (counted as part of `total`).
      this._safeProgress({ key, url, status: 'loading', completed, total });

      return this._loadWithTimeout(key, url).then(({ status }) => {
        completed += 1;
        this._safeProgress({ key, url, status, completed, total });
      });
    });

    // Race Promise.all against a polling check on the force flag.
    // We can't AbortController GLTFLoader directly; instead we let in-flight
    // requests finish in the background while loadAll() resolves immediately.
    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(forceCheck);
        resolve();
      };
      const forceCheck = setInterval(() => { if (this._forced) finish(); }, 100);
      Promise.all(tasks).finally(finish);
    });
    this._loadAllResolved = true;

    // Fill any keys still missing (force-start path) with magenta fallbacks.
    for (const [key] of entries) {
      if (!this.cache[key]) this.cache[key] = this._fallbackPrototype(key, 'forced');
    }

    // Wire FALLBACK_ALIAS so rigged slots fall back to working primitives.
    for (const [k, aliasKey] of Object.entries(FALLBACK_ALIAS)) {
      const proto = this.cache[k];
      const aliased = this.cache[aliasKey];
      if (proto?.placeholder && aliased && !aliased.placeholder) {
        console.log(`[AssetLoader] alias "${k}" → "${aliasKey}" (rigged slot empty)`);
        this.cache[k] = { ...aliased, _aliasOf: aliasKey };
      }
    }

    const realCount = Object.values(this.cache).filter((p) => !p.placeholder).length;
    const fallbackCount = total - realCount;
    const animatedCount = Object.values(this.cache).filter((p) => p.clips?.length).length;
    console.log(`[AssetLoader] complete: ${realCount}/${total} real (${fallbackCount} fallback, ${animatedCount} animated)`);
    return this.cache;
  }

  // ---- internals ----

  _safeProgress(info) {
    try { this.onProgress(info); }
    catch (e) { console.warn('[AssetLoader] onProgress threw:', e); }
  }

  /**
   * Wraps `_loadOne` in a 10-second timeout.
   * Returns: Promise<{ status: 'done'|'error'|'timeout' }>
   * Always resolves — never rejects.
   */
  _loadWithTimeout(key, url) {
    let timedOut = false;
    let settled = false;
    return new Promise((resolve) => {
      const finish = (status) => {
        if (settled) return;
        settled = true;
        resolve({ status });
      };

      // Per-asset timeout: drop the load, install a magenta box.
      const timer = setTimeout(() => {
        timedOut = true;
        if (!this.cache[key]) {
          console.warn(`[AssetLoader] TIMEOUT after ${this.timeoutMs}ms: ${url}`);
          this.cache[key] = this._fallbackPrototype(key, 'timeout');
        }
        finish('timeout');
      }, this.timeoutMs);

      this._loader.load(url,
        // onLoad
        (gltf) => {
          clearTimeout(timer);
          if (timedOut) return;     // late success — ignore (timeout already won)
          try {
            this.cache[key] = this._buildPrototype(gltf, key);
            if (this.cache[key].clips.length) {
              console.log(`[AssetLoader] ${key}: ${this.cache[key].clips.length} clip(s) — ${this.cache[key].clips.map(c => c.name).join(', ')}`);
            }
          } catch (e) {
            console.error(`[AssetLoader] post-load error for "${key}" (${url}):`, e);
            this.cache[key] = this._fallbackPrototype(key, 'error');
            finish('error');
            return;
          }
          finish('done');
        },
        // onProgress: ignore — per-byte updates are too noisy for our use case
        undefined,
        // onError — bullet-proof: log + fallback + RESOLVE (never reject)
        (err) => {
          clearTimeout(timer);
          if (timedOut) return;
          console.error(`[AssetLoader] FAILED to load "${url}":`, err?.message || err);
          if (!this.cache[key]) this.cache[key] = this._fallbackPrototype(key, 'error');
          finish('error');
        });
    });
  }

  /** Build a real prototype from a parsed glTF. */
  _buildPrototype(gltf, key) {
    const scene = gltf.scene || gltf.scenes?.[0] || new THREE.Group();
    const clips = gltf.animations || [];
    let embeddedCamera = null;
    scene.traverse((o) => {
      if (o.isCamera && !embeddedCamera) embeddedCamera = o;
    });
    return {
      scene,
      clips,
      embeddedCamera,
      placeholder: false,
    };
  }

  /**
   * Bright magenta `BoxGeometry` fallback. Shape kept identical to a real
   * prototype so callers don't need to special-case it.
   *
   * `reason` ∈ 'error' | 'timeout' | 'forced' — surfaced for debugging.
   */
  _fallbackPrototype(key, reason) {
    const geom = new THREE.BoxGeometry(1.0, 1.0, 1.0);
    const mat = new THREE.MeshStandardMaterial({ ...MAGENTA_MAT_PARAMS });
    const cube = new THREE.Mesh(geom, mat);
    cube.userData = { placeholder: true, originalKey: key, failureReason: reason };
    // Slight wireframe overlay to make it extra-obvious in render
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geom),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 })
    );
    cube.add(wire);
    const wrap = new THREE.Group();
    wrap.add(cube);
    return {
      scene: wrap,
      clips: [],
      embeddedCamera: null,
      placeholder: true,
      failureReason: reason,
    };
  }

  /** Static-prop clone (no animation). Returns Object3D. Robust to misses. */
  get(key) {
    const proto = this.cache[key];
    if (!proto) {
      console.warn(`[AssetLoader] get("${key}"): unknown asset → magenta box`);
      return this._fallbackPrototype(key, 'unknown').scene.clone(true);
    }
    return proto.scene.clone(true);
  }

  /**
   * Rich instance for animated/rigged models. Always returns a usable shape;
   * if the asset failed, you get a magenta box with no actions.
   */
  getInstance(key) {
    const proto = this.cache[key];
    if (!proto) {
      console.warn(`[AssetLoader] getInstance("${key}"): unknown — magenta box`);
      return { scene: this._fallbackPrototype(key, 'unknown').scene, mixer: null, actions: {}, collisionBoxes: [], embeddedCamera: null };
    }
    const cloned = (proto.clips.length || this._isSkinned(proto.scene))
      ? SkeletonUtils.clone(proto.scene)
      : proto.scene.clone(true);
    const collisionBoxes = this._extractCollisionBoxes(cloned);
    let embeddedCamera = null;
    cloned.traverse((o) => { if (o.isCamera && !embeddedCamera) embeddedCamera = o; });
    let mixer = null;
    const actions = {};
    if (proto.clips.length) {
      mixer = new THREE.AnimationMixer(cloned);
      for (const clip of proto.clips) actions[clip.name] = mixer.clipAction(clip);
    }
    return { scene: cloned, mixer, actions, collisionBoxes, embeddedCamera };
  }

  _isSkinned(root) {
    let found = false;
    root.traverse((o) => { if (o.isSkinnedMesh) found = true; });
    return found;
  }

  /** Walks scene, hides COL_-prefixed meshes, returns world-space Box3 list. */
  _extractCollisionBoxes(root) {
    const boxes = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (typeof o.name !== 'string' || !o.name.startsWith('COL_')) return;
      o.visible = false;
      o.userData.isCollisionProxy = true;
      boxes.push(new THREE.Box3().setFromObject(o));
    });
    return boxes;
  }
}
