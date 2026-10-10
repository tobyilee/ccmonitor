# ccmonitor

**Version: 1.10.0**

Real-time TUI dashboard for monitoring Claude Code sessions.

Reads `~/.claude/` data files every 2 seconds and displays live activity — a recap of what Claude just did, turn timing, background agents and commands, tool usage, skills, token consumption, and the git working-tree status of the project.

## Screenshot

The dashboard refreshes every 2 seconds by default (`↑`/`↓` change the interval) and renders entirely with ANSI escape codes — no external UI framework. Here's what an active session looks like (colors are suggested in brackets; actual output uses ANSI):

```
 Claude Code Monitor                                                  17:18:00    [#1e3a8a bg, #ffffff bold]
 /Users/you/workspace/my-project [main] — Add git branch to the header bar         [dim gray + magenta + cyan]
 Session:⌨ a1b2c3d4·merry-tarjan Model:opus-4-6 Effort:max Ctx:18% Age:12m 30s Idle:2s
 Turn:#7 done 4m02s · avg 2m10s · ▂▅▃▇▁ Mode:auto(bash-first) RC●
 Sess:3 (+●api-f3, 🖥○docs-a1) CC:v2.1.296 update available (2.1.297)
 Msgs:U:5 A:12 Tok:I:45.2K O:8.3K CW:12.1K CR:38.0K Files:12
 Cost:$1.03 API:1m23s Tools:1.3s +12/-3 opus-4-6:$1.03
 Rate:8.2K/min Compact:1 (auto 180.2K→14.1K) Peak:245.3K Think:4.9s ⣀⣤⣶⣿⣿⣶⣤⣀⣤⣶⣿⣿⣶⣤⣀⣤⣶⣿⣿
 Quota 5h:████░░░░░░ 42% (2h 15m) 7d:██░░░░░░░░ 18% (5d 3h)
┌─ Last Prompt  17:17:45 ─────────────────────────────────────────────────────┐
│ add a feature to show git branch next to the current path, and adjust the   │
│ title bar color to be more readable                                         │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Recap  17:21:03 ───────────────────────────────────────────────────────────┐
│ CC: You asked for a git branch in the header, so I read .git/HEAD and       │
│ rendered it next to the cwd. Next, say pr to open the PR.                   │
│ ── Final reply 17:18:00 (opus-4-6) ───────────────────────────────────────  │
│ - 경로 옆에 현재 브랜치를 마젠타로 표시했습니다.                              │
│ - 타이틀 바를 진한 남색(#1e3a8a) 배경으로 바꿨습니다.                         │
│ … (+6 lines, press c)                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Tools ─────────────────────────────────────────────────────────────────────┐
│ Edit:15 Bash:12 Read:8 Grep:5 Agent:3 Skill:2 Write:1                        │
│ Denied:1 (hook 1) (d)                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Background  1 running ─────────────────────────────────────────────────────┐
│ ● agent Explore "Find auth middleware files" 1m22s opus-4-6                 │
│ ✓ bash  "Run the unit tests" exit 0 42s                                     │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Skill ─────────────────────────────────────────────────────────────────────┐
│ ● /commit (Fix login bug)  3s                                               │
│   /oh-my-claudecode:plan at 17:15:02                                        │
│   /deep-interview at 17:10:44                                               │
│ frontend-design attributed:6                                                │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Hooks ─────────────────────────────────────────────────────────────────────┐
│ PreToolUse:37 Stop:3 SessionStart:1  errors:0                               │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Links ─────────────────────────────────────────────────────────────────────┐
│ PR #42 you/my-project                                                       │
│ Plan my-project-swift-river.md (12 KB)                                      │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Teams ─────────────────────────────────────────────────────────────────────┐
│ research-team (3)                                                           │
│   explorer                                                                  │
│   planner                                                                   │
│   reviewer                                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Tasks ─────────────────────────────────────────────────────────────────────┐
│ ✔ Refactor auth middleware                                                  │
│ ● Write migration tests                                                     │
│ ○ Update API docs                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Memory ────────────────────────────────────────────────────────────────────┐
│ MEMORY.md (127 lines) + 9 topics last: 2h 15m ago                           │
│   categories: feedback:5 project:3 user:1                                   │
│   recent: user_profile, feedback_naming, project_codex_model                │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Git Status ────────────────────────────────────────────────────────────────┐
│ +1 new  ~2 modified  -0 deleted                                             │
│  M src/ui.ts                                                                │
│  M README.md                                                                │
│ ?? src/loaders/gitStatus.ts                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
 q:quit r:refresh c:recap b:background d:denials i:info s:sessions n:next | auto 2s ↑↓ hidden:9
```

