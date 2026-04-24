export type EntryType =
  | 'assistant'
  | 'user'
  | 'system'
  | 'tool_result'
  | 'text'
  | 'file-history-snapshot'
  | 'permission-mode'
  | 'create'
  | 'update'
  | 'queue-operation'
  | 'tool_reference'
  | 'attachment';

export interface ToolUse {
  name: string;
  id: string;
  input: Record<string, unknown>;
  caller?: { type: string };
}

export interface TranscriptEntry {
  type?: EntryType;
  parentUuid?: string;
  uuid?: string;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  message?: {
    model?: string;
    role?: string;
    stop_reason?: string;
    content?: Array<{
      type: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      input?: Record<string, unknown>;
      text?: string;
      caller?: { type: string };
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  // Task entries
  subject?: string;
  status?: string;
  taskId?: string;
  description?: string;
}

export interface ToolStats {
  name: string;
  count: number;
  lastUsed: Date;
}

export interface SubagentInfo {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'completed' | 'error';
  startTime: Date;
  endTime?: Date;
}

export interface TeamInfo {
  name: string;
  configFile: string;
  members: string[];
  hasInbox: boolean;
}

export interface SkillInfo {
  name: string;
  count: number;
  lastUsed: Date;
}

export interface AvailableSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: Date;
}

export interface MemoryInfo {
  /** Whether MEMORY.md (the index file) exists. */
  hasIndex: boolean;
  /** Line count of MEMORY.md, or 0 if absent. */
  indexLines: number;
  /** Number of topic files (*.md files other than MEMORY.md/MEMORY.md.bak). */
  topicCount: number;
  /** Count of topic files grouped by prefix (e.g. { feedback: 4, project: 3, user: 1 }). */
  categoryBreakdown: Record<string, number>;
  /** Top 3 most recently modified topic file names (without .md extension). */
  recentTopics: string[];
  /** Most recent modification across all memory files, or null if none. */
  lastModified: Date | null;
}

export interface RateLimitInfo {
  /** Data source: "abtop" or "omc" */
  source: string;
  /** 5-hour window usage percentage (0-100), or null if unavailable */
  fiveHourPct: number | null;
  /** When the 5-hour window resets (epoch seconds for abtop, ISO string date for OMC) */
  fiveHourResetsAt: number | null;
  /** Weekly (7-day) usage percentage (0-100), or null if unavailable */
  weeklyPct: number | null;
  /** When the weekly window resets (epoch seconds for abtop, ISO string date for OMC) */
  weeklyResetsAt: number | null;
  /** Per-model Sonnet weekly percentage (OMC only) */
  sonnetWeeklyPct: number | null;
  /** Per-model Opus weekly percentage (OMC only) */
  opusWeeklyPct: number | null;
  /** Epoch milliseconds when this data was last collected */
  updatedAt: number | null;
  /** Whether the data is stale (>15 minutes old) */
  isStale: boolean;
}

export interface ToolDuration {
  name: string;
  /** Average execution time in milliseconds */
  avgMs: number;
  /** Maximum execution time in milliseconds */
  maxMs: number;
  /** Number of completed calls (with measured duration) */
  count: number;
}

export interface ChildProcess {
  pid: number;
  command: string;
  memMb: number;
}

export interface ActiveSkill {
  name: string;
  args?: string;
  toolUseId: string;
  startTime: Date;
}

export interface SessionState {
  sessionId: string;
  projectDir: string;
  transcriptFile: string;
  startTime: Date;
  toolStats: Map<string, ToolStats>;
  skills: Map<string, SkillInfo>;
  activeSkill: ActiveSkill | null;
  /** The most recently completed skill (for display when idle) */
  lastCompletedSkill: { name: string; args?: string; endTime: Date } | null;
  /** Recent skill history (most recent first, up to 5) */
  skillHistory: Array<{ name: string; args?: string; endTime: Date }>;
  /** Set of Skill tool_use IDs that have received tool_result (completed) */
  completedSkillIds: Set<string>;
  subagents: Map<string, SubagentInfo>;
  teams: TeamInfo[];
  tasks: Array<{ id: string; subject: string; status: string }>;
  tokenUsage: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** Last input_tokens from the most recent assistant message (= current context size) */
  contextTokens: number;
  messageCount: { user: number; assistant: number; system: number };
  recentFiles: Array<{ path: string; time: Date; event: string }>;
  sessionTeamNames: Set<string>;
  lastActivity: Date;
  model: string;
  /** The most recent actual user-typed prompt (excludes tool results, hook output, system reminders) */
  lastUserPrompt: string | null;
  /** Timestamp of the last user prompt */
  lastUserPromptTime: Date | null;
  /** Current git branch of the project cwd (or short SHA for detached HEAD). Null if not a git repo. */
  gitBranch: string | null;
  /** Count of unique files edited in this session (derived from ~/.claude/file-history/<sessionId>/). */
  editedFilesCount: number;
  /** All currently-alive Claude Code sessions (including this one), from ~/.claude/sessions/<pid>.json with PID liveness check. */
  activeSessions: AvailableSession[];
  /** Auto-memory info for this project (from projects/<cwd>/memory/). Null if no memory directory exists. */
  memory: MemoryInfo | null;
  /** Current Claude Code reasoning effort level (e.g. "low", "medium", "high", "xhigh").
   *  Resolved from the settings cascade: project .claude/settings.local.json → project .claude/settings.json → ~/.claude/settings.json.
   *  Null if no setting is found in any layer. */
  effortLevel: string | null;

  // --- Context & Token Analytics (inspired by abtop) ---

  /** Model's maximum context window in tokens (e.g. 200_000 or 1_000_000). */
  contextWindow: number;
  /** Current context usage as a percentage (0-100). Derived from contextTokens / contextWindow. */
  contextPercent: number;
  /** Number of detected context compactions (>30% drop in context tokens between consecutive turns). */
  compactionCount: number;
  /** Peak context tokens observed during this session. */
  maxContextTokens: number;
  /** Per-turn total token counts (input+output+cache) for sparkline rendering. Capped at 500 entries. */
  tokenHistory: number[];
  /** Average token burn rate in tokens per minute, calculated from session start to last activity. */
  tokenBurnRate: number;

  /** Account-level rate limit quota info (from abtop's StatusLine hook). Null if no data available. */
  rateLimit: RateLimitInfo | null;

  // --- Tool & Process Analytics ---

  /** Per-tool execution duration stats (avg/max/count), derived from tool_use→tool_result timestamp pairs. */
  toolDurations: Map<string, ToolDuration>;
  /** Claude Code process memory usage in MB. 0 if unavailable. */
  processMemMb: number;
  /** Child processes spawned by the Claude Code session. */
  childProcesses: ChildProcess[];
}
