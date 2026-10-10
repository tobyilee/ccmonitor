import type { BackgroundTask, SessionState } from './types.js';
import { mdToPlain } from './recap.js';
import { readTaskOutputTail } from './loaders/scratchpad.js';
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

const FG = {
  black: `${CSI}30m`, red: `${CSI}31m`, green: `${CSI}32m`,
  yellow: `${CSI}33m`, blue: `${CSI}34m`, magenta: `${CSI}35m`,
  cyan: `${CSI}36m`, white: `${CSI}37m`, gray: `${CSI}90m`,
};
const BG = {
  black: `${CSI}40m`, blue: `${CSI}44m`, cyan: `${CSI}46m`,
  yellow: `${CSI}43m`, gray: `${CSI}100m`,
  brightBlue: `${CSI}104m`,
  // Truecolor (24-bit) — deterministic RGB regardless of terminal theme.
  // Title bar uses Tailwind blue-900 (#1e3a8a), a deep saturated navy.
  deepBlue: `${CSI}48;2;30;58;138m`,
};
const FG_PURE_WHITE = `${CSI}38;2;255;255;255m`; // #ffffff

export type View = 'dashboard' | 'recap' | 'background' | 'info';

export interface RenderOptions {
  isSwitchedView?: boolean;
  view?: View;
  /** Scroll offset (lines) for the full-screen views. */
  scroll?: number;
  /** Clock override for tests. */
  now?: Date;
  /** Width override for tests. */
  width?: number;
  /** Height override for tests (full-screen views). */
  height?: number;
  /** `d` toggles the expanded denial list under Tools. */
  showDenials?: boolean;
  /** Section ids hidden with the number keys (persisted in ~/.claude/ccmonitor-ui.json). */
  collapsed?: ReadonlySet<string>;
}

/** ⌨ for CLI sessions, 🖥 for Claude Desktop, nothing when unknown. */
export function entrypointIcon(entrypoint: string | null | undefined): string {
  if (entrypoint === 'claude-desktop') return '🖥';
  if (entrypoint === 'cli') return '⌨';
  return '';
}

const STATUS_STALE_MS = 10 * 60 * 1000;

/** Registry status dot; grey `?` when the status is older than 10 minutes. */
export function statusDot(status: string | null, statusUpdatedAt: number | null, nowMs: number): string {
  if (statusUpdatedAt !== null && nowMs - statusUpdatedAt > STATUS_STALE_MS) return `${FG.gray}?${RESET}`;
  if (status === 'busy') return `${FG.yellow}●${RESET}`;
  if (status === 'waiting') return `${FG.red}●${RESET}`;
  if (status === 'idle') return `${DIM}○${RESET}`;
  return '';
}

function modeChip(state: SessionState): string {
  const mode = state.permissions.mode;
  if (!mode) return '';
  const color = mode === 'auto' ? FG.cyan : mode === 'plan' ? FG.magenta : mode === 'bypassPermissions' ? FG.red : FG.white;
  const flags: string[] = [];
  if (mode === 'auto' && state.permissions.autoMode) {
    if (state.permissions.autoMode.bashFirst) flags.push('bash-first');
    if (state.permissions.autoMode.bypass) flags.push('bypass');
  }
  return `${DIM} Mode:${RESET}${color}${mode}${flags.length ? `(${flags.join(',')})` : ''}${RESET}`;
}

function queueChip(state: SessionState): string {
  return state.queue.depth > 0 ? ` ${DIM}Queue:${RESET}${FG.yellow}${state.queue.depth}${RESET}` : '';
}

/** `Advisor:opus-5-5 ×12  Think:4.9s  Fast` — only the parts that have data. */
function telemetryChips(state: SessionState): string {
  const a = state.attribution;
  let out = '';
  if (a.advisorCalls > 0) {
    out += `${DIM} Advisor:${RESET}${FG.cyan}${shortModel(a.advisorModel) || '?'}${RESET} ${DIM}×${a.advisorCalls}${RESET}`;
  }
  if (a.thinkingSamples > 0) out += `${DIM} Think:${RESET}${(a.thinkingAvgMs / 1000).toFixed(1)}s`;
  if (a.fastMode) out += ` ${FG.magenta}Fast${RESET}`;
  return out;
}

/** Red one-liner when the last 3 turns saw an API error, interrupt or aborted stream. Zero lines otherwise. */
export function errorStrip(state: SessionState): string | null {
  const e = state.errors;
  if (e.api.length === 0 && e.interrupts === 0 && e.abortedMidStream === 0) return null;
  const turnStarts = [...state.turns.map(t => t.startedAt), ...(state.currentTurn ? [state.currentTurn.startedAt] : [])];
  const since = turnStarts.length >= 3 ? turnStarts[turnStarts.length - 3]! : (turnStarts[0] ?? new Date(0));
  const recentApi = e.api.filter(x => !x.time || x.time >= since);
  const recentInterrupts = e.interruptTimes.filter(t => t >= since).length;
  const parts: string[] = [];
  for (const x of recentApi.slice(-2)) {
    const when = x.time ? ` ${formatTime(x.time)}` : '';
    parts.push(`API ${x.status ?? ''}${x.code ? ` ${x.code}` : ''}${when}`.replace(/\s+/g, ' ').trim());
  }
  if (recentInterrupts > 0) parts.push(`interrupted ×${recentInterrupts}`);
  if (e.abortedMidStream > 0 && turnStarts.length < 3) parts.push(`aborted ×${e.abortedMidStream}`);
  if (parts.length === 0) return null;
  return ` ${FG.red}✗ ${parts.join(' · ')}${RESET}`;
}

function rcChip(state: SessionState): string {
  const rc = state.remoteControl;
  if (!rc.url && !rc.bridgeSessionId && !rc.active) return '';
  return rc.active ? ` ${FG.green}RC●${RESET}` : ` ${DIM}RC○${RESET}`;
}

function formatUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Text helpers (exported for tests)
// ---------------------------------------------------------------------------

export function pad(s: string, len: number): string {
  const dw = displayWidth(s);
  return dw >= len ? s : s + ' '.repeat(len - dw);
}

