import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { SessionState, TeamInfo, TranscriptEntry } from './types.js';

const CLAUDE_DIR = join(homedir(), '.claude');

/**
 * Convert a CWD path to the Claude project directory name.
 * Claude Code replaces '/' with '-', e.g. /Users/foo/bar → -Users-foo-bar
 */
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/\//g, '-');
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
  };

  if (!existsSync(transcriptFile)) return state;

  const content = readFileSync(transcriptFile, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      processEntry(state, entry);
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

  return state;
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

function processEntry(state: SessionState, entry: TranscriptEntry): void {
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

  // Track skills invoked via slash commands (<command-name>/skill</command-name> in user messages)
  if (entry.message?.role === 'user') {
    const content = entry.message.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(b => b.type === 'text').map(b => b.text || '').join('')
        : '';
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
        state.contextTokens = totalInput;
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
