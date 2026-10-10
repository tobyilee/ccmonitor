# ccmonitor v2 — Session State Expansion Spec

**Status:** Draft for review
**Date:** 2026-10-10
**Baseline:** ccmonitor 1.5.0 (built against Claude Code ~2.1.220, 2026-08-02)
**Target:** Claude Code 2.1.296 (installed) and later
**Author:** Claude Fable 5.1, with the ccmonitor maintainer

---

## 0. 요약 (Korean summary)

- ccmonitor 1.5.0 이후 Claude Code는 2.1.220 → 2.1.296으로 76개 버전이 올라갔다. 트랜스크립트 JSONL에 **새 엔트리 타입 12종**과 **새 필드 40여 개**가 추가됐고, `~/.claude/` 아래에 새 파일/디렉토리가 생겼다.
- 이 문서는 (1) 실제 디스크 데이터를 조사한 결과, (2) 그 데이터로 만들 수 있는 **16개 기능**의 설계, (3) 4단계 릴리스 계획을 담는다.
- 사용자가 가장 원하는 **Recap 패널**은 두 개의 소스를 쓴다.
  1. Claude Code가 직접 쓰는 `system/away_summary` 엔트리 (한 문장 recap, 턴 종료 후 약 3분 뒤 기록됨).
  2. 모델의 마지막 `end_turn` 응답 텍스트 (사용자 CLAUDE.md 규칙에 따라 "Korean recap" 섹션이 들어 있음).
- 1차 릴리스(v1.6)는 Recap, 턴 타임라인, 백그라운드 작업 패널 3개에 집중한다.

---

## 1. Purpose and scope

ccmonitor shows the live state of a Claude Code session. It reads only the files Claude Code writes. It never imports Claude Code source.

This spec does three things:

1. Records what changed in Claude Code between 2.1.220 and 2.1.296 that a monitor can observe.
2. Lists every data source now available on disk, with its shape and freshness.
3. Designs new features on top of those sources, with acceptance criteria and a phased plan.

Out of scope: refactors already planned in `tasks/prd-quality-uplift.md` (test suite, pure parser split). This spec assumes those land first or in parallel. Where this spec adds parser logic, it follows the `processEntry` + loader pattern so the refactor stays mechanical.

---

## 2. What changed in Claude Code (2.1.220 → 2.1.296)

Source: `~/.claude/cache/changelog.md` (release notes Claude Code caches locally) and direct inspection of transcripts written by 2.1.285–2.1.296.

See section 2.1 for the release-note digest and section 3 for the on-disk evidence. The short version:

| Area | Change | Monitor impact |
|---|---|---|
| Recap | Claude Code writes a one-line session recap (`away_summary`) when the user has been away. `/recap` command exists. Can be disabled in `/config`. | **New Recap panel (P0)** |
| Turn accounting | `turn_duration` and `stop_hook_summary` system entries close every turn. `turnPosition` on user prompts. | Turn timeline, per-turn duration, hook health |
| Background work | `Agent` runs async (`status: async_launched`, `outputFile`), Bash `run_in_background` writes to a scratchpad `tasks/` dir, results arrive as `task-notification` prompts through a queue. `pendingBackgroundAgentCount` on `turn_duration`. | Background tasks panel |
| Cost | `cost-state` entry with `totalCostUSD`, per-model usage, lines added/removed, API time. | Cost panel |
| Compaction | `compact_boundary` system entry with `compactMetadata` (pre/post tokens, trigger). Compact summary user entry flagged `isCompactSummary`. | Exact compaction count and savings; replaces the >30% drop heuristic |
| Permissions | `permissionMode` per prompt (`auto`, …), `permissionDecision` per tool result (accept/reject, source, reasonType), `toolDenialKind`. `auto_mode` attachment. | Permission and safety strip |
| Hooks | `hook_success` attachments per hook run, `stop_hook_summary` with `hookErrors`, `preventedContinuation`. | Hooks panel without an external hook script |
| Session identity | Registry gains `name`, `kind`, `entrypoint` (`cli`/`claude-desktop`), `peerFeatures`, `messagingSocketPath`, `status`. Transcript gains `slug`, `agent-name`, `custom-title`. | Richer header, Remote Control badge |
| Remote Control | `bridge-session` entries and `bridge_status` system entry with a claude.ai URL. | RC indicator with link |
| Links | `pr-link` (PR number/URL), `frame-link` (Artifact URL/title). Plans saved as `~/.claude/plans/<slug>.md`. | Links panel |
| Prompt queue | `queue-operation` (enqueue/dequeue/remove), `queued_command` attachments, `promptSource: queued`. | Queue depth |
| Attribution | `attributionSkill`, `attributionPlugin`, `attributionMcpServer` on assistant entries. `server_tool_use` for the advisor model. `thinkingDurationMs`. `usage.speed` (fast mode). | Skill/MCP/advisor usage without heuristics |
| Model catalog | `~/.claude/cache/model-catalog/*.json` lists models, effort options, fast-mode availability. | Replace hard-coded context-window table |
| Persistence | Large tool outputs saved to `projects/<p>/<sid>/tool-results/<id>.txt`. Subagent `.meta.json` gains `requestShape`, `spawnDepth`. | Subagent panel shows background vs inline |
| Errors | `isApiErrorMessage`, `apiErrorStatus`, `isAbortedMidStream`, `interruptedMessageId`. | Error strip |
| Mods | `dev-mods` entry and `~/.claude/dev-mods/<sid>/`. `informational` system notices. | Low priority badge |
| Tasks/todos | Task tools are off on Claude 5-family models by default; `~/.claude/tasks/` stays empty. | Hide the Tasks box when empty |
| Scheduled / workflows | `.claude/scheduled_tasks.json`, `.claude/workflows/`, workflow progress row. | F16 (unverified) |

### 2.1 Release-note digest

Read from `~/.claude/cache/changelog.md`, versions 2.1.296 down to 2.1.220. Only items that leave a trace a monitor can read. Version in brackets. Items marked **unverified** were not found on this machine today and need a fixture before implementation.

**Recap**

- Session recap exists since ~2.1.110: an automatic one-line summary shown when you come back to a session. Opt out via `/config` or `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`. On disk it is the `system/away_summary` entry.
- [2.1.236] Recap text (automatic and `/recap`) capped at 400 characters, cut at a word boundary.
- [2.1.246] The end-of-turn line gained a completion clock (`done 6:05 PM`).
- [2.1.261] `/recap` runs as a background model request. [2.1.284] `/recap` declines when relayed from a chat thread, routine or webhook.
- [2.1.286] Background-agent replies no longer start with a recap of your message.

