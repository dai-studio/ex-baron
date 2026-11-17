import { afterEach, describe, expect, it } from 'vitest';
import { STYLES, composeSpec } from '../src/plane/loadout';
import { asiScale, vsiAngle, vsiMax } from '../src/ui/instruments';
import { altOf, fmtAltRounded, fmtDist, fmtRun, fmtSpeed, fmtVs, getUnits, setUnits, speedOf, vsOf, vsValue } from '../src/core/units';

afterEach(() => setUnits('metric'));

describe('display units', () => {
  it('metric is the default and reads as before', () => {
    expect(getUnits()).toBe('metric');
    expect(fmtSpeed(50)).toBe('180 km/h');
    expect(altOf(1000)).toBe(1000);
    expect(fmtVs(2.34)).toBe('2.3 m/s');
    expect(fmtDist(12_345)).toBe('12.3 km');
    expect(fmtAltRounded(1234)).toBe('1230 m');
    expect(fmtRun(347)).toBe('350 m');
  });

  it('imperial uses knots, feet, feet per minute and nautical miles', () => {
    setUnits('imperial');
    expect(speedOf(1852 / 3600)).toBeCloseTo(1, 10); // 1 knot
    expect(fmtSpeed(50)).toBe('97 kt');
    expect(altOf(0.3048)).toBeCloseTo(1, 10);
    expect(vsOf(0.3048 / 60)).toBeCloseTo(1, 10); // 1 ft/min
    expect(fmtVs(2.54)).toBe('500 ft/min');
    expect(fmtDist(1852 * 6.5)).toBe('6.5 nm');
    expect(fmtAltRounded(1000)).toBe('3300 ft');
    expect(fmtRun(300)).toBe('1000 ft');
  });

  for (const st of STYLES) {
    it(`knots airspeed dial is well labelled for the ${st.id}`, () => {
      const spec = composeSpec({ style: st.id, paint: 'sunflower', wheels: 'medium' });
      const kt = asiScale(spec, 'imperial');
      const kmh = asiScale(spec, 'metric');
      expect(kt.vne).toBeCloseTo(kmh.vne / 1.852, 6);
      expect(kt.vne).toBeLessThan(kt.max);
      const labels = kt.max / kt.step;
      expect(Number.isInteger(labels)).toBe(true);
      expect(labels).toBeGreaterThanOrEqual(5);
      expect(labels).toBeLessThanOrEqual(8);
    });
  }
});

describe('vertical speed', () => {
  it('signed values in both systems', () => {
    expect(vsValue(2.34, 'metric')).toBe('+2.3');
    expect(vsValue(-1, 'metric')).toBe('−1.0');
    expect(vsValue(0.01, 'metric')).toBe('0.0');
    expect(vsValue(2.54, 'imperial')).toBe('+500');
    expect(vsValue(-0.61, 'imperial')).toBe('−120');
  });

  it('VSI needle: level at 9 o\'clock, climb up, sink down, pinned at full scale', () => {
    const max = vsiMax('metric');
    expect(vsiAngle(0, max)).toBeCloseTo(Math.PI);
    expect(vsiAngle(5, max)).toBeGreaterThan(Math.PI); // toward 12 o'clock
    expect(vsiAngle(-5, max)).toBeLessThan(Math.PI); // toward 6 o'clock
    expect(vsiAngle(99, max)).toBeCloseTo(Math.PI + (160 * Math.PI) / 180);
    expect(vsiAngle(-99, max)).toBeCloseTo(Math.PI - (160 * Math.PI) / 180);
    expect(vsiMax('imperial')).toBe(2000);
  });
});
