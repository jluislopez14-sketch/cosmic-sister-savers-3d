// Entry point. Boots Three.js, the AssetManager, and the Game state machine.
//
// The build stamp below prints to the console — open DevTools and check it
// matches the "build NNN" line on the loading screen. If they differ, you
// have a stale cached bundle and need to hard-refresh (Ctrl/Cmd+Shift+R).

import { Game, ASSET_MANIFEST } from './Game.js';

const BUILD_ID = '1777737235';
console.log(`%c[main] Cosmic Sister Savers 3D — build ${BUILD_ID}`,
            'color:#ff66cc;font-weight:bold;font-size:14px');
console.log(`[main] ASSET_MANIFEST imported: ${ASSET_MANIFEST?.length ?? 'undefined'} entries`);
if (!ASSET_MANIFEST || ASSET_MANIFEST.length === 0) {
  console.error('[main] ASSET_MANIFEST is empty — abort. Game.js export broken?');
}

window.addEventListener('load', async () => {
  const canvas = document.getElementById('game-canvas');
  const game = new Game(canvas);
  await game.boot();
  game.start();
  window.__game = game;          // expose for debugging in DevTools
});
