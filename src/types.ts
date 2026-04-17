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
}
