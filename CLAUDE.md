# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ccmonitor** — A standalone Bun TUI app that monitors Claude Code session activity in real time. It watches `~/.claude/` data files (JSONL transcripts, subagent metadata, team configs, task files) and renders a terminal dashboard showing tool usage, skills, subagents, teams, tasks, token consumption, and file activity.

## Build & Run Commands

```bash
bun run start          # Run the monitor (bun run src/index.ts)
bun run dev            # Run with --watch for auto-reload
bun run build          # Compile to standalone binary: dist/ccmonitor
bun run install:global # Build + copy binary to ~/.bun/bin/ccmonitor
```

Run with a specific session: `bun run src/index.ts <sessionId>`

## Testing

```bash
bun test               # synthetic + fixture tests (src/*.test.ts, fixtures/*.jsonl)
bun run typecheck      # tsc --noEmit, strict + noUncheckedIndexedAccess
bun run src/index.ts --fixture fixtures/recap-basic.jsonl   # render a fixture, no watcher/registry
```

Fixtures are scrubbed cuts of real transcripts (`scripts/make-fixture.ts`, re-cut with `scripts/cut-fixtures.sh`). Each has a measured `.expect.json` sidecar. Before a release also run `bun run build` and the width sweep in `src/ui.test.ts` (80/100/140 columns). Golden renders live in `fixtures/golden/`; after a deliberate visual change run `bun run scripts/update-golden.ts` and read the diff.

## Upgrade

When the user says `upgrade`:
- Bump the minor version in `package.json`
- Verify with `bun run build` (rebuild `dist/ccmonitor`)
- Add an entry to `CHANGELOG.md` (Keep a Changelog format)
- Update `README.md` (version line + any user-facing changes)
- Save, commit, push

## Architecture

No external UI framework — raw ANSI escape codes to stdout. Parsing is split into a pure layer and disk loaders:

