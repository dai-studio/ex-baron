# Baron

A cartoon biplane game for the browser: take off, fly, dogfight and land over a procedurally generated world. It is built with TypeScript, three.js (WebGL 2) and Vite.

The design is in `design.dai`, the build plan in `plan.dai`, and the build log in `progress.dai`. Open them in DAI Studio.

https://baron.by.dai.studio

## Run

```sh
npm install
npm run dev      # http://localhost:5288
npm test         # vitest: world determinism + flight model
npm run build    # static build in dist/ (host on any CDN)
```

Add `?debug` to the URL to get a live flight-model tuning panel (lil-gui) and a stats overlay.

## Controls

| Action | Keys |
| --- | --- |
| Pitch | W / S or ↑ / ↓ (S pulls up) |
| Roll | A / D or ← / → |
| Rudder | Q / E |
| Throttle | Shift / Ctrl, or 1–9 and 0 (full) |
| Fire | Space |
| Brakes | B |
| Camera | C (chase / cockpit / padlock) |
| Mouse stick | M toggles, click to fire |
| Bail out | X |
| Pause / restart | Esc or P / R |
| Gamepad | Left stick to fly, right stick X for rudder and Y for throttle, RT to fire |

## Code map

| Folder | Contents | Design section |
| --- | --- | --- |
| `src/core` | fixed 120 Hz loop, input, settings and saves | §6 |
| `src/world` | seeded RNG and noise, terrain, biomes, airfields, chunk workers with LOD rings, props, clouds | §4 |
| `src/render` | toon material with rim light, inverted-hull outlines, depth-edge ink pass + FXAA, sky, water | §5 |
| `src/plane` | procedural biplane mesh, flight model, steering | §3 |
| `src/combat` | guns, hit zones, enemy AI pilots | §3 |
| `src/fx` | instanced cartoon particles, POW! bursts | §5 |
| `src/ui`, `src/audio` | canvas HUD and minimap, menus, synthesised Web Audio | §3 |
| `src/game` | game state machine (core loop §2), camera rig | §2, §6 |

All art and audio are generated in code. There are no external asset files.
