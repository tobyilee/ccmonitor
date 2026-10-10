import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './paths.js';

/**
 * Resolve the reasoning effort from the settings cascade (most specific wins):
 *   <cwd>/.claude/settings.local.json → <cwd>/.claude/settings.json → ~/.claude/settings.json
 * Only a fallback for transcripts that lack the per-entry `effort` field.
 */
export function loadEffortLevel(cwdPath: string): string | null {
  const candidates = [
    join(cwdPath, '.claude', 'settings.local.json'),
    join(cwdPath, '.claude', 'settings.json'),
    join(CLAUDE_DIR, 'settings.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof data.effortLevel === 'string' && data.effortLevel) return data.effortLevel;
    } catch {
      // Skip malformed JSON and continue the cascade
    }
  }
  return null;
}
