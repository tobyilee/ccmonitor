import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { TeamInfo } from '../types.js';
import { CLAUDE_DIR } from './paths.js';

export function loadTeams(): TeamInfo[] {
  const teamsDir = join(CLAUDE_DIR, 'teams');
  if (!existsSync(teamsDir)) return [];

  const teams: TeamInfo[] = [];
  let dirs: string[];
  try { dirs = readdirSync(teamsDir); } catch { return []; }
  for (const dir of dirs) {
    const teamDir = join(teamsDir, dir);
    try {
      if (!statSync(teamDir).isDirectory()) continue;
    } catch { continue; }

    const configFile = join(teamDir, 'config.json');
    let members: string[] = [];
    if (existsSync(configFile)) {
      try {
        const config = JSON.parse(readFileSync(configFile, 'utf-8'));
        const rawMembers: unknown[] = config.members || Object.keys(config.agents || {});
        members = rawMembers.map((m: unknown) =>
          typeof m === 'object' && m !== null && 'name' in m ? String((m as { name: unknown }).name) : String(m),
        );
      } catch { /* skip */ }
    }

    teams.push({
      name: dir,
      configFile: existsSync(configFile) ? configFile : '',
      members,
      hasInbox: existsSync(join(teamDir, 'inboxes')),
    });
  }
  return teams;
}
