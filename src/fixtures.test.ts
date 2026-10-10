/**
 * Fixture-based tests. Fixtures are cut from real transcripts with
 * scripts/make-fixture.ts; each has an `.expect.json` sidecar with measured
 * counts. The suite skips when the fixtures directory is absent.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { computeDerived, parseTranscriptLines, type ParseContext } from './parser.js';
import { loadActiveSessions } from './loaders/sessions.js';
import { mdToPlain } from './recap.js';

const FIX = join(import.meta.dir, '..', 'fixtures');
const have = (name: string): boolean => existsSync(join(FIX, `${name}.jsonl`));

interface Expect {
  lines: number;
  types: Record<string, number>;
  systemSubtypes: Record<string, number>;
  attachmentTypes: Record<string, number>;
  stopReasons: Record<string, number>;
  messageIds: string[];
  outputTokensByMessage: Record<string, number>;
  promptSources: Record<string, number>;
  turnOrigins: Record<string, number>;
  permissionReasonTypes: Record<string, number>;
  permissionDecisions: Record<string, number>;
  hookEvents: Record<string, number>;
  queueOperations: Record<string, number>;
  trackingPaths: Record<string, number>;
  attributionSkills: Record<string, number>;
  mcpServers: Record<string, number>;
  toolNames: Record<string, number>;
  models: Record<string, number>;
  toolDenialKinds: Record<string, number>;
  interrupted: number;
  apiErrors: number;
  humanPrompts: number;
}

function load(name: string): { lines: string[]; expect: Expect; ctx: ParseContext } {
  const file = join(FIX, `${name}.jsonl`);
  const lines = readFileSync(file, 'utf-8').split('\n');
  const sidecar = JSON.parse(readFileSync(join(FIX, `${name}.expect.json`), 'utf-8')) as Expect;
  return { lines, expect: sidecar, ctx: { sessionId: name, projectDir: FIX, transcriptFile: file } };
}

function sum(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}

describe.skipIf(!existsSync(FIX))('fixture smoke tests', () => {
  const names = existsSync(FIX)
    ? readdirSync(FIX).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, ''))
    : [];
  for (const name of names) {
    test(`${name}: counts match the sidecar`, () => {
      const { lines, expect: e, ctx } = load(name);
      const s = parseTranscriptLines(lines, ctx);
      expect(s.messageCount.assistant).toBe(e.messageIds.length);
      expect(s.messageCount.user).toBe(e.types['user'] ?? 0);
      expect(s.messageCount.system).toBe(e.types['system'] ?? 0);
      expect(s.tokenUsage.output).toBe(sum(e.outputTokensByMessage));
      expect(s.hooks.total).toBe(e.attachmentTypes['hook_success'] ?? 0);
      expect(s.compactions.length).toBe(e.systemSubtypes['compact_boundary'] ?? 0);
      expect(s.errors.api.length).toBe(e.apiErrors);
      expect(s.errors.interrupts).toBe(e.interrupted);
      const realModels = Object.keys(e.models).filter(m => m !== '<synthetic>');
      if (realModels.length > 0) expect(realModels).toContain(s.model);
    });
  }
});

describe.skipIf(!have('recap-basic'))('recap-basic', () => {
  test('header numbers, recap and turns', () => {
    const { lines, expect: e, ctx } = load('recap-basic');
    const s = parseTranscriptLines(lines, ctx);
    expect(s.messageCount.user).toBe(e.types['user'] ?? 0);
    expect(s.messageCount.assistant).toBe(e.messageIds.length);
    expect(s.model).toBe('claude-fable-5-1');
    expect(s.recap.nativeRecap?.startsWith('You asked for a pre-PR sync')).toBe(true);
    expect(s.recap.nativeRecap?.includes('disable recaps')).toBe(false);
    expect(s.recap.nativeRecapTime?.toISOString()).toBe('2026-10-10T03:34:37.339Z');
    expect(s.recap.finalReply).toContain('Committed on a new branch');
    expect(s.recap.finalReplyTime?.toISOString()).toBe('2026-10-10T03:31:31.612Z');
    const kr = s.recap.koreanRecap?.split('\n').filter(l => l.trim()) ?? [];
    expect(kr).toHaveLength(3);
    expect(kr[0]?.replace(/^-\s*/, '').startsWith('`main`에서 바로 커밋하지 않고')).toBe(true);
    expect(s.recap.turnOpen).toBe(false);
    expect(s.recap.liveNarration).toBeNull();
    expect(s.turns.length).toBe(e.humanPrompts);
    expect(s.currentTurn).toBeNull();
    // away_summary arrives ~3 minutes after the final reply
    const gap = (s.recap.nativeRecapTime!.getTime() - s.recap.finalReplyTime!.getTime()) / 1000;
    expect(gap).toBeGreaterThan(180);
  });

  test('recaps disabled: dropping away_summary leaves the final reply intact', () => {
    const { lines, ctx } = load('recap-basic');
    const without = lines.filter(l => !l.includes('"away_summary"'));
    const s = parseTranscriptLines(without, ctx);
    expect(s.recap.nativeRecap).toBeNull();
    expect(s.recap.finalReply).toContain('Committed on a new branch');
  });
});

