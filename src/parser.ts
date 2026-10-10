/**
 * Transcript parsing orchestration.
 *
 *   read bytes → parseTranscriptLines / TranscriptReader (pure, src/entry.ts)
 *              → enrichSessionState (disk loaders, src/loaders/*)
 *
 * `parseTranscriptLines` and `processEntry` never touch the file system, the
 * clock or other processes. Everything that does lives in `enrichSessionState`.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { SessionState, TranscriptEntry } from './types.js';
import { createParseSession, type ParseContext, type ParseSession } from './state.js';
import { compareVersions, processEntry } from './entry.js';
import { CLAUDE_DIR, cwdToProjectDirName, projectDirToRealCwd } from './loaders/paths.js';
import { loadSubagents } from './loaders/subagents.js';
import { loadTeams } from './loaders/teams.js';
import { loadTasks } from './loaders/tasks.js';
import { loadSkillHookState } from './loaders/skillHook.js';
import { readGitBranch } from './loaders/git.js';
import { loadEditedFilesCount } from './loaders/fileHistory.js';
import { loadActiveSessions } from './loaders/sessions.js';
import { loadMemoryInfo } from './loaders/memory.js';
import { loadEffortLevel } from './loaders/effort.js';
import { loadRateLimit } from './loaders/rateLimit.js';
import { loadProcessMemMb } from './loaders/process.js';
import { loadScratchpadTasks } from './loaders/scratchpad.js';
import { fileUnknownLogger } from './unknownFields.js';

export { extractRealUserPrompt, processEntry, compareVersions } from './entry.js';
export { cwdToProjectDirName, projectDirToRealCwd, CLAUDE_DIR } from './loaders/paths.js';
export { loadTeams } from './loaders/teams.js';
export type { ParseContext } from './state.js';

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/** Feed one raw JSONL line. Malformed lines are skipped. */
export function feedLine(session: ParseSession, line: string): void {
  if (!line.trim()) return;
  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  processEntry(session, entry);
}

/** Idempotent post-parse fix-ups that need the whole file. */
export function finalizeParse(state: SessionState): void {
  // If startTime was never set, use first activity
  if (state.startTime.getTime() === 0 && state.lastActivity.getTime() > 0) {
    state.startTime = state.lastActivity;
  }
}

/** Parse a whole transcript held in memory. Pure: no fs, no clock, no process. */
export function parseTranscriptLines(lines: string[], ctx: ParseContext): SessionState {
  const session = createParseSession(ctx);
  for (const line of lines) feedLine(session, line);
  finalizeParse(session.state);
  return session.state;
}

/** Map model string to its context window size in tokens. */
export function getModelContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('[1m]')) return 1_000_000;
  if (/opus-4-(?:[5-9]|\d{2,})/.test(m)) return 1_000_000;
  // Claude 5 family (opus/sonnet/haiku-5-x, fable, mythos): contexts above 900K observed.
  if (/-5-\d/.test(m) || m.includes('fable') || m.includes('mythos')) return 1_000_000;
  return 200_000;
}

/** Derived numbers computed from the parsed state (pure). */
export function computeDerived(state: SessionState): void {
  state.contextWindow = getModelContextWindow(state.model);
  state.contextPercent = state.contextTokens > 0
    ? Math.round((state.contextTokens / state.contextWindow) * 100)
    : 0;
  // Exact compaction count when compact_boundary exists; the >30% heuristic
  // only for transcripts written before compact_boundary existed.
  if (state.compactions.length > 0) {
    state.compactionCount = state.compactions.length;
  } else if (state.version === null || compareVersions(state.version, '2.1.280') < 0) {
    state.compactionCount = state.heuristicCompactionCount;
  } else {
    state.compactionCount = 0;
  }
  if (state.startTime.getTime() > 0 && state.lastActivity.getTime() > state.startTime.getTime()) {
    const totalTokens = state.tokenUsage.input + state.tokenUsage.output
      + state.tokenUsage.cacheWrite + state.tokenUsage.cacheRead;
    const elapsedMin = (state.lastActivity.getTime() - state.startTime.getTime()) / 60_000;
    state.tokenBurnRate = elapsedMin > 0 ? Math.round(totalTokens / elapsedMin) : 0;
  } else {
    state.tokenBurnRate = 0;
  }
}

