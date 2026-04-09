# claude-monitor

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

```bash
git clone <repo-url> && cd ccmonitor
bun install
```

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
bun run build    # outputs dist/claude-monitor
```

## Dashboard Panels

| Panel | Shows |
|-------|-------|
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

1. Converts `process.cwd()` to Claude's project directory name (`/Users/foo/bar` → `-Users-foo-bar`)
2. Finds the latest `.jsonl` transcript in `~/.claude/projects/<dir>/`
3. Parses each JSONL entry for tool usage, skills, tokens, messages, and model info
4. Loads subagent metadata, team configs, and task files from disk
5. Renders ANSI box-drawing UI to stdout every 2 seconds
6. Watches for file changes via [chokidar](https://github.com/paulmillr/chokidar) to show live file activity
