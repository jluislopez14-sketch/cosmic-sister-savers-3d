// CloudSync.js — Stub for save-state cloud sync.
//
// Sketch only — implement the backend before enabling.
//
// Design:
//   1. On first launch, mint an anonymous ID via Sign-in-with-Vercel
//      (or a simple `crypto.randomUUID()` fallback for now).
//   2. Persist ID + auth token in localStorage.
//   3. On save changes (debounced), POST the SaveData JSON to
//      `${baseUrl}/api/save` with the auth header.
//   4. On boot, GET the latest cloud save and merge with local state if
//      the cloud is newer (last-write-wins, keyed by data.lastModified).
//
// Backend contract (Next.js route or any framework):
//   POST /api/save  Authorization: Bearer <token>  body: SaveData JSON
//     → { ok: true, lastModified }
//   GET  /api/save  Authorization: Bearer <token>
//     → SaveData JSON (or 404 if user has no cloud save yet)
//
// Sign-in-with-Vercel handles the OAuth dance — see https://vercel.com/docs/sign-in-with-vercel
// You'll typically expose a /api/auth/session endpoint that proxies to it
// and sets an httpOnly cookie. The client-side code below assumes the
// token is already present in localStorage.

const STORAGE_KEY = 'css3d.cloudAuth';

export class CloudSync {
  constructor({ baseUrl = null } = {}) {
    this.baseUrl = baseUrl
      || (typeof window !== 'undefined' && window.__cloudSyncURL)
      || null;
    this.auth = this._loadAuth();
    this._debounceId = null;
  }

  get enabled() { return !!this.baseUrl && !!this.auth?.token; }
  get userId()  { return this.auth?.id || null; }

  _loadAuth() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }
  _saveAuth(a) {
    this.auth = a;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); }
    catch {}
  }

  /** Anonymous bootstrap — call once if no auth exists. Replace with real
      Sign-in-with-Vercel flow when you wire that up. */
  async bootstrapAnonymous() {
    if (this.auth?.token) return this.auth;
    if (!this.baseUrl) return null;
    try {
      const r = await fetch(`${this.baseUrl}/api/auth/anonymous`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this._saveAuth(data);
      return data;
    } catch (e) {
      // Fallback: client-side UUID, no real auth (dev only)
      const fake = { id: (crypto.randomUUID?.() || `local-${Math.random()}`), token: null };
      this._saveAuth(fake);
      return fake;
    }
  }

  /** Push the current SaveData snapshot. Debounced — safe to call often. */
  push(saveData) {
    if (!this.enabled) return;
    clearTimeout(this._debounceId);
    this._debounceId = setTimeout(() => this._sendNow(saveData), 800);
  }

  async _sendNow(saveData) {
    try {
      const body = JSON.stringify({ ...saveData.data, lastModified: Date.now() });
      const r = await fetch(`${this.baseUrl}/api/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.auth.token}`,
        },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { console.warn('[CloudSync] push failed:', e?.message || e); }
  }

  /** Pull the cloud save. Returns the parsed JSON or null. */
  async pull() {
    if (!this.enabled) return null;
    try {
      const r = await fetch(`${this.baseUrl}/api/save`, {
        headers: { 'authorization': `Bearer ${this.auth.token}` },
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { console.warn('[CloudSync] pull failed:', e?.message || e); return null; }
  }
}
