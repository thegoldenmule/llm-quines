import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Durable state = the `completed/` folder plus git history. `state.json` is a
 * human-readable cache only; on startup we always rebuild from a scan of
 * `completed/`, so killing the loop at any point loses at most the in-flight
 * iteration.
 */

const __dir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dir, '../../..');
export const COMPLETED_DIR = join(PROJECT_ROOT, 'completed');
export const WORKSPACE_DIR = join(PROJECT_ROOT, 'workspace');
export const STATE_FILE = join(PROJECT_ROOT, 'state.json');

const FILE_RE = /^quine-(\d+)-(\d+)b\.js$/;

export interface QuinerState {
  /** Sequence number the next quine will get. */
  nextSeq: number;
  /** Byte length of the current best (largest) verified quine; 0 when none. */
  bestLength: number;
  /** Absolute path of the current best quine, if any. */
  bestFile?: string;
}

/** Crash-safe file write: temp file in the same dir, then atomic rename. */
function writeFileAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function ensureDirs(): void {
  mkdirSync(COMPLETED_DIR, { recursive: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  // The project root is "type": "module"; pin the workspace to CommonJS so the
  // agent's self-test (`node candidate.js`) runs under the same module system
  // as the verifier.
  const pkg = join(WORKSPACE_DIR, 'package.json');
  if (!existsSync(pkg)) {
    writeFileSync(pkg, '{ "type": "commonjs" }\n');
  }
}

export function scanState(): QuinerState {
  ensureDirs();
  let nextSeq = 0;
  let bestLength = 0;
  let bestFile: string | undefined;
  for (const name of readdirSync(COMPLETED_DIR)) {
    const m = name.match(FILE_RE);
    if (!m) continue;
    const seq = parseInt(m[1], 10);
    if (seq + 1 > nextSeq) nextSeq = seq + 1;
    const path = join(COMPLETED_DIR, name);
    const bytes = statSync(path).size;
    if (bytes !== parseInt(m[2], 10)) {
      // Likely truncated by a hard kill mid-write; never trust it as "best".
      // (The seq above still advances so we don't reuse its number.)
      console.warn(`[quiner] WARNING: ${name} is ${bytes} bytes but its name claims ${m[2]} — ignoring as best candidate`);
      continue;
    }
    if (bytes > bestLength) {
      bestLength = bytes;
      bestFile = path;
    }
  }
  return { nextSeq, bestLength, bestFile };
}

export function readBestSource(state: QuinerState): string | undefined {
  if (!state.bestFile) return undefined;
  return readFileSync(state.bestFile, 'utf-8');
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}

export function ensureGitRepo(): void {
  if (!existsSync(join(PROJECT_ROOT, '.git'))) {
    git(['init', '-b', 'main']);
  }
  // Make sure commits work even without a global identity.
  try {
    git(['config', 'user.email']);
  } catch {
    git(['config', 'user.email', 'quiner@localhost']);
    git(['config', 'user.name', 'quiner']);
  }
}

/** Write the verified quine into completed/, update state.json, git commit. */
export function commitQuine(source: Buffer, seq: number): { file: string; byteLength: number } {
  ensureDirs();
  const byteLength = source.length;
  const name = `quine-${String(seq).padStart(4, '0')}-${byteLength}b.js`;
  const path = join(COMPLETED_DIR, name);
  writeFileAtomic(path, source);
  writeFileAtomic(
    STATE_FILE,
    JSON.stringify(
      { nextSeq: seq + 1, bestLength: byteLength, bestFile: path, updatedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  // `add -A` on the whole folder sweeps in any quine a previous crash left
  // written-but-unstaged, so no completed quine can be lost to git forever.
  git(['add', '-A', '--', COMPLETED_DIR, STATE_FILE]);
  // --no-verify/--no-gpg-sign: a global hook or gpg config must not be able
  // to wedge the loop.
  git(['commit', '--no-verify', '--no-gpg-sign', '-m', `quine #${seq}: ${byteLength} bytes`]);
  return { file: path, byteLength };
}