**Transcript**

- [2.1.288] `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` rewrites a large transcript **in place**. The file is no longer strictly append-only. Incremental parsing must detect shrink and reparse (section 6.2).
- [2.1.288] Named entry kinds: compaction marker, loop wakeup entry, stop hook summary, memory-saved notice, task-reminder / @-file attachment, queued-prompt records.
- [2.1.259] Nested background subagent results are saved in the parent subagent's transcript. [2.1.277] Subagent results arrive under a "subagent output" header (the `origin.kind: peer` prompts).
- [2.1.239] Custom title is a transcript entry (`custom-title`).
- [2.1.234] `CLAUDE_CODE_PROJECT_DIR_NAME` overrides the project directory name. [2.1.251] `/cd` can move a session to another project directory. Both break the cwd → directory mapping; the monitor must trust `cwd` inside entries, not the directory name.
- [2.1.261] `bashOutputMaxChars` / `taskOutputMaxChars` (≤128K) before output spills to `tool-results/`. [2.1.265] 1 GB cap on saved tool results. [2.1.277] `TaskOutput` tool removed; background output is read with `Read` from the output file. [2.1.269] Bash edit diffs embedded in tool results (`bashEditDiff` in `toolUseResult`).

**Session registry and background sessions**

- [2.1.221] `/status` shows session kind: `interactive`, background `attached` or `unattended` (registry `kind`).
- [2.1.232] Duplicate live names get a `name-word-word` variant. [2.1.246] Names live in the registry; headless sessions purge stale `~/.claude/sessions` entries.
- [2.1.251] `claude attach | logs | stop | respawn | rm <name>`; [2.1.288] `claude purge`. [2.1.257] Background sessions have a `state.json` with a `detail` field (**unverified**: no such file on this machine today).
- [2.1.221] `/fork` runs in its own worktree under `.claude/worktrees/`; background sessions can commit, push and open a draft PR.
- [2.1.224] `SendMessage` / `ListAgents` across sessions; [2.1.248] socket dir is a private per-user `/tmp` directory (`/tmp/cc-socks/<pid>.sock` here).
- [2.1.295] OSC 7501 Program Status Protocol tells the terminal `working`, `waiting on you`, or `done`. This mirrors the registry `status` field.

**Tasks, todos, scheduled tasks, workflows**

- [2.1.233, 2.1.268] `TaskCreate/Get/Update/List` and `TodoWrite` are **off** on Opus 4.8, Sonnet 5, Fable 5, Mythos 5 and newer unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. This is why `~/.claude/tasks/` is absent here. The Tasks panel must hide itself when empty.
- [2.1.285, 2.1.290] Saved scheduled tasks live in the project-local `.claude/scheduled_tasks.json` (file-watched by Claude Code). [2.1.243] `/usage` has a Loops breakdown. (**unverified** on this machine.)
- [2.1.268] Workflow scripts in `.claude/workflows/`. [2.1.281] The prompt row shows workflow name, progress bar, agent count, elapsed time, total tokens. [2.1.265] Workflows keep a run journal (**unverified** location).
- [2.1.232] Non-teammate `Agent` spawns run in the background by default; `subagent_type: "fork"`. [2.1.243] `/tasks` shows each subagent's model and effort. [2.1.271] `Monitor` watches always have a deadline (≤30 min). [2.1.285] Background Bash timeout 30 min default, 2 h max.

**Cost, usage, model**

- [2.1.251] `/cost` shows a prompt-cache line; statusline payload gains `prompt_cache` and `rate_limits.spend_limit`; [2.1.284] adds `used_usd`, `limit_usd`, `period`. [2.1.260] Cache-miss cause surfaced (the `diagnostics.cache_miss_reason` field). [2.1.275] Headless sessions save cost totals at exit (`cost-state`).
- [2.1.251] Effort saved per model (`modelSettings.<model>.effortLevel` in settings). [2.1.267] `maxEffortLevel`. [2.1.292] `Agent` tool has an `effort` parameter. [2.1.284] Ultracode has its own toggle (`/effort ultracode on|off`).
- [2.1.260] `/advisor <model>|off`; [2.1.290] advisor calls exposed as server tool uses (`server_tool_use` blocks named `advisor`). [2.1.284] Advisor turns count toward the context meter.
- [2.1.288] `/autocompact` per model; [2.1.296] subagent `autoCompactWindow`.

**Permissions and hooks**

- [2.1.284] Interactive sessions default to auto mode; [2.1.278] server-side classifier (`permissionDecision.reasonType: classifier`). [2.1.259] `--permission-prompts none`; [2.1.248] `--restricted`.
- New hook events: `PreModelSwitch`/`PostModelSwitch` [2.1.251], `WorktreeCreate` [2.1.281], `Elicitation`/`ElicitationResult` [2.1.284], `InstructionsLoaded` [2.1.288], `ConfigChange`, `TeammateIdle` [2.1.290]. [2.1.295] `onFailure: "block"`. The Hooks panel should count by `hookEvent` dynamically, not from a fixed list.

**Artifacts, plans, memory, feedback, mods**

- [2.1.281] `/artifacts` lists this session's artifacts first; footer pill `⧉ N`. On disk: `frame-link`, `artifact-comment-monitor` entries and `cachedArtifactRoster` in `~/.claude.json`.
- [2.1.290] `plansDirectory` setting overrides `~/.claude/plans/`. Read the setting before resolving the plan path.
- [2.1.247] `SendFeedback` tool writes drafts for `/feedback` (`feedback/drafts/*.json`, `feedbackDrafts` setting).
- [2.1.287] Claude Mods (`dev-mods` entry, `~/.claude/dev-mods/<sid>/`). [2.1.275] claude.ai skill/plugin sync (`skills/synced/`, `plugins/synced/`).
- [2.1.293] Statusline `subagentStatusLine` payload gains `agentType`.

---

## 3. Data inventory (observed on this machine, 2026-10-10)

Legend: **Fresh** = written during the turn. **Turn-end** = written when the turn closes. **Lazy** = written minutes later or on exit.

### 3.1 Transcript JSONL (`projects/<proj>/<sid>.jsonl`)

Entry types seen across the 60 most recent transcripts, with counts:

