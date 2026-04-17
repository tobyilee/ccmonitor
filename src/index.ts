#!/usr/bin/env bun
/**
 * Claude Code Monitor - TUI app for monitoring ~/.claude session activity.
 *
 * Watches project data files, tracks tool usage, skills, subagents, and teams.
 *
 * Usage:
 *   bun run monitor/src/index.ts [sessionId]
 */

import { watch } from 'chokidar';
import { homedir } from 'os';
import { join } from 'path';
import { findLatestSession, findSessionByCwdAndId, parseTranscript } from './parser.js';
import { render, cleanup } from './ui.js';
import type { SessionState } from './types.js';
import pkg from '../package.json' with { type: 'json' };

const CLAUDE_DIR = join(homedir(), '.claude');
const REFRESH_INTERVAL = 2000;
const PROJECT_CWD = process.cwd();

// Handle --version / -v flag before any other startup work so the binary exits
// cleanly without touching the filesystem or spawning watchers.
const firstArg = process.argv[2];
if (firstArg === '--version' || firstArg === '-v') {
  console.log(pkg.version);
  process.exit(0);
}

// File events ring buffer
const MAX_FILE_EVENTS = 50;
const fileEvents: Array<{ path: string; time: Date; event: string }> = [];

function addFileEvent(path: string, event: string): void {
  fileEvents.push({ path, time: new Date(), event });
  if (fileEvents.length > MAX_FILE_EVENTS) {
    fileEvents.shift();
  }
}

// State
let state: SessionState | null = null;
let running = true;
/** When the user presses 'n' to switch sessions, this holds the target.
 *  While set, refreshState() loads this session instead of the default cwd lookup. */
let selectedSession: { cwd: string; sessionId: string } | null = null;

function refreshState(): void {
  const sessionId = process.argv[2];

  // Priority 1: If the user has switched to a specific session via 'n', keep showing it.
  if (selectedSession) {
    const switched = findSessionByCwdAndId(selectedSession.cwd, selectedSession.sessionId);
    if (switched) {
      state = switched;
      return;
    }
    // Session disappeared (crashed or cleaned up) — fall back to default lookup
    selectedSession = null;
  }

  if (sessionId && state) {
    // Refresh existing session
    state = parseTranscript(state.sessionId, state.projectDir, state.transcriptFile);
  } else if (sessionId) {
    // Find session by ID in projects
    const { readdirSync, existsSync, statSync } = require('fs') as typeof import('fs');
    const projectsDir = join(CLAUDE_DIR, 'projects');
    if (existsSync(projectsDir)) {
      for (const dir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, dir);
        if (!statSync(fullDir).isDirectory()) continue;
        const transcriptFile = join(fullDir, `${sessionId}.jsonl`);
        if (existsSync(transcriptFile)) {
          state = parseTranscript(sessionId, fullDir, transcriptFile);
          break;
        }
      }
    }
  } else {
    // Find latest session for the current project
    state = findLatestSession(PROJECT_CWD);
  }
}

/**
 * Cycle to the next live Claude Code session. Uses the current state's
 * activeSessions list as the source of truth — this list is refreshed every
 * 2 seconds, so it reflects newly-started and recently-ended sessions.
 *
 * Behavior:
 * - If no state yet, do nothing.
 * - If only one session is alive, do nothing (nothing to switch to).
 * - Otherwise, find the next session in the list after the currently-shown
 *   one (wrapping at the end) and select it. Pressing 'n' again cycles further.
 */
function switchToNextSession(): void {
  if (!state || state.activeSessions.length < 2) return;

  const currentId = state.sessionId;
  const idx = state.activeSessions.findIndex(s => s.sessionId === currentId);
  // If current session isn't in the list (shouldn't happen but defensive),
  // pick the first entry.
  const nextIdx = idx === -1 ? 0 : (idx + 1) % state.activeSessions.length;
  const next = state.activeSessions[nextIdx];

  // Skip self (if wrapping results in same session somehow)
  if (next.sessionId === currentId) return;

  selectedSession = { cwd: next.cwd, sessionId: next.sessionId };
  refreshState();
}

// Setup file watcher
const watcher = watch(
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

// Setup keyboard input
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\x03') {
      // q or Ctrl+C
      running = false;
      cleanup();
      watcher.close();
      process.exit(0);
    }
    if (key === 'r') {
      // 'r' also clears any switched-session override, returning to the CWD-default view
      selectedSession = null;
      refreshState();
      render(state, fileEvents, selectedSession !== null);
    }
    if (key === 'n') {
      switchToNextSession();
      render(state, fileEvents, selectedSession !== null);
    }
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  running = false;
  cleanup();
  watcher.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  running = false;
  cleanup();
  watcher.close();
  process.exit(0);
});

// Main loop — recursive setTimeout is more reliable than setInterval in Bun
console.log('Starting Claude Code Monitor...');
refreshState();
render(state, fileEvents, selectedSession !== null);

function tick(): void {
  if (!running) return;
  refreshState();
  render(state, fileEvents, selectedSession !== null);
  setTimeout(tick, REFRESH_INTERVAL);
}
setTimeout(tick, REFRESH_INTERVAL);
