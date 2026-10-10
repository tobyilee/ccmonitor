#!/usr/bin/env bun
/**
 * Claude Code Monitor - TUI app for monitoring ~/.claude session activity.
 *
 * Usage:
 *   ccmonitor [sessionId]
 *   ccmonitor --fixture fixtures/<name>.jsonl   # parse a fixture, no watcher / registry
 */

import { watch, type FSWatcher } from 'chokidar';
import { join, resolve, dirname, basename } from 'path';
import {
  CLAUDE_DIR,
  TranscriptReader,
  locateLatestSession,
  locateSessionByCwdAndId,
  locateSessionById,
  makeContext,
  type SessionLocation,
} from './parser.js';
import { render, cleanup, sectionForKey, type View } from './ui.js';
import { sessionRows } from './views/sessions.js';
import { loadUiPrefs, saveUiPrefs } from './uiPrefs.js';
import type { SessionState } from './types.js';

const REFRESH_INTERVAL = 2000;
const PROJECT_CWD = process.cwd();

// --- CLI args ---
const argv = process.argv.slice(2);
let fixturePath: string | null = null;
let sessionArg: string | null = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? '';
  if (a === '--fixture') {
    fixturePath = resolve(argv[++i] ?? '');
  } else if (a === '--help' || a === '-h') {
    console.log('usage: ccmonitor [sessionId] [--fixture <path.jsonl>]');
    process.exit(0);
  } else if (!a.startsWith('-')) {
    sessionArg = a;
  }
}
const FIXTURE_MODE = fixturePath !== null;

// File events ring buffer
const MAX_FILE_EVENTS = 50;
const fileEvents: Array<{ path: string; time: Date; event: string }> = [];

function addFileEvent(path: string, event: string): void {
  fileEvents.push({ path, time: new Date(), event });
  if (fileEvents.length > MAX_FILE_EVENTS) fileEvents.shift();
}

// State
let state: SessionState | null = null;
let running = true;
let reader: TranscriptReader | null = null;
/** When the user presses 'n' to switch sessions, this holds the target. */
let selectedSession: { cwd: string; sessionId: string } | null = null;
/** Current screen: dashboard, or one of the full-screen views (c / b). */
let view: View = 'dashboard';
let scroll = 0;
let showDenials = false;
let cursor = 0;
const uiPrefs = loadUiPrefs();

function draw(): void {
  render(state, fileEvents, { isSwitchedView: selectedSession !== null, view, scroll, showDenials, collapsed: uiPrefs.collapsed, cursor });
}

/** Enter in the session picker: switch to the highlighted session. */
function selectCursorSession(): void {
  if (!state) return;
  const rows = sessionRows(state);
  const row = rows[Math.min(cursor, rows.length - 1)];
  if (!row) return;
  selectedSession = row.isCurrent ? null : { cwd: row.session.cwd, sessionId: row.session.sessionId };
  view = 'dashboard';
  scroll = 0;
  refreshState();
}

/** Number keys toggle a dashboard section; the choice is persisted. */
function toggleSection(key: string): boolean {
  const section = sectionForKey(key);
  if (!section) return false;
  if (uiPrefs.collapsed.has(section.id)) uiPrefs.collapsed.delete(section.id);
  else uiPrefs.collapsed.add(section.id);
  saveUiPrefs(uiPrefs);
  return true;
}

function setView(next: View): void {
  view = view === next ? 'dashboard' : next;
  scroll = 0;
}

function readerFor(loc: SessionLocation): TranscriptReader {
  if (!reader || reader.ctx.transcriptFile !== loc.transcriptFile) {
    reader = new TranscriptReader(makeContext(loc.sessionId, loc.projectDir, loc.transcriptFile));
  }
  return reader;
}

function locate(): SessionLocation | null {
  if (fixturePath) {
    return {
      sessionId: basename(fixturePath, '.jsonl'),
      projectDir: dirname(fixturePath),
      transcriptFile: fixturePath,
    };
  }
  if (selectedSession) {
    const loc = locateSessionByCwdAndId(selectedSession.cwd, selectedSession.sessionId);
    if (loc) return loc;
    selectedSession = null; // session disappeared — fall back
  }
  if (sessionArg) return locateSessionById(sessionArg);
  return locateLatestSession(PROJECT_CWD);
}

