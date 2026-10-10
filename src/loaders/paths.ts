import { join, basename } from 'path';
import { homedir } from 'os';

/** Root of Claude Code's data directory. Overridable for tests via CCMONITOR_CLAUDE_DIR. */
export const CLAUDE_DIR = process.env.CCMONITOR_CLAUDE_DIR || join(homedir(), '.claude');

/**
 * Convert a CWD path to the Claude project directory name.
 * Claude Code replaces '/', '_', and '.' with '-',
 * e.g. /Users/foo_bar/.claude → -Users-foo-bar--claude
 */
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[/_.]/g, '-');
}

/**
 * Convert Claude's projectDir (e.g. ~/.claude/projects/-Users-foo-bar) back to
 * the real filesystem cwd (e.g. /Users/foo/bar). Lossy for `_` and `.`; only a
 * fallback for transcripts that lack the per-entry `cwd` field.
 */
export function projectDirToRealCwd(projectDir: string): string {
  return basename(projectDir).replace(/-/g, '/');
}
