# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-10-10

### Added
- **Recap panel (F1).** A new box under Last Prompt shows what Claude just said it did: the `CC:` line is Claude Code's own session recap (`system/away_summary`, written about 3 minutes after a turn ends); below a `── Final reply HH:MM:SS (model) ──` divider comes the "Korean recap" section of the last `end_turn` reply, or its first 6 lines when there is no such section. While a turn is open the title turns yellow and the first line is `now: <mid-turn narration>`. Capped at 8 lines with `… (+N lines, press c)`.
- **`c` full-screen recap view.** The whole final reply, Markdown-lite rendered (bold/code markers stripped, fenced blocks shown as `[code]`), word-wrapped CJK-aware, scrollable with `j`/`k` (or arrows, Space/PageUp/PageDown). `Esc` or `c` returns.
- **Turn line (F2).** `Turn:#N ⏱ 1m04s (open) tools:12` while Claude works; `Turn:#N done 4m02s · avg 2m10s · ▂▅▃▇▁` when idle (block sparkline of the last 10 turn durations, from `system/turn_duration`). Turns opened by background task notifications or peer messages are tagged and do not move the Last Prompt.
- **Background panel (F3).** Replaces the Subagents box when the session has launched async agents (`Agent` → `status: async_launched`), background Bash commands (`run_in_background`) or Monitors. Rows: `● agent code-reviewer "Review the slice" 2m14s fable-5-1`, `✓ bash "Run tests" exit 0 12s`, red `✗` on failure. Completion comes from `<task-notification>` queue entries; still-running Bash tasks are also checked for the `[exited with code N]` trailer in their scratchpad output file.
- **`b` full-screen background view.** Lists every task with id, output file, notification summary and the last 20 lines of its output file (read on demand, never on the dashboard).
- **Test suite.** `bun test` (69 tests) with synthetic transcripts and nine scrubbed fixtures under `fixtures/` cut from real sessions by `scripts/make-fixture.ts` (`scripts/cut-fixtures.sh` re-cuts them). Each fixture has a measured `.expect.json` sidecar. `bun run typecheck` runs `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess`.
- **`--fixture <path.jsonl>` flag** renders a fixture with no file watcher, registry or network access.
- **Unknown-field log.** Entry types, system subtypes and attachment kinds the parser does not know are appended once per run to `~/.claude/ccmonitor-unknown-fields.log`, so schema drift in new Claude Code versions is visible.
- `scripts/bench-parse.ts` times a full parse and an incremental refresh.

### Changed
- **Token and message counts are now per API response, not per JSONL line.** Newer Claude Code writes one assistant response as several lines sharing `message.id` (thinking / text / tool_use), each carrying the same `usage`. The old parser added usage once per line. On the live ccmonitor session the header moved from `A:93` to `A:30` and `O:408.7K` to `O:95.2K`; `U:` did not change. Expect lower numbers than 1.5.x on the same session.
- **Incremental parsing.** Each refresh reads only the bytes appended since the last one (8 MB transcript: 19 ms first parse, 0.3 ms per refresh). A shrunken file or a rewritten first 64 bytes (`CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`) triggers a full reparse. `CCMONITOR_FULL_PARSE=1` forces the old whole-file path.
- **Compaction count** uses `system/compact_boundary` when the transcript has one; the >30 percent-drop heuristic is kept only for transcripts from Claude Code < 2.1.280.
- **Context window** for Claude 5 family models (Fable, Mythos, Opus/Sonnet/Haiku 5.x) is 1M tokens; `Ctx:%` no longer exceeds 100 on those sessions.
- The header shows the model without the `claude-` prefix, and free-text header lines are truncated with `…` instead of wrapping on narrow terminals. Emoji count as two columns in width calculations.
- The **Tasks** box is hidden when empty (task tools are off by default on Claude 5 models).
- `CC:vX.Y.Z` falls back to the version stamped in the transcript when the session is not in the live registry (fixtures, finished sessions).
- Parser split into a pure per-entry state machine (`src/entry.ts`, `src/state.ts`, `src/recap.ts`) and disk loaders (`src/loaders/*`); `src/parser.ts` orchestrates. `parseTranscriptLines` runs without the file system, clock or process access.

## [1.5.0] - 2026-08-02

### Added
- **AI session title in the header.** Newer Claude Code writes `ai-title` transcript entries with an AI-generated conversation title; it now renders next to the cwd/branch line, truncated CJK-aware to the terminal width.
- **Live session status dots.** `~/.claude/sessions/<pid>.json` now reports each session's status directly. Other sessions render as registry-name chips (e.g. `ccmonitor-b6`) with a status dot: yellow ●=busy, red ●=waiting for user input, dim ○=idle.
- **Claude Code version (`CC:vX.Y.Z`) in the header**, read from the current session's registry entry.

