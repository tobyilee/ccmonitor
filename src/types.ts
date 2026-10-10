export type EntryType =
  | 'assistant'
  | 'user'
  | 'system'
  | 'tool_result'
  | 'text'
  | 'file-history-snapshot'
  | 'file-history-delta'
  | 'permission-mode'
  | 'create'
  | 'update'
  | 'queue-operation'
  | 'tool_reference'
  | 'attachment'
  | 'last-prompt'
  | 'ai-title'
  | 'mode'
  | 'atis-latch'
  | 'cost-state'
  | 'custom-title'
  | 'agent-name'
  | 'frame-link'
  | 'pr-link'
  | 'bridge-session'
  | 'dev-mods'
  | 'artifact-comment-monitor'
  | 'artifact-autoreact-ledger';

export interface ToolUse {
  name: string;
  id: string;
  input: Record<string, unknown>;
  caller?: { type: string };
}

/** One block of an assistant or user message. */
export interface ContentBlock {
  type: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
  /** tool_result payload: string or nested blocks */
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
  caller?: { type: string };
}

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  speed?: string;
  output_tokens_details?: { thinking_tokens?: number };
}

export interface PermissionDecision {
  decision?: string;
  source?: string;
  reasonType?: string;
}

export interface TranscriptEntry {
  type?: EntryType | string;
  parentUuid?: string;
  uuid?: string;
  isSidechain?: boolean;
  /** True for entries Claude Code injected itself (local command echoes, hand-backs). */
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  version?: string;
  entrypoint?: string;
  slug?: string;
  // Reasoning effort actually used for this assistant turn (e.g. "high")
  effort?: string;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    stop_reason?: string;
    content?: string | ContentBlock[];
    usage?: MessageUsage;
  };
  // --- assistant extras ---
  thinkingDurationMs?: number;
  attributionSkill?: string;
  attributionPlugin?: string;
  attributionMcpServer?: string;
  advisorModel?: string;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  apiErrorCode?: string;
  isAbortedMidStream?: boolean;
  // --- user extras ---
  promptId?: string;
  permissionMode?: string;
  promptSource?: string;
  turnOrigin?: string;
  turnPosition?: { promptIndex?: number; turnIndex?: number };
  origin?: { kind?: string; producer?: string; runId?: string; from?: string; name?: string };
  toolUseResult?: unknown;
  permissionDecision?: PermissionDecision;
  toolDenialKind?: string;
  isCompactSummary?: boolean;
  interruptedMessageId?: string;
  // --- system extras ---
  subtype?: string;
  content?: string;
  level?: string;
  durationMs?: number;
  messageCount?: number;
  pendingBackgroundAgentCount?: number;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    cumulativeDroppedTokens?: number;
    durationMs?: number;
  };
  url?: string;
  hookCount?: number;
  hookErrors?: unknown[];
  preventedContinuation?: boolean;
  commandRun?: { command?: string; args?: string };
  // --- attachment ---
  attachment?: Record<string, unknown> & { type?: string };
  // --- queue-operation ---
  operation?: string;
  reason?: string;
  deliveryId?: string;
  // --- cost-state ---
  totalCostUSD?: number;
  totalAPIDuration?: number;
  totalToolDuration?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  totalDuration?: number;
  modelUsage?: Record<string, { costUSD?: number; inputTokens?: number; outputTokens?: number }>;
  hasUnknownModelCost?: boolean;
  // --- links / identity ---
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  frameUrl?: string;
  title?: string;
  path?: string;
  artifactCount?: number;
  customTitle?: string;
  agentName?: string;
  // --- file-history-delta ---
  trackingPath?: string;
  backup?: { backupFileName?: string; version?: number; backupTime?: string };
  // Task entries
  subject?: string;
  status?: string;
  taskId?: string;
  description?: string;
  // last-prompt entries: the verbatim user-typed prompt
  lastPrompt?: string;
  // ai-title entries: AI-generated session title
  aiTitle?: string;
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
  /** Short human-readable session name from the registry (e.g. "ccmonitor-b6"). Null on old versions. */
  name: string | null;
  /** Live status reported by Claude Code itself: "busy" | "idle". Null on old versions. */
  status: string | null;
  /** Claude Code version running this session (e.g. "2.1.220"). Null on old versions. */
  version: string | null;
  /** "interactive" | "attached" | "unattended" … Null on old versions. */
  kind: string | null;
  /** "cli" | "claude-desktop". Null on old versions. */
  entrypoint: string | null;
  /** Desktop host session id. Null for CLI sessions. */
  hostSessionId: string | null;
  /** "derived" | "user" | null */
  nameSource: string | null;
  /** When `status` was last written (epoch ms). Null on old versions. */
  statusUpdatedAt: number | null;
  /** Unix socket for cross-session messaging. Null on old versions. */
  messagingSocketPath: string | null;
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
  /** Data source: "api", "abtop" or "statusline" */
  source: string;
  /** 5-hour window usage percentage (0-100), or null if unavailable */
  fiveHourPct: number | null;
  /** When the 5-hour window resets (epoch seconds) */
  fiveHourResetsAt: number | null;
  /** Weekly (7-day) usage percentage (0-100), or null if unavailable */
  weeklyPct: number | null;
  /** When the weekly window resets (epoch seconds) */
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

