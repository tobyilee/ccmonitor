import type { GitStatusFile, GitStatusInfo } from '../types.js';

/** Re-run `git status` at most this often for one cwd. */
export const GIT_STATUS_TTL_MS = 5_000;
/** When the cwd is not a repository (or git is missing), do not retry for this long. */
const NOT_A_REPO_TTL_MS = 30_000;
const SYNC_TIMEOUT_MS = 2_000;
export const GIT_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall'] as const;

function classify(x: string, y: string): GitStatusFile['kind'] {
  if (x === '?' && y === '?') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  return 'modified';
}

/**
 * Parse `git status --porcelain=v1 -z` output. Each record is `XY <path>`; a
 * rename or copy (`R`/`C` in either column) is followed by the old path as a
 * second NUL-terminated field, which is dropped.
 */
export function parseGitStatus(text: string): GitStatusInfo {
  const files: GitStatusFile[] = [];
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i] ?? '';
    if (rec.length < 4) continue;
    const x = rec[0] ?? ' ';
    const y = rec[1] ?? ' ';
    const path = rec.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++; // skip the original path
    if (x === '!' && y === '!') continue; // ignored entries (not requested, but be safe)
    files.push({ code: `${x}${y}`, path, kind: classify(x, y) });
  }
  const info: GitStatusInfo = { added: 0, modified: 0, deleted: 0, files };
  for (const f of files) info[f.kind === 'added' ? 'added' : f.kind === 'deleted' ? 'deleted' : 'modified']++;
  return info;
}

interface CacheEntry {
  at: number;
  value: GitStatusInfo | null;
  pending: Promise<GitStatusInfo | null> | null;
}
const cache = new Map<string, CacheEntry>();

function runSync(cwd: string): GitStatusInfo | null {
  try {
    const r = Bun.spawnSync({ cmd: ['git', '-C', cwd, ...GIT_STATUS_ARGS], stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: SYNC_TIMEOUT_MS });
    if (r.exitCode !== 0) return null;
    return parseGitStatus(r.stdout.toString());
  } catch {
    return null;
  }
}

async function runAsync(cwd: string): Promise<GitStatusInfo | null> {
  try {
    const p = Bun.spawn({ cmd: ['git', '-C', cwd, ...GIT_STATUS_ARGS], stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const [out, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (exitCode !== 0) return null;
    return parseGitStatus(out);
  } catch {
    return null;
  }
}

function ttlFor(value: GitStatusInfo | null): number {
  return value === null ? NOT_A_REPO_TTL_MS : GIT_STATUS_TTL_MS;
}

/**
 * Working-tree status of `cwd`, cached for a few seconds. The first call for a
 * cwd runs `git status` synchronously (bounded by a timeout); later calls return
 * the cached value and, when it is stale, start one background refresh whose
 * result shows up on a following call. Returns null when `cwd` is not inside a
 * git repository or git cannot be run.
 */
export function loadGitStatus(cwd: string, nowMs = Date.now()): GitStatusInfo | null {
  const hit = cache.get(cwd);
  if (!hit) {
    const value = runSync(cwd);
    cache.set(cwd, { at: nowMs, value, pending: null });
    return value;
  }
  if (nowMs - hit.at >= ttlFor(hit.value) && !hit.pending) {
    hit.pending = runAsync(cwd).then(value => {
      hit.value = value;
      hit.at = Date.now();
      hit.pending = null;
      return value;
    });
  }
  return hit.value;
}

/** Force a refresh now and wait for it (tests, and `r`). */
export async function refreshGitStatus(cwd: string): Promise<GitStatusInfo | null> {
  const value = await runAsync(cwd);
  cache.set(cwd, { at: Date.now(), value, pending: null });
  return value;
}

/** Drop every cached entry (tests). */
export function clearGitStatusCache(): void {
  cache.clear();
}
