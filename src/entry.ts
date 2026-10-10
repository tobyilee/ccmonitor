/**
 * Pure per-entry state machine. No file system, no clock, no process access.
 * `processEntry` dispatches one transcript line into the ParseSession.
 */
import type { ParseSession } from './state.js';
import { MAX_KEPT_MESSAGES } from './state.js';
import type {
  AssistantMessage, BackgroundTask, ContentBlock, SessionState, TranscriptEntry, TurnInfo, TurnOrigin,
} from './types.js';
import { cleanNativeRecap, extractKoreanRecap, parseTaskNotification } from './recap.js';

// ---------------------------------------------------------------------------
// Known-value catalogs (spec §3.1). Anything else is reported through onUnknown.
// ---------------------------------------------------------------------------

export const KNOWN_TYPES = new Set<string>([
  'assistant', 'user', 'system', 'attachment', 'last-prompt', 'ai-title', 'atis-latch', 'mode',
  'permission-mode', 'bridge-session', 'queue-operation', 'pr-link', 'file-history-delta',
  'file-history-snapshot', 'cost-state', 'agent-name', 'frame-link', 'artifact-comment-monitor',
  'artifact-autoreact-ledger', 'custom-title', 'dev-mods', 'create', 'update', 'tool_result', 'text',
  'tool_reference', 'summary', 'worktree-state',
]);

export const KNOWN_SYSTEM_SUBTYPES = new Set<string>([
  'turn_duration', 'stop_hook_summary', 'away_summary', 'local_command', 'bridge_status',
  'compact_boundary', 'informational', 'api_error', 'memory_saved', 'loop_wakeup',
]);

export const KNOWN_ATTACHMENT_TYPES = new Set<string>([
  'hook_success', 'total_tokens_reminder', 'deferred_tools_record', 'batching_reminder_sent',
  'bash_output_audience_note', 'environment', 'silent_turn_reminder', 'edited_text_file',
  'queued_command', 'prompt_snapshot', 'deferred_tools_delta', 'date', 'skill_listing',
  'remote_session_change', 'instructions', 'mcp_instructions_delta', 'credential_org', 'model',
  'session_context', 'agent_listing_delta', 'auto_mode', 'advisor_tool', 'file', 'command_permissions',
  'compact_file_reference', 'task_reminder', 'at_file', 'hook_error', 'hook_blocking_error',
  'hook_additional_context', 'hook_stopped_continuation', 'hook_system_message', 'hook_non_blocking_error',
  'goal_status', 'thinking_drop', 'plan_mode', 'plan_mode_exit',
]);

const HUMAN_PROMPT_SOURCES = new Set(['typed', 'queued', 'suggestion_accepted', 'sdk']);
/** First Claude Code version that stamps `promptSource` on human prompts. */
const PROMPT_SOURCE_SINCE = '2.1.281';