| `type` | Count | New since 1.5.0 | Key fields |
|---|---|---|---|
| `assistant` | 14 865 | fields | `message.{id,model,stop_reason,usage,content[]}`, `effort`, `perTurnEffort`, `advisorModel`, `requestedModel`, `thinkingDurationMs`, `attributionSkill`, `attributionPlugin`, `attributionMcpServer`, `isApiErrorMessage`, `apiErrorStatus`, `isAbortedMidStream`, `slug` |
| `user` | 8 054 | fields | `promptId`, `permissionMode`, `origin{kind}`, `promptSource`, `turnOrigin`, `turnPosition{promptIndex,turnIndex}`, `toolUseResult`, `permissionDecision`, `toolDenialKind`, `isCompactSummary`, `interruptedMessageId`, `queueSkipAttachments` |
| `attachment` | 22 916 | yes | `attachment.type` (25 kinds, see 3.1.2) |
| `system` | 1 350 | fields | `subtype` (7 kinds, see 3.1.3) |
| `last-prompt` | 3 567 | handled | `lastPrompt`, `leafUuid` |
| `ai-title` | 3 432 | handled | `aiTitle` |
| `atis-latch` | 3 537 | yes | `atis` (opaque, ignore) |
| `mode` | 3 525 | handled | `mode` (`normal`) |
| `permission-mode` | 2 979 | handled | `permissionMode` (`auto`, `default`, `plan`, …) |
| `bridge-session` | 1 994 | yes | `bridgeSessionId`, `lastSequenceNum`, `ownerAccountUuid` |
| `queue-operation` | 829 | yes | `operation` (`enqueue`/`dequeue`/`remove`), `content`, `reason`, `deliveryId` |
| `pr-link` | 790 | yes | `prNumber`, `prUrl`, `prRepository`, `timestamp` |
| `file-history-delta` | 520 | yes | `trackingPath`, `backup{backupFileName,version,backupTime}` |
| `file-history-snapshot` | 453 | handled | `snapshot.trackedFileBackups` |
| `cost-state` | 123 | yes | `totalCostUSD`, `totalAPIDuration`, `totalToolDuration`, `totalLinesAdded`, `totalLinesRemoved`, `totalDuration`, `startTime`, `modelUsage{<model>:{inputTokens,outputTokens,thinkingTokens,cacheReadInputTokens,cacheCreationInputTokens,costUSD}}` |
| `agent-name` | 72 | yes | `agentName` |
| `frame-link` | 56 | yes | `frameUrl`, `title`, `path`, `artifactCount` |
| `artifact-comment-monitor` | 18 | yes | `artifacts{id:{state,title}}` |
| `artifact-autoreact-ledger` | 32 | yes | internal, ignore |
| `custom-title` | 25 | yes | `customTitle` |
| `dev-mods` | 5 | yes | `folder` |

Every `assistant`, `user`, `attachment` and `system` entry also carries `cwd`, `gitBranch`, `sessionId`, `version`, `entrypoint`, `userType`, `isSidechain`, `uuid`, `parentUuid`, `timestamp`.

#### 3.1.1 Assistant message splitting (important)

One API response is written as **several JSONL lines that share `message.id`**. Each line holds one content block (`thinking`, `text`, `tool_use`, `server_tool_use`, `advisor_tool_result`). `stop_reason` and `usage` are copied to every line. Observed: 3 lines per message is common.

Consequences:

- Token counters must count `usage` **once per `message.id`**, not once per line. The current parser (`processEntry`, "Track token usage" block) adds `usage` on every line, so a 3-line message is counted 3 times. The `A:` message counter has the same defect. (Bug, fix in v1.6.)
- The recap text is the **join of all `text` blocks** with the same `message.id` on the last `end_turn` message.

#### 3.1.2 Attachment kinds (`attachment.type`)

| Kind | Count | Useful for |
|---|---|---|
| `hook_success` | 8 381 | Hooks panel: `hookName` (`PreToolUse:Bash`, `Stop`, `SessionStart:startup`), `hookEvent`, `exitCode`, `stdout`, `command` |
| `total_tokens_reminder` | 6 530 | Output budget left (`<total_tokens>N tokens left</total_tokens>`) |
| `deferred_tools_record` | 3 795 | ignore |
| `batching_reminder_sent` | 996 | ignore |
| `bash_output_audience_note` | 899 | ignore |
| `environment` | 683 | `snapshot.scratchpadDirectory`, `isWorktree`, `additionalWorkingDirectories` |
| `silent_turn_reminder` | 359 | "model has been silent" signal |
| `edited_text_file` | 154 | externally edited file notice (`filename`) |
| `queued_command` | 148 | queue contents: `prompt`, `commandMode`, `origin`, `runId` |
| `prompt_snapshot` | 118 | system prompt text (do **not** render; privacy) |
| `deferred_tools_delta` | 81 | ignore |
| `date` | 74 | ignore |
| `skill_listing` | 73 | available skills list |
| `remote_session_change` | 71 | commit/PR attribution lines |
| `instructions` | 67 | CLAUDE.md files loaded (`files[].path`, `type`) |
| `mcp_instructions_delta` | 65 | MCP servers attached |
| `credential_org` | 62 | ignore |
| `model` | 61 | `identity.{modelId,marketingName,knowledgeCutoff}` |
| `session_context` | 61 | git status snapshot at start |
| `agent_listing_delta` | 60 | agent types available |
| `auto_mode` | 60 | `bashFirst`, `steerOnly`, `bypass` flags |
| `advisor_tool` | 51 | advisor `model`, `available` |
| `file` | 41 | ignore |
| `command_permissions` | 24 | `allowedTools` |
| `compact_file_reference` | 14 | files kept across compaction |

#### 3.1.3 System subtypes (`system.subtype`)

| Subtype | Count | Fields | Meaning |
|---|---|---|---|
| `turn_duration` | 535 | `durationMs`, `messageCount`, `pendingBackgroundAgentCount` | Written when a turn closes. **Turn boundary marker.** |
| `stop_hook_summary` | 535 | `hookCount`, `hookInfos[]`, `hookErrors[]`, `preventedContinuation`, `stopReason`, `durationMs` | Stop hooks that ran at turn end |
| `away_summary` | 199 | `content` | **Claude Code's native recap.** One or two sentences. Observed ≥182 s after the last `end_turn`. Ends with `(disable recaps in /config)`. |
| `local_command` | 48 | `commandRun{command,args}`, `content` | Slash commands typed locally (`/clear`, `/model`) |
| `bridge_status` | 14 | `content`, `url` | Remote Control on/off with claude.ai URL |
| `compact_boundary` | 11 | `compactMetadata{trigger,preTokens,postTokens,cumulativeDroppedTokens,durationMs}`, `logicalParentUuid` | Exact compaction record |
| `informational` | 8 | `content`, `level` | Notices (mods hot reload, etc.) |

