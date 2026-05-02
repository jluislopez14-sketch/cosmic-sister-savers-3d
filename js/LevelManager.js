// LevelManager.js — Mission states, transitions, per-mode gameplay logic.
//
// Each mission is a class with a consistent shape:
//   enter(), tick(dt), isComplete(), isFailed(), exit().
// LevelManager owns the active Mission and handles advance/fail transitions.
//
// The Game (Game.js) exposes a small set of shared helpers (camera modes,
// ship/runner movement, projectiles, collisions, HUD updates) so missions stay
// readable.

import * as THREE from 'three';
import { STORY } from './StoryData.js';

export const LEVELS = [
  {
    id: 1, key: 'mission1', title: 'ESCAPING EARTH',
    mode: 'FLYING_MODE',
    cameraMode: 'TOP_DOWN',
    bgTint: 0x150633,
    goal: { type: 'kills', value: 20 },
    enemy:    { interval: 1100, speed: 5.5, hp: 1 },
    asteroid: { interval: 0,    speed: 0 },
    powerUpChance: 0.18,
    shootingAllowed: true,
    music: 'synth:space',
  },
  {
    id: 2, key: 'mission2', title: 'ATMOSPHERIC RE-ENTRY',
    mode: 'RE_ENTRY_MODE',
    cameraMode: 'TOP_DOWN_SHAKE',
    bgTint: 0x4a0e08,
    goal: { type: 'survive', value: 30000 },
    enemy:    { interval: 0,    speed: 0 },
    asteroid: { interval: 360,  speed: 18 },          // 3x faster than M1's debris pace
    powerUpChance: 0.0,
    shootingAllowed: false,
    music: 'synth:reentry',
  },
  {
    id: 3, key: 'mission3', title: 'THE CRYSTAL CAVES',
    mode: 'ON_FOOT_MODE',
    cameraMode: 'ANGLED_FOLLOW',
    bgTint: 0x2c0a4a,
    goal: { type: 'distance', value: 220 },           // run distance in world units
    runner: { speed: 11, lanes: [-2.4, 0, 2.4], jumpV: 7.5, gravity: 18 },
    obstacleInterval: 700,
    shootingAllowed: false,
    music: 'synth:caves',
  },
  {
    id: 4, key: 'mission4', title: "LORD GRUMP'S LANDING PAD",
    mode: 'BOSS_MODE',
    cameraMode: 'WIDE_ARENA',
    bgTint: 0x3a0820,
    goal: { type: 'boss', value: 1 },
    enemy:    { interval: 2400, speed: 6, hp: 1 },
    asteroid: { interval: 0,    speed: 0 },
    powerUpChance: 0.30,
    shootingAllowed: true,
    boss: { hp: 100 },
    music: 'synth:boss',
  },
];

// =====================================================================
// Base Mission
// =====================================================================
class Mission {
  constructor(game, def) {
    this.game = game;
    this.def = def;
    this.entities = [];   // generic spawned things (enemy, debris, heart…)
    this.elapsed = 0;
    this._completeFlag = false;
  }

  enter() {
    console.log(`[Mission ${this.def.id}] enter — ${this.def.title} (${this.def.mode})`);
    this.game.setCameraMode(this.def.cameraMode);
    if (this.def.bgTint != null) this.game._setBgTint(this.def.bgTint);
    this.game._renderHUD();
  }

  tick(dt) { this.elapsed += dt; }

  /** Composite difficulty multiplier: time-based ramp × dynamic difficulty. */
  get rampMul() {
    const t = Math.min(60, this.elapsed);
    const base = 1.0 + (t / 60) * 0.6;
    const dda = this.game._ddaMultiplier ? this.game._ddaMultiplier() : 1.0;
    return base * dda;
  }
  rampedInterval(base) { return base ? Math.max(150, base / this.rampMul) : 0; }
  rampedSpeed(base)    { return base * this.rampMul; }

  isComplete() { return this._completeFlag; }
  isFailed()   { return this.game.lives <= 0; }

  exit() {
    console.log(`[Mission ${this.def.id}] exit`);
    for (const e of this.entities) this.game.scene.remove(e.mesh);
    this.entities = [];
  }

  /** Add a mesh + bookkeeping object to the entity list and the scene. */
  spawn(mesh, kind, props = {}) {
    const ent = { mesh, kind, ...props };
    this.entities.push(ent);
    this.game.scene.add(mesh);
    return ent;
  }

  remove(ent) {
    const i = this.entities.indexOf(ent);
    if (i >= 0) this.entities.splice(i, 1);
    this.game.scene.remove(ent.mesh);
  }
}