describe.skipIf(!have('multiblock'))('multiblock', () => {
  test('one message id spanning lines counts once', () => {
    const { lines, expect: e, ctx } = load('multiblock');
    const s = parseTranscriptLines(lines, ctx);
    const linesWithId = lines.filter(l => l.includes('msg_011CfsqkAy8H2tJKPnokNzYh')).length;
    expect(linesWithId).toBe(3);
    expect(s.messageCount.assistant).toBe(e.messageIds.length);
    expect(s.messageCount.assistant).toBeLessThan(e.types['assistant'] ?? 0);
    expect(s.tokenUsage.output).toBe(sum(e.outputTokensByMessage));
    expect(e.outputTokensByMessage['msg_011Cfsr7dZN5HMtVDQ5LsjEE']).toBe(1228);
    // The end_turn message's first line has no text block, but the grouped text is non-empty.
    expect(s.recap.finalReply?.length ?? 0).toBeGreaterThan(0);
  });
});

describe.skipIf(!have('turn-open'))('turn-open', () => {
  test('turn is open with live narration', () => {
    const { lines, ctx } = load('turn-open');
    const s = parseTranscriptLines(lines, ctx);
    expect(s.recap.turnOpen).toBe(true);
    expect(s.currentTurn).not.toBeNull();
    expect(s.currentTurn!.toolCalls).toBeGreaterThan(0);
    expect(s.turns.length).toBeGreaterThan(0);
    expect(s.recap.liveNarration?.startsWith('**Rewritten prompt:**')).toBe(true);
    expect(mdToPlain(s.recap.liveNarration ?? '')[0]?.startsWith('Rewritten prompt:')).toBe(true);
    // No turn_duration after the last human prompt.
    let lastPrompt = -1;
    lines.forEach((l, i) => { if (l.includes('"promptSource":"typed"')) lastPrompt = i; });
    expect(lines.slice(lastPrompt).some(l => l.includes('"turn_duration"'))).toBe(false);
  });
});

describe.skipIf(!have('background'))('background', () => {
  test('agents, bash tasks, turns, denials, hooks', () => {
    const { lines, expect: e, ctx } = load('background');
    const s = parseTranscriptLines(lines, ctx);
    const agents = [...s.backgroundTasks.values()].filter(t => t.kind === 'agent');
    const bash = [...s.backgroundTasks.values()].filter(t => t.kind === 'bash');
    expect(agents.map(a => a.id).sort()).toEqual(['a3307b749cd8cca09', 'a573350ab857e538c']);
    expect(bash.map(b => b.id).sort()).toEqual(['b40ny2vsk', 'beew8wowa', 'bv2yna52c', 'bxyacc5c3', 'bz0had0z5']);
    const first = s.backgroundTasks.get('a3307b749cd8cca09')!;
    expect(first.description).toBe('Review the email capture slice');
    expect(first.model).toBe('claude-fable-5-1');
    expect(first.agentType).toBe('code-reviewer');
    for (const t of s.backgroundTasks.values()) {
      if (t.summary) {
        expect(t.status).toBe('completed');
        if (t.kind === 'bash') expect(t.exitCode).toBe(0);
      } else {
        expect(t.status).toBe('running');
      }
    }
    expect(s.scratchpadDir?.endsWith('/253aaf04-fe1a-4d97-b8eb-87ee6b61659f/scratchpad')).toBe(true);
    // turns
    const humanTurns = s.turns.filter(t => t.origin === 'human').length + (s.currentTurn?.origin === 'human' ? 1 : 0);
    expect(humanTurns).toBe(e.humanPrompts);
    const withPending = s.turns.find(t => t.pendingBackgroundAgents === 2);
    expect(withPending).toBeDefined();
    // permissions
    expect(s.permissions.mode).toBe('auto');
    expect(s.permissions.decisions.reject).toBe(e.permissionDecisions['reject'] ?? 0);
    expect(s.permissions.decisions.byReason['classifier']).toBe(e.permissionReasonTypes['classifier']);
    expect(s.permissions.denials[0]?.kind).toBe('permission-rule');
    expect(s.permissions.denials[0]?.tool).toBe('Bash');
    expect(s.permissions.denials[0]?.reason).toContain('BLOCKED by scripts/hooks/guard-bash.sh');
    expect(s.permissions.autoMode?.bashFirst).toBe(true);
    // hooks
    expect(s.hooks.total).toBe(e.attachmentTypes['hook_success'] ?? 0);
    expect(sum(s.hooks.byEvent)).toBe(s.hooks.total);
    for (const [ev, n] of Object.entries(e.hookEvents)) expect(s.hooks.byEvent[ev]).toBe(n);
    // queue: enqueue − dequeue − remove, never negative
    const ops = e.queueOperations;
    expect(sum(ops)).toBeGreaterThan(0);
    expect(s.queue.depth).toBe(Math.max(0, (ops['enqueue'] ?? 0) - (ops['dequeue'] ?? 0) - (ops['remove'] ?? 0)));
    // attribution / mcp
    for (const [skill, n] of Object.entries(e.attributionSkills)) expect(s.attribution.skills[skill]).toBe(n);
    for (const server of Object.keys(e.mcpServers)) expect(s.attribution.mcpServers[server]).toBeGreaterThan(0);
    // edited files
    expect(s.editedFiles.size).toBeGreaterThanOrEqual(Object.keys(e.trackingPaths).length);
  });
});

