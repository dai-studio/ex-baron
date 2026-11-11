import { Game } from './game/game';

/** Entry point: WebGL 2 feature check (design §5 "Context loss & fallback"), then boot. */
function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLCanvasElement;

if (!hasWebGL2()) {
  document.getElementById('title')?.classList.add('hidden');
  document.getElementById('nogl')?.classList.remove('hidden');
} else {
  const game = new Game(canvas, hud);
  game.start();
}
