import type { AssistantMessage, SessionState } from './types.js';

/** Identity of the transcript being parsed. */
export interface ParseContext {
  sessionId: string;
  projectDir: string;
  transcriptFile: string;
  /** Called once per unknown (kind, value) pair. Injected so tests can observe it. */
  onUnknown?: (kind: string, value: string) => void;
}

/** Parser working memory that is not part of the rendered state. */
export interface ParseMemo {
  /** Pending tool_use calls: id → { name, timestamp } for duration calculation. */
  pendingTools: Map<string, { name: string; time: Date }>;
  /** Every `message.id` seen so far (usage counted once per id). */
  seenMessageIds: Set<string>;
  /** Recent assistant messages merged by id (bounded). */
  messages: Map<string, AssistantMessage>;
  /** Insertion order of `messages`, for eviction. */
  messageOrder: string[];
  /** Unknown (kind:value) pairs already reported. */
  unknownSeen: Set<string>;
  /** tool_use id → launch info for background tasks awaiting their result. */
  pendingBackground: Map<string, { kind: 'agent' | 'bash' | 'monitor'; description: string; agentType: string | null; time: Date }>;
  /** Time of the last human prompt (drives turnOpen and live narration). */
  lastHumanPromptTime: Date | null;
  /** Last context-token figure used for the compaction heuristic. */
  turnCounter: number;
  /** Queue bookkeeping. */
  queueEnqueued: number;
  queueDequeued: number;
  queueRemoved: number;
  /** Running sum for thinking-duration average. */
  thinkingSumMs: number;
}

export interface ParseSession {
  ctx: ParseContext;
  memo: ParseMemo;
  state: SessionState;
}

export const MAX_KEPT_MESSAGES = 100;

export function createSessionState(ctx: ParseContext): SessionState {
  return {
    sessionId: ctx.sessionId,
    projectDir: ctx.projectDir,
    transcriptFile: ctx.transcriptFile,
    cwd: null,
    sessionTitle: null,
    titleSources: { custom: null, agent: null, ai: null },
    slug: null,
    version: null,
    entrypoint: null,
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
    heuristicCompactionCount: 0,
    maxContextTokens: 0,
    tokenHistory: [],
    tokenBurnRate: 0,
    rateLimit: null,
    toolDurations: new Map(),
    processMemMb: 0,
    recap: {
      nativeRecap: null,
      nativeRecapTime: null,
      finalReply: null,
      finalReplyTime: null,
      finalReplyModel: null,
      koreanRecap: null,
      liveNarration: null,
      liveNarrationTime: null,
      turnOpen: false,
    },
    turns: [],
    currentTurn: null,
    backgroundTasks: new Map(),
    pendingBackgroundAgents: 0,
    scratchpadDir: null,
    compactions: [],
    remoteControl: { active: false, url: null, bridgeSessionId: null },
    localCommands: [],
    hooks: { byEvent: {}, total: 0, errors: [], stopBlocked: false, lastStopHookCount: 0 },
    cost: null,
    permissions: {
      mode: null,
      autoMode: null,
      decisions: { accept: 0, reject: 0, byReason: {} },
      denials: [],
    },
    links: { prs: [], artifacts: [], plan: null, feedbackDrafts: [] },
    queue: { depth: 0, preview: null },
    attribution: {
      skills: {}, plugins: {}, mcpServers: {},
      advisorCalls: 0, advisorModel: null,
      thinkingAvgMs: 0, thinkingSamples: 0, fastMode: false,
    },
    errors: { api: [], interrupts: 0, abortedMidStream: 0 },
    editedFiles: new Map(),
  };
}

export function createParseMemo(): ParseMemo {
  return {
    pendingTools: new Map(),
    seenMessageIds: new Set(),
    messages: new Map(),
    messageOrder: [],
    unknownSeen: new Set(),
    pendingBackground: new Map(),
    lastHumanPromptTime: null,
    turnCounter: 0,
    queueEnqueued: 0,
    queueDequeued: 0,
    queueRemoved: 0,
    thinkingSumMs: 0,
  };
}

export function createParseSession(ctx: ParseContext): ParseSession {
  return { ctx, memo: createParseMemo(), state: createSessionState(ctx) };
}