/** Compare dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const MAX_TURNS = 20;
const MAX_LOCAL_COMMANDS = 5;
const MAX_DENIALS = 5;
const MAX_HOOK_ERRORS = 10;
const MAX_API_ERRORS = 10;
const MAX_ARTIFACTS = 3;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function reportUnknown(s: ParseSession, kind: string, value: string): void {
  const key = `${kind}:${value}`;
  if (s.memo.unknownSeen.has(key)) return;
  s.memo.unknownSeen.add(key);
  s.ctx.onUnknown?.(kind, value);
}

function contentBlocks(entry: TranscriptEntry): ContentBlock[] {
  const c = entry.message?.content;
  return Array.isArray(c) ? c : [];
}

function contentText(entry: TranscriptEntry): string {
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join('');
  return '';
}

function toolResultText(block: ContentBlock): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  return '';
}

function firstLine(s: string): string {
  return s.split('\n').find(l => l.trim()) ?? '';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
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
    const args = (argsMatch[1] ?? '').trim();
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

function resolveTitle(state: SessionState): void {
  const t = state.titleSources;
  state.sessionTitle = t.custom ?? t.agent ?? t.ai;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function processEntry(s: ParseSession, entry: TranscriptEntry): void {
  const { state } = s;
  const entryTime = entry.timestamp ? new Date(entry.timestamp) : null;
  // Fallback for entries without timestamps: the last known activity time.
  const now = entryTime ?? state.lastActivity;

  const type = typeof entry.type === 'string' ? entry.type : '';
  if (type && !KNOWN_TYPES.has(type)) reportUnknown(s, 'type', type);

  // Metadata stamped on most entries. The last one seen wins.
  if (entry.cwd) state.cwd = entry.cwd;
  if (entry.gitBranch) state.gitBranch = entry.gitBranch;
  if (entry.effort) state.effortLevel = entry.effort;
  if (entry.version) state.version = entry.version;
  if (entry.entrypoint) state.entrypoint = entry.entrypoint;
  if (entry.slug) state.slug = entry.slug;

  switch (type) {
    case 'permission-mode':
      if (entry.permissionMode) state.permissions.mode = entry.permissionMode;
      return;
    case 'last-prompt':
      // Verbatim user prompt; overrides the tag-stripping heuristic. No timestamp.
      if (entry.lastPrompt) state.lastUserPrompt = entry.lastPrompt;
      return;
    case 'ai-title':
      if (entry.aiTitle) { state.titleSources.ai = entry.aiTitle; resolveTitle(state); }
      return;
    case 'custom-title':
      if (entry.customTitle) { state.titleSources.custom = entry.customTitle; resolveTitle(state); }
      return;
    case 'agent-name':
      if (entry.agentName) { state.titleSources.agent = entry.agentName; resolveTitle(state); }
      return;
    case 'cost-state':
      handleCostState(state, entry);
      return;
    case 'pr-link':
      handlePrLink(state, entry);
      return;
    case 'frame-link':
      handleFrameLink(state, entry);
      return;
    case 'bridge-session': {
      const raw = (entry as unknown as { bridgeSessionId?: unknown }).bridgeSessionId;
      state.remoteControl.bridgeSessionId = str(raw) ?? state.remoteControl.bridgeSessionId;
      return;
    }
    case 'file-history-delta':
      handleFileHistoryDelta(state, entry);
      return;
    case 'queue-operation':
      handleQueueOperation(s, entry, entryTime);
      return;
    case 'mode':
    case 'atis-latch':
    case 'file-history-snapshot':
    case 'artifact-comment-monitor':
    case 'artifact-autoreact-ledger':
    case 'dev-mods':
      return;
    default:
      break;
  }

  // Set startTime from the first timestamped entry
  if (entryTime && state.startTime.getTime() === 0) {
    state.startTime = entryTime;
  }

  if (type === 'system') {
    state.messageCount.system++;
    handleSystem(s, entry, entryTime);
  } else if (type === 'attachment') {
    handleAttachment(s, entry, entryTime);
  } else if (entry.message?.role === 'assistant') {
    handleAssistant(s, entry, entryTime, now);
  } else if (entry.message?.role === 'user') {
    handleUser(s, entry, entryTime, now);
  }

  // Track task entries (TaskCreate/TaskUpdate tools; absent on Claude 5 models)
  if (type === 'create' && entry.subject) {
    state.tasks.push({
      id: entry.taskId || '',
      subject: entry.subject,
      status: entry.status || 'pending',
    });
  }
  if (type === 'update' && entry.taskId) {
    const task = state.tasks.find(t => t.id === entry.taskId);
    if (task && entry.status) task.status = entry.status;
  }

  if (entryTime) state.lastActivity = entryTime;
}

// ---------------------------------------------------------------------------
// system.*
// ---------------------------------------------------------------------------

function handleSystem(s: ParseSession, entry: TranscriptEntry, time: Date | null): void {
  const { state } = s;
  const subtype = entry.subtype ?? '';
  if (subtype && !KNOWN_SYSTEM_SUBTYPES.has(subtype)) reportUnknown(s, 'system.subtype', subtype);
  switch (subtype) {
    case 'away_summary':
      if (entry.content) {
        state.recap.nativeRecap = cleanNativeRecap(entry.content);
        state.recap.nativeRecapTime = time;
      }
      break;
    case 'turn_duration':
      closeTurn(state, entry, time);
      break;
    case 'stop_hook_summary':
      state.hooks.stopBlocked = entry.preventedContinuation === true;
      state.hooks.lastStopHookCount = num(entry.hookCount) ?? 0;
      break;
    case 'compact_boundary': {
      const m = entry.compactMetadata;
      state.compactions.push({
        trigger: m?.trigger ?? 'unknown',
        preTokens: m?.preTokens ?? 0,
        postTokens: m?.postTokens ?? 0,
        durationMs: m?.durationMs ?? null,
        at: time,
      });
      break;
    }
    case 'bridge_status':
      state.remoteControl.active = /\bis active\b/i.test(entry.content ?? '');
      if (entry.url) state.remoteControl.url = entry.url;
      break;
    case 'local_command': {
      const cmd = entry.commandRun?.command ?? firstLine(entry.content ?? '');
      if (cmd) {
        state.localCommands.push({ command: cmd, args: entry.commandRun?.args ?? '', time });
        if (state.localCommands.length > MAX_LOCAL_COMMANDS) state.localCommands.shift();
      }
      break;
    }
    default:
      break;
  }
}

function closeTurn(state: SessionState, entry: TranscriptEntry, time: Date | null): void {
  const pending = num(entry.pendingBackgroundAgentCount) ?? 0;
  state.pendingBackgroundAgents = pending;
  state.hooks.stopBlocked = false;
  const turn = state.currentTurn;
  if (turn) {
    turn.endedAt = time;
    turn.durationMs = num(entry.durationMs);
    turn.messageCount = num(entry.messageCount);
    turn.pendingBackgroundAgents = pending;
    state.turns.push(turn);
    if (state.turns.length > MAX_TURNS) state.turns.shift();
    state.currentTurn = null;
  }
  state.recap.turnOpen = false;
  state.recap.liveNarration = null;
  state.recap.liveNarrationTime = null;
}

function openTurn(state: SessionState, origin: TurnOrigin, time: Date, preview: string, index: number | null): void {
  // An unclosed previous turn (e.g. interrupted) is closed without a duration.
  if (state.currentTurn) {
    state.turns.push(state.currentTurn);
    if (state.turns.length > MAX_TURNS) state.turns.shift();
  }
  const last = state.turns[state.turns.length - 1];
  const turn: TurnInfo = {
    index: index ?? (last ? last.index + 1 : 1),
    startedAt: time,
    endedAt: null,
    durationMs: null,
    messageCount: null,
    toolCalls: 0,
    promptPreview: preview.slice(0, 80),
    origin,
    pendingBackgroundAgents: 0,
  };
  state.currentTurn = turn;
  state.recap.turnOpen = true;
  state.recap.liveNarration = null;
  state.recap.liveNarrationTime = null;
}

// ---------------------------------------------------------------------------
// attachment.*
// ---------------------------------------------------------------------------

function handleAttachment(s: ParseSession, entry: TranscriptEntry, time: Date | null): void {
  const { state } = s;
  const att = entry.attachment;
  if (!att) return;
  const kind = typeof att.type === 'string' ? att.type : '';
  if (kind && !KNOWN_ATTACHMENT_TYPES.has(kind)) reportUnknown(s, 'attachment.type', kind);
  switch (kind) {
    case 'hook_success': {
      const event = str(att.hookEvent) ?? 'unknown';
      bump(state.hooks.byEvent, event);
      state.hooks.total++;
      const exit = num(att.exitCode) ?? 0;
      if (exit !== 0) {
        state.hooks.errors.push({
          hookName: str(att.hookName) ?? event,
          exitCode: exit,
          stderr: firstLine(str(att.stderr) ?? ''),
          time,
        });
        if (state.hooks.errors.length > MAX_HOOK_ERRORS) state.hooks.errors.shift();
      }
      break;
    }
    case 'queued_command': {
      const prompt = str(att.prompt);
      if (prompt && !prompt.trimStart().startsWith('<task-notification>')) {
        state.queue.preview = prompt.slice(0, 200);
      }
      break;
    }
    case 'environment': {
      const snap = asRecord(att.snapshot);
      const dir = str(snap?.scratchpadDirectory);
      if (dir) state.scratchpadDir = dir;
      break;
    }
    case 'auto_mode':
      state.permissions.autoMode = {
        bashFirst: att.bashFirst === true,
        steerOnly: att.steerOnly === true,
        bypass: att.bypass === true,
      };
      break;
    case 'edited_text_file': {
      const file = str(att.filename);
      if (file) {
        const existing = state.editedFiles.get(file);
        if (existing) existing.external = true;
        else state.editedFiles.set(file, { path: file, version: 0, lastEdit: time, external: true });
      }
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// assistant
// ---------------------------------------------------------------------------

function handleAssistant(s: ParseSession, entry: TranscriptEntry, time: Date | null, now: Date): void {
  const { state, memo } = s;
  const msg = entry.message!;
  const id = msg.id ?? null;
  const blocks = contentBlocks(entry);
  const isFirstLine = id === null || !memo.seenMessageIds.has(id);

  // Synthetic API error lines carry model "<synthetic>" — never let it become the session model.
  if (entry.isApiErrorMessage === true) {
    state.errors.api.push({
      status: num(entry.apiErrorStatus),
      code: str(entry.apiErrorCode),
      text: contentText(entry).slice(0, 80),
      time,
    });
    if (state.errors.api.length > MAX_API_ERRORS) state.errors.api.shift();
  } else if (msg.model && msg.model !== '<synthetic>') {
    state.model = msg.model;
  }
  if (entry.isAbortedMidStream === true) state.errors.abortedMidStream++;

  // Promote active skill when the assistant finishes a complete turn.
  if (msg.stop_reason === 'end_turn' && state.activeSkill) {
    promoteActiveSkill(state, now);
  }

  // --- once per API response ---
  if (isFirstLine) {
    if (id) memo.seenMessageIds.add(id);
    state.messageCount.assistant++;
    trackUsage(state, entry);
    if (entry.attributionSkill) bump(state.attribution.skills, entry.attributionSkill);
    if (entry.attributionPlugin) bump(state.attribution.plugins, entry.attributionPlugin);
    if (entry.attributionMcpServer) bump(state.attribution.mcpServers, entry.attributionMcpServer);
    if (entry.advisorModel) state.attribution.advisorModel = entry.advisorModel;
    const think = num(entry.thinkingDurationMs);
    if (think !== null) {
      memo.thinkingSumMs += think;
      state.attribution.thinkingSamples++;
      state.attribution.thinkingAvgMs = Math.round(memo.thinkingSumMs / state.attribution.thinkingSamples);
    }
    if (msg.usage?.speed === 'fast') state.attribution.fastMode = true;
  }

  // --- merge blocks into the grouped message ---
  const group = id ? getOrCreateMessage(s, id, msg, time ?? now) : null;
  if (group) {
    group.stopReason = msg.stop_reason ?? group.stopReason;
    if (msg.model && msg.model !== '<synthetic>') group.model = msg.model;
  }

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      if (group) group.texts.push(block.text);
      if (msg.stop_reason === 'tool_use' && state.currentTurn) {
        state.recap.liveNarration = block.text;
        state.recap.liveNarrationTime = time;
      }
    } else if (block.type === 'tool_use' && block.name) {
      if (group) group.toolUses++;
      trackToolUse(s, block, now);
    } else if (block.type === 'server_tool_use' && block.name === 'advisor') {
      state.attribution.advisorCalls++;
    }
  }

  // Final reply = last end_turn message (text may be split across lines of the same id).
  if (msg.stop_reason === 'end_turn' && entry.isApiErrorMessage !== true) {
    const texts = group ? group.texts : blocks.filter(b => b.type === 'text').map(b => b.text || '');
    const full = texts.join('\n').trim();
    if (full) {
      state.recap.finalReply = full;
      state.recap.finalReplyTime = group?.time ?? time;
      state.recap.finalReplyModel = group?.model ?? (msg.model !== '<synthetic>' ? msg.model ?? null : null);
      state.recap.koreanRecap = extractKoreanRecap(full);
    }
    state.recap.liveNarration = null;
    state.recap.liveNarrationTime = null;
  }
}

function getOrCreateMessage(s: ParseSession, id: string, msg: NonNullable<TranscriptEntry['message']>, time: Date): AssistantMessage {
  const { memo } = s;
  let m = memo.messages.get(id);
  if (m) return m;
  m = {
    id,
    texts: [],
    toolUses: 0,
    stopReason: msg.stop_reason ?? null,
    time,
    model: msg.model && msg.model !== '<synthetic>' ? msg.model : null,
  };
  memo.messages.set(id, m);
  memo.messageOrder.push(id);
  while (memo.messageOrder.length > MAX_KEPT_MESSAGES) {
    const old = memo.messageOrder.shift();
    if (old) memo.messages.delete(old);
  }
  return m;
}

function trackUsage(state: SessionState, entry: TranscriptEntry): void {
  const u = entry.message?.usage;
  if (!u) return;
  state.tokenUsage.input += u.input_tokens || 0;
  state.tokenUsage.output += u.output_tokens || 0;
  state.tokenUsage.cacheWrite += u.cache_creation_input_tokens || 0;
  state.tokenUsage.cacheRead += u.cache_read_input_tokens || 0;
  const totalInput = (u.input_tokens || 0)
    + (u.cache_creation_input_tokens || 0)
    + (u.cache_read_input_tokens || 0);
  if (totalInput > 0) {
    // Heuristic compaction detection: >30% drop between consecutive responses.
    if (state.contextTokens > 0 && totalInput < state.contextTokens * 0.7) {
      state.heuristicCompactionCount++;
    }
    state.contextTokens = totalInput;
    if (totalInput > state.maxContextTokens) state.maxContextTokens = totalInput;
  }
  const turnTotal = totalInput + (u.output_tokens || 0);
  if (turnTotal > 0) {
    state.tokenHistory.push(turnTotal);
    if (state.tokenHistory.length > 500) state.tokenHistory.shift();
  }
}

function trackToolUse(s: ParseSession, block: ContentBlock, ts: Date): void {
  const { state, memo } = s;
  const name = block.name!;
  const existing = state.toolStats.get(name);
  if (existing) {
    existing.count++;
    existing.lastUsed = ts;
  } else {
    state.toolStats.set(name, { name, count: 1, lastUsed: ts });
  }
  if (block.id) memo.pendingTools.set(block.id, { name, time: ts });
  if (state.currentTurn) state.currentTurn.toolCalls++;

  const mcp = /^mcp__(.+?)__/.exec(name);
  if (mcp?.[1]) bump(state.attribution.mcpServers, mcp[1]);

  const input = (block.input ?? {}) as Record<string, unknown>;

  if (name === 'Skill') {
    const skillName = str(input.skill) ?? 'unknown';
    const sk = state.skills.get(skillName);
    if (sk) {
      sk.count++;
      sk.lastUsed = ts;
    } else {
      state.skills.set(skillName, { name: skillName, count: 1, lastUsed: ts });
    }
    if (block.id) {
      promoteActiveSkill(state, ts);
      state.activeSkill = {
        name: skillName,
        args: str(input.args) ?? undefined,
        toolUseId: block.id,
        startTime: ts,
      };
    }
  }

  if (name === 'TeamCreate') {
    const teamName = str(input.team_name);
    if (teamName) state.sessionTeamNames.add(teamName);
  }

  // Background launches: remembered until the tool_result tells us the task id.
  if (block.id) {
    if (name === 'Agent') {
      memo.pendingBackground.set(block.id, {
        kind: 'agent',
        description: str(input.description) ?? '',
        agentType: str(input.subagent_type) ?? null,
        time: ts,
      });
    } else if (name === 'Bash' && input.run_in_background === true) {
      memo.pendingBackground.set(block.id, {
        kind: 'bash', description: str(input.description) ?? '', agentType: null, time: ts,
      });
    } else if (name === 'Monitor') {
      memo.pendingBackground.set(block.id, {
        kind: 'monitor', description: str(input.description) ?? str(input.command) ?? '', agentType: null, time: ts,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

function handleUser(s: ParseSession, entry: TranscriptEntry, time: Date | null, now: Date): void {
  const { state, memo } = s;
  state.messageCount.user++;
  const blocks = contentBlocks(entry);
  const text = contentText(entry);

  if (entry.interruptedMessageId) state.errors.interrupts++;
  // Human prompts carry the mode they were sent under (also a `permission-mode` entry on most versions).
  if (entry.permissionMode) state.permissions.mode = entry.permissionMode;

  // Permission decisions ride on tool_result entries.
  const pd = entry.permissionDecision;
  if (pd) {
    if (pd.decision === 'accept') state.permissions.decisions.accept++;
    else if (pd.decision === 'reject') state.permissions.decisions.reject++;
    bump(state.permissions.decisions.byReason, pd.reasonType ?? 'none');
  }

  // tool_result blocks: durations, denials, background launches
  for (const block of blocks) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue;
    const pending = memo.pendingTools.get(block.tool_use_id);
    if (pending && time) {
      const durationMs = time.getTime() - pending.time.getTime();
      if (durationMs >= 0) {
        const d = state.toolDurations.get(pending.name);
        if (d) {
          d.avgMs = (d.avgMs * d.count + durationMs) / (d.count + 1);
          d.maxMs = Math.max(d.maxMs, durationMs);
          d.count++;
        } else {
          state.toolDurations.set(pending.name, { name: pending.name, avgMs: durationMs, maxMs: durationMs, count: 1 });
        }
      }
    }
    if (entry.toolDenialKind) {
      state.permissions.denials.push({
        tool: pending?.name ?? null,
        kind: entry.toolDenialKind,
        reason: firstLine(toolResultText(block)).slice(0, 200),
        time,
      });
      if (state.permissions.denials.length > MAX_DENIALS) state.permissions.denials.shift();
    }
    handleToolUseResult(s, entry, block, pending?.name ?? null, now);
    memo.pendingTools.delete(block.tool_use_id);
  }

  // Task notifications delivered as a prompt (origin.kind task-notification).
  if (text.includes('<task-notification>')) {
    for (const chunk of text.split('<task-notification>').slice(1)) {
      applyTaskNotification(state, `<task-notification>${chunk}`, now);
    }
  }
  if (entry.isCompactSummary === true) return;

  // --- turn boundaries & the real prompt ---
  const realPrompt = extractRealUserPrompt(text);
  const origin = turnOriginOf(entry, realPrompt, state.version);
  if (origin) {
    const idx = num(entry.turnPosition?.turnIndex);
    openTurn(state, origin, now, realPrompt ?? '', idx);
    if (origin === 'human') {
      memo.lastHumanPromptTime = now;
      if (entry.promptSource === 'queued') {
        memo.queueDequeued++;
        recomputeQueue(s);
      }
    }
  }

  if (realPrompt && origin !== 'task_notification') {
    state.lastUserPrompt = realPrompt;
    state.lastUserPromptTime = now;
  }

  // Slash-command skills (<command-name>/skill</command-name>)
  const cmdMatch = text.match(/<command-name>\/?(.+?)<\/command-name>/);
  if (cmdMatch?.[1]) {
    const skillName = cmdMatch[1];
    const existing = state.skills.get(skillName);
    if (existing) {
      existing.count++;
      existing.lastUsed = now;
    } else {
      state.skills.set(skillName, { name: skillName, count: 1, lastUsed: now });
    }
    promoteActiveSkill(state, now);
    state.activeSkill = {
      name: skillName,
      args: undefined,
      toolUseId: `cmd-${skillName}-${now.getTime()}`,
      startTime: now,
    };
  } else if (state.activeSkill && realPrompt) {
    // A non-skill user prompt while a skill is active means the skill completed.
    promoteActiveSkill(state, now);
  }
}

/** Decide whether this user entry starts a turn, and with which origin. */
function turnOriginOf(entry: TranscriptEntry, realPrompt: string | null, version: string | null): TurnOrigin | null {
  if (entry.turnOrigin === 'task_notification') return 'task_notification';
  if (entry.turnOrigin === 'peer') return 'peer';
  if (entry.turnOrigin === 'human') return 'human';
  if (entry.promptSource && HUMAN_PROMPT_SOURCES.has(entry.promptSource)) return 'human';
  if (entry.promptSource !== undefined || entry.turnOrigin !== undefined) return null;
  if (entry.isMeta === true) return null;
  // Transcripts written before promptSource existed: a user entry with real text is a human prompt.
  const old = version === null || compareVersions(version, PROMPT_SOURCE_SINCE) < 0;
  return old && realPrompt ? 'human' : null;
}

