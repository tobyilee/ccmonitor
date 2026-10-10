import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './paths.js';

export const FEEDBACK_DRAFTS_DIR = join(CLAUDE_DIR, 'feedback', 'drafts');

/** SendFeedback drafts whose `source_session_id` is this session. */
export function loadFeedbackDrafts(sessionId: string, dir: string = FEEDBACK_DRAFTS_DIR): Array<{ title: string; type: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ title: string; type: string }> = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (d?.source_session_id !== sessionId) continue;
        out.push({
          title: typeof d.title === 'string' ? d.title : f,
          type: typeof d.type === 'string' ? d.type : 'feedback',
        });
      } catch {
        // skip malformed draft
      }
    }
  } catch {
    return [];
  }
  return out;
}
