#!/usr/bin/env bun
/**
 * make-fixture — cut a scrubbed JSONL fixture from a real Claude Code transcript.
 *
 * Usage:
 *   bun run scripts/make-fixture.ts <transcript.jsonl> --out fixtures/<name>.jsonl
 *       [--from <uuid>]          start at this entry (inclusive)
 *       [--to <uuid>]            stop at this entry (inclusive)
 *       [--from-line N]          1-based line range alternative to --from/--to
 *       [--to-line N]
 *       [--keep <uuid,...>]      entries kept verbatim (after path scrubbing)
 *       [--keep-msg <id,...>]    assistant message ids kept verbatim
 *       [--types a,b,...]        include only these entry types
 *       [--max-per-type N]       keep at most N entries of each type
 *       [--append]               append to --out instead of overwriting
 *
 * Scrub rules (see docs/implementation-plan-v2.md §2):
 *   - `/Users/<name>` → `/Users/dev`, the login name itself → `dev`, e-mail addresses → user@example.com
 *   - `rendered*` caches and `toolUseResult.prompt` (agent prompts) are removed
 *   - attachment entries of type prompt_snapshot / credential_org / session_context are dropped
 *   - serverClassifierContext / serverClassifierRequest / wireToolInputs keys are removed
 *   - thinking blocks and signatures are replaced
 *   - assistant text blocks keep their first 300 characters
 *   - every other string longer than 300 characters becomes a placeholder
 *   - entries on the keep-list skip the truncation rules
 *
 * Also writes `<name>.expect.json` with measured counts so tests do not depend on prose.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir, userInfo } from 'os';

const MAX_STR = 300;
const DROP_ATTACHMENTS = new Set(['prompt_snapshot', 'credential_org', 'session_context']);
const DROP_KEYS = new Set(['serverClassifierContext', 'serverClassifierRequest', 'wireToolInputs', 'rendered', 'renderedInHumanTurn']);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@(?!anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

interface Opts {
  input: string;
  out: string;
  from?: string;
  to?: string;
  fromLine?: number;
  toLine?: number;
  keep: Set<string>;
  keepMsg: Set<string>;
  types: Set<string> | null;
  maxPerType: number;
  append: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    input: '', out: '', keep: new Set(), keepMsg: new Set(), types: null,
    maxPerType: Infinity, append: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = (): string => { i++; return argv[i] ?? ''; };
    switch (a) {
      case '--out': opts.out = next(); break;
      case '--from': opts.from = next(); break;
      case '--to': opts.to = next(); break;
      case '--from-line': opts.fromLine = Number(next()); break;
      case '--to-line': opts.toLine = Number(next()); break;
      case '--keep': next().split(',').filter(Boolean).forEach(u => opts.keep.add(u)); break;
      case '--keep-msg': next().split(',').filter(Boolean).forEach(u => opts.keepMsg.add(u)); break;
      case '--types': opts.types = new Set(next().split(',').filter(Boolean)); break;
      case '--max-per-type': opts.maxPerType = Number(next()); break;
      case '--append': opts.append = true; break;
      default: positional.push(a);
    }
  }
  opts.input = positional[0] ?? '';
  if (!opts.input || !opts.out) {
    console.error('usage: make-fixture.ts <transcript.jsonl> --out fixtures/<name>.jsonl [options]');
    process.exit(2);
  }
  return opts;
}

/** Scrub paths and the login name from a serialized line. */
export function scrubText(s: string, home: string, login: string): string {
  let out = s.split(home).join('/Users/dev');
  out = out.replace(/\/Users\/[A-Za-z0-9._-]+/g, '/Users/dev');
  if (login && login !== 'dev') out = out.split(login).join('dev');
  out = out.replace(EMAIL_RE, 'user@example.com');
  return out;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function truncate(s: string, keepPrefix: boolean): string {
  if (s.length <= MAX_STR) return s;
  return keepPrefix
    ? `${s.slice(0, MAX_STR)}…[+${s.length - MAX_STR}]`
    : `[scrubbed ${s.length} chars]`;
}

/** Recursively scrub one entry. `verbatim` skips the length rules. */
function scrubEntry(entry: { [k: string]: Json }, verbatim: boolean): { [k: string]: Json } | null {
  if (entry.type === 'attachment') {
    const att = entry.attachment;
    const attType = att && typeof att === 'object' && !Array.isArray(att) ? att.type : null;
    if (typeof attType === 'string' && DROP_ATTACHMENTS.has(attType)) return null;
  }
  const isAssistant = entry.type === 'assistant';
  const walk = (v: Json, key: string, inContent: boolean, parentKey = ''): Json => {
    if (typeof v === 'string') {
      if (key === 'signature') return '[sig]';
      if (verbatim) return v;
      return truncate(v, isAssistant && inContent && key === 'text');
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key, inContent, parentKey));
    if (v && typeof v === 'object') {
      const out: { [k: string]: Json } = {};
      if (isAssistant && v.type === 'thinking') {
        return { type: 'thinking', thinking: '[thinking scrubbed]', signature: '[sig]' };
      }
      for (const [k, val] of Object.entries(v)) {
        if (DROP_KEYS.has(k)) continue;
        if (k === 'prompt' && key === 'toolUseResult') continue;
        out[k] = walk(val, k, inContent || k === 'content', key);
      }
      return out;
    }
    return v;
  };
  return walk(entry, '', false) as { [k: string]: Json };
}

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
  versions: Record<string, number>;
  entrypoints: Record<string, number>;
  toolDenialKinds: Record<string, number>;
  interrupted: number;
  apiErrors: number;
  humanPrompts: number;
}