function handleToolUseResult(
  s: ParseSession, entry: TranscriptEntry, block: ContentBlock, toolName: string | null, now: Date,
): void {
  const { state, memo } = s;
  const launch = memo.pendingBackground.get(block.tool_use_id!);
  const r = asRecord(entry.toolUseResult);

  // Edited files (Write/Edit carry filePath in the structured result)
  if (r && (toolName === 'Write' || toolName === 'Edit')) {
    const filePath = str(r.filePath);
    if (filePath) {
      const existing = state.editedFiles.get(filePath);
      if (existing) {
        existing.lastEdit = now;
      } else {
        state.editedFiles.set(filePath, { path: filePath, version: 1, lastEdit: now, external: false });
      }
    }
  }

  if (!launch) return;
  memo.pendingBackground.delete(block.tool_use_id!);

  if (r && r.status === 'async_launched') {
    const id = str(r.agentId) ?? block.tool_use_id!;
    upsertTask(state, {
      id,
      kind: launch.kind === 'monitor' ? 'monitor' : 'agent',
      agentType: launch.agentType,
      description: str(r.description) ?? launch.description,
      model: str(r.resolvedModel),
      startedAt: launch.time,
      endedAt: null,
      status: 'running',
      exitCode: null,
      outputFile: str(r.outputFile),
      outputBytes: 0,
      toolUseId: block.tool_use_id!,
      summary: null,
    });
    return;
  }
  const bgId = r ? str(r.backgroundTaskId) : null;
  if (bgId) {
    const resultText = toolResultText(block);
    const fileMatch = /written to:\s*(\S+\.output)/.exec(resultText);
    upsertTask(state, {
      id: bgId,
      kind: launch.kind === 'agent' ? 'agent' : launch.kind,
      agentType: launch.agentType,
      description: launch.description,
      model: null,
      startedAt: launch.time,
      endedAt: null,
      status: 'running',
      exitCode: null,
      outputFile: fileMatch?.[1] ?? null,
      outputBytes: 0,
      toolUseId: block.tool_use_id!,
      summary: null,
    });
  }
}