### Visual highlights

- **Title bar** — deep blue (`#1e3a8a`) background with bold pure-white (`#ffffff`) text. Uses 24-bit truecolor for deterministic rendering across terminal themes.
- **Path line** — dim gray cwd (read from the transcript's per-entry `cwd` field, so paths containing `_` or `.` display correctly), the current git branch in magenta brackets (from `.git/HEAD`, with the transcript's `gitBranch` field as fallback), and the AI-generated session title in cyan — truncated CJK-aware to the terminal width.
- **Recap** — `CC:` is Claude Code's own one-line session recap (`system/away_summary`, written a few minutes after a turn ends; disable with `/config`). Below the divider is the "Korean recap" section of Claude's last reply, or its first lines. While Claude is working the title turns yellow and a `now:` line shows the latest mid-turn narration. Press `c` for the full reply.
- **Turn line** — elapsed time and tool calls of the open turn, or the last turn's duration, the average, and a sparkline of the last 10 turns (from `system/turn_duration`).
- **Background** — async `Agent` runs, `run_in_background` Bash commands and Monitors with status, elapsed time, exit code and model. Replaces the Subagents box when present. Press `b` for each task's output tail.
- **Mode / RC chips** — `Mode:auto(bash-first)` is the permission mode the session runs under (cyan auto, magenta plan, red bypassPermissions); `RC●` means Remote Control is active (URL in the `i` view).
- **Cost line** — total and per-model cost, API time, tool time and lines added/removed from the transcript's `cost-state` entry; `(prev session)` when it falls back to `~/.claude.json`.
- **Denied strip** — count of rejected tool calls by reason inside the Tools box; `d` expands the last 5 with the blocking rule.
- **Hooks** — per-event hook run counts, non-zero exits, and a `STOP BLOCKED` badge when a Stop hook prevented the turn from ending.
- **Links** — the session's pull requests, Artifacts, plan file and feedback drafts; URLs in the `i` view.
- **Queue chip** — `Queue:N` while prompts wait behind the running turn, with the next one previewed under Last Prompt.
- **Attribution** — the Skill box shows how many responses ran under each skill or plugin; an `MCP` box counts calls per MCP server; `Think:4.9s` is the mean thinking time per response, `Advisor:…` counts advisor calls, `Fast` marks fast mode.
- **Error strip** — a red line appears under the header when the last three turns saw an API error, an interrupt or an aborted stream.
- **Session counter** — `Sess:N` (on its own line) shows how many Claude Code processes are alive across all terminals, plus up to four other sessions as registry-name chips (e.g. `ccmonitor-b6`) with a live status dot: yellow `●`=busy, red `●`=waiting for user input, dim `○`=idle, grey `?`=status older than 10 minutes. `🖥` marks Claude Desktop sessions. Additional sessions beyond the first four are shown as a `+N` overflow count. `CC:vX.Y.Z` shows the Claude Code version running the current session.
- **Files counter** — `Files:N` shows the number of unique files edited in this session (file-history directory and transcript `file-history-delta` / Write / Edit records; `~N` when the two sources disagree). The Git Status box at the bottom shows the working tree of the session cwd: `+N new  ~N modified  -N deleted` and the first 8 entries of `git status --porcelain`.
- **Update awareness** — `update available (x.y.z)` appears after the Claude Code version when `.last-update-result.json` names a newer release; the `i` view shows the newest cached changelog bullets.
- **Last Prompt** — shows the most recent user-typed prompt with the timestamp in the box title, CJK-aware word wrap, and a 500-character hard cap. Sourced from the transcript's dedicated `last-prompt` entries (verbatim text); falls back to tag-stripping heuristics for old transcripts.
- **Memory panel** — summarizes the auto-memory system for this project: MEMORY.md size, topic count, category breakdown by filename prefix, and the 3 most recently modified topics.
- **Reasoning effort** — `Effort:max` shows the current Claude Code reasoning level color-coded by intensity (max=magenta, high=red, medium=yellow, low=gray). Read from the per-turn `effort` field newer Claude Code stamps on assistant transcript entries (the value actually used), falling back to the settings cascade (project `.claude/settings.local.json` → project `.claude/settings.json` → user `~/.claude/settings.json`) for old transcripts. The internal value `xhigh` is displayed as `max` to match what `/effort max` accepts as input.
- **Token analytics** — `Rate:8.2K/min` shows average token burn rate, `Compact:2 (manual 535.0K→13.8K)` counts context compactions exactly from `system/compact_boundary` (the >30% token-drop heuristic is kept only for transcripts from Claude Code older than 2.1.280), `Peak:245.3K` tracks the high-water mark, `Think:4.9s` is the mean thinking time per response, and a braille sparkline visualizes per-response token volume.
- **Rate limit quota** — inline 10-char usage bars for the 5-hour and 7-day quota windows, fetched from the Anthropic OAuth usage API (token from the macOS Keychain) and cached for 5 minutes in `~/.claude/ccmonitor-usage-cache.json`; falls back to abtop's `~/.claude/abtop-rate-limits.json`. Color-coded green/yellow/red with reset countdowns. Marked `(stale)` when the cached data is older than its TTL.
- **Process memory** — `Mem:NMB` in the session header shows the Claude Code process RSS (via `ps`, no shell).
- **Context indicator** — `Ctx:18%` turns yellow at 70% and red at 85% so you notice context exhaustion before it bites. The window is 1M tokens for Claude 5 family models (Fable, Mythos, Opus/Sonnet/Haiku 5.x) and Opus 4.5+, 200K otherwise.
- **Subagent status** — `●` (running, yellow), `✔` (completed, green), `✘` (error, red); completed-count summary appears in the box title when there are finished agents.
- **Session picker** — press `s` for a list of live sessions (status, entrypoint, name, cwd, age, version, last typed prompt from `history.jsonl`); `Enter` switches, `Esc` returns. `n` still cycles through them one by one. A high-contrast yellow `VIEWING` badge in the footer reminds you that you're watching a switched session; press `r` to return to the default view for your current cwd.

