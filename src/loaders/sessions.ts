import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { AvailableSession } from '../types.js';
import { CLAUDE_DIR, cwdToProjectDirName } from './paths.js';

/** Check if a process is alive by sending signal 0. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the sessionId of the most recently modified transcript for a cwd. More
 * reliable than the registry, whose sessionId can go stale after /clear.
 */
export function resolveLatestSessionId(cwd: string, projectsRoot: string = join(CLAUDE_DIR, 'projects')): string | null {
  const projectDir = join(projectsRoot, cwdToProjectDirName(cwd));
  if (!existsSync(projectDir)) return null;
  try {
    let latestMtime = 0;
    let latestId: string | null = null;
    for (const file of readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const mtime = statSync(join(projectDir, file)).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestId = file.replace('.jsonl', '');
      }
    }
    return latestId;
  } catch {
    return null;
  }
}

/** Parse one registry file's JSON into an AvailableSession (no liveness check). */
export function parseRegistryEntry(data: Record<string, unknown>): AvailableSession | null {
  if (typeof data.pid !== 'number') return null;
  const s = (k: string): string | null => (typeof data[k] === 'string' && data[k] ? data[k] as string : null);
  return {
    pid: data.pid,
    sessionId: s('sessionId') ?? '',
    cwd: s('cwd') ?? '',
    startedAt: new Date(typeof data.startedAt === 'number' ? data.startedAt : 0),
    name: s('name'),
    status: s('status'),
    version: s('version'),
    kind: s('kind'),
    entrypoint: s('entrypoint'),
    hostSessionId: s('hostSessionId'),
    nameSource: s('nameSource'),
    statusUpdatedAt: typeof data.statusUpdatedAt === 'number' ? data.statusUpdatedAt : null,
    messagingSocketPath: s('messagingSocketPath'),
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
  };
}

export interface LoadSessionsOptions {
  sessionsDir?: string;
  projectsRoot?: string;
  isAlive?: (pid: number) => boolean;
}

/**
 * Live Claude Code sessions from ~/.claude/sessions/<pid>.json, filtered by
 * PID liveness, newest first. `.key` files are never read.
 */
export function loadActiveSessions(opts: LoadSessionsOptions = {}): AvailableSession[] {
  const sessionsDir = opts.sessionsDir ?? join(CLAUDE_DIR, 'sessions');
  const isAlive = opts.isAlive ?? isProcessAlive;
  if (!existsSync(sessionsDir)) return [];
  try {
    const alive: AvailableSession[] = [];
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
        const parsed = parseRegistryEntry(data);
        if (!parsed || !isAlive(parsed.pid)) continue;
        // The registry sessionId goes stale after /clear; prefer the newest transcript.
        const resolved = parsed.cwd ? resolveLatestSessionId(parsed.cwd, opts.projectsRoot) : null;
        if (resolved) parsed.sessionId = resolved;
        alive.push(parsed);
      } catch {
        // Skip malformed or unreadable entries
      }
    }
    alive.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return alive;
  } catch {
    return [];
  }
}