// ---------------------------------------------------------------------------
// Enrichment (disk loaders)
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  /** Skip loaders that depend on live processes / network (fixture mode). */
  skipLive?: boolean;
  nowMs?: number;
}

/**
 * Run the disk loaders and return an enriched *copy* of the parsed state. The
 * parsed state stays untouched so the incremental reader can keep extending it.
 */
export function enrichSessionState(parsed: SessionState, opts: EnrichOptions = {}): SessionState {
  const nowMs = opts.nowMs ?? Date.now();
  const state: SessionState = {
    ...parsed,
    tasks: [...parsed.tasks],
    subagents: new Map(),
    skillHistory: [...parsed.skillHistory],
    backgroundTasks: new Map([...parsed.backgroundTasks].map(([k, v]) => [k, { ...v }])),
    recap: { ...parsed.recap },
    hooks: { ...parsed.hooks },
    links: { ...parsed.links },
  };

  loadSubagents(state, nowMs);
  state.teams = loadTeams().filter(t => state.sessionTeamNames.has(t.name));
  loadTasks(state);
  loadSkillHookState(state, nowMs);
  const realCwd = state.cwd ?? projectDirToRealCwd(state.projectDir);
  state.gitBranch = readGitBranch(realCwd) ?? state.gitBranch;
  state.editedFilesCount = loadEditedFilesCount(state.sessionId);
  state.memory = loadMemoryInfo(state.projectDir);
  state.effortLevel = state.effortLevel ?? loadEffortLevel(realCwd);
  loadScratchpadTasks(state.backgroundTasks);

  if (!opts.skipLive) {
    state.activeSessions = loadActiveSessions();
    state.rateLimit = loadRateLimit();
    const self = state.activeSessions.find(s => s.sessionId === state.sessionId);
    state.processMemMb = self ? loadProcessMemMb(self.pid) : 0;
  } else {
    state.activeSessions = [];
    state.rateLimit = null;
    state.processMemMb = 0;
  }

  computeDerived(state);
  return state;
}

// ---------------------------------------------------------------------------
// Incremental reader
// ---------------------------------------------------------------------------

const HEAD_BYTES = 64;

export interface RefreshResult {
  state: SessionState;
  fullReparse: boolean;
  bytesRead: number;
}

/**
 * Keeps a parse session for one transcript file and feeds it only new bytes
 * on each refresh. A shrunken file or a changed first 64 bytes (transcript GC
 * rewrite) triggers a full reparse. Set CCMONITOR_FULL_PARSE=1 to always
 * reparse from zero.
 */
export class TranscriptReader {
  readonly ctx: ParseContext;
  private session: ParseSession;
  private offset = 0;
  private headHash: string | null = null;
  private partial: Buffer = Buffer.alloc(0);
  private readonly forceFull: boolean;

  constructor(ctx: ParseContext, opts: { forceFull?: boolean } = {}) {
    this.ctx = ctx;
    this.session = createParseSession(ctx);
    this.forceFull = opts.forceFull ?? process.env.CCMONITOR_FULL_PARSE === '1';
  }

  /** The pure parsed state (not enriched). */
  get parsed(): SessionState {
    return this.session.state;
  }

  private reset(): void {
    this.session = createParseSession(this.ctx);
    this.offset = 0;
    this.headHash = null;
    this.partial = Buffer.alloc(0);
  }