#### 3.1.4 Value enumerations observed

- `user.promptSource`: `typed` 305, `system` 208, `queued` 37, `suggestion_accepted` 19, `sdk` 2
- `user.turnOrigin`: `human` 378, `task_notification` 124, `peer` 71
- `user.origin.kind`: `human`, `task-notification` (with `producer: session-task`, `runId`), `peer` (with `from`, `name`, `body`)
- `user.permissionDecision`: `{decision: accept|reject, source: config|hook, reasonType: classifier|mode|hook|safetyCheck|other}`
- `user.toolDenialKind`: `permission-rule` 67, `automode-blocked` 7
- `assistant.message.stop_reason`: `tool_use` 14 026, `end_turn` 819, `stop_sequence` 3 (synthetic API errors)
- `assistant.message.usage.speed`: `standard` (fast mode would show `fast`)
- `assistant.message.usage.output_tokens_details.thinking_tokens`
- `assistant.message.diagnostics.cache_miss_reason.type`: `previous_message_not_found`, `tools_changed`, `messages_changed`, `system_changed` with `cache_missed_input_tokens`
- `assistant.attributionSkill`: `ego-browser`, `frontend-design:frontend-design`, `security-review`, `plugin-authoring`, `artifact-design`, …
- `assistant.attributionMcpServer`: `clavis`, `claude-in-chrome`, `Claude Browser`, `claude.ai Claude Docs`, `cmux-cua`, `idea`, …
- `entrypoint`: `cli`, `claude-desktop`
- `toolUseResult` for async `Agent`: `{isAsync: true, status: "async_launched", agentId, description, resolvedModel, outputFile, canReadOutputFile, canContinueAgent}`
- `toolUseResult` for background Bash: `{backgroundTaskId, backgroundCwdHint}`

### 3.2 Session registry (`sessions/<pid>.json`)

```json
{"pid":30111,"sessionId":"01c3eb5d-…","cwd":"/Users/…/ccmonitor","startedAt":1791603121889,
 "procStart":"Sat Oct 10 03:32:00 2026","version":"2.1.296","peerProtocol":1,
 "peerFeatures":["notify_idle","reply_across_default_dirs","artifact_yield"],
 "kind":"interactive","entrypoint":"cli","pidDomain":"darwin",
 "messagingSocketPath":"/tmp/cc-socks/30111.sock",
 "name":"ccmonitor-2c","nameSource":"derived","nameSince":1791603121889,
 "status":"busy","updatedAt":1791603218906,"statusUpdatedAt":1791603218906}
```

New since 1.5.0: `kind`, `entrypoint`, `hostSessionId` (desktop), `peerFeatures`, `messagingSocketPath`, `nameSource`, `statusUpdatedAt`. A sibling `<pid>.<hash>.key` file holds a peer token (do not read). Sockets live in `/tmp/cc-socks/<pid>.sock`.

### 3.3 Per-session directory (`projects/<proj>/<sid>/`)

| Path | Content |
|---|---|
| `subagents/agent-<id>.jsonl` | Subagent transcript (same schema; `isSidechain: true`, `agentId`) |
| `subagents/agent-<id>.meta.json` | `{agentType, description, toolUseId, spawnDepth, requestShape ("background" or inline), requestNonInteractive}` |
| `subagents/agent-<id>.prefix.json` | Prompt-cache prefix state (`toolNames[]`); ignore |
| `tool-results/<id>.txt` | Persisted large tool outputs (>~30 KB) |

### 3.4 Scratchpad (`/private/tmp/claude-<uid>/<proj>/<sid>/`)

| Path | Content |
|---|---|
| `scratchpad/` | Model's temp files |
| `tasks/<taskId>.output` | Background Bash output (ends with `[exited with code N]`) |
| `tasks/<agentId>.output` | Background Agent transcript (JSONL) |

The path comes from the `environment` attachment (`snapshot.scratchpadDirectory`) or from `toolUseResult.outputFile`.

### 3.5 Other `~/.claude/` files

| Path | Freshness | Use |
|---|---|---|
| `history.jsonl` | Fresh | All typed prompts across projects: `{display, project, sessionId, timestamp, pastedContents}` |
| `cache/model-catalog/*.json` | Hourly | Model list, `effort_options`, `fast_mode`, `min_claude_code_version` |
| `cache/changelog.md` | Daily | Release notes; show "what's new" after an update |
| `.last-update-result.json` | On update | `version_from`, `version_to`, `outcome` |
| `plans/<slug>.md` | On plan exit | Plan-mode output. `<slug>` matches the transcript `slug` field |
| `feedback/drafts/*.json` | Lazy | SendFeedback drafts: `title`, `type`, `source_session_id` |
| `dev-mods/<sid>/` | Lazy | Mod development folder |
| `file-history/<sid>/<hash>@v<N>` | Fresh | Edit backups (already used for the count) |
| `session-env/<sid>/` | Session start | Empty on this machine |
| `shell-snapshots/snapshot-zsh-*.sh` | Session start | ignore |
| `.statusline-usage-cache` | 1 min | `UTILIZATION`, `RESETS_AT`, `WEEKLY_UTILIZATION`, `WEEKLY_RESETS_AT` from the statusline script (third rate-limit source) |
| `~/.claude.json` → `projects[<cwd>]` | Session exit | `lastCost`, `lastDuration`, `lastModelUsage`, `lastSessionId`, `lastLinesAdded/Removed`, `lastGracefulShutdown`, `lastFpsAverage` |
| `~/.claude.json` top level | Varies | `hasUsedRemoteControl`, `cachedArtifactRoster`, `pluginUsage`, `mcpServers` |
| `plugins/installed_plugins.json` | On install | Installed plugins with versions |
| `ide/<pid>.lock` | IDE connect | `ideName`, `workspaceFolders`, `pid` (do not read `authToken`) |
| `teams/`, `tasks/` | — | **Absent** on this machine with 2.1.296. Keep the loaders but treat as optional. |

---

## 4. Feature design

Priorities: **P0** = v1.6, **P1** = v1.7, **P2** = v1.8, **P3** = v1.9.

Each feature lists: data source → parse rule → UI → acceptance.