describe.skipIf(!have('compaction'))('compaction', () => {
  test('exact compaction records and remote control', () => {
    const { lines, ctx } = load('compaction');
    const s = parseTranscriptLines(lines, ctx);
    computeDerived(s);
    expect(s.compactions.length).toBe(2);
    expect(s.compactions[0]).toMatchObject({ trigger: 'manual', preTokens: 534977, postTokens: 13769 });
    expect(s.compactionCount).toBe(2);
    expect(s.remoteControl.url).toBe('https://claude.ai/code/session_01VZC8GyRsaCCBz48ySKtCbA');
    expect(s.remoteControl.active).toBe(true);
    const off = parseTranscriptLines([...lines, JSON.stringify({ type: 'system', subtype: 'bridge_status', content: '/remote-control is off', timestamp: '2026-10-09T00:00:00.000Z' })], ctx);
    expect(off.remoteControl.active).toBe(false);
  });
});

describe.skipIf(!have('links'))('links', () => {
  test('pr-link dedupe, artifacts, title precedence', () => {
    const { lines, ctx } = load('links');
    const s = parseTranscriptLines(lines, ctx);
    expect(s.links.prs).toHaveLength(1);
    expect(s.links.prs[0]).toMatchObject({ number: 158, repository: 'bizmatrixx/bzflow' });
    expect(s.links.artifacts[0]?.title).toBe('Kotlin 1.9 → 2.4');
    expect(s.sessionTitle).toBe('Kotlin 1.9에서 2.4로 마이그레이션 가이드');
    expect(s.entrypoint).toBe('claude-desktop');
  });
});

describe.skipIf(!have('cost'))('cost', () => {
  test('cost-state totals and per-model sum', () => {
    const { lines, ctx } = load('cost');
    const s = parseTranscriptLines(lines, ctx);
    expect(s.cost).not.toBeNull();
    expect(s.cost!.totalUSD).toBeGreaterThan(0);
    const perModelSum = Object.values(s.cost!.perModel).reduce((a, b) => a + b, 0);
    expect(Math.abs(perModelSum - s.cost!.totalUSD)).toBeLessThan(0.01);
    expect(s.cost!.hasUnknownModelCost).toBe(false);
  });
});

describe.skipIf(!have('errors'))('errors', () => {
  test('synthetic API error is captured and does not become the model', () => {
    const { lines, ctx } = load('errors');
    const s = parseTranscriptLines(lines, ctx);
    expect(s.errors.api).toHaveLength(1);
    expect(s.errors.api[0]?.text.startsWith('Your organization has disabled')).toBe(true);
    expect(s.errors.api[0]?.status).toBe(403);
    expect(s.model).not.toBe('<synthetic>');
  });
});

describe.skipIf(!existsSync(join(FIX, 'registry')))('registry', () => {
  test('parses entries; dead PIDs are filtered', () => {
    const dir = join(FIX, 'registry');
    const all = loadActiveSessions({ sessionsDir: dir, isAlive: () => true, projectsRoot: join(FIX, 'no-projects') });
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.some(s => s.entrypoint === 'claude-desktop' && s.hostSessionId)).toBe(true);
    expect(all.every(s => s.status === 'busy' || s.status === 'idle')).toBe(true);
    const none = loadActiveSessions({ sessionsDir: dir, isAlive: () => false });
    expect(none).toEqual([]);
  });
});
