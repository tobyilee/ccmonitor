import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Read the current git branch for a cwd by parsing .git/HEAD directly.
 * Returns the branch name, a short SHA for detached HEAD, or null.
 */
export function readGitBranch(cwdPath: string): string | null {
  try {
    const headFile = join(cwdPath, '.git', 'HEAD');
    if (!existsSync(headFile)) return null;
    const content = readFileSync(headFile, 'utf-8').trim();
    const refMatch = content.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch?.[1]) return refMatch[1];
    if (/^[0-9a-f]{7,40}$/i.test(content)) return content.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}
