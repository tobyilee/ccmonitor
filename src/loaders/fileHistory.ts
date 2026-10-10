import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './paths.js';

/**
 * Count unique files edited in a session from ~/.claude/file-history/<sid>/.
 * Entries look like "<hash>@v<N>"; deduplicating by hash gives the file count.
 */
export function loadEditedFilesCount(sessionId: string): number {
  const dir = join(CLAUDE_DIR, 'file-history', sessionId);
  if (!existsSync(dir)) return 0;
  try {
    const unique = new Set(readdirSync(dir).map(e => e.replace(/@v\d+$/, '')));
    return unique.size;
  } catch {
    return 0;
  }
}
