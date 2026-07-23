import { mastra } from './mastra/index';
import { ensureDirs, ensureGitRepo, scanState, readBestSource } from './mastra/utils/state';
import { requestShutdown, shutdownRequested } from './mastra/utils/shutdown';

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let signals = 0;
function onSignal(sig: string) {
  signals++;
  if (signals === 1) {
    console.log(`\n[quiner] ${sig} received — aborting in-flight session and stopping (state is safe; restart with npm start)`);
    requestShutdown();
  } else {
    console.log(`\n[quiner] ${sig} received again — exiting immediately`);
    process.exit(130);
  }
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

async function main(): Promise<void> {
  ensureDirs();
  ensureGitRepo();

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
          bestSource: readBestSource(state),
        },
      });

      if (result.status === 'success') {
        consecutiveFailures = 0;
        console.log(`[quiner] ✓ quine #${result.result.seq} complete: ${result.result.byteLength} bytes → ${result.result.file}`);
      } else {
        consecutiveFailures++;
        const error = result.status === 'failed' ? result.error : `workflow ended with status ${result.status}`;
        console.log(`[quiner] ✗ iteration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (err) {
      consecutiveFailures++;
      console.log(`[quiner] ✗ iteration threw: ${err instanceof Error ? err.message : String(err)}`);
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