### F1. Recap panel (P0) — the user's top request

**Goal:** Show what Claude just said it did, and what Claude Code says the session was about, without scrolling the terminal.

**Sources (in display order):**

1. **Native recap:** last `system` entry with `subtype: "away_summary"`. Field `content`. Strip the trailing ` (disable recaps in /config)`.
2. **Final reply:** the last assistant message with `stop_reason: "end_turn"`. Join all `text` blocks across lines that share `message.id`. Ignore `thinking` blocks.
3. **Korean recap section:** inside the final reply, if a line matches `/^\*{0,2}(Korean recap|한국어 요약|요약|Recap)\*{0,2}\s*:?\s*$/i`, show only the text after that heading in the compact view. Fall back to the first 6 lines of the final reply.
4. **Live narration:** when the turn is still open (no `turn_duration` after the last user prompt), show the newest `text` block from any assistant line with `stop_reason: "tool_use"`. Label it `now:`. This is the "I'm doing X" line the model emits mid-turn.

**State additions:**

```ts
interface RecapInfo {
  nativeRecap: string | null;        // away_summary.content, cleaned
  nativeRecapTime: Date | null;
  finalReply: string | null;         // full text of last end_turn message
  finalReplyTime: Date | null;
  finalReplyModel: string | null;
  koreanRecap: string | null;        // extracted section, or null
  liveNarration: string | null;      // last mid-turn text block if turn open
  liveNarrationTime: Date | null;
  turnOpen: boolean;
}
```

**UI:**

```
┌─ Recap  13:34 ───────────────────────────────────────────────────────────┐
│ CC: You asked for a pre-PR sync with remote main, so I built pnpm pr …    │
│ ── Final reply 13:31 (fable-5-1) ─────────────────────────────────────── │
│ main에서 바로 커밋하지 않고 chore/pr-sync-main 브랜치를 만들어 커밋했습니다. │
│ 커밋 c0bf78c9, 파일 6개. post-commit 훅이 자동으로 push했고 …              │
│ 다음은 pr 또는 mtm 중 선택하시면 됩니다.                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

While the turn is open, the box title turns yellow and the first line is `now: <liveNarration>`.

Key `c` toggles a **full-screen recap view**: the full final reply, word-wrapped, scrollable with `j`/`k`, `Esc` returns.

**Rules:**

- Markdown is rendered minimally: strip `**`, keep list bullets, collapse blank lines, drop fenced code blocks and replace with `[code]`.
- CJK width handling reuses `displayWidth`/`wordWrap`.
- Cap the compact view at 8 lines; show `… (+N lines, press c)`.

**Acceptance:**

- With the sample transcript `b7a3fc04` (bzflow2), the compact panel shows the native recap and the three Korean lines.
- When a new user prompt arrives, the panel switches to `now:` mode within one refresh.
- When `away_summary` is absent (recaps disabled), the panel shows only the final reply, with no empty line.

### F2. Turn timeline (P0)

**Sources:** `user` entries with `promptSource` ∈ {`typed`, `queued`, `suggestion_accepted`} start a turn; `system/turn_duration` closes it (`durationMs`, `messageCount`, `pendingBackgroundAgentCount`). `turnPosition.turnIndex` gives the index.

**State:**

```ts
interface TurnInfo {
  index: number; startedAt: Date; endedAt: Date | null; durationMs: number | null;
  messageCount: number | null; toolCalls: number; promptPreview: string;
  origin: 'human' | 'task_notification' | 'peer';
  pendingBackgroundAgents: number;
}
turns: TurnInfo[];            // last 20
currentTurn: TurnInfo | null; // open turn, elapsed computed at render
```

**UI:** one line in the header area: `Turn:#14 ⏱ 2m31s (open) tools:37` or `Turn:#14 done 4m02s · avg 2m10s · last 5: ▂▅▃▇▁`. The sparkline uses `durationMs` of the last 10 turns.

**Acceptance:** `turnOpen` flips to false on the first `turn_duration` after the latest human prompt. Turns triggered by `task_notification` are shown dim and do not reset the "Idle" timer.

### F3. Background tasks & agents panel (P0)

**Sources:**

- `Agent` tool_use → `toolUseResult.status === "async_launched"` with `agentId`, `description`, `resolvedModel`, `outputFile`.
- Bash `run_in_background` → `toolUseResult.backgroundTaskId`.
- `Monitor` tool_use → same shape (verify on first sample).
- Completion: `user` entry with `origin.kind === "task-notification"`; content holds `<task-notification><task-id>…</task-id><status>completed|failed</status><summary>…</summary></task-notification>`. Also `queue-operation` with the same content.
- Liveness fallback: `tasks/<id>.output` mtime in the scratchpad dir; for Bash, the file ends with `[exited with code N]`.
- `pendingBackgroundAgentCount` from the latest `turn_duration`.

**State:**

```ts
interface BackgroundTask {
  id: string; kind: 'agent' | 'bash' | 'monitor' | 'workflow';
  description: string; model: string | null;
  startedAt: Date; endedAt: Date | null;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  exitCode: number | null; outputFile: string | null; outputBytes: number;
}
```

**UI:** replaces the current Subagents box when non-empty. Running rows show a spinner and elapsed; completed rows show the summary line. Row format: `● agent  code-reviewer  "Review the email capture slice"  2m14s  fable-5-1`.

**Acceptance:** For bzflow session `2c4b8982`, the panel lists 2 agents and 4 bash tasks with correct completed/running states, derived only from the transcript (no scratchpad read). Scratchpad read adds `outputBytes`.

### F4. Cost panel (P1)

**Source:** last `cost-state` entry. Fallback: `~/.claude.json` → `projects[cwd].lastCost` tagged "(prev session)".

**UI:** one header line: `Cost:$1.03  API:1m23s  Tools:1.3s  +0/-0 lines  fable:$1.03 haiku:$0.00`. Red when `hasUnknownModelCost`.

**Acceptance:** Shows within one refresh after the entry appears. Per-model costs sum to total ±$0.01.

### F5. Exact compaction and context (P1)

**Sources:** `system/compact_boundary.compactMetadata`; `user.isCompactSummary`; `attachment/compact_file_reference`. Context window from `cache/model-catalog` when it lists a context size, else the existing regex table.

**Changes:**

- `compactionCount` = count of `compact_boundary`. Keep the >30% heuristic only when the transcript has no `compact_boundary` and `version < 2.1.280`.
- New `lastCompaction: {trigger, preTokens, postTokens, durationMs, at}`.
- Header: `Compact:2 (manual 535K→14K)`.

