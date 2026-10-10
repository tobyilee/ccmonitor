import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseTranscriptLines, computeDerived } from './parser.js';
import {
  displayWidth, wordWrap, stripAnsi, truncateToWidth, formatDurationCompact,
  renderDashboardLines, renderRecapViewLines, renderBackgroundViewLines,
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
