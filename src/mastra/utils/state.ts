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
import { measureSteps } from './quine';

/**
 * Durable state = the `completed/` folder plus git history. `state.json` is a
 * cache only (it also memoizes measured step counts for legacy files); on
 * startup we always rebuild from a scan of `completed/`, so killing the loop
 * at any point loses at most the in-flight iteration.
 *
 * The incumbent "best" is the highest-sequence valid file: every accepted
 * quine must strictly beat its predecessor in BOTH bytes and executed steps,
 * so the chain is totally ordered and the newest entry dominates.
 */

const __dir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dir, '../../..');
export const COMPLETED_DIR = join(PROJECT_ROOT, 'completed');
export const WORKSPACE_DIR = join(PROJECT_ROOT, 'workspace');
export const STATE_FILE = join(PROJECT_ROOT, 'state.json');

// quine-<seq>-<bytes>b[-<steps>s].js — the steps suffix is absent on legacy
// files committed before the computational-complexity gate existed.
const FILE_RE = /^quine-(\d+)-(\d+)b(?:-(\d+)s)?\.js$/;

export interface QuinerState {
  /** Sequence number the next quine will get. */
  nextSeq: number;
  /** Byte length of the incumbent; 0 when none. */
  bestBytes: number;
  /** Executed-step count of the incumbent; 0 when none. */
  bestSteps: number;
  /** Absolute path of the incumbent, if any. */
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

interface StateCache {
  bestFile?: string;
  bestSteps?: number;
}

function readStateCache(): StateCache {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return { bestFile: parsed.bestFile, bestSteps: parsed.bestSteps };
  } catch {
    return {};
  }
}

function writeStateCache(state: QuinerState): void {
  writeFileAtomic(
    STATE_FILE,
    JSON.stringify(
      {
        nextSeq: state.nextSeq,
        bestFile: state.bestFile,
        bestBytes: state.bestBytes,
        bestSteps: state.bestSteps,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
}

export async function scanState(): Promise<QuinerState> {
  ensureDirs();
  let nextSeq = 0;
  let best: { seq: number; bytes: number; steps?: number; path: string } | undefined;
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
    if (best === undefined || seq > best.seq) {
      best = { seq, bytes, steps: m[3] !== undefined ? parseInt(m[3], 10) : undefined, path };
    }
  }

  if (!best) return { nextSeq, bestBytes: 0, bestSteps: 0 };

  let bestSteps = best.steps;
  if (bestSteps === undefined) {
    // Legacy file from before the steps gate: measure once, memoized in
    // state.json so restarts don't pay the run again.
    const cache = readStateCache();
    if (cache.bestFile === best.path && typeof cache.bestSteps === 'number') {
      bestSteps = cache.bestSteps;
    } else {
      console.log(`[quiner] measuring steps for legacy best ${best.path}...`);
      const measured = await measureSteps(readFileSync(best.path));
      bestSteps = measured.ok ? measured.steps : 0;
      if (!measured.ok) {
        console.warn(`[quiner] WARNING: could not measure legacy best (${measured.reason}); treating as 0 steps`);
      }
    }
  }

  const state: QuinerState = { nextSeq, bestBytes: best.bytes, bestSteps, bestFile: best.path };
  writeStateCache(state);
  return state;
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
export function commitQuine(
  source: Buffer,
  seq: number,
  steps: number,
  note?: string,
): { file: string; byteLength: number } {
  ensureDirs();
  const byteLength = source.length;
  const name = `quine-${String(seq).padStart(4, '0')}-${byteLength}b-${steps}s.js`;
  const path = join(COMPLETED_DIR, name);
  writeFileAtomic(path, source);
  writeStateCache({ nextSeq: seq + 1, bestBytes: byteLength, bestSteps: steps, bestFile: path });
  // `add -A` on the whole folder sweeps in any quine a previous crash left
  // written-but-unstaged, so no completed quine can be lost to git forever.
  git(['add', '-A', '--', COMPLETED_DIR, STATE_FILE]);
  // --no-verify/--no-gpg-sign: a global hook or gpg config must not be able
  // to wedge the loop.
  git([
    'commit', '--no-verify', '--no-gpg-sign',
    '-m', `quine #${seq}: ${byteLength} bytes, ${steps} steps`,
    ...(note ? ['-m', note] : []),
  ]);
  return { file: path, byteLength };
}
