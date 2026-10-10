# ccmonitor v2 — Verification Record

**Date:** 2026-10-10
**Plan:** `docs/implementation-plan-v2.md` (31 tasks, T0.1–T4.4)
**Releases:** v1.6.0 `7b7cbe7`, v1.7.0 `948c1d5`, v1.8.0 `0aabe88`, v1.9.0 `27c8697`, v1.9.1 `dae0aa8` (Phase 0 foundation: `43d8a78`)
**Machine:** macOS, Bun 1.4.2, Claude Code 2.1.296

This file records how each task's **Verify** block was satisfied, with the command outputs from the final run. Re-run everything with the commands in section 2.

---

## 1. Per-task verification

| Task | Verify block | Evidence |
|---|---|---|
| T0.1 tsconfig/typecheck | `bun run typecheck` exit 0; build | `tsc --noEmit` clean (section 2); `dist/ccmonitor` built; `./dist/ccmonitor --help` exits 0 |
| T0.2 test runner | `bun test` green; break/restore | 104 tests, 0 fail (section 2). Break check: the golden test failed on the 1.8.0 version bump and on the T3.x panel additions, then went green after deliberate regeneration (`835937a`) |
| T0.3 fixtures + `--fixture` | greps 0; renders; smoke tests; review | `grep -c tobylee fixtures/*` total 0; banned fields 0; `./dist/ccmonitor --fixture fixtures/recap-basic.jsonl` renders the Recap box and `q` exits 0 under `expect`; `src/fixtures.test.ts` smoke test per fixture vs `.expect.json`; scrubber tightened after review (agent prompts, queue hand-backs, e-mails removed) |
| T0.4 pure parser split | tests; no fs/clock in parse; same header numbers | `parseTranscriptLines` tests on `recap-basic` (`messageCount`, model); `src/entry.ts` imports no `fs`; before/after comparison on the live session: all header fields identical except the intended T0.5 counts |
| T0.5 message-id grouping | multiblock test; A/O drop, U same | `multiblock` test: assistant count = distinct ids, output = sum over ids, `msg_011Cfsr7dZN5HMtVDQ5LsjEE` grouped text non-empty. Live session: A 93 → 30, O 408.7K → 95.2K, U 61 unchanged (CHANGELOG 1.6.0) |
| T0.6 incremental parsing | halves deep-equal; truncate ⇒ `fullReparse`; <50 ms; idle CPU | Tests: split mid-line, truncate, rewritten head. Bench on the 8.1 MB transcript: full 19.4 ms, +10 lines 0.2 ms. Idle CPU of the binary over 28 s: 0.1–0.9 % |
| T0.7 unknown-field logger | once per value; no known kinds logged | Test: `made-up-type` reported once for two lines. Sweep over the 40 newest transcripts: `{}` after adding `goal_status`, `worktree-state`, `thinking_drop`, `plan_mode`, `plan_mode_exit` to the known sets |
| T1.1 types | typecheck; one object per interface | `tsc` clean; every new interface is constructed in `src/state.ts` defaults and in tests |
| T1.2 system/attachment routing | recap-basic, compaction, background facts | Tests: `nativeRecap` prefix + time `03:34:37.339Z`, suffix stripped; `compactions[0]` 534977→13769 manual; RC url; `scratchpadDir` ends with `/253aaf04-…/scratchpad` |
| T1.3 recap extraction | finalReply, koreanRecap (3 lines), turnOpen, narration, mdToPlain, recaps disabled | All asserted in `src/parser.test.ts` and `src/fixtures.test.ts` (`recap-basic`, `turn-open`, synthetic) |
| T1.4 Recap panel + `c` | fixture renders; widths 80/100/140; live `now:`; keys | Width sweep test over every fixture and view; `turn-open` yellow title + `now: Rewritten prompt:`; live session showed `now:` with this session's narration; `c`/Esc/`j`/`k` verified under `expect` (section 3) |
| T1.5 turns | background turns; turn-open; task_notification origin; live counter | Tests: human turns = sidecar `humanPrompts`, `pendingBackgroundAgents === 2`, queued ⇒ human, task_notification keeps Last Prompt; live header `Turn:#1 ⏱ 36m23s (open) tools:99` |
| T1.6 background parsing + loader | ids/description/model; notification parser; temp-dir loader; live flip | Tests: 2 agents + 5 bash ids, `Review the email capture slice`, `claude-fable-5-1`, exit codes; loader temp dir `[exited with code 3]`; **live:** a `run_in_background` Bash and an Agent launched from this session flipped ● → ✓ (`exit 0 29s`, `done 12s haiku-5-5`) |
| T1.7 Background panel + `b` | 7 rows; `N running`; `b` tail; 80 cols | Render test: rows = tasks, title `0 running` for the fixture; `b` view and scrolling verified under `expect` (section 3); width sweep |
| T1.8 release 1.6.0 | checks green; binary shows panels; clean tree | `7b7cbe7`; binary run on the live session showed Turn line, Recap, Background |
| T2.1 cost | cost fixture; temp `.claude.json`; live/fallback | Tests: per-model sum within $0.01; fallback 0.25 `isPrevious`, missing ⇒ null. Live: `Cost:$13.70 … (prev session)` |
| T2.2 compaction | exact 2; heuristic only <2.1.280; catalog loader | Tests: `compactionCount` 2 / heuristic 1 for 2.1.200 / 0 for 2.1.296; catalog temp dir + real cache; header `Compact:2 (manual 500.4K→12.1K)` |
| T2.3 permissions | background denial facts; classifier count; live `Denied` | Tests: mode `auto`, reject 1, `permission-rule`, `Bash`, rule text, classifier count = sidecar. **Live:** this session's two classifier blocks plus a temporary PreToolUse hook (installed with the user's consent, removed afterwards) ⇒ `Denied:3 (classifier 2, hook 1)` with the `d` rows |
| T2.4 hooks | 162 total; byEvent sum; stopBlocked; exitCode 2 | Tests against the sidecar's `hook_success` total and per-event counts; synthetic `preventedContinuation` set/reset; exit 2 error row. Live: `PreToolUse:191 Stop:16 SessionStart:1` |
| T2.5 identity / RC | links title; RC on/off; registry fixture; live icons | Tests: custom title wins, `entrypoint claude-desktop`; RC active then `/remote-control is off` ⇒ false; registry fixture 6 entries, dead-PID filter. **Live:** Desktop session header `Session:🖥 7fe32363 …`, `i` view shows kind, host session, socket |
| T2.6 release 1.7.0 | as T1.8 | `948c1d5` |
| T3.1 sections | golden byte-identical; collapsed drops height; persisted | `fixtures/golden/*.100.txt` matched after the refactor and before new panels; collapse test (Tools box omitted, line count drops by its height, `hidden:3`); prefs round-trip test; `3`/`3` under `expect` writes and clears `~/.claude/ccmonitor-ui.json` |
| T3.2 links | links fixture; plan loader; feedback loader; clavis plan | Tests: PR #158 deduped, artifact title; plan temp dir + `plansDirectory`; drafts filter + malformed skip. Real: `loadPlanFile('clavis-link-robust-tide')` ⇒ 12102 bytes |
| T3.3 queue | depth never negative; enqueue/enqueue/dequeue ⇒ 1 | Streaming test `[0,1,2,1]`, preview = second prompt, drain ⇒ null; chip + footer render test |
| T3.4 attribution / MCP | skills counts; mcp keys; advisor; thinking avg | Tests: `ego-browser` = sidecar, MCP spellings merged (`Gmail ×2`), advisor `server_tool_use`, thinking mean per id, `Fast` |
| T3.5 errors | errors fixture; interrupt; golden zero lines | Tests: 1 API error `403 oauth_not_allowed…`, model not `<synthetic>`; interrupt counted with time; `recap-basic` renders zero strips |
| T3.6 release 1.8.0 | as T1.8 | `0aabe88` (+ `835937a` golden version mask) |
| T4.1 session picker | history loader; rows sorted; live switch | Tests: last prompt per session, malformed skipped, tail read; rows sorted by `updatedAt`, current marked; live picker rendered 7 sessions with prompts; `s`/Esc under `expect` |
| T4.2 file activity | editedFiles vs trackingPath; `~` count; live v1/v2 | Tests: relative + absolute paths share one key, versions/external merge; render `src/a.kt v2`; `Files:~2`. Live: duplicate rows gone after normalisation (36 files) |
| T4.3 update awareness | version compare; changelog parser; `CCMONITOR_UPDATE_FILE` 9.9.9 | Tests pass; real changelog parsed (2.1.296, 5 bullets). Live: override ⇒ `CC:v2.1.296 update available (9.9.9)` and the `i` section; real file ⇒ `available:false` |
| T4.4 release 1.9.0 | as T1.8 | `27c8697`; `dae0aa8` (v1.9.1 burst-key fix found by the pty probe) |