## Requirements

- [Bun](https://bun.sh/) v1.0+
- `git` on `PATH` (optional; without it the Git Status box shows `(not a git repository)`)

## Install

### From source (run directly)

```bash
git clone https://github.com/tobyilee/ccmonitor.git && cd ccmonitor
bun install
bun run start
```

### Global install (recommended)

```bash
git clone https://github.com/tobyilee/ccmonitor.git && cd ccmonitor
bun install
bun run install:global
```

This runs [`scripts/install.ts`](./scripts/install.ts), which builds the standalone binary via `bun build --compile` and installs it to `~/.bun/bin/ccmonitor` by default. After install, run it from anywhere with `ccmonitor`.

**Options:**

```bash
bun run install:global -- --dir /usr/local/bin   # custom install directory
bun run install:global -- --name ccmon           # custom binary name
```

The `bun build --compile` flag embeds the Bun runtime into a single binary (~62MB), so once installed, the machine does not need Bun on PATH to run it.

### Global link (for development)

```bash
cd ccmonitor
bun link
```

Creates a global symlink so `ccmonitor` is available from any directory. Changes to source files take effect immediately.

## Usage

```bash
# Monitor the latest session for the current directory
bun run start

# Monitor with auto-reload on code changes
bun run dev

# Monitor a specific session by ID
bun run start <sessionId>
```

### Keyboard

- `c` — full-screen Recap view (the whole final reply); `j`/`k`, arrows, Space/PageUp/PageDown scroll; `Esc` or `c` returns
- `b` — full-screen Background view with the last 20 lines of each task's output file; same scroll keys
- `i` — full-screen Info view: registry fields, Remote Control / PR / artifact URLs, compactions, cost per model, model catalog
- `d` — expand/collapse the denial list under Tools
- `1`–`9`, `0` — hide/show a panel (1 Last Prompt, 2 Recap, 3 Tools, 4 Background, 5 Skill, 6 Hooks, 7 Links, 8 Teams, 9 Memory, 0 Git Status); saved in `~/.claude/ccmonitor-ui.json`
- `r` — force refresh (also clears any switched-session view)
- `↑` / `↓` (dashboard) — make the auto-refresh interval 1 s longer / shorter; 2 s minimum, 60 s maximum, shown in the footer as `auto Ns`. Not saved between runs
- `s` — session picker: `j`/`k` move, `Enter` switch, `Esc`/`s` back
- `n` — cycle to the next live Claude Code session across all projects (only useful when multiple sessions are active)
- `Esc` — back to the dashboard
- `q` / `Ctrl+C` — quit

### Fixtures and tests

```bash
bun test                                   # unit + fixture tests
bun run typecheck                          # tsc --noEmit (strict)
bun run src/index.ts --fixture fixtures/recap-basic.jsonl   # render a fixture, no registry
bun run scripts/bench-parse.ts <transcript.jsonl>           # full vs incremental parse timing
```

Fixtures under `fixtures/` are cut from real transcripts by `scripts/make-fixture.ts`, which scrubs home paths, e-mail addresses, long strings, thinking blocks and classifier fields. `scripts/cut-fixtures.sh` re-cuts the whole set; review `git diff fixtures/` before committing. Each fixture has an `.expect.json` sidecar with measured counts that the tests compare against.

### Build standalone binary

```bash
bun run build    # outputs dist/ccmonitor
```

## Dashboard Panels

| Panel | Shows |
|-------|-------|
| **Last Prompt** | The most recent user-typed prompt (wrapped to fit, truncated at 500 chars) |
| **Recap** | Claude Code's native recap (`CC:`), the Korean recap section or first lines of the final reply, `now:` narration while a turn is open |
| **Tools** | Tool call counts, sorted by frequency; `Denied:N` strip when tool calls were rejected |
| **Hooks** | Hook runs per event, errors, `STOP BLOCKED` badge (shown when the session has hook activity) |
| **MCP** | Calls per MCP server (shown when any MCP tool was used) |
| **Links** | PRs, Artifacts, plan file, feedback drafts (shown when any exist) |
| **Background** | Async agents, background Bash commands and Monitors with status, elapsed, exit code, model (replaces Subagents when present) |
| **Subagents** | Running/completed agents with type, duration, description (when no background tasks exist) |
| **Skill** | Active skill with elapsed time, last completed skill, history, attributed response counts per skill |
| **Teams** | Team names and member lists |
| **Tasks** | Task subjects with status icons (hidden when empty; task tools are off on Claude 5 models) |
| **Memory** | Auto-memory state: MEMORY.md size, topic count, category breakdown, recent topics |
| **Git Status** | `git status` of the session cwd: `+N new  ~N modified  -N deleted`, then up to 8 `XY path` rows (`… N more`); `clean` or `(not a git repository)` |

## Faster Skill Detection (Optional)

Install the PostToolUse hook for near-instant skill completion updates:

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Skill",
        "command": "bash /path/to/ccmonitor/scripts/on-skill-complete.sh"
      }
    ]
  }
}
```

## Documentation

- [`docs/spec-v2-session-state.md`](./docs/spec-v2-session-state.md) — what changed in Claude Code 2.1.220 → 2.1.296 on disk, every data source, and the design of features F1–F16.
- [`docs/implementation-plan-v2.md`](./docs/implementation-plan-v2.md) — the 31-task plan with a Verify block per task.
- [`docs/verification-v2.md`](./docs/verification-v2.md) — how each task was verified, with the final check outputs.
- [`docs/plan-git-status-panel.md`](./docs/plan-git-status-panel.md) — the v1.10.0 Git Status box: plan and verification record.
- [`CLAUDE.md`](./CLAUDE.md) — architecture and conventions for contributors.
- [`filegen.md`](./filegen.md) — reference for the files Claude Code writes under `~/.claude/`.

## How It Works

ccmonitor is **fully decoupled** from Claude Code — it imports nothing from the Claude Code codebase. Instead, it reads the file artifacts that Claude Code produces under `~/.claude/`, using three data channels: **JSONL transcript parsing**, **disk file scanning**, and one `git status` call per refresh window.

### Overview

1. Converts `process.cwd()` to Claude's project directory name by replacing `/`, `_`, and `.` with `-` (`/Users/foo/bar` → `-Users-foo-bar`; `/Users/foo/.claude/worktrees/x` → `-Users-foo--claude-worktrees-x`)
2. Finds the latest `.jsonl` transcript in `~/.claude/projects/<dir>/`
3. Parses each JSONL entry for tool usage, skills, tokens, messages, model info, recap text, turn boundaries and background tasks. One API response can span several lines that share `message.id`; usage is counted once per id. Refreshes read only the bytes appended since the last one.
4. Loads subagent metadata, team configs, task files and background-task output files from disk
5. Renders ANSI box-drawing UI to stdout every 2 seconds (default; `↑`/`↓` change it)
6. Runs `git status --porcelain` in the session cwd (at most every 5 s) for the Git Status box

### Data Extraction Details

#### Last User Prompt

The "Last Prompt" panel shows the most recent actual user-typed prompt. Extracting it is trickier than it sounds — user-role transcript entries contain a mix of real input and system-injected noise:

1. Tool results (`type: "tool_result"`)
2. System reminders (`<system-reminder>...</system-reminder>`, `<local-command-caveat>...`, hook output)
3. Slash-command markers (`<command-name>`, `<command-args>`, `<command-message>`)
4. Bash output wrappers (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`)
5. Task notifications (`<task-notification>...`)
6. Skill expansion bodies (huge prose blobs injected when a slash-command skill loads)

