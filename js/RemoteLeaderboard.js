// RemoteLeaderboard.js — Optional online sync for top scores.
//
// Disabled by default. To enable:
//   1. Deploy a small backend exposing two endpoints:
//        POST /api/leaderboard   { score, combo, hard, name? }  →  { rank, top: [...] }
//        GET  /api/leaderboard                                 →  { top: [{score, name, hard, date}] }
//   2. Set window.__remoteLeaderboardURL = 'https://your-deploy.vercel.app'
//      OR pass { baseUrl } when constructing.
//
// Vercel-friendly contract — works with a Fluid Compute function backed by
// Vercel KV or any KV-style store. Sample handler (Next.js Route Handler):
//
//     export async function POST(req) {
//       const { score, combo, hard } = await req.json();
//       // ...validate, store in Redis sorted set, return { rank, top }
//     }
//
// If no URL is provided, all calls resolve to null gracefully.

const DEFAULT_TIMEOUT_MS = 4000;

export class RemoteLeaderboard {
  constructor({ baseUrl = null } = {}) {
    this.baseUrl = baseUrl
      || (typeof window !== 'undefined' && window.__remoteLeaderboardURL)
      || null;
    this.lastFetch = null;
    this._cache = null;
  }

  get enabled() { return !!this.baseUrl; }

  async submit({ score, combo, hard }) {
    if (!this.enabled) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
      const r = await fetch(`${this.baseUrl}/api/leaderboard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ score, combo, hard, ts: Date.now() }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      console.log('[Remote] submit OK', data);
      return data;
    } catch (e) {
      console.warn('[Remote] submit failed:', e?.message || e);
      return null;
    }
  }

  async fetch() {
    if (!this.enabled) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
      const r = await fetch(`${this.baseUrl}/api/leaderboard`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this._cache = data;
      this.lastFetch = Date.now();
      return data;
    } catch (e) {
      console.warn('[Remote] fetch failed:', e?.message || e);
      return null;
    }
  }
}
