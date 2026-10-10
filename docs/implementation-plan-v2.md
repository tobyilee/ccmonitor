# ccmonitor v2 — Implementation Plan

**Status:** Draft for review
**Date:** 2026-10-10
**Spec:** `docs/spec-v2-session-state.md` (feature IDs F1–F16 refer to that document)
**Related:** `tasks/prd-quality-uplift.md` (US-001 … US-007; this plan absorbs the parts it needs)

---

## 0. 요약 (Korean summary)

- 스펙의 16개 기능을 **5개 단계, 31개 태스크**로 나눴다. 단계마다 릴리스가 하나 있다 (v1.6 → v1.9).
- 모든 태스크에 **검증 절차**가 있다. 검증은 세 종류다. (1) `bun test` 로 돌리는 fixture 기반 단위 테스트, (2) `bun run typecheck` + `bun run build`, (3) 실제 세션으로 하는 수동 TUI 확인.
- Fixture는 이 머신의 실제 트랜스크립트에서 잘라낸다. 그래서 기대값이 이미 정해져 있다. 예: Recap fixture의 `away_summary`는 "You asked for a pre-PR sync…"로 시작해야 한다.
- 0단계(기반 작업)를 먼저 끝내야 한다. 테스트 러너, fixture 도구, 메시지 ID 그룹핑, 증분 파싱이 여기에 있다.

---

## 1. How to read this plan

Each task has the same five blocks.

| Block | Meaning |
|---|---|
| **Goal** | One sentence. What exists after the task. |
| **Files** | Files created or changed. |
| **Steps** | The work, in order. |
| **Verify** | Exact checks. A task is not done until every check passes. |
| **Depends on** | Tasks that must be done first. |

Verification uses three tools:

1. **Unit tests** — `bun test`. Tests live next to the code (`src/*.test.ts`) and read fixtures from `fixtures/`.
2. **Static checks** — `bun run typecheck` (tsc, zero errors) and `bun run build` (binary builds).
3. **Manual TUI check** — run `bun run src/index.ts <sessionId>` against a named real session and compare with the expected text. The session IDs below exist on this machine today. If one is gone, cut a fixture from it first (T0.3) and use `bun run src/index.ts --fixture fixtures/<name>.jsonl` (added in T0.3).

Expected values in this plan were measured on 2026-10-10 from `~/.claude/projects/`. When a fixture is cut, record the measured values in the fixture's `.expect.json` sidecar so tests do not depend on prose.

---

## 2. Fixture catalog

Fixtures are trimmed, scrubbed JSONL files. The scrubber (T0.3) replaces `/Users/tobylee` with `/Users/dev`, removes `prompt_snapshot`, `credential_org`, `serverClassifier*`, `wireToolInputs`, `session_context`, and replaces every `text`/`content` string longer than 300 characters with a placeholder unless the entry is in the keep-list. **Review every fixture before commit**; the source sessions hold work content (`bzflow`).

| Fixture | Source session | Keep-list | Expected facts (measured) |
|---|---|---|---|
| `recap-basic.jsonl` | bzflow2 `b7a3fc04-de70-4c43-adc1-1d041c43c567` | last `end_turn` message, `away_summary` | 3 `end_turn` messages; last one `message.id = msg_011CfsrHM5x682ADRG8wU5AP` at `03:31:31Z`; its text contains the heading `**Korean recap**` followed by 3 bullets; `away_summary` content starts `You asked for a pre-PR sync with remote main` and ends `(disable recaps in /config)`; `away_summary` is 186 s after the last `end_turn` |
| `multiblock.jsonl` | same session | one message split in 3 lines | `message.id = msg_011CfsqkAy8H2tJKPnokNzYh` appears on 3 lines; each line carries identical `usage` (`output_tokens` 1228 on the end_turn message `msg_011Cfsr7dZN5HMtVDQ5LsjEE`, 2 lines) |
| `turn-open.jsonl` | same session, cut before the final `turn_duration` | mid-turn `text` blocks | 8 mid-turn narration blocks in the full session; last one begins `**Rewritten prompt:** "Commit the current changes."`; no `turn_duration` after the last human prompt |
| `background.jsonl` | bzflow `253aaf04-fe1a-4d97-b8eb-87ee6b61659f` | async Agent results, Bash background results, queue ops | agents `a3307b749cd8cca09`, `a573350ab857e538c`; bash tasks `b40ny2vsk`, `beew8wowa`, `bv2yna52c`, `bxyacc5c3`, `bz0had0z5`; 20 `queue-operation` entries; one `turn_duration` with `pendingBackgroundAgentCount: 2`; 3 human prompts; 1 `toolDenialKind`; 162 `hook_success` attachments |
| `compaction.jsonl` | bzflow `e1cd2912-6033-4ef6-8de0-4f97d4978041` | `compact_boundary`, `isCompactSummary` user entry, `bridge_status` | 2 `compact_boundary`; the first has `trigger: manual`, `preTokens: 534977`, `postTokens: 13769`; `bridge_status.url` = `https://claude.ai/code/session_01VZC8GyRsaCCBz48ySKtCbA` |
| `links.jsonl` | bzflow `f63f1f68-fbdd-431b-83e4-4b8fb3cc78d9` + kotlin `7fe32363-515c-4a1b-b09d-c62eb5ccacf4` | `pr-link`, `frame-link`, `custom-title`, `agent-name` | `pr-link` #158 `bizmatrixx/bzflow` (2 entries, dedupe to 1); `frame-link` title `Kotlin 1.9 → 2.4`; `custom-title` = `Kotlin 1.9에서 2.4로 마이그레이션 가이드`; kotlin entries have `entrypoint: claude-desktop` |
| `cost.jsonl` | any session with `cost-state` (find with `grep -l '"type":"cost-state"' ~/.claude/projects/*/*.jsonl`) | all `cost-state` | sample seen: `totalCostUSD: 1.0333569`, two models, `hasUnknownModelCost: false` |
| `errors.jsonl` | laurentang `1b993a23-0a71-4f76-85f2-dde383c94c46` | synthetic assistant error | one assistant line with `isApiErrorMessage: true`, `model: "<synthetic>"`, `stop_reason: stop_sequence`, text starts `Your organization has disabled` |
| `registry/` | copies of `~/.claude/sessions/*.json` with `pid` set to a dead PID and `.key` files **excluded** | — | 5 entries; one has `entrypoint: claude-desktop` and `hostSessionId`; statuses `busy`/`idle` |

