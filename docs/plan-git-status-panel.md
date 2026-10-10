# Git Status panel — Implementation Plan

**Status:** Done (v1.10.0, 2026-10-10)
**Date:** 2026-10-10
**Request:** Replace the File Activity box at the bottom of the dashboard with a box that shows how many files are new, modified and deleted according to `git status` of the session's cwd.

---

## 0. 요약 (Korean summary)

- 대시보드 맨 아래 **File Activity** 박스를 **Git Status** 박스로 바꾼다. 세션 cwd에서 `git status --porcelain`을 읽어 **신규 / 수정 / 삭제 파일 수**와 파일 목록(최대 8줄)을 보여준다.
- File Activity 박스만 쓰던 chokidar 감시자와 이벤트 버퍼는 제거한다 (2초 갱신 루프가 이미 모든 패널을 새로 그린다). 헤더의 `Files:N` 카운터(세션이 편집한 파일 수)는 그대로 둔다.
- `git status`는 5초마다 한 번만 실행한다. 첫 호출은 동기, 그 뒤는 비동기(키 입력이 막히지 않게). 저장소가 아니면 `(not a git repository)`.
- 검증: 순수 파서 단위 테스트, 임시 git 저장소로 로더 테스트, 80/100/140 폭 렌더 테스트, golden 재생성 후 diff 확인, 빌드한 바이너리를 이 저장소에서 실행해 실제 숫자 확인.

---

## 1. Tasks

### T1 — Loader `src/loaders/gitStatus.ts`

**Goal:** A pure parser for porcelain output and a cached loader that never blocks the TUI for long.

**Files:** `src/loaders/gitStatus.ts` (new), `src/types.ts` (`GitStatusInfo`, `GitStatusFile`, `SessionState.gitStatus`), `src/state.ts` (default `null`), `src/parser.ts` (call in `enrichSessionState`, skipped with `skipLive`).

**Steps:**
1. `parseGitStatus(text)` reads `git status --porcelain=v1 -z` output. Rules per `XY` code: `??` → new; `A` in the index → new; `D` in either column → deleted; everything else (`M`, `T`, `R`, `C`, `U`) → modified. A rename/copy entry consumes the extra `\0`-separated old path.
2. `loadGitStatus(cwd, nowMs)` runs `git -C <cwd> --no-optional-locks status --porcelain=v1 -z -uall`. The result is cached per cwd for 5 s. The first call is synchronous (2 s timeout); later refreshes run asynchronously and replace the cached value when they finish. A non-zero exit (not a repository, git missing) caches `null` for 30 s.
3. `refreshGitStatus(cwd)` is exported so tests can await a refresh.

**Verify:**
- Unit tests for every code class, renames, quoted paths, an empty tree (`clean`).
- Loader test on a temporary repository created with `git init`: one new, one modified, one deleted file give `1/1/1`; a non-repository directory gives `null`.
- `bun run typecheck` exit 0.

### T2 — Panel `Git Status` (key `0`)

**Goal:** The last dashboard box shows counts and the first files.

**Files:** `src/ui.ts` (`sectionGit` replaces `sectionFiles`; `SECTIONS` id `git`), `src/ui.test.ts`.

**Steps:**
1. Title `Git Status`. First row: `+N new  ~N modified  -N deleted` in green / yellow / red; `clean` when all are zero; `(not a git repository)` when the loader returned `null`.
2. Then up to 8 rows `XY path` in git order, coloured by class, paths cwd-relative, truncated to the width. A final dim row `… N more` when truncated.
3. Remove `fileEvents` from `SectionCtx`, `renderDashboardLines` and `render`.

**Verify:**
- Render test: counts row, file rows, the `… N more` row, `clean`, `null`.
- Width sweep (80/100/140) still passes for every fixture.
- Golden files regenerated with `TZ=UTC bun run scripts/update-golden.ts`; the diff shows only the File Activity box replaced by the Git Status box.

### T3 — Remove the watcher

**Goal:** No code is left that only fed the old box.

**Files:** `src/index.ts` (chokidar import, `fileEvents`, `addFileEvent`, watcher setup/close), `package.json` (drop `chokidar`), `bun.lock`.

**Verify:** `grep -rn chokidar src package.json` prints nothing; `bun run build` succeeds; the binary still refreshes every 2 s.

### T4 — Docs and release 1.10.0

**Files:** `README.md` (screenshot block, panel table, keyboard list, How It Works, remove Watched File Paths), `CLAUDE.md` (architecture, loader list), `CHANGELOG.md`, `package.json` version.

**Verify:** `bun test` and `bun run typecheck` exit 0; `bun run build`; the binary run in this repository shows the real `git status` counts; `bun run install:global`; commit and push.

---

## 2. Verification record (2026-10-10)

| Task | Evidence |
|---|---|
| T1 | `src/gitStatus.test.ts`: every porcelain code class, renames/copies, spaces, empty output; temporary `git init` repository gives `1/1/1`; non-repository gives `null`; TTL cache returns the old value then refreshes in the background. `tsc --noEmit` clean. |
| T2 | `src/ui.test.ts` "git status box": summary row, `??`/`A `/` D` rows, `… 5 more`, `clean`, `(not a git repository)`; width sweep 80/100/140. Golden diff: only the File Activity box replaced by the Git Status box (3 files). |
| T3 | `grep -rn chokidar src package.json` empty; `bun install` removed 1 package; `bun run build` ok. |
| T4 | Binary run in this repository under `expect` (pty 100×60) showed `+3 new  ~13 modified  -0 deleted` and the first 8 ` M` rows, matching `git status --short` (3 untracked, 13 modified). `bun test` 110 pass, `tsc` clean; the golden mask now also collapses the title-bar padding (v1.10.0 is one character longer than v1.9.1). |