### Changed
- **Real cwd from transcript entries.** Every transcript entry now carries the session's actual `cwd`; the monitor prefers it over reversing the project directory name — which was lossy for paths containing `_` or `.` (NG-6). The reversal remains only as a fallback for old transcripts.
- **Git branch from transcript entries as fallback.** Live `.git/HEAD` parsing is still the primary source (reflects mid-session branch switches immediately); the per-entry `gitBranch` field covers cases where HEAD is unreadable.
- **Last Prompt panel now uses `last-prompt` entries.** Claude Code records the verbatim user-typed prompt as a dedicated entry type; the tag-stripping regex heuristic is demoted to a fallback for old transcripts.
- **Effort indicator reads the per-turn `effort` field.** Newer Claude Code no longer persists `effortLevel` in the settings cascade (the indicator was silently blank); assistant entries now record the effort actually used per turn, which is authoritative. The settings cascade remains as a fallback.

## [1.4.0] - 2026-04-26

### Fixed
- **Session switcher (`n` key) now works for worktree paths.** `cwdToProjectDirName` only replaced `/` and `_` with `-`, but Claude Code also replaces `.` — so cwds like `/Users/foo/proj/.claude/worktrees/branch` were being mapped to `-Users-foo-proj-.claude-worktrees-branch` instead of the actual on-disk `-Users-foo-proj--claude-worktrees-branch`. `findSessionByCwdAndId` then returned null, `refreshState` silently reverted `selectedSession`, and pressing `n` looked like a no-op. The regex now also covers `.`, so worktree sessions are reachable through the switcher.

## [1.3.0] - 2026-04-24

### Added
- **Token analytics row** — new dashboard line showing burn rate (tokens/min), compaction count (detected via >30% context token drops between turns), peak context tokens, and a braille sparkline of per-turn token usage.
- **Rate limit quota bars** — reads `~/.claude/abtop-rate-limits.json` (written by abtop's StatusLine hook) and renders inline 5-hour and 7-day usage bars with color thresholds (green <50%, yellow 50-80%, red 80%+), reset countdowns, and a stale-data indicator.
- **Tool execution durations** — pairs `tool_use` → `tool_result` timestamps in the transcript to compute average and max execution time per tool, shown as `~Ns` suffixes in the Tools panel.
- **Process monitoring panel** — reads RSS memory and child processes for the Claude Code session PID via `ps` (using `execFileSync` with no shell for safety). Shows `Mem:NMB` in the session header and a collapsible Processes box listing up to 5 children sorted by memory.

### Changed
- `SessionState` expanded with `contextWindow`, `contextPercent`, `compactionCount`, `maxContextTokens`, `tokenHistory`, `tokenBurnRate`, `rateLimit`, `toolDurations`, `processMemMb`, and `childProcesses` fields.
- New types: `RateLimitInfo`, `ToolDuration`, `ChildProcess`.

## [1.2.0] - 2026-04-17

### Fixed
- **Context % over 100% (sometimes 200%+) for Opus 4.7 sessions.** `getContextLimit` was hard-coded to recognize only Opus 4.5 / 4.6 as 1M-context models, so Opus 4.7 silently fell through to the generic `opus` branch (200K) and produced inflated percentages on long sessions (e.g. an 800K-token context displayed as 400%). The lookup now uses a regex that absorbs every Opus 4.x where x ≥ 5 — including future 4.8, 4.9, 4.10+ — and also recognizes the explicit `[1m]` runtime variant marker.

## [1.1.0] - 2026-04-17

### Added
- **Reasoning effort indicator (`Effort:`) in the title bar.** Shows the current Claude Code reasoning level (`low` / `medium` / `high` / `max`) color-coded by intensity (`max`=magenta, `high`=red, `medium`=yellow, `low`=gray, unknown=cyan). The value is resolved from the same three-layer settings cascade Claude Code uses — project `.claude/settings.local.json` → project `.claude/settings.json` → user `~/.claude/settings.json` — so the monitor never disagrees with the live session when a project overrides the global default.

### Changed
- The persisted internal effort value `xhigh` is now displayed as `max` in the title bar to match the user-facing label that `/effort max` accepts as input. The underlying stored value is preserved as-is in `~/.claude/settings.json`; only the display layer is mapped.

## [1.0.0]

Initial public release. See [git history](https://github.com/tobyilee/ccmonitor/commits/main) for the prior change set, including:

- Real-time TUI dashboard for Claude Code sessions (auto-refresh every 2s)
- Tools / Subagents / Skills / Teams / Tasks / Memory / File Activity panels
- Last Prompt panel with CJK-aware word wrap
- Active sessions counter with cross-project visibility (`Sess:N (+other, projects)`)
- Files-edited counter derived from `~/.claude/file-history/`
- Memory panel summarizing auto-memory categories and recent topics
- Context-window indicator with yellow/red warning thresholds
- Session switcher (press `n`) for cycling across live Claude Code sessions
- Standalone binary via `bun build --compile`; global install via `bun run install:global`
- 24-bit truecolor title bar with deterministic cross-theme rendering
- Git branch in path line read directly from `.git/HEAD` (no subprocess)