---

## 3. Phase 0 — Foundation (no user-visible change)

### T0.1 tsconfig and typecheck

- **Goal:** `bun run typecheck` exists and passes with zero errors.
- **Files:** `tsconfig.json` (new), `package.json`.
- **Steps:** Add `tsconfig.json` with `"types": ["bun"]`, `strict`, `noUncheckedIndexedAccess`. `bun add -d @types/bun typescript`. Add script `"typecheck": "tsc --noEmit"`. Fix any real type errors that surface.
- **Verify:**
  - `bun run typecheck` → exit 0, prints no errors.
  - `bun run build` → `dist/ccmonitor` exists and `./dist/ccmonitor --help` (or `q` after start) exits 0.
- **Depends on:** none.

### T0.2 Test runner

- **Goal:** `bun test` runs and is green.
- **Files:** `package.json`, `src/parser.test.ts` (new).
- **Steps:** Add scripts `"test": "bun test"`, `"test:watch": "bun test --watch"`. Write 3 tests for `extractRealUserPrompt` (plain text; `<command-args>` extraction; hook preamble stripped).
- **Verify:**
  - `bun test` → `3 pass, 0 fail`, exit 0.
  - Break one assertion on purpose, confirm `bun test` fails, then restore it.
- **Depends on:** T0.1.

### T0.3 Fixture tool and `--fixture` flag

- **Goal:** A repeatable way to cut scrubbed fixtures from real transcripts and run the monitor against them.
- **Files:** `scripts/make-fixture.ts` (new), `fixtures/` (new), `src/index.ts`.
- **Steps:**
  1. `make-fixture.ts <transcript> --out fixtures/<name>.jsonl [--from <uuid>] [--to <uuid>] [--keep <uuid>,…]`. Scrub rules from section 2. Write `<name>.expect.json` with counts per `type`, `system.subtype`, `attachment.type`, `stop_reason`, and the list of `message.id`s.
  2. In `index.ts`, accept `--fixture <path>`: parse that file as the session, skip the registry/process loaders, and disable the file watcher.
  3. Cut the 9 fixtures from the catalog.
- **Verify:**
  - `grep -c tobylee fixtures/*.jsonl` → every file prints `0`.
  - `grep -c -E 'prompt_snapshot|credential_org|serverClassifier|wireToolInputs' fixtures/*.jsonl` → all `0`.
  - `bun run src/index.ts --fixture fixtures/recap-basic.jsonl` renders a dashboard, no crash, `q` exits.
  - For each fixture, `bun test` includes a smoke test that parses it and compares type counts with the `.expect.json` sidecar.
  - Manual review: open each fixture and confirm no customer or secret text remains.
- **Depends on:** T0.2.

### T0.4 Pure parser split

- **Goal:** Parsing is separate from disk loaders, so fixtures test parsing without `~/.claude`.
- **Files:** `src/parser.ts`.
- **Steps:** Extract `parseTranscriptLines(lines: string[], ctx): SessionState` (no fs, no `Date.now`, no `process.kill`) and `enrichSessionState(state)` that runs the existing loaders. `parseTranscript` becomes read → parse → enrich. This is US-003 from the quality PRD.
- **Verify:**
  - `bun test` green; add a test that calls `parseTranscriptLines` on `recap-basic.jsonl` and asserts `messageCount.user`, `messageCount.assistant`, `model` equal the sidecar values.
  - `grep -n 'readFileSync\|existsSync\|Date.now\|process.kill' src/parser.ts` shows none of them inside `parseTranscriptLines` or `processEntry`.
  - Manual: `bun run src/index.ts` on the current session renders the same header numbers as before the change (write them down before starting).
- **Depends on:** T0.3.

### T0.5 Message-id grouping (token and message count fix)

