#!/usr/bin/env bun
/**
 * update-golden — regenerate fixtures/golden/<name>.<width>.txt from the
 * current renderer (ANSI stripped, fixed clock). Run on purpose after a
 * deliberate visual change, then read `git diff fixtures/golden`.
 *
 *   bun run scripts/update-golden.ts [name ...]
 */
process.env.TZ = 'UTC'; // bun test renders in UTC; keep the golden files deterministic
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseTranscriptLines, computeDerived } from '../src/parser.js';
import { renderDashboardLines, stripAnsi } from '../src/ui.js';
import pkg from '../package.json';

/**
 * Golden files must not change on every release: mask the version in the title
 * bar and collapse the padding after it (a longer version string shifts the clock).
 */
export function normalizeGolden(text: string): string {
  return text
    .replace(/Claude Code Monitor v\d+\.\d+\.\d+ +/g, 'Claude Code Monitor vX.Y.Z ')
    .split(`v${pkg.version}`).join('vX.Y.Z');
}

export const GOLDEN_NOW = new Date('2026-10-10T05:00:00.000Z');
export const GOLDEN_WIDTH = 100;

const FIX = join(import.meta.dir, '..', 'fixtures');
const OUT = join(FIX, 'golden');

export function goldenFor(name: string): string {
  const file = join(FIX, `${name}.jsonl`);
  const s = parseTranscriptLines(readFileSync(file, 'utf-8').split('\n'), { sessionId: name, projectDir: FIX, transcriptFile: file });
  computeDerived(s);
  return normalizeGolden(renderDashboardLines(s, { now: GOLDEN_NOW, width: GOLDEN_WIDTH }).map(stripAnsi).join('\n') + '\n');
}

if (import.meta.main) {
  const names = process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : readdirSync(FIX).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, ''));
  mkdirSync(OUT, { recursive: true });
  for (const name of names) {
    const path = join(OUT, `${name}.${GOLDEN_WIDTH}.txt`);
    writeFileSync(path, goldenFor(name));
    console.log(`wrote ${path}`);
  }
}
