#!/usr/bin/env bun
/**
 * Global install script for ccmonitor.
 *
 * Builds the standalone binary via `bun build --compile`, then copies it
 * to a directory in the user's PATH. Defaults to ~/.bun/bin (which Bun
 * already adds to PATH on install), or falls back to /usr/local/bin.
 *
 * Usage:
 *   bun run install:global              # default: ~/.bun/bin/ccmonitor
 *   bun run install:global --name foo   # custom binary name
 *   bun run install:global --dir /opt/bin
 */

import { $ } from 'bun';
import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

interface Options {
  name: string;
  dir: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    name: 'ccmonitor',
    dir: join(homedir(), '.bun', 'bin'),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name' && argv[i + 1]) {
      opts.name = argv[++i];
    } else if (arg === '--dir' && argv[i + 1]) {
      opts.dir = resolve(argv[++i]);
    } else if (arg === '-h' || arg === '--help') {
      console.log(`
Usage: bun run scripts/install.ts [options]

Options:
  --name <name>   Binary name (default: ccmonitor)
  --dir <path>    Install directory (default: ~/.bun/bin)
  -h, --help      Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(scriptDir, '..');
  const builtBinary = join(projectRoot, 'dist', 'ccmonitor');
  const targetPath = join(opts.dir, opts.name);

  console.log(`▸ Building standalone binary...`);
  const build = await $`bun build src/index.ts --compile --outfile dist/ccmonitor`
    .cwd(projectRoot)
    .nothrow();
  if (build.exitCode !== 0) {
    console.error(`✘ Build failed (exit ${build.exitCode})`);
    process.exit(build.exitCode);
  }

  if (!existsSync(builtBinary)) {
    console.error(`✘ Built binary not found at ${builtBinary}`);
    process.exit(1);
  }

  if (!existsSync(opts.dir)) {
    console.log(`▸ Creating install directory: ${opts.dir}`);
    mkdirSync(opts.dir, { recursive: true });
  }

  console.log(`▸ Installing to ${targetPath}`);
  copyFileSync(builtBinary, targetPath);
  chmodSync(targetPath, 0o755);

  const pathEnv = process.env.PATH || '';
  const inPath = pathEnv.split(':').some(p => resolve(p) === resolve(opts.dir));

  console.log(`✔ Installed ${opts.name} → ${targetPath}`);
  if (!inPath) {
    console.log(`\n⚠  ${opts.dir} is not in your PATH. Add this to your shell rc:`);
    console.log(`    export PATH="${opts.dir}:$PATH"`);
  } else {
    console.log(`\nRun it from anywhere: ${opts.name}`);
  }
}

main().catch(err => {
  console.error(`✘ Install failed: ${err.message}`);
  process.exit(1);
});