The extractor (`extractRealUserPrompt()` in `src/entry.ts`) handles these in priority order:

1. **If `<command-args>` is present** → use its content (slash commands put the user's actual input there)
2. **Otherwise** → strip all wrapper tags and return the remainder
3. **Filter out** pure hook echo lines (`UserPromptSubmit hook success: ...`), skill expansion preambles (`Base directory for this skill: ...`) and `[Request interrupted by user]` markers

Newer Claude Code also writes the verbatim prompt as a `last-prompt` entry, which wins when present. Prompts delivered by background-task notifications or peer sessions (`turnOrigin`) open a turn but do not replace the Last Prompt.

The UI panel then applies a **500-character hard cap** (using `Array.from()` for true character counting, which handles emoji surrogate pairs correctly) and **word-wraps** the result to the terminal width with CJK-aware width calculations — Korean/Japanese/Chinese characters count as 2 cells, so wrapping respects their true display width.

#### Tools

Extracted from the JSONL transcript by scanning `message.content` arrays for blocks with `type: "tool_use"`. Each block contains a `name` field (e.g. `"Bash"`, `"Read"`, `"Edit"`). The monitor aggregates call counts per tool name and tracks the last-used timestamp.

```jsonl
{"message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","id":"toolu_01X...","input":{"file_path":"/src/index.ts"}}]}}
```

#### Skills

Skills are detected through **three complementary mechanisms**:

1. **Slash-command skills** — When a user invokes a skill via `/skill-name`, Claude Code injects a `<command-name>skill-name</command-name>` XML tag into the user message. The parser extracts these with regex matching on user-role entries.

2. **Skill tool invocations** — When the assistant calls the `Skill` tool programmatically, it appears as a `tool_use` block with `name: "Skill"` and `input.skill` containing the skill name. The parser captures both the skill name and optional `args`.

3. **PostToolUse hook** (optional) — An external shell script (`scripts/on-skill-complete.sh`) can be registered as a Claude Code PostToolUse hook. When the Skill tool completes, the hook writes completion data to `~/.claude/.omc/state/last-skill-complete.json`. The monitor reads this file for near-instant skill completion detection, falling back to transcript-based detection if the hook isn't installed.

**Skill lifecycle tracking:** The active skill is tracked via `activeSkill` state. Completion is detected when the assistant emits a message with `stop_reason: "end_turn"` or the user sends the next prompt, at which point the skill is promoted to `lastCompletedSkill` and added to the history ring (up to 5 entries). Independently, newer transcripts stamp `attributionSkill` / `attributionPlugin` on each assistant response; the Skill box shows how many responses ran under each (`ego-browser attributed:14`).

#### Subagents (Agents)

Loaded from disk at `~/.claude/projects/<dir>/<sessionId>/subagents/`:

- **`agent-*.meta.json`** — Provides metadata: `agentType` (e.g. `"Explore"`, `"code-reviewer"`) and `description` (the task summary).
- **`agent-*.jsonl`** — The subagent's own transcript. The monitor uses its **file modification time** as a status heuristic: if the `.jsonl` hasn't been written to in 30 seconds, the agent is considered `completed`.

The Subagents box is discovered entirely through filesystem scanning of this directory. It is shown only when the transcript has no background tasks (next section); newer Claude Code launches most agents asynchronously, which the transcript records directly.

#### Teams

Extracted via a **two-step process**:

1. **Transcript scanning** — The parser watches for `TeamCreate` tool_use blocks in the transcript to collect team names associated with the current session.
2. **Config loading** — For each discovered team name, the monitor reads `~/.claude/teams/<name>/config.json` to get the member list, and checks for an `inboxes/` directory.

Only teams referenced in the current session's transcript are displayed — not all teams on disk.

#### Tasks

Aggregated from **two sources**:

1. **Transcript entries** — JSONL entries with `type: "create"` contain task subjects and initial status. Entries with `type: "update"` modify existing task statuses by matching `taskId`.
2. **Task files on disk** — JSON files at `~/.claude/tasks/<sessionId>/*.json` provide task data that may not yet appear in the transcript (e.g. tasks created by subagents).

#### Background Tasks

Newer Claude Code runs `Agent` calls asynchronously and lets Bash run with `run_in_background`. The parser remembers each launch from its `tool_use` block (kind, description, `subagent_type`) and resolves it from the matching tool result: `toolUseResult.status === "async_launched"` gives `agentId`, `resolvedModel` and `outputFile`; `toolUseResult.backgroundTaskId` gives the Bash task id and its output path. Completion arrives as a `<task-notification>` block (inside `queue-operation` entries or a notification prompt) with `<status>` and `<summary>` (`… completed (exit code 0)`). For Bash tasks still marked running, the loader stats the output file under the scratchpad `tasks/` directory and reads its `[exited with code N]` trailer. The `b` view shows the last 20 lines of each output file, read on demand.

#### Recap and Turns

- **Native recap** — `system` entries with `subtype: "away_summary"`, written by Claude Code a few minutes after a turn ends (`CC:` line; the `(disable recaps in /config)` suffix is stripped).
- **Final reply** — the `text` blocks of the last assistant message with `stop_reason: "end_turn"`, joined across the JSONL lines that share its `message.id`. If it contains a "Korean recap" style heading, only that section is shown in the compact box; otherwise the first 6 lines. Markdown is reduced (`**` and backticks stripped, fenced code shown as `[code]`).
- **Live narration** — while a turn is open, the newest `text` block from a `tool_use` response is shown as `now:`.
- **Turns** — a user entry with `promptSource` in typed/queued/suggestion_accepted/sdk (or `turnOrigin: "human"`) opens a turn; `system/turn_duration` closes it with `durationMs`, `messageCount` and `pendingBackgroundAgentCount`. The Turn line shows the open turn's elapsed time and tool calls, or the last duration, the average and a sparkline of the last 10.

#### Cost, Permissions, Hooks, Links, Queue, Errors

| Panel / chip | Source |
|---|---|
| Cost line | `cost-state` entry (`totalCostUSD`, per-model `modelUsage`, API/tool time, lines added/removed); fallback `~/.claude.json` → `projects[cwd].lastCost` shown as `(prev session)` |
| `Mode:` chip | `permission-mode` entries, `permissionMode` on prompts, `auto_mode` attachment flags (`bash-first`) |
| `Denied:` strip | `permissionDecision: {decision: "reject", reasonType}` and `toolDenialKind` on tool results; the rule text is the first line of the tool error |
| Hooks box | `hook_success` attachments counted per `hookEvent`; non-zero `exitCode` rows; `stop_hook_summary.preventedContinuation` ⇒ `STOP BLOCKED` |
| `RC●` chip | `system/bridge_status` content and URL (Remote Control) |
| Links box | `pr-link` (deduped per repository + number), `frame-link` artifacts, `<plansDirectory>/<slug>.md` for the transcript's `slug`, `feedback/drafts/*.json` matching `source_session_id` |
| `Queue:N` chip | `queue-operation` enqueue − dequeue − remove; preview from `queued_command` attachments |
| MCP box, `Advisor:`, `Fast` | `mcp__<server>__*` tool names + `attributionMcpServer`; `server_tool_use` blocks named `advisor`; `usage.speed === "fast"` |
| Error strip | `isApiErrorMessage` (status/code), `interruptedMessageId`, `isAbortedMidStream` within the last 3 turns |
| Title, icons | `custom-title` > `agent-name` > `ai-title`; `entrypoint` (`cli` ⌨ / `claude-desktop` 🖥) |

Unknown entry types, system subtypes and attachment kinds are appended once per run to `~/.claude/ccmonitor-unknown-fields.log`, so schema drift in a new Claude Code version is visible without a debugger.

#### Token Usage & Context Window

Extracted from `message.usage` fields on transcript entries:

| Field | Meaning |
|-------|---------|
| `input_tokens` | Tokens sent to the model |
| `output_tokens` | Tokens generated by the model |
| `cache_creation_input_tokens` | Tokens written to prompt cache |
| `cache_read_input_tokens` | Tokens read from prompt cache |

One API response is written as several JSONL lines that share `message.id` (thinking, text, tool_use), each carrying the same `usage`; the parser counts usage and the `A:` message counter **once per id**. The **context window usage percentage** is calculated from the most recent response's total input tokens (input + cache write + cache read) divided by the model's context limit (1M for Claude 5 family models and Opus 4.5+, 200K for others; a size published in `~/.claude/cache/model-catalog` would take precedence).

#### Model

Read from the `message.model` field on assistant transcript entries. Updated on every assistant message, so it reflects the most recently used model.

#### Git Branch

Parsed directly from `<cwd>/.git/HEAD` every refresh cycle. Handles both normal refs (`ref: refs/heads/<branch>`) and detached HEAD (raw SHA, shown as a 7-character short form). Returns `null` for non-git directories. This bypasses `git` subprocess spawning entirely — at a 2-second refresh interval, the fork overhead of `git branch --show-current` would be measurable, whereas reading a ~40-byte file is effectively free.

#### Files Edited Counter

Two sources. (1) `~/.claude/file-history/<sessionId>/`, where Claude Code stores pre-edit backups for the Undo feature as `<hash>@v<N>`; stripping the `@v<N>` suffix and deduplicating by hash gives distinct files. (2) The transcript: `file-history-delta` entries (`trackingPath`, `backup.version`, cwd-relative) and the `filePath` in Write/Edit tool results (absolute), normalised to one key per file; `edited_text_file` attachments flag files changed outside Claude Code. The header shows `Files:N`, or `~N` with the larger value when the two sources disagree.

#### Active Sessions

Populated from `~/.claude/sessions/<pid>.json`, a registry of every running Claude Code process. Each entry carries `pid`, `sessionId`, `cwd`, `startedAt`, `name`, `status` (`busy`/`idle`/`waiting`), `statusUpdatedAt`, `updatedAt`, `version`, `kind`, `entrypoint`, `hostSessionId` (Desktop) and `messagingSocketPath`; the sibling `.key` files are never read. The registry's `sessionId` can go stale after `/clear`, so the newest transcript in the session's project directory is used instead. The monitor:

1. Reads every `*.json` file in the sessions directory.
2. For each entry, sends signal 0 (`process.kill(pid, 0)`) to verify the process is actually alive — this is a zero-cost liveness check that doesn't affect the target process.
3. Discards stale entries from crashed or SIGKILL'd processes (the OS doesn't clean these up automatically).
4. Sorts surviving entries by `startedAt` descending so the `n` key cycles through them in a predictable order.

