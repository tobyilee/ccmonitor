import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import type { SessionState, TeamInfo, TranscriptEntry, MemoryInfo, RateLimitInfo, ToolDuration } from './types.js';

const CLAUDE_DIR = join(homedir(), '.claude');

/**
 * Convert a CWD path to the Claude project directory name.
 * Claude Code replaces '/', '_', and '.' with '-',
 * e.g. /Users/foo_bar/.claude → -Users-foo-bar--claude
 */
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[/_.]/g, '-');
}

/**
 * Load a specific session by its cwd + sessionId. Used by the session switcher
 * to view any of the live sessions discovered via loadActiveSessions.
 *
 * Returns null if the transcript file doesn't exist (e.g. session hasn't
 * written to disk yet, or the sessionId is wrong).
 */
export function findSessionByCwdAndId(cwd: string, sessionId: string): SessionState | null {
  const projectDir = join(CLAUDE_DIR, 'projects', cwdToProjectDirName(cwd));
  const transcriptFile = join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(transcriptFile)) return null;
  return parseTranscript(sessionId, projectDir, transcriptFile);
}

export function findLatestSession(cwd?: string): SessionState | null {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) return null;

  let targetDir: string | null = null;
  let targetSessionId: string | null = null;
  let latestMtime = 0;

  // If a cwd is provided, scope to that project's directory only
  const dirs = cwd
    ? [join(projectsDir, cwdToProjectDirName(cwd))]
    : readdirSync(projectsDir).map(d => join(projectsDir, d));

  for (const fullDir of dirs) {
    if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) continue;

    const files = readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
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

  const transcriptFile = join(targetDir, `${targetSessionId}.jsonl`);
  return parseTranscript(targetSessionId, targetDir, transcriptFile);
}

/** Map model string to its context window size in tokens. */
function getModelContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('[1m]')) return 1_000_000;
  if (/opus-4-(?:[5-9]|\d{2,})/.test(m)) return 1_000_000;
  if (m.includes('opus')) return 200_000;
  if (m.includes('sonnet')) return 200_000;
  if (m.includes('haiku')) return 200_000;
  return 200_000;
}

export function parseTranscript(
  sessionId: string,
  projectDir: string,
  transcriptFile: string,
): SessionState {
  const state: SessionState = {
    sessionId,
    projectDir,
    transcriptFile,
    startTime: new Date(0),
    toolStats: new Map(),
    skills: new Map(),
    activeSkill: null,
    lastCompletedSkill: null,
    skillHistory: [],
    completedSkillIds: new Set(),
    subagents: new Map(),
    teams: [],
    tasks: [],
    tokenUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    contextTokens: 0,
    messageCount: { user: 0, assistant: 0, system: 0 },
    recentFiles: [],
    sessionTeamNames: new Set(),
    lastActivity: new Date(0),
    model: 'unknown',
    lastUserPrompt: null,
    lastUserPromptTime: null,
    gitBranch: null,
    editedFilesCount: 0,
    activeSessions: [],
    memory: null,
    effortLevel: null,
    contextWindow: 200_000,
    contextPercent: 0,
    compactionCount: 0,
    maxContextTokens: 0,
    tokenHistory: [],
    tokenBurnRate: 0,
    rateLimit: null,
    toolDurations: new Map(),
    processMemMb: 0,
  };

  if (!existsSync(transcriptFile)) return state;

  const content = readFileSync(transcriptFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  // Track pending tool_use calls: id → { name, timestamp } for duration calculation
  const pendingTools = new Map<string, { name: string; time: Date }>();

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      processEntry(state, entry, pendingTools);
    } catch {
      // Skip malformed lines
    }
  }

  // If startTime was never set (no permission-mode entry), use first activity
  if (state.startTime.getTime() === 0 && state.lastActivity.getTime() > 0) {
    state.startTime = state.lastActivity;
  }

  // Load subagents
  loadSubagents(state);
  // Load teams (only those referenced in this session's transcript)
  state.teams = loadTeams().filter(
    t => state.sessionTeamNames.has(t.name),
  );
  // Load tasks
  loadTasks(state);
  // Check PostToolUse hook state file for faster skill completion detection
  loadSkillHookState(state);
  // Read git branch from the project cwd (derived from Claude's projectDir convention)
  state.gitBranch = readGitBranch(projectDirToRealCwd(projectDir));
  // Count unique files edited in this session (from file-history backups)
  loadEditedFilesCount(state);
  // Count live Claude Code sessions across all terminals/projects
  loadActiveSessions(state);
  // Read auto-memory state for this project
  loadMemoryInfo(state);
  // Read current reasoning effort level from the settings cascade
  state.effortLevel = loadEffortLevel(projectDirToRealCwd(projectDir));

  // Load account-level rate limit data (from abtop's StatusLine hook)
  state.rateLimit = loadRateLimit();
  // Load process memory for the current session's PID
  loadProcessInfo(state);

  // Derive context window from model, then calculate context percent and burn rate
  state.contextWindow = getModelContextWindow(state.model);
  state.contextPercent = state.contextTokens > 0
    ? Math.round((state.contextTokens / state.contextWindow) * 100)
    : 0;
  // Token burn rate: average tokens per minute across session lifetime
  if (state.startTime.getTime() > 0 && state.lastActivity.getTime() > state.startTime.getTime()) {
    const totalTokens = state.tokenUsage.input + state.tokenUsage.output
      + state.tokenUsage.cacheWrite + state.tokenUsage.cacheRead;
    const elapsedMin = (state.lastActivity.getTime() - state.startTime.getTime()) / 60_000;
    state.tokenBurnRate = elapsedMin > 0 ? Math.round(totalTokens / elapsedMin) : 0;
  }

  return state;
}