### F6. Permission and safety strip (P1)

**Sources:** `permission-mode` entry (latest), `user.permissionDecision`, `user.toolDenialKind`, `attachment/auto_mode` flags, `hook_success` with `exitCode ≠ 0`.

**State:** `permissionMode: string`, `decisions: {accept: number, reject: number, byReason: Record<string, number>}`, `denials: Array<{tool, kind, reason, time}>` (last 5).

**UI:** header chip `Mode:auto(bash-first)` colored by mode (`auto` cyan, `plan` magenta, `bypassPermissions` red, `default` white). Below the Tools box, a one-line `Denied: 3 (hook 2, rule 1)` that expands with key `d`.

### F7. Hooks panel (P1)

**Sources:** `attachment/hook_success` (`hookName`, `hookEvent`, `exitCode`, `stdout` length), `system/stop_hook_summary` (`hookCount`, `hookErrors`, `preventedContinuation`).

**UI:** replaces the OMC-specific `.omc/state/last-skill-complete.json` dependency. Shows counts per event (`PreToolUse:7238 Stop:1060 SessionStart:85`), last error, and a red `STOP BLOCKED` tag when `preventedContinuation` is true on the latest turn.

Keep `scripts/on-skill-complete.sh` working but mark it optional in README.

### F8. Richer session identity (P1)

- Title precedence: `custom-title` > `agent-name` > `ai-title`.
- Header shows `slug` dimmed after the session id (links to `plans/<slug>.md`).
- Registry: `entrypoint` icon (`⌨` cli, `🖥` desktop), `kind`, `nameSource`.
- Status dot adds `waiting` (already drawn) and `unknown` when `statusUpdatedAt` is older than 10 min.
- Remote Control badge: latest `bridge_status` content containing "active" → `RC●` with the URL in the full-screen info view (`i`).

### F9. Links panel (P2)

**Sources:** `pr-link` (latest per repository), `frame-link` (last 3 artifacts), `plans/<slug>.md` (exists?), `feedback/drafts/*.json` where `source_session_id === sessionId`.

**UI:** `Links` box: `PR #158 bizmatrixx/bzflow`, `Artifact "Kotlin 1.9 → 2.4"`, `Plan clavis-link-robust-tide.md (12 KB)`, `Feedback draft: "Suggested …"`. URLs shown in the `i` view, not inline.

### F10. Prompt queue (P2)

**Sources:** `queue-operation` events (enqueue +1, dequeue/remove −1, floor 0); `attachment/queued_command.prompt` for previews; `promptSource: queued` confirms delivery.

**UI:** header chip `Queue:2` with the first 40 chars of the next queued prompt in the Last Prompt box footer.

### F11. Attribution and model telemetry (P2)

**Sources:** `assistant.attributionSkill`, `attributionPlugin`, `attributionMcpServer` (per message, dedupe by `message.id`); `server_tool_use` blocks named `advisor`; `thinkingDurationMs`; `usage.output_tokens_details.thinking_tokens`; `usage.speed`; `advisorModel`; `diagnostics.cache_miss_reason`.

**UI changes:**

- Skills box gains an "attributed" column: number of assistant messages produced under each skill. This replaces the `end_turn` heuristic for skill completion.
- New `MCP` box (collapsed by default): server → call count, from tool names `mcp__<server>__*` and `attributionMcpServer`.
- Header: `Advisor:opus-5-5 ×12`, `Think:4.9s avg`, `Fast` tag when `speed === "fast"`.
- Token line: `Cache miss: 3 (tools_changed 384K)` only when non-zero in the last 10 messages.

### F12. Error strip (P2)

**Sources:** `assistant.isApiErrorMessage` with `apiErrorStatus`/`apiErrorCode` and the text block; `user.interruptedMessageId` (`[Request interrupted by user]`); `assistant.isAbortedMidStream`.

**UI:** a red single line under the header when the last 3 turns contain an error: `API 529 overloaded 13:02 · interrupted ×1`.

### F13. Cross-session view (P3)

**Sources:** `history.jsonl` (last 10 prompts across projects with project basename), `sessions/*.json`, `~/.claude.json` projects `last*`.

**UI:** key `s` opens a session list: name, cwd, status dot, version, entrypoint, age, last prompt preview. `Enter` switches (replaces cycling with `n`). `n` stays as a shortcut.

### F14. File activity upgrade (P3)

**Sources:** `file-history-delta` (`trackingPath`, `backup.version`, `backup.backupTime`) gives real file names and edit counts; `attachment/edited_text_file` marks external edits; `toolUseResult.filePath` on Write/Edit.

**UI:** File Activity box lists `path  v3  13:31` sorted by last edit, replacing the raw chokidar event list for the session's own edits. Keep chokidar events for `~/.claude` internals under a dim sub-list.

### F15. Update and model catalog awareness (P3)

**Sources:** `.last-update-result.json`, `cache/changelog.md`, `cache/model-catalog/*.json`.

**UI:** when the running session's `version` ≠ newest `version_to`, show `update available` dim in the header. `i` view lists the top 5 changelog bullets of the newest version.

### F16. Scheduled tasks and background sessions (P3, unverified)

**Sources (from release notes, not yet seen on this machine):** project-local `.claude/scheduled_tasks.json`; background-session `state.json` with `detail`; registry `kind` = `attached` / `unattended`; `claude logs <name>`.

**Plan:** implement only after a fixture exists. Until then, show background-session rows in the session picker using the registry `kind` field, which is already present.

---

## 5. UI layout proposal

Default view at 100 columns. New or changed lines are marked `*`.

