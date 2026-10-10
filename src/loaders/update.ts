import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './paths.js';

/** `.last-update-result.json`; override with CCMONITOR_UPDATE_FILE for testing. */
export const LAST_UPDATE_FILE = process.env.CCMONITOR_UPDATE_FILE || join(CLAUDE_DIR, '.last-update-result.json');
export const CHANGELOG_CACHE = join(CLAUDE_DIR, 'cache', 'changelog.md');

export interface LastUpdate {
  versionFrom: string | null;
  versionTo: string | null;
  outcome: string | null;
  at: Date | null;
}

export function loadLastUpdate(path: string = LAST_UPDATE_FILE): LastUpdate | null {
  if (!existsSync(path)) return null;
  try {
    const d = JSON.parse(readFileSync(path, 'utf-8'));
    const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return {
      versionFrom: s(d.version_from),
      versionTo: s(d.version_to),
      outcome: s(d.outcome) ?? s(d.status),
      at: s(d.timestamp) ? new Date(d.timestamp) : null,
    };
  } catch {
    return null;
  }
}

export interface ChangelogTop {
  version: string;
  bullets: string[];
}

/** First `## x.y.z` heading of a changelog and its first `n` bullets. */
export function parseChangelogTop(text: string, n: number = 5): ChangelogTop | null {
  const lines = text.split('\n');
  const headIdx = lines.findIndex(l => /^##\s+\d+\.\d+\.\d+/.test(l));
  if (headIdx === -1) return null;
  const version = /^##\s+(\d+\.\d+\.\d+)/.exec(lines[headIdx] ?? '')?.[1] ?? '';
  const bullets: string[] = [];
  for (const l of lines.slice(headIdx + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(l);
    if (m?.[1]) bullets.push(m[1]);
    if (bullets.length >= n) break;
  }
  return { version, bullets };
}

export function loadChangelogTop(path: string = CHANGELOG_CACHE, n: number = 5): ChangelogTop | null {
  if (!existsSync(path)) return null;
  try {
    return parseChangelogTop(readFileSync(path, 'utf-8'), n);
  } catch {
    return null;
  }
}
