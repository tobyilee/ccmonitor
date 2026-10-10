import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import type { SessionState } from '../types.js';
import { CLAUDE_DIR } from './paths.js';

/** Merge `~/.claude/tasks/<sid>/*.json` into state.tasks (deduped by id). */
export function loadTasks(state: SessionState): void {
  const tasksDir = join(CLAUDE_DIR, 'tasks', state.sessionId);
  if (!existsSync(tasksDir)) return;

  try {
    const known = new Set(state.tasks.map(t => t.id));
    const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(tasksDir, file), 'utf-8'));
        const id: string = task.id || basename(file, '.json');
        if (task.subject && !known.has(id)) {
          known.add(id);
          state.tasks.push({ id, subject: task.subject, status: task.status || 'unknown' });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