/**
 * Resolve the current Claude Code reasoning effort setting. Claude Code loads
 * settings in this precedence (most-specific wins):
 *   1. <cwd>/.claude/settings.local.json
 *   2. <cwd>/.claude/settings.json
 *   3. ~/.claude/settings.json
 *
 * We walk the same order and return the first `effortLevel` we find. This
 * mirrors what the live session is actually using so the monitor never
 * disagrees with reality when a project overrides the global default.
 */
function loadEffortLevel(cwdPath: string): string | null {
  const candidates = [
    join(cwdPath, '.claude', 'settings.local.json'),
    join(cwdPath, '.claude', 'settings.json'),
    join(CLAUDE_DIR, 'settings.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof data.effortLevel === 'string' && data.effortLevel) {
        return data.effortLevel;
      }
    } catch {
      // Skip malformed JSON and continue the cascade
    }
  }
  return null;
}

/**
 * Count unique files edited in this session by reading ~/.claude/file-history/<sessionId>/.
 * Each edit creates a file like "<hash>@v<N>" — multiple versions of the same file share
 * the hash prefix, so deduplicating by hash gives the actual unique file count.
 */
function loadEditedFilesCount(state: SessionState): void {
  const dir = join(CLAUDE_DIR, 'file-history', state.sessionId);
  if (!existsSync(dir)) {
    state.editedFilesCount = 0;
    return;
  }
  try {
    const entries = readdirSync(dir);
    // Strip the "@vN" version suffix to deduplicate multiple edits of the same file
    const unique = new Set(entries.map((e: string) => e.replace(/@v\d+$/, '')));
    state.editedFilesCount = unique.size;
  } catch {
    state.editedFilesCount = 0;
  }
}

/**
 * Check if a process is currently alive by sending signal 0 (no-op).
 * Returns false on ESRCH (no such process) or any other error.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count currently-alive Claude Code processes across all terminals.
 *
 * Reads each ~/.claude/sessions/<pid>.json registry entry, parses the
 * embedded `pid` field, and verifies liveness with signal 0. Stale entries
 * (from crashed processes) are ignored.
 */
/**
 * Read auto-memory state for this project from projects/<cwd>/memory/.
 *
 * The auto-memory system stores:
 *   - MEMORY.md — index file (topic pointers)
 *   - <category>_<name>.md — individual topic files, organized by category prefix
 *     (e.g. feedback_naming.md, project_structure.md, user_preferences.md)
 *
 * Subdirectories (team/, logs/) are skipped — we only count flat topic files.
 */