**Not implemented by decision:** F16 (no fixture on this machine). **Decisions confirmed by the user on 2026-10-10:** keep the `end_turn` skill-completion heuristic; leave F16 out; hide the Links box when empty; a temporary hook in local settings is acceptable for verification when removed afterwards.

---

## 2. Cross-cutting checks (plan §8) — final run

```
## bun test
 104 pass
 0 fail
Ran 104 tests across 4 files. [143.00ms]

## bun run typecheck
$ tsc --noEmit            (no errors)

## bun run build
 [174ms] compile  dist/ccmonitor
62392050 bytes

## binary renders a fixture and q exits 0 (expect, pty 100x24)
rendered Recap box
exit code: 0

## privacy: renderers must not read these fields
none

## fixtures scrubbed (login name occurrences)
total: 0
banned fields total: 0

## bench (8 MB transcript)
full parse (in-memory):   19.4 ms  (8.0 MB)
full parse (reader):      17.4 ms
incremental (+10 lines): 0.2 ms  fullReparse=false bytes=9710
no-op refresh:            0.0 ms

## unknown-field sweep over 40 recent transcripts
parsed 40 transcripts in 257 ms
{}

## idle CPU of ./dist/ccmonitor on a live session (ps %cpu, 6 samples over 28 s)
0.9 0.3 0.1 0.2 0.3 0.5
```