- **Goal:** One API response counts once, even when it spans several JSONL lines.
- **Files:** `src/parser.ts`, `src/types.ts`.
- **Steps:** Track `seenMessageIds: Set<string>`. On an assistant line whose `message.id` was seen: merge the content blocks into the group, do **not** add `usage`, do **not** increment `messageCount.assistant`, do **not** push to `tokenHistory`. Keep `contextTokens` logic on the first line only. Record `assistantMessages: Map<messageId, {blocks, stopReason, time, model}>` for F1.
- **Verify:**
  - Test on `multiblock.jsonl`: `messageCount.assistant` equals the number of distinct `message.id`s in the sidecar (not the number of lines). `tokenUsage.output` equals the sum of `output_tokens` over distinct ids.
  - Test: for `msg_011Cfsr7dZN5HMtVDQ5LsjEE`, the grouped text is non-empty although the first line of that id has no text block.
  - Manual: run on the current session before and after. The `A:` count and `O:` tokens must drop; `U:` must not change. Record both numbers in the CHANGELOG entry for 1.6.0.
- **Depends on:** T0.4.

### T0.6 Incremental tail parsing

- **Goal:** A refresh reads only new bytes; a rewritten transcript is detected and reparsed.
- **Files:** `src/parser.ts`, `src/index.ts`.
- **Steps:** Keep `{path, offset, headHash, state}`. On refresh: `stat`. If `size < offset` or the hash of the first 64 bytes changed → full reparse. Else read `[offset, size)`, split on `\n`, keep a trailing partial line in a buffer, feed complete lines to `processEntry`, then run `enrichSessionState`. Add `CCMONITOR_FULL_PARSE=1` to force the old path.
- **Verify:**
  - Test: feed `recap-basic.jsonl` in two halves (split mid-line) and in one piece; the resulting states are deep-equal (ignore `Date` objects from loaders).
  - Test: after parsing, truncate the file to half and refresh; the parser reports `fullReparse: true` and the state equals a fresh parse of the truncated file.
  - Timing: `time bun run scripts/bench-parse.ts <8 MB transcript>` (new tiny script) prints full parse time; then an incremental refresh with 10 appended lines must be under 50 ms. Use `~/.claude/projects/-Users-tobylee-workspace-work-bmx-bzflow/518905f8-d3f4-4edb-a457-a091f106871a.jsonl` (8.1 MB) as the input.
  - Manual: run the monitor on a live session, type a prompt in that session, confirm the dashboard updates within 2 refreshes and CPU stays low (`top -pid <monitor pid>` under 5 percent while idle).
- **Depends on:** T0.5.

### T0.7 Unknown-field logger

- **Goal:** Schema drift is visible without a debugger.
- **Files:** `src/parser.ts`.
- **Steps:** Keep a `Set` of known `type`, `system.subtype`, `attachment.type`. When an unknown value appears, append one line `{"when","sessionId","kind","value"}` to `~/.claude/ccmonitor-unknown-fields.log` once per value per run.
- **Verify:**
  - Test: parse a line `{"type":"made-up-type"}`; the logger callback (injected) receives `kind: type, value: made-up-type` exactly once even if the line is fed twice.
  - Manual: run on the current session for one minute; the log file contains no entries for the kinds listed in spec section 3.1.
- **Depends on:** T0.4.

---

## 4. Phase 1 — v1.6.0 (Recap, Turns, Background)

### T1.1 Types for new entries

- **Goal:** `types.ts` covers every field the v1.6 parser reads.
- **Files:** `src/types.ts`.
- **Steps:** Extend `EntryType`; add optional fields to `TranscriptEntry` (`subtype`, `content`, `durationMs`, `messageCount`, `pendingBackgroundAgentCount`, `compactMetadata`, `url`, `origin`, `promptSource`, `turnOrigin`, `turnPosition`, `toolUseResult`, `attachment`, `operation`, …). Add `RecapInfo`, `TurnInfo`, `BackgroundTask`, `AssistantMessage`. Add the new `SessionState` fields with defaults in `parseTranscript`.
- **Verify:** `bun run typecheck` green. A test constructs one object of each new interface (compile-time check).
- **Depends on:** T0.5.

### T1.2 System subtype and attachment routing

- **Goal:** `processEntry` stores the raw facts for every useful `system.subtype` and `attachment.type`.
- **Files:** `src/parser.ts`.
- **Steps:** Add `handleSystem(state, entry)` with a `switch` on `subtype`: `away_summary` → `state.recap.nativeRecap/time`; `turn_duration` → turn close (T1.5); `stop_hook_summary` → `state.hooks.lastStop`; `compact_boundary` → `state.compactions.push(...)`; `bridge_status` → `state.remoteControl`; `local_command` → `state.localCommands` (last 5). Add `handleAttachment(state, entry)` for `hook_success`, `queued_command`, `environment` (scratchpad path), `auto_mode`, `edited_text_file`. Ignore the rest silently.
- **Verify:**
  - Test on `recap-basic.jsonl`: `recap.nativeRecap` starts with `You asked for a pre-PR sync`; the ` (disable recaps in /config)` suffix is removed; `recap.nativeRecapTime` is `2026-10-10T03:34:37.339Z`.
  - Test on `compaction.jsonl`: `compactions.length === 2`; `compactions[0]` has `trigger: "manual"`, `preTokens: 534977`, `postTokens: 13769`; `remoteControl.url` equals the fixture URL.
  - Test on `background.jsonl`: `scratchpadDir` ends with `/253aaf04-fe1a-4d97-b8eb-87ee6b61659f/scratchpad` (after scrubbing, under `/Users/dev` or `/private/tmp/claude-501`).
