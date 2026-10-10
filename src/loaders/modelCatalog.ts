import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { ModelCatalogInfo, ModelCatalogEntry } from '../types.js';
import { CLAUDE_DIR } from './paths.js';

export const MODEL_CATALOG_DIR = join(CLAUDE_DIR, 'cache', 'model-catalog');

let cache: { dir: string; mtimeMs: number; value: ModelCatalogInfo | null } | null = null;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse one cached catalog JSON document. Exported for tests. */
export function parseModelCatalog(doc: unknown): ModelCatalogInfo | null {
  const d = doc as { fetchedAt?: unknown; catalog?: { config?: { models?: unknown[] } } } | null;
  const models = d?.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  const entries: ModelCatalogEntry[] = [];
  for (const raw of models) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') continue;
    const thinking = m.thinking as { effort_options?: Array<{ id?: unknown }> } | undefined;
    entries.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      section: typeof m.section === 'string' ? m.section : null,
      fastMode: m.fast_mode !== undefined && m.fast_mode !== null && m.fast_mode !== false,
      effortOptions: (thinking?.effort_options ?? []).map(o => (typeof o?.id === 'string' ? o.id : '')).filter(Boolean),
      // Not published today; honoured if it ever appears under one of these names.
      contextWindow: num(m.context_window) ?? num(m.context_length) ?? num(m.max_context_tokens),
      minVersion: typeof m.min_claude_code_version === 'string' ? m.min_claude_code_version : null,
    });
  }
  return { models: entries, fetchedAt: num(d?.fetchedAt) !== null ? new Date(num(d!.fetchedAt)!) : null };
}

/**
 * Read the newest `~/.claude/cache/model-catalog/*.json`. Cached per process
 * and re-read only when that file's mtime changes. Null when absent/invalid.
 */
export function loadModelCatalog(dir: string = MODEL_CATALOG_DIR): ModelCatalogInfo | null {
  if (!existsSync(dir)) return null;
  try {
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(dir, f);
      const st = statSync(p);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: p, mtimeMs: st.mtimeMs };
    }
    if (!newest) return null;
    if (cache && cache.dir === dir && cache.mtimeMs === newest.mtimeMs) return cache.value;
    const value = parseModelCatalog(JSON.parse(readFileSync(newest.path, 'utf-8')));
    cache = { dir, mtimeMs: newest.mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}
