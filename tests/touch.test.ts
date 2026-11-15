import { describe, expect, it } from 'vitest';
import {
  BAIL_HOLD,
  MINI_TOP,
  MINI_TOUCH,
  TouchModel,
  hitTest,
  leverThrottle,
  stickCurve,
  tiltAngles,
  tiltAxes,
  touchLayout,
  type Circle,
  type Rect,
  type TouchLayout,
} from '../src/core/touch';
import type { Insets } from '../src/core/device';

/** Touch mapping unit test (design §9.3): pure layout + gesture → controls. */
const NONE: Insets = { l: 0, r: 0, t: 0, b: 0 };
const SCREENS: [string, number, number, Insets][] = [
  ['small phone', 667, 375, NONE],
  ['phone with notch', 844, 390, { l: 47, r: 47, t: 0, b: 21 }],
  ['tablet', 1180, 820, { l: 0, r: 0, t: 24, b: 20 }],
];

const circleRect = (c: Circle): Rect => ({ x: c.x - c.r, y: c.y - c.r, w: 2 * c.r, h: 2 * c.r });
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, l: TouchLayout) =>
  r.x >= l.safe.l - 0.01 && r.y >= l.safe.t - 0.01 && r.x + r.w <= l.w - l.safe.r + 0.01 && r.y + r.h <= l.h - l.safe.b + 0.01;

describe('touch layout', () => {
  for (const [name, w, h, safe] of SCREENS) {
    it(`controls fit, don't overlap and stay in the safe area on a ${name} (${w}×${h})`, () => {
      const l = touchLayout(w, h, safe);
      const rects: [string, Rect][] = [
        ['lever', l.lever],
        ...Object.entries(l.buttons).map(([k, c]) => [k, circleRect(c)] as [string, Rect]),
        ['stick', { x: l.stickRest.x - l.stickR, y: l.stickRest.y - l.stickR, w: 2 * l.stickR, h: 2 * l.stickR }],
      ];
      for (const [k, r] of rects) expect(inside(r, l), `${k} inside the safe area`).toBe(true);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i][1], rects[j][1]), `${rects[i][0]} vs ${rects[j][0]}`).toBe(false);
      // buttons are finger-sized (≥ 44 px across)
      for (const c of Object.values(l.buttons)) expect(2 * c.r).toBeGreaterThanOrEqual(36);
      expect(l.buttons.brake.r * 2).toBeGreaterThanOrEqual(56);
      // the lever sits below the minimap
      expect(l.lever.y).toBeGreaterThanOrEqual(safe.t + MINI_TOP + MINI_TOUCH);
      // room between the thumbs for the instrument cluster
      expect(l.rightEdge - l.leftEdge).toBeGreaterThan(w * 0.3);
    });
  }

  it('hit-tests every control at its centre', () => {
    const l = touchLayout(844, 390, NONE);
    for (const [k, c] of Object.entries(l.buttons)) expect(hitTest(l, c.x, c.y, true)).toBe(k);
    expect(hitTest(l, l.buttons.bail.x, l.buttons.bail.y, false)).not.toBe('bail');
    expect(hitTest(l, l.lever.x + l.lever.w / 2, l.lever.y + l.lever.h / 2, true)).toBe('lever');
    expect(hitTest(l, 200, 250, true)).toBe('stick');
    expect(hitTest(l, l.stickRest.x, l.stickRest.y, true)).toBe('stick');
  });
});

describe('stick', () => {
  it('has a dead zone, keeps the sign and reaches full deflection', () => {
    expect(stickCurve(0.03)).toBe(0);
    expect(stickCurve(-0.03)).toBe(0);
    expect(stickCurve(1)).toBeCloseTo(1);
    expect(stickCurve(-1)).toBeCloseTo(-1);
    expect(stickCurve(0.5)).toBeGreaterThan(0);
    expect(stickCurve(0.5)).toBeLessThan(0.5); // gentle around the centre
    expect(stickCurve(-0.5)).toBeCloseTo(-stickCurve(0.5));
  });

  it('floats where the thumb lands and clamps to the stick radius', () => {
    const m = new TouchModel(844, 390, NONE);
    const R = m.layout.stickR;
    expect(m.down(1, 150, 250, 0)).toBe('stick');
    m.move(1, 150 + R / 2, 250);
    expect(m.stick()).toMatchObject({ ox: 150, oy: 250, x: 0.5, y: 0 });
    m.move(1, 150, 250 + 3 * R); // drag far down = full pull
    const s = m.stick()!;
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(1);
    m.up(1);
    expect(m.stick()).toBeNull();
  });

  it('takes only one stick thumb at a time', () => {
    const m = new TouchModel(844, 390, NONE);
    m.down(1, 150, 250, 0);
    expect(m.down(2, 250, 300, 0)).toBeNull();
    m.move(2, 400, 300);
    expect(m.stick()!.x).toBe(0);
  });
});