export function rpad(s: string, len: number): string {
  const dw = displayWidth(s);
  return dw >= len ? s : ' '.repeat(len - dw) + s;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Calculate terminal display width accounting for CJK fullwidth characters */
export function displayWidth(s: string): number {
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
      (cp >= 0x1f300 && cp <= 0x1f6ff) || // Emoji: pictographs, emoticons, transport
      (cp >= 0x1f900 && cp <= 0x1faff) || // Supplemental symbols, extended pictographs
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
export function wordWrap(text: string, width: number): string[] {
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

/**
 * Truncate a string that may contain ANSI color codes to a display width.
 * Escape sequences are copied through (zero width); a trailing … marks the cut.
 */
export function truncateAnsi(s: string, maxW: number): string {
  if (displayWidth(s) <= maxW) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const chW = displayWidth(ch);
    if (w + chW > maxW - 1) break;
    out += ch;
    w += chW;
    i += ch.length;
  }
  return `${out}…${RESET}`;
}

/** Truncate a string to a maximum terminal display width (CJK-aware), adding … if cut. */
export function truncateToWidth(s: string, maxW: number): string {
  if (displayWidth(s) <= maxW) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const chW = displayWidth(ch);
    if (w + chW > maxW - 1) break; // reserve 1 col for the ellipsis
    out += ch;
    w += chW;
  }
  return out + '…';
}

function boxLine(content: string, width: number, color: string = FG.cyan): string {
  const dw = displayWidth(content);
  const padding = Math.max(0, width - 3 - dw);
  return `${color}│${RESET} ${content}${' '.repeat(padding)}${color}│${RESET}`;
}

function boxTop(title: string, width: number, color: string = FG.cyan, titleColor: string = ''): string {
  const inner = width - 5 - displayWidth(title);
  return `${color}┌─ ${BOLD}${titleColor}${title}${RESET}${color} ${'─'.repeat(Math.max(0, inner))}┐${RESET}`;
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
    case 'failed':
      return `${FG.red}✘${RESET}`;
    case 'pending':
      return `${FG.gray}○${RESET}`;
    default:
      return `${FG.gray}?${RESET}`;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Compact duration: 12s, 4m02s, 1h04m. */
export function formatDurationCompact(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false });
}

/** "claude-fable-5-1" → "fable-5-1" */
export function shortModel(model: string | null): string {
  return (model ?? '').replace(/^claude-/, '');
}

/**
 * Render a braille sparkline from an array of numeric values.
 */