function loadMemoryInfo(state: SessionState): void {
  const memDir = join(state.projectDir, 'memory');
  if (!existsSync(memDir)) {
    state.memory = null;
    return;
  }
  try {
    const indexPath = join(memDir, 'MEMORY.md');
    const hasIndex = existsSync(indexPath);
    const indexLines = hasIndex
      ? readFileSync(indexPath, 'utf-8').split('\n').length
      : 0;

    const entries = readdirSync(memDir, { withFileTypes: true });
    // Collect topic files: .md files at the top level, excluding MEMORY.md and its backup
    const topics = entries
      .filter((e: { isFile: () => boolean; name: string }) =>
        e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('MEMORY'))
      .map((e: { name: string }) => {
        const fullPath = join(memDir, e.name);
        return { name: e.name, mtime: statSync(fullPath).mtime };
      });
    topics.sort((a: { mtime: Date }, b: { mtime: Date }) => b.mtime.getTime() - a.mtime.getTime());

    // Group by category prefix (the token before the first underscore)
    const categoryBreakdown: Record<string, number> = {};
    for (const t of topics) {
      const match = t.name.match(/^([a-z]+)_/);
      const cat = match ? match[1] : 'other';
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
    }

    const lastModified = topics[0]?.mtime
      ?? (hasIndex ? statSync(indexPath).mtime : null);

    // Top 3 most recently modified topic files (already sorted mtime desc above),
    // with the .md extension stripped for display.
    const recentTopics = topics
      .slice(0, 3)
      .map((t: { name: string }) => t.name.replace(/\.md$/, ''));

    const info: MemoryInfo = {
      hasIndex,
      indexLines,
      topicCount: topics.length,
      categoryBreakdown,
      recentTopics,
      lastModified,
    };
    state.memory = info;
  } catch {
    state.memory = null;
  }
}

function loadActiveSessions(state: SessionState): void {
  const sessionsDir = join(CLAUDE_DIR, 'sessions');
  if (!existsSync(sessionsDir)) {
    state.activeSessions = [];
    return;
  }
  try {
    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.json'));
    const alive: import('./types.js').AvailableSession[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
        if (typeof data.pid === 'number' && isProcessAlive(data.pid)) {
          const cwd = typeof data.cwd === 'string' ? data.cwd : '';
          // The registry's sessionId can go stale (Claude Code writes it once at
          // startup but doesn't update it when a new conversation begins in the
          // same process). Resolve the actual latest sessionId from the transcript
          // directory instead.
          const resolvedSessionId = cwd ? resolveLatestSessionId(cwd) : '';
          alive.push({
            pid: data.pid,
            sessionId: resolvedSessionId || (typeof data.sessionId === 'string' ? data.sessionId : ''),
            cwd,
            startedAt: new Date(typeof data.startedAt === 'number' ? data.startedAt : 0),
          });
        }
      } catch {
        // Skip malformed or unreadable entries
      }
    }
    // Sort by startedAt descending (newest first) for stable iteration order
    alive.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    state.activeSessions = alive;
  } catch {
    state.activeSessions = [];
  }
}

/**
 * Find the sessionId of the most recently modified .jsonl transcript for a given cwd.
 * This is more reliable than reading the sessions/<pid>.json registry, which can
 * contain a stale sessionId from a previous conversation in the same process.
 */
