import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CostInfo } from '../types.js';

/** Default location of Claude Code's global config (`~/.claude.json`). */
export const GLOBAL_CONFIG = process.env.CCMONITOR_CLAUDE_JSON || join(homedir(), '.claude.json');

/**
 * Cost of the previous session for a cwd, from `~/.claude.json` →
 * `projects[cwd].lastCost` and friends. Tagged `isPrevious: true` so the UI
 * can label it "(prev session)". Null when the project or the field is absent.
 */
export function loadPreviousCost(cwd: string, configPath: string = GLOBAL_CONFIG): CostInfo | null {
  if (!existsSync(configPath)) return null;
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    const project = data?.projects?.[cwd];
    if (!project || typeof project.lastCost !== 'number') return null;
    const perModel: Record<string, number> = {};
    const usage = project.lastModelUsage;
    if (usage && typeof usage === 'object') {
      for (const [model, u] of Object.entries(usage as Record<string, { costUSD?: unknown }>)) {
        perModel[model] = typeof u?.costUSD === 'number' ? u.costUSD : 0;
      }
    }
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      totalUSD: project.lastCost,
      apiDurationMs: n(project.lastAPIDuration),
      toolDurationMs: n(project.lastToolDuration),
      linesAdded: n(project.lastLinesAdded),
      linesRemoved: n(project.lastLinesRemoved),
      perModel,
      hasUnknownModelCost: false,
      isPrevious: true,
    };
  } catch {
    return null;
  }
}
