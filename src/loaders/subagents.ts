import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { SessionState } from '../types.js';

/** Read `projects/<p>/<sid>/subagents/agent-*.meta.json`; 30 s idle ⇒ completed. */
export function loadSubagents(state: SessionState, nowMs: number = Date.now()): void {
  const subagentDir = join(state.projectDir, state.sessionId, 'subagents');
  if (!existsSync(subagentDir)) return;

  let files: string[];
  try { files = readdirSync(subagentDir); } catch { return; }
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(subagentDir, file), 'utf-8'));
      const agentId = file.replace('.meta.json', '').replace('agent-', '');
      const jsonlFile = join(subagentDir, file.replace('.meta.json', '.jsonl'));

      let status: 'running' | 'completed' | 'error' = 'running';
      let startTime = new Date(nowMs);
      let endTime: Date | undefined;

      if (existsSync(jsonlFile)) {
        const jsonlStat = statSync(jsonlFile);
        startTime = jsonlStat.birthtime;
        const lastModified = jsonlStat.mtime;
        if (nowMs - lastModified.getTime() > 30_000) {
          status = 'completed';
          endTime = lastModified;
        }
      }

      state.subagents.set(agentId, {
        id: agentId,
        type: meta.agentType || 'unknown',
        description: meta.description || '',
        status,
        startTime,
        endTime,
      });
    } catch {
      // Skip invalid meta files
    }
  }
}