// =====================================================================
// Mission 1 — Flying Top-Down Shooter
// =====================================================================
class FlyingMission extends Mission {
  constructor(g, def) {
    super(g, def);
    this.kills = 0;
    this._lastEnemy = 0;
    this._lastFire  = 0;
  }
  enter() {
    super.enter();
    this.game.input.setMode('STEER');
    this.game._showShip(true);
    this.game._showRunners(false);
    this.game.audio.speakSequence(STORY[this.def.key].voice, 350);
  }
  tick(dt) {
    super.tick(dt);
    const g = this.game;
    g._updateShip(dt);

    this._lastEnemy += dt * 1000;
    if (this.def.enemy.interval > 0 && this._lastEnemy >= this.rampedInterval(this.def.enemy.interval)) {
      this._lastEnemy = 0;
      g._spawnEnemy(this);
    }
    this._lastFire += dt;
    if (this.def.shootingAllowed && this._lastFire > 0.18) {
      this._lastFire = 0;
      g._fireBeams(this);
    }

    g._updateBeams(this, dt);
    g._updateEntities(this, dt);
    g._checkBeamHits(this);
    g._checkPlayerHits(this);

    if (this.kills >= this.def.goal.value) {
      console.log(`[Mission 1] kills met: ${this.kills}/${this.def.goal.value}`);
      this._completeFlag = true;
    }
  }
}

// =====================================================================
// Mission 2 — Atmospheric Re-Entry (Survival, no shooting, camera shake)
// =====================================================================
class ReEntryMission extends Mission {
  constructor(g, def) {
    super(g, def);
    this._lastSpawn = 0;
    this._shakeT = 0;
  }
  enter() {
    super.enter();
    this.game.input.setMode('STEER');
    this.game._showShip(true);
    this.game._showRunners(false);
    this.game.audio.speakSequence(STORY[this.def.key].voice, 350);
  }
  tick(dt) {
    super.tick(dt);
    const g = this.game;
    g._updateShip(dt);

    this._lastSpawn += dt * 1000;
    if (this._lastSpawn >= this.rampedInterval(this.def.asteroid.interval)) {
      this._lastSpawn = 0;
      g._spawnDebris(this, this.rampedSpeed(this.def.asteroid.speed));
    }
    g._updateEntities(this, dt);
    g._checkPlayerHits(this);

    // Heavy camera shake (re-entry buffeting)
    this._shakeT += dt * 26;
    g._cameraShake(Math.sin(this._shakeT) * 0.34, Math.cos(this._shakeT * 0.7) * 0.22);

    if (this.elapsed * 1000 >= this.def.goal.value) {
      console.log(`[Mission 2] survived ${(this.elapsed).toFixed(1)}s`);
      this._completeFlag = true;
    }
  }
}