function refreshState(): void {
  const loc = locate();
  if (!loc) {
    state = null;
    return;
  }
  state = readerFor(loc).refresh({ skipLive: FIXTURE_MODE }).state;
}

/**
 * Cycle to the next live Claude Code session (from activeSessions, refreshed
 * every 2 s). No-op with fewer than two live sessions.
 */
function switchToNextSession(): void {
  if (!state || state.activeSessions.length < 2) return;
  const currentId = state.sessionId;
  const idx = state.activeSessions.findIndex(s => s.sessionId === currentId);
  const nextIdx = idx === -1 ? 0 : (idx + 1) % state.activeSessions.length;
  const next = state.activeSessions[nextIdx];
  if (!next || next.sessionId === currentId) return;
  selectedSession = { cwd: next.cwd, sessionId: next.sessionId };
  refreshState();
}

// Setup file watcher (not in fixture mode)
let watcher: FSWatcher | null = null;
if (!FIXTURE_MODE) {
  watcher = watch(
    [
      join(CLAUDE_DIR, 'projects', '**', '*.jsonl'),
      join(CLAUDE_DIR, 'projects', '**', '*.json'),
      join(CLAUDE_DIR, 'tasks', '**', '*.json'),
      join(CLAUDE_DIR, 'teams', '**', '*'),
      join(CLAUDE_DIR, 'sessions', '*.json'),
      join(CLAUDE_DIR, 'file-history', '**', '*'),
      join(CLAUDE_DIR, '.omc', 'state', 'last-skill-complete.json'),
    ],
    {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    },
  );
  watcher
    .on('add', (path: string) => addFileEvent(path, 'add'))
    .on('change', (path: string) => addFileEvent(path, 'change'))
    .on('unlink', (path: string) => addFileEvent(path, 'unlink'));
}

function shutdown(): void {
  running = false;
  cleanup();
  watcher?.close();
  process.exit(0);
}

// Setup keyboard input
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (key: string) => {
    switch (key) {
      case 'q':
      case '\x03':
        shutdown();
        return;
      case 'r':
        // 'r' also clears any switched-session override, returning to the CWD-default view
        selectedSession = null;
        refreshState();
        break;
      case 'n':
        switchToNextSession();
        break;
      case 'c':
        setView('recap');
        break;
      case 'b':
        setView('background');
        break;
      case 'i':
        setView('info');
        break;
      case 's':
        setView('sessions');
        if (view === 'sessions' && state) {
          cursor = Math.max(0, sessionRows(state).findIndex(r => r.isCurrent));
        }
        break;
      case '\r':
      case '\n':
        if (view === 'sessions') selectCursorSession();
        else return;
        break;
      case 'd':
        showDenials = !showDenials;
        break;
      case '\x1b': // Esc
        view = 'dashboard';
        scroll = 0;
        break;
      case 'j':
      case '\x1b[B': // Down
        if (view === 'sessions') cursor++;
        else if (view !== 'dashboard') scroll++;
        break;
      case 'k':
      case '\x1b[A': // Up
        if (view === 'sessions') cursor = Math.max(0, cursor - 1);
        else if (view !== 'dashboard') scroll = Math.max(0, scroll - 1);
        break;
      case ' ':
      case '\x1b[6~': // PageDown
        if (view !== 'dashboard') scroll += 10;
        break;
      case '\x1b[5~': // PageUp
        if (view !== 'dashboard') scroll = Math.max(0, scroll - 10);
        break;
      default:
        if (!toggleSection(key)) return;
    }
    draw();
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Main loop — recursive setTimeout is more reliable than setInterval in Bun
console.log('Starting Claude Code Monitor...');
refreshState();
draw();

function tick(): void {
  if (!running) return;
  refreshState();
  draw();
  setTimeout(tick, REFRESH_INTERVAL);
}
setTimeout(tick, REFRESH_INTERVAL);
