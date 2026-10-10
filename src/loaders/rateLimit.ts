import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { RateLimitInfo } from '../types.js';
import { CLAUDE_DIR } from './paths.js';

/** Local cache path for rate limit data fetched directly from the Anthropic API. */
const RATE_LIMIT_CACHE = join(CLAUDE_DIR, 'ccmonitor-usage-cache.json');
/** Cache TTL: 5 minutes. Avoids hitting the API on every 2-second refresh. */
const RATE_LIMIT_CACHE_TTL = 5 * 60 * 1000;

/**
 * Account-level rate limits: local 5-minute cache of the OAuth usage API,
 * falling back to abtop's file (~/.claude/abtop-rate-limits.json).
 */
export function loadRateLimit(): RateLimitInfo | null {
  return loadRateLimitFromCache() ?? loadRateLimitFromAbtop();
}

function loadRateLimitFromCache(): RateLimitInfo | null {
  const nowMs = Date.now();
  if (existsSync(RATE_LIMIT_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(RATE_LIMIT_CACHE, 'utf-8'));
      const cacheAge = nowMs - (cached.timestamp ?? 0);
      if (cacheAge < RATE_LIMIT_CACHE_TTL && cached.data) {
        return cachedDataToRateLimitInfo(cached);
      }
    } catch {
      // Cache corrupt — fall through to refresh
    }
  }
  return fetchAndCacheRateLimit();
}

/** OAuth access token from macOS Keychain via the `security` CLI (null elsewhere). */
function readOAuthToken(): string | null {
  try {
    const raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function fetchAndCacheRateLimit(): RateLimitInfo | null {
  const token = readOAuthToken();
  if (!token) return null;

  try {
    const raw = execFileSync('curl', [
      '-s', '--max-time', '5',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'anthropic-beta: oauth-2025-04-20',
      'https://api.anthropic.com/api/oauth/usage',
    ], { encoding: 'utf-8', timeout: 8000 });

    const resp = JSON.parse(raw);
    const toEpochSec = (iso: string | undefined | null): number | null => {
      if (!iso) return null;
      const ms = new Date(iso).getTime();
      return isNaN(ms) ? null : Math.floor(ms / 1000);
    };
    const pct = (v: unknown): number | null => (typeof v === 'number' ? Math.round(v) : null);

    const cached = {
      timestamp: Date.now(),
      data: {
        fiveHourPct: pct(resp.five_hour?.utilization),
        fiveHourResetsAt: toEpochSec(resp.five_hour?.resets_at),
        weeklyPct: pct(resp.seven_day?.utilization),
        weeklyResetsAt: toEpochSec(resp.seven_day?.resets_at),
        sonnetWeeklyPct: pct(resp.seven_day_sonnet?.utilization),
        opusWeeklyPct: pct(resp.seven_day_opus?.utilization),
      },
    };
    try {
      writeFileSync(RATE_LIMIT_CACHE, JSON.stringify(cached, null, 2));
    } catch { /* best effort */ }
    return cachedDataToRateLimitInfo(cached);
  } catch {
    return null;
  }
}

function cachedDataToRateLimitInfo(cached: { timestamp: number; data: Record<string, unknown> }): RateLimitInfo {
  const d = cached.data;
  const isStale = (Date.now() - cached.timestamp) > RATE_LIMIT_CACHE_TTL;
  const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    source: 'api',
    fiveHourPct: n(d.fiveHourPct),
    fiveHourResetsAt: n(d.fiveHourResetsAt),
    weeklyPct: n(d.weeklyPct),
    weeklyResetsAt: n(d.weeklyResetsAt),
    sonnetWeeklyPct: n(d.sonnetWeeklyPct),
    opusWeeklyPct: n(d.opusWeeklyPct),
    updatedAt: cached.timestamp,
    isStale,
  };
}

function loadRateLimitFromAbtop(): RateLimitInfo | null {
  const filePath = join(CLAUDE_DIR, 'abtop-rate-limits.json');
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const updatedAt = typeof data.updated_at === 'number' ? data.updated_at * 1000 : null;
    const isStale = updatedAt !== null ? (Date.now() - updatedAt) > 900_000 : true;
    return {
      source: 'abtop',
      fiveHourPct: data.five_hour?.used_percentage ?? null,
      fiveHourResetsAt: data.five_hour?.resets_at ?? null,
      weeklyPct: data.seven_day?.used_percentage ?? null,
      weeklyResetsAt: data.seven_day?.resets_at ?? null,
      sonnetWeeklyPct: null,
      opusWeeklyPct: null,
      updatedAt,
      isStale,
    };
  } catch {
    return null;
  }
}