function upsertTask(state: SessionState, task: BackgroundTask): void {
  const existing = state.backgroundTasks.get(task.id);
  if (!existing) {
    state.backgroundTasks.set(task.id, task);
    return;
  }
  // A notification may have arrived before the launch result (unlikely, but cheap to handle).
  existing.kind = task.kind;
  existing.agentType = task.agentType ?? existing.agentType;
  existing.description = task.description || existing.description;
  existing.model = task.model ?? existing.model;
  existing.startedAt = task.startedAt;
  existing.outputFile = task.outputFile ?? existing.outputFile;
  existing.toolUseId = task.toolUseId ?? existing.toolUseId;
}

function applyTaskNotification(state: SessionState, text: string, now: Date): void {
  const n = parseTaskNotification(text);
  if (!n) return;
  let task = state.backgroundTasks.get(n.id);
  if (!task) {
    const isAgent = /^Agent\b/.test(n.summary ?? '') || n.id.length > 12;
    task = {
      id: n.id,
      kind: isAgent ? 'agent' : 'bash',
      agentType: null,
      description: /"([^"]+)"/.exec(n.summary ?? '')?.[1] ?? '',
      model: null,
      startedAt: now,
      endedAt: null,
      status: 'running',
      exitCode: null,
      outputFile: n.outputFile,
      outputBytes: 0,
      toolUseId: n.toolUseId,
      summary: null,
    };
    state.backgroundTasks.set(n.id, task);
  }
  if (n.status === 'completed' || n.status === 'failed') {
    task.status = n.exitCode !== null && n.exitCode !== 0 ? 'failed' : n.status;
    task.endedAt = task.endedAt ?? now;
    task.exitCode = n.exitCode;
  }
  if (n.summary) task.summary = n.summary;
  if (n.outputFile && !task.outputFile) task.outputFile = n.outputFile;
}

