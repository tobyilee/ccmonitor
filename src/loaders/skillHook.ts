import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { SessionState } from '../types.js';
import { CLAUDE_DIR } from './paths.js';

/**
 * Optional fast path: the PostToolUse hook (`scripts/on-skill-complete.sh`)
 * writes ~/.claude/.omc/state/last-skill-complete.json when a Skill finishes.
 */
export function loadSkillHookState(state: SessionState, nowMs: number = Date.now()): void {
  const hookFile = join(CLAUDE_DIR, '.omc', 'state', 'last-skill-complete.json');
  if (!existsSync(hookFile)) return;

  try {
    const stat = statSync(hookFile);
    if (nowMs - stat.mtimeMs > 5 * 60 * 1000) return;

    const data = JSON.parse(readFileSync(hookFile, 'utf-8'));
    if (!data.skill || data.skill === 'unknown') return;

    const hookTime = new Date(data.completedAt || stat.mtime);
    if (!state.lastCompletedSkill || hookTime.getTime() > state.lastCompletedSkill.endTime.getTime()) {
      const completed = { name: data.skill, args: data.args ?? undefined, endTime: hookTime };
      state.lastCompletedSkill = completed;
      const head = state.skillHistory[0];
      if (!head || head.name !== completed.name || head.endTime.getTime() !== completed.endTime.getTime()) {
        state.skillHistory.unshift(completed);
        if (state.skillHistory.length > 5) state.skillHistory.length = 5;
      }
      if (state.activeSkill && state.activeSkill.name === data.skill) {
        state.activeSkill = null;
      }
    }
  } catch { /* skip */ }
}
