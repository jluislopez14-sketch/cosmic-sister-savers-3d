// Achievements.js — Game-event listener + persistent unlock list.
//
// Game.js calls `achievements.fire(eventName, payload)` from gameplay
// hotspots. Each achievement has a `match(state, event, payload)` predicate.
// On first match, we persist the unlock and fire a toast.

export const ACHIEVEMENTS = [
  {
    id: 'first_kill',
    label: 'First Strike',
    desc: 'Defeat your first Gloom-Borg',
    icon: '👾',
    match: (state, e) => e === 'kill' && state.totalKills === 1,
  },
  {
    id: 'combo_5',
    label: 'On Fire',
    desc: 'Hit a ×5 combo multiplier',
    icon: '🔥',
    match: (state, e, p) => e === 'combo' && p.mult >= 5,
  },
  {
    id: 'combo_50',
    label: 'Cosmic Streak',
    desc: 'Reach 50 consecutive kills',
    icon: '☄️',
    match: (state, e, p) => e === 'combo' && p.combo >= 50,
  },
  {
    id: 'shielded_hit',
    label: 'Bubble Wrap',
    desc: 'Take a hit while a shield is active',
    icon: '💧',
    match: (state, e) => e === 'shielded_hit',
  },
  {
    id: 'survive_perfect',
    label: 'Untouchable',
    desc: 'Clear a mission without losing a heart',
    icon: '✨',
    match: (state, e, p) => e === 'mission_complete' && p.lostLives === 0,
  },
  {
    id: 'merge',
    label: 'Family Reunion',
    desc: 'Activate the Duo-Drive Mech',
    icon: '⚡',
    match: (state, e) => e === 'merge',
  },
  {
    id: 'all_powerups',
    label: 'Smile Stash',
    desc: 'Collect all 4 power-up types in one run',
    icon: '🎁',
    match: (state) => state.powerupKinds && state.powerupKinds.size >= 4,
  },
  {
    id: 'win_easy',
    label: 'Universe Saved',
    desc: 'Defeat Lord Grump',
    icon: '🌟',
    match: (state, e) => e === 'victory',
  },
  {
    id: 'win_hard',
    label: 'Spicy Reunion',
    desc: 'Defeat Lord Grump on Hard Mode',
    icon: '🌶️',
    match: (state, e, p) => e === 'victory' && p.hard,
  },
  {
    id: 'score_5000',
    label: 'Score Showoff',
    desc: 'Finish a run with 5000+ score',
    icon: '💎',
    match: (state, e, p) => e === 'victory' && p.score >= 5000,
  },
];

export class AchievementsManager {
  constructor(save, onUnlock) {
    this.save = save;
    this.onUnlock = onUnlock || (() => {});
    this.runState = this._freshState();
  }

  _freshState() {
    return {
      totalKills: 0,
      powerupKinds: new Set(),
      lostLives: 0,
    };
  }

  resetRun() { this.runState = this._freshState(); }

  /** Emitted from Game.js. eventName: 'kill' | 'combo' | 'shielded_hit' |
      'mission_complete' | 'merge' | 'powerup' | 'victory' | 'damaged' */
  fire(eventName, payload = {}) {
    // Update accumulated state
    if (eventName === 'kill')         this.runState.totalKills += 1;
    if (eventName === 'powerup')      this.runState.powerupKinds.add(payload.kind);
    if (eventName === 'damaged')      this.runState.lostLives += 1;

    for (const a of ACHIEVEMENTS) {
      try {
        if (a.match(this.runState, eventName, payload)) {
          if (this.save.unlockAchievement(a.id)) {
            console.log(`[Achievement] 🏅 ${a.label}`);
            this.onUnlock(a);
          }
        }
      } catch (e) {
        console.warn('[Achievement] match error:', a.id, e);
      }
    }
  }

  /** Number unlocked / total. */
  progress() {
    const total = ACHIEVEMENTS.length;
    const unlocked = Object.keys(this.save.achievements || {}).length;
    return { unlocked, total };
  }

  /** Render the list as HTML for menus. */
  renderHTML() {
    const got = this.save.achievements || {};
    return ACHIEVEMENTS.map((a) => {
      const owned = !!got[a.id];
      return `<div class="ach-row" style="display:flex;gap:8px;align-items:center;opacity:${owned ? 1 : 0.45}">
        <span style="font-size:18px">${a.icon}</span>
        <span style="font-weight:800;font-size:12px;letter-spacing:0.5px;color:${owned ? '#ffe45e' : '#bbb'}">${a.label}</span>
        <span style="font-size:11px;color:#c5b3ff">${a.desc}</span>
      </div>`;
    }).join('');
  }
}
