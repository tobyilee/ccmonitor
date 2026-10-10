import { appendFileSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './loaders/paths.js';

export const UNKNOWN_FIELDS_LOG = join(CLAUDE_DIR, 'ccmonitor-unknown-fields.log');

/**
 * Build an onUnknown callback that appends one JSON line per unknown value to
 * ~/.claude/ccmonitor-unknown-fields.log. De-duplication per run is done by
 * the parser (once per value per session).
 */
export function fileUnknownLogger(sessionId: string): (kind: string, value: string) => void {
  return (kind, value) => {
    try {
      appendFileSync(
        UNKNOWN_FIELDS_LOG,
        JSON.stringify({ when: new Date().toISOString(), sessionId, kind, value }) + '\n',
      );
    } catch {
      // best effort
    }
  };
}
