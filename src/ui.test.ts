import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseTranscriptLines, computeDerived } from './parser.js';
import {
  displayWidth, wordWrap, stripAnsi, truncateToWidth, formatDurationCompact,
  renderDashboardLines, renderRecapViewLines, renderBackgroundViewLines, renderInfoViewLines, statusDot, entrypointIcon,
} from './ui.js';
import type { SessionState } from './types.js';

const FIX = join(import.meta.dir, '..', 'fixtures');
const NOW = new Date('2026-10-10T05:00:00.000Z');

function loadState(name: string): SessionState {
  const file = join(FIX, `${name}.jsonl`);
  const s = parseTranscriptLines(readFileSync(file, 'utf-8').split('\n'), { sessionId: name, projectDir: FIX, transcriptFile: file });
  computeDerived(s);
  return s;
}

describe('displayWidth', () => {
  test('ASCII, Hangul, CJK, emoji, ANSI', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('한글')).toBe(4);
    expect(displayWidth('漢字')).toBe(4);
    expect(displayWidth('ᄀ')).toBe(2);
    expect(displayWidth('ᅟ')).toBe(2);
    expect(displayWidth('⺀')).toBe(2);
    expect(displayWidth('｠')).toBe(2);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('\x1b[31mred\x1b[0m')).toBe(3);
  });
});

describe('wordWrap', () => {
  test('breaks on spaces, hard newlines, long tokens and CJK', () => {
    expect(wordWrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wordWrap('a\n\nb', 10)).toEqual(['a', '', 'b']);
    expect(wordWrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wordWrap('한글한글한글', 4)).toEqual(['한글', '한글', '한글']);
  });

  test('truncateToWidth reserves one column for the ellipsis', () => {
    expect(truncateToWidth('abcdef', 4)).toBe('abc…');
    expect(truncateToWidth('한글한글', 5)).toBe('한글…');
    expect(truncateToWidth('ab', 4)).toBe('ab');
  });

  test('formatDurationCompact', () => {
    expect(formatDurationCompact(12_000)).toBe('12s');
    expect(formatDurationCompact(242_000)).toBe('4m02s');
    expect(formatDurationCompact(3_840_000)).toBe('1h04m');
  });
});

/** Every line must fit the width; box lines must end exactly at the width. */
function assertFits(lines: string[], W: number, label: string): void {
  for (const line of lines) {
    const plain = stripAnsi(line);
    const w = displayWidth(plain);
    expect(w, `${label} W=${W}: "${plain}"`).toBeLessThanOrEqual(W);
    if (/^[│┌└]/.test(plain)) {
      expect(w, `${label} W=${W} border: "${plain}"`).toBe(W);
      expect(/[│┐┘]$/.test(plain), `${label} W=${W} right border: "${plain}"`).toBe(true);
    }
  }
}

describe.skipIf(!existsSync(FIX))('width sweep over fixtures', () => {
  const names = existsSync(FIX) ? readdirSync(FIX).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')) : [];
  for (const name of names) {
    for (const W of [80, 100, 140]) {
      test(`${name} at ${W} columns`, () => {
        const s = loadState(name);
        assertFits(renderDashboardLines(s, [], { now: NOW, width: W }), W, name);
        assertFits(renderRecapViewLines(s, { now: NOW, width: W, height: 40 }), W, `${name} recap view`);
        assertFits(renderBackgroundViewLines(s, { now: NOW, width: W, height: 40 }), W, `${name} background view`);
        assertFits(renderInfoViewLines(s, { now: NOW, width: W, height: 40 }), W, `${name} info view`);
        assertFits(renderDashboardLines(s, [], { now: NOW, width: W, showDenials: true }), W, `${name} denials`);
      });
    }
  }
});