- **Depends on:** T1.1.

### T1.3 Recap extraction

- **Goal:** `state.recap` is complete: native recap, final reply, Korean section, live narration, `turnOpen`.
- **Files:** `src/parser.ts`, `src/recap.ts` (new, pure functions).
- **Steps:**
  1. `finalReply` = joined `text` blocks of the last grouped assistant message with `stop_reason: end_turn`.
  2. `extractKoreanRecap(text)` finds a line matching `/^\*{0,2}(Korean recap|한국어 요약|한글 요약|요약|Recap)\*{0,2}\s*:?\s*$/im` and returns the text after it, trimmed. Returns `null` if absent.
  3. `liveNarration` = the last `text` block from any grouped assistant message with `stop_reason: tool_use` that is newer than the last human prompt. Only set when `turnOpen`.
  4. `mdToPlain(text): string[]` strips `**`, `__`, backticks, heading `#`s; keeps `- ` bullets; replaces fenced code blocks with `[code]`; collapses blank runs to one.
- **Verify:**
  - Test on `recap-basic.jsonl`: `finalReply` contains `Committed on a new branch`; `koreanRecap` has exactly 3 lines, the first starts with `main에서 바로 커밋하지 않고`; `turnOpen === false`; `liveNarration === null`.
  - Test on `turn-open.jsonl`: `turnOpen === true`; `liveNarration` starts with `**Rewritten prompt:**` before `mdToPlain` and with `Rewritten prompt:` after it.
  - Test `extractKoreanRecap` on 4 strings: `**Korean recap**`, `## 요약`, `Recap:`, and a text with none → the last returns `null`.
  - Test `mdToPlain`: input with a fenced block and bold → output has `[code]` once and no `**`.
  - Test: recaps disabled case — remove the `away_summary` line from a copy of the fixture; `nativeRecap === null` and `finalReply` is unchanged.
- **Depends on:** T1.2.

### T1.4 Recap panel and `c` view

- **Goal:** The Recap box renders under Last Prompt; `c` opens a scrollable full view.
- **Files:** `src/ui.ts`, `src/index.ts`.
- **Steps:** Add `renderRecap(state, W)`: title `Recap  HH:MM` (yellow and `(turn open)` while open); first line `CC: <nativeRecap>` if present; divider line `── Final reply HH:MM (model) ──`; then `koreanRecap ?? first 6 lines of mdToPlain(finalReply)`; cap at 8 lines with `… (+N lines, press c)`. Add `view` state in `index.ts`: `dashboard | recap`; keys `c`, `j`, `k`, `Esc`.
- **Verify:**
  - Manual with fixture: `bun run src/index.ts --fixture fixtures/recap-basic.jsonl` shows the box with `CC: You asked for a pre-PR sync…` and three Korean lines. No line exceeds the terminal width (resize to 80 and 120 columns; borders stay aligned, check with CJK text).
  - Manual with fixture: `--fixture fixtures/turn-open.jsonl` shows a yellow title and `now: Rewritten prompt: …`.
  - Manual live: run on this session's ID (`01c3eb5d-…`). Type a short prompt in the Claude Code session. Within 4 s the box shows `now:`; after the reply, it shows the new final reply; about 3 minutes later `CC:` appears.
  - Press `c`: the full reply is shown, `j`/`k` scroll, `Esc` returns to the dashboard. `q` still quits from both views.
  - `bun run typecheck`, `bun run build` green.
- **Depends on:** T1.3.

### T1.5 Turn state machine and header line

- **Goal:** `state.turns` and `state.currentTurn` exist and the header shows the turn line.
- **Files:** `src/parser.ts`, `src/ui.ts`.
- **Steps:** Open a turn on a `user` entry with `promptSource` in `typed|queued|suggestion_accepted|sdk` or `turnOrigin: human` (fallback for old transcripts: `extractRealUserPrompt` non-null). Mark `origin` from `turnOrigin`. Count `tool_use` blocks into the open turn. Close on `turn_duration` with `durationMs`, `messageCount`, `pendingBackgroundAgents`. Keep the last 20. Header line: `Turn:#N ⏱ 1m04s (open) tools:12` or `Turn:#N done 4m02s · avg 2m10s · ▂▅▃▇▁`.
- **Verify:**
  - Test on `background.jsonl`: `turns.length === 3` closed turns; the last has `pendingBackgroundAgents === 2`; the turn with `promptSource: queued` has `origin: human`.
  - Test on `turn-open.jsonl`: `currentTurn !== null`, `currentTurn.toolCalls > 0`, `turns` holds the earlier closed turns.
  - Test: a `user` entry with `turnOrigin: task_notification` opens a turn flagged `origin: task_notification` and does not update `lastUserPrompt`.
  - Manual live: the elapsed counter increases every refresh while Claude works, then freezes at the final duration when the reply lands. The `Idle:` value does not reset when a background task notification arrives.
- **Depends on:** T1.2.

### T1.6 Background task parsing and scratchpad loader