// =====================================================================
// Mission 3 — Crystal Caves (On-Foot Auto-Runner)
// =====================================================================
class OnFootMission extends Mission {
  constructor(g, def) {
    super(g, def);
    this.distance = 0;
    this.laneIdx = 1;
    this.targetX = 0;
    this.runnerY = 0;
    this.runnerVy = 0;
    this._lastObstacle = 0;
    this.obstacles = [];
  }
  enter() {
    super.enter();
    this.game._showShip(false);
    this.game._showRunners(true);
    // Reset runners pos
    this.game.runners.position.set(0, 0, 4);
    this.game.input.setMode('LANE_TAP', {
      onSwipe: (dir) => this._switchLane(dir),
      onTap:   ()    => this._jump(),
    });
    this.game.audio.speakSequence(STORY[this.def.key].voice, 350);
  }
  _switchLane(dir) {
    const lanes = this.def.runner.lanes;
    this.laneIdx = THREE.MathUtils.clamp(this.laneIdx + (dir > 0 ? 1 : -1), 0, lanes.length - 1);
    this.targetX = lanes[this.laneIdx];
    console.log(`[Mission 3] lane → ${this.laneIdx} (x=${this.targetX.toFixed(2)})`);
  }
  _jump() {
    if (this.runnerY > 0.05) return;
    this.runnerVy = this.def.runner.jumpV;
    this.game.audio.sfx('jump');
    this.game.particles.sparkle(this.game.runners.position.clone().setY(0.1),
      { count: 6, color: 0xa050ff, speed: 2, life: 0.4 });
    console.log('[Mission 3] jump');
  }
  tick(dt) {
    super.tick(dt);
    const g = this.game;
    const cfg = this.def.runner;

    // Forward auto-run (the "world" scrolls by; player Z is constant)
    this.distance += cfg.speed * dt;
    g._scrollGround(cfg.speed * dt);

    // Lane lerp
    g.runners.position.x += (this.targetX - g.runners.position.x) * Math.min(1, dt * 12);

    // Jump physics
    this.runnerVy -= cfg.gravity * dt;
    this.runnerY = Math.max(0, this.runnerY + this.runnerVy * dt);
    if (this.runnerY === 0 && this.runnerVy < 0) this.runnerVy = 0;
    g.runners.position.y = this.runnerY;

    // Obstacle spawner
    this._lastObstacle += dt * 1000;
    if (this._lastObstacle >= this.def.obstacleInterval) {
      this._lastObstacle = 0;
      g._spawnCaveObstacle(this);
    }

    // Move + collide obstacles
    for (let i = this.obstacles.length - 1; i >= 0; i--) {
      const o = this.obstacles[i];
      o.mesh.position.z += cfg.speed * dt;
      if (o.kind === 'crystal') {
        // bob + spin
        o.mesh.rotation.y += 3 * dt;
        o.mesh.position.y = 1.0 + Math.sin(performance.now() * 0.005 + o.mesh.position.x) * 0.20;
      }
      if (o.mesh.position.z > 8) {
        g.scene.remove(o.mesh);
        this.obstacles.splice(i, 1);
        continue;
      }
      const dx = Math.abs(o.mesh.position.x - g.runners.position.x);
      const dz = Math.abs(o.mesh.position.z - g.runners.position.z);
      if (dx < 1.0 && dz < 0.9) {
        if (o.kind === 'crystal') {
          const points = Math.round(25 * (g._scoreMultiplier || 1));
          g.score += points;
          g.particles.burst(o.mesh.position.clone(), { count: 14, color: 0xffd24c, speed: 5, life: 0.6 });
          g.particles.scorePopup(o.mesh.position.clone(), g.camera, g.canvas, `+${points}`, '#ffd24c');
          g.audio.sfx('pickup');
          g.scene.remove(o.mesh);
          this.obstacles.splice(i, 1);
          continue;
        }
        const isPit = o.kind === 'chasm';
        const isPuddle = o.kind === 'puddle';
        if ((isPit && this.runnerY < 1.2) || (isPuddle && this.runnerY < 0.4)) {
          g._onPlayerHit(o.kind);
          g.scene.remove(o.mesh);
          this.obstacles.splice(i, 1);
        }
      }
    }

    if (this.distance >= this.def.goal.value) {
      console.log(`[Mission 3] distance reached: ${this.distance.toFixed(0)}/${this.def.goal.value}`);
      this._completeFlag = true;
    }
  }
  exit() {
    super.exit();
    for (const o of this.obstacles) this.game.scene.remove(o.mesh);
    this.obstacles = [];
  }
}

