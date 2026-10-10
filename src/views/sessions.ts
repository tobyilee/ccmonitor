/**
 * Session picker rows (pure). The renderer lives in ui.ts.
 */
import type { AvailableSession, SessionState } from '../types.js';

export interface SessionRow {
  session: AvailableSession;
  isCurrent: boolean;
  label: string;
  cwdBase: string;
  lastPrompt: string | null;
  lastPromptTime: Date | null;
}

/** Rows sorted by registry `updatedAt` (newest first); the current session is marked. */
export function sessionRows(state: SessionState): SessionRow[] {
  const sorted = [...state.activeSessions].sort((a, b) => {
    const ua = a.updatedAt ?? a.startedAt.getTime();
    const ub = b.updatedAt ?? b.startedAt.getTime();
    return ub - ua;
  });
  return sorted.map(s => {
    const lp = state.sessionPrompts.get(s.sessionId) ?? null;
    return {
      session: s,
      isCurrent: s.sessionId === state.sessionId,
      label: s.name ?? (s.cwd.split('/').pop() || s.sessionId.slice(0, 8)),
      cwdBase: s.cwd.split('/').pop() || s.cwd,
      lastPrompt: lp?.display ?? null,
      lastPromptTime: lp?.time ?? null,
    };
  });
}