```
 Claude Code Monitor v1.6.0                                              13:34:21
 /Users/tobylee/workspace/ai/ccmonitor [main] — ccmonitor 기능 확장 스펙
 Session:01c3eb5d merry-enchanting-tarjan  Model:fable-5-1  Effort:high  Ctx:9%  Age:3m  Idle:12s
*Turn:#3 ⏱ 1m04s (open) tools:12 · last 5: ▂▅▃▇▁      Mode:auto(bash-first)  RC○  CC:v2.1.296
 Sess:5 (+●bzflow2-a4, ●bzflow-3d, ○Kotlin…)  Mem:412MB
 Msgs:U:3 A:41  Tok:I:1.2K O:38K CW:120K CR:3.1M  Files:1
*Cost:$1.03  API:1m23s  Compact:0  Peak:91K  Rate:52K/min
 Quota 5h:█░░░░░░░░░ 10% (4h12m) wk:███░░░░░░░ 28% (1d19h)
┌─ Last Prompt  13:33 ──────────────────────────────────────────────────────────┐
│ ccmonitor 마지막 개발 이후 claude code에 많은 기능이 추가됐어. …                │
└───────────────────────────────────────────────────────────────────────────────┘
*┌─ Recap  (turn open) ─────────────────────────────────────────────────────────┐
*│ now: I have the raw data mapped. Writing the spec while the agent finishes.   │
*│ ── Previous reply 13:29 ────────────────────────────────────────────────────  │
*│ main에서 바로 커밋하지 않고 chore/pr-sync-main 브랜치를 만들어 커밋했습니다.   │
*└───────────────────────────────────────────────────────────────────────────────┘
*┌─ Background  2 running ──────────────────────────────────────────────────────┐
*│ ● agent  general-purpose  "Summarize Claude Code changelog range"  1m48s      │
*│ ✓ bash   "Survey entry types across recent transcripts"  exit 0  12s          │
*└───────────────────────────────────────────────────────────────────────────────┘
┌─ Tools ───────────────────────────────────────────────────────────────────────┐
│ Bash ×37 ~1.2s   Agent ×1   Read ×2   …                   Denied:0            │
└───────────────────────────────────────────────────────────────────────────────┘
┌─ Skills ──────────────┐┌─ Hooks ────────────────────────────────────────────────┐
│ (none this session)   ││ PreToolUse:37 Stop:3 SessionStart:1   errors:0        │
└───────────────────────┘└───────────────────────────────────────────────────────┘
┌─ Links ───────────────────────────────────────────────────────────────────────┐
│ PR —   Artifact —   Plan —   Feedback —                                       │
└───────────────────────────────────────────────────────────────────────────────┘
┌─ Memory ──────────────┐┌─ File Activity ────────────────────────────────────────┐
│ MEMORY.md 0 topics    ││ docs/spec-v2-session-state.md  v1  13:34               │
└───────────────────────┘└───────────────────────────────────────────────────────┘
```

Keyboard (additions):

| Key | Action |
|---|---|
| `c` | Full-screen Recap view (scroll `j`/`k`, `Esc` back) |
| `b` | Full-screen Background tasks view with output tail (last 20 lines of `outputFile`) |
| `d` | Expand denials / permission decisions |
| `i` | Session info view: registry JSON fields, URLs (RC, PR, artifacts), plan path, changelog top 5 |
| `s` | Session picker list (P3) |
| `1`–`9` | Collapse/expand panel N (persisted in `~/.claude/ccmonitor-ui.json`) |

Narrow terminals (<80 cols): Recap and Background stack full width; Hooks/Links fold into the `i` view.

---

## 6. Architecture changes

### 6.1 Types (`src/types.ts`)

- Extend `EntryType` with: `atis-latch`, `cost-state`, `custom-title`, `agent-name`, `frame-link`, `pr-link`, `bridge-session`, `file-history-delta`, `dev-mods`, `artifact-comment-monitor`, `artifact-autoreact-ledger`.
- Extend `TranscriptEntry` with the fields in 3.1 (all optional).
- Add `RecapInfo`, `TurnInfo`, `BackgroundTask`, `CostInfo`, `CompactionInfo`, `PermissionInfo`, `HookInfo`, `LinkInfo`, `QueueInfo`, `AttributionInfo`, `ErrorInfo`, `EditedFile`.
- `SessionState` gains one field per feature. Keep existing fields; mark `completedSkillIds` deprecated once F11 lands.

### 6.2 Parser (`src/parser.ts`)

- **Message grouping:** maintain `lastMessageId`; when an assistant line repeats `message.id`, merge blocks and skip `usage` accumulation. This fixes token over-counting and enables recap text joining.
- **Turn state machine:** `openTurn` set on human prompt; closed on `turn_duration`. `task_notification` prompts open a turn flagged `origin: task_notification`.
- **New `processEntry` branches:** `system` by subtype; `attachment` by kind (only the kinds in 3.1.2 marked useful); `cost-state`; `pr-link`; `frame-link`; `bridge-session`; `custom-title`; `agent-name`; `queue-operation`; `file-history-delta`.
- **New loaders:** `loadScratchpadTasks(state)` (reads `tasks/*.output` size and tail only for running tasks), `loadModelCatalog()` (cached per process, re-read when mtime changes), `loadPlanFile(slug)`, `loadFeedbackDrafts(sessionId)`, `loadLastUpdate()`, `loadStatuslineUsageCache()` as a third rate-limit source.
- **Incremental parsing (required for v1.6):** transcripts reach 8 MB. Keep `{file, size, offset, state}`; on refresh, if `size > offset`, read only the new bytes and feed complete lines to `processEntry`. If `size < offset`, or the first 64 bytes at offset 0 changed (transcript GC rewrite, `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC`), reparse from zero. Loaders still run every refresh. Measured budget: a refresh must finish in <50 ms for a 3 MB transcript on this machine.

### 6.3 Renderer (`src/ui.ts`)

- Introduce `Section` objects (`id`, `title`, `render(state, W): string[]`, `collapsed`) as planned in US-007 of the quality PRD. The new panels are the first consumers.
- Add a `View` enum: `dashboard | recap | background | info | sessions`. `render()` dispatches on it.
- Markdown-lite helper `mdToPlain(text): string[]`.

### 6.4 Watcher (`src/index.ts`)

- Add watch paths: the session's scratchpad `tasks/` dir (from the `environment` attachment), `~/.claude/plans/`, `~/.claude/feedback/drafts/`, `~/.claude/cache/model-catalog/`.
- Keyboard: add the keys in section 5. Keep `q`, `r`, `n`.

### 6.5 Privacy rules

- Never render `prompt_snapshot`, `credential_org`, `session_context.userEmail`, `ide/*.lock.authToken`, `sessions/*.key`, or `.credentials.json`.
- Background agent output tails may contain secrets echoed by tools. Show tails only in the `b` view, never in the default dashboard.

---

## 7. Phased plan