- **index.ts** — Entry point. CLI args (`[sessionId]`, `--fixture`), chokidar watcher, keyboard (q/r/n/s/c/b/i/d/1-9/0/Enter/Esc/j/k), view state (`dashboard | recap | background | info | sessions`), collapsed-section prefs (`src/uiPrefs.ts` → `~/.claude/ccmonitor-ui.json`), 2-second refresh loop. Holds one `TranscriptReader` per transcript file.
- **parser.ts** — Orchestration. `parseTranscriptLines(lines, ctx)` (pure), `enrichSessionState(state)` (runs the loaders on a copy), `TranscriptReader` (incremental tail reads; full reparse when the file shrinks or its first 64 bytes change), `locate*Session` helpers, `computeDerived`.
- **entry.ts** — The pure per-entry state machine (`processEntry` + `handleSystem` / `handleAttachment` / `handleAssistant` / `handleUser` …). Groups assistant lines by `message.id`, opens/closes turns, tracks background tasks, recap text, hooks, permissions, cost, links, queue, attribution, errors. Reports unknown `type` / `system.subtype` / `attachment.type` values through `ctx.onUnknown`.
- **state.ts** — `createSessionState`, `ParseMemo` (parser working memory), `ParseSession`.
- **recap.ts** — Pure text helpers: `extractKoreanRecap`, `mdToPlain`, `parseTaskNotification`, `cleanNativeRecap`.
- **loaders/** — One file per disk source (subagents, teams, tasks, skillHook, git, fileHistory, sessions, memory, effort, rateLimit, process, scratchpad, globalConfig, modelCatalog, plans, feedback, history, update).
- **views/sessions.ts** — pure row builder for the session picker. `paths.ts` holds `CLAUDE_DIR` (override with `CCMONITOR_CLAUDE_DIR`).
- **types.ts** — All TypeScript interfaces. `SessionState` is the central data structure; `TranscriptEntry` models the JSONL schema.
- **ui.ts** — Pure rendering. The dashboard is header + `SECTIONS` (each a `Section {id, key, title, render}`) + footer; `renderDashboardLines` / `renderRecapViewLines` / `renderBackgroundViewLines` / `renderInfoViewLines` / `renderSessionsViewLines` return `string[]`; `render()` writes to stdout. Adding a panel = appending to `SECTIONS`. Handles CJK fullwidth and emoji widths. No state mutation.
- **keys.ts** — `splitKeys`: splits a stdin chunk into single keys (escape sequences whole). `CCMONITOR_KEYLOG=<file>` logs raw chunks.
- **unknownFields.ts** — Appends unknown kinds to `~/.claude/ccmonitor-unknown-fields.log`.

### Key Design Decisions

- **CWD-scoped by default**: Without a sessionId argument, the monitor finds the latest session matching `process.cwd()` by converting the path to Claude's directory naming convention (`/Users/foo/bar` → `-Users-foo-bar`).
  - **Known footgun:** `cwdToProjectDirName` maps `_` → `-` (fixed in PR #1), but the inverse `projectDirToRealCwd` only maps `-` → `/`. A cwd containing `_` (e.g. `/Users/foo_bar/baz`) round-trips lossy. Tracked in `quality-20260417.md` Issue #4 and `tasks/prd-quality-uplift.md` NG-6.
- **Message-id grouping**: one API response is written as several JSONL lines sharing `message.id`; `usage` and the `A:` counter are taken once per id. Numbers are lower than in 1.5.x on the same session.
- **Turns**: a `user` entry with `promptSource` in typed/queued/suggestion_accepted/sdk or `turnOrigin: human` opens a turn; `system/turn_duration` closes it. Transcripts older than 2.1.281 fall back to "user entry with real text" (never `isMeta` entries).
- **Background tasks**: launches are remembered from `tool_use` blocks (`Agent`, `Bash` with `run_in_background`, `Monitor`) and resolved by the matching `toolUseResult` (`async_launched` / `backgroundTaskId`). Completion comes from `<task-notification>` blocks in `queue-operation` entries or user prompts; Bash output files are also checked for `[exited with code N]`.
- **Subagent status heuristic**: A subagent is considered "completed" if its `.jsonl` file hasn't been modified in 30 seconds.
- **Skill completion detection**: Two mechanisms — (1) transcript parsing detects `stop_reason === 'end_turn'` on assistant messages, (2) a PostToolUse hook (`scripts/on-skill-complete.sh`) writes to `~/.claude/.omc/state/last-skill-complete.json` for faster detection.
- **No imports from Claude Code codebase** — fully decoupled. Reads only the file artifacts Claude Code produces.

### Reference: `~/.claude/` File Structure

The monitor reads these paths (documented in detail in `filegen.md`):

| Path Pattern | Content |
|---|---|
| `projects/<sanitized-cwd>/<sessionId>.jsonl` | Session transcript (JSONL, append-only) |
| `projects/<sanitized-cwd>/<sessionId>/subagents/agent-*.meta.json` | Subagent metadata |
| `projects/<sanitized-cwd>/<sessionId>/subagents/agent-*.jsonl` | Subagent transcripts |
| `teams/<name>/config.json` | Team member list |
| `teams/<name>/inboxes/` | Team message inboxes |
| `tasks/<sessionId>/*.json` | Task/TODO data |
| `sessions/<pid>.json` | Active session registry |
| `.omc/state/last-skill-complete.json` | Hook-written skill completion signal (optional) |
| `cache/model-catalog/*.json` | Model list, effort options, fast-mode flags |
| `plans/<slug>.md` (or `settings.plansDirectory`) | Plan-mode output for the session slug |
| `feedback/drafts/*.json` | SendFeedback drafts (`source_session_id`) |
| `ccmonitor-ui.json` | Collapsed panel preferences (written by ccmonitor) |
| `history.jsonl` | Typed prompts across projects (last prompt per session in the picker) |
| `.last-update-result.json`, `cache/changelog.md` | Update awareness |
| `~/.claude.json` → `projects[cwd].lastCost` | Previous-session cost fallback |
| `/private/tmp/claude-<uid>/<proj>/<sid>/tasks/<id>.output` | Background task output (path from the `environment` attachment / `toolUseResult.outputFile`) |

### Hook Script

`scripts/on-skill-complete.sh` — A PostToolUse hook for the Skill tool. Receives `PostToolUseHookInput` JSON on stdin, extracts skill name/args, writes completion state JSON. Install by referencing it in Claude Code's `settings.json` hooks config.