// ---------------------------------------------------------------------------
// queue-operation
// ---------------------------------------------------------------------------

function handleQueueOperation(s: ParseSession, entry: TranscriptEntry, time: Date | null): void {
  const { state, memo } = s;
  switch (entry.operation) {
    case 'enqueue': memo.queueEnqueued++; break;
    case 'dequeue': memo.queueDequeued++; break;
    case 'remove': memo.queueRemoved++; break;
    default: break;
  }
  const content = entry.content ?? '';
  if (content.includes('<task-notification>')) {
    if (entry.operation === 'enqueue') {
      for (const chunk of content.split('<task-notification>').slice(1)) {
        applyTaskNotification(state, `<task-notification>${chunk}`, time ?? state.lastActivity);
      }
    }
  } else if (entry.operation === 'enqueue' && content.trim()) {
    state.queue.preview = content.slice(0, 200);
  }
  recomputeQueue(s);
}

function recomputeQueue(s: ParseSession): void {
  const { state, memo } = s;
  state.queue.depth = Math.max(0, memo.queueEnqueued - memo.queueDequeued - memo.queueRemoved);
  if (state.queue.depth === 0) state.queue.preview = null;
}

// ---------------------------------------------------------------------------
// misc top-level entries
// ---------------------------------------------------------------------------

