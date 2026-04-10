# ccmonitor

Real-time TUI dashboard for monitoring Claude Code sessions.

Watches `~/.claude/` data files and displays live activity — tool usage, skills, subagents, teams, tasks, token consumption, and file changes.

```
 CLAUDE CODE MONITOR                                    17:18:00
 Session:a1b2c3d4 Model:claude-opus-4-6 Age:12m 30s Idle:2s
 Msgs:U:5 A:12 Tok:I:45.2K O:8.3K CW:12.1K CR:38.0K
┌─ Tools ──────────────────────────────────────────────────────┐
│ Edit:15 Bash:12 Read:8 Grep:5 Agent:3 Skill:2 Write:1       │
└──────────────────────────────────────────────────────────────┘
┌─ Subagents ──────────────────────────────────────────────────┐
│ ● Explore        1m 22s  Find auth middleware files          │
│ ✔ code-reviewer     42s  Review migration safety             │
└──────────────────────────────────────────────────────────────┘
┌─ Skill ──────────────────────────────────────────────────────┐
│ ● /commit (Fix login bug)  3s                                │
└──────────────────────────────────────────────────────────────┘
```

## Requirements

- [Bun](https://bun.sh/) v1.0+

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

The `bun build --compile` flag embeds the Bun runtime into a single binary (~54MB), so once installed, the machine does not need Bun on PATH to run it.

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

- `r` — force refresh
- `q` / `Ctrl+C` — quit

### Build standalone binary

```bash
bun run build    # outputs dist/ccmonitor
```

## Dashboard Panels

| Panel | Shows |
|-------|-------|
| **Last Prompt** | The most recent user-typed prompt (wrapped to fit, truncated at 500 chars) |
| **Tools** | Tool call counts, sorted by frequency |
| **Subagents** | Running/completed agents with type, duration, description |
| **Skill** | Active skill with elapsed time, last completed skill, history |
| **Teams** | Team names and member lists |
| **Tasks** | Task subjects with status icons |
| **File Activity** | Recent file add/change/unlink events from `~/.claude/` |

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

## How It Works

ccmonitor is **fully decoupled** from Claude Code — it imports nothing from the Claude Code codebase. Instead, it reads the file artifacts that Claude Code produces under `~/.claude/`, using two data channels: **JSONL transcript parsing** and **disk file scanning**.

### Overview

1. Converts `process.cwd()` to Claude's project directory name (`/Users/foo/bar` → `-Users-foo-bar`)
2. Finds the latest `.jsonl` transcript in `~/.claude/projects/<dir>/`
3. Parses each JSONL entry for tool usage, skills, tokens, messages, and model info
4. Loads subagent metadata, team configs, and task files from disk
5. Renders ANSI box-drawing UI to stdout every 2 seconds
6. Watches for file changes via [chokidar](https://github.com/paulmillr/chokidar) to show live file activity

### Data Extraction Details

#### Last User Prompt

The "Last Prompt" panel shows the most recent actual user-typed prompt. Extracting it is trickier than it sounds — user-role transcript entries contain a mix of real input and system-injected noise:

1. Tool results (`type: "tool_result"`)
2. System reminders (`<system-reminder>...</system-reminder>`, `<local-command-caveat>...`, hook output)
3. Slash-command markers (`<command-name>`, `<command-args>`, `<command-message>`)
4. Bash output wrappers (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`)
5. Task notifications (`<task-notification>...`)
6. Skill expansion bodies (huge prose blobs injected when a slash-command skill loads)

The extractor (`extractRealUserPrompt()` in `src/parser.ts`) handles these in priority order:

1. **If `<command-args>` is present** → use its content (slash commands put the user's actual input there)
2. **Otherwise** → strip all wrapper tags and return the remainder
3. **Filter out** pure hook echo lines (`UserPromptSubmit hook success: ...`) and skill expansion preambles (`Base directory for this skill: ...`)

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

**Skill lifecycle tracking:** The active skill is tracked via `activeSkill` state. Completion is detected when the assistant emits a message with `stop_reason: "end_turn"`, at which point the skill is promoted to `lastCompletedSkill` and added to the history ring (up to 5 entries).

#### Subagents (Agents)

Loaded from disk at `~/.claude/projects/<dir>/<sessionId>/subagents/`:

- **`agent-*.meta.json`** — Provides metadata: `agentType` (e.g. `"Explore"`, `"code-reviewer"`) and `description` (the task summary).
- **`agent-*.jsonl`** — The subagent's own transcript. The monitor uses its **file modification time** as a status heuristic: if the `.jsonl` hasn't been written to in 30 seconds, the agent is considered `completed`.

Subagents are **not** parsed from the main transcript — they are discovered entirely through filesystem scanning of the subagents directory.

#### Teams

Extracted via a **two-step process**:

1. **Transcript scanning** — The parser watches for `TeamCreate` tool_use blocks in the transcript to collect team names associated with the current session.
2. **Config loading** — For each discovered team name, the monitor reads `~/.claude/teams/<name>/config.json` to get the member list, and checks for an `inboxes/` directory.

Only teams referenced in the current session's transcript are displayed — not all teams on disk.

#### Tasks

Aggregated from **two sources**:

1. **Transcript entries** — JSONL entries with `type: "create"` contain task subjects and initial status. Entries with `type: "update"` modify existing task statuses by matching `taskId`.
2. **Task files on disk** — JSON files at `~/.claude/tasks/<sessionId>/*.json` provide task data that may not yet appear in the transcript (e.g. tasks created by subagents).

#### Token Usage & Context Window

Extracted from `message.usage` fields on transcript entries:

| Field | Meaning |
|-------|---------|
| `input_tokens` | Tokens sent to the model |
| `output_tokens` | Tokens generated by the model |
| `cache_creation_input_tokens` | Tokens written to prompt cache |
| `cache_read_input_tokens` | Tokens read from prompt cache |

The **context window usage percentage** is calculated from the most recent assistant message's total input tokens (input + cache write + cache read) divided by the model's known context limit (1M for Opus 4.5+, 200K for others).

#### Model

Read from the `message.model` field on assistant transcript entries. Updated on every assistant message, so it reflects the most recently used model.

#### File Activity

Not extracted from transcripts — instead, [chokidar](https://github.com/paulmillr/chokidar) watches glob patterns across `~/.claude/` for real-time file system events (add/change/unlink). Events are stored in a ring buffer (max 50) and the 8 most recent are displayed.

### Watched File Paths

| Glob Pattern | What It Captures |
|---|---|
| `projects/**/*.jsonl` | Session & subagent transcripts |
| `projects/**/*.json` | Subagent metadata |
| `tasks/**/*.json` | Task/TODO data |
| `teams/**/*` | Team configs & inboxes |
| `sessions/*.json` | Active session registry |
| `file-history/**/*` | File change history |
| `.omc/state/last-skill-complete.json` | Hook-based skill completion signal |
