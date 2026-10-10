import { execFileSync } from 'child_process';

/** RSS of a process in MB via `ps` (no shell). 0 on any failure. */
export function loadProcessMemMb(pid: number): number {
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2000 });
    const rssKb = parseInt(output.trim(), 10);
    return isNaN(rssKb) ? 0 : Math.round(rssKb / 1024);
  } catch {
    return 0;
  }
}