| Version | Features | Notes |
|---|---|---|
| **1.6.0** | F1 Recap, F2 Turn timeline, F3 Background tasks, message-id grouping fix, incremental parsing | The user's priority. Ship with `c` and `b` views. |
| **1.7.0** | F4 Cost, F5 Compaction, F6 Permissions, F7 Hooks, F8 Identity/RC | All header/strip level; no new boxes except Hooks. |
| **1.8.0** | F9 Links, F10 Queue, F11 Attribution/MCP, F12 Errors | Depends on `Section` refactor for layout. |
| **1.9.0** | F13 Sessions picker, F14 File activity, F15 Update awareness, F16 if fixtures exist | Cross-session and polish. |

Each release follows the CLAUDE.md `upgrade` protocol: bump minor, `bun run build`, CHANGELOG entry, README update, commit, push.

### 7.1 Test fixtures

Create `fixtures/` with trimmed, anonymized JSONL from this machine:

- `recap-basic.jsonl`: one turn, `end_turn` with Korean recap, then `away_summary`.
- `turn-open.jsonl`: human prompt, several `tool_use` lines with narration, no `turn_duration`.
- `background.jsonl`: async Agent launch, Bash background, two task-notifications, `pendingBackgroundAgentCount: 1`.
- `compaction.jsonl`: `compact_boundary` + `isCompactSummary` user entry.
- `multiblock.jsonl`: one `message.id` across 3 lines to lock the token-count fix.

`bun test` (from the quality PRD) runs parser assertions against these.

---

## 8. Risks and open questions

1. **Undocumented schema.** Every field here was observed, not documented. Field names can change between patch versions. Mitigation: all new fields optional; render `—` when absent; log unknown `type`/`subtype`/`attachment.type` values once per run to `~/.claude/ccmonitor-unknown-fields.log` so drift is visible.
2. **`away_summary` timing.** It appears ≥3 minutes after the turn ends and only when recaps are enabled. The Recap panel must look complete without it.
3. **Message-id grouping changes existing numbers.** Token totals will drop after the fix. Note this in the 1.6.0 CHANGELOG.
4. **Scratchpad path differs per OS/uid.** Always derive it from the `environment` attachment; never hard-code `/private/tmp/claude-501`.
5. **`teams/` and `tasks/` directories are absent on 2.1.296.** Cause confirmed in the release notes: todo/task tools are disabled on Claude 5-family models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. Keep the loaders guarded and hide the Tasks box when empty. Team features remain untested here.
6. **Performance.** 60 transcripts total 505 MB in `projects/`. Only the selected session is parsed, but the first parse of an 8 MB file takes noticeable time. Incremental parsing is in scope for 1.6 for this reason.
7. **Desktop sessions** (`entrypoint: claude-desktop`) register with a title as `name` and a `hostSessionId`. The picker should show them but mark them as desktop.

---

## Appendix A. Sample entries (trimmed)

```jsonc
// Native recap
{"type":"system","subtype":"away_summary","content":"You asked for a pre-PR sync with remote main, so I built pnpm pr with tests and docs, and committed it on branch chore/pr-sync-main. Next, say pr to open the PR or mtm to merge into main. (disable recaps in /config)","timestamp":"2026-10-10T03:34:37.339Z","sessionId":"b7a3fc04-…","gitBranch":"chore/pr-sync-main"}

// Turn close
{"type":"system","subtype":"turn_duration","durationMs":491,"messageCount":17,"pendingBackgroundAgentCount":2,"timestamp":"2026-10-10T02:31:10.459Z"}

// Compaction
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"manual","preTokens":534977,"postTokens":13769,"cumulativeDroppedTokens":521208,"durationMs":59230},"logicalParentUuid":"e6fe46ea-…"}

// Cost
{"type":"cost-state","totalCostUSD":1.0333569,"totalAPIDuration":83110,"totalToolDuration":1347,"totalLinesAdded":0,"totalLinesRemoved":0,"totalDuration":1685879,"startTime":1791601063618,"modelUsage":{"claude-fable-5-1":{"inputTokens":290,"outputTokens":3634,"thinkingTokens":1050,"cacheReadInputTokens":388622,"cacheCreationInputTokens":37567,"webSearchRequests":0,"costUSD":1.0330955}},"hasUnknownModelCost":false}

// Async agent launch (user entry carrying the tool result)
{"type":"user","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a3307b749cd8cca09","description":"Review the email capture slice","resolvedModel":"claude-fable-5-1","outputFile":"/private/tmp/claude-501/<proj>/<sid>/tasks/a3307b749cd8cca09.output","canReadOutputFile":true,"canContinueAgent":true}}

// Task notification prompt
{"type":"user","origin":{"kind":"task-notification","producer":"session-task","runId":"0mv1u5hx8-06fa3363"},"turnOrigin":"task_notification","message":{"role":"user","content":"<task-notification>\n<task-id>beew8wowa</task-id>\n<status>completed</status>\n<summary>Background command \"Run the adapter…\" completed (exit code 0)</summary>\n</task-notification>"}}

// Links
{"type":"pr-link","prNumber":158,"prUrl":"https://github.com/bizmatrixx/bzflow/pull/158","prRepository":"bizmatrixx/bzflow","timestamp":"2026-10-08T11:49:31.515Z"}
{"type":"frame-link","frameUrl":"https://claude.ai/artifact/Y9BT3V16qDzRdSv4UfcJif","title":"Kotlin 1.9 → 2.4","artifactCount":1,"path":"/private/tmp/…/kotlin-24-motion.html"}

// Remote Control
{"type":"system","subtype":"bridge_status","content":"/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01VZC8…","url":"https://claude.ai/code/session_01VZC8…"}

// Permission decision on a tool result
{"type":"user","permissionDecision":{"decision":"reject","source":"hook","reasonType":"hook"},"toolDenialKind":"permission-rule"}

// Subagent metadata
{"agentType":"code-reviewer","description":"Review the email capture slice","toolUseId":"toolu_01Wk…","spawnDepth":1,"requestShape":"background","requestNonInteractive":true}
```

## Appendix B. Fields the monitor must not display

`prompt_snapshot.systemPrompt`, `credential_org`, `session_context.userEmail`, `sessions/<pid>.<hash>.key`, `ide/<pid>.lock.authToken`, `.credentials.json`, `advisor_tool_result.encrypted_content`, `serverClassifierContext`, `serverClassifierRequest`, `wireToolInputs`.

## Appendix C. Changelog lines worth re-reading

Line numbers in `~/.claude/cache/changelog.md` as of 2026-10-10: recap cap 3166; `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` 5758; todo tools off 2.1.233/2.1.268; transcript GC 2.1.288; OSC 7501 2.1.295; scheduled tasks 2.1.285/2.1.290.
