import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { MemoryInfo } from '../types.js';

/**
 * Read auto-memory state from projects/<cwd>/memory/: MEMORY.md index plus
 * `<category>_<name>.md` topic files. Subdirectories are skipped.
 */
export function loadMemoryInfo(projectDir: string): MemoryInfo | null {
  const memDir = join(projectDir, 'memory');
  if (!existsSync(memDir)) return null;
  try {
    const indexPath = join(memDir, 'MEMORY.md');
    const hasIndex = existsSync(indexPath);
    const indexLines = hasIndex ? readFileSync(indexPath, 'utf-8').split('\n').length : 0;

    const topics = readdirSync(memDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('MEMORY'))
      .map(e => ({ name: e.name, mtime: statSync(join(memDir, e.name)).mtime }));
    topics.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const categoryBreakdown: Record<string, number> = {};
    for (const t of topics) {
      const cat = t.name.match(/^([a-z]+)_/)?.[1] ?? 'other';
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
    }

    const lastModified = topics[0]?.mtime ?? (hasIndex ? statSync(indexPath).mtime : null);
    const recentTopics = topics.slice(0, 3).map(t => t.name.replace(/\.md$/, ''));

    return { hasIndex, indexLines, topicCount: topics.length, categoryBreakdown, recentTopics, lastModified };
  } catch {
    return null;
  }
}
