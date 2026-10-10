import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import type { BackgroundTask } from '../types.js';

const EXIT_MARKER = /\[exited with code (-?\d+)\]\s*$/;

/** Read the last `bytes` of a file as UTF-8 (never the whole file). */
export function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (len <= 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * For tasks still `running`, stat their outputFile: record size and, for Bash
 * tasks, detect the `[exited with code N]` trailer. Missing files are left alone.
 */
export function loadScratchpadTasks(tasks: Map<string, BackgroundTask>): void {
  for (const task of tasks.values()) {
    if (task.status !== 'running' || !task.outputFile) continue;
    try {
      if (!existsSync(task.outputFile)) continue;
      const st = statSync(task.outputFile);
      task.outputBytes = st.size;
      if (task.kind === 'bash' || task.kind === 'monitor') {
        const tail = readTail(task.outputFile, 256);
        const m = EXIT_MARKER.exec(tail);
        if (m?.[1] !== undefined) {
          const code = Number(m[1]);
          task.exitCode = code;
          task.status = code === 0 ? 'completed' : 'failed';
          task.endedAt = st.mtime;
        }
      }
    } catch {
      // unreadable output file — leave status as is
    }
  }
}

/** Last `n` lines of a task's output file, for the `b` view. */
export function readTaskOutputTail(task: BackgroundTask, n: number = 20): string[] {
  if (!task.outputFile) return [];
  try {
    if (!existsSync(task.outputFile)) return [];
    const text = readTail(task.outputFile, 32 * 1024);
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}
