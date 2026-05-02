// SaveData.js — Persistent progress in localStorage.
//
// Single JSON object stored under the key "css3d.save". Schema-versioned so
// we can evolve fields without nuking existing saves.

const KEY = 'css3d.save';
const VERSION = 3;
const MAX_LEADERBOARD = 10;

const DEFAULTS = {
  version: VERSION,
  highScore: 0,
  bestCombo: 0,
  victories: 0,
  hardModeUnlocked: false,
  hardModePreferred: false,   // last toggle state on the menu
  muted: false,
  tutorialDone: false,
  scores: [],                  // [{ score, combo, hard, date }] desc by score, max 10
  achievements: {},            // { id: { unlockedAt: ISO } }
  shipVariant: 'default',      // 'default' | 'gold' | 'rainbow' | 'mech'
  smilePoints: 0,              // currency for permanent upgrades
  upgrades: {                  // permanent meta-progression purchases
    extraLife:        0,       // +1 starting life per level (max 3)
    longerShield:     0,       // +1.5s shield duration per level (max 3)
    widerBeam:        0,       // +2 beams in triple mode per level (max 2)
    slowerCombo:      0,       // +0.5s combo timeout per level (max 4)
    bonusMultiplier:  0,       // +0.25x score per level (max 4)
  },
};

// Catalog of upgrades — used both by the shop UI and by Game.js to apply effects.
export const UPGRADES = [
  { id: 'extraLife',       label: 'Extra Life',         desc: '+1 starting life',      max: 3, cost: (lvl) => 30 + lvl * 30 },
  { id: 'longerShield',    label: 'Tougher Shield',     desc: '+1.5s shield duration', max: 3, cost: (lvl) => 20 + lvl * 20 },
  { id: 'widerBeam',       label: 'Wider Beams',        desc: '+2 triple-beam shots',  max: 2, cost: (lvl) => 25 + lvl * 35 },
  { id: 'slowerCombo',     label: 'Persistent Combo',   desc: '+0.5s combo timeout',   max: 4, cost: (lvl) => 15 + lvl * 15 },
  { id: 'bonusMultiplier', label: 'Score Booster',      desc: '+25% score multiplier', max: 4, cost: (lvl) => 35 + lvl * 35 },
];

export class SaveData {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      if (parsed.version !== VERSION) return { ...DEFAULTS, ...parsed, version: VERSION };
      return { ...DEFAULTS, ...parsed };
    } catch (e) {
      console.warn('[SaveData] load failed, using defaults', e);
      return { ...DEFAULTS };
    }
  }

  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) { console.warn('[SaveData] save failed', e); }
  }

  // ---- Reads ----
  get highScore()        { return this.data.highScore; }
  get bestCombo()        { return this.data.bestCombo; }
  get victories()        { return this.data.victories; }
  get hardModeUnlocked() { return this.data.hardModeUnlocked; }
  get hardModePreferred(){ return this.data.hardModePreferred; }
  get muted()            { return this.data.muted; }
  get tutorialDone()     { return this.data.tutorialDone; }
  get scores()           { return this.data.scores || []; }
  get achievements()     { return this.data.achievements || {}; }
  get shipVariant()      { return this.data.shipVariant || 'default'; }
  get smilePoints()      { return this.data.smilePoints || 0; }
  get upgrades()         { return this.data.upgrades || {}; }
  upgradeLevel(id)       { return (this.data.upgrades || {})[id] || 0; }
  /** Available ship variants based on progression. */
  unlockedShipVariants() {
    const out = ['default'];
    if (this.data.highScore >= 1000) out.push('gold');
    if (this.data.highScore >= 5000) out.push('rainbow');
    if (this.data.victories >= 1 && this.data.hardModeUnlocked) out.push('mech');
    return out;
  }

  // ---- Writes ----
  /** Returns true if this score is a new high. */
  recordScore(score) {
    if (score > this.data.highScore) {
      this.data.highScore = score;
      this._save();
      return true;
    }
    return false;
  }

  recordCombo(combo) {
    if (combo > this.data.bestCombo) {
      this.data.bestCombo = combo;
      this._save();
      return true;
    }
    return false;
  }

  recordVictory() {
    this.data.victories += 1;
    if (!this.data.hardModeUnlocked) this.data.hardModeUnlocked = true;
    this._save();
    return this.data;
  }

  setHardModePreferred(flag) {
    this.data.hardModePreferred = !!flag;
    this._save();
  }

  setMuted(flag) {
    this.data.muted = !!flag;
    this._save();
  }

  setTutorialDone() {
    this.data.tutorialDone = true;
    this._save();
  }

  setShipVariant(name) {
    if (!this.unlockedShipVariants().includes(name)) return false;
    this.data.shipVariant = name;
    this._save();
    return true;
  }

  /** Add an entry. Returns the rank (1-based) if it landed in the top-N, else 0. */
  recordRunResult({ score, combo, hard, won }) {
    if (!won) return 0;
    const entry = { score, combo, hard: !!hard, date: new Date().toISOString() };
    const list = (this.data.scores || []).slice();
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    const trimmed = list.slice(0, MAX_LEADERBOARD);
    this.data.scores = trimmed;
    const rank = trimmed.findIndex((s) => s === entry) + 1;
    this._save();
    return rank;
  }

  /** Award smile points (1 per 100 points scored). Call at end of run. */
  awardSmilePoints(score) {
    const earned = Math.floor(score / 100);
    if (earned <= 0) return 0;
    this.data.smilePoints = (this.data.smilePoints || 0) + earned;
    this._save();
    return earned;
  }

  /** Try to purchase one level of an upgrade. Returns true on success. */
  buyUpgrade(catalogEntry) {
    const id = catalogEntry.id;
    const lvl = this.upgradeLevel(id);
    if (lvl >= catalogEntry.max) return false;
    const cost = catalogEntry.cost(lvl);
    if ((this.data.smilePoints || 0) < cost) return false;
    this.data.smilePoints -= cost;
    this.data.upgrades[id] = lvl + 1;
    this._save();
    return true;
  }

  unlockAchievement(id) {
    if (!this.data.achievements) this.data.achievements = {};
    if (this.data.achievements[id]) return false;     // already unlocked
    this.data.achievements[id] = { unlockedAt: new Date().toISOString() };
    this._save();
    return true;
  }

  /** For debug — wipe save. */
  reset() {
    this.data = { ...DEFAULTS };
    this._save();
  }
}
