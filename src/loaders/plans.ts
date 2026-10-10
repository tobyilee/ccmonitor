import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './paths.js';

export interface PlanLoaderOptions {
  /** `~/.claude/settings.json` (read for `plansDirectory`). */
  settingsPath?: string;
  /** Default plans directory when the setting is absent. */
  defaultDir?: string;
}

/** Resolve the plans directory: `settings.plansDirectory` or `~/.claude/plans`. */
export function resolvePlansDir(opts: PlanLoaderOptions = {}): string {
  const settingsPath = opts.settingsPath ?? join(CLAUDE_DIR, 'settings.json');
  const fallback = opts.defaultDir ?? join(CLAUDE_DIR, 'plans');
  try {
    if (!existsSync(settingsPath)) return fallback;
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const dir = data?.plansDirectory;
    if (typeof dir === 'string' && dir) return dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  } catch {
    // fall through
  }
  return fallback;
}

/** `<plansDir>/<slug>.md` with its size, or null when the slug or file is absent. */
export function loadPlanFile(slug: string | null, opts: PlanLoaderOptions = {}): { path: string; bytes: number } | null {
  if (!slug) return null;
  const path = join(resolvePlansDir(opts), `${slug}.md`);
  try {
    if (!existsSync(path)) return null;
    return { path, bytes: statSync(path).size };
  } catch {
    return null;
  }
}
