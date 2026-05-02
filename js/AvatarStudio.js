// AvatarStudio.js — In-game avatar creation: photo → Hyper3D Rodin → GLB.
//
// Stub — wires up the UI flow client-side. The actual Rodin call MUST go
// through a server endpoint so your API key never reaches the browser.
//
// Backend (Next.js example):
//   POST /api/avatar
//     body: multipart/form-data with `photo` file (or JSON with `imageUrl`)
//     server: forwards to https://hyperhuman.deemos.com/api/v2/rodin
//             with HYPER3D_API_KEY (env var, set via `vercel env add`)
//             returns { task_uuid, subscription_key }
//
//   GET  /api/avatar/:task_uuid/status
//     server: polls /api/v2/status, returns { status: 'Done'|'Pending'|'Failed' }
//
//   GET  /api/avatar/:task_uuid/glb
//     server: proxies the GLB binary back to the client
//
// Once a GLB returns, hand it to AssetLoader as a runtime asset:
//   const url = '/api/avatar/<uuid>/glb';
//   await game.assetLoader._loadOne('custom_alaia', url);
//   game.refreshAvatars();

export class AvatarStudio {
  constructor({ baseUrl = null, onProgress = () => {}, onResult = () => {} } = {}) {
    this.baseUrl = baseUrl
      || (typeof window !== 'undefined' && window.__avatarStudioURL)
      || null;
    this.onProgress = onProgress;
    this.onResult = onResult;
  }

  get enabled() { return !!this.baseUrl; }

  /** Submit a File (from <input type="file"> change event). */
  async submit(file, slot /* 'alaia'|'lisabel'|'jose'|'mom' */) {
    if (!this.enabled) {
      console.warn('[Avatar] not configured');
      return null;
    }
    const fd = new FormData();
    fd.append('photo', file);
    fd.append('slot', slot);
    this.onProgress({ phase: 'upload', pct: 0 });
    let job;
    try {
      const r = await fetch(`${this.baseUrl}/api/avatar`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      job = await r.json();
    } catch (e) {
      this.onProgress({ phase: 'error', error: e?.message || String(e) });
      return null;
    }
    return this._poll(job, slot);
  }

  async _poll(job, slot) {
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {  // 5 min timeout
      try {
        const r = await fetch(`${this.baseUrl}/api/avatar/${job.task_uuid}/status`);
        const data = await r.json();
        this.onProgress({ phase: 'render', status: data.status, elapsed: Date.now() - start });
        if (data.status === 'Done')   { this.onResult({ slot, glbUrl: `${this.baseUrl}/api/avatar/${job.task_uuid}/glb` }); return data; }
        if (data.status === 'Failed') { this.onProgress({ phase: 'error', error: 'Rodin failed' }); return null; }
      } catch (e) { /* network blip — keep polling */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
    this.onProgress({ phase: 'error', error: 'timeout' });
    return null;
  }
}

/* Example UI integration (drop into menu):

  const studio = new AvatarStudio({ onProgress: console.log });
  document.querySelector('#avatar-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const slot = document.querySelector('#avatar-slot').value;  // 'alaia' etc.
    await studio.submit(file, slot);
    // On result: hot-swap the GLB asset and rebuild the player ship companions.
  });
*/