function resolveLatestSessionId(cwd: string): string | null {
  const projectDir = join(CLAUDE_DIR, 'projects', cwdToProjectDirName(cwd));
  if (!existsSync(projectDir)) return null;
  try {
    let latestMtime = 0;
    let latestId: string | null = null;
    const files = readdirSync(projectDir).filter((f: string) => f.endsWith('.jsonl'));
    for (const file of files) {
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

/**
 * Convert Claude's projectDir (e.g. ~/.claude/projects/-Users-foo-bar) back to
 * the real filesystem cwd (e.g. /Users/foo/bar). This is the inverse of
 * cwdToProjectDirName.
 */
function projectDirToRealCwd(projectDir: string): string {
  return basename(projectDir).replace(/-/g, '/');
}

/**
 * Read the current git branch for a given cwd by parsing .git/HEAD directly.
 * Returns the branch name, short SHA for detached HEAD, or null if not a git repo.
 *
 * Parsing .git/HEAD is preferred over shelling out to `git` because:
 *   - Zero fork overhead on every 2s refresh
 *   - No dependency on `git` being on PATH
 *   - Handles detached HEAD uniformly
 */
function readGitBranch(cwdPath: string): string | null {
  try {
    const headFile = join(cwdPath, '.git', 'HEAD');
    if (!existsSync(headFile)) return null;
    const content = readFileSync(headFile, 'utf-8').trim();
    // Normal case: "ref: refs/heads/<branch>"
    const refMatch = content.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];
    // Detached HEAD: raw SHA — show short form
    if (/^[0-9a-f]{7,40}$/i.test(content)) return content.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the actual user-typed prompt from a raw user-message text block.
 *
 * User-role transcript entries contain a mix of:
 *   - Real user input (what we want)
 *   - <system-reminder>...</system-reminder> (hook injections, environment context)
 *   - <local-command-caveat>...</local-command-caveat> (bash command banners)
 *   - <command-name>/cmd</command-name>, <command-message>, <command-args> (slash command markers)
 *   - <bash-input>/<bash-stdout>/<bash-stderr> (local bash output)
 *
 * This helper strips all of the above and returns the trimmed remainder,
 * or null if nothing user-typed is left (pure tool_result / hook echo).
 */
export function extractRealUserPrompt(text: string): string | null {
  if (!text) return null;

  // Slash command invocations inject the full skill body into the user message,
  // with the actual user-typed arguments in a <command-args> tag. When present,
  // that tag's content IS the user's prompt — prefer it over the rest.
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) {
    const args = argsMatch[1].trim();
    // Empty args means a no-arg slash command like "/status" — fall back to the command name.
    if (args) return args;
    const nameMatch = text.match(/<command-name>\/?(.+?)<\/command-name>/);
    if (nameMatch) return `/${nameMatch[1]}`;
    return null;
  }

  let cleaned = text;
  // Strip all known system-injected wrapper tags (including their content).
  const wrapperTags = [
    'system-reminder',
    'local-command-caveat',
    'command-message',
    'command-name',
    'bash-input',
    'bash-stdout',
    'bash-stderr',
    'task-notification',
  ];
  for (const tag of wrapperTags) {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g');
    cleaned = cleaned.replace(re, '');
  }
  cleaned = cleaned.trim();
  // If everything was a wrapper/hook echo, ignore it.
  if (!cleaned) return null;
  // Skip pure hook status lines like "UserPromptSubmit hook success: ..."
  if (/^[A-Za-z]+ hook success:/.test(cleaned)) return null;
  // Skip skill expansion bodies injected by Claude Code (they start with this preamble).
  if (cleaned.startsWith('Base directory for this skill:')) return null;
  return cleaned;
}

/** Promote the current activeSkill to lastCompletedSkill (if any). */
function promoteActiveSkill(state: SessionState, endTime: Date): void {
  if (!state.activeSkill) return;
  const completed = {
    name: state.activeSkill.name,
    args: state.activeSkill.args,
    endTime,
  };
  state.lastCompletedSkill = completed;
  state.skillHistory.unshift(completed);
  if (state.skillHistory.length > 5) state.skillHistory.length = 5;
  state.completedSkillIds.add(state.activeSkill.toolUseId);
  state.activeSkill = null;
}

function processEntry(
  state: SessionState,
  entry: TranscriptEntry,
  pendingTools: Map<string, { name: string; time: Date }>,
): void {
  // Use the entry's real timestamp; skip entries without timestamps for time tracking
  const entryTime = entry.timestamp ? new Date(entry.timestamp) : null;

  if (entry.type === 'permission-mode') {
    return;
  }

  // Set startTime from the first timestamped entry
  if (entryTime && state.startTime.getTime() === 0) {
    state.startTime = entryTime;
  }

  // Promote active skill when assistant finishes a complete turn (end_turn),
  // meaning all tool calls are done and the final response is delivered.
  // This works for both slash-command skills (cmd-) and Skill tool invocations.
  if (
    entry.message?.role === 'assistant'
    && entry.message.stop_reason === 'end_turn'
    && state.activeSkill
  ) {
    promoteActiveSkill(state, entryTime ?? new Date());
  }

  // Count messages
  if (entry.message?.role === 'user') state.messageCount.user++;
  if (entry.message?.role === 'assistant') state.messageCount.assistant++;
  if (entry.type === 'system') state.messageCount.system++;

  // Match tool_result entries with pending tool_use calls to calculate duration
  if (entry.message?.role === 'user' && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const pending = pendingTools.get(block.tool_use_id);
        if (pending && entryTime) {
          const durationMs = entryTime.getTime() - pending.time.getTime();
          if (durationMs >= 0) {
            const existing = state.toolDurations.get(pending.name);
            if (existing) {
              existing.avgMs = (existing.avgMs * existing.count + durationMs) / (existing.count + 1);
              existing.maxMs = Math.max(existing.maxMs, durationMs);
              existing.count++;
            } else {
              state.toolDurations.set(pending.name, {
                name: pending.name, avgMs: durationMs, maxMs: durationMs, count: 1,
              });
            }
          }
          pendingTools.delete(block.tool_use_id);
        }
      }
    }
  }

  // Track skills invoked via slash commands (<command-name>/skill</command-name> in user messages)
  if (entry.message?.role === 'user') {
    const content = entry.message.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(b => b.type === 'text').map(b => b.text || '').join('')
        : '';

    // Extract and store the actual user-typed prompt.
    // Strip system-injected wrappers and filter out tool-result-only entries.
    const realPrompt = extractRealUserPrompt(text);
    if (realPrompt) {
      state.lastUserPrompt = realPrompt;
      state.lastUserPromptTime = entryTime ?? new Date();
    }

    const cmdMatch = text.match(/<command-name>\/?(.+?)<\/command-name>/);
    if (cmdMatch) {
      const skillName = cmdMatch[1];
      const ts = entryTime ?? new Date();
      const existing = state.skills.get(skillName);
      if (existing) {
        existing.count++;
        existing.lastUsed = ts;
      } else {
        state.skills.set(skillName, { name: skillName, count: 1, lastUsed: ts });
      }
      // Slash-command skills don't go through tool_use/tool_result,
      // so track them directly as active (will be promoted to lastCompleted
      // when the next skill starts or assistant responds)
      promoteActiveSkill(state, ts);
      state.activeSkill = {
        name: skillName,
        args: undefined,
        toolUseId: `cmd-${skillName}-${ts.getTime()}`,
        startTime: ts,
      };
    } else if (state.activeSkill) {
      // A non-skill user message while a skill is active means the skill
      // has completed — user can only send after the assistant's turn ends.
      // This is a robust fallback for when end_turn detection is missed.
      promoteActiveSkill(state, entryTime ?? new Date());
    }
  }

  // Track model
  if (entry.message?.model) {
    state.model = entry.message.model;
  }

  // Track token usage
  if (entry.message?.usage) {
    const u = entry.message.usage;
    state.tokenUsage.input += u.input_tokens || 0;
    state.tokenUsage.output += u.output_tokens || 0;
    state.tokenUsage.cacheWrite += u.cache_creation_input_tokens || 0;
    state.tokenUsage.cacheRead += u.cache_read_input_tokens || 0;
    // Track current context window size (sum of all input token types)
    if (entry.message.role === 'assistant') {
      const totalInput = (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.cache_read_input_tokens || 0);
      if (totalInput > 0) {
        // Compaction detection: >30% drop in context tokens between consecutive turns
        if (state.contextTokens > 0 && totalInput < state.contextTokens * 0.7) {
          state.compactionCount++;
        }
        state.contextTokens = totalInput;
        if (totalInput > state.maxContextTokens) {
          state.maxContextTokens = totalInput;
        }
      }
      // Per-turn token history for sparkline (cap at 500 entries)
      const turnTotal = (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (turnTotal > 0) {
        state.tokenHistory.push(turnTotal);
        if (state.tokenHistory.length > 500) state.tokenHistory.shift();
      }
    }
  }

  // Track tool usage
  if (entry.message?.content) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const ts = entryTime ?? new Date();
        const existing = state.toolStats.get(block.name);
        if (existing) {
          existing.count++;
          existing.lastUsed = ts;
        } else {
          state.toolStats.set(block.name, { name: block.name, count: 1, lastUsed: ts });
        }
        // Register pending tool call for duration measurement
        if (block.id) {
          pendingTools.set(block.id, { name: block.name, time: ts });
        }

        // Track Skill tool usage + active skill state
        if (block.name === 'Skill' && block.input) {
          const skillName = (block.input as Record<string, string>).skill || 'unknown';
          const existing = state.skills.get(skillName);
          if (existing) {
            existing.count++;
            existing.lastUsed = ts;
          } else {
            state.skills.set(skillName, { name: skillName, count: 1, lastUsed: ts });
          }
          // Track as active skill (will be promoted on assistant end_turn)
          if (block.id) {
            // Promote previous activeSkill to lastCompleted if it was never resolved
            promoteActiveSkill(state, ts);
            state.activeSkill = {
              name: skillName,
              args: (block.input as Record<string, string>).args,
              toolUseId: block.id,
              startTime: ts,
            };
          }
        }

        // Track TeamCreate to know which teams belong to this session
        if (block.name === 'TeamCreate' && block.input) {
          const teamName = (block.input as Record<string, string>).team_name;
          if (teamName) state.sessionTeamNames.add(teamName);
        }
      }

      // Note: tool_result for Skill tool fires immediately ("Launching skill: ..."),
      // which is the START of execution, not the end. Skill completion is detected
      // by stop_reason === 'end_turn' on the assistant's final response instead.
    }
  }

  // Track task entries
  if (entry.type === 'create' && entry.subject) {
    state.tasks.push({
      id: entry.taskId || '',
      subject: entry.subject,
      status: entry.status || 'pending',
    });
  }
  if (entry.type === 'update' && entry.taskId) {
    const task = state.tasks.find(t => t.id === entry.taskId);
    if (task && entry.status) {
      task.status = entry.status;
    }
  }

  if (entryTime) {
    state.lastActivity = entryTime;
  }
}

