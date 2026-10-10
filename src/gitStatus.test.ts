import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseGitStatus, loadGitStatus, refreshGitStatus, clearGitStatusCache, GIT_STATUS_TTL_MS } from './loaders/gitStatus.js';

describe('parseGitStatus', () => {
  const z = (...recs: string[]): string => recs.join('\0') + '\0';

  test('classifies every porcelain code', () => {
    const g = parseGitStatus(z('?? new.ts', 'A  staged.ts', 'AM staged-then-edited.ts', ' M wt.ts', 'M  idx.ts', 'MM both.ts', 'T  type.ts', 'UU conflict.ts', ' D gone.ts', 'D  rm.ts', 'AD added-then-deleted.ts'));
    expect(g.files.map(f => f.kind)).toEqual(['added', 'added', 'added', 'modified', 'modified', 'modified', 'modified', 'modified', 'deleted', 'deleted', 'deleted']);
    expect(g).toMatchObject({ added: 3, modified: 5, deleted: 3 });
    expect(g.files[0]).toEqual({ code: '??', path: 'new.ts', kind: 'added' });
  });

  test('renames and copies consume the old path; paths may contain spaces', () => {
    const g = parseGitStatus(z('R  new name.ts', 'old name.ts', 'C  copy.ts', 'orig.ts', ' M a b/c d.ts'));
    expect(g.files.map(f => f.path)).toEqual(['new name.ts', 'copy.ts', 'a b/c d.ts']);
    expect(g).toMatchObject({ added: 0, modified: 3, deleted: 0 });
  });

  test('empty output is clean; ignored entries are skipped', () => {
    expect(parseGitStatus('')).toEqual({ added: 0, modified: 0, deleted: 0, files: [] });
    expect(parseGitStatus(z('!! build/')).files).toEqual([]);
  });
});

describe('loadGitStatus', () => {
  let repo = '';
  let plain = '';
  const git = (...args: string[]): void => {
    const r = Bun.spawnSync({ cmd: ['git', '-C', repo, ...args], stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ccmon-git-'));
    plain = mkdtempSync(join(tmpdir(), 'ccmon-plain-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'kept.ts'), 'a\n');
    writeFileSync(join(repo, 'edit.ts'), 'b\n');
    writeFileSync(join(repo, 'gone.ts'), 'c\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'edit.ts'), 'changed\n');
    unlinkSync(join(repo, 'gone.ts'));
    writeFileSync(join(repo, 'brand-new.ts'), 'd\n');
    clearGitStatusCache();
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
    clearGitStatusCache();
  });

  test('counts new, modified and deleted files in a temporary repository', () => {
    const g = loadGitStatus(repo, 1_000);
    expect(g).toMatchObject({ added: 1, modified: 1, deleted: 1 });
    expect(g?.files.map(f => f.path).sort()).toEqual(['brand-new.ts', 'edit.ts', 'gone.ts']);
  });

  test('a directory outside any repository gives null', () => {
    expect(loadGitStatus(plain, 1_000)).toBeNull();
  });

  test('the cached value is returned inside the TTL and refreshed after it', async () => {
    writeFileSync(join(repo, 'second-new.ts'), 'e\n');
    expect(loadGitStatus(repo, 1_000 + GIT_STATUS_TTL_MS - 1)?.added).toBe(1); // still cached
    expect((await refreshGitStatus(repo))?.added).toBe(2);
    expect(loadGitStatus(repo, Date.now())?.added).toBe(2);
    // stale call: returns the old value and starts one background refresh
    unlinkSync(join(repo, 'second-new.ts'));
    const stale = loadGitStatus(repo, Date.now() + GIT_STATUS_TTL_MS + 1);
    expect(stale?.added).toBe(2);
    for (let i = 0; i < 50 && loadGitStatus(repo, Date.now())?.added !== 1; i++) await Bun.sleep(20);
    expect(loadGitStatus(repo, Date.now())?.added).toBe(1);
  });
});
