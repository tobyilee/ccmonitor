import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './paths.js';
import { readTail } from './scratchpad.js';

export const HISTORY_FILE = join(CLAUDE_DIR, 'history.jsonl');

export interface LastPrompt {
  display: string;
  time: Date | null;
  project: string | null;
}

/** Parse history.jsonl text into the last typed prompt per sessionId. Malformed lines are skipped. */
export function parseHistory(text: string): Map<string, LastPrompt> {
  const out = new Map<string, LastPrompt>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d?.sessionId !== 'string' || typeof d?.display !== 'string') continue;
      out.set(d.sessionId, {
        display: d.display,
        time: typeof d.timestamp === 'number' ? new Date(d.timestamp) : null,
        project: typeof d.project === 'string' ? d.project : null,
      });
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Last typed prompt per session from `~/.claude/history.jsonl`. Only the tail
 * of the file is read (default 512 KB) so the refresh stays cheap.
 */
export function loadLastPrompts(path: string = HISTORY_FILE, tailBytes: number = 512 * 1024): Map<string, LastPrompt> {
  if (!existsSync(path)) return new Map();
  try {
    const size = statSync(path).size;
    let text = readTail(path, Math.min(size, tailBytes));
    // Drop a partial first line when we started mid-file.
    if (size > tailBytes) text = text.slice(text.indexOf('\n') + 1);
    return parseHistory(text);
  } catch {
    return new Map();
  }
}