function bump(rec: Record<string, number>, key: unknown): void {
  if (typeof key !== 'string' || !key) return;
  rec[key] = (rec[key] ?? 0) + 1;
}

export function measure(lines: string[]): Expect {
  const e: Expect = {
    lines: lines.length, types: {}, systemSubtypes: {}, attachmentTypes: {}, stopReasons: {},
    messageIds: [], outputTokensByMessage: {}, promptSources: {}, turnOrigins: {},
    permissionReasonTypes: {}, permissionDecisions: {}, hookEvents: {}, queueOperations: {},
    trackingPaths: {}, attributionSkills: {}, mcpServers: {}, toolNames: {}, models: {},
    versions: {}, entrypoints: {}, toolDenialKinds: {}, interrupted: 0, apiErrors: 0, humanPrompts: 0,
  };
  const seenIds = new Set<string>();
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }
    bump(e.types, obj.type);
    bump(e.versions, obj.version);
    bump(e.entrypoints, obj.entrypoint);
    if (obj.type === 'system') bump(e.systemSubtypes, obj.subtype);
    const att = obj.attachment as Record<string, unknown> | undefined;
    if (obj.type === 'attachment' && att) {
      bump(e.attachmentTypes, att.type);
      if (att.type === 'hook_success') bump(e.hookEvents, att.hookEvent);
    }
    if (obj.type === 'queue-operation') bump(e.queueOperations, obj.operation);
    if (obj.type === 'file-history-delta') bump(e.trackingPaths, obj.trackingPath);
    const msg = obj.message as Record<string, unknown> | undefined;
    if (obj.type === 'assistant' && msg) {
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        e.messageIds.push(id);
        bump(e.stopReasons, msg.stop_reason);
        bump(e.models, msg.model);
        bump(e.attributionSkills, obj.attributionSkill);
        bump(e.mcpServers, obj.attributionMcpServer);
        const usage = msg.usage as Record<string, unknown> | undefined;
        e.outputTokensByMessage[id] = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
      }
      if (obj.isApiErrorMessage === true) e.apiErrors++;
      const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      for (const b of content) {
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          bump(e.toolNames, b.name);
          const m = b.name.match(/^mcp__([^_].*?)__/);
          if (m) bump(e.mcpServers, m[1]);
        }
      }
    }
    if (obj.type === 'user') {
      bump(e.promptSources, obj.promptSource);
      bump(e.turnOrigins, obj.turnOrigin);
      bump(e.toolDenialKinds, obj.toolDenialKind);
      const pd = obj.permissionDecision as Record<string, unknown> | undefined;
      if (pd) {
        bump(e.permissionDecisions, pd.decision);
        bump(e.permissionReasonTypes, pd.reasonType ?? 'none');
      }
      if (obj.interruptedMessageId) e.interrupted++;
      const ps = obj.promptSource;
      if (ps === 'typed' || ps === 'queued' || ps === 'suggestion_accepted' || ps === 'sdk' || obj.turnOrigin === 'human') {
        e.humanPrompts++;
      }
    }
  }
  return e;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const home = homedir();
  const login = userInfo().username;
  const raw = readFileSync(opts.input, 'utf-8').split('\n').filter(l => l.trim());

  let active = !opts.from && !opts.fromLine;
  const perType: Record<string, number> = {};
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] ?? '';
    const lineNo = i + 1;
    let obj: { [k: string]: Json };
    try { obj = JSON.parse(line); } catch { continue; }
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : '';
    if (!active) {
      if ((opts.from && uuid === opts.from) || (opts.fromLine && lineNo >= opts.fromLine)) active = true;
      else continue;
    }
    if (opts.toLine && lineNo > opts.toLine) break;
    const type = typeof obj.type === 'string' ? obj.type : 'unknown';
    const include = !opts.types || opts.types.has(type);
    if (include && (perType[type] ?? 0) < opts.maxPerType) {
      const msg = obj.message;
      const msgId = msg && typeof msg === 'object' && !Array.isArray(msg) && typeof msg.id === 'string' ? msg.id : '';
      const isTaskNote = (v: unknown): boolean => typeof v === 'string' && v.trimStart().startsWith('<task-notification>');
      const verbatim = opts.keep.has(uuid) || (msgId !== '' && opts.keepMsg.has(msgId))
        || (type === 'queue-operation' && isTaskNote(obj.content))
        || (type === 'attachment' && (obj.attachment as { type?: string } | undefined)?.type === 'queued_command'
          && isTaskNote((obj.attachment as { prompt?: unknown }).prompt));
      const scrubbed = scrubEntry(obj, verbatim);
      if (scrubbed) {
        out.push(scrubText(JSON.stringify(scrubbed), home, login));
        perType[type] = (perType[type] ?? 0) + 1;
      }
    }
    if (opts.to && uuid === opts.to) break;
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  const previous = opts.append && existsSync(opts.out)
    ? readFileSync(opts.out, 'utf-8').split('\n').filter(l => l.trim())
    : [];
  const all = [...previous, ...out];
  writeFileSync(opts.out, all.join('\n') + '\n');
  const expectPath = opts.out.replace(/\.jsonl$/, '.expect.json');
  writeFileSync(expectPath, JSON.stringify(measure(all), null, 2) + '\n');
  console.log(`wrote ${out.length} entries (${all.length} total) → ${opts.out}`);
  console.log(`sidecar → ${expectPath}`);
}

if (import.meta.main) main();
