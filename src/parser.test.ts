import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, truncateSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TranscriptReader,
  compareVersions,
  computeDerived,
  extractRealUserPrompt,
  parseTranscriptLines,
  type ParseContext,
} from './parser.js';
import { cleanNativeRecap, extractKoreanRecap, mdToPlain, parseTaskNotification } from './recap.js';
import { loadScratchpadTasks, readTaskOutputTail } from './loaders/scratchpad.js';
import type { BackgroundTask } from './types.js';

const ctx: ParseContext = { sessionId: 'test', projectDir: '/nowhere', transcriptFile: '/nowhere/test.jsonl' };

// ---------------------------------------------------------------------------
// Synthetic entry builders
// ---------------------------------------------------------------------------

let seq = 0;
const T0 = Date.parse('2026-10-10T03:00:00.000Z');
function ts(offsetSec: number): string {
  return new Date(T0 + offsetSec * 1000).toISOString();
}

function human(text: string, offsetSec: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user', uuid: `u${++seq}`, timestamp: ts(offsetSec), version: '2.1.296', cwd: '/Users/dev/p',
    promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 },
    message: { role: 'user', content: text }, ...extra,
  });
}

function assistantLine(
  id: string, stop: string, blocks: unknown[], offsetSec: number, usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 100 },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant', uuid: `a${++seq}`, timestamp: ts(offsetSec), version: '2.1.296',
    message: { id, model: 'claude-fable-5-1', role: 'assistant', stop_reason: stop, content: blocks, usage },
    ...extra,
  });
}

function toolResult(toolUseId: string, offsetSec: number, extra: Record<string, unknown> = {}, text = 'ok'): string {
  return JSON.stringify({
    type: 'user', uuid: `r${++seq}`, timestamp: ts(offsetSec), version: '2.1.296',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    ...extra,
  });
}

function system(subtype: string, offsetSec: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'system', subtype, uuid: `s${++seq}`, timestamp: ts(offsetSec), version: '2.1.296', ...extra });
}

// ---------------------------------------------------------------------------

describe('extractRealUserPrompt', () => {
  test('plain text is returned unchanged', () => {
    expect(extractRealUserPrompt('fix the login bug')).toBe('fix the login bug');
  });

  test('<command-args> content wins over the skill body', () => {
    const text = [
      '<command-name>/commit</command-name>',
      '<command-message>commit</command-message>',
      '<command-args>Fix login bug</command-args>',
      'Base directory for this skill: /x',
    ].join('\n');
    expect(extractRealUserPrompt(text)).toBe('Fix login bug');
  });

  test('hook preamble and system-reminder are stripped', () => {
    const text = '<system-reminder>hook injected</system-reminder>\nUserPromptSubmit hook success: ok';
    expect(extractRealUserPrompt(text)).toBeNull();
  });
});