describe.skipIf(!existsSync(join(FIX, 'recap-basic.jsonl')))('recap panel content', () => {
  test('recap-basic shows CC line, final reply divider and three Korean lines', () => {
    const s = loadState('recap-basic');
    const plain = renderDashboardLines(s, [], { now: NOW, width: 100 }).map(stripAnsi);
    const start = plain.findIndex(l => l.startsWith('┌─ Recap'));
    expect(start).toBeGreaterThan(0);
    const box = plain.slice(start, plain.findIndex((l, i) => i > start && l.startsWith('└')) + 1);
    expect(box.some(l => l.includes('CC: You asked for a pre-PR sync'))).toBe(true);
    expect(box.some(l => l.includes('── Final reply'))).toBe(true);
    expect(box.filter(l => l.startsWith('│ - ')).length).toBeGreaterThanOrEqual(3);
    expect(box.some(l => l.includes('main에서 바로 커밋하지 않고'))).toBe(true);
    expect(plain.some(l => l.startsWith(' Turn:#') && l.includes('done'))).toBe(true);
  });

  test('turn-open shows the yellow open title and the now: line', () => {
    const s = loadState('turn-open');
    const lines = renderDashboardLines(s, [], { now: NOW, width: 100 });
    const plain = lines.map(stripAnsi);
    const titleIdx = plain.findIndex(l => l.startsWith('┌─ Recap  (turn open)'));
    expect(titleIdx).toBeGreaterThan(0);
    expect(lines[titleIdx]).toContain('\x1b[33m');
    expect(plain[titleIdx + 1]?.startsWith('│ now: Rewritten prompt:')).toBe(true);
    expect(plain.some(l => l.startsWith(' Turn:#') && l.includes('(open)'))).toBe(true);
  });

  test('background box replaces subagents and counts running tasks', () => {
    const s = loadState('background');
    const plain = renderDashboardLines(s, [], { now: NOW, width: 100 }).map(stripAnsi);
    const title = plain.find(l => l.startsWith('┌─ Background'));
    expect(title).toBeDefined();
    const running = [...s.backgroundTasks.values()].filter(t => t.status === 'running').length;
    expect(title).toContain(`${running} running`);
    expect(plain.some(l => l.startsWith('┌─ Subagents'))).toBe(false);
    const rows = plain.filter(l => /^│ [●✓✗] (agent|bash)/.test(l));
    expect(rows.length).toBe(Math.min(8, s.backgroundTasks.size));
  });

  test('recap view scrolls and clamps', () => {
    const s = loadState('recap-basic');
    const top = renderRecapViewLines(s, { now: NOW, width: 100, height: 12, scroll: 0 }).map(stripAnsi);
    const down = renderRecapViewLines(s, { now: NOW, width: 100, height: 12, scroll: 3 }).map(stripAnsi);
    const far = renderRecapViewLines(s, { now: NOW, width: 100, height: 12, scroll: 999 }).map(stripAnsi);
    expect(top).toHaveLength(12);
    expect(down[2]).toBe(top[5]);
    expect(far[far.length - 1]).toMatch(/\[\d+-\d+\/\d+\]$/);
  });
});

describe.skipIf(!existsSync(join(FIX, 'background.jsonl')))('phase 2 panels', () => {
  test('cost fixture renders the Cost line with per-model parts', () => {
    const s = loadState('cost');
    const plain = renderDashboardLines(s, [], { now: NOW, width: 100 }).map(stripAnsi);
    const line = plain.find(l => l.startsWith(' Cost:$'));
    expect(line).toBeDefined();
    expect(line).toContain('opus-5-5:$');
    expect(line).toContain('API:');
  });

  test('compaction fixture shows the exact compaction detail', () => {
    const s = loadState('compaction');
    const plain = renderDashboardLines(s, [], { now: NOW, width: 100 }).map(stripAnsi);
    expect(plain.some(l => l.includes('Compact:2 (manual 500.4K→12.1K)'))).toBe(true);
    expect(plain.some(l => l.includes('RC●'))).toBe(true);
    const info = renderInfoViewLines(s, { now: NOW, width: 100, height: 60 }).map(stripAnsi);
    expect(info.some(l => l.includes('https://claude.ai/code/session_01VZC8GyRsaCCBz48ySKtCbA'))).toBe(true);
    expect(info.some(l => l.includes('manual 535.0K→13.8K'))).toBe(true);
  });

  test('background fixture shows Mode chip, Denied strip, Hooks box', () => {
    const s = loadState('background');
    const plain = renderDashboardLines(s, [], { now: NOW, width: 100 }).map(stripAnsi);
    expect(plain.some(l => l.includes('Mode:auto(bash-first)'))).toBe(true);
    expect(plain.some(l => /^│ Denied:1 \(hook 1\) \(d\)/.test(l))).toBe(true);
    const hooks = plain.find(l => l.startsWith('┌─ Hooks'));
    expect(hooks).toBeDefined();
    const hooksBody = plain[plain.indexOf(hooks!) + 1] ?? '';
    expect(hooksBody).toMatch(/PreToolUse:\d+/);
    expect(hooksBody).toContain('errors:0');
    const expanded = renderDashboardLines(s, [], { now: NOW, width: 100, showDenials: true }).map(stripAnsi);
    expect(expanded.some(l => l.includes('Bash permission-rule') && l.includes('BLOCKED by'))).toBe(true);
  });

  test('links fixture: desktop icon and custom title in the header', () => {
    const s = loadState('links');
    const plain = renderDashboardLines(s, [], { now: NOW, width: 100 }).map(stripAnsi);
    expect(plain[1]).toContain('Kotlin 1.9에서 2.4로 마이그레이션 가이드');
    expect(plain[2]).toContain('Session:🖥 links');
    const info = renderInfoViewLines(s, { now: NOW, width: 100, height: 60 }).map(stripAnsi);
    expect(info.some(l => l.includes('PR #158') && l.includes('bizmatrixx/bzflow'))).toBe(true);
    expect(info.some(l => l.includes('Kotlin 1.9 → 2.4'))).toBe(true);
  });

  test('status dots and icons', () => {
    const now = Date.parse('2026-10-10T05:00:00Z');
    expect(stripAnsi(statusDot('busy', now - 1000, now))).toBe('●');
    expect(stripAnsi(statusDot('idle', now - 1000, now))).toBe('○');
    expect(stripAnsi(statusDot('busy', now - 11 * 60 * 1000, now))).toBe('?');
    expect(entrypointIcon('cli')).toBe('⌨');
    expect(entrypointIcon('claude-desktop')).toBe('🖥');
    expect(entrypointIcon(null)).toBe('');
  });
});