- **Goal:** `state.backgroundTasks` lists agents and background commands with status.
- **Files:** `src/parser.ts`, `src/loaders/scratchpad.ts` (new).
- **Steps:**
  1. From `tool_use` blocks named `Agent`, `Bash` (with `run_in_background: true`), `Monitor`: remember `toolUseId → {kind, description, startedAt}`.
  2. From the matching `toolUseResult`: `agentId`/`backgroundTaskId`, `resolvedModel`, `outputFile`, `status: async_launched` → `running`.
  3. From `queue-operation` content and `user` entries whose content contains `<task-notification>`: parse `<task-id>`, `<status>`, `<summary>`; mark the task `completed`/`failed`, set `endedAt`, parse `exit code N` from the summary.
  4. Loader: for tasks still `running`, `stat` the `outputFile`; set `outputBytes`; for Bash, if the file ends with `[exited with code N]`, mark completed with that code. If the scratchpad dir does not exist, leave `unknown`.
  5. Cross-check with `pendingBackgroundAgentCount` from the latest `turn_duration`; show a dim `?` when the counts disagree.
- **Verify:**
  - Test on `background.jsonl` (parse only, no fs): 2 agents (`a3307b749cd8cca09`, `a573350ab857e538c`) and 5 bash tasks with the IDs in the catalog; `description` of the first agent is `Review the email capture slice`; `model` is `claude-fable-5-1`; tasks whose task-notification is in the fixture are `completed` with `exitCode 0`; others are `running`.
  - Test the task-notification parser on the sample string from spec Appendix A: returns `{id: "beew8wowa", status: "completed", exitCode: 0}`.
  - Test the loader with a temp dir: write `x.output` ending in `[exited with code 3]` → status `completed`, `exitCode 3`; write a file without the marker → stays `running`, `outputBytes` equals the file size.
  - Manual live: in a Claude Code session run a background command (`sleep 20 &` via `run_in_background`) and spawn one Agent. The panel shows both as running within 4 s and flips to done after they finish.
- **Depends on:** T1.2, T1.5.

### T1.7 Background panel and `b` view

- **Goal:** The Background box replaces the Subagents box when it has rows; `b` shows the output tail.
- **Files:** `src/ui.ts`, `src/index.ts`.
- **Steps:** Row format `● agent  <type>  "<description>"  <elapsed>  <model>` and `✓ bash  "<description>"  exit 0  12s`; failed rows red `✗`. Title `Background  N running`. `b` view lists tasks with the last 20 lines of each `outputFile` (read on demand, never on the dashboard). Keep the old Subagents box when `backgroundTasks` is empty but `subagents` is not.
- **Verify:**
  - Manual with fixture: `--fixture fixtures/background.jsonl` shows 7 rows; the title says `N running` where N equals the number of rows without a notification in the fixture.
  - Manual live: the `b` view shows the real tail of a running `sleep`+`echo` background command and updates on refresh. Output longer than the screen is truncated, not wrapped off-screen.
  - Width check at 80 columns: descriptions truncate with `…`, right borders aligned.
- **Depends on:** T1.6, T1.4 (view switching).

### T1.8 Release 1.6.0

- **Goal:** Tagged, built, documented release.
- **Files:** `package.json`, `CHANGELOG.md`, `README.md`, `dist/ccmonitor`.
- **Steps:** Follow the CLAUDE.md `upgrade` protocol. CHANGELOG lists F1, F2, F3, the token-count fix with before/after numbers, incremental parsing, fixtures and `bun test`. README adds the Recap and Background panels and the `c`/`b` keys.
- **Verify:**
  - `bun test`, `bun run typecheck`, `bun run build` all green on a clean checkout (`git stash -u` first, or a fresh clone).
  - `./dist/ccmonitor` runs on the current session and shows all three new panels.
  - `git status` clean after commit; `git log -1` message starts `Release v1.6.0`.
- **Depends on:** T1.4, T1.5, T1.7.

---

## 5. Phase 2 — v1.7.0 (Cost, Compaction, Permissions, Hooks, Identity)

### T2.1 Cost line (F4)

- **Files:** `src/parser.ts`, `src/types.ts`, `src/ui.ts`, `src/loaders/globalConfig.ts` (new).
- **Steps:** Store the last `cost-state`. Loader reads `~/.claude.json` → `projects[cwd].lastCost` etc. as fallback tagged `(prev session)`. Header line `Cost:$1.03  API:1m23s  Tools:1.3s  +12/-3  fable:$1.03 haiku:$0.00`. Red when `hasUnknownModelCost`.
- **Verify:**
  - Test on `cost.jsonl`: `cost.totalUSD` equals the sidecar; per-model sum within $0.01 of total.
  - Test loader with a temp `.claude.json` containing one project with `lastCost: 0.25` → fallback returns `0.25` and `isPrevious: true`; with a missing project → `null`.
  - Manual live: the line appears after Claude Code writes `cost-state` (observed at turn ends in 2.1.285+). If the live session shows no line after two turns, confirm with `grep -c cost-state <transcript>`; if 0, the fallback must show `(prev session)`.
- **Depends on:** T1.2.

### T2.2 Exact compaction (F5)