describe('message-id grouping (T0.5)', () => {
  test('usage and A: count once per message id across split lines', () => {
    const lines = [
      human('hello', 0),
      assistantLine('m1', 'tool_use', [{ type: 'thinking', thinking: 'x' }], 1, { input_tokens: 10, output_tokens: 880 }),
      assistantLine('m1', 'tool_use', [{ type: 'text', text: 'Looking' }], 2, { input_tokens: 10, output_tokens: 880 }),
      assistantLine('m1', 'tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 3, { input_tokens: 10, output_tokens: 880 }),
      toolResult('t1', 4),
      assistantLine('m2', 'end_turn', [{ type: 'thinking', thinking: 'y' }], 5, { input_tokens: 20, output_tokens: 1228 }),
      assistantLine('m2', 'end_turn', [{ type: 'text', text: 'Done.' }], 6, { input_tokens: 20, output_tokens: 1228 }),
    ];
    const s = parseTranscriptLines(lines, ctx);
    expect(s.messageCount.assistant).toBe(2);
    expect(s.messageCount.user).toBe(2);
    expect(s.tokenUsage.output).toBe(880 + 1228);
    expect(s.tokenUsage.input).toBe(30);
    expect(s.tokenHistory.length).toBe(2);
    // Grouped text of m2 is non-empty although its first line has no text block.
    expect(s.recap.finalReply).toBe('Done.');
    expect(s.recap.finalReplyModel).toBe('claude-fable-5-1');
  });
});

describe('TranscriptReader incremental parsing (T0.6)', () => {
  const lines = [
    human('first prompt 한국어', 0),
    assistantLine('m1', 'tool_use', [{ type: 'text', text: 'Working on it' }], 1),
    assistantLine('m1', 'tool_use', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], 2),
    toolResult('t1', 3),
    assistantLine('m2', 'end_turn', [{ type: 'text', text: 'All done.\n\n**Korean recap**\n\n- 끝났습니다.' }], 4),
    system('turn_duration', 5, { durationMs: 5000, messageCount: 5 }),
  ];
  const content = lines.join('\n') + '\n';

  function strip(s: unknown): unknown {
    return JSON.parse(JSON.stringify(s, (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)));
  }

  test('two halves split mid-line equal one-piece parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-'));
    const file = join(dir, 'a.jsonl');
    const mid = Math.floor(content.length / 2) + 7; // somewhere inside a line
    const bytes = Buffer.from(content, 'utf-8');
    writeFileSync(file, bytes.subarray(0, mid));
    const c = { ...ctx, transcriptFile: file };
    const reader = new TranscriptReader(c);
    const r1 = reader.readNew();
    expect(r1.fullReparse).toBe(false);
    appendFileSync(file, bytes.subarray(mid));
    const r2 = reader.readNew();
    expect(r2.fullReparse).toBe(false);
    const whole = parseTranscriptLines(lines, c);
    expect(strip(reader.parsed)).toEqual(strip(whole));
    rmSync(dir, { recursive: true, force: true });
  });

  test('truncated file triggers fullReparse and matches a fresh parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-'));
    const file = join(dir, 'a.jsonl');
    writeFileSync(file, content);
    const c = { ...ctx, transcriptFile: file };
    const reader = new TranscriptReader(c);
    reader.readNew();
    expect(reader.parsed.turns.length).toBe(1);
    const half = lines.slice(0, 3).join('\n') + '\n';
    truncateSync(file, Buffer.byteLength(half));
    const r = reader.readNew();
    expect(r.fullReparse).toBe(true);
    const fresh = parseTranscriptLines(lines.slice(0, 3), c);
    expect(strip(reader.parsed)).toEqual(strip(fresh));
    expect(reader.parsed.recap.turnOpen).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('rewritten head (same size or larger) triggers fullReparse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-'));
    const file = join(dir, 'a.jsonl');
    writeFileSync(file, content);
    const c = { ...ctx, transcriptFile: file };
    const reader = new TranscriptReader(c);
    reader.readNew();
    // Rewrite in place: different first line, longer overall.
    writeFileSync(file, [human('rewritten head prompt', 0), ...lines.slice(1), system('turn_duration', 9)].join('\n') + '\n');
    const r = reader.readNew();
    expect(r.fullReparse).toBe(true);
    expect(reader.parsed.lastUserPrompt).toBe('rewritten head prompt');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('unknown-field logger (T0.7)', () => {
  test('reports each unknown value once', () => {
    const seen: string[] = [];
    const c: ParseContext = { ...ctx, onUnknown: (k, v) => seen.push(`${k}=${v}`) };
    const line = JSON.stringify({ type: 'made-up-type' });
    const att = JSON.stringify({ type: 'attachment', attachment: { type: 'weird_thing' } });
    const sys = JSON.stringify({ type: 'system', subtype: 'odd_subtype' });
    parseTranscriptLines([line, line, att, att, sys, sys, human('x', 0)], c);
    expect(seen).toEqual(['type=made-up-type', 'attachment.type=weird_thing', 'system.subtype=odd_subtype']);
  });
});

