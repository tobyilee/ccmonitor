#!/usr/bin/env bun
/**
 * bench-parse — time a full parse and an incremental refresh of a transcript.
 *
 *   bun run scripts/bench-parse.ts <transcript.jsonl> [appendLines=10]
 *
 * Copies the transcript to a temp file, measures the first full parse, then
 * appends N lines (copied from the file's own tail) and measures the refresh.
 */
import { copyFileSync, mkdtempSync, readFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TranscriptReader, parseTranscriptLines } from '../src/parser.js';

const [input, appendArg] = process.argv.slice(2);
if (!input) {
  console.error('usage: bench-parse.ts <transcript.jsonl> [appendLines]');
  process.exit(2);
}
const appendLines = Number(appendArg ?? 10);
const dir = mkdtempSync(join(tmpdir(), 'ccm-bench-'));
const file = join(dir, 'bench.jsonl');
copyFileSync(input, file);
const ctx = { sessionId: 'bench', projectDir: dir, transcriptFile: file };

const text = readFileSync(file, 'utf-8');
let t = performance.now();
parseTranscriptLines(text.split('\n'), ctx);
console.log(`full parse (in-memory):   ${(performance.now() - t).toFixed(1)} ms  (${(text.length / 1e6).toFixed(1)} MB)`);

const reader = new TranscriptReader(ctx);
t = performance.now();
reader.readNew();
console.log(`full parse (reader):      ${(performance.now() - t).toFixed(1)} ms`);

const tail = text.split('\n').filter(l => l.trim()).slice(-appendLines).join('\n') + '\n';
appendFileSync(file, tail);
t = performance.now();
const r = reader.readNew();
console.log(`incremental (+${appendLines} lines): ${(performance.now() - t).toFixed(1)} ms  fullReparse=${r.fullReparse} bytes=${r.bytesRead}`);

t = performance.now();
reader.readNew();
console.log(`no-op refresh:            ${(performance.now() - t).toFixed(1)} ms`);
rmSync(dir, { recursive: true, force: true });