- **Files:** `src/parser.ts`, `src/ui.ts`, `src/loaders/modelCatalog.ts` (new).
- **Steps:** `compactionCount = compactions.length` when any `compact_boundary` exists; keep the 30 percent heuristic only when none exists and `version < 2.1.280`. Header `Compact:2 (manual 535K→14K)`. Model catalog loader reads `~/.claude/cache/model-catalog/*.json`; if a context size is published, use it; else fall back to `getModelContextWindow`.
- **Verify:**
  - Test on `compaction.jsonl`: `compactionCount === 2`, `lastCompaction.preTokens === 534977`.
  - Test: a fixture copy with `version` set to `2.1.200` and no `compact_boundary` but a 50 percent token drop → `compactionCount === 1` (heuristic path). The same file with `version 2.1.296` → `0`.
  - Test the catalog loader with the real cache files copied into a temp dir: returns the model list including `claude-fable-5-1` and `claude-opus-5-5`; with an empty dir → `null` and no throw.
  - Manual: on a session that was compacted (`e1cd2912`), the header shows `Compact:2 (manual 535K→14K)`.
- **Depends on:** T1.2.

### T2.3 Permission strip (F6)

- **Files:** `src/parser.ts`, `src/ui.ts`, `src/index.ts`.
- **Steps:** Track latest `permission-mode`; accumulate `permissionDecision` by `decision` and `reasonType`; keep the last 5 denials with tool name (from the matching `tool_use`), `toolDenialKind`, and the first line of the error text. Header chip `Mode:auto(bash-first)` using `auto_mode.bashFirst`. Line under Tools: `Denied: 1 (hook 1)`. Key `d` toggles the denial list.
- **Verify:**
  - Test on `background.jsonl`: `permissionMode === "auto"`; `decisions.reject === 1`; `denials[0].kind === "permission-rule"`, `denials[0].reason` contains `BLOCKED by scripts/hooks/guard-bash.sh`; `denials[0].tool === "Bash"`.
  - Test: `decisions.byReason.classifier` equals the count of `reasonType: classifier` in the sidecar.
  - Manual live: in a Claude Code session with a `PreToolUse` hook that blocks `git push --force`, ask Claude to force-push; the strip shows `Denied: 1` within 4 s and `d` shows the rule text.
- **Depends on:** T1.2.

### T2.4 Hooks panel (F7)

- **Files:** `src/parser.ts`, `src/ui.ts`, `README.md`.
- **Steps:** Count `hook_success` by `hookEvent` (dynamic keys), track non-zero `exitCode` as errors with `hookName` and `stderr` first line; from `stop_hook_summary` keep `hookErrors`, `preventedContinuation`. Box `Hooks`: `PreToolUse:162 Stop:3 SessionStart:1  errors:0`; red `STOP BLOCKED` when the latest `preventedContinuation` is true. README marks `scripts/on-skill-complete.sh` optional.
- **Verify:**
  - Test on `background.jsonl`: total `hook_success` is 162; `byEvent.PreToolUse + byEvent.Stop + byEvent.SessionStart + byEvent.PostToolUse === 162`.
  - Test: a synthetic `stop_hook_summary` with `preventedContinuation: true` sets `hooks.stopBlocked === true`; the next `turn_duration` resets it to `false`.
  - Test: a `hook_success` with `exitCode: 2` appears in `hooks.errors` with its `hookName`.
  - Manual live: this session has cmux hooks; the panel shows non-zero `PreToolUse` and `Stop` counts and grows with each tool call.
- **Depends on:** T1.2.

### T2.5 Identity and Remote Control (F8)

- **Files:** `src/parser.ts`, `src/types.ts`, `src/ui.ts`, `src/index.ts`.
- **Steps:** Title precedence `custom-title` > `agent-name` > `ai-title`. Show `slug` dim after the session id. Registry: parse `kind`, `entrypoint`, `hostSessionId`, `nameSource`, `statusUpdatedAt`; chip icon `⌨` for cli, `🖥` for desktop; status `unknown` (grey `?`) when `statusUpdatedAt` older than 10 min. `RC●` when the latest `bridge_status` content contains `is active`, `RC○` otherwise. Key `i` opens an info view with the registry fields and all URLs.
- **Verify:**
  - Test on `links.jsonl`: `sessionTitle === "Kotlin 1.9에서 2.4로 마이그레이션 가이드"` (custom wins over ai-title); `slug` non-null.
  - Test on `compaction.jsonl`: `remoteControl.active === true` and `url` set; after appending a synthetic `bridge_status` with content `/remote-control is off`, `active === false`.
  - Test registry parsing on `fixtures/registry/`: 5 sessions; one `entrypoint: claude-desktop`; liveness check is injected and returns false for all → `activeSessions` is empty (the dead-PID filter still works).
  - Manual live: header shows `⌨` for CLI sessions and `🖥` for the Desktop session `Kotlin…`; `i` shows the socket path and version; `Esc` returns.
- **Depends on:** T1.2, T1.4.

### T2.6 Release 1.7.0

- Same procedure and checks as T1.8. CHANGELOG lists F4–F8.
- **Depends on:** T2.1–T2.5.

---

## 6. Phase 3 — v1.8.0 (Links, Queue, Attribution, Errors)

### T3.1 Section-based renderer

