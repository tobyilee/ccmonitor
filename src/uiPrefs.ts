import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CLAUDE_DIR } from './loaders/paths.js';

/** Where collapsed-section preferences live. */
export const UI_PREFS_FILE = join(CLAUDE_DIR, 'ccmonitor-ui.json');

export interface UiPrefs {
  collapsed: Set<string>;
}

export function loadUiPrefs(path: string = UI_PREFS_FILE): UiPrefs {
  try {
    if (!existsSync(path)) return { collapsed: new Set() };
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const list = Array.isArray(data?.collapsed) ? data.collapsed.filter((x: unknown) => typeof x === 'string') : [];
    return { collapsed: new Set<string>(list) };
  } catch {
    return { collapsed: new Set() };
  }
}

export function saveUiPrefs(prefs: UiPrefs, path: string = UI_PREFS_FILE): void {
  try {
    writeFileSync(path, JSON.stringify({ collapsed: [...prefs.collapsed] }, null, 2) + '\n');
  } catch {
    // best effort
  }
}
