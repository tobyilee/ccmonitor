import { describe, expect, test } from 'bun:test';
import { REFRESH_DEFAULT_MS, REFRESH_MAX_MS, REFRESH_MIN_MS, stepRefreshMs } from './refresh.js';

describe('stepRefreshMs', () => {
  test('default is the minimum, 2 s', () => {
    expect(REFRESH_DEFAULT_MS).toBe(2000);
    expect(REFRESH_MIN_MS).toBe(2000);
  });

  test('up adds one second, down removes one', () => {
    expect(stepRefreshMs(2000, 1)).toBe(3000);
    expect(stepRefreshMs(5000, -1)).toBe(4000);
  });

  test('never goes below 2 s', () => {
    expect(stepRefreshMs(2000, -1)).toBe(2000);
    expect(stepRefreshMs(2500, -1)).toBe(2000);
  });

  test('never goes above the maximum', () => {
    expect(stepRefreshMs(REFRESH_MAX_MS, 1)).toBe(REFRESH_MAX_MS);
  });
});