describe('throttle lever', () => {
  it('maps top = full and bottom = idle', () => {
    const r: Rect = { x: 0, y: 100, w: 40, h: 200 };
    expect(leverThrottle(r, 100)).toBe(1);
    expect(leverThrottle(r, 300)).toBe(0);
    expect(leverThrottle(r, 200)).toBeCloseTo(0.5);
    expect(leverThrottle(r, 0)).toBe(1);
    expect(leverThrottle(r, 999)).toBe(0);
  });

  it('follows the finger, stays where it is left, and double-tap snaps to idle', () => {
    const m = new TouchModel(844, 390, NONE);
    const lv = m.layout.lever;
    const cx = lv.x + lv.w / 2;
    m.down(1, cx, lv.y + lv.h * 0.75, 0);
    expect(m.throttle).toBeCloseTo(0.25);
    expect(m.leverHeld).toBe(true);
    m.move(1, cx, lv.y);
    expect(m.throttle).toBe(1);
    m.up(1);
    expect(m.leverHeld).toBe(false);
    expect(m.throttle).toBe(1);
    // double tap
    m.down(2, cx, lv.y + 10, 5);
    m.up(2);
    m.down(3, cx, lv.y + 10, 5.2);
    expect(m.throttle).toBe(0);
    m.move(3, cx, lv.y); // dragging after the snap doesn't undo it
    expect(m.throttle).toBe(0);
    m.up(3);
    // slow taps are not a double tap
    m.down(4, cx, lv.y + lv.h / 2, 10);
    m.up(4);
    m.down(5, cx, lv.y + lv.h / 2, 11);
    expect(m.throttle).toBeCloseTo(0.5);
  });
});

describe('buttons and multi-touch', () => {
  it('stick, throttle and brake can all be held at once', () => {
    const m = new TouchModel(844, 390, NONE);
    const l = m.layout;
    m.down(1, 150, 250, 0);
    m.down(2, l.lever.x + 10, l.lever.y + 5, 0);
    m.down(3, l.buttons.brake.x, l.buttons.brake.y, 0);
    m.move(1, 150 - l.stickR, 250);
    expect(m.stick()!.x).toBeCloseTo(-1);
    expect(m.throttle).toBeGreaterThan(0.9);
    expect(m.brake).toBe(true);
    m.up(3);
    expect(m.brake).toBe(false);
    expect(m.leverHeld).toBe(true);
  });

  it('fires each button press once', () => {
    const m = new TouchModel(844, 390, NONE);
    const b = m.layout.buttons;
    m.down(1, b.flapsMore.x, b.flapsMore.y, 0);
    m.down(2, b.camera.x, b.camera.y, 0);
    expect([...m.take()].sort()).toEqual(['camera', 'flapsMore']);
    expect(m.take().size).toBe(0);
    m.up(1);
    m.down(1, b.flapsLess.x, b.flapsLess.y, 1);
    m.down(4, b.pause.x, b.pause.y, 1);
    expect([...m.take()].sort()).toEqual(['flapsLess', 'pause']);
  });

  it('bails out only after holding BAIL, and only while it is shown', () => {
    const m = new TouchModel(844, 390, NONE);
    const b = m.layout.buttons.bail;
    expect(m.down(1, b.x, b.y, 0)).not.toBe('bail'); // hidden on the ground
    m.cancelAll();
    m.bailShown = true;
    expect(m.down(1, b.x, b.y, 10)).toBe('bail');
    m.update(10 + BAIL_HOLD * 0.5);
    expect(m.bailProgress(10 + BAIL_HOLD * 0.5)).toBeCloseTo(0.5);
    expect(m.take().has('bail')).toBe(false);
    m.update(10 + BAIL_HOLD + 0.01);
    expect(m.take().has('bail')).toBe(true);
    m.update(10 + BAIL_HOLD + 0.5);
    expect(m.take().has('bail')).toBe(false); // once per hold
    // a short tap never bails
    m.up(1);
    m.down(2, b.x, b.y, 20);
    m.up(2);
    m.update(22);
    expect(m.take().has('bail')).toBe(false);
  });

  it('cancelAll releases everything', () => {
    const m = new TouchModel(844, 390, NONE);
    m.down(1, 150, 250, 0);
    m.down(2, m.layout.buttons.brake.x, m.layout.buttons.brake.y, 0);
    m.cancelAll();
    expect(m.active).toBe(false);
    expect(m.stick()).toBeNull();
    expect(m.brake).toBe(false);
  });
});

describe('tilt', () => {
  const deg = Math.PI / 180;
  it('is neutral at the captured attitude, in both landscape directions', () => {
    for (const angle of [90, 270]) {
      const n = tiltAngles(40, 0, angle);
      expect(tiltAxes(n, n)).toEqual({ x: 0, y: 0 });
    }
  });

  it('a 2° wobble is inside the dead zone, 25° is full', () => {
    const n = { roll: 0, pitch: 50 * deg };
    expect(tiltAxes({ roll: 2 * deg, pitch: 50 * deg }, n).x).toBe(0);
    expect(tiltAxes({ roll: 25 * deg, pitch: 50 * deg }, n).x).toBe(1);
    expect(tiltAxes({ roll: -40 * deg, pitch: 50 * deg }, n).x).toBe(-1);
    // leaning the top away = push = nose down (negative pitch input)
    expect(tiltAxes({ roll: 0, pitch: 80 * deg }, n).y).toBe(-1);
    expect(tiltAxes({ roll: 0, pitch: 40 * deg }, n).y).toBeGreaterThan(0);
  });

  it('right edge down = positive roll in either landscape direction', () => {
    // angle 90: device top on the left, so the right edge is the device bottom: raising the top (β > 0) lowers it.
    // angle 270: device top on the right: lowering the top (β < 0) lowers the right edge.
    expect(tiltAngles(20, 0, 90).roll).toBeCloseTo(20 * deg);
    expect(tiltAngles(-20, 0, 270).roll).toBeCloseTo(20 * deg);
    expect(tiltAngles(-20, 0, 90).roll).toBeCloseTo(-20 * deg);
    // held upright in landscape (screen vertical): level, screen not leaning back
    const up = tiltAngles(0, -90, 90);
    expect(up.roll).toBeCloseTo(0);
    expect(up.pitch).toBeCloseTo(0);
  });
});