- **Goal:** `render()` composes `Section[]`; panels collapse with number keys.
- **Files:** `src/ui.ts`, `src/sections/*.ts` (new), `src/index.ts`, `~/.claude/ccmonitor-ui.json` (runtime).
- **Steps:** Move each box into `Section {id, title, render(state, W): string[], collapsed}`. Keys `1`–`9` toggle collapse; persist to `~/.claude/ccmonitor-ui.json`. Visual output must not change when nothing is collapsed. This is US-007 from the quality PRD.
- **Verify:**
  - Golden test: render `recap-basic.jsonl` with a fixed clock, width 100, before and after the refactor; strip ANSI; the outputs are byte-identical. Store the golden file in `fixtures/golden/recap-basic.100.txt`.
  - Test: `render` with `sections[2].collapsed = true` omits that box and the header count of lines drops by that box's height.
  - Manual: press `3`, restart the monitor, the same panel is still collapsed; delete `~/.claude/ccmonitor-ui.json`, all panels return.
- **Depends on:** T1.8.

### T3.2 Links panel (F9)

- **Files:** `src/parser.ts`, `src/sections/links.ts`, `src/loaders/plans.ts`, `src/loaders/feedback.ts`.
- **Steps:** Dedupe `pr-link` by `prRepository+prNumber` (latest wins); keep the last 3 `frame-link`; plan path = `settings.plansDirectory ?? ~/.claude/plans` + `/<slug>.md`, show size if it exists; feedback drafts where `source_session_id === sessionId`. URLs only in the `i` view.
- **Verify:**
  - Test on `links.jsonl`: `links.prs.length === 1`, `prs[0].number === 158`, `repository === "bizmatrixx/bzflow"`; `artifacts[0].title === "Kotlin 1.9 → 2.4"`.
  - Test plan loader with a temp dir containing `<slug>.md` → returns path and size; without the file → `null`; with `plansDirectory` set in a temp settings file → uses that dir.
  - Test feedback loader with the real draft copied to a temp dir and `source_session_id` rewritten → returns 1 item with `title` starting `Suggested`; with a different session id → `[]`.
  - Manual: run on the clavis session `6fa4d51c-7303-4855-978b-e9e5d536b09f`; the panel shows `Plan clavis-link-robust-tide.md (12 KB)`.
- **Depends on:** T3.1.

### T3.3 Prompt queue (F10)

- **Files:** `src/parser.ts`, `src/sections/lastPrompt.ts`.
- **Steps:** Depth = enqueue − dequeue − remove, floor 0, reset on each human prompt delivery with `promptSource: queued`. Preview from the latest `queued_command.prompt` that is not a `<task-notification>`. Chip `Queue:N` in the header; preview as the Last Prompt box footer.
- **Verify:**
  - Test on `background.jsonl`: final depth equals enqueue − dequeue − remove from the sidecar (20 ops in total); never negative at any point (assert while streaming).
  - Test: a synthetic sequence `enqueue, enqueue, dequeue` → depth 1 and preview equals the second prompt.
  - Manual live: while Claude is busy, type two prompts; the chip shows `Queue:2`, then `1`, then disappears as each one is delivered.
- **Depends on:** T3.1.

### T3.4 Attribution and MCP (F11)

- **Files:** `src/parser.ts`, `src/sections/skills.ts`, `src/sections/mcp.ts` (new), `src/ui.ts`.
- **Steps:** Per grouped assistant message, read `attributionSkill`, `attributionPlugin`, `attributionMcpServer`; count `server_tool_use` blocks named `advisor`; average `thinkingDurationMs`; detect `usage.speed === "fast"`. MCP box counts tool names `mcp__<server>__*` plus attribution. Skills box gains an `attributed` column and drops the `end_turn` completion heuristic (keep the hook-state loader as an optional fast path). Header: `Advisor:opus-5-5 ×12  Think:4.9s  Fast`.
- **Verify:**
  - Test on `background.jsonl`: `attribution.skills["ego-browser"]` ≥ 1 if present in the sidecar (record the number); `mcp.servers` keys match the distinct `mcp__<server>` prefixes in the sidecar.
  - Test: a synthetic message with `server_tool_use` named `advisor` increments `advisorCalls` by 1 and `advisorModel` is read from the entry.
  - Test: `thinkingAvgMs` equals the mean of `thinkingDurationMs` over distinct message ids (not lines).
  - Manual live: use a skill in a Claude Code session (`/simplify`); the Skills box shows the skill with `attributed: N` growing while it runs.
- **Depends on:** T3.1.

### T3.5 Error strip (F12)

- **Files:** `src/parser.ts`, `src/sections/errors.ts`.
- **Steps:** Collect `isApiErrorMessage` (status, code, first 80 chars of text), `interruptedMessageId` count, `isAbortedMidStream`. Show one red line when the last 3 turns contain any. Otherwise render nothing (zero lines).
- **Verify:**
  - Test on `errors.jsonl`: `errors.api.length === 1`, text starts `Your organization has disabled`; `model === "<synthetic>"` must not become `state.model` (assert `state.model` is still the real model).
  - Test: a user entry `[Request interrupted by user]` with `interruptedMessageId` → `errors.interrupts === 1`.
  - Golden test: `recap-basic.jsonl` renders zero error lines (compare with the golden file from T3.1).
- **Depends on:** T3.1.

### T3.6 Release 1.8.0

- Same procedure as T1.8. CHANGELOG lists F9–F12 and the Section refactor.
- **Depends on:** T3.2–T3.5.

---

## 7. Phase 4 — v1.9.0 (Sessions, Files, Updates)

### T4.1 Session picker (F13)