  /** Read new bytes and feed complete lines. Returns whether a full reparse happened. */
  readNew(): { fullReparse: boolean; bytesRead: number } {
    const path = this.ctx.transcriptFile;
    if (!existsSync(path)) {
      const had = this.offset > 0;
      this.reset();
      return { fullReparse: had, bytesRead: 0 };
    }
    const size = statSync(path).size;
    let fullReparse = false;
    if (this.forceFull || size < this.offset || (this.offset > 0 && this.headHash !== null && readHead(path) !== this.headHash)) {
      this.reset();
      fullReparse = true;
    }
    if (size <= this.offset) {
      finalizeParse(this.session.state);
      return { fullReparse, bytesRead: 0 };
    }
    const len = size - this.offset;
    const fd = openSync(path, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(len);
      const n = readSync(fd, chunk, 0, len, this.offset);
      if (n < len) chunk = chunk.subarray(0, n);
    } finally {
      closeSync(fd);
    }
    if (this.offset === 0) this.headHash = hashHead(chunk.subarray(0, HEAD_BYTES));
    this.offset += chunk.length;

    const data = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl === -1) {
      this.partial = data;
    } else {
      const complete = data.subarray(0, lastNl).toString('utf-8');
      this.partial = Buffer.from(data.subarray(lastNl + 1));
      for (const line of complete.split('\n')) feedLine(this.session, line);
    }
    finalizeParse(this.session.state);
    return { fullReparse, bytesRead: chunk.length };
  }

  /** Read new bytes, then enrich. */
  refresh(opts: EnrichOptions = {}): RefreshResult {
    const r = this.readNew();
    return { state: enrichSessionState(this.session.state, opts), ...r };
  }
}

function hashHead(buf: Buffer): string {
  return buf.toString('base64');
}

function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return hashHead(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// One-shot parse and session lookup
// ---------------------------------------------------------------------------

export function makeContext(sessionId: string, projectDir: string, transcriptFile: string): ParseContext {
  return { sessionId, projectDir, transcriptFile, onUnknown: fileUnknownLogger(sessionId) };
}

/** Full read → parse → enrich. */
export function parseTranscript(
  sessionId: string,
  projectDir: string,
  transcriptFile: string,
  opts: EnrichOptions = {},
): SessionState {
  const ctx = makeContext(sessionId, projectDir, transcriptFile);
  const lines = existsSync(transcriptFile) ? readFileSync(transcriptFile, 'utf-8').split('\n') : [];
  const parsed = parseTranscriptLines(lines, ctx);
  return enrichSessionState(parsed, opts);
}

export interface SessionLocation {
  sessionId: string;
  projectDir: string;
  transcriptFile: string;
}

/** Locate a session by cwd + sessionId without parsing it. */
export function locateSessionByCwdAndId(cwd: string, sessionId: string): SessionLocation | null {
  const projectDir = join(CLAUDE_DIR, 'projects', cwdToProjectDirName(cwd));
  const transcriptFile = join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(transcriptFile)) return null;
  return { sessionId, projectDir, transcriptFile };
}

/** Locate a session by id across all project directories. */
export function locateSessionById(sessionId: string): SessionLocation | null {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const fullDir = join(projectsDir, dir);
    try {
      if (!statSync(fullDir).isDirectory()) continue;
    } catch { continue; }
    const transcriptFile = join(fullDir, `${sessionId}.jsonl`);
    if (existsSync(transcriptFile)) return { sessionId, projectDir: fullDir, transcriptFile };
  }
  return null;
}

/** Locate the most recently modified transcript, optionally scoped to one cwd. */
export function locateLatestSession(cwd?: string): SessionLocation | null {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) return null;

  let targetDir: string | null = null;
  let targetSessionId: string | null = null;
  let latestMtime = 0;

  const dirs = cwd
    ? [join(projectsDir, cwdToProjectDirName(cwd))]
    : readdirSync(projectsDir).map(d => join(projectsDir, d));

  for (const fullDir of dirs) {
    if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) continue;
    for (const file of readdirSync(fullDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = join(fullDir, file);
      const mtime = statSync(fullPath).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        targetDir = fullDir;
        targetSessionId = basename(file, '.jsonl');
      }
    }
  }
  if (!targetDir || !targetSessionId) return null;
  return { sessionId: targetSessionId, projectDir: targetDir, transcriptFile: join(targetDir, `${targetSessionId}.jsonl`) };
}

export function findSessionByCwdAndId(cwd: string, sessionId: string): SessionState | null {
  const loc = locateSessionByCwdAndId(cwd, sessionId);
  return loc ? parseTranscript(loc.sessionId, loc.projectDir, loc.transcriptFile) : null;
}

export function findLatestSession(cwd?: string): SessionState | null {
  const loc = locateLatestSession(cwd);
  return loc ? parseTranscript(loc.sessionId, loc.projectDir, loc.transcriptFile) : null;
}