function sparkline(values: number[], width: number): string {
  if (values.length === 0) return '';
  const slice = values.slice(-width);
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

/** Block-character sparkline ▁▂▃▄▅▆▇█ for turn durations. */
function blockSparkline(values: number[]): string {
  if (values.length === 0) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const maxVal = Math.max(...values, 1);
  return values.map(v => blocks[Math.min(7, Math.floor((v / maxVal) * 7.999))] ?? '▁').join('');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function titleBar(W: number, now: Date): string {
  const headerText = ` Claude Code Monitor v${pkg.version} `;
  const timeText = ` ${formatTime(now)} `;
  const headerPad = W - headerText.length - timeText.length;
  return `${BG.deepBlue}${FG_PURE_WHITE}${BOLD}${headerText}${' '.repeat(Math.max(0, headerPad))}${timeText}${RESET}`;
}

function pathLine(state: SessionState | null, W: number): string {
  const cwdPath = state
    ? state.cwd ?? state.projectDir.replace(/.*projects\//, '').replace(/-/g, '/')
    : process.cwd();
  const branchSuffix = state?.gitBranch ? ` ${FG.magenta}[${state.gitBranch}]${RESET}` : '';
  let titleSuffix = '';
  if (state?.sessionTitle) {
    const usedW = displayWidth(` ${cwdPath}`) + displayWidth(stripAnsi(branchSuffix)) + 3; // " — "
    const titleRoom = W - usedW;
    if (titleRoom >= 4) {
      const title = truncateToWidth(state.sessionTitle, titleRoom);
      titleSuffix = `${DIM} — ${RESET}${FG.cyan}${title}${RESET}`;
    }
  }
  return `${DIM} ${cwdPath}${RESET}${branchSuffix}${titleSuffix}`;
}

/** `Turn:#N ⏱ 1m04s (open) tools:12` or `Turn:#N done 4m02s · avg 2m10s · ▂▅▃▇▁`. */
function turnLine(state: SessionState, now: Date): string | null {
  const t = state.currentTurn;
  const closed = state.turns.filter(x => x.durationMs !== null);
  const chips = `${modeChip(state)}${rcChip(state)}${queueChip(state)}`;
  if (!t && closed.length === 0) return chips ? chips : null;
  if (t) {
    const elapsed = formatDurationCompact(now.getTime() - t.startedAt.getTime());
    const originTag = t.origin === 'human' ? '' : ` ${DIM}(${t.origin.replace('_', ' ')})${RESET}`;
    return `${DIM} Turn:${RESET}${FG.yellow}#${t.index}${RESET} ${FG.yellow}⏱ ${elapsed}${RESET} ${FG.yellow}(open)${RESET}${originTag}` +
      `${DIM} tools:${RESET}${t.toolCalls}${chips}`;
  }
  const last = closed[closed.length - 1]!;
  const durations = closed.slice(-10).map(x => x.durationMs ?? 0);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const spark = durations.length > 1 ? ` ${DIM}·${RESET} ${FG.cyan}${blockSparkline(durations)}${RESET}` : '';
  return `${DIM} Turn:${RESET}${FG.cyan}#${last.index}${RESET} ${DIM}done${RESET} ${formatDurationCompact(last.durationMs ?? 0)}` +
    ` ${DIM}· avg${RESET} ${formatDurationCompact(avg)}${spark}` +
    (state.pendingBackgroundAgents > 0 ? ` ${DIM}· bg:${RESET}${FG.yellow}${state.pendingBackgroundAgents}${RESET}` : '') + chips;
}

/** `Cost:$1.03 API:1m23s Tools:1.3s +12/-3 fable-5-1:$1.03 haiku:$0.00`. */
function costLine(state: SessionState): string | null {
  const c = state.cost;
  if (!c) return null;
  const color = c.hasUnknownModelCost ? FG.red : FG.green;
  const models = Object.entries(c.perModel)
    .sort((a, b) => b[1] - a[1])
    .map(([m, v]) => `${DIM}${shortModel(m)}:${RESET}${formatUsd(v)}`)
    .join(' ');
  const lines = c.linesAdded || c.linesRemoved ? ` ${FG.green}+${c.linesAdded}${RESET}${DIM}/${RESET}${FG.red}-${c.linesRemoved}${RESET}` : '';
  const prev = c.isPrevious ? ` ${DIM}(prev session)${RESET}` : '';
  return `${DIM} Cost:${RESET}${color}${formatUsd(c.totalUSD)}${RESET}` +
    `${DIM} API:${RESET}${formatDurationCompact(c.apiDurationMs)}` +
    `${DIM} Tools:${RESET}${(c.toolDurationMs / 1000).toFixed(1)}s` +
    lines + (models ? ` ${models}` : '') + prev;
}

export function renderHooksBox(state: SessionState, W: number): string[] {
  const h = state.hooks;
  if (h.total === 0) return [];
  const color = h.stopBlocked || h.errors.length > 0 ? FG.red : FG.cyan;
  const out = [boxTop('Hooks', W, color)];
  const events = Object.entries(h.byEvent)
    .sort((a, b) => b[1] - a[1])
    .map(([ev, n]) => `${FG.green}${ev}${RESET}${DIM}:${n}${RESET}`)
    .join(' ');
  const errs = h.errors.length > 0 ? `  ${FG.red}errors:${h.errors.length}${RESET}` : `  ${DIM}errors:0${RESET}`;
  const blocked = h.stopBlocked ? `  ${BG.yellow}${FG.black}${BOLD} STOP BLOCKED ${RESET}` : '';
  out.push(boxLine(truncateAnsi(`${events}${errs}${blocked}`, W - 4), W, color));
  for (const e of h.errors.slice(-2)) {
    const when = e.time ? `${formatTime(e.time)} ` : '';
    out.push(boxLine(truncateAnsi(`${FG.red}✗${RESET} ${DIM}${when}${RESET}${e.hookName} ${DIM}exit ${e.exitCode}${RESET} ${e.stderr}`, W - 4), W, color));
  }
  out.push(boxBottom(W, color));
  return out;
}

const RECAP_MAX_LINES = 8;

export function renderRecapBox(state: SessionState, W: number): string[] {
  const r = state.recap;
  const out: string[] = [];
  const innerW = Math.max(10, W - 4);
  const stamp = r.turnOpen
    ? ''
    : (r.nativeRecapTime ?? r.finalReplyTime) ? `  ${formatTime((r.nativeRecapTime ?? r.finalReplyTime)!)}` : '';
  const title = r.turnOpen ? 'Recap  (turn open)' : `Recap${stamp}`;
  const color = r.turnOpen ? FG.yellow : FG.cyan;
  out.push(boxTop(title, W, color, r.turnOpen ? FG.yellow : ''));

  const body: string[] = [];
  if (r.turnOpen && r.liveNarration) {
    const plain = mdToPlain(r.liveNarration).filter(l => l.trim()).join(' ');
    const wrapped = wordWrap(`now: ${plain}`, innerW).slice(0, 2);
    for (const w of wrapped) body.push(`${FG.yellow}${w}${RESET}`);
  } else if (r.turnOpen) {
    body.push(`${FG.yellow}now: ${RESET}${DIM}working…${RESET}`);
  }
  if (r.nativeRecap) {
    for (const w of wordWrap(`CC: ${r.nativeRecap}`, innerW)) body.push(`${FG.green}${w}${RESET}`);
  }
  if (r.finalReply) {
    const label = r.turnOpen ? 'Previous reply' : 'Final reply';
    const when = r.finalReplyTime ? ` ${formatTime(r.finalReplyTime)}` : '';
    const model = r.finalReplyModel ? ` (${shortModel(r.finalReplyModel)})` : '';
    const head = `── ${label}${when}${model} `;
    body.push(`${DIM}${head}${'─'.repeat(Math.max(0, innerW - displayWidth(head)))}${RESET}`);
    const source = r.koreanRecap ?? mdToPlain(r.finalReply).filter(l => l.trim()).slice(0, 6).join('\n');
    const plainLines = r.koreanRecap ? mdToPlain(source).filter(l => l.trim()) : source.split('\n');
    for (const line of plainLines) {
      for (const w of wordWrap(line, innerW)) body.push(`${FG.white}${w}${RESET}`);
    }
  }
  if (body.length === 0) body.push(`${DIM}(no reply yet)${RESET}`);

  const total = r.finalReply ? mdToPlain(r.finalReply).length : 0;
  if (body.length > RECAP_MAX_LINES) {
    const shown = body.slice(0, RECAP_MAX_LINES - 1);
    const hidden = Math.max(body.length - shown.length, total - shown.length);
    shown.push(`${DIM}… (+${hidden} lines, press c)${RESET}`);
    for (const b of shown) out.push(boxLine(b, W, color));
  } else {
    for (const b of body) out.push(boxLine(b, W, color));
    if (r.finalReply && total > body.length + 2) {
      out.push(boxLine(`${DIM}… (+${total - body.length} lines, press c)${RESET}`, W, color));
    }
  }
  out.push(boxBottom(W, color));
  return out;
}

function taskRow(t: BackgroundTask, now: Date, W: number): string {
  const icon = t.status === 'running' ? `${FG.yellow}●${RESET}`
    : t.status === 'completed' ? `${FG.green}✓${RESET}`
      : t.status === 'failed' ? `${FG.red}✗${RESET}` : `${FG.gray}?${RESET}`;
  const end = t.endedAt ?? now;
  const elapsed = formatDurationCompact(end.getTime() - t.startedAt.getTime());
  const kind = pad(t.kind, 5);
  const type = t.kind === 'agent' && t.agentType ? ` ${FG.cyan}${t.agentType}${RESET}` : '';
  const tail = t.status === 'running'
    ? `${DIM}${elapsed}${RESET}`
    : t.exitCode !== null
      ? `${t.exitCode === 0 ? FG.green : FG.red}exit ${t.exitCode}${RESET} ${DIM}${elapsed}${RESET}`
      : `${DIM}done ${elapsed}${RESET}`;
  const model = t.model ? ` ${DIM}${shortModel(t.model)}${RESET}` : '';
  const fixed = displayWidth(stripAnsi(`${icon} ${kind}${type} "" ${tail}${model}`));
  const room = Math.max(6, W - 4 - fixed);
  const desc = truncateToWidth(t.description || t.summary || t.id, room);
  return `${icon} ${DIM}${kind}${RESET}${type} "${desc}" ${tail}${model}`;
}

export function renderBackgroundBox(state: SessionState, W: number, now: Date): string[] {
  const tasks = [...state.backgroundTasks.values()];
  const running = tasks.filter(t => t.status === 'running').length;
  const mismatch = state.pendingBackgroundAgents > 0 && state.pendingBackgroundAgents !== tasks.filter(t => t.kind === 'agent' && t.status === 'running').length;
  const title = `Background  ${running} running${mismatch ? ' ?' : ''}`;
  const color = running > 0 ? FG.green : FG.gray;
  const out = [boxTop(title, W, color)];
  const shown = tasks.slice(-8);
  for (const t of shown) out.push(boxLine(taskRow(t, now, W), W, color));
  if (tasks.length > shown.length) out.push(boxLine(`${DIM}  … +${tasks.length - shown.length} earlier${RESET}`, W, color));
  out.push(boxBottom(W, color));
  return out;
}

function renderSubagentsBox(state: SessionState, W: number, now: Date): string[] {
  const out: string[] = [];
  const allAgents = [...state.subagents.values()];
  const runningAgents = allAgents.filter(a => a.status === 'running');
  const completedCount = allAgents.filter(a => a.status === 'completed').length;
  out.push(boxTop('Subagents', W, FG.green));
  if (runningAgents.length === 0 && completedCount === 0) {
    out.push(boxLine(`${DIM}(no subagents)${RESET}`, W, FG.green));
  } else if (runningAgents.length === 0) {
    out.push(boxLine(`${DIM}All ${completedCount} subagent(s) completed${RESET}`, W, FG.green));
  }
  for (const a of runningAgents.slice(-8)) {
    const dur = formatDuration(now.getTime() - a.startTime.getTime());
    const descMax = Math.max(0, W - 32);
    const desc = a.description.slice(0, descMax);
    out.push(boxLine(
      `${statusIcon(a.status)} ${FG.cyan}${pad(a.type, 12)}${RESET} ${DIM}${rpad(dur, 6)}${RESET} ${desc}`,
      W, FG.green,
    ));
  }
  if (runningAgents.length > 8) {
    out.push(boxLine(`${DIM}  ... +${runningAgents.length - 8} more running${RESET}`, W, FG.green));
  }
  out.push(boxBottom(W, FG.green));
  return out;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionCtx {
  state: SessionState;
  fileEvents: Array<{ path: string; time: Date; event: string }>;
  W: number;
  now: Date;
  opts: RenderOptions;
}

/** One collapsible dashboard box. `key` is the keyboard toggle (1-9, 0). */
export interface Section {
  id: string;
  key: string;
  title: string;
  render: (ctx: SectionCtx) => string[];
}

function sectionPrompt({ state, W }: SectionCtx): string[] {
  const out: string[] = [];
  const promptTitle = state.lastUserPromptTime ? `Last Prompt  ${formatTime(state.lastUserPromptTime)}` : 'Last Prompt';
  out.push(boxTop(promptTitle, W, FG.white));
  if (state.lastUserPrompt) {
    const MAX_CHARS = 500;
    const chars = Array.from(state.lastUserPrompt);
    const displayText = chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS - 3).join('') + '...' : state.lastUserPrompt;
    const innerW = Math.max(10, W - 4);
    for (const wrapped of wordWrap(displayText, innerW)) {
      out.push(boxLine(`${FG.white}${wrapped}${RESET}`, W, FG.white));
    }
  } else {
    out.push(boxLine(`${DIM}(no user prompt yet)${RESET}`, W, FG.white));
  }
  if (state.queue.depth > 0 && state.queue.preview) {
    const preview = state.queue.preview.replace(/\s+/g, ' ').trim();
    out.push(boxLine(truncateAnsi(`${DIM}↳ next (${state.queue.depth} queued): ${preview}${RESET}`, W - 4), W, FG.white));
  }
  out.push(boxBottom(W, FG.white));
  return out;
}

function sectionTools({ state, W, opts }: SectionCtx): string[] {
  const out: string[] = [];
  const sortedTools = [...state.toolStats.values()].sort((a, b) => b.count - a.count);
  out.push(boxTop('Tools', W, FG.cyan));
  if (sortedTools.length === 0) {
    out.push(boxLine(`${DIM}(no tools used yet)${RESET}`, W));
  } else {
    const chips: string[] = [];
    const chipTexts: string[] = [];
    for (const t of sortedTools) {
      chips.push(`${FG.green}${t.name}${RESET}${DIM}:${t.count}${RESET}`);
      chipTexts.push(`${t.name}:${t.count}`);
    }
    const innerW = W - 4;
    let currentLine = '';
    let currentLen = 0;
    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i] ?? '';
      const chipLen = (chipTexts[i] ?? '').length;
      if (currentLen > 0 && currentLen + 1 + chipLen > innerW) {
        out.push(boxLine(currentLine, W));
        currentLine = chip;
        currentLen = chipLen;
      } else {
        currentLine += (currentLen > 0 ? ' ' : '') + chip;
        currentLen += (currentLen > 0 ? 1 : 0) + chipLen;
      }
    }
    if (currentLen > 0) out.push(boxLine(currentLine, W));
  }
  const dec = state.permissions.decisions;
  if (dec.reject > 0) {
    const byReason = Object.entries(dec.rejectByReason)
      .map(([r, n]) => `${r} ${n}`).join(', ');
    const hint = opts.showDenials ? '' : ` ${DIM}(d)${RESET}`;
    out.push(boxLine(`${FG.red}Denied:${dec.reject}${RESET}${byReason ? ` ${DIM}(${byReason})${RESET}` : ''}${hint}`, W));
    if (opts.showDenials) {
      for (const d of state.permissions.denials) {
        const when = d.time ? `${formatTime(d.time)} ` : '';
        out.push(boxLine(truncateAnsi(`${FG.red}✗${RESET} ${DIM}${when}${RESET}${FG.yellow}${d.tool ?? '?'}${RESET} ${DIM}${d.kind ?? ''}${RESET} ${d.reason}`, W - 4), W));
      }
    }
  }
  out.push(boxBottom(W, FG.cyan));
  const mcp = Object.entries(state.attribution.mcpServers).sort((a, b) => b[1] - a[1]);
  if (mcp.length > 0) {
    out.push(boxTop('MCP', W, FG.cyan));
    const chips = mcp.map(([server, n]) => `${FG.green}${server}${RESET}${DIM} ×${n}${RESET}`).join('  ');
    out.push(boxLine(truncateAnsi(chips, W - 4), W));
    out.push(boxBottom(W, FG.cyan));
  }
  return out;
}

function sectionBackground({ state, W, now }: SectionCtx): string[] {
  // Background tasks replace the Subagents box when present
  return state.backgroundTasks.size > 0 ? renderBackgroundBox(state, W, now) : renderSubagentsBox(state, W, now);
}

function sectionSkill({ state, W, now }: SectionCtx): string[] {
  const out: string[] = [];
  out.push(boxTop('Skill', W, FG.magenta));
  if (state.activeSkill) {
    const dur = formatDuration(now.getTime() - state.activeSkill.startTime.getTime());
    const argsDisplay = state.activeSkill.args ? ` ${DIM}(${state.activeSkill.args.slice(0, 30)})${RESET}` : '';
    out.push(boxLine(
      `${statusIcon('running')} ${FG.yellow}/${state.activeSkill.name}${RESET}${argsDisplay} ${DIM}${dur}${RESET}`,
      W, FG.magenta,
    ));
  } else if (state.lastCompletedSkill) {
    const argsDisplay = state.lastCompletedSkill.args ? ` ${DIM}(${state.lastCompletedSkill.args.slice(0, 30)})${RESET}` : '';
    out.push(boxLine(
      `${FG.green}✔${RESET} ${FG.cyan}/${state.lastCompletedSkill.name}${RESET}${argsDisplay} ${DIM}at ${formatTime(state.lastCompletedSkill.endTime)}${RESET}`,
      W, FG.magenta,
    ));
  } else {
    out.push(boxLine(`${DIM}(no skills invoked)${RESET}`, W, FG.magenta));
  }
  const historyHead = state.skillHistory[0];
  const historyStart = (state.lastCompletedSkill && historyHead
    && historyHead.name === state.lastCompletedSkill.name
    && historyHead.endTime === state.lastCompletedSkill.endTime) ? 1 : 0;
  for (const h of state.skillHistory.slice(historyStart, historyStart + 5)) {
    const hArgs = h.args ? ` (${h.args.slice(0, 20)})` : '';
    out.push(boxLine(`${DIM}  /${h.name}${hArgs} at ${formatTime(h.endTime)}${RESET}`, W, FG.magenta));
  }
  // Attribution: how many assistant responses ran under each skill / plugin
  const attributed = [
    ...Object.entries(state.attribution.skills),
    ...Object.entries(state.attribution.plugins).map(([k, v]) => [`plugin:${k}`, v] as [string, number]),
  ].sort((a, b) => b[1] - a[1]);
  if (attributed.length > 0) {
    const chips = attributed.map(([name, n]) => `${FG.cyan}${name}${RESET}${DIM} attributed:${n}${RESET}`).join('  ');
    out.push(boxLine(truncateAnsi(chips, W - 4), W, FG.magenta));
  }
  out.push(boxBottom(W, FG.magenta));
  return out;
}

function sectionLinks({ state, W }: SectionCtx): string[] {
  const l = state.links;
  if (l.prs.length === 0 && l.artifacts.length === 0 && !l.plan && l.feedbackDrafts.length === 0) return [];
  const out = [boxTop('Links', W, FG.blue)];
  for (const pr of l.prs.slice(-3)) {
    out.push(boxLine(truncateAnsi(`${FG.green}PR${RESET} #${pr.number} ${DIM}${pr.repository}${RESET}`, W - 4), W, FG.blue));
  }
  for (const a of l.artifacts) {
    out.push(boxLine(truncateAnsi(`${FG.cyan}Artifact${RESET} "${a.title}"`, W - 4), W, FG.blue));
  }
  if (l.plan) {
    const name = l.plan.path.split('/').pop() ?? l.plan.path;
    out.push(boxLine(truncateAnsi(`${FG.magenta}Plan${RESET} ${name} ${DIM}(${Math.max(1, Math.round(l.plan.bytes / 1024))} KB)${RESET}`, W - 4), W, FG.blue));
  }
  for (const f of l.feedbackDrafts.slice(0, 2)) {
    out.push(boxLine(truncateAnsi(`${FG.yellow}Feedback${RESET} ${DIM}${f.type}:${RESET} "${f.title}"`, W - 4), W, FG.blue));
  }
  out.push(boxBottom(W, FG.blue));
  return out;
}

function sectionTeams({ state, W }: SectionCtx): string[] {
  const out: string[] = [];
  out.push(boxTop('Teams', W, FG.blue));
  if (state.teams.length === 0) out.push(boxLine(`${DIM}(no teams)${RESET}`, W, FG.blue));
  for (const team of state.teams) {
    const memberCount = team.members.length > 0 ? ` ${DIM}(${team.members.length})${RESET}` : '';
    out.push(boxLine(`${FG.yellow}${team.name}${RESET}${memberCount}`, W, FG.blue));
    for (const member of team.members) out.push(boxLine(`${DIM}  ${member}${RESET}`, W, FG.blue));
  }
  out.push(boxBottom(W, FG.blue));
  // Tasks (hidden when empty: task tools are off on Claude 5 models)
  if (state.tasks.length > 0) {
    out.push(boxTop('Tasks', W, FG.yellow));
    for (const t of state.tasks.slice(-6)) {
      out.push(boxLine(`${statusIcon(t.status)} ${pad(t.subject || '', W - 8)}`, W, FG.yellow));
    }
    out.push(boxBottom(W, FG.yellow));
  }
  return out;
}

function sectionMemory({ state, W, now }: SectionCtx): string[] {
  const out: string[] = [];
  out.push(boxTop('Memory', W, FG.blue));
  if (!state.memory) {
    out.push(boxLine(`${DIM}(no memory yet)${RESET}`, W, FG.blue));
  } else {
    const m = state.memory;
    const indexPart = m.hasIndex
      ? `${FG.cyan}MEMORY.md${RESET}${DIM} (${m.indexLines} lines)${RESET}`
      : `${DIM}(no index)${RESET}`;
    const topicPart = m.topicCount > 0
      ? ` ${DIM}+${RESET} ${FG.yellow}${m.topicCount} topic${m.topicCount === 1 ? '' : 's'}${RESET}`
      : '';
    const ageSuffix = m.lastModified
      ? ` ${DIM}last: ${formatDuration(now.getTime() - m.lastModified.getTime())} ago${RESET}`
      : '';
    out.push(boxLine(`${indexPart}${topicPart}${ageSuffix}`, W, FG.blue));
    if (m.topicCount > 0) {
      const cats = Object.entries(m.categoryBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `${FG.magenta}${cat}${RESET}${DIM}:${n}${RESET}`)
        .join(' ');
      out.push(boxLine(`${DIM}  categories:${RESET} ${cats}`, W, FG.blue));
    }
    if (m.recentTopics.length > 0) {
      const topics = m.recentTopics.map(t => `${FG.cyan}${t}${RESET}`).join(`${DIM}, ${RESET}`);
      out.push(boxLine(`${DIM}  recent:${RESET} ${topics}`, W, FG.blue));
    }
  }
  out.push(boxBottom(W, FG.blue));
  return out;
}

function sectionFiles({ fileEvents, W }: SectionCtx): string[] {
  const out: string[] = [];
  out.push(boxTop('File Activity', W, FG.gray));
  const recentEvents = fileEvents.slice(-8);
  if (recentEvents.length === 0) out.push(boxLine(`${DIM}(watching for changes...)${RESET}`, W, FG.gray));
  for (const ev of recentEvents) {
    const evColor = ev.event === 'add' ? FG.green : ev.event === 'change' ? FG.yellow : FG.red;
    const shortPath = ev.path.replace(process.env.HOME || '', '~').slice(-(W - 22));
    out.push(boxLine(`${evColor}${pad(ev.event, 6)}${RESET} ${DIM}${formatTime(ev.time)}${RESET} ${shortPath}`, W, FG.gray));
  }
  out.push(boxBottom(W, FG.gray));
  return out;
}

/** Dashboard boxes in display order. Toggle with the listed key; persisted in ~/.claude/ccmonitor-ui.json. */
export const SECTIONS: Section[] = [
  { id: 'prompt', key: '1', title: 'Last Prompt', render: sectionPrompt },
  { id: 'recap', key: '2', title: 'Recap', render: ({ state, W }) => renderRecapBox(state, W) },
  { id: 'tools', key: '3', title: 'Tools', render: sectionTools },
  { id: 'background', key: '4', title: 'Background / Subagents', render: sectionBackground },
  { id: 'skill', key: '5', title: 'Skill', render: sectionSkill },
  { id: 'hooks', key: '6', title: 'Hooks', render: ({ state, W }) => renderHooksBox(state, W) },
  { id: 'links', key: '7', title: 'Links', render: sectionLinks },
  { id: 'teams', key: '8', title: 'Teams / Tasks', render: sectionTeams },
  { id: 'memory', key: '9', title: 'Memory', render: sectionMemory },
  { id: 'files', key: '0', title: 'File Activity', render: sectionFiles },
];

export function sectionForKey(key: string): Section | undefined {
  return SECTIONS.find(s => s.key === key);
}

/** Header block: title bar, path, session / turn / sessions / tokens / cost / rate / quota lines. */
function renderHeaderLines(state: SessionState, W: number, now: Date): string[] {
  const lines: string[] = [];
  const sessionAge = formatDuration(now.getTime() - state.startTime.getTime());
  const sinceActivity = formatDuration(now.getTime() - state.lastActivity.getTime());
  const ctxPct = state.contextPercent;
  const ctxColor = ctxPct >= 85 ? FG.red : ctxPct >= 70 ? FG.yellow : FG.green;
  const effortColor = (() => {
    switch (state.effortLevel) {
      case 'xhigh': return FG.magenta;
      case 'high': return FG.red;
      case 'medium': return FG.yellow;
      case 'low': return FG.gray;
      default: return FG.cyan;
    }
  })();
  const effortLabel = state.effortLevel === 'xhigh' ? 'max' : state.effortLevel;
  const effortPart = state.effortLevel ? `${DIM} Effort:${RESET}${effortColor}${effortLabel}${RESET}` : '';
  const selfSession = state.activeSessions.find(s => s.sessionId === state.sessionId);
  const icon = entrypointIcon(selfSession?.entrypoint ?? state.entrypoint);
  const slugPart = state.slug ? `${DIM}·${state.slug}${RESET}` : '';
  lines.push(
    `${DIM} Session:${RESET}${icon ? `${icon} ` : ''}${FG.cyan}${state.sessionId.slice(0, 8)}${RESET}${slugPart}` +
    `${DIM} Model:${RESET}${FG.green}${shortModel(state.model)}${RESET}` +
    effortPart +
    `${DIM} Ctx:${RESET}${ctxColor}${ctxPct}%${RESET}` +
    `${DIM} Age:${RESET}${sessionAge}` +
    `${DIM} Idle:${RESET}${sinceActivity}`,
  );

  const turn = turnLine(state, now);
  if (turn) lines.push(turn);

  // Active sessions
  const sessionsTotal = state.activeSessions.length;
  const others = state.activeSessions.filter(s => s.sessionId !== state.sessionId && s.cwd);
  const sessionChip = (s: typeof others[number]): string => {
    const label = s.name ?? (s.cwd.split('/').pop() || '?');
    const dot = statusDot(s.status, s.statusUpdatedAt, now.getTime());
    const ic = s.entrypoint === 'claude-desktop' ? '🖥' : '';
    return `${dot}${ic}${DIM}${label}${RESET}`;
  };
  const MAX_PROJECTS_SHOWN = 4;
  const otherProjectsDisplay = others.length > 0
    ? ` ${DIM}(+${RESET}${others.slice(0, MAX_PROJECTS_SHOWN).map(sessionChip).join(`${DIM}, ${RESET}`)}${others.length > MAX_PROJECTS_SHOWN ? `${DIM}, +${others.length - MAX_PROJECTS_SHOWN}${RESET}` : ''}${DIM})${RESET}`
    : '';
  const memPart = state.processMemMb > 0 ? `${DIM} Mem:${RESET}${FG.cyan}${state.processMemMb}MB${RESET}` : '';
  const ccVersion = selfSession?.version ?? state.version;
  const versionPart = ccVersion ? `${DIM} CC:${RESET}${FG.green}v${ccVersion}${RESET}` : '';
  lines.push(`${DIM} Sess:${RESET}${FG.cyan}${sessionsTotal}${RESET}${otherProjectsDisplay}${memPart}${versionPart}`);

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

  const cost = costLine(state);
  if (cost) lines.push(cost);

  // Token analytics line
  const burnRateStr = state.tokenBurnRate > 0
    ? `${FG.cyan}${formatTokens(state.tokenBurnRate)}${RESET}${DIM}/min${RESET}`
    : `${DIM}--${RESET}`;
  const lastCompaction = state.compactions[state.compactions.length - 1];
  const compactDetail = lastCompaction
    ? ` ${DIM}(${lastCompaction.trigger} ${formatTokens(lastCompaction.preTokens)}→${formatTokens(lastCompaction.postTokens)})${RESET}`
    : '';
  const compactStr = state.compactionCount > 0 ? `${FG.yellow}${state.compactionCount}${RESET}${compactDetail}` : `${FG.green}0${RESET}`;
  const peakStr = state.maxContextTokens > 0 ? `${FG.cyan}${formatTokens(state.maxContextTokens)}${RESET}` : `${DIM}--${RESET}`;
  const sparkW = Math.min(20, Math.max(0, W - 60));
  const spark = state.tokenHistory.length > 1 ? ` ${DIM}${sparkline(state.tokenHistory, sparkW)}${RESET}` : '';
  lines.push(`${DIM} Rate:${RESET}${burnRateStr}${DIM} Compact:${RESET}${compactStr}${DIM} Peak:${RESET}${peakStr}${telemetryChips(state)}${spark}`);

  // Rate limit quota
  if (state.rateLimit) {
    const rl = state.rateLimit;
    const staleTag = rl.isStale ? ` ${FG.gray}(stale)${RESET}` : '';
    const fiveColor = (rl.fiveHourPct ?? 0) >= 80 ? FG.red : (rl.fiveHourPct ?? 0) >= 50 ? FG.yellow : FG.green;
    const weekColor = (rl.weeklyPct ?? 0) >= 80 ? FG.red : (rl.weeklyPct ?? 0) >= 50 ? FG.yellow : FG.green;
    const resetCountdown = (epochSec: number | null): string => {
      if (!epochSec) return '';
      const remainMs = (epochSec * 1000) - now.getTime();
      if (remainMs <= 0) return '';
      return ` ${DIM}(${formatDuration(remainMs)})${RESET}`;
    };
    const bar = (pct: number, color: string): string => {
      const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
      return `${color}${'█'.repeat(filled)}${FG.gray}${'░'.repeat(10 - filled)}${RESET}`;
    };
    const fivePct = rl.fiveHourPct ?? 0;
    const weekPct = rl.weeklyPct ?? 0;
    lines.push(
      `${DIM} Quota 5h:${RESET}${bar(fivePct, fiveColor)} ${fiveColor}${fivePct.toFixed(0)}%${RESET}${resetCountdown(rl.fiveHourResetsAt)}` +
      `${DIM} wk:${RESET}${bar(weekPct, weekColor)} ${weekColor}${weekPct.toFixed(0)}%${RESET}${resetCountdown(rl.weeklyResetsAt)}${staleTag}`,
    );
  }
  const strip = errorStrip(state);
  if (strip) lines.push(strip);
  return lines;
}

function renderFooter(state: SessionState, opts: RenderOptions): string {
  const canSwitch = state.activeSessions.length > 1;
  const nextHint = canSwitch ? ` ${BOLD}n${RESET}${DIM}:next${RESET}` : '';
  const bgHint = state.backgroundTasks.size > 0 ? ` ${BOLD}b${RESET}${DIM}:background${RESET}` : '';
  const dHint = state.permissions.decisions.reject > 0 ? ` ${BOLD}d${RESET}${DIM}:denials${RESET}` : '';
  const hidden = SECTIONS.filter(s => opts.collapsed?.has(s.id)).map(s => s.key);
  const hiddenHint = hidden.length > 0 ? ` ${DIM}hidden:${hidden.join(',')}${RESET}` : '';
  const switchedBadge = opts.isSwitchedView
    ? ` ${BG.yellow}${FG.black}${BOLD} VIEWING ${RESET}${FG.yellow}${BOLD} press r to return${RESET}`
    : '';
  return `${DIM} ${BOLD}q${RESET}${DIM}:quit ${BOLD}r${RESET}${DIM}:refresh ${BOLD}c${RESET}${DIM}:recap${RESET}${bgHint}${dHint} ${BOLD}i${RESET}${DIM}:info${RESET}${nextHint}${DIM} | auto 2s${RESET}${hiddenHint}${switchedBadge}`;
}

/** Pure dashboard renderer: header + every non-collapsed Section + footer. */
export function renderDashboardLines(
  state: SessionState | null,
  fileEvents: Array<{ path: string; time: Date; event: string }>,
  opts: RenderOptions = {},
): string[] {
  const W = opts.width ?? Math.max(20, (process.stdout.columns || 80) - 1);
  const now = opts.now ?? new Date();
  const lines: string[] = [titleBar(W, now), pathLine(state, W)];

  if (!state) {
    lines.push('');
    lines.push(`${FG.yellow}  No active session found. Waiting for activity...${RESET}`);
    lines.push('');
    return lines;
  }

  lines.push(...renderHeaderLines(state, W, now));
  const ctx: SectionCtx = { state, fileEvents, W, now, opts };
  for (const section of SECTIONS) {
    if (opts.collapsed?.has(section.id)) continue;
    lines.push(...section.render(ctx));
  }
  lines.push(renderFooter(state, opts));
  // Header/footer lines are free text; keep them inside the terminal width.
  return lines.map(l => (/^[│┌└]/.test(stripAnsi(l)) ? l : truncateAnsi(l, W)));
}

// ---------------------------------------------------------------------------
// Full-screen views
// ---------------------------------------------------------------------------

function scrollWindow(body: string[], scroll: number, height: number, W: number, footer: string): string[] {
  const avail = Math.max(3, height - 3); // title + path + footer
  const maxScroll = Math.max(0, body.length - avail);
  const start = Math.min(Math.max(0, scroll), maxScroll);
  const slice = body.slice(start, start + avail);
  const pos = body.length > avail ? ` ${DIM}[${start + 1}-${start + slice.length}/${body.length}]${RESET}` : '';
  return [...slice, `${footer}${pos}`];
}

/** Full-screen Recap view: native recap + the whole final reply, word-wrapped. */
export function renderRecapViewLines(state: SessionState | null, opts: RenderOptions = {}): string[] {
  const W = opts.width ?? Math.max(20, (process.stdout.columns || 80) - 1);
  const H = opts.height ?? (process.stdout.rows || 40);
  const now = opts.now ?? new Date();
  const lines = [titleBar(W, now), pathLine(state, W)];
  const footer = `${DIM} ${BOLD}Esc${RESET}${DIM}/${BOLD}c${RESET}${DIM}:back ${BOLD}j${RESET}${DIM}/${BOLD}k${RESET}${DIM}:scroll ${BOLD}q${RESET}${DIM}:quit${RESET}`;
  if (!state) return [...lines, '', `${DIM}(no session)${RESET}`, footer];
  const r = state.recap;
  const body: string[] = [];
  const innerW = Math.max(10, W - 2);
  if (r.turnOpen && r.liveNarration) {
    for (const w of wordWrap(`now: ${mdToPlain(r.liveNarration).join(' ')}`, innerW)) body.push(` ${FG.yellow}${w}${RESET}`);
    body.push('');
  }
  if (r.nativeRecap) {
    body.push(` ${BOLD}${FG.green}Claude Code recap${RESET}${r.nativeRecapTime ? `${DIM}  ${formatTime(r.nativeRecapTime)}${RESET}` : ''}`);
    for (const w of wordWrap(r.nativeRecap, innerW)) body.push(` ${w}`);
    body.push('');
  }
  if (r.finalReply) {
    const when = r.finalReplyTime ? `  ${formatTime(r.finalReplyTime)}` : '';
    body.push(` ${BOLD}${FG.cyan}Final reply${RESET}${DIM}${when}${r.finalReplyModel ? ` (${shortModel(r.finalReplyModel)})` : ''}${RESET}`);
    for (const line of mdToPlain(r.finalReply)) {
      if (line === '') { body.push(''); continue; }
      for (const w of wordWrap(line, innerW)) body.push(` ${w}`);
    }
  } else {
    body.push(` ${DIM}(no reply yet)${RESET}`);
  }
  return [...lines, ...scrollWindow(body, opts.scroll ?? 0, H, W, footer)];
}

/** Full-screen Background view: each task with the tail of its output file. */
export function renderBackgroundViewLines(state: SessionState | null, opts: RenderOptions = {}): string[] {
  const W = opts.width ?? Math.max(20, (process.stdout.columns || 80) - 1);
  const H = opts.height ?? (process.stdout.rows || 40);
  const now = opts.now ?? new Date();
  const lines = [titleBar(W, now), pathLine(state, W)];
  const footer = `${DIM} ${BOLD}Esc${RESET}${DIM}/${BOLD}b${RESET}${DIM}:back ${BOLD}j${RESET}${DIM}/${BOLD}k${RESET}${DIM}:scroll ${BOLD}q${RESET}${DIM}:quit${RESET}`;
  if (!state) return [...lines, '', `${DIM}(no session)${RESET}`, footer];
  const body: string[] = [];
  const tasks = [...state.backgroundTasks.values()];
  if (tasks.length === 0) body.push(` ${DIM}(no background tasks)${RESET}`);
  for (const t of tasks) {
    body.push(` ${taskRow(t, now, W)}`);
    const meta = [t.id, t.outputFile ? t.outputFile.replace(process.env.HOME || '', '~') : null, t.outputBytes > 0 ? `${formatTokens(t.outputBytes)}B` : null]
      .filter(Boolean).join('  ');
    body.push(`   ${DIM}${truncateToWidth(meta, W - 4)}${RESET}`);
    if (t.summary) body.push(`   ${DIM}${truncateToWidth(t.summary, W - 4)}${RESET}`);
    const tail = readTaskOutputTail(t, 20);
    for (const l of tail) body.push(`   ${FG.gray}${truncateToWidth(l.replace(/\t/g, '  '), W - 4)}${RESET}`);
    body.push('');
  }
  return [...lines, ...scrollWindow(body, opts.scroll ?? 0, H, W, footer)];
}

/** Full-screen Info view: registry fields, URLs, compactions, cost, model catalog. */
export function renderInfoViewLines(state: SessionState | null, opts: RenderOptions = {}): string[] {
  const W = opts.width ?? Math.max(20, (process.stdout.columns || 80) - 1);
  const H = opts.height ?? (process.stdout.rows || 40);
  const now = opts.now ?? new Date();
  const lines = [titleBar(W, now), pathLine(state, W)];
  const footer = `${DIM} ${BOLD}Esc${RESET}${DIM}/${BOLD}i${RESET}${DIM}:back ${BOLD}j${RESET}${DIM}/${BOLD}k${RESET}${DIM}:scroll ${BOLD}q${RESET}${DIM}:quit${RESET}`;
  if (!state) return [...lines, '', `${DIM}(no session)${RESET}`, footer];
  const body: string[] = [];
  const row = (k: string, v: string | number | null | undefined): void => {
    if (v === null || v === undefined || v === '') return;
    body.push(truncateAnsi(` ${DIM}${pad(k, 14)}${RESET} ${v}`, W));
  };
  const head = (t: string): void => { if (body.length) body.push(''); body.push(` ${BOLD}${FG.cyan}${t}${RESET}`); };

  head('Session');
  row('id', state.sessionId);
  row('title', state.sessionTitle);
  row('slug', state.slug);
  row('cwd', state.cwd);
  row('transcript', state.transcriptFile.replace(process.env.HOME || '', '~'));
  row('version', state.version);
  row('entrypoint', state.entrypoint);
  row('model', state.model);
  row('effort', state.effortLevel);
  row('mode', state.permissions.mode);
  row('scratchpad', state.scratchpadDir);

  const self = state.activeSessions.find(s => s.sessionId === state.sessionId);
  if (self) {
    head('Registry');
    row('pid', self.pid);
    row('name', `${self.name ?? ''}${self.nameSource ? ` ${DIM}(${self.nameSource})${RESET}` : ''}`);
    row('kind', self.kind);
    row('entrypoint', self.entrypoint);
    row('host session', self.hostSessionId);
    row('status', `${self.status ?? ''}${self.statusUpdatedAt ? ` ${DIM}at ${formatTime(new Date(self.statusUpdatedAt))}${RESET}` : ''}`);
    row('version', self.version);
    row('socket', self.messagingSocketPath);
    row('started', formatTime(self.startedAt));
  }

  head('Remote Control');
  row('status', state.remoteControl.active ? `${FG.green}active${RESET}` : `${DIM}off${RESET}`);
  row('url', state.remoteControl.url);
  row('bridge', state.remoteControl.bridgeSessionId);

  if (state.links.prs.length || state.links.artifacts.length || state.links.plan || state.links.feedbackDrafts.length) {
    head('Links');
    for (const pr of state.links.prs) row(`PR #${pr.number}`, `${pr.repository}  ${DIM}${pr.url}${RESET}`);
    for (const a of state.links.artifacts) row('artifact', `${a.title}  ${DIM}${a.url}${RESET}`);
    if (state.links.plan) row('plan', `${state.links.plan.path} ${DIM}(${formatTokens(state.links.plan.bytes)}B)${RESET}`);
    for (const f of state.links.feedbackDrafts) row('feedback', `${f.type}: ${f.title}`);
  }

  if (state.compactions.length > 0) {
    head('Compactions');
    for (const c of state.compactions) {
      row(c.at ? formatTime(c.at) : '?', `${c.trigger} ${formatTokens(c.preTokens)}→${formatTokens(c.postTokens)}${c.durationMs ? ` ${DIM}${(c.durationMs / 1000).toFixed(0)}s${RESET}` : ''}`);
    }
  }

  if (state.cost) {
    head(`Cost${state.cost.isPrevious ? ' (previous session)' : ''}`);
    row('total', formatUsd(state.cost.totalUSD));
    for (const [m, v] of Object.entries(state.cost.perModel)) row(shortModel(m), formatUsd(v));
    row('api time', formatDurationCompact(state.cost.apiDurationMs));
    row('lines', `+${state.cost.linesAdded} / -${state.cost.linesRemoved}`);
  }

  if (state.localCommands.length > 0) {
    head('Local commands');
    for (const c of state.localCommands) row(c.time ? formatTime(c.time) : '?', `${c.command} ${DIM}${c.args}${RESET}`);
  }

  if (state.modelCatalog) {
    head(`Model catalog${state.modelCatalog.fetchedAt ? ` ${DIM}(fetched ${formatTime(state.modelCatalog.fetchedAt)})${RESET}` : ''}`);
    for (const m of state.modelCatalog.models) {
      row(shortModel(m.id), `${m.name}${m.fastMode ? ` ${FG.cyan}fast${RESET}` : ''}${m.effortOptions.length ? ` ${DIM}effort:${m.effortOptions.join('/')}${RESET}` : ''}${m.contextWindow ? ` ${DIM}ctx:${formatTokens(m.contextWindow)}${RESET}` : ''}`);
    }
  }

  return [...lines, ...scrollWindow(body, opts.scroll ?? 0, H, W, footer)];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function render(
  state: SessionState | null,
  fileEvents: Array<{ path: string; time: Date; event: string }>,
  opts: RenderOptions | boolean = {},
): void {
  const o: RenderOptions = typeof opts === 'boolean' ? { isSwitchedView: opts } : opts;
  const view = o.view ?? 'dashboard';
  const lines = view === 'recap'
    ? renderRecapViewLines(state, o)
    : view === 'background'
      ? renderBackgroundViewLines(state, o)
      : view === 'info'
        ? renderInfoViewLines(state, o)
        : renderDashboardLines(state, fileEvents, o);
  process.stdout.write(CLEAR + HIDE_CURSOR + lines.join('\n') + '\n');
}

export function cleanup(): void {
  process.stdout.write(SHOW_CURSOR);
}
