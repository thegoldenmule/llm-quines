import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mastra } from './mastra/index';
import { PROJECT_ROOT, ensureDirs, ensureGitRepo, scanState } from './mastra/utils/state';
import { requestShutdown, shutdownRequested, shutdownSignal } from './mastra/utils/shutdown';
import { killAllClaudeProcesses } from './mastra/utils/claude-cli';

/**
 * The quiner loop: forever, run one quine-workflow iteration (generate a
 * strictly-longer verified quine, commit it to completed/), then go again.
 *
 * Restartability: all durable state lives in completed/ + git. Each loop turn
 * re-scans completed/ from scratch, so you can kill this process at any time
 * and `npm start` will pick up exactly where it left off.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DELAY_MS = intEnv('QUINER_DELAY_MS', 2_000);
const MAX_ITERATIONS = intEnv('QUINER_MAX_ITERATIONS', 0) || Infinity;
const LOCK_FILE = join(PROJECT_ROOT, '.quiner.pid');

/** Sleep that wakes immediately when shutdown is requested. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      shutdownSignal().removeEventListener('abort', done);
      resolve();
    }
    shutdownSignal().addEventListener('abort', done, { once: true });
  });
}

/** Mastra's failed-run error is a plain {message,...} object at runtime, not an Error. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Refuse to run two loops at once — they'd race on workspace/, seq numbers, and git. */
function acquireLock(): void {
  try {
    writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    const prev = parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10);
    if (Number.isFinite(prev) && prev !== process.pid && pidAlive(prev)) {
      console.error(`[quiner] another quiner loop (pid ${prev}) is already running — exiting`);
      process.exit(1);
    }
    writeFileSync(LOCK_FILE, `${process.pid}\n`);
  }
  process.on('exit', () => {
    try {
      if (parseInt(readFileSync(LOCK_FILE, 'utf-8'), 10) === process.pid) rmSync(LOCK_FILE);
    } catch {
      // lock already gone
    }
  });
}

let signals = 0;
function onSignal(sig: string) {
  signals++;
  if (signals === 1) {
    console.log(`\n[quiner] ${sig} received — aborting in-flight session and stopping (state is safe; restart with npm start)`);
    requestShutdown();
  } else {
    console.log(`\n[quiner] ${sig} received again — killing children and exiting immediately`);
    killAllClaudeProcesses();
    process.exit(130);
  }
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

async function main(): Promise<void> {
  ensureDirs();
  ensureGitRepo();
  acquireLock();

  let iterations = 0;
  let consecutiveFailures = 0;

  while (!shutdownRequested() && iterations < MAX_ITERATIONS) {
    const state = scanState();
    console.log(
      `\n[quiner] ── iteration ${state.nextSeq} ── best so far: ${state.bestLength > 0 ? `${state.bestLength} bytes (${state.bestFile})` : 'none'}`,
    );

    try {
      const workflow = mastra.getWorkflow('quineWorkflow');
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {
          seq: state.nextSeq,
          bestLength: state.bestLength,
          bestFile: state.bestFile,
        },
      });

      if (result.status === 'success') {
        consecutiveFailures = 0;
        console.log(`[quiner] ✓ quine #${result.result.seq} complete: ${result.result.byteLength} bytes → ${result.result.file}`);
      } else {
        consecutiveFailures++;
        const error = result.status === 'failed' ? result.error : `workflow ended with status ${result.status}`;
        console.log(`[quiner] ✗ iteration failed: ${errorMessage(error)}`);
      }
    } catch (err) {
      consecutiveFailures++;
      console.log(`[quiner] ✗ iteration threw: ${errorMessage(err)}`);
    }

    iterations++;
    if (shutdownRequested()) break;
    if (consecutiveFailures > 0) {
      const backoff = Math.min(5_000 * consecutiveFailures, 60_000);
      console.log(`[quiner] backing off ${Math.round(backoff / 1000)}s after ${consecutiveFailures} consecutive failure(s)`);
      await sleep(backoff);
    } else {
      await sleep(DELAY_MS);
    }
  }

  console.log('[quiner] loop stopped');
  process.exit(0);
}

main().catch((err) => {
  console.error('[quiner] fatal:', err);
  process.exit(1);
});
