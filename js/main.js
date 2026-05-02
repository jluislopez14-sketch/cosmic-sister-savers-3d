// Entry point. Boots Three.js, the AssetManager, and the Game state machine.
import { Game } from './Game.js';

window.addEventListener('load', async () => {
  const canvas = document.getElementById('game-canvas');
  const game = new Game(canvas);
  await game.boot();
  game.start();
  // Expose for debugging.
  window.__game = game;
});
