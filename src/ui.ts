import type { SessionState } from './types.js';
import pkg from '../package.json';

// ANSI escape helpers
const ESC = '\x1b';
const CSI = `${ESC}[`;
const CLEAR = `${CSI}2J${CSI}H`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const RESET = `${CSI}0m`;
const UNDERLINE = `${CSI}4m`;

const FG = {
  black: `${CSI}30m`, red: `${CSI}31m`, green: `${CSI}32m`,
  yellow: `${CSI}33m`, blue: `${CSI}34m`, magenta: `${CSI}35m`,
  cyan: `${CSI}36m`, white: `${CSI}37m`, gray: `${CSI}90m`,
};
const BG = {
  black: `${CSI}40m`, blue: `${CSI}44m`, cyan: `${CSI}46m`,
  yellow: `${CSI}43m`, gray: `${CSI}100m`,
  // Bright variants (ANSI 90-107 range): more vivid than standard
  brightBlue: `${CSI}104m`,
  // Truecolor (24-bit) — deterministic RGB regardless of terminal theme.
  // Title bar uses Tailwind blue-900 (#1e3a8a), a deep saturated navy.
  deepBlue: `${CSI}48;2;30;58;138m`,
};

// Truecolor foreground entries for when ANSI palette colors aren't precise enough.
// Used sparingly — most text still uses the FG table above.
const FG_PURE_WHITE = `${CSI}38;2;255;255;255m`; // #ffffff

function pad(s: string, len: number): string {
  const dw = displayWidth(s);
  return dw >= len ? s : s + ' '.repeat(len - dw);
}