function handleCostState(state: SessionState, entry: TranscriptEntry): void {
  const perModel: Record<string, number> = {};
  for (const [model, u] of Object.entries(entry.modelUsage ?? {})) {
    perModel[model] = num(u?.costUSD) ?? 0;
  }
  state.cost = {
    totalUSD: num(entry.totalCostUSD) ?? 0,
    apiDurationMs: num(entry.totalAPIDuration) ?? 0,
    toolDurationMs: num(entry.totalToolDuration) ?? 0,
    linesAdded: num(entry.totalLinesAdded) ?? 0,
    linesRemoved: num(entry.totalLinesRemoved) ?? 0,
    perModel,
    hasUnknownModelCost: entry.hasUnknownModelCost === true,
    isPrevious: false,
  };
}

function handlePrLink(state: SessionState, entry: TranscriptEntry): void {
  const number = num(entry.prNumber);
  const url = str(entry.prUrl);
  if (number === null || !url) return;
  const repository = str(entry.prRepository) ?? '';
  const time = entry.timestamp ? new Date(entry.timestamp) : null;
  const idx = state.links.prs.findIndex(p => p.number === number && p.repository === repository);
  const row = { number, url, repository, time };
  if (idx >= 0) state.links.prs[idx] = row;
  else state.links.prs.push(row);
}

function handleFrameLink(state: SessionState, entry: TranscriptEntry): void {
  const url = str(entry.frameUrl);
  if (!url) return;
  const title = str(entry.title) ?? url;
  const time = entry.timestamp ? new Date(entry.timestamp) : null;
  const idx = state.links.artifacts.findIndex(a => a.url === url);
  if (idx >= 0) state.links.artifacts.splice(idx, 1);
  state.links.artifacts.push({ title, url, path: str(entry.path), time });
  while (state.links.artifacts.length > MAX_ARTIFACTS) state.links.artifacts.shift();
}

function handleFileHistoryDelta(state: SessionState, entry: TranscriptEntry): void {
  const path = str(entry.trackingPath);
  if (!path) return;
  const version = num(entry.backup?.version) ?? 1;
  const when = entry.backup?.backupTime ? new Date(entry.backup.backupTime) : null;
  const existing = state.editedFiles.get(path);
  if (existing) {
    existing.version = Math.max(existing.version, version);
    existing.lastEdit = when ?? existing.lastEdit;
  } else {
    state.editedFiles.set(path, { path, version, lastEdit: when, external: false });
  }
}