describe('recap helpers (T1.3)', () => {
  test('extractKoreanRecap finds the heading variants', () => {
    expect(extractKoreanRecap('a\n\n**Korean recap**\n\n- 하나\n- 둘')).toBe('- 하나\n- 둘');
    expect(extractKoreanRecap('a\n## 요약\n내용')).toBe('내용');
    expect(extractKoreanRecap('a\nRecap:\n내용')).toBe('내용');
    expect(extractKoreanRecap('a\n**요약 (Korean recap)**\n- 내용')).toBe('- 내용');
    expect(extractKoreanRecap('no heading here')).toBeNull();
  });

  test('mdToPlain strips markup and replaces fences', () => {
    const out = mdToPlain('# Title\n\n**bold** and `code`\n\n```ts\nconst x = 1;\n```\n\n\n* bullet\n');
    expect(out).toEqual(['Title', '', 'bold and code', '', '[code]', '', '- bullet']);
    expect(out.join('\n')).not.toContain('**');
    expect(out.filter(l => l === '[code]').length).toBe(1);
  });

  test('cleanNativeRecap strips the config suffix', () => {
    expect(cleanNativeRecap('You did X. (disable recaps in /config)')).toBe('You did X.');
  });

  test('parseTaskNotification reads the spec sample', () => {
    const n = parseTaskNotification('<task-notification>\n<task-id>beew8wowa</task-id>\n<status>completed</status>\n<summary>Background command "Run the adapter…" completed (exit code 0)</summary>\n</task-notification>');
    expect(n).toMatchObject({ id: 'beew8wowa', status: 'completed', exitCode: 0 });
  });

  test('recap state on a synthetic turn', () => {
    const away = system('away_summary', 200, { content: 'You asked for X, so I did Y. (disable recaps in /config)' });
    const s = parseTranscriptLines([
      human('do it', 0),
      assistantLine('m1', 'tool_use', [{ type: 'text', text: '**Rewritten prompt:** "Do it."' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 1),
      toolResult('t1', 2),
      assistantLine('m2', 'end_turn', [{ type: 'text', text: 'Committed on a new branch.\n\n**Korean recap**\n\n- 브랜치를 만들었습니다.\n- 커밋했습니다.\n- 끝.' }], 3),
      system('turn_duration', 4, { durationMs: 4000 }),
      away,
    ], ctx);
    expect(s.recap.nativeRecap).toBe('You asked for X, so I did Y.');
    expect(s.recap.nativeRecapTime?.toISOString()).toBe(ts(200));
    expect(s.recap.finalReply).toContain('Committed on a new branch');
    expect(s.recap.koreanRecap?.split('\n')).toHaveLength(3);
    expect(s.recap.turnOpen).toBe(false);
    expect(s.recap.liveNarration).toBeNull();

    // Turn still open: narration visible, before and after mdToPlain.
    const open = parseTranscriptLines([
      human('do it', 0),
      assistantLine('m1', 'tool_use', [{ type: 'text', text: '**Rewritten prompt:** "Do it."' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 1),
    ], ctx);
    expect(open.recap.turnOpen).toBe(true);
    expect(open.recap.liveNarration?.startsWith('**Rewritten prompt:**')).toBe(true);
    expect(mdToPlain(open.recap.liveNarration ?? '')[0]?.startsWith('Rewritten prompt:')).toBe(true);
    expect(open.currentTurn?.toolCalls).toBe(1);

    // Recaps disabled: no away_summary line.
    const noAway = parseTranscriptLines([
      human('do it', 0),
      assistantLine('m2', 'end_turn', [{ type: 'text', text: 'Committed on a new branch.' }], 3),
      system('turn_duration', 4, { durationMs: 4000 }),
    ], ctx);
    expect(noAway.recap.nativeRecap).toBeNull();
    expect(noAway.recap.finalReply).toBe('Committed on a new branch.');
  });
});

describe('turn state machine (T1.5)', () => {
  test('task_notification turns do not update the last user prompt', () => {
    const s = parseTranscriptLines([
      human('real prompt', 0),
      assistantLine('m1', 'end_turn', [{ type: 'text', text: 'ok' }], 1),
      system('turn_duration', 2, { durationMs: 1000, messageCount: 2, pendingBackgroundAgentCount: 2 }),
      JSON.stringify({
        type: 'user', uuid: 'n1', timestamp: ts(3), version: '2.1.296', turnOrigin: 'task_notification',
        origin: { kind: 'task-notification', producer: 'session-task' },
        message: { role: 'user', content: '<task-notification>\n<task-id>beew8wowa</task-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>' },
      }),
    ], ctx);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.pendingBackgroundAgents).toBe(2);
    expect(s.turns[0]?.durationMs).toBe(1000);
    expect(s.currentTurn?.origin).toBe('task_notification');
    expect(s.lastUserPrompt).toBe('real prompt');
    expect(s.backgroundTasks.get('beew8wowa')?.status).toBe('completed');
  });

  test('queued prompts are human turns', () => {
    const s = parseTranscriptLines([
      human('a', 0, { promptSource: 'queued' }),
      system('turn_duration', 1, { durationMs: 10 }),
    ], ctx);
    expect(s.turns[0]?.origin).toBe('human');
  });
});

describe('background tasks (T1.6)', () => {
  test('agent and bash launches become running tasks; notifications close them', () => {
    const launch = assistantLine('m1', 'tool_use', [
      { type: 'tool_use', id: 'tA', name: 'Agent', input: { description: 'Review the slice', subagent_type: 'code-reviewer' } },
      { type: 'tool_use', id: 'tB', name: 'Bash', input: { description: 'Run tests', run_in_background: true, command: 'x' } },
      { type: 'tool_use', id: 'tC', name: 'Bash', input: { description: 'ls', command: 'ls' } },
    ], 1);
    const agentRes = toolResult('tA', 2, {
      toolUseResult: {
        isAsync: true, status: 'async_launched', agentId: 'a3307b749cd8cca09', description: 'Review the slice',
        resolvedModel: 'claude-fable-5-1', outputFile: '/tmp/x/tasks/a3307b749cd8cca09.output',
      },
    });
    const bashRes = toolResult('tB', 3, { toolUseResult: { backgroundTaskId: 'beew8wowa' } },
      'Command running in background with ID: beew8wowa. Output is being written to: /tmp/x/tasks/beew8wowa.output');
    const plain = toolResult('tC', 4);
    const note = JSON.stringify({
      type: 'queue-operation', operation: 'enqueue', timestamp: ts(5),
      content: '<task-notification>\n<task-id>beew8wowa</task-id>\n<status>completed</status>\n<summary>Background command "Run tests" completed (exit code 3)</summary>\n</task-notification>',
    });
    const s = parseTranscriptLines([human('go', 0), launch, agentRes, bashRes, plain, note], ctx);
    expect(s.backgroundTasks.size).toBe(2);
    const agent = s.backgroundTasks.get('a3307b749cd8cca09')!;
    expect(agent.kind).toBe('agent');
    expect(agent.agentType).toBe('code-reviewer');
    expect(agent.model).toBe('claude-fable-5-1');
    expect(agent.status).toBe('running');
    const bash = s.backgroundTasks.get('beew8wowa')!;
    expect(bash.kind).toBe('bash');
    expect(bash.outputFile).toBe('/tmp/x/tasks/beew8wowa.output');
    expect(bash.status).toBe('failed');
    expect(bash.exitCode).toBe(3);
    expect(s.queue.depth).toBe(1);
  });

  test('scratchpad loader reads exit markers and sizes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-tasks-'));
    writeFileSync(join(dir, 'x.output'), 'line1\nline2\n[exited with code 3]\n');
    writeFileSync(join(dir, 'y.output'), 'still going\n');
    const mk = (id: string): BackgroundTask => ({
      id, kind: 'bash', agentType: null, description: '', model: null, startedAt: new Date(0), endedAt: null,
      status: 'running', exitCode: null, outputFile: join(dir, `${id}.output`), outputBytes: 0, toolUseId: null, summary: null,
    });
    const tasks = new Map([['x', mk('x')], ['y', mk('y')]]);
    loadScratchpadTasks(tasks);
    expect(tasks.get('x')?.status).toBe('failed');
    expect(tasks.get('x')?.exitCode).toBe(3);
    expect(tasks.get('y')?.status).toBe('running');
    expect(tasks.get('y')?.outputBytes).toBe(Buffer.byteLength('still going\n'));
    expect(readTaskOutputTail(tasks.get('x')!, 2)).toEqual(['line2', '[exited with code 3]']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('derived values', () => {
  test('compareVersions', () => {
    expect(compareVersions('2.1.296', '2.1.295')).toBeGreaterThan(0);
    expect(compareVersions('2.1.300', '2.1.296')).toBeGreaterThan(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
    expect(compareVersions('2.1.280', '2.1.280')).toBe(0);
  });

  test('compaction count: exact when compact_boundary exists, heuristic only on old versions', () => {
    const drop = [
      human('a', 0),
      assistantLine('m1', 'end_turn', [{ type: 'text', text: 'x' }], 1, { input_tokens: 100, cache_read_input_tokens: 500_000 }),
      assistantLine('m2', 'end_turn', [{ type: 'text', text: 'y' }], 2, { input_tokens: 100, cache_read_input_tokens: 10_000 }),
    ];
    const oldV = parseTranscriptLines(drop.map(l => l.replace('"2.1.296"', '"2.1.200"')), ctx);
    computeDerived(oldV);
    expect(oldV.compactionCount).toBe(1);
    const newV = parseTranscriptLines(drop, ctx);
    computeDerived(newV);
    expect(newV.compactionCount).toBe(0);
    const exact = parseTranscriptLines([...drop, system('compact_boundary', 3, { compactMetadata: { trigger: 'manual', preTokens: 534977, postTokens: 13769 } })], ctx);
    computeDerived(exact);
    expect(exact.compactionCount).toBe(1);
    expect(exact.compactions[0]?.preTokens).toBe(534977);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (v1.7): cost fallback, model catalog, hooks, permissions
// ---------------------------------------------------------------------------

import { loadPreviousCost } from './loaders/globalConfig.js';
import { loadModelCatalog, parseModelCatalog } from './loaders/modelCatalog.js';

describe('loadPreviousCost (T2.1)', () => {
  test('reads projects[cwd].lastCost as a previous-session cost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-cfg-'));
    const cfg = join(dir, 'claude.json');
    writeFileSync(cfg, JSON.stringify({
      projects: { '/Users/dev/p': { lastCost: 0.25, lastAPIDuration: 1000, lastModelUsage: { 'claude-opus-5-5': { costUSD: 0.25 } } } },
    }));
    const c = loadPreviousCost('/Users/dev/p', cfg);
    expect(c?.totalUSD).toBe(0.25);
    expect(c?.isPrevious).toBe(true);
    expect(c?.perModel['claude-opus-5-5']).toBe(0.25);
    expect(loadPreviousCost('/Users/dev/other', cfg)).toBeNull();
    expect(loadPreviousCost('/Users/dev/p', join(dir, 'missing.json'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('model catalog loader (T2.2)', () => {
  const doc = {
    version: 2, fetchedAt: 1790405043367,
    catalog: { config: { models: [
      { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main', thinking: { effort_options: [{ id: 'low' }, { id: 'max' }] } },
      { id: 'claude-opus-5-5', name: 'Opus 5.5', fast_mode: { available: true } },
    ] } },
  };
  test('parses ids, effort options and fast mode', () => {
    const cat = parseModelCatalog(doc)!;
    expect(cat.models.map(m => m.id)).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
    expect(cat.models[0]?.effortOptions).toEqual(['low', 'max']);
    expect(cat.models[1]?.fastMode).toBe(true);
    expect(cat.models[0]?.contextWindow).toBeNull();
    expect(cat.fetchedAt?.getTime()).toBe(1790405043367);
  });
  test('reads the newest file in a directory; empty dir → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-cat-'));
    expect(loadModelCatalog(dir)).toBeNull();
    writeFileSync(join(dir, 'a.json'), JSON.stringify(doc));
    const cat = loadModelCatalog(dir);
    expect(cat?.models.map(m => m.id)).toContain('claude-fable-5-1');
    expect(cat?.models.map(m => m.id)).toContain('claude-opus-5-5');
    expect(loadModelCatalog(join(dir, 'nope'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  test('real cache (if present) lists the current models', () => {
    const real = join(process.env.HOME ?? '', '.claude', 'cache', 'model-catalog');
    const cat = loadModelCatalog(real);
    if (!cat) return; // machine without a cache
    expect(cat.models.length).toBeGreaterThan(0);
    expect(cat.models.every(m => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
  });
});

describe('hooks (T2.4)', () => {
  test('stop_hook_summary sets stopBlocked; turn_duration resets it', () => {
    const base = [human('go', 0), assistantLine('m1', 'end_turn', [{ type: 'text', text: 'ok' }], 1)];
    const blocked = parseTranscriptLines([...base, system('stop_hook_summary', 2, { hookCount: 1, preventedContinuation: true })], ctx);
    expect(blocked.hooks.stopBlocked).toBe(true);
    const reset = parseTranscriptLines([...base, system('stop_hook_summary', 2, { hookCount: 1, preventedContinuation: true }), system('turn_duration', 3, { durationMs: 10 })], ctx);
    expect(reset.hooks.stopBlocked).toBe(false);
  });
  test('non-zero exitCode hook_success is recorded as an error', () => {
    const att = JSON.stringify({ type: 'attachment', uuid: 'h1', timestamp: ts(1), attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', exitCode: 2, stderr: 'boom\nmore' } });
    const ok = JSON.stringify({ type: 'attachment', uuid: 'h2', timestamp: ts(2), attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', exitCode: 0 } });
    const s = parseTranscriptLines([human('go', 0), att, ok], ctx);
    expect(s.hooks.total).toBe(2);
    expect(s.hooks.byEvent).toEqual({ PreToolUse: 1, Stop: 1 });
    expect(s.hooks.errors).toHaveLength(1);
    expect(s.hooks.errors[0]).toMatchObject({ hookName: 'PreToolUse:Bash', exitCode: 2, stderr: 'boom' });
  });
});

describe('permissions (T2.3)', () => {
  test('denials capture tool name, kind and first line of the error', () => {
    const lines = [
      human('go', 0),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' }),
      JSON.stringify({ type: 'attachment', uuid: 'am', timestamp: ts(0), attachment: { type: 'auto_mode', bashFirst: true, steerOnly: true, bypass: false } }),
      assistantLine('m1', 'tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push --force' } }], 1),
      toolResult('t1', 2, { toolDenialKind: 'permission-rule', permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook' } },
        'PreToolUse:Bash hook error: BLOCKED by scripts/hooks/guard-bash.sh\n\n  Rule: no force push'),
      assistantLine('m2', 'tool_use', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }], 3),
      toolResult('t2', 4, { permissionDecision: { decision: 'accept', source: 'config', reasonType: 'classifier' } }),
    ];
    const s = parseTranscriptLines(lines, ctx);
    expect(s.permissions.mode).toBe('auto');
    expect(s.permissions.autoMode?.bashFirst).toBe(true);
    expect(s.permissions.decisions).toEqual({ accept: 1, reject: 1, byReason: { hook: 1, classifier: 1 }, rejectByReason: { hook: 1 } });
    expect(s.permissions.denials[0]).toMatchObject({ tool: 'Bash', kind: 'permission-rule' });
    expect(s.permissions.denials[0]?.reason).toContain('BLOCKED by scripts/hooks/guard-bash.sh');
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (v1.8): links, queue, attribution, errors
// ---------------------------------------------------------------------------

import { loadPlanFile, resolvePlansDir } from './loaders/plans.js';
import { loadFeedbackDrafts } from './loaders/feedback.js';

describe('plan and feedback loaders (T3.2)', () => {
  test('plan file resolves under the default dir or settings.plansDirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-plans-'));
    const plans = join(dir, 'plans');
    const custom = join(dir, 'custom');
    const settings = join(dir, 'settings.json');
    for (const d of [plans, custom]) { require('fs').mkdirSync(d); }
    writeFileSync(join(plans, 'slug-a.md'), '# plan\n'.repeat(100));
    expect(loadPlanFile('slug-a', { settingsPath: settings, defaultDir: plans })).toEqual({ path: join(plans, 'slug-a.md'), bytes: 700 });
    expect(loadPlanFile('missing', { settingsPath: settings, defaultDir: plans })).toBeNull();
    expect(loadPlanFile(null, { settingsPath: settings, defaultDir: plans })).toBeNull();
    writeFileSync(settings, JSON.stringify({ plansDirectory: custom }));
    writeFileSync(join(custom, 'slug-b.md'), 'x');
    expect(resolvePlansDir({ settingsPath: settings, defaultDir: plans })).toBe(custom);
    expect(loadPlanFile('slug-b', { settingsPath: settings, defaultDir: plans })?.bytes).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('feedback drafts filter on source_session_id and skip malformed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccm-fb-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ title: 'Suggested `. ./.env` to load an SSH key', type: 'bug', source_session_id: 'sess-1', cwd: '/x' }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ title: 'Other', type: 'idea', source_session_id: 'sess-2' }));
    writeFileSync(join(dir, 'c.json'), '{broken');
    const mine = loadFeedbackDrafts('sess-1', dir);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.title.startsWith('Suggested')).toBe(true);
    expect(loadFeedbackDrafts('sess-3', dir)).toEqual([]);
    expect(loadFeedbackDrafts('sess-1', join(dir, 'nope'))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('prompt queue (T3.3)', () => {
  test('enqueue, enqueue, dequeue → depth 1 and preview is the second prompt', () => {
    const q = (operation: string, content: string, t: number): string =>
      JSON.stringify({ type: 'queue-operation', operation, content, timestamp: ts(t) });
    const depths: number[] = [];
    const lines = [human('go', 0), q('enqueue', 'first prompt', 1), q('enqueue', 'second prompt', 2), q('dequeue', '', 3)];
    // stream line by line and assert the depth is never negative
    for (let i = 1; i <= lines.length; i++) depths.push(parseTranscriptLines(lines.slice(0, i), ctx).queue.depth);
    expect(depths).toEqual([0, 1, 2, 1]);
    const s = parseTranscriptLines(lines, ctx);
    expect(s.queue.preview).toBe('second prompt');
    const drained = parseTranscriptLines([...lines, q('remove', '', 4), q('dequeue', '', 5)], ctx);
    expect(drained.queue.depth).toBe(0);
    expect(drained.queue.preview).toBeNull();
  });
});

describe('attribution and telemetry (T3.4)', () => {
  test('advisor server_tool_use, thinking average per message id, fast mode, mcp merge', () => {
    const lines = [
      human('go', 0),
      assistantLine('m1', 'tool_use', [{ type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} }], 1, { input_tokens: 1, output_tokens: 1 }, { advisorModel: 'claude-opus-5-5', thinkingDurationMs: 4000, attributionSkill: 'ego-browser' }),
      assistantLine('m1', 'tool_use', [{ type: 'text', text: 'x' }], 2, { input_tokens: 1, output_tokens: 1 }, { advisorModel: 'claude-opus-5-5', thinkingDurationMs: 4000, attributionSkill: 'ego-browser' }),
      assistantLine('m2', 'tool_use', [{ type: 'tool_use', id: 't1', name: 'mcp__claude_ai_Gmail__search', input: {} }], 3, { input_tokens: 1, output_tokens: 1, speed: 'fast' }, { thinkingDurationMs: 2000, attributionMcpServer: 'claude.ai Gmail' }),
      toolResult('t1', 4),
    ];
    const s = parseTranscriptLines(lines, ctx);
    expect(s.attribution.advisorCalls).toBe(1);
    expect(s.attribution.advisorModel).toBe('claude-opus-5-5');
    expect(s.attribution.thinkingSamples).toBe(2);
    expect(s.attribution.thinkingAvgMs).toBe(3000);
    expect(s.attribution.fastMode).toBe(true);
    expect(s.attribution.skills['ego-browser']).toBe(1);
    expect(Object.keys(s.attribution.mcpServers)).toHaveLength(1);
    expect(Object.values(s.attribution.mcpServers)[0]).toBe(2);
  });
});

describe('errors (T3.5)', () => {
  test('interrupted request is counted with its time', () => {
    const s = parseTranscriptLines([
      human('go', 0),
      JSON.stringify({ type: 'user', uuid: 'i1', timestamp: ts(5), interruptedMessageId: 'msg_1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    ], ctx);
    expect(s.errors.interrupts).toBe(1);
    expect(s.errors.interruptTimes[0]?.toISOString()).toBe(ts(5));
    expect(s.lastUserPrompt).toBe('go');
  });
});