function loadSubagents(state: SessionState): void {
  const subagentDir = join(state.projectDir, state.sessionId, 'subagents');
  if (!existsSync(subagentDir)) return;

  const files = readdirSync(subagentDir);
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const metaPath = join(subagentDir, file);
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      const agentId = file.replace('.meta.json', '').replace('agent-', '');

      const jsonlFile = join(subagentDir, file.replace('.meta.json', '.jsonl'));
      const hasJsonl = existsSync(jsonlFile);

      // Determine status: if JSONL hasn't been modified in 30s, consider completed
      let status: 'running' | 'completed' | 'error' = 'running';
      let startTime = new Date();
      let endTime: Date | undefined;

      if (hasJsonl) {
        const jsonlStat = statSync(jsonlFile);
        startTime = jsonlStat.birthtime;
        const lastModified = jsonlStat.mtime;
        const idleMs = Date.now() - lastModified.getTime();

        if (idleMs > 30_000) {
          // No writes for 30s — agent likely finished
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

export function loadTeams(): TeamInfo[] {
  const teamsDir = join(CLAUDE_DIR, 'teams');
  if (!existsSync(teamsDir)) return [];

  const teams: TeamInfo[] = [];
  for (const dir of readdirSync(teamsDir)) {
    const teamDir = join(teamsDir, dir);
    if (!statSync(teamDir).isDirectory()) continue;

    const configFile = join(teamDir, 'config.json');
    let members: string[] = [];
    if (existsSync(configFile)) {
      try {
        const config = JSON.parse(readFileSync(configFile, 'utf-8'));
        const rawMembers = config.members || Object.keys(config.agents || {});
      members = rawMembers.map((m: unknown) =>
        typeof m === 'object' && m !== null && 'name' in m ? (m as { name: string }).name : String(m),
      );
      } catch { /* skip */ }
    }

    const inboxDir = join(teamDir, 'inboxes');
    teams.push({
      name: dir,
      configFile: existsSync(configFile) ? configFile : '',
      members,
      hasInbox: existsSync(inboxDir),
    });
  }
  return teams;
}

function loadTasks(state: SessionState): void {
  const tasksDir = join(CLAUDE_DIR, 'tasks', state.sessionId);
  if (!existsSync(tasksDir)) return;

  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(tasksDir, file), 'utf-8'));
        if (task.subject && !state.tasks.find(t => t.id === task.id)) {
          state.tasks.push({
            id: task.id || basename(file, '.json'),
            subject: task.subject,
            status: task.status || 'unknown',
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

/**
 * Read the PostToolUse hook state file for faster skill completion detection.
 * The hook script writes to ~/.claude/.omc/state/last-skill-complete.json
 * whenever a Skill tool completes. This is faster than transcript parsing
 * for the most recent skill.
 */
function loadSkillHookState(state: SessionState): void {
  const hookFile = join(CLAUDE_DIR, '.omc', 'state', 'last-skill-complete.json');
  if (!existsSync(hookFile)) return;

  try {
    const stat = statSync(hookFile);
    // Only use if written within the last 5 minutes (avoid stale data)
    if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) return;

    const data = JSON.parse(readFileSync(hookFile, 'utf-8'));
    if (!data.skill || data.skill === 'unknown') return;

    const hookTime = new Date(data.completedAt || stat.mtime);

    // Only override if the hook data is newer than what transcript parsing found
    if (
      !state.lastCompletedSkill ||
      hookTime.getTime() > state.lastCompletedSkill.endTime.getTime()
    ) {
      const completed = {
        name: data.skill,
        args: data.args ?? undefined,
        endTime: hookTime,
      };
      state.lastCompletedSkill = completed;
      // Also add to history if not already there
      if (
        state.skillHistory.length === 0 ||
        state.skillHistory[0].name !== completed.name ||
        state.skillHistory[0].endTime.getTime() !== completed.endTime.getTime()
      ) {
        state.skillHistory.unshift(completed);
        if (state.skillHistory.length > 5) state.skillHistory.length = 5;
      }
      // Clear activeSkill if it matches the completed one
      if (state.activeSkill && state.activeSkill.name === data.skill) {
        state.activeSkill = null;
      }
    }
  } catch { /* skip */ }
}

/** Local cache path for rate limit data fetched directly from the Anthropic API. */
const RATE_LIMIT_CACHE = join(CLAUDE_DIR, 'ccmonitor-usage-cache.json');
/** Cache TTL: 5 minutes. Avoids hitting the API on every 2-second refresh. */
const RATE_LIMIT_CACHE_TTL = 5 * 60 * 1000;

/**
 * Read account-level rate limit data by calling the Anthropic OAuth usage API
 * directly. OAuth credentials are read from macOS Keychain. Results are cached
 * locally for 5 minutes to avoid API spam on the 2-second refresh cycle.
 *
 * Falls back to abtop's file if the Keychain approach fails (e.g. on Linux).
 */
function loadRateLimit(): RateLimitInfo | null {
  return loadRateLimitFromCache() ?? loadRateLimitFromAbtop();
}

/**
 * Read from or refresh the local cache (~/.claude/ccmonitor-usage-cache.json).
 * If the cache is fresh (<5 min), return it. Otherwise, fetch from the API,
 * update the cache, and return the new data.
 */
function loadRateLimitFromCache(): RateLimitInfo | null {
  const nowMs = Date.now();

  // Try reading existing cache
  if (existsSync(RATE_LIMIT_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(RATE_LIMIT_CACHE, 'utf-8'));
      const cacheAge = nowMs - (cached.timestamp ?? 0);
      if (cacheAge < RATE_LIMIT_CACHE_TTL && cached.data) {
        return cachedDataToRateLimitInfo(cached);
      }
    } catch {
      // Cache corrupt — fall through to refresh
    }
  }

  // Cache missing or stale — fetch fresh data from the API
  return fetchAndCacheRateLimit();
}

/**
 * Read OAuth access token from macOS Keychain via the `security` CLI.
 * Returns null on non-macOS or if no credentials are stored.
 */
function readOAuthToken(): string | null {
  try {
    const raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch rate limits from the Anthropic OAuth usage API and write the result
 * to the local cache file. Uses curl (synchronous) to keep the architecture
 * consistent with the rest of the codebase.
 */
function fetchAndCacheRateLimit(): RateLimitInfo | null {
  const token = readOAuthToken();
  if (!token) return null;

  try {
    const raw = execFileSync('curl', [
      '-s', '--max-time', '5',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'anthropic-beta: oauth-2025-04-20',
      'https://api.anthropic.com/api/oauth/usage',
    ], { encoding: 'utf-8', timeout: 8000 });

    const resp = JSON.parse(raw);
    // API returns utilization as a percentage (e.g. 14.0 = 14%), not a fraction.
    const toEpochSec = (iso: string | undefined | null): number | null => {
      if (!iso) return null;
      const ms = new Date(iso).getTime();
      return isNaN(ms) ? null : Math.floor(ms / 1000);
    };
    const pct = (v: unknown): number | null =>
      typeof v === 'number' ? Math.round(v) : null;

    const cached = {
      timestamp: Date.now(),
      data: {
        fiveHourPct: pct(resp.five_hour?.utilization),
        fiveHourResetsAt: toEpochSec(resp.five_hour?.resets_at),
        weeklyPct: pct(resp.seven_day?.utilization),
        weeklyResetsAt: toEpochSec(resp.seven_day?.resets_at),
        sonnetWeeklyPct: pct(resp.seven_day_sonnet?.utilization),
        opusWeeklyPct: pct(resp.seven_day_opus?.utilization),
      },
    };

    // Write cache (best-effort — don't fail if write fails)
    try {
      writeFileSync(RATE_LIMIT_CACHE, JSON.stringify(cached, null, 2));
    } catch { /* skip */ }

    return cachedDataToRateLimitInfo(cached);
  } catch {
    return null;
  }
}

/** Convert the local cache shape to RateLimitInfo. */
function cachedDataToRateLimitInfo(cached: {
  timestamp: number;
  data: Record<string, unknown>;
}): RateLimitInfo {
  const d = cached.data;
  const nowMs = Date.now();
  const isStale = (nowMs - cached.timestamp) > RATE_LIMIT_CACHE_TTL;
  return {
    source: 'api',
    fiveHourPct: typeof d.fiveHourPct === 'number' ? d.fiveHourPct : null,
    fiveHourResetsAt: typeof d.fiveHourResetsAt === 'number' ? d.fiveHourResetsAt : null,
    weeklyPct: typeof d.weeklyPct === 'number' ? d.weeklyPct : null,
    weeklyResetsAt: typeof d.weeklyResetsAt === 'number' ? d.weeklyResetsAt : null,
    sonnetWeeklyPct: typeof d.sonnetWeeklyPct === 'number' ? d.sonnetWeeklyPct : null,
    opusWeeklyPct: typeof d.opusWeeklyPct === 'number' ? d.opusWeeklyPct : null,
    updatedAt: cached.timestamp,
    isStale,
  };
}

/** Fallback: abtop source (~/.claude/abtop-rate-limits.json) for non-macOS or no Keychain. */
function loadRateLimitFromAbtop(): RateLimitInfo | null {
  const filePath = join(CLAUDE_DIR, 'abtop-rate-limits.json');
  if (!existsSync(filePath)) return null;

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const nowMs = Date.now();
    const updatedAt = typeof data.updated_at === 'number' ? data.updated_at * 1000 : null;
    const isStale = updatedAt !== null ? (nowMs - updatedAt) > 900_000 : true;

    return {
      source: 'abtop',
      fiveHourPct: data.five_hour?.used_percentage ?? null,
      fiveHourResetsAt: data.five_hour?.resets_at ?? null,
      weeklyPct: data.seven_day?.used_percentage ?? null,
      weeklyResetsAt: data.seven_day?.resets_at ?? null,
      sonnetWeeklyPct: null,
      opusWeeklyPct: null,
      updatedAt,
      isStale,
    };
  } catch {
    return null;
  }
}

/**
 * Load process memory (RSS) for the Claude Code session.
 * Finds the session's PID from activeSessions, then reads RSS via `ps`.
 * Uses execFileSync (no shell) to avoid command injection.
 * Gracefully degrades — leaves processMemMb at 0 on any failure.
 */
function loadProcessInfo(state: SessionState): void {
  const session = state.activeSessions.find(s => s.sessionId === state.sessionId);
  if (!session) return;
  const pid = session.pid;

  try {
    const output = execFileSync(
      'ps', ['-o', 'rss=', '-p', String(pid)],
      { encoding: 'utf-8', timeout: 2000 },
    );
    const rssKb = parseInt(output.trim(), 10);
    if (!isNaN(rssKb)) {
      state.processMemMb = Math.round(rssKb / 1024);
    }
  } catch {
    // ps failed — silently degrade
  }
}