export interface ActiveSkill {
  name: string;
  args?: string;
  toolUseId: string;
  startTime: Date;
}

// --- v1.6 additions ---

/** One API response, merged across the JSONL lines that share `message.id`. */
export interface AssistantMessage {
  id: string;
  /** `text` blocks in order (thinking and tool_use are not kept). */
  texts: string[];
  toolUses: number;
  stopReason: string | null;
  time: Date;
  model: string | null;
}

export interface RecapInfo {
  /** `system/away_summary` content with the "(disable recaps…)" suffix removed. */
  nativeRecap: string | null;
  nativeRecapTime: Date | null;
  /** Full text of the last `end_turn` assistant message. */
  finalReply: string | null;
  finalReplyTime: Date | null;
  finalReplyModel: string | null;
  /** The "Korean recap" section of `finalReply`, or null if absent. */
  koreanRecap: string | null;
  /** Newest mid-turn text block while the turn is open. */
  liveNarration: string | null;
  liveNarrationTime: Date | null;
  turnOpen: boolean;
}

export type TurnOrigin = 'human' | 'task_notification' | 'peer';

export interface TurnInfo {
  index: number;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  messageCount: number | null;
  toolCalls: number;
  promptPreview: string;
  origin: TurnOrigin;
  pendingBackgroundAgents: number;
}

export type BackgroundTaskKind = 'agent' | 'bash' | 'monitor' | 'workflow';
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  /** Agent type (subagent_type) for agents, null otherwise. */
  agentType: string | null;
  description: string;
  model: string | null;
  startedAt: Date;
  endedAt: Date | null;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  outputFile: string | null;
  outputBytes: number;
  /** Tool-use id that launched the task (for matching the result). */
  toolUseId: string | null;
  /** Summary line from the task notification, if any. */
  summary: string | null;
}

export interface CompactionInfo {
  trigger: string;
  preTokens: number;
  postTokens: number;
  durationMs: number | null;
  at: Date | null;
}

export interface CostInfo {
  totalUSD: number;
  apiDurationMs: number;
  toolDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  perModel: Record<string, number>;
  hasUnknownModelCost: boolean;
  /** True when the value came from ~/.claude.json (previous session), not the transcript. */
  isPrevious: boolean;
}

export interface HookRunError {
  hookName: string;
  exitCode: number;
  stderr: string;
  time: Date | null;
}

export interface HooksInfo {
  byEvent: Record<string, number>;
  total: number;
  errors: HookRunError[];
  /** `preventedContinuation` of the latest stop_hook_summary (reset by turn_duration). */
  stopBlocked: boolean;
  lastStopHookCount: number;
}

export interface Denial {
  tool: string | null;
  kind: string | null;
  reason: string;
  time: Date | null;
}

export interface PermissionInfo {
  mode: string | null;
  autoMode: { bashFirst: boolean; steerOnly: boolean; bypass: boolean } | null;
  decisions: { accept: number; reject: number; byReason: Record<string, number> };
  denials: Denial[];
}

export interface RemoteControlInfo {
  active: boolean;
  url: string | null;
  bridgeSessionId: string | null;
}