- **Files:** `src/index.ts`, `src/views/sessions.ts` (new), `src/loaders/history.ts` (new).
- **Steps:** `s` opens a list: name, cwd basename, status dot, version, entrypoint icon, age, last prompt preview from `history.jsonl` (match on `sessionId`). `j`/`k`/`Enter`/`Esc`. `n` keeps cycling.
- **Verify:**
  - Test history loader on a temp `history.jsonl` with 3 lines → returns the last prompt per `sessionId`; malformed line is skipped without throw.
  - Test: picker rows are sorted by `updatedAt` desc; the current session is marked.
  - Manual live: open the picker with 5 live sessions; select the Desktop one; the dashboard switches and `r` returns to the cwd default.
- **Depends on:** T2.5, T3.1.

### T4.2 File activity upgrade (F14)

- **Files:** `src/parser.ts`, `src/sections/files.ts`.
- **Steps:** Build `editedFiles: Map<path, {version, lastEdit}>` from `file-history-delta` and `toolUseResult.filePath` (Write/Edit); mark external edits from `edited_text_file`. Render `path  v3  13:31` sorted by `lastEdit`; chokidar events for `~/.claude` go to a dim sub-list.
- **Verify:**
  - Test on `background.jsonl`: `editedFiles.size` equals the number of distinct `trackingPath` in the sidecar; a path with 2 deltas has `version === 2`.
  - Test: `editedFilesCount` (from `file-history/`) and `editedFiles.size` are both reported; when they differ, the UI shows the larger with `~`.
  - Manual live: edit one file through Claude Code; the row appears with `v1`, then `v2` after a second edit.
- **Depends on:** T3.1.

### T4.3 Update awareness (F15)

- **Files:** `src/loaders/update.ts` (new), `src/views/info.ts`.
- **Steps:** Read `.last-update-result.json`; if `version_to` is newer than the running session's `version`, show `update available` dim in the header. In the `i` view, list the first 5 bullets under the newest `## x.y.z` heading of `cache/changelog.md`.
- **Verify:**
  - Test: version compare `2.1.296 > 2.1.295`, `2.1.300 > 2.1.296`, `2.2.0 > 2.1.999`.
  - Test changelog parser on the real cached file copied to a temp dir → first heading is a version string, 5 bullets returned, none empty.
  - Manual: temporarily edit a copy of `.last-update-result.json` (via an env override `CCMONITOR_UPDATE_FILE`) to `version_to: 9.9.9`; the header shows `update available`.
- **Depends on:** T2.5.

### T4.4 Release 1.9.0

- Same procedure as T1.8. CHANGELOG lists F13–F15 (and F16 only if fixtures were found).
- **Depends on:** T4.1–T4.3.

---

## 8. Cross-cutting checks (run before every release)

| Check | Command | Pass condition |
|---|---|---|
| Unit tests | `bun test` | 0 failures |
| Types | `bun run typecheck` | 0 errors |
| Build | `bun run build && ./dist/ccmonitor --fixture fixtures/recap-basic.jsonl` | renders, `q` exits 0 |
| Golden render | `bun test src/ui.test.ts` | golden files unchanged, or diffs reviewed and the golden regenerated on purpose |
| Width sweep | run with `COLUMNS=80`, `100`, `140` on `recap-basic.jsonl` | every line ≤ width, right borders aligned |
| Privacy | `grep -rn -E 'prompt_snapshot|credential_org|authToken|encrypted_content' src/ui.ts src/sections` | no renderer reads these fields |
| Idle CPU | run on a live idle session for 2 minutes, `top -pid` | under 5 percent average |
| Unknown fields | `cat ~/.claude/ccmonitor-unknown-fields.log` after a 10-minute live run | no new kinds, or each new kind filed as a follow-up |
| Fixtures scrubbed | `grep -c tobylee fixtures/*.jsonl` | all 0 |

---

## 9. Order of work and estimates

| Order | Task | Size | Blocks |
|---|---|---|---|
| 1 | T0.1, T0.2 | S | everything |
| 2 | T0.3 fixtures | M | all tests |
| 3 | T0.4 pure parser | M | T0.5+ |
| 4 | T0.5 message-id grouping | S | F1 |
| 5 | T0.6 incremental parsing | M | release 1.6 |
| 6 | T0.7 unknown-field log | S | — |
| 7 | T1.1 → T1.3 | M | T1.4 |
| 8 | T1.4 Recap panel | M | release 1.6 |
| 9 | T1.5 turns | S | T1.6 |
| 10 | T1.6, T1.7 background | M | release 1.6 |
| 11 | T1.8 release 1.6.0 | S | phase 2 |
| 12–17 | T2.1 → T2.6 | S each | release 1.7 |
| 18 | T3.1 Section refactor | M | phase 3 |
| 19–24 | T3.2 → T3.6 | S each | release 1.8 |
| 25–28 | T4.1 → T4.4 | S/M | release 1.9 |

S = under half a session, M = one session. Phase 0 and Phase 1 together are about 4 sessions.

---

## 10. Definition of done (per task)

1. Every item in the task's **Verify** block passed, and the command outputs were pasted into the PR or commit message.
2. `bun test`, `bun run typecheck`, `bun run build` are green.
3. New parser fields have a default in `parseTranscript` and render `—` when absent.
4. No new field from Appendix B of the spec is rendered.
5. If the task changed visible output, the golden file was regenerated on purpose and the diff was read.
