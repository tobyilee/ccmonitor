/**
 * Pure helpers for the Recap panel. No I/O, no clock.
 */

const KOREAN_HEADING = /^\s*(?:#{1,6}\s*)?\*{0,2}(?:Korean recap|한국어 요약|한글 요약|요약|Recap)\*{0,2}\s*:?\s*$/im;

/** Strip Claude Code's "(disable recaps in /config)" suffix from an away_summary. */
export function cleanNativeRecap(text: string): string {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/i, '').trim();
}

/**
 * Return the text after a "Korean recap" style heading line, trimmed, or null
 * when the reply has no such heading or nothing follows it.
 */
export function extractKoreanRecap(text: string): string | null {
  const m = KOREAN_HEADING.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length).trim();
  return after.length > 0 ? after : null;
}

/**
 * Minimal Markdown → plain text. Strips emphasis markers, inline code
 * backticks and heading hashes; keeps "- " bullets; replaces fenced code
 * blocks with "[code]"; collapses runs of blank lines to one.
 */
export function mdToPlain(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  let lastBlank = true; // suppress leading blank lines
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) {
        out.push('[code]');
        lastBlank = false;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let s = line;
    s = s.replace(/^\s{0,3}#{1,6}\s+/, '');
    s = s.replace(/\*\*(.+?)\*\*/g, '$1');
    s = s.replace(/__(.+?)__/g, '$1');
    s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2');
    s = s.replace(/`([^`]*)`/g, '$1');
    s = s.replace(/^(\s*)[*+]\s+/, '$1- ');
    s = s.replace(/\*\*/g, '');
    if (s.trim() === '') {
      if (!lastBlank) {
        out.push('');
        lastBlank = true;
      }
      continue;
    }
    out.push(s);
    lastBlank = false;
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Parse one `<task-notification>` block. Returns null when the shape is not recognised. */
export function parseTaskNotification(text: string): {
  id: string;
  status: 'completed' | 'failed' | 'unknown';
  summary: string | null;
  exitCode: number | null;
  outputFile: string | null;
  toolUseId: string | null;
} | null {
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1];
  if (!id) return null;
  const rawStatus = /<status>\s*([^<\s]+)\s*<\/status>/.exec(text)?.[1] ?? '';
  const status = rawStatus === 'completed' ? 'completed'
    : rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'killed' ? 'failed'
      : 'unknown';
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() ?? null;
  const exitMatch = summary ? /exit code\s+(-?\d+)/i.exec(summary) : null;
  const exitCode = exitMatch?.[1] !== undefined ? Number(exitMatch[1]) : null;
  const outputFile = /<output-file>\s*([^<]+?)\s*<\/output-file>/.exec(text)?.[1] ?? null;
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1] ?? null;
  return { id, status, summary, exitCode, outputFile, toolUseId };
}
