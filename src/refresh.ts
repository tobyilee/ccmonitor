/** Auto-refresh interval: 2 s by default, ↑/↓ on the dashboard change it in 1 s steps. */
export const REFRESH_DEFAULT_MS = 2000;
export const REFRESH_MIN_MS = 2000;
export const REFRESH_MAX_MS = 60_000;
export const REFRESH_STEP_MS = 1000;

/** Next interval after one ↑ (+1) or ↓ (-1), clamped to [min, max]. */
export function stepRefreshMs(ms: number, dir: 1 | -1): number {
  return Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, ms + dir * REFRESH_STEP_MS));
}