export interface LinksInfo {
  prs: Array<{ number: number; url: string; repository: string; time: Date | null }>;
  artifacts: Array<{ title: string; url: string; path: string | null; time: Date | null }>;
  plan: { path: string; bytes: number } | null;
  feedbackDrafts: Array<{ title: string; type: string }>;
}

export interface QueueInfo {
  depth: number;
  preview: string | null;
}

export interface AttributionInfo {
  skills: Record<string, number>;
  plugins: Record<string, number>;
  mcpServers: Record<string, number>;
  advisorCalls: number;
  advisorModel: string | null;
  thinkingAvgMs: number;
  thinkingSamples: number;
  fastMode: boolean;
}

export interface ErrorInfo {
  api: Array<{ status: number | null; code: string | null; text: string; time: Date | null }>;
  interrupts: number;
  abortedMidStream: number;
}

export interface EditedFile {
  path: string;
  version: number;
  lastEdit: Date | null;
  external: boolean;
}

export interface SessionState {
  sessionId: string;
  projectDir: string;
  transcriptFile: string;
  /** Real working directory as recorded in transcript entries (`cwd` field).
   *  Preferred over deriving from projectDir, whose name mangling is lossy
   *  (`_` and `.` both become `-`). Null for old transcripts without the field. */
  cwd: string | null;
  /** Session title: custom-title > agent-name > ai-title. Null if none yet. */
  sessionTitle: string | null;
  /** Raw title sources, kept so precedence can be re-resolved on each entry. */
  titleSources: { custom: string | null; agent: string | null; ai: string | null };
  /** Plan-mode slug (`slug` field on assistant entries). */
  slug: string | null;
  /** Claude Code version from transcript entries. */
  version: string | null;
  /** `cli` | `claude-desktop` from transcript entries. */
  entrypoint: string | null;
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
  /** Current Claude Code reasoning effort level (e.g. "low", "medium", "high", "xhigh"). */
  effortLevel: string | null;

  // --- Context & Token Analytics ---

  /** Model's maximum context window in tokens (e.g. 200_000 or 1_000_000). */
  contextWindow: number;
  /** Current context usage as a percentage (0-100). Derived from contextTokens / contextWindow. */
  contextPercent: number;
  /** Number of context compactions. Exact from `compact_boundary` when present, else heuristic. */
  compactionCount: number;
  /** Heuristic count (>30% drop between consecutive turns); used only for old transcripts. */
  heuristicCompactionCount: number;
  /** Peak context tokens observed during this session. */
  maxContextTokens: number;
  /** Per-turn total token counts (input+output+cache) for sparkline rendering. Capped at 500 entries. */
  tokenHistory: number[];
  /** Average token burn rate in tokens per minute, calculated from session start to last activity. */
  tokenBurnRate: number;

  /** Account-level rate limit quota info. Null if no data available. */
  rateLimit: RateLimitInfo | null;

  // --- Tool & Process Analytics ---

  /** Per-tool execution duration stats (avg/max/count), derived from tool_use→tool_result timestamp pairs. */
  toolDurations: Map<string, ToolDuration>;
  /** Claude Code process memory usage in MB. 0 if unavailable. */
  processMemMb: number;

  // --- v1.6: Recap, Turns, Background ---

  recap: RecapInfo;
  /** Closed turns, oldest first (last 20). */
  turns: TurnInfo[];
  /** The open turn, or null when idle. */
  currentTurn: TurnInfo | null;
  backgroundTasks: Map<string, BackgroundTask>;
  /** `pendingBackgroundAgentCount` from the latest turn_duration. */
  pendingBackgroundAgents: number;
  /** Scratchpad directory from the `environment` attachment. */
  scratchpadDir: string | null;
  compactions: CompactionInfo[];
  remoteControl: RemoteControlInfo;
  /** Last 5 local slash commands (`/clear`, `/model` …). */
  localCommands: Array<{ command: string; args: string; time: Date | null }>;
  hooks: HooksInfo;

  // --- v1.7 ---
  cost: CostInfo | null;
  permissions: PermissionInfo;

  // --- v1.8 ---
  links: LinksInfo;
  queue: QueueInfo;
  attribution: AttributionInfo;
  errors: ErrorInfo;

  // --- v1.9 ---
  editedFiles: Map<string, EditedFile>;
}