// =====================================================================
// Mission 4 — Lord Grump Boss
// =====================================================================
class BossMission extends Mission {
  constructor(g, def) {
    super(g, def);
    this.boss = null;
    this.mergeOffered = false;
    this._lastFire = 0;
    this._lastBossFire = 0;
    this._lastSpiral = 0;
    this._lastEnemy = 0;
    this.kills = 0;
    this.bossPhase = 1;
    this.laser = null;          // active rotating laser (phase 4)
    this._laserAngle = 0;
  }
  enter() {
    super.enter();
    this.game.input.setMode('STEER');
    this.game._showShip(true);
    this.game._showRunners(false);
    this.game._spawnBoss(this, this.def.boss.hp);
    // Run intro cinematic; gameplay tick is paused via this._introUntil
    this.game._playBossIntro(this);
    this.game.audio.speakSequence(STORY[this.def.key].voice, 350);
  }
  tick(dt) {
    if (this._introUntil && performance.now() < this._introUntil) {
      // During intro the game is "alive" but no spawns/firing.
      this.elapsed += dt;
      this.game._updateShip(dt);
      this.game._updateBeams(this, dt);
      this.game._updateBossBullets(this, dt);
      return;
    }
    return this._tickFight(dt);
  }
  _tickFight(dt) {
    super.tick(dt);
    const g = this.game;
    g._updateShip(dt);

    // Light enemy waves alongside the boss
    this._lastEnemy += dt * 1000;
    if (this.def.enemy.interval > 0 && this._lastEnemy >= this.rampedInterval(this.def.enemy.interval)) {
      this._lastEnemy = 0;
      g._spawnEnemy(this);
    }

    this._lastFire += dt;
    if (this.def.shootingAllowed && this._lastFire > 0.18) {
      this._lastFire = 0;
      g._fireBeams(this);
    }

    g._updateBeams(this, dt);
    g._updateEntities(this, dt);
    g._updateBossBullets(this, dt);

    if (this.boss) {
      this.boss.sway = (this.boss.sway || 0) + dt;
      this.boss.mesh.position.x = Math.sin(this.boss.sway * 0.7) * 4;
      this.boss.mesh.position.y = 1.6 + Math.sin(this.boss.sway * 1.4) * 0.25;

      // ---- Phase escalation ----
      const hpRatio = this.boss.hp / this.boss.maxHp;
      const desiredPhase = hpRatio > 0.75 ? 1 : hpRatio > 0.50 ? 2 : hpRatio > 0.25 ? 3 : 4;
      if (desiredPhase !== this.bossPhase) {
        this.bossPhase = desiredPhase;
        g._onBossPhase(this, desiredPhase);
      }

      // ---- Attack patterns by phase ----
      const cadence = { 1: 1.40, 2: 1.05, 3: 0.85, 4: 0.65 }[this.bossPhase];
      this._lastBossFire += dt;
      if (this._lastBossFire > cadence) {
        this._lastBossFire = 0;
        g._bossAttack(this, this.bossPhase);
      }
      // Phase 3+ adds periodic spiral burst
      if (this.bossPhase >= 3) {
        this._lastSpiral += dt;
        if (this._lastSpiral > 4.0) {
          this._lastSpiral = 0;
          g._bossSpiralBurst(this);
        }
        // Dispatch homing drones every ~6s
        this._lastDrone = (this._lastDrone || 0) + dt;
        if (this._lastDrone > 6.0) {
          this._lastDrone = 0;
          g._spawnDrone(this);
          g._spawnDrone(this);
        }
      }
      // Phase 4 has rotating laser sweep
      if (this.bossPhase >= 4) {
        if (!this.laser) g._spawnBossLaser(this);
        if (this.laser) g._tickBossLaser(this, dt);
      }

      // Merge offer: boss < 50% AND resonance == 100% (player choice; not auto)
      if (!this.mergeOffered && this.boss.hp <= this.boss.maxHp * 0.5 && g.resonance >= 100) {
        this.mergeOffered = true;
        console.log('[Mission 4] merge OFFERED (resonance maxed at sub-50%)');
        g._enterMergeOverlay(this);
      }
    }

    g._checkBeamHits(this);
    g._checkPlayerHits(this);

    if (!this.boss) {
      // Clean up the laser when boss dies
      if (this.laser) { this.game.scene.remove(this.laser.mesh); this.laser = null; }
      this._completeFlag = true;
    }
  }
  exit() {
    super.exit();
    if (this.laser) { this.game.scene.remove(this.laser.mesh); this.laser = null; }
  }
}

// =====================================================================
// LevelManager (orchestrator)
// =====================================================================
const MISSION_CTORS = {
  FLYING_MODE:   FlyingMission,
  RE_ENTRY_MODE: ReEntryMission,
  ON_FOOT_MODE:  OnFootMission,
  BOSS_MODE:     BossMission,
};

export class LevelManager {
  constructor(game) {
    this.game = game;
    this.idx = -1;
    this.current = null;
  }

  start(idx = 0) {
    this.idx = idx;
    const baseDef = LEVELS[idx];
    if (!baseDef) { console.warn('[LevelManager] no mission at idx', idx); return; }
    const def = this.game._applyHardMode ? this.game._applyHardMode(baseDef) : baseDef;
    const Ctor = MISSION_CTORS[def.mode] || FlyingMission;
    this.current = new Ctor(this.game, def);
    if (def.music) this.game.audio.playMusic(def.music);
    this.current.enter();
  }

  tick(dt) {
    if (!this.current) return;
    this.current.tick(dt);
    if (this.current.isComplete())     this._advance();
    else if (this.current.isFailed())  this.game._enterGameOver();
  }

  _advance() {
    const completedDef = this.current.def;
    this.current.exit();
    this.game._onMissionComplete?.(completedDef);
    this.current = null;
    if (this.idx + 1 >= LEVELS.length) {
      this.game._enterVictory();
      return;
    }
    const nextIdx = this.idx + 1;
    if (this.game._playCutscene) {
      this.game._playCutscene(nextIdx, () => this.game._enterStory(nextIdx));
    } else {
      this.game._enterStory(nextIdx);
    }
  }

  exit() {
    if (this.current) this.current.exit();
    this.current = null;
    this.idx = -1;
  }
}
