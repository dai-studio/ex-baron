import { describe, expect, it } from 'vitest';
import { digitThrottle } from '../src/core/input';

describe('number-key throttle', () => {
  it('1 is idle and 0 is full power', () => {
    expect(digitThrottle(1)).toBe(0);
    expect(digitThrottle(0)).toBe(1);
  });

  it('rises in even steps from 1 through 9 to 0', () => {
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(digitThrottle);
    for (let i = 1; i < keys.length; i++) expect(keys[i] - keys[i - 1]).toBeCloseTo(1 / 9, 10);
  });
});
