import { describe, expect, it } from 'vitest';
import { STYLES, composeSpec } from '../src/plane/loadout';
import { altimeterAngles, asiAngle, asiScale } from '../src/ui/instruments';

describe('instrument scales', () => {
  for (const st of STYLES) {
    it(`airspeed markings make sense for the ${st.id}`, () => {
      const sc = asiScale(composeSpec({ style: st.id, paint: 'sunflower', wheels: 'medium' }));
      // full-flap stall < clean stall < max flap speed < max cruise < never exceed < top of dial
      expect(sc.white[0]).toBeLessThan(sc.green[0]);
      expect(sc.green[0]).toBeLessThan(sc.white[1]);
      expect(sc.white[1]).toBeLessThan(sc.green[1]);
      expect(sc.green[1]).toBe(sc.yellow[0]);
      expect(sc.yellow[1]).toBe(sc.vne);
      expect(sc.vne).toBeLessThan(sc.max);
      const labels = sc.max / sc.step;
      expect(labels).toBeGreaterThanOrEqual(5);
      expect(labels).toBeLessThanOrEqual(8);
      expect(Number.isInteger(labels)).toBe(true);
    });
  }

  it('needles', () => {
    expect(asiAngle(0, 200)).toBeCloseTo(-Math.PI / 2);
    expect(asiAngle(200, 200)).toBeCloseTo(-Math.PI / 2 + (330 * Math.PI) / 180);
    expect(asiAngle(-5, 200)).toBeCloseTo(-Math.PI / 2);
    const a = altimeterAngles(1000);
    expect(a.hundreds).toBeCloseTo(-Math.PI / 2 + Math.PI * 2);
    expect(a.thousands).toBeCloseTo(-Math.PI / 2 + Math.PI * 0.2);
  });
});