function rpad(s: string, len: number): string {
  const dw = displayWidth(s);
  return dw >= len ? s : ' '.repeat(len - dw) + s;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Calculate terminal display width accounting for CJK fullwidth characters */
function displayWidth(s: string): number {
  const stripped = stripAnsi(s);
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) || 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||  // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||  // CJK Radicals, Kangxi, CJK Symbols
      (cp >= 0x3040 && cp <= 0x33bf) ||  // Hiragana, Katakana, Bopomofo, CJK Compat
      (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK Unified Ext A
      (cp >= 0x4e00 && cp <= 0xa4cf) ||  // CJK Unified, Yi
      (cp >= 0xa960 && cp <= 0xa97c) ||  // Hangul Jamo Extended-A
      (cp >= 0xac00 && cp <= 0xd7a3) ||  // Hangul Syllables
      (cp >= 0xd7b0 && cp <= 0xd7fb) ||  // Hangul Jamo Extended-B
      (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK Compat Ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) ||  // CJK Compat Forms
      (cp >= 0xff01 && cp <= 0xff60) ||  // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||  // Fullwidth Signs
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B-F
      (cp >= 0x30000 && cp <= 0x3fffd)    // CJK Ext G+
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * Word-wrap text to a given display width, accounting for CJK fullwidth
 * characters. Breaks on whitespace where possible; falls back to character
 * boundaries for tokens longer than the line width. Preserves explicit \n
 * as hard line breaks.
 */
function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const tokens = paragraph.split(/(\s+)/); // keep whitespace separators
    let current = '';
    let currentW = 0;
    for (const token of tokens) {
      if (!token) continue;
      const tokenW = displayWidth(token);
      if (tokenW > width) {
        // Token longer than a full line — break at character boundaries.
        if (current) {
          lines.push(current);
          current = '';
          currentW = 0;
        }
        for (const ch of token) {
          const chW = displayWidth(ch);
          if (currentW + chW > width) {
            lines.push(current);
            current = ch;
            currentW = chW;
          } else {
            current += ch;
            currentW += chW;
          }
        }
      } else if (currentW + tokenW > width) {
        lines.push(current);
        // Don't start a new line with leading whitespace.
        if (/^\s+$/.test(token)) {
          current = '';
          currentW = 0;
        } else {
          current = token;
          currentW = tokenW;
        }
      } else {
        current += token;
        currentW += tokenW;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

function boxLine(content: string, width: number, color: string = FG.cyan): string {
  const dw = displayWidth(content);
  // │ + space + content + padding + │ = width
  const padding = Math.max(0, width - 3 - dw);
  return `${color}│${RESET} ${content}${' '.repeat(padding)}${color}│${RESET}`;
}

function boxTop(title: string, width: number, color: string = FG.cyan): string {
  // ┌─ TITLE ───...───┐ = width
  const inner = width - 5 - displayWidth(title);
  return `${color}┌─ ${BOLD}${title}${RESET}${color} ${'─'.repeat(Math.max(0, inner))}┐${RESET}`;
}

function boxBottom(width: number, color: string = FG.cyan): string {
  return `${color}└${'─'.repeat(width - 2)}┘${RESET}`;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running':
    case 'in_progress':
      return `${FG.yellow}●${RESET}`;
    case 'completed':
      return `${FG.green}✔${RESET}`;
    case 'error':
      return `${FG.red}✘${RESET}`;
    case 'pending':
      return `${FG.gray}○${RESET}`;
    default:
      return `${FG.gray}?${RESET}`;
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Render a braille sparkline from an array of numeric values.
 * Each braille character encodes two vertical dots (upper/lower),
 * mapping value magnitude to one of 4 levels (⠀ ⣀ ⣤ ⣶ ⣿).
 */
function sparkline(values: number[], width: number): string {
  if (values.length === 0) return '';
  // Take the last `width * 2` values (each char encodes 2 values)
  const maxChars = width;
  const slice = values.slice(-maxChars);
  const maxVal = Math.max(...slice, 1);
  const chars: string[] = [];
  for (const v of slice) {
    const ratio = v / maxVal;
    if (ratio <= 0) chars.push('⣀');
    else if (ratio < 0.25) chars.push('⣀');
    else if (ratio < 0.5) chars.push('⣤');
    else if (ratio < 0.75) chars.push('⣶');
    else chars.push('⣿');
  }
  return chars.join('');
}

export function render(
  state: SessionState | null,
  fileEvents: Array<{ path: string; time: Date; event: string }>,
  isSwitchedView: boolean = false,
): void {
  // Reserve the last column to avoid the terminal "last-column auto-wrap" bug
  // that pushes right borders off-screen in tmux/iTerm2/SSH sessions.
  const W = Math.max(20, (process.stdout.columns || 80) - 1);

  const lines: string[] = [];
  const now = new Date();

  // Header bar — deep blue (#1e3a8a) background with pure white (#ffffff)
  // bold text. Using 24-bit truecolor gives deterministic rendering across
  // terminal themes (modern terminals support this). The deep saturated
  // navy is more "substantial" than the previous bright blue.
  const headerText = ` Claude Code Monitor v${pkg.version} `;
  const timeText = ` ${formatTime(now)} `;
  const headerPad = W - headerText.length - timeText.length;
  lines.push(
    `${BG.deepBlue}${FG_PURE_WHITE}${BOLD}${headerText}${' '.repeat(Math.max(0, headerPad))}${timeText}${RESET}`,
  );
  // Current working directory + git branch (if available)
  const cwdPath = state ? state.projectDir.replace(/.*projects\//, '').replace(/-/g, '/') : process.cwd();
  const branchSuffix = state?.gitBranch
    ? ` ${FG.magenta}[${state.gitBranch}]${RESET}`
    : '';
  lines.push(`${DIM} ${cwdPath}${RESET}${branchSuffix}`);

  if (!state) {
    lines.push('');
    lines.push(`${FG.yellow}  No active session found. Waiting for activity...${RESET}`);
    lines.push('');
    process.stdout.write(CLEAR + HIDE_CURSOR + lines.join('\n') + '\n');
    return;
  }

  // Session info (2 lines for narrow screens)
  const sessionAge = formatDuration(now.getTime() - state.startTime.getTime());
  const sinceActivity = formatDuration(now.getTime() - state.lastActivity.getTime());
  const ctxPct = state.contextPercent;
  const ctxColor = ctxPct >= 85 ? FG.red : ctxPct >= 70 ? FG.yellow : FG.green;
  // Effort level color-codes intensity so it's legible at a glance:
  // xhigh = magenta (most distinctive), high = red, medium = yellow, low = gray.
  const effortColor = (() => {
    switch (state.effortLevel) {
      case 'xhigh': return FG.magenta;
      case 'high': return FG.red;
      case 'medium': return FG.yellow;
      case 'low': return FG.gray;
      default: return FG.cyan;
    }
  })();
  // `/effort max` accepts "max" as input but Claude Code persists it as "xhigh".
  // Show the user-facing label so the monitor matches what the user typed.
  const effortLabel = state.effortLevel === 'xhigh' ? 'max' : state.effortLevel;
  const effortPart = state.effortLevel
    ? `${DIM} Effort:${RESET}${effortColor}${effortLabel}${RESET}`
    : '';
  lines.push(
    `${DIM} Session:${RESET}${FG.cyan}${state.sessionId.slice(0, 8)}${RESET}` +
    `${DIM} Model:${RESET}${FG.green}${state.model}${RESET}` +
    effortPart +
    `${DIM} Ctx:${RESET}${ctxColor}${ctxPct}%${RESET}` +
    `${DIM} Age:${RESET}${sessionAge}` +
    `${DIM} Idle:${RESET}${sinceActivity}`,
  );
  // Active sessions on its own line — total count + other project basenames
  // (dedicated line means we can show more project names without crowding)
  const sessionsTotal = state.activeSessions.length;
  const otherProjects = state.activeSessions
    .filter(s => s.sessionId !== state.sessionId && s.cwd)
    .map(s => s.cwd.split('/').pop() || '')
    .filter(Boolean);
  const MAX_PROJECTS_SHOWN = 4;
  const otherProjectsDisplay = otherProjects.length > 0
    ? ` ${DIM}(+${otherProjects.slice(0, MAX_PROJECTS_SHOWN).join(', ')}${otherProjects.length > MAX_PROJECTS_SHOWN ? `, +${otherProjects.length - MAX_PROJECTS_SHOWN}` : ''})${RESET}`
    : '';
  const memPart = state.processMemMb > 0
    ? `${DIM} Mem:${RESET}${FG.cyan}${state.processMemMb}MB${RESET}`
    : '';
  lines.push(
    `${DIM} Sess:${RESET}${FG.cyan}${sessionsTotal}${RESET}${otherProjectsDisplay}${memPart}`,
  );
  const { input, output, cacheWrite, cacheRead } = state.tokenUsage;
  lines.push(
    `${DIM} Msgs:${RESET}${FG.blue}U:${state.messageCount.user} A:${state.messageCount.assistant}${RESET}` +
    `${DIM} Tok:${RESET}` +
    `${FG.cyan}I:${formatTokens(input)}${RESET} ` +
    `${FG.magenta}O:${formatTokens(output)}${RESET} ` +
    `${FG.yellow}CW:${formatTokens(cacheWrite)}${RESET} ` +
    `${FG.green}CR:${formatTokens(cacheRead)}${RESET}` +
    `${DIM} Files:${RESET}${FG.yellow}${state.editedFilesCount}${RESET}`,
  );

  // Token analytics line: burn rate, compaction count, peak context, sparkline
  const burnRateStr = state.tokenBurnRate > 0
    ? `${FG.cyan}${formatTokens(state.tokenBurnRate)}${RESET}${DIM}/min${RESET}`
    : `${DIM}--${RESET}`;
  const compactStr = state.compactionCount > 0
    ? `${FG.yellow}${state.compactionCount}${RESET}`
    : `${FG.green}0${RESET}`;
  const peakStr = state.maxContextTokens > 0
    ? `${FG.cyan}${formatTokens(state.maxContextTokens)}${RESET}`
    : `${DIM}--${RESET}`;
  const sparkW = Math.min(20, Math.max(0, W - 60));
  const spark = state.tokenHistory.length > 1
    ? ` ${DIM}${sparkline(state.tokenHistory, sparkW)}${RESET}`
    : '';
  lines.push(
    `${DIM} Rate:${RESET}${burnRateStr}` +
    `${DIM} Compact:${RESET}${compactStr}` +
    `${DIM} Peak:${RESET}${peakStr}` +
    spark,
  );

  // --- Rate Limit Quota (from abtop or OMC) ---
  if (state.rateLimit) {
    const rl = state.rateLimit;
    const staleTag = rl.isStale ? ` ${FG.gray}(stale)${RESET}` : '';
    const fiveColor = (rl.fiveHourPct ?? 0) >= 80 ? FG.red : (rl.fiveHourPct ?? 0) >= 50 ? FG.yellow : FG.green;
    const weekColor = (rl.weeklyPct ?? 0) >= 80 ? FG.red : (rl.weeklyPct ?? 0) >= 50 ? FG.yellow : FG.green;
    // Only show reset countdown when the reset time is in the future
    const resetCountdown = (epochSec: number | null): string => {
      if (!epochSec) return '';
      const remainMs = (epochSec * 1000) - Date.now();
      if (remainMs <= 0) return '';
      return ` ${DIM}(${formatDuration(remainMs)})${RESET}`;
    };
    const fiveReset = resetCountdown(rl.fiveHourResetsAt);
    const weekReset = resetCountdown(rl.weeklyResetsAt);
    // Inline bar: ████░░░░░░ style, 10 chars wide
    const bar = (pct: number, color: string): string => {
      const filled = Math.round(pct / 10);
      const empty = 10 - filled;
      return `${color}${'█'.repeat(filled)}${FG.gray}${'░'.repeat(empty)}${RESET}`;
    };
    const fivePct = rl.fiveHourPct ?? 0;
    const weekPct = rl.weeklyPct ?? 0;
    lines.push(
      `${DIM} Quota 5h:${RESET}${bar(fivePct, fiveColor)} ${fiveColor}${fivePct.toFixed(0)}%${RESET}${fiveReset}` +
      `${DIM} wk:${RESET}${bar(weekPct, weekColor)} ${weekColor}${weekPct.toFixed(0)}%${RESET}${weekReset}${staleTag}`,
    );
  }

  // --- Last User Prompt ---
  const promptTitle = state.lastUserPromptTime
    ? `Last Prompt  ${formatTime(state.lastUserPromptTime)}`
    : 'Last Prompt';
  lines.push(boxTop(promptTitle, W, FG.white));
  if (state.lastUserPrompt) {
    const MAX_CHARS = 500;
    // Count true characters (Array.from handles surrogate-pair emoji correctly).
    const chars = Array.from(state.lastUserPrompt);
    const displayText = chars.length > MAX_CHARS
      ? chars.slice(0, MAX_CHARS - 3).join('') + '...'
      : state.lastUserPrompt;
    const innerW = Math.max(10, W - 4); // box borders + padding
    for (const wrapped of wordWrap(displayText, innerW)) {
      lines.push(boxLine(`${FG.white}${wrapped}${RESET}`, W, FG.white));
    }
  } else {
    lines.push(boxLine(`${DIM}(no user prompt yet)${RESET}`, W, FG.white));
  }
  lines.push(boxBottom(W, FG.white));

  // --- Tools (compact: wrapped inside box) ---
  const sortedTools = [...state.toolStats.values()].sort((a, b) => b.count - a.count);
  lines.push(boxTop('Tools', W, FG.cyan));
  if (sortedTools.length === 0) {
    lines.push(boxLine(`${DIM}(no tools used yet)${RESET}`, W));
  } else {
    // Build chips: "Bash:11"
    const chips: string[] = [];
    const chipTexts: string[] = [];
    for (const t of sortedTools) {
      chips.push(`${FG.green}${t.name}${RESET}${DIM}:${t.count}${RESET}`);
      chipTexts.push(`${t.name}:${t.count}`);
    }
    const innerW = W - 4; // box borders + padding
    let currentLine = '';
    let currentLen = 0;
    for (let i = 0; i < chips.length; i++) {
      const chipLen = chipTexts[i].length;
      if (currentLen > 0 && currentLen + 1 + chipLen > innerW) {
        lines.push(boxLine(currentLine, W));
        currentLine = chips[i];
        currentLen = chipLen;
      } else {
        currentLine += (currentLen > 0 ? ' ' : '') + chips[i];
        currentLen += (currentLen > 0 ? 1 : 0) + chipLen;
      }
    }
    if (currentLen > 0) {
      lines.push(boxLine(currentLine, W));
    }
  }
  lines.push(boxBottom(W, FG.cyan));

  // --- Subagents (only running; completed count shown) ---
  const allAgents = [...state.subagents.values()];
  const runningAgents = allAgents.filter(a => a.status === 'running');
  const completedCount = allAgents.filter(a => a.status === 'completed').length;
  const errorCount = allAgents.filter(a => a.status === 'error').length;

  const agentSuffix = completedCount > 0 || errorCount > 0
    ? ` ${DIM}(${FG.green}${completedCount} done${RESET}${errorCount > 0 ? `${DIM}, ${FG.red}${errorCount} err${RESET}` : ''}${DIM})${RESET}`
    : '';
  lines.push(boxTop(`Subagents${stripAnsi(agentSuffix) ? '' : ''}`, W, FG.green));

  if (runningAgents.length === 0 && completedCount === 0) {
    lines.push(boxLine(`${DIM}(no subagents)${RESET}`, W, FG.green));
  } else if (runningAgents.length === 0) {
    lines.push(boxLine(`${DIM}All ${completedCount} subagent(s) completed${RESET}`, W, FG.green));
  }
  for (const a of runningAgents.slice(-8)) {
    const dur = formatDuration(now.getTime() - a.startTime.getTime());
    const descMax = Math.max(0, W - 32);
    const desc = a.description.slice(0, descMax);
    lines.push(boxLine(
      `${statusIcon(a.status)} ${FG.cyan}${pad(a.type, 12)}${RESET} ${DIM}${rpad(dur, 6)}${RESET} ${desc}`,
      W, FG.green,
    ));
  }
  if (runningAgents.length > 8) {
    lines.push(boxLine(`${DIM}  ... +${runningAgents.length - 8} more running${RESET}`, W, FG.green));
  }
  lines.push(boxBottom(W, FG.green));

  // --- Active Skill ---
  lines.push(boxTop('Skill', W, FG.magenta));
  if (state.activeSkill) {
    const dur = formatDuration(now.getTime() - state.activeSkill.startTime.getTime());
    const argsDisplay = state.activeSkill.args ? ` ${DIM}(${state.activeSkill.args.slice(0, 30)})${RESET}` : '';
    lines.push(boxLine(
      `${statusIcon('running')} ${FG.yellow}/${state.activeSkill.name}${RESET}${argsDisplay} ${DIM}${dur}${RESET}`,
      W, FG.magenta,
    ));
  } else if (state.lastCompletedSkill) {
    const argsDisplay = state.lastCompletedSkill.args ? ` ${DIM}(${state.lastCompletedSkill.args.slice(0, 30)})${RESET}` : '';
    lines.push(boxLine(
      `${FG.green}✔${RESET} ${FG.cyan}/${state.lastCompletedSkill.name}${RESET}${argsDisplay} ${DIM}at ${formatTime(state.lastCompletedSkill.endTime)}${RESET}`,
      W, FG.magenta,
    ));
  } else {
    lines.push(boxLine(`${DIM}(no skills invoked)${RESET}`, W, FG.magenta));
  }
  // Show skill history (skip the first entry if it matches lastCompletedSkill)
  const historyStart = (state.lastCompletedSkill && state.skillHistory.length > 0
    && state.skillHistory[0].name === state.lastCompletedSkill.name
    && state.skillHistory[0].endTime === state.lastCompletedSkill.endTime) ? 1 : 0;
  for (const h of state.skillHistory.slice(historyStart, historyStart + 5)) {
    const hArgs = h.args ? ` (${h.args.slice(0, 20)})` : '';
    lines.push(boxLine(
      `${DIM}  /${h.name}${hArgs} at ${formatTime(h.endTime)}${RESET}`,
      W, FG.magenta,
    ));
  }
  lines.push(boxBottom(W, FG.magenta));

  // --- Teams ---
  lines.push(boxTop('Teams', W, FG.blue));
  if (state.teams.length === 0) {
    lines.push(boxLine(`${DIM}(no teams)${RESET}`, W, FG.blue));
  }
  for (const team of state.teams) {
    const memberCount = team.members.length > 0 ? ` ${DIM}(${team.members.length})${RESET}` : '';
    lines.push(boxLine(
      `${FG.yellow}${team.name}${RESET}${memberCount}`,
      W, FG.blue,
    ));
    for (const member of team.members) {
      lines.push(boxLine(
        `${DIM}  ${member}${RESET}`,
        W, FG.blue,
      ));
    }
  }
  lines.push(boxBottom(W, FG.blue));

  // --- Tasks ---
  lines.push(boxTop('Tasks', W, FG.yellow));
  if (state.tasks.length === 0) {
    lines.push(boxLine(`${DIM}(no tasks)${RESET}`, W, FG.yellow));
  }
  for (const t of state.tasks.slice(-6)) {
    lines.push(boxLine(
      `${statusIcon(t.status)} ${pad(t.subject || '', W - 8)}`,
      W, FG.yellow,
    ));
  }
  lines.push(boxBottom(W, FG.yellow));

  // --- Memory ---
  lines.push(boxTop('Memory', W, FG.blue));
  if (!state.memory) {
    lines.push(boxLine(`${DIM}(no memory yet)${RESET}`, W, FG.blue));
  } else {
    const m = state.memory;
    // Line 1: index status + topic count + last-modified ago
    const indexPart = m.hasIndex
      ? `${FG.cyan}MEMORY.md${RESET}${DIM} (${m.indexLines} lines)${RESET}`
      : `${DIM}(no index)${RESET}`;
    const topicPart = m.topicCount > 0
      ? ` ${DIM}+${RESET} ${FG.yellow}${m.topicCount} topic${m.topicCount === 1 ? '' : 's'}${RESET}`
      : '';
    const ageSuffix = m.lastModified
      ? ` ${DIM}last: ${formatDuration(now.getTime() - m.lastModified.getTime())} ago${RESET}`
      : '';
    lines.push(boxLine(`${indexPart}${topicPart}${ageSuffix}`, W, FG.blue));

    // Line 2 (optional): category breakdown, if there are topics
    if (m.topicCount > 0) {
      const cats = Object.entries(m.categoryBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `${FG.magenta}${cat}${RESET}${DIM}:${n}${RESET}`)
        .join(' ');
      lines.push(boxLine(`${DIM}  categories:${RESET} ${cats}`, W, FG.blue));
    }
    // Line 3 (optional): most recently modified topic names
    if (m.recentTopics.length > 0) {
      const topics = m.recentTopics.map(t => `${FG.cyan}${t}${RESET}`).join(`${DIM}, ${RESET}`);
      lines.push(boxLine(`${DIM}  recent:${RESET} ${topics}`, W, FG.blue));
    }
  }
  lines.push(boxBottom(W, FG.blue));

  // --- Child Processes (only shown when non-empty) ---
  if (state.childProcesses.length > 0) {
    lines.push(boxTop('Processes', W, FG.gray));
    for (const cp of state.childProcesses.slice(0, 5)) {
      const cmdDisplay = cp.command.length > W - 25
        ? cp.command.slice(0, W - 28) + '...'
        : cp.command;
      lines.push(boxLine(
        `${DIM}pid:${RESET}${FG.cyan}${cp.pid}${RESET} ${DIM}mem:${RESET}${FG.yellow}${cp.memMb}MB${RESET} ${cmdDisplay}`,
        W, FG.gray,
      ));
    }
    if (state.childProcesses.length > 5) {
      lines.push(boxLine(`${DIM}  ... +${state.childProcesses.length - 5} more${RESET}`, W, FG.gray));
    }
    lines.push(boxBottom(W, FG.gray));
  }

  // --- File Activity ---
  lines.push(boxTop('File Activity', W, FG.gray));
  const recentEvents = fileEvents.slice(-8);
  if (recentEvents.length === 0) {
    lines.push(boxLine(`${DIM}(watching for changes...)${RESET}`, W, FG.gray));
  }
  for (const ev of recentEvents) {
    const evColor = ev.event === 'add' ? FG.green : ev.event === 'change' ? FG.yellow : FG.red;
    const shortPath = ev.path.replace(process.env.HOME || '', '~').slice(-(W - 22));
    lines.push(boxLine(
      `${evColor}${pad(ev.event, 6)}${RESET} ${DIM}${formatTime(ev.time)}${RESET} ${shortPath}`,
      W, FG.gray,
    ));
  }
  lines.push(boxBottom(W, FG.gray));

  // Footer
  // Footer — key hints, with 'n:next' only shown when multiple sessions are alive
  const canSwitch = state && state.activeSessions.length > 1;
  const nextHint = canSwitch
    ? ` ${BOLD}n${RESET}${DIM}:next session${RESET}`
    : '';
  // High-contrast yellow-on-black badge — eye-catching regardless of
  // terminal theme and clearly distinct from the blue title bar above.
  const switchedBadge = isSwitchedView
    ? ` ${BG.yellow}${FG.black}${BOLD} VIEWING ${RESET}${FG.yellow}${BOLD} press r to return${RESET}`
    : '';
  lines.push(
    `${DIM} ${BOLD}q${RESET}${DIM}:quit ${BOLD}r${RESET}${DIM}:refresh${RESET}${nextHint}${DIM} | auto 2s${RESET}${switchedBadge}`,
  );

  process.stdout.write(CLEAR + HIDE_CURSOR + lines.join('\n') + '\n');
}

export function cleanup(): void {
  process.stdout.write(SHOW_CURSOR);
}