The surviving list is exposed as `state.activeSessions`, used both for the `Sess:N (+project, project)` header badge and as the source of truth for the `n` session switcher.

#### Memory

Read from `~/.claude/projects/<sanitized-cwd>/memory/`, the auto-memory directory Claude Code maintains per project. The parser:

1. Checks for `MEMORY.md` (the index file) and counts its lines.
2. Lists top-level `.md` files excluding `MEMORY.md` and `MEMORY.md.bak` — these are the topic files.
3. Groups topics by filename prefix (the token before the first underscore), so `feedback_naming.md`, `feedback_conv_format.md`, and `feedback_review.md` all contribute to the `feedback` category count.
4. Sorts topics by mtime descending and keeps the top 3 names for the "recent" line.
5. Skips subdirectories (`team/`, `logs/`) since they have different semantics.

The breakdown line trades vertical space for information density: a 9-topic memory compresses to one line like `feedback:5 project:3 user:1`, preserving the distribution without consuming the whole panel.

#### Git Status

The bottom box runs `git -C <cwd> --no-optional-locks status --porcelain=v1 -z -uall` for the session's cwd (`src/loaders/gitStatus.ts`). Counting rules per `XY` code: `??` and a staged `A` are **new**; a `D` in either column is **deleted**; everything else (`M`, `T`, `R`, `C`, `U`) is **modified**. The summary row shows the three counts, then the first 8 entries in git order with their raw two-letter code, then `… N more`. The result is cached for 5 seconds per cwd; the first call is synchronous with a 2-second timeout, later refreshes run in the background so key input is never blocked. A cwd that is not inside a repository shows `(not a git repository)` and is retried every 30 seconds. `--no-optional-locks` keeps the monitor from touching the index lock while Claude Code works.