Golden renders (`fixtures/golden/*.100.txt`) and the width sweep (80/100/140 columns, every fixture, every view) run inside `bun test`.

---

## 3. Pseudo-terminal key probe (expect, 100×24)

Final run against `fixtures/background.jsonl`, 0 failures:

```
OK   b background view indicator [1-21/28]
OK   j scroll +1
OK   k scroll -1
OK   space page down → [8-
OK   PageUp key → [1-
OK   Down arrow → [2-
OK   Up arrow → [1-
OK   burst jj → [3-
OK   Esc → dashboard
OK   burst bj → [2-
OK   q quits
exit code: 0   failures: 0
```

Earlier run covering the other keys (same session): `c` → Final reply, Esc → dashboard, `b` → task rows, `i` → Remote Control section, `d` → `permission-rule` rows, `3` → `hidden:3` then Tools back, `s` → sessions view. This probe found the burst-input bug (several keys in one stdin chunk were dropped), fixed in v1.9.1.

Probe notes: match on text that is contiguous in the raw ANSI stream (a task id, a section title), not on footer labels, which are split by colour codes; set the pty size with `stty rows/columns` or scrolling never engages.

---

## 4. Live checks on this machine

| Check | Result |
|---|---|
| Background flip | `● bash … 18s` → `✓ bash … exit 0 29s`; `✓ agent general-purpose … done 12s haiku-5-5` |
| Hook-rule denial | `Denied:3 (classifier 2, hook 1)`; row `✗ 15:27:50 Bash permission-rule BLOCKED by deny-probe-hook.sh: ccmonitor denial probe` |
| Desktop session | `Session:🖥 7fe32363`, title `Kotlin 1.9에서 2.4로 마이그레이션 가이드`, `i` view: kind interactive, host session `local_…`, socket `/tmp/cc-socks/50424.sock` |
| Update awareness | override 9.9.9 ⇒ `update available (9.9.9)`; real file ⇒ none |
| Recap `now:` | this session's own mid-turn narration appeared in the Recap box while the turn was open |
